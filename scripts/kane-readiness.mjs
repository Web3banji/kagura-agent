/**
 * KAGURA runner Kane CLI readiness assessment.
 *
 * Pure classification/helpers are exported for deterministic tests. The default
 * command runner uses child_process.spawn with shell:false; tests inject a fake
 * runner and never execute Kane CLI.
 *
 * CLI contract basis (static inspection, @testmuai/kane-cli@0.10.8 installed):
 * - `kane-cli whoami` exits 0 when verified, 1 for missing/not-authenticated or
 *   rejected/expired auth, 3 when server unreachable (index.js whoami action).
 * - `kane-cli --version` prints version (commander default).
 * - Executable resolved via package bin/resolve-runtime; runner already resolves
 *   node entrypoint for Windows shell:false execution.
 *
 * This module does NOT print or return raw CLI output. It returns sanitized
 * reason codes/messages only.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const READINESS_STATES = Object.freeze({
  READY: "ready",
  KANE_MISSING: "kane_missing",
  KANE_UNAUTHENTICATED: "kane_unauthenticated",
  KANE_AUTH_EXPIRED: "kane_auth_expired",
  BROWSER_UNAVAILABLE: "browser_unavailable",
  PROFILE_UNAVAILABLE: "profile_unavailable",
  ISOLATION_UNAVAILABLE: "isolation_unavailable",
  CONFIGURATION_MISSING: "configuration_missing",
  UNKNOWN: "unknown",
});

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 1000;

export function clampReadinessTimeoutMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

export function sanitizeReadinessText(value, max = 240) {
  if (value == null) return "";
  let s = String(value);
  // Redact common secret-bearing patterns before any truncation/logging.
  s = s.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]");
  s = s.replace(/(KAGURA_[A-Z0-9_]*TOKEN|LT_ACCESS_KEY|LT_USERNAME|access[_-]?key|password|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  s = s.replace(/[A-Za-z0-9_\-]{24,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, "[REDACTED_JWT]");
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

export function resolveKaneCliEntry(rootDir = process.cwd()) {
  const override = process.env.KAGURA_KANE_CLI_JS;
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.resolve(rootDir, override);
    return fs.existsSync(abs) ? abs : null;
  }
  try {
    const resolved = require.resolve("@testmuai/kane-cli/bin/kane-cli.cjs", { paths: [rootDir, process.cwd()] });
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {}
  const candidates = [
    path.join(rootDir, "node_modules", "@testmuai", "kane-cli", "bin", "kane-cli.cjs"),
    path.join(process.cwd(), "node_modules", "@testmuai", "kane-cli", "bin", "kane-cli.cjs"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

export function classifyWhoamiResult({ exitCode, stdout = "", stderr = "", timedOut = false, spawnError = null }) {
  if (spawnError) {
    const code = spawnError.code || "";
    if (code === "ENOENT") return { state: READINESS_STATES.KANE_MISSING, reason: "Kane CLI executable not found." };
    return { state: READINESS_STATES.UNKNOWN, reason: "Kane CLI readiness check could not be started." };
  }
  if (timedOut) return { state: READINESS_STATES.UNKNOWN, reason: "Kane CLI readiness check timed out." };
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (exitCode === 0) {
    // Guard: only treat explicit verified/authenticated signals as ready.
    if (/not.?authenticated|not logged in|login required|missing/.test(text) && !/authenticated/.test(text.replace(/not.?authenticated/g, ""))) {
      return { state: READINESS_STATES.KANE_UNAUTHENTICATED, reason: "Kane CLI authentication required." };
    }
    return { state: READINESS_STATES.READY, reason: "Kane CLI authenticated." };
  }
  if (/not.?authenticated|not logged in|no active profile|login required|whoami: not-authenticated/.test(text)) {
    return { state: READINESS_STATES.KANE_UNAUTHENTICATED, reason: "Kane CLI authentication required." };
  }
  if (/expired|rejected|refresh failed|invalid credentials|unauthorized|forbidden|401|403/.test(text)) {
    return { state: READINESS_STATES.KANE_AUTH_EXPIRED, reason: "Kane CLI authentication expired or invalid." };
  }
  if (exitCode === 3 || /unreachable|network|econn|enotfound|timeout/.test(text)) {
    return { state: READINESS_STATES.UNKNOWN, reason: "Kane CLI authentication could not be verified due to an unreachable service." };
  }
  if (exitCode === 1) {
    // Exit 1 is ambiguous in CLI; prefer unauthenticated/expired only with signals, else unknown.
    return { state: READINESS_STATES.UNKNOWN, reason: "Kane CLI readiness check failed." };
  }
  return { state: READINESS_STATES.UNKNOWN, reason: "Kane CLI readiness check returned an unknown result." };
}

function defaultRunCommand(cmd, args, opts) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, opts.timeoutMs);
    child.stdout?.on("data", (d) => { if (stdout.length < 16000) stdout += String(d); });
    child.stderr?.on("data", (d) => { if (stderr.length < 16000) stderr += String(d); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr, timedOut, spawnError: err });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: typeof code === "number" ? code : null, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

export function getReadinessBlockReason({ readiness, isolationAssessment, requiresIsolation }) {
  if (!readiness?.ready) {
    return `Runner readiness blocked: ${readiness?.state || READINESS_STATES.UNKNOWN}${readiness?.reason ? ` - ${sanitizeReadinessText(readiness.reason)}` : ""}`;
  }
  if (requiresIsolation && isolationAssessment && !isolationAssessment.ok) {
    return `Runner readiness blocked: ${READINESS_STATES.ISOLATION_UNAVAILABLE} - ${sanitizeReadinessText(isolationAssessment.reason || "OS isolation unavailable")}`;
  }
  return null;
}

export function assessBrowserPrerequisites({ profileDir, chromeProfileDir } = {}) {
  const dir = chromeProfileDir || profileDir;
  if (!dir) return { ok: false, state: READINESS_STATES.PROFILE_UNAVAILABLE, reason: "Kane browser profile path is unavailable." };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".kagura-readiness-probe");
    fs.writeFileSync(probe, "ok", "utf8");
    fs.rmSync(probe, { force: true });
  } catch {
    return { ok: false, state: READINESS_STATES.PROFILE_UNAVAILABLE, reason: "Kane browser profile path is not writable." };
  }
  const chromePath = process.env.CHROME_PATH || process.env.KAGURA_CHROME_PATH;
  if (chromePath) {
    const abs = path.isAbsolute(chromePath) ? chromePath : path.resolve(process.cwd(), chromePath);
    if (!fs.existsSync(abs)) return { ok: false, state: READINESS_STATES.BROWSER_UNAVAILABLE, reason: "Configured Chrome executable was not found." };
  }
  // Chrome may be discoverable by Kane CLI itself; absence of CHROME_PATH is not a failure.
  return { ok: true };
}

export async function assessKaneReadiness({
  rootDir = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  profileDir,
  chromeProfileDir,
  runCommand = defaultRunCommand,
  resolveEntry = resolveKaneCliEntry,
} = {}) {
  const checkedAt = new Date().toISOString();
  const timeout = clampReadinessTimeoutMs(timeoutMs);
  const entry = resolveEntry(rootDir);
  if (!entry) {
    return { state: READINESS_STATES.KANE_MISSING, ready: false, checkedAt, reason: "Kane CLI executable could not be resolved.", details: { cliResolved: false } };
  }

  const browser = assessBrowserPrerequisites({ profileDir, chromeProfileDir });
  if (!browser.ok) {
    return { state: browser.state, ready: false, checkedAt, reason: browser.reason, details: { cliResolved: true } };
  }

  const cmd = process.execPath;
  const args = [entry, "whoami"];
  const childEnv = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === "string") childEnv[k] = v;
  }
  childEnv.KANE_CLI_USER_AGENT = childEnv.KANE_CLI_USER_AGENT || "kilocode";

  let result;
  try {
    result = await runCommand(cmd, args, { cwd: rootDir, env: childEnv, timeoutMs: timeout });
  } catch (e) {
    return { state: READINESS_STATES.UNKNOWN, ready: false, checkedAt, reason: "Kane CLI readiness check failed to run.", details: { cliResolved: true } };
  }

  const classified = classifyWhoamiResult(result);
  return {
    state: classified.state,
    ready: classified.state === READINESS_STATES.READY,
    checkedAt,
    reason: sanitizeReadinessText(classified.reason),
    details: {
      cliResolved: true,
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      timedOut: !!result.timedOut,
    },
  };
}
