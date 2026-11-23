import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { RunnerHeartbeat, VerificationJob, VerificationJobStatus, VerificationOutcome } from "@/types/verification";
import { ensureDb, getPool, hasDatabase, isProductionRuntime, kvGet, kvSet } from "@/lib/db";

const DATA_DIR = path.join(process.cwd(), "data", "verification");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const HEARTBEAT_KEY = "runner:heartbeat";
const HEARTBEAT_TTL_MS = 90_000;
const LEASE_MS = 10 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function canUseLocalFs(): boolean {
  return !hasDatabase() && !isProductionRuntime();
}

async function ensureFile() {
  if (!canUseLocalFs()) {
    throw new Error("Durable verification job storage is not configured (DATABASE_URL missing in production).");
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(JOBS_FILE);
  } catch {
    await fs.writeFile(JOBS_FILE, "[]", "utf8");
  }
}

async function readJobsFile(): Promise<VerificationJob[]> {
  if (!canUseLocalFs()) return [];
  await ensureFile();
  try {
    const raw = await fs.readFile(JOBS_FILE, "utf8");
    const parsed = JSON.parse(raw) as VerificationJob[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeJobsFile(jobs: VerificationJob[]): Promise<void> {
  if (!canUseLocalFs()) {
    throw new Error("Durable verification job storage is not configured (DATABASE_URL missing in production).");
  }
  await ensureFile();
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs.slice(0, 200), null, 2), "utf8");
}

function rowToJob(row: Record<string, unknown>): VerificationJob {
  const payload = (row.payload || {}) as Partial<VerificationJob>;
  return {
    id: String(row.id),
    status: String(row.status) as VerificationJobStatus,
    flow: String(payload.flow || ""),
    objective: String(payload.objective || ""),
    url: String(payload.url || ""),
    projectId: String(row.project_id || payload.projectId || ""),
    requestedBy: String(row.requested_by || payload.requestedBy || ""),
    chromeProfile: payload.chromeProfile,
    headless: payload.headless,
    timeout: payload.timeout,
    reason: payload.reason,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : String(payload.createdAt || nowIso()),
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : payload.updatedAt,
    claimedAt: row.claimed_at ? new Date(String(row.claimed_at)).toISOString() : payload.claimedAt,
    leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)).toISOString() : payload.leaseExpiresAt,
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : payload.startedAt,
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : payload.completedAt,
    claimedBy: row.claimed_by ? String(row.claimed_by) : payload.claimedBy,
    runnerId: row.runner_id ? String(row.runner_id) : payload.runnerId,
    attempt: typeof payload.attempt === "number" ? payload.attempt : 0,
    recordId: row.record_id ? String(row.record_id) : payload.recordId,
    error: row.error ? String(row.error) : payload.error,
    result: (payload.result as VerificationJob["result"]) || undefined,
  };
}

async function upsertDbJob(job: VerificationJob): Promise<void> {
  await ensureDb();
  const p = getPool();
  await p.query(
    `INSERT INTO verification_jobs (id, project_id, requested_by, status, payload, created_at, updated_at, claimed_at, lease_expires_at, started_at, completed_at, claimed_by, runner_id, record_id, error)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15)
     ON CONFLICT (id) DO UPDATE SET
       project_id=EXCLUDED.project_id, requested_by=EXCLUDED.requested_by, status=EXCLUDED.status, payload=EXCLUDED.payload,
       updated_at=NOW(), claimed_at=EXCLUDED.claimed_at, lease_expires_at=EXCLUDED.lease_expires_at, started_at=EXCLUDED.started_at,
       completed_at=EXCLUDED.completed_at, claimed_by=EXCLUDED.claimed_by, runner_id=EXCLUDED.runner_id, record_id=EXCLUDED.record_id, error=EXCLUDED.error`,
    [
      job.id,
      job.projectId || "",
      job.requestedBy || "",
      job.status,
      JSON.stringify(job),
      job.createdAt || nowIso(),
      job.updatedAt || nowIso(),
      job.claimedAt || null,
      job.leaseExpiresAt || null,
      job.startedAt || null,
      job.completedAt || null,
      job.claimedBy || null,
      job.runnerId || null,
      job.recordId || null,
      job.error || null,
    ],
  );
}

