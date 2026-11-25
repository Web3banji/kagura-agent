#!/usr/bin/env node
/**
 * KAGURA persistent Windows/local Kane runner (Stage 2).
 * - Coordinator: deployed KAGURA app (Vercel). Executes Kane CLI ONLY locally.
 * - Claims jobs via /api/runner/claim, sends /api/runner/heartbeat, syncs /api/runner/complete.
 * - Genuine execution only (no simulation). Reuses kane-verify execution/parsing behavior.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { statSync as fsSyncStatSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  buildIsolationPlan,
  buildSandboxSpawnCommand,
  assessIsolation,
  normalizeIsolationMode,
  probeIsolation,
  requiresIsolationForJob,
  validateIsolationPaths,
} from "./runner-isolation.mjs";
import { workspaceDir, profileDir, isInside } from "./runner-workspace.mjs";
import {
  buildChildEnv,
  validateJobForExecution,
  isShellSafeArg,
} from "./runner-security.mjs";
import { assessKaneReadiness, READINESS_STATES } from "./kane-readiness.mjs";

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function loadEnvFile(file) {
  try {
    const raw = await fs.readFile(path.join(ROOT, file), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // optional file
  }
}

async function loadEnv() {
  // local runner secrets first, then general local env (do not override already-set vars)
  await loadEnvFile(".env.runner");
  await loadEnvFile(".env.local");
  await loadEnvFile(".env");
}

function required(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redactUrl(u) {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "(configured)";
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Operator opt-in list of additional environment variable names passed to job processes.
 * Secrets are filtered out regardless, so this cannot leak tokens.
 */
