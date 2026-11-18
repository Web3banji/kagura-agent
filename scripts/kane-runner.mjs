#!/usr/bin/env node
/**
 * KAGURA persistent Windows/local Kane runner (Stage 2).
 * - Coordinator: deployed KAGURA app (Vercel). Executes Kane CLI ONLY locally.
 * - Claims jobs via /api/runner/claim, sends /api/runner/heartbeat, syncs /api/runner/complete.
 * - Genuine execution only (no simulation). Reuses kane-verify execution/parsing behavior.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

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
  const objective = String(job.objective || "").trim();
  const url = String(job.url || "").trim();
  if (!objective || !url) {
    return {
      jobId: job.id,
      runnerId,
      claimedBy: runnerId,
      outcome: "did_not_start",
      exitCode: 2,
      summary: "Job missing required objective or url; cannot execute genuine Kane verification.",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  const outDir = path.join(ROOT, "data", "verification", "runs");
  await ensureDir(outDir);
  const runId = randomUUID();
  const ndjsonPath = path.join(outDir, `${runId}.ndjson`);
  const startedAt = new Date().toISOString();

  const profile = path.resolve(ROOT, "data", "verification", "kane-chrome-profile");
  await ensureDir(profile);

  const timeoutSec = typeof job.timeout === "number" && job.timeout > 0 ? Math.floor(job.timeout) : 180;
  const headless = job.headless !== false;
  const name = `kagura-${String(job.flow || "job").replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  const args = ["run", objective, "--agent", "--url", url];
  if (headless) args.push("--headless");
  args.push("--timeout", String(timeoutSec));
  args.push("--name", name);
  args.push("--chrome-profile", profile);

  const userAgent = required("KANE_CLI_USER_AGENT") || "kilocode";
  const env = { ...process.env, KANE_CLI_USER_AGENT: userAgent };

  const isWin = process.platform === "win32";
  const child = isWin
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "kane-cli", ...args], {
        env,
        cwd: ROOT,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn("kane-cli", args, { shell: false, env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

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

  await fs.writeFile(ndjsonPath, closeResult.stdout || stdout || "", "utf8").catch(() => {});
  const { runEnd, failingStep } = parseNdjson(closeResult.stdout || stdout || "");
  const runEndStatus = typeof runEnd?.status === "string" ? runEnd.status : undefined;
  const outcome = closeResult.outcome || mapOutcome(closeResult.exitCode ?? null, runEndStatus);
  const durationRaw = runEnd?.duration;
  const durationMs =
    typeof durationRaw === "number"
      ? Math.round(durationRaw * 1000)
      : typeof durationRaw === "string" && !Number.isNaN(Number(durationRaw))
        ? Math.round(Number(durationRaw) * 1000)
        : undefined;
  const evidenceMatch = String(closeResult.stderr || stderr || "").match(/(\S+\.evidence\b)/i);

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
    runEnd,
    stderr: (closeResult.stderr || stderr || undefined) ? String(closeResult.stderr || stderr) : undefined,
    command: `KANE_CLI_USER_AGENT=${userAgent} kane-cli run --agent --url <target>`,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

async function main() {
  await loadEnv();
  const cfg = getConfig();
  if (!cfg.base) {
    console.error("KAGURA_RUNNER_TOKEN/KAGURA_APP_URL configuration error: KAGURA_APP_URL is required.");
    process.exit(2);
  }
  if (!cfg.token) {
    console.error("KAGURA_RUNNER_TOKEN/KAGURA_APP_URL configuration error: KAGURA_RUNNER_TOKEN is required.");
    process.exit(2);
  }

  const runnerId = await getOrCreateRunnerId();
  const version = getVersion();

  let stopping = false;
  let executing = false;
  let claimBackoff = 1000;
  let hbBackoff = 1000;
  let lastHeartbeatOk = false;

  const requestStop = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`KAGURA RUNNER: shutdown requested (${sig}). ${executing ? "Will stop after current job completes/syncs." : "Stopping."}`);
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  async function sendHeartbeat(note, currentJobId) {
    try {
      const res = await apiRequest(cfg, "POST", "/api/runner/heartbeat", {
        runnerId,
        version,
        currentJobId: currentJobId || undefined,
        note: note || undefined,
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

  // Initial connectivity/auth probe via heartbeat (token never logged)
  try {
    const probe = await apiRequest(cfg, "POST", "/api/runner/heartbeat", { runnerId, version, note: "startup" });
    if (probe.status === 401 || probe.status === 403) {
      console.error("Runner authentication failed (unauthorized). Check KAGURA_RUNNER_TOKEN.");
      process.exit(1);
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

  // Flush any pending sync payloads from previous runs
  try {
    const flushed = await flushSyncQueue(cfg, runnerId);
    if (flushed.flushed > 0) log(`KAGURA RUNNER: flushed ${flushed.flushed} pending sync payload(s)`);
  } catch {}

  let idleHeartbeatAt = 0;
  while (!stopping) {
    // periodic idle heartbeat
    const now = Date.now();
    if (now - idleHeartbeatAt >= cfg.heartbeatMs) {
      const ok = await sendHeartbeat("idle");
      idleHeartbeatAt = Date.now();
      if (!ok) {
        await sleep(hbBackoff);
        hbBackoff = nextBackoff(hbBackoff, cfg.maxBackoffMs);
        continue;
      }
    }

    // attempt to flush pending syncs opportunistically
    try {
      await flushSyncQueue(cfg, runnerId);
    } catch {}

    if (executing) {
      await sleep(500);
      continue;
    }

    log("Checking for jobs...");
    let claimRes;
    try {
      claimRes = await apiRequest(cfg, "POST", "/api/runner/claim", { runnerId, version }, 30000);
    } catch {
      await sleep(claimBackoff);
      claimBackoff = nextBackoff(claimBackoff, cfg.maxBackoffMs);
      continue;
    }

    if (claimRes.status === 401 || claimRes.status === 403) {
      console.error("Runner authentication failed during claim (unauthorized). Check KAGURA_RUNNER_TOKEN.");
      await sleep(claimBackoff);
      claimBackoff = nextBackoff(claimBackoff, cfg.maxBackoffMs);
      continue;
    }
    if (claimRes.status === 204) {
      claimBackoff = 1000;
      await sleep(cfg.pollMs);
      continue;
    }
    if (!(claimRes.status >= 200 && claimRes.status < 300) || !claimRes.data || !claimRes.data.job) {
      await sleep(claimBackoff);
      claimBackoff = nextBackoff(claimBackoff, cfg.maxBackoffMs);
      continue;
    }

    claimBackoff = 1000;
    const job = claimRes.data.job;
    log(`Job received: ${job.id}`);
    executing = true;
    await sendHeartbeat("claimed", job.id);

    let resultPayload;
    try {
      log("Executing Kane verification...");
      resultPayload = await executeKaneJob(job, runnerId, async (note) => sendHeartbeat(note, job.id));
      log(`Execution finished: ${resultPayload.outcome || "unknown"}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resultPayload = {
        jobId: job.id,
        runnerId,
        claimedBy: runnerId,
        outcome: "did_not_start",
        exitCode: 2,
        summary: `Runner execution error: ${msg}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      log("Execution finished: did_not_start");
    }

    // Sync result with bounded retries; never discard
    log("Synchronizing result...");
    let synced = false;
    let syncDelay = 1000;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const completeRes = await apiRequest(cfg, "POST", "/api/runner/complete", resultPayload, 45000);
        if (completeRes.status >= 200 && completeRes.status < 300) {
          synced = true;
          log("Result synchronized successfully");
          break;
        }
        if (completeRes.status === 409 || completeRes.status === 403 || completeRes.status === 404) {
          const file = await enqueueSync(resultPayload, `non-retriable-${completeRes.status}`);
          log(`KAGURA RUNNER: sync not accepted (HTTP ${completeRes.status}); payload retained at ${path.relative(ROOT, file)}`);
          synced = true; // retained, not silently discarded
          break;
        }
      } catch {}
      if (attempt < 5) {
        await sleep(syncDelay);
        syncDelay = nextBackoff(syncDelay, 30000);
      }
    }
    if (!synced) {
      const file = await enqueueSync(resultPayload, "retry-exhausted");
      log(`KAGURA RUNNER: sync unavailable; payload retained locally at ${path.relative(ROOT, file)}`);
    }

    await sendHeartbeat("idle");
    executing = false;

    if (stopping) break;
  }

  // best-effort final heartbeat/flush
  try {
    await flushSyncQueue(cfg, runnerId);
  } catch {}
  await sendHeartbeat(stopping ? "stopping" : "idle");
  log("KAGURA RUNNER STOPPED");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`KAGURA RUNNER: fatal error: ${msg}`);
  process.exit(1);
});