async function getDbJob(id: string): Promise<VerificationJob | undefined> {
  await ensureDb();
  const res = await getPool().query("SELECT * FROM verification_jobs WHERE id = $1", [id]);
  if (!res.rows[0]) return undefined;
  return rowToJob(res.rows[0] as Record<string, unknown>);
}

export async function enqueueJob(job: Omit<VerificationJob, "id" | "status" | "createdAt"> & { id?: string; status?: VerificationJobStatus }): Promise<VerificationJob> {
  const record: VerificationJob = {
    id: job.id || randomUUID(),
    status: job.status || "pending",
    flow: job.flow,
    objective: job.objective,
    url: job.url,
    projectId: job.projectId,
    requestedBy: job.requestedBy,
    chromeProfile: job.chromeProfile,
    headless: job.headless ?? true,
    timeout: job.timeout,
    reason: job.reason,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    attempt: job.attempt ?? 0,
    recordId: job.recordId,
  };
  if (hasDatabase()) {
    await upsertDbJob(record);
    return record;
  }
  const jobs = await readJobsFile();
  jobs.unshift(record);
  await writeJobsFile(jobs);
  return record;
}

export async function readJobs(opts?: { projectId?: string; requestedBy?: string; includeLegacy?: boolean }): Promise<VerificationJob[]> {
  let jobs: VerificationJob[];
  if (hasDatabase()) {
    await ensureDb();
    const res = await getPool().query("SELECT * FROM verification_jobs ORDER BY created_at DESC LIMIT 200");
    jobs = res.rows.map((r) => rowToJob(r as Record<string, unknown>));
  } else {
    jobs = await readJobsFile();
  }
  return jobs.filter((j) => matchesJobScope(j, opts));
}

/**
 * Fails closed. When `requestedBy` is supplied, jobs owned by a different principal
 * are excluded, and jobs with no recorded owner (legacy/platform jobs) are excluded
 * unless `includeLegacy` is explicitly true. The same rule applies to `projectId`.
 */
function matchesJobScope(
  job: VerificationJob,
  opts?: { projectId?: string; requestedBy?: string; includeLegacy?: boolean },
): boolean {
  if (opts?.projectId) {
    if (job.projectId && job.projectId !== opts.projectId) return false;
    if (!job.projectId && !opts.includeLegacy) return false;
  }
  if (opts?.requestedBy) {
    if (job.requestedBy && job.requestedBy !== opts.requestedBy) return false;
    if (!job.requestedBy && !opts.includeLegacy) return false;
  }
  return true;
}

export async function getJob(id: string, opts?: { projectId?: string; requestedBy?: string; includeLegacy?: boolean }): Promise<VerificationJob | undefined> {
  let job: VerificationJob | undefined;
  if (hasDatabase()) job = await getDbJob(id);
  else job = (await readJobsFile()).find((j) => j.id === id);
  if (!job) return undefined;
  return matchesJobScope(job, opts) ? job : undefined;
}

export async function updateJob(id: string, patch: Partial<VerificationJob>): Promise<VerificationJob | undefined> {
  if (hasDatabase()) {
    const current = await getDbJob(id);
    if (!current) return undefined;
    const next: VerificationJob = { ...current, ...patch, updatedAt: nowIso() };
    await upsertDbJob(next);
    return next;
  }
  const jobs = await readJobsFile();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx < 0) return undefined;
  jobs[idx] = { ...jobs[idx], ...patch, updatedAt: nowIso() };
  await writeJobsFile(jobs);
  return jobs[idx];
}

export async function claimNextJob(opts?: { runnerId?: string; leaseMs?: number }): Promise<VerificationJob | null> {
  const leaseMs = opts?.leaseMs ?? LEASE_MS;
  const runnerId = opts?.runnerId || "runner";
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  if (hasDatabase()) {
    await ensureDb();
    const p = getPool();
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `UPDATE verification_jobs
         SET status='claimed', claimed_at=NOW(), updated_at=NOW(), claimed_by=$1, runner_id=$1, lease_expires_at=$2::timestamptz,
             payload = jsonb_set(jsonb_set(jsonb_set(COALESCE(payload,'{}'::jsonb), '{claimedBy}', to_jsonb($1::text)), '{runnerId}', to_jsonb($1::text)), '{leaseExpiresAt}', to_jsonb($2::text))
         WHERE id = (
           SELECT id FROM verification_jobs
           WHERE status = 'pending' OR (status IN ('claimed','running') AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW())
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`,
        [runnerId, leaseUntil],
      );
      await client.query("COMMIT");
      if (!res.rows[0]) return null;
      return rowToJob(res.rows[0] as Record<string, unknown>);
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }
  const jobs = await readJobsFile();
  const idx = jobs.findIndex(
    (j) => j.status === "pending" || ((j.status === "claimed" || j.status === "running") && j.leaseExpiresAt && new Date(j.leaseExpiresAt).getTime() < Date.now()),
  );
  if (idx < 0) return null;
  jobs[idx] = { ...jobs[idx], status: "claimed", claimedAt: nowIso(), claimedBy: runnerId, runnerId, leaseExpiresAt: leaseUntil, updatedAt: nowIso(), attempt: (jobs[idx].attempt || 0) + 1 };
  await writeJobsFile(jobs);
  return jobs[idx];
}

export async function setJobRunning(id: string, runnerId: string): Promise<VerificationJob | undefined> {
  const job = await getJob(id);
  if (!job) return undefined;
  if (job.claimedBy && job.claimedBy !== runnerId && job.runnerId && job.runnerId !== runnerId) return undefined;
  return updateJob(id, { status: "running", startedAt: job.startedAt || nowIso(), runnerId });
}

export async function countPendingJobs(projectId?: string): Promise<number> {
  const jobs = await readJobs(projectId ? { projectId } : undefined);
  return jobs.filter((j) => j.status === "pending" || j.status === "claimed" || j.status === "running").length;
}

export async function recordHeartbeat(hb: Partial<RunnerHeartbeat> & { runnerId?: string }): Promise<RunnerHeartbeat> {
  const prev = (await kvGet<RunnerHeartbeat>(HEARTBEAT_KEY)) || { status: "disconnected" as const };
  const next: RunnerHeartbeat = {
    ...prev,
    ...hb,
    status: "connected",
    lastHeartbeat: nowIso(),
  };
  await kvSet(HEARTBEAT_KEY, next);
  return next;
}

export async function markRunnerSuccess(executionAt = nowIso()): Promise<void> {
  const prev = (await kvGet<RunnerHeartbeat>(HEARTBEAT_KEY)) || { status: "disconnected" as const };
  await kvSet(HEARTBEAT_KEY, { ...prev, status: prev.lastHeartbeat ? "connected" : prev.status, lastSuccessfulExecution: executionAt });
}

export async function getRunnerHeartbeat(): Promise<RunnerHeartbeat> {
  const hb = await kvGet<RunnerHeartbeat>(HEARTBEAT_KEY);
  if (!hb || !hb.lastHeartbeat) {
    return { status: "disconnected", note: "No runner heartbeat recorded." };
  }
  const age = Date.now() - new Date(hb.lastHeartbeat).getTime();
  const connected = age <= HEARTBEAT_TTL_MS;
  return {
    ...hb,
    status: connected ? "connected" : "disconnected",
    note: connected ? hb.note : "Runner heartbeat is stale.",
  };
}

export function outcomeFromJobStatus(status: VerificationJobStatus): VerificationOutcome {
  // A job's status alone never implies a successful Kane verification.
  // "completed" only means the runner finished the job; the actual Kane
  // execution result (runEnd.status / exit code) must be consulted to
  // determine passed vs failed.
  if (status === "did_not_start") return "did_not_start";
  if (status === "failed") return "failed";
  if (status === "running" || status === "claimed") return "running";
  return "pending";
}