function extraChildEnvNames() {
  const raw = required("KAGURA_KANE_CHILD_ENV_EXTRA");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Locate the kane-cli Node entry point so the runner never has to go through cmd.exe.
 * Resolution order: explicit override, local node_modules resolution, npm global root,
 * node install root. Returns an absolute path or undefined.
 */
function resolveKaneCliEntry() {
  const override = required("KAGURA_KANE_CLI_JS");
  const candidates = [];
  if (override) candidates.push(path.resolve(ROOT, override));
  try {
    candidates.push(require.resolve("@testmuai/kane-cli/bin/kane-cli.cjs"));
  } catch {
    // not installed locally
  }
  const rel = path.join("node_modules", "@testmuai", "kane-cli", "bin", "kane-cli.cjs");
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", rel));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "nodejs", rel));
  candidates.push(path.join(path.dirname(process.execPath), rel));
  candidates.push(path.join(path.dirname(process.execPath), "node_modules", "npm", rel));
  for (const c of candidates) {
    if (c && path.isAbsolute(c) && fsSyncExists(c)) return path.resolve(c);
  }
  return undefined;
}

function fsSyncExists(p) {
  try {
    return fsSyncStatSync(p).isFile();
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function getOrCreateRunnerId() {
  const envId = required("KAGURA_RUNNER_ID");
  if (envId) return envId;
  const idFile = path.join(ROOT, "data", "verification", "runner-id");
  try {
    const existing = (await fs.readFile(idFile, "utf8")).trim();
    if (existing) return existing;
  } catch {}
  const id = `runner-${os.hostname().replace(/[^a-zA-Z0-9_-]/g, "-")}-${randomUUID().slice(0, 8)}`;
  await ensureDir(path.dirname(idFile));
  await fs.writeFile(idFile, `${id}\n`, "utf8");
  return id;
}

function getVersion() {
  return required("KAGURA_RUNNER_VERSION") || process.env.npm_package_version || "0.1.0";
}

function getConfig() {
  const base = required("KAGURA_APP_URL").replace(/\/+$/, "");
  const token = required("KAGURA_RUNNER_TOKEN");
  const pollMs = Number(process.env.KAGURA_RUNNER_POLL_MS || 5000);
  const heartbeatMs = Number(process.env.KAGURA_RUNNER_HEARTBEAT_MS || 30000);
  const maxBackoffMs = Number(process.env.KAGURA_RUNNER_MAX_BACKOFF_MS || 60000);
  return {
    base,
    token,
    pollMs: Number.isFinite(pollMs) && pollMs >= 1000 ? pollMs : 5000,
    heartbeatMs: Number.isFinite(heartbeatMs) && heartbeatMs >= 10000 ? heartbeatMs : 30000,
    maxBackoffMs: Number.isFinite(maxBackoffMs) && maxBackoffMs >= 5000 ? maxBackoffMs : 60000,
  };
}

let _sandboxPassword = undefined;
function consumeSandboxPassword() {
  if (_sandboxPassword !== undefined) return _sandboxPassword;
  const v = process.env.KAGURA_RUNNER_SANDBOX_PASSWORD || "";
  _sandboxPassword = v;
  // Remove from runner process env after first read to reduce accidental exposure via child env dumps/logging.
  // The operator must supply it via secure env injection; it cannot be recovered after clearing.
  try { delete process.env.KAGURA_RUNNER_SANDBOX_PASSWORD; } catch {}
  return _sandboxPassword;
}

function getIsolationConfig() {
  const mode = normalizeIsolationMode(process.env.KAGURA_RUNNER_ISOLATION || "auto");
  const workspacesRoot = path.resolve(required("KAGURA_RUNNER_WORKSPACE_ROOT") || path.join(ROOT, "data", "verification", "workspaces"));
  const profilesRoot = path.resolve(required("KAGURA_RUNNER_PROFILE_ROOT") || path.join(ROOT, "data", "verification", "profiles"));
  const secretFiles = [".env.local", ".env.runner", ".env", ".env.development.local", ".env.production.local", ".env.test.local"]
    .map((f) => path.join(ROOT, f))
    .filter((f) => fsSyncExists(f));
  return {
    mode,
    sandboxUser: required("KAGURA_RUNNER_SANDBOX_USER") || undefined,
    get sandboxPassword() { return consumeSandboxPassword(); },
    workspacesRoot,
    profilesRoot,
    repoRoot: ROOT,
    secretFiles,
    isolateAllJobs: process.env.KAGURA_RUNNER_ISOLATE_ALL_JOBS === "true",
  };
}

let isolationAssessment = null;
async function assessIsolationOnce(config) {
  if (isolationAssessment) return isolationAssessment;
  const requiredExecutables = [process.execPath];
  const kaneEntry = resolveKaneCliEntry();
  if (kaneEntry) requiredExecutables.push(kaneEntry);
  isolationAssessment = assessIsolation(config, await probeIsolation({ ...config, requiredExecutables }));
  return isolationAssessment;
}

async function apiRequest(cfg, method, pathname, body, timeoutMs = 30000) {
  const url = `${cfg.base}${pathname}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 204) return { status: 204, data: null };
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, ok: res.ok, data };
  } finally {
    clearTimeout(t);
  }
}

function nextBackoff(current, max) {
  const base = current || 1000;
  return Math.min(max, Math.floor(base * 1.8));
}

const SYNC_DIR = path.join(ROOT, "data", "verification", "pending-sync");

async function enqueueSync(payload, reason) {
  await ensureDir(SYNC_DIR);
  const file = path.join(SYNC_DIR, `${payload.jobId || "job"}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await writeJsonAtomic(file, { payload, reason: String(reason || "sync_failed"), queuedAt: new Date().toISOString() });
  return file;
}

async function flushSyncQueue(cfg, runnerId) {
  await ensureDir(SYNC_DIR);
  let files = [];
  try {
    files = (await fs.readdir(SYNC_DIR)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { flushed: 0, remaining: 0 };
  }
  let flushed = 0;
  for (const f of files) {
    const full = path.join(SYNC_DIR, f);
    const item = await readJson(full, null);
    if (!item || !item.payload) {
      await fs.rm(full, { force: true }).catch(() => {});
      continue;
    }
    try {
      const res = await apiRequest(cfg, "POST", "/api/runner/complete", item.payload, 45000);
      if (res.status >= 200 && res.status < 300) {
        await fs.rm(full, { force: true }).catch(() => {});
        flushed++;
        log(`KAGURA RUNNER: pending sync delivered for job ${item.payload.jobId}`);
      } else if (res.status === 409 || res.status === 403 || res.status === 404) {
        // terminal/non-retriable for this payload; keep record for inspection by renaming
        const dead = `${full}.dead`;
        await fs.rename(full, dead).catch(() => {});
        log(`KAGURA RUNNER: pending sync rejected as non-retriable (HTTP ${res.status}) for job ${item.payload.jobId}; kept for inspection`);
      } else {
        return { flushed, remaining: files.length - flushed };
      }
    } catch {
      return { flushed, remaining: files.length - flushed };
    }
  }
  return { flushed, remaining: 0 };
}

function parseNdjson(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  let runEnd;
  let failingStep;
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt && evt.type === "run_end") runEnd = evt;
      if (evt && evt.status === "failed" && typeof evt.remark === "string" && !failingStep) failingStep = evt.remark;
    } catch {
      // ignore non-JSON
    }
  }
  return { runEnd, failingStep };
}

function mapOutcome(exitCode, runEndStatus) {
  if (exitCode === 0 && runEndStatus === "passed") return "passed";
  if (exitCode === 1) return "failed";
  if (exitCode === 2) return "did_not_start";
  if (exitCode === 3) return "timeout";
  if (runEndStatus === "failed") return "failed";
  return "blocked";
}

async function executeKaneJob(job, runnerId, onHeartbeat) {
  const startedAt = new Date().toISOString();

  function reject(summary) {
    return {
      jobId: job?.id,
      runnerId,
      claimedBy: runnerId,
      outcome: "did_not_start",
      exitCode: 2,
      summary,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  // 1) Validate every user-controlled field BEFORE any path is derived or process spawned.
  const validated = validateJobForExecution(job);
  if (!validated.ok) return reject(`Job rejected by runner validation: ${validated.reason}`);
  const { objective, url, flow, timeout: timeoutSec, headless } = validated;

  // 2) OS-level isolation gate. Ordinary-user jobs (recorded requestedBy) may only
  // execute under a genuine OS boundary; platform/legacy jobs (no requestedBy) run
  // under the shared runner account exactly as before.
  const isolation = getIsolationConfig();
  const requiresIsolation = requiresIsolationForJob(job, { isolateAllJobs: isolation.isolateAllJobs });
  if (requiresIsolation) {
    const assessment = await assessIsolationOnce(isolation);
    if (!assessment.ok) {
      log(`Isolation not ready: ${assessment.reason}`);
      return reject(
        `Refusing to execute ordinary-user job: OS-level isolation is unavailable (${assessment.reason}). ` +
          "Run scripts/setup-runner-isolation.ps1 and set KAGURA_RUNNER_SANDBOX_USER / KAGURA_RUNNER_SANDBOX_PASSWORD.",
      );
    }
    log(`OS-level isolation active as "${assessment.sandboxUser}" for job ${job.id}`);
  }

  // 2) Per-job isolation: dedicated working directory and Kane/Chrome profile.
  // NOTE: filesystem separation is not an OS security boundary. OS boundary is enforced
  // separately via sandbox account + ACLs when requiresIsolation is true.
  const workspacesRoot = isolation.workspacesRoot || path.join(ROOT, "data", "verification", "workspaces");
  const profilesRoot = isolation.profilesRoot || path.join(ROOT, "data", "verification", "profiles");
  const pathValidation = validateIsolationPaths({ repoRoot: ROOT, workspacesRoot, profilesRoot });
  if (!pathValidation.ok) {
    return reject(`Refusing to execute: isolation path configuration invalid (${pathValidation.errors.join("; ")}).`);
  }
  const jobCwd = workspaceDir(ROOT, job, { workspacesRoot, profilesRoot });
  if (!isInside(workspacesRoot, jobCwd) || path.resolve(jobCwd) === path.resolve(ROOT)) {
    return reject("Refusing to execute: could not derive a safe isolated workspace for this job.");
  }
  await ensureDir(jobCwd);

  let profile = profileDir(ROOT, job, { workspacesRoot, profilesRoot });
  if (typeof job.chromeProfile === "string" && job.chromeProfile.trim()) {
    const configured = path.resolve(ROOT, job.chromeProfile.trim());
    if (isInside(profilesRoot, configured)) profile = configured;
  }
  if (!isInside(profilesRoot, profile)) {
    await fs.rm(jobCwd, { recursive: true, force: true }).catch(() => {});
    return reject("Refusing to execute: could not derive a safe isolated Kane profile directory.");
  }
  await ensureDir(profile);

  // 3) Logs live inside the job's own workspace so one job's output is co-located with
  // its data and never written into a shared directory.
  const logsDir = path.join(jobCwd, "logs");
  await ensureDir(logsDir);
  const runId = randomUUID();
  const ndjsonPath = path.join(logsDir, `${runId}.ndjson`);
  if (!isInside(jobCwd, ndjsonPath)) {
    return reject("Refusing to execute: could not derive a safe log path for this job.");
  }

  const name = `kagura-${flow}`;

  // Approved, fixed argument set only. No user value is ever used as a command name.
  const args = ["run", objective, "--agent", "--url", url];
  if (headless) args.push("--headless");
  args.push("--timeout", String(timeoutSec));
  args.push("--name", name);
  args.push("--chrome-profile", profile);

  const userAgent = required("KANE_CLI_USER_AGENT") || "kilocode";
  // Job processes get a minimal environment. Runner tokens, GitHub tokens, DATABASE_URL,
  // NODE_OPTIONS and every other platform secret are never inherited.
  const env = buildChildEnv(process.env, {
    overrides: { KANE_CLI_USER_AGENT: userAgent },
    extraNames: extraChildEnvNames(),
  });

  // 4) Spawn without a shell. On Windows `kane-cli` is an npm .cmd shim, and routing it
  // through cmd.exe would let cmd metacharacters in job input execute arbitrary commands.
  // Instead we invoke the underlying Node entry point directly with node.exe. When OS-level
  // isolation is active the process is launched as the restricted sandbox account via
  // PowerShell (arguments passed as data, never interpolated into a command string), with
  // stdout/stderr redirected to files inside the job workspace.
  let spawnTarget;
  let spawnArgs;
  let sandboxed = false;
  let sandboxOutFile = "";
  let sandboxErrFile = "";
  if (process.platform === "win32") {
    const entry = resolveKaneCliEntry();
    if (!entry) {
      return reject(
        "Runner misconfigured: could not locate the kane-cli Node entry point. " +
          "Set KAGURA_KANE_CLI_JS to the absolute path of kane-cli.cjs (the npm .cmd shim is never used).",
      );
    }
    const assessment = isolation.mode === "account" ? isolationAssessment : null;
    if (requiresIsolation && assessment?.ok) {
      sandboxed = true;
      sandboxOutFile = path.join(jobCwd, "logs", `stdout-${runId}.txt`);
      sandboxErrFile = path.join(jobCwd, "logs", `stderr-${runId}.txt`);
      // The sandbox password is never embedded in the command line. It is written to
      // a per-job file inside the workspace and ACL-locked so only the sandbox account
      // (and SYSTEM/Administrators) can read it; PowerShell reads it at spawn time.
      const pwFile = path.join(os.tmpdir(), `kagura-sandbox-pw-${runId}.txt`);
      await fs.writeFile(pwFile, isolation.sandboxPassword, { encoding: "utf8", mode: 0o600 }).catch(() => {});
      try {
        await spawn("icacls", [pwFile, "/inheritance:r", "/grant:r", `${assessment.sandboxUser}:(R)`, "/grant:r", "SYSTEM:(R)"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).catch(() => {});
      } catch {}
      spawnTarget = "powershell.exe";
      spawnArgs = buildSandboxSpawnCommand({
        nodeExe: process.execPath,
        cliEntry: entry,
        args,
        cwd: jobCwd,
        stdoutFile: sandboxOutFile,
        stderrFile: sandboxErrFile,
        sandboxUser: assessment.sandboxUser,
        passwordFile: pwFile,
      });
    } else {
      spawnTarget = process.execPath;
      spawnArgs = [entry, ...args];
    }
  } else {
    const bin = required("KAGURA_KANE_CLI_BIN") || "kane-cli";
    if (!isShellSafeArg(bin)) return reject("Runner misconfigured: unsafe KAGURA_KANE_CLI_BIN value.");
    spawnTarget = bin;
    spawnArgs = args;
  }

  const child = spawn(spawnTarget, spawnArgs, {
    env: sandboxed ? {} : env,
    cwd: sandboxed ? jobCwd : jobCwd,
    shell: false,
    windowsVerbatimArguments: false,
    windowsHide: true,
    stdio: sandboxed ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  const hbTimer = setInterval(() => {
    onHeartbeat("executing").catch(() => {});
  }, 30000);

  const closeResult = await new Promise((resolve) => {
    child.on("error", async (err) => {
      clearInterval(hbTimer);
      await fs.writeFile(ndjsonPath, "", "utf8").catch(() => {});
      resolve({
        exitCode: 2,
        outcome: "did_not_start",
        summary: `Failed to start kane-cli: ${err.message}`,
        stdout: "",
        stderr,
      });
    });
    child.on("close", (code) => {
      clearInterval(hbTimer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });

  // When sandboxed, Kane's stdout/stderr were redirected to files inside the job
  // workspace; read them back so NDJSON parsing and evidence work unchanged. The
  // per-job password file is deleted immediately after the process exits.
  let finalStdout = stdout;
  let finalStderr = stderr;
  if (sandboxed) {
    try { finalStdout = await fs.readFile(sandboxOutFile, "utf8"); } catch {}
    try { finalStderr = await fs.readFile(sandboxErrFile, "utf8"); } catch {}
    const pwFile = path.join(os.tmpdir(), `kagura-sandbox-pw-${runId}.txt`);
    await fs.rm(pwFile, { force: true }).catch(() => {});
  }

  await fs.writeFile(ndjsonPath, closeResult.stdout || finalStdout || "", "utf8").catch(() => {});
  const { runEnd, failingStep } = parseNdjson(closeResult.stdout || finalStdout || "");
  const runEndStatus = typeof runEnd?.status === "string" ? runEnd.status : undefined;
  const outcome = closeResult.outcome || mapOutcome(closeResult.exitCode ?? null, runEndStatus);
  const durationRaw = runEnd?.duration;
  const durationMs =
    typeof durationRaw === "number"
      ? Math.round(durationRaw * 1000)
      : typeof durationRaw === "string" && !Number.isNaN(Number(durationRaw))
        ? Math.round(Number(durationRaw) * 1000)
        : undefined;
  const evidenceMatch = String(closeResult.stderr || finalStderr || "").match(/(\S+\.evidence\b)/i);

  return {
    jobId: job.id,
    runnerId,
    claimedBy: runnerId,
    recordId: job.recordId || job.id,
    outcome,
    exitCode: typeof closeResult.exitCode === "number" ? closeResult.exitCode : null,
    summary:
      typeof runEnd?.summary === "string"
        ? runEnd.summary
        : typeof runEnd?.one_liner === "string"
          ? runEnd.one_liner
          : closeResult.summary,
    failingStep,
    durationMs,
    creditsConsumed: typeof runEnd?.credits_consumed === "number" ? runEnd.credits_consumed : undefined,
    evidencePath: evidenceMatch?.[1],
    testUrl: typeof runEnd?.test_url === "string" ? runEnd.test_url : undefined,
    sessionDir: typeof runEnd?.session_dir === "string" ? runEnd.session_dir : undefined,
    ndjsonPath,
    workspaceDir: path.relative(ROOT, jobCwd).replace(/\\/g, "/"),
    runEnd,
    stderr: (closeResult.stderr || finalStderr || undefined) ? String(closeResult.stderr || finalStderr) : undefined,
    command: `${JSON.stringify(spawnTarget)} ${spawnArgs.map((a) => JSON.stringify(a)).join(" ")} (shell: false, cwd: ${path.relative(ROOT, jobCwd).replace(/\\/g, "/") || "."})`,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/**
 * Best-effort removal of stale per-job workspaces. Disabled by default
 * (KAGURA_RUNNER_WORKSPACE_RETENTION_DAYS=0) so evidence is never silently destroyed.
 * When enabled, only directories under the workspaces root older than the retention
 * window are removed — never the current job's workspace, and never arbitrary paths.
 */
async function pruneStaleWorkspaces(retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { removed: 0 };
  const workspacesRoot = path.join(ROOT, "data", "verification", "workspaces");
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries = [];
  try {
    entries = await fs.readdir(workspacesRoot, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(workspacesRoot, entry.name);
    if (!isInside(workspacesRoot, full)) continue;
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(full, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // ignore individual failures
    }
  }
  return { removed };
}

export async function runRunnerLoop(deps = {}) {
  await loadEnv();
  const cfg = deps.cfg ?? getConfig();
  const isolation = deps.isolation ?? getIsolationConfig();
  log(`Runner isolation: mode=${isolation.mode} sandboxUser=${isolation.sandboxUser || "(none)"}`);
  if (!cfg.base) {
    console.error("KAGURA_RUNNER_TOKEN/KAGURA_APP_URL configuration error: KAGURA_APP_URL is required.");
    return { exitCode: 2, reason: "configuration_missing" };
  }
  if (!cfg.token) {
    console.error("KAGURA_RUNNER_TOKEN/KAGURA_APP_URL configuration error: KAGURA_RUNNER_TOKEN is required.");
    return { exitCode: 2, reason: "configuration_missing" };
  }

  const runnerId = deps.runnerId ?? await getOrCreateRunnerId();
  const version = deps.version ?? getVersion();
  const assessReadiness = deps.assessReadiness ?? ((opts) => assessKaneReadiness(opts));
  const assessIsolationFn = deps.assessIsolation ?? assessIsolationOnce;
  const requiresIsolationFn = deps.requiresIsolation ?? ((job, isolateAll) => requiresIsolationForJob(job, { isolateAllJobs: isolateAll }));
  const executeJob = deps.executeKaneJob ?? executeKaneJob;
  const apiRequestFn = deps.apiRequest ?? apiRequest;
  const syncWithRetry = deps.syncCompletionWithRetry ?? ((c, pld) => syncCompletionWithRetry(c, pld));
  const enqueuePendingSyncFn = deps.enqueuePendingSync ?? enqueueSync;
  const sleepFn = deps.sleep ?? sleep;
  const flushSyncQueueFn = deps.flushSyncQueue ?? flushSyncQueue;
  const pruneStaleWorkspacesFn = deps.pruneStaleWorkspaces ?? pruneStaleWorkspaces;
  const maxJobs = Number.isFinite(deps.maxJobs) ? deps.maxJobs : Infinity;
  const stopAfterMs = Number.isFinite(deps.stopAfterMs) ? deps.stopAfterMs : null;
  const startedLoopAt = Date.now();

  let stopping = false;
  let executing = false;
  let claimBackoff = 1000;
  let hbBackoff = 1000;
  let lastHeartbeatOk = false;
  let processedJobs = 0;
  let lastReadiness = { state: READINESS_STATES.UNKNOWN, ready: false, reason: "Kane readiness has not been checked yet." };

  async function refreshReadiness(note = "readiness-check") {
    const browserProfile = path.join(isolation.profilesRoot, "readiness-probe");
    const readiness = await assessReadiness({
      rootDir: ROOT,
      env: process.env,
      timeoutMs: Number(process.env.KAGURA_KANE_READINESS_TIMEOUT_MS || 15000),
      profileDir: browserProfile,
      chromeProfileDir: browserProfile,
    });
    lastReadiness = {
      state: readiness.state,
      ready: readiness.ready === true,
      checkedAt: readiness.checkedAt,
      reason: readiness.reason,
      details: readiness.details,
    };
    if (!lastReadiness.ready) log(`Kane readiness: ${lastReadiness.state}${lastReadiness.reason ? ` (${lastReadiness.reason})` : ""}`);
    return lastReadiness;
  }

  const requestStop = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`KAGURA RUNNER: shutdown requested (${sig}). ${executing ? "Will stop after current job completes/syncs." : "Stopping."}`);
  };
  if (!deps.disableSignals) {
    process.on("SIGINT", () => requestStop("SIGINT"));
    process.on("SIGTERM", () => requestStop("SIGTERM"));
  }

  async function sendHeartbeat(note, currentJobId) {
    try {
      const res = await apiRequestFn(cfg, "POST", "/api/runner/heartbeat", {
        runnerId,
        version,
        currentJobId: currentJobId || undefined,
        note: note || undefined,
        readiness: lastReadiness,
      });
      if (res.status >= 200 && res.status < 300) {
        if (!lastHeartbeatOk) log("Heartbeat successful");
        lastHeartbeatOk = true;
        hbBackoff = 1000;
        return true;
      }
      lastHeartbeatOk = false;
      return false;
    } catch {
      lastHeartbeatOk = false;
      return false;
    }
  }

  log("KAGURA RUNNER STARTED");
  log(`Backend: ${redactUrl(cfg.base)}`);
  log(`Runner ID: ${runnerId}`);
  log(`Runner version: ${version}`);

  try {
    await refreshReadiness("startup");
    const probe = await apiRequestFn(cfg, "POST", "/api/runner/heartbeat", { runnerId, version, note: "startup", readiness: lastReadiness });
    if (probe.status === 401 || probe.status === 403) {
      console.error("Runner authentication failed (unauthorized). Check KAGURA_RUNNER_TOKEN.");
      return { exitCode: 1, reason: "unauthorized" };
    }
    if (probe.status >= 200 && probe.status < 300) {
      log("Backend connected");
      log("Runner authenticated");
      log("Heartbeat successful");
      lastHeartbeatOk = true;
    } else {
      log(`Backend reachable but heartbeat returned HTTP ${probe.status}; will retry.`);
    }
  } catch {
    log("Backend not reachable at startup; will retry with backoff.");
  }

  try {
    const flushed = await flushSyncQueueFn(cfg, runnerId);
    if (flushed.flushed > 0) log(`KAGURA RUNNER: flushed ${flushed.flushed} pending sync payload(s)`);
  } catch {}

  const retentionDays = Number(process.env.KAGURA_RUNNER_WORKSPACE_RETENTION_DAYS || 0);
  if (retentionDays > 0) {
    try {
      const pruned = await pruneStaleWorkspacesFn(retentionDays);
      if (pruned.removed > 0) log(`KAGURA RUNNER: pruned ${pruned.removed} stale job workspace(s)`);
    } catch {}
  }

  let idleHeartbeatAt = 0;
  while (!stopping) {
    if (stopAfterMs != null && Date.now() - startedLoopAt >= stopAfterMs) break;
    if (processedJobs >= maxJobs) break;

    const now = Date.now();
    if (now - idleHeartbeatAt >= cfg.heartbeatMs) {
      const ok = await sendHeartbeat("idle");
      idleHeartbeatAt = Date.now();
      if (!ok) {
        await sleepFn(hbBackoff);
        hbBackoff = nextBackoff(hbBackoff, cfg.maxBackoffMs);
        continue;
      }
    }

    try { await flushSyncQueueFn(cfg, runnerId); } catch {}
    if (executing) { await sleepFn(500); continue; }

    log("Checking for jobs...");
    let claimRes;
    try {
      claimRes = await apiRequestFn(cfg, "POST", "/api/runner/claim", { runnerId, version }, 30000);
    } catch {
      await sleepFn(claimBackoff);
      claimBackoff = nextBackoff(claimBackoff, cfg.maxBackoffMs);
      continue;
    }

    if (claimRes.status === 401 || claimRes.status === 403) {
      console.error("Runner authentication failed during claim (unauthorized). Check KAGURA_RUNNER_TOKEN.");
      await sleepFn(claimBackoff);
      claimBackoff = nextBackoff(claimBackoff, cfg.maxBackoffMs);
      continue;
    }
    if (claimRes.status === 204) {
      claimBackoff = 1000;
      await sleepFn(cfg.pollMs);
      continue;
    }
    if (!(claimRes.status >= 200 && claimRes.status < 300) || !claimRes.data || !claimRes.data.job) {
      await sleepFn(claimBackoff);
      claimBackoff = nextBackoff(claimBackoff, cfg.maxBackoffMs);
      continue;
    }

    claimBackoff = 1000;
    const job = claimRes.data.job;
    log(`Job received: ${job.id}`);
    executing = true;
    await sendHeartbeat("claimed", job.id);

    await refreshReadiness("pre-execution");
    const requiresIso = requiresIsolationFn(job, isolation.isolateAllJobs);
    let isolationState = null;
    if (requiresIso) isolationState = await assessIsolationFn(isolation);
    const blockedReason = !lastReadiness.ready
      ? `Runner readiness blocked: ${lastReadiness.state}${lastReadiness.reason ? ` - ${lastReadiness.reason}` : ""}`
      : (requiresIso && isolationState && !isolationState.ok)
        ? `Runner readiness blocked: isolation_unavailable - ${isolationState.reason || "OS isolation unavailable"}`
        : null;
    if (blockedReason) {
      const finishedAt = new Date().toISOString();
      const blockedPayload = {
        jobId: job.id, runnerId, claimedBy: runnerId, recordId: job.recordId || job.id,
        outcome: "did_not_start", exitCode: null, summary: blockedReason, failingStep: "Runner readiness",
        durationMs: 0, runEnd: { status: "did_not_start", summary: blockedReason }, stderr: "", command: "kane-readiness",
        startedAt: finishedAt, finishedAt,
      };
      log(`Readiness blocked execution for job ${job.id}: ${lastReadiness.state}`);
      await sendHeartbeat("blocked", job.id);
      try {
        const syncRes = await syncWithRetry(cfg, blockedPayload);
        if (syncRes.ok) log(`KAGURA RUNNER: synced blocked/readiness job ${job.id}`);
        else {
          const nonRetriable = syncRes.status === 409 || syncRes.status === 403 || syncRes.status === 404;
          await enqueuePendingSyncFn(blockedPayload, syncRes.reason, nonRetriable);
          log(`KAGURA RUNNER: readiness-blocked sync not completed for ${job.id} (${syncRes.reason || `HTTP ${syncRes.status}`}); retained.`);
        }
      } catch (err) {
        await enqueuePendingSyncFn(blockedPayload, err instanceof Error ? err.message : String(err), false);
      }
      processedJobs++;
      executing = false;
      await sendHeartbeat("idle");
      await sleepFn(250);
      continue;
    }

    let resultPayload;
    try {
      log("Executing Kane verification...");
      resultPayload = await executeJob(job, runnerId, async (note) => sendHeartbeat(note, job.id));
      log(`Execution finished: ${resultPayload.outcome || "unknown"}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resultPayload = {
        jobId: job.id, runnerId, claimedBy: runnerId, outcome: "did_not_start", exitCode: 2,
        summary: `Runner execution error: ${msg}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      };
      log("Execution finished: did_not_start");
    }

    log("Synchronizing result...");
    const syncRes = await syncWithRetry(cfg, resultPayload);
    if (!syncRes.ok) {
      const nonRetriable = syncRes.status === 409 || syncRes.status === 403 || syncRes.status === 404;
      await enqueuePendingSyncFn(resultPayload, syncRes.reason, nonRetriable);
      log(`KAGURA RUNNER: sync not completed for ${job.id} (${syncRes.reason || `HTTP ${syncRes.status}`}); payload retained for retry.`);
    } else {
      log("Result synchronized successfully");
    }

    processedJobs++;
    executing = false;
    await sendHeartbeat("idle");
  }

  try { await refreshReadiness("shutdown"); await flushSyncQueueFn(cfg, runnerId); } catch {}
  await sendHeartbeat(stopping ? "stopping" : "idle");
  log("KAGURA RUNNER: stopped.");
  return { exitCode: 0, reason: "stopped", processedJobs };
}

async function main() {
  const res = await runRunnerLoop();
  if (res && typeof res.exitCode === "number" && res.exitCode !== 0) process.exit(res.exitCode);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
