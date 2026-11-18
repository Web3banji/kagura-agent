/**
 * Per-job workspace/profile path derivation for the KAGURA local Kane runner.
 *
 * Shared runner infrastructure must never share user data: every job gets its own
 * isolated working directory and its own Kane/Chrome profile directory, derived from
 * the job's authenticated owner (requestedBy), project (projectId) and unique job id.
 *
 * Pure functions only (no fs, no env) so they are unit-testable in isolation.
 */
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_SEGMENT = 48;

/**
 * Reduce an arbitrary value to a single safe path segment.
 * Strips anything that could escape the parent directory (separators, "..", drive colons).
 */
export function safeSegment(value, fallback = "unknown") {
  const raw = value === undefined || value === null ? "" : String(value);
  const cleaned = raw
    .replace(/[\\/]+/g, "-") // path separators
    .replace(/[^a-zA-Z0-9._-]+/g, "-") // anything exotic
    .replace(/\.{2,}/g, ".") // collapse ".."
    .replace(/^[.-]+/, "") // no leading dots/dashes (hidden or flag-like)
    .replace(/[.-]+$/, "");
  const trimmed = cleaned.slice(0, MAX_SEGMENT);
  return trimmed || fallback;
}

/** Short stable hash used to guarantee uniqueness even after sanitisation/truncation. */
export function shortHash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12);
}

/**
 * Stable identity for a job: project + owner + job id.
 * Includes a hash so two different inputs can never collapse onto the same directory.
 */
export function jobKey(job) {
  const projectId = safeSegment(job?.projectId, "default");
  const requestedBy = safeSegment(job?.requestedBy, "anonymous");
  const jobId = safeSegment(job?.id, "job");
  const identity = `${projectId}--${requestedBy}--${jobId}`;
  return `${identity}--${shortHash(`${job?.projectId ?? ""}|${job?.requestedBy ?? ""}|${job?.id ?? ""}`)}`;
}

/** Per-job isolated working directory (used as the child process cwd). */
export function workspaceDir(rootDir, job) {
  return path.join(rootDir, "data", "verification", "workspaces", jobKey(job));
}

/** Per-job isolated Kane/Chrome profile directory (never shared between jobs). */
export function profileDir(rootDir, job) {
  return path.join(rootDir, "data", "verification", "profiles", jobKey(job));
}

/** Shared output directory for NDJSON run logs (filenames are per-run UUIDs). */
export function outputsDir(rootDir) {
  return path.join(rootDir, "data", "verification", "runs");
}

/** Verify a derived path really lives under the expected parent. */
export function isInside(parentDir, candidate) {
  const rel = path.relative(parentDir, candidate);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}