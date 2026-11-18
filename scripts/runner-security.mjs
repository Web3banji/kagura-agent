/**
 * Security helpers for the KAGURA local Kane runner.
 *
 * The runner is shared infrastructure executing jobs on behalf of many users. Everything
 * in this module is pure (no fs, no child_process, no env reads) so it can be unit tested
 * without executing Kane.
 *
 * Two independent defences are implemented:
 *  1. Strict validation of every user-controlled job field, before anything is spawned.
 *  2. A minimal child environment, so job processes never inherit platform secrets.
 */

export const MAX_OBJECTIVE_LEN = 4000;
export const MAX_URL_LEN = 2048;
export const MAX_FLOW_LEN = 40;
export const MIN_TIMEOUT_SEC = 10;
export const MAX_TIMEOUT_SEC = 1800;
export const DEFAULT_TIMEOUT_SEC = 180;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Environment variable names that must never reach a job process. */
const SECRET_NAME_PATTERNS = [
  /^KAGURA_/i,
  /^ECHOLOG_/i,
  /^GITHUB_/i,
  /^GH_/i,
  /^KANE_.*(TOKEN|KEY|SECRET)/i,
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY)$/i,
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY)_/i,
  /^DATABASE_URL$/i,
  /^NODE_OPTIONS$/i,
  /^NODE_PATH$/i,
  /^_$/,
];

/** Environment variables a browser/Kane process legitimately needs. */
export const SAFE_CHILD_ENV_NAMES = [
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "LANG",
  "LC_ALL",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "KANE_CLI_USER_AGENT",
];

export function isSecretEnvName(name) {
  if (!name) return true;
  return SECRET_NAME_PATTERNS.some((re) => re.test(name));
}

/**
 * Windows environment variable names are case-insensitive but preserve whatever
 * casing the parent used ("Path", "SystemRoot", "windir"). Compare lowercased so
 * a legitimate variable is never dropped just because of casing.
 */
function normalizeEnvName(name) {
  return String(name).toLowerCase();
}

const SAFE_CHILD_ENV_NAME_SET = new Set(SAFE_CHILD_ENV_NAMES.map(normalizeEnvName));

/**
 * Build a minimal child environment from an allowlist.
 * `extraNames` lets an operator opt specific names back in (never secrets).
 */
export function buildChildEnv(baseEnv, opts) {
  const base = baseEnv || {};
  const extras = Array.isArray(opts?.extraNames) ? opts.extraNames : [];
  const allowed = new Set([...SAFE_CHILD_ENV_NAME_SET, ...extras.map(normalizeEnvName)]);
  const out = {};
  // Walk the real environment so the child receives the parent's own casing.
  for (const [name, value] of Object.entries(base)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (!allowed.has(normalizeEnvName(name))) continue;
    if (isSecretEnvName(name)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(opts?.overrides || {})) {
    if (isSecretEnvName(name)) continue;
    if (typeof value === "string" && value.length > 0) out[name] = value;
  }
  return out;
}

/** True when a value is a non-empty string without control characters. */
function isCleanString(value) {
  return typeof value === "string" && value.length > 0 && !CONTROL_CHARS.test(value);
}

/**
 * Only http(s) targets are allowed. `file:`, `javascript:`, `data:` and UNC/absolute paths
 * are rejected so a job cannot drive the browser into local files or the runner's own disk.
 */
export function validateUrl(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "url is required" };
  const value = raw.trim();
  if (!value) return { ok: false, reason: "url is required" };
  if (value.length > MAX_URL_LEN) return { ok: false, reason: `url exceeds ${MAX_URL_LEN} characters` };
  if (CONTROL_CHARS.test(value)) return { ok: false, reason: "url contains control characters" };
  if (/\s/.test(value)) return { ok: false, reason: "url contains whitespace" };
  if (value.includes('"')) return { ok: false, reason: 'url contains a double quote' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "url is not a valid absolute URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported url scheme: ${parsed.protocol}` };
  }
  if (!parsed.hostname) return { ok: false, reason: "url has no host" };
  return { ok: true, url: parsed.toString() };
}

/** Free-text objective: bounded length, single line, no control characters. */
export function validateObjective(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "objective is required" };
  const value = raw.trim();
  if (!value) return { ok: false, reason: "objective is required" };
  if (value.length > MAX_OBJECTIVE_LEN) {
    return { ok: false, reason: `objective exceeds ${MAX_OBJECTIVE_LEN} characters` };
  }
  if (!isCleanString(value)) return { ok: false, reason: "objective contains control characters" };
  return { ok: true, objective: value };
}

/** Flow names are used to build CLI flags and process names: strict allowlist. */
export function validateFlow(raw) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, flow: "shell-nav" };
  if (typeof raw !== "string") return { ok: false, reason: "flow must be a string" };
  const value = raw.trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(value)) {
    return { ok: false, reason: "flow must match ^[A-Za-z0-9_-]{1,40}$" };
  }
  return { ok: true, flow: value };
}

export function normalizeTimeout(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.floor(n)));
}

export function normalizeHeadless(raw) {
  return raw !== false;
}

/**
 * Validate every user-controlled job field in one place.
 * Returns the normalized job fields to execute, or a reason the job cannot run.
 */
export function validateJobForExecution(job) {
  if (!job || typeof job !== "object") return { ok: false, reason: "job payload missing" };

  const flow = validateFlow(job.flow);
  if (!flow.ok) return flow;

  const url = validateUrl(job.url);
  if (!url.ok) return { ok: false, reason: `invalid url: ${url.reason}` };

  const objective = validateObjective(job.objective);
  if (!objective.ok) return objective;

  return {
    ok: true,
    flow: flow.flow,
    url: url.url,
    objective: objective.objective,
    timeout: normalizeTimeout(job.timeout),
    headless: normalizeHeadless(job.headless),
  };
}

/**
 * Shell-metacharacter check for the legacy `cmd.exe /c` fallback path only.
 * The hardened runner does not use a shell; this exists so the fallback can never be
 * reached with unvalidated input.
 */
const CMD_METACHARACTERS = /["&|<>^%\r\n`]/;

export function isShellSafeArg(value) {
  if (typeof value !== "string") return false;
  if (CONTROL_CHARS.test(value)) return false;
  return !CMD_METACHARACTERS.test(value);
}

/** Characters that are safe to interpolate into a double-quoted cmd.exe argument. */
export function hasUnsafeCmdChars(value) {
  return !isShellSafeArg(value);
}