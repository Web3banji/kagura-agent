import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import type { RunnerHeartbeat, VerificationJob, VerificationJobAttempt, VerificationJobStatus, VerificationOutcome } from "@/types/verification";
import { ensureDb, getPool, hasDatabase, isProductionRuntime, kvGet, kvSet } from "@/lib/db";
import { appendJournalEvent } from "@/lib/journal/store";

type AuditFn = typeof appendJournalEvent;

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

export function resolvePersistedJobOwner(row: Record<string, unknown>): string {
  const dbOwner = String(row.requested_by ?? "").trim();
  if (dbOwner) return dbOwner;
  const payload = (row.payload || {}) as Partial<VerificationJob>;
  return String(payload.requestedBy ?? "").trim();
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
    requestedBy: resolvePersistedJobOwner(row),
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
    claimGeneration: typeof row.claim_generation === "number" ? row.claim_generation : Number(row.claim_generation || payload.claimGeneration || 0),
  };
}

async function upsertDbJob(job: VerificationJob): Promise<void> {
  if (!job.requestedBy?.trim()) throw new Error("requestedBy is required: ownerless verification jobs cannot be persisted");
  await ensureDb();
  const p = getPool();
  await p.query(
    `INSERT INTO verification_jobs (id, project_id, requested_by, status, payload, created_at, updated_at, claimed_at, lease_expires_at, started_at, completed_at, claimed_by, runner_id, record_id, error, claim_generation)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15,$16)
     ON CONFLICT (id) DO UPDATE SET
       project_id=EXCLUDED.project_id, requested_by=EXCLUDED.requested_by, status=EXCLUDED.status, payload=EXCLUDED.payload,
       updated_at=NOW(), claimed_at=EXCLUDED.claimed_at, lease_expires_at=EXCLUDED.lease_expires_at, started_at=EXCLUDED.started_at,
       completed_at=EXCLUDED.completed_at, claimed_by=EXCLUDED.claimed_by, runner_id=EXCLUDED.runner_id, record_id=EXCLUDED.record_id, error=EXCLUDED.error,
       claim_generation=EXCLUDED.claim_generation`,
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
      job.claimGeneration ?? 0,
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
  const requestedBy = typeof job.requestedBy === "string" ? job.requestedBy.trim() : "";
  if (!requestedBy) {
    throw new Error("requestedBy is required: ownerless verification jobs cannot be queued");
  }
  const record: VerificationJob = {
    id: job.id || randomUUID(),
    status: job.status || "pending",
    flow: job.flow,
    objective: job.objective,
    url: job.url,
    projectId: job.projectId,
    requestedBy,
    repositoryConnectionId: job.repositoryConnectionId,
    repositoryOwner: job.repositoryOwner,
    repositoryName: job.repositoryName,
    repositoryFullName: job.repositoryFullName,
    repositoryDefaultBranch: job.repositoryDefaultBranch,
    chromeProfile: job.chromeProfile,
    headless: job.headless ?? true,
    timeout: job.timeout,
    reason: job.reason,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    attempt: job.attempt ?? 0,
    recordId: job.recordId,
    claimGeneration: job.claimGeneration ?? 0,
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

export type UpdateJobOpts = { expectedClaimedBy?: string; expectedStatus?: VerificationJobStatus | VerificationJobStatus[]; requireActiveLease?: boolean; expectedClaimGeneration?: number };

export async function updateJob(id: string, patch: Partial<VerificationJob>, opts?: UpdateJobOpts): Promise<VerificationJob | undefined> {
  const expectedClaimedBy = opts?.expectedClaimedBy?.trim();
  const expectedStatus = opts?.expectedStatus;
  const requireActiveLease = opts?.requireActiveLease === true;
  const expectedClaimGeneration = typeof opts?.expectedClaimGeneration === "number" ? opts.expectedClaimGeneration : undefined;
  const allowedStatuses = Array.isArray(expectedStatus) ? expectedStatus : expectedStatus ? [expectedStatus] : undefined;
  const canApply = (current: VerificationJob): boolean => {
    if (expectedClaimedBy && current.claimedBy !== expectedClaimedBy) return false;
    if (allowedStatuses && !allowedStatuses.includes(current.status)) return false;
    if (requireActiveLease && current.leaseExpiresAt && new Date(current.leaseExpiresAt).getTime() < Date.now()) return false;
    if (expectedClaimGeneration !== undefined && (current.claimGeneration ?? 0) !== expectedClaimGeneration) return false;
    return true;
  };

  if (hasDatabase()) {
    const current = await getDbJob(id);
    if (!current || !canApply(current)) return undefined;
    const next: VerificationJob = { ...current, ...patch, updatedAt: nowIso() };
    await ensureDb();
    const p = getPool();
    const fullParams: unknown[] = [next.projectId || "", next.requestedBy || "", next.status, JSON.stringify(next), next.updatedAt || nowIso(), next.claimedAt || null, next.leaseExpiresAt || null, next.startedAt || null, next.completedAt || null, next.claimedBy || null, next.runnerId || null, next.recordId || null, next.error || null, next.claimGeneration ?? 0, id];
    let statusClause = "";
    let claimedByClause = "";
    let leaseClause = "";
    let generationClause = "";
    if (allowedStatuses) { fullParams.push(allowedStatuses); statusClause = ` AND status = ANY($${fullParams.length}::text[])`; }
    if (expectedClaimedBy) { fullParams.push(expectedClaimedBy); claimedByClause = ` AND claimed_by = $${fullParams.length}`; }
    if (requireActiveLease) { leaseClause = ` AND (lease_expires_at IS NULL OR lease_expires_at >= NOW())`; }
    if (expectedClaimGeneration !== undefined) { fullParams.push(expectedClaimGeneration); generationClause = ` AND claim_generation = $${fullParams.length}`; }
    const sql = `UPDATE verification_jobs SET project_id=$1, requested_by=$2, status=$3, payload=$4::jsonb, updated_at=$5::timestamptz,
      claimed_at=$6::timestamptz, lease_expires_at=$7::timestamptz, started_at=$8::timestamptz, completed_at=$9::timestamptz,
      claimed_by=$10, runner_id=$11, record_id=$12, error=$13, claim_generation=$14 WHERE id=$15${statusClause}${claimedByClause}${leaseClause}${generationClause} RETURNING *`;
    const res = await p.query(sql, fullParams);
    if (!res.rows[0]) return undefined;
    return rowToJob(res.rows[0] as Record<string, unknown>);
  }
  const jobs = await readJobsFile();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx < 0 || !canApply(jobs[idx])) return undefined;
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
             claim_generation = COALESCE(claim_generation, 0) + 1,
             payload = jsonb_set(jsonb_set(jsonb_set(jsonb_set(COALESCE(payload,'{}'::jsonb), '{claimedBy}', to_jsonb($1::text)), '{runnerId}', to_jsonb($1::text)), '{leaseExpiresAt}', to_jsonb($2::text)), '{claimGeneration}', to_jsonb(COALESCE(claim_generation, 0) + 1))
         WHERE id = (
           SELECT id FROM verification_jobs
           WHERE (status = 'pending' OR (status IN ('claimed','running') AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()))
             AND COALESCE(NULLIF(btrim(requested_by), ''), NULLIF(btrim(payload->>'requestedBy'), '')) IS NOT NULL
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`,
        [runnerId, leaseUntil],
      );
      if (!res.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const claimed = rowToJob(res.rows[0] as Record<string, unknown>);
      if (!claimed.requestedBy?.trim()) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return claimed;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }
  const jobs = await readJobsFile();
  const idx = jobs.findIndex(
    (j) => (j.status === "pending" || ((j.status === "claimed" || j.status === "running") && j.leaseExpiresAt && new Date(j.leaseExpiresAt).getTime() < Date.now()))
      && typeof j.requestedBy === "string" && j.requestedBy.trim().length > 0,
  );
  if (idx < 0) return null;
  if (!jobs[idx].requestedBy?.trim()) return null;
  const prevGen = typeof jobs[idx].claimGeneration === "number" ? jobs[idx].claimGeneration : 0;
  jobs[idx] = { ...jobs[idx], status: "claimed", claimedAt: nowIso(), claimedBy: runnerId, runnerId, leaseExpiresAt: leaseUntil, updatedAt: nowIso(), attempt: (jobs[idx].attempt || 0) + 1, claimGeneration: prevGen + 1 };
  await writeJobsFile(jobs);
  return jobs[idx];
}

export type JobOperationActor = { type: "user" | "admin-token"; id: string };
export type JobOperationKind = "cancel" | "retry" | "recover" | "finalize";
export type JobOperationState = "requested" | "applied";

export interface JobOperationRecord {
  id: string;
  jobId: string;
  kind: JobOperationKind;
  generation: number;
  state: JobOperationState;
  actor: JobOperationActor;
  reason: string;
  before: VerificationJobStatus;
  after: VerificationJobStatus;
  requestedAt: string;
  appliedAt?: string;
}

export type JobOperationResult = {
  job: VerificationJob;
  auditStatus: "applied" | "pending";
  operationId: string;
  idempotent: boolean;
  auditError?: string;
};

export type JobOperationInput = {
  kind: JobOperationKind;
  jobId: string;
  operationId?: string;
  actor: JobOperationActor;
  reason: string;
  expectedClaimedBy?: string;
  expectedClaimGeneration?: number;
  audit?: AuditFn;
};

const JOB_OPERATION_PREFIX = "job-operation:";
const JOB_OPERATIONS_FILE = path.join(DATA_DIR, "job-operations.json");
const JOB_OPERATION_LOCK_DIR = path.join(DATA_DIR, "job-operation-locks");

function jobOperationKey(id: string) { return `${JOB_OPERATION_PREFIX}${id}`; }
function stableOperationId(kind: JobOperationKind, jobId: string, generation: number) { return `${kind}:${jobId}:${generation}`; }

function attemptSnapshot(job: VerificationJob): VerificationJobAttempt {
  return {
    attempt: job.attempt ?? 0,
    status: job.status,
    claimedBy: job.claimedBy,
    runnerId: job.runnerId,
    claimGeneration: job.claimGeneration,
    startedAt: job.startedAt,
    finishedAt: job.completedAt,
    outcome: job.result?.outcome,
    summary: job.result?.summary,
    error: job.error,
    recordedAt: nowIso(),
  };
}

function operationAfter(kind: JobOperationKind, job: VerificationJob): VerificationJobStatus {
  if (kind === "cancel") return job.status === "running" ? "cancelling" : "cancelled";
  if (kind === "finalize") return "cancelled";
  return "pending";
}

function operationPatch(kind: JobOperationKind, job: VerificationJob, after: VerificationJobStatus, reason: string, actor: JobOperationActor): Partial<VerificationJob> {
  const attempts = [...(job.attempts || []), attemptSnapshot(job)];
  if (kind === "cancel" || kind === "finalize") {
    return {
      status: after,
      completedAt: after === "cancelled" ? nowIso() : undefined,
      cancellationRequestedAt: after === "cancelling" ? nowIso() : job.cancellationRequestedAt,
      error: `Cancellation ${after === "cancelling" ? "requested" : "completed"} by ${actor.type}:${actor.id}: ${reason}`,
      leaseExpiresAt: after === "cancelled" ? undefined : job.leaseExpiresAt,
      attempts,
    };
  }
  if (kind === "retry") {
    return {
      status: "pending",
      claimedAt: undefined,
      claimedBy: undefined,
      runnerId: undefined,
      leaseExpiresAt: undefined,
      startedAt: undefined,
      completedAt: undefined,
      recordId: undefined,
      result: undefined,
      error: undefined,
      cancellationRequestedAt: undefined,
      attempt: (job.attempt ?? 0) + 1,
      claimGeneration: (job.claimGeneration ?? 0) + 1,
      attempts,
    };
  }
  return {
    status: "pending",
    claimedAt: undefined,
    claimedBy: undefined,
    runnerId: undefined,
    leaseExpiresAt: undefined,
    startedAt: undefined,
    completedAt: undefined,
    recordId: undefined,
    result: undefined,
    error: undefined,
    cancellationRequestedAt: undefined,
    attempt: job.attempt ?? 0,
    claimGeneration: (job.claimGeneration ?? 0) + 1,
    attempts,
  };
}

function validateOperation(job: VerificationJob, kind: JobOperationKind, opts: { expectedClaimedBy?: string; expectedClaimGeneration?: number }): void {
  if (opts.expectedClaimedBy && job.claimedBy !== opts.expectedClaimedBy) throw new Error("ClaimedBy does not match");
  if (opts.expectedClaimGeneration !== undefined && (job.claimGeneration ?? 0) !== opts.expectedClaimGeneration) throw new Error("Claim generation does not match");
  if (kind === "cancel") {
    if (!["pending", "claimed", "running", "cancelling", "cancelled"].includes(job.status)) throw new Error(`Job ${job.status} cannot be cancelled`);
    return;
  }
  if (kind === "finalize") {
    if (!["cancelling", "cancelled"].includes(job.status)) throw new Error(`Job ${job.status} cannot be finalized as cancelled`);
    return;
  }
  if (kind === "retry") {
    if (!job.requestedBy?.trim()) throw new Error("Ownerless jobs cannot be retried");
    if (!["failed", "did_not_start", "pending"].includes(job.status)) throw new Error(`Job ${job.status} is not retryable`);
    return;
  }
  if (!["claimed", "running", "pending"].includes(job.status)) throw new Error(`Job ${job.status} cannot be recovered`);
}

function auditEvent(record: JobOperationRecord, phase: "requested" | "applied") {
  return {
    id: `${record.id}:${phase}`,
    type: "decision" as const,
    source: "job-operations",
    title: `Verification job ${record.kind}: ${record.jobId}`,
    summary: `phase=${phase} operationId=${record.id} actor=${record.actor.type}:${record.actor.id} operation=${record.kind} jobId=${record.jobId} before=${record.before} after=${record.after} generation=${record.generation} reason=${record.reason}`,
    timestamp: nowIso(),
    refs: [record.jobId],
  };
}

async function readOperationsFile(): Promise<JobOperationRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(JOB_OPERATIONS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
async function writeOperationsFile(rows: JobOperationRecord[]) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(JOB_OPERATIONS_FILE, JSON.stringify(rows.slice(0, 500), null, 2), "utf8");
}

async function withJobOperationLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(JOB_OPERATION_LOCK_DIR, { recursive: true });
  const lock = path.join(JOB_OPERATION_LOCK_DIR, `${encodeURIComponent(id)}.lock`);
  for (let i = 0; i < 100; i++) {
    try { await fs.mkdir(lock); break; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  try { return await fn(); } finally { await fs.rm(lock, { recursive: true, force: true }).catch(() => {}); }
}

async function readOperationDb(client: PoolClient, id: string): Promise<JobOperationRecord | undefined> {
  const key = jobOperationKey(id);
  await client.query("INSERT INTO echolog_kv (key, value, updated_at) VALUES ($1, 'null'::jsonb, NOW()) ON CONFLICT (key) DO NOTHING", [key]);
  const res = await client.query("SELECT value FROM echolog_kv WHERE key = $1 FOR UPDATE", [key]);
  return res.rows[0]?.value ? (res.rows[0].value as JobOperationRecord) : undefined;
}
async function writeOperationDb(client: PoolClient, record: JobOperationRecord) {
  await client.query(
    `INSERT INTO echolog_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [jobOperationKey(record.id), JSON.stringify(record)],
  );
}
async function appendJournalEventDb(client: PoolClient, event: ReturnType<typeof auditEvent>) {
  const key = "journal:events";
  await client.query("INSERT INTO echolog_kv (key, value, updated_at) VALUES ($1, '[]'::jsonb, NOW()) ON CONFLICT (key) DO NOTHING", [key]);
  const res = await client.query("SELECT value FROM echolog_kv WHERE key = $1 FOR UPDATE", [key]);
  const events = Array.isArray(res.rows[0]?.value) ? res.rows[0].value : [];
  events.unshift(event);
  await client.query("UPDATE echolog_kv SET value = $2::jsonb, updated_at = NOW() WHERE key = $1", [key, JSON.stringify(events.slice(0, 1000))]);
}
async function updateJobDb(client: PoolClient, id: string, patch: Partial<VerificationJob>, expected: { status: VerificationJobStatus[]; claimedBy?: string; generation?: number }): Promise<VerificationJob | undefined> {
  const currentRes = await client.query("SELECT * FROM verification_jobs WHERE id = $1 FOR UPDATE", [id]);
  const row = currentRes.rows[0] as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const current = rowToJob(row);
  if (!expected.status.includes(current.status)) return undefined;
  if (expected.claimedBy && current.claimedBy !== expected.claimedBy) return undefined;
  if (expected.generation !== undefined && (current.claimGeneration ?? 0) !== expected.generation) return undefined;
  const next = { ...current, ...patch, updatedAt: nowIso() };
  const params: unknown[] = [next.projectId || "", next.requestedBy || "", next.status, JSON.stringify(next), next.updatedAt || nowIso(), next.claimedAt || null, next.leaseExpiresAt || null, next.startedAt || null, next.completedAt || null, next.claimedBy || null, next.runnerId || null, next.recordId || null, next.error || null, next.claimGeneration ?? 0, id];
  const res = await client.query(
    `UPDATE verification_jobs SET project_id=$1, requested_by=$2, status=$3, payload=$4::jsonb, updated_at=$5::timestamptz,
      claimed_at=$6::timestamptz, lease_expires_at=$7::timestamptz, started_at=$8::timestamptz, completed_at=$9::timestamptz,
      claimed_by=$10, runner_id=$11, record_id=$12, error=$13, claim_generation=$14 WHERE id=$15 RETURNING *`,
    params,
  );
  return res.rows[0] ? rowToJob(res.rows[0] as Record<string, unknown>) : undefined;
}

async function applyJobOperationDb(input: JobOperationInput, operationId: string): Promise<JobOperationResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const jobRes = await client.query("SELECT * FROM verification_jobs WHERE id = $1 FOR UPDATE", [input.jobId]);
    const row = jobRes.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("Job not found");
    const job = rowToJob(row);
    let record = await readOperationDb(client, operationId);
    if (record?.state === "applied") {
      await client.query("COMMIT");
      return { job, auditStatus: "applied", operationId, idempotent: true };
    }
    validateOperation(job, input.kind, input);
    const after = operationAfter(input.kind, job);
    const before = job.status;
    if (!record) {
      record = {
        id: operationId,
        jobId: job.id,
        kind: input.kind,
        generation: job.claimGeneration ?? 0,
        state: "requested",
        actor: input.actor,
        reason: input.reason,
        before,
        after,
        requestedAt: nowIso(),
      };
      await writeOperationDb(client, record);
      await appendJournalEventDb(client, auditEvent(record, "requested"));
    }
    let updated = job;
    if (job.status !== after) {
      const changed = await updateJobDb(client, job.id, operationPatch(input.kind, job, after, input.reason, input.actor), {
        status: [job.status],
        claimedBy: input.expectedClaimedBy,
        generation: input.expectedClaimGeneration,
      });
      if (!changed) throw new Error("Job changed during operation");
      updated = changed;
    }
    const applied: JobOperationRecord = { ...record, state: "applied", appliedAt: nowIso(), after };
    await appendJournalEventDb(client, auditEvent(applied, "applied"));
    await writeOperationDb(client, applied);
    await client.query("COMMIT");
    return { job: updated, auditStatus: "applied", operationId, idempotent: record.state === "applied" };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function applyJobOperationFile(input: JobOperationInput, operationId: string): Promise<JobOperationResult> {
  return withJobOperationLock(operationId, async () => {
    const operations = await readOperationsFile();
    let record = operations.find((r) => r.id === operationId);
    if (record?.state === "applied") {
      const job = await getJob(input.jobId);
      if (!job) throw new Error("Job not found");
      return { job, auditStatus: "applied", operationId, idempotent: true };
    }
    const job = await getJob(input.jobId);
    if (!job) throw new Error("Job not found");
    validateOperation(job, input.kind, input);
    const after = operationAfter(input.kind, job);
    const isNew = !record;
    if (!record) {
      record = {
        id: operationId,
        jobId: job.id,
        kind: input.kind,
        generation: job.claimGeneration ?? 0,
        state: "requested",
        actor: input.actor,
        reason: input.reason,
        before: job.status,
        after,
        requestedAt: nowIso(),
      };
      operations.unshift(record);
      await writeOperationsFile(operations);
    }
    let updated = job;
    if (isNew) await (input.audit || appendJournalEvent)(auditEvent(record, "requested"));
    if (job.status !== after) {
      const changed = await updateJob(job.id, operationPatch(input.kind, job, after, input.reason, input.actor), {
        expectedStatus: [job.status],
        expectedClaimedBy: input.expectedClaimedBy,
        expectedClaimGeneration: input.expectedClaimGeneration,
        requireActiveLease: false,
      });
      if (!changed) throw new Error("Job changed during operation");
      updated = changed;
    }
    try {
      const applied: JobOperationRecord = { ...record, state: "applied", appliedAt: nowIso(), after };
      await (input.audit || appendJournalEvent)(auditEvent(applied, "applied"));
      const idx = operations.findIndex((r) => r.id === operationId);
      operations[idx] = applied;
      await writeOperationsFile(operations);
      return { job: updated, auditStatus: "applied", operationId, idempotent: false };
    } catch (err) {
      return { job: updated, auditStatus: "pending", operationId, idempotent: false, auditError: err instanceof Error ? err.message : String(err) };
    }
  });
}

export async function applyJobOperation(input: JobOperationInput): Promise<JobOperationResult> {
  const job = await getJob(input.jobId);
  if (!job) throw new Error("Job not found");
  const operationId = input.operationId?.trim() || stableOperationId(input.kind, input.jobId, input.expectedClaimGeneration ?? job.claimGeneration ?? 0);
  if (hasDatabase()) return applyJobOperationDb(input, operationId);
  return applyJobOperationFile(input, operationId);
}

export async function reconcileJobOperations(opts: { actor: JobOperationActor; reason?: string; audit?: AuditFn } = { actor: { type: "admin-token", id: "reconciler" } }): Promise<{ reconciled: number; auditStatus: "applied" | "pending" }> {
  let rows: JobOperationRecord[] = [];
  if (hasDatabase()) {
    await ensureDb();
    const res = await getPool().query("SELECT value FROM echolog_kv WHERE key LIKE 'job-operation:%'");
    rows = res.rows.map((r) => r.value as JobOperationRecord).filter((r) => r && r.state === "requested");
  } else {
    rows = (await readOperationsFile()).filter((r) => r.state === "requested");
  }
  let reconciled = 0;
  let pending = false;
  for (const row of rows) {
    try {
      const result = await applyJobOperation({ kind: row.kind, jobId: row.jobId, operationId: row.id, actor: opts.actor, reason: opts.reason || row.reason, audit: opts.audit });
      if (result.auditStatus === "pending") pending = true;
      else reconciled++;
    } catch {
      pending = true;
    }
  }
  return { reconciled, auditStatus: pending ? "pending" : "applied" };
}

export async function cancelVerificationJob(
  id: string,
  opts: { actor: JobOperationActor; reason: string; expectedClaimedBy?: string; expectedClaimGeneration?: number; operationId?: string; audit?: AuditFn },
): Promise<JobOperationResult> {
  return applyJobOperation({ kind: "cancel", jobId: id, ...opts });
}

export async function retryVerificationJob(
  id: string,
  opts: { actor: JobOperationActor; reason: string; expectedClaimGeneration?: number; operationId?: string; audit?: AuditFn },
): Promise<JobOperationResult> {
  return applyJobOperation({ kind: "retry", jobId: id, ...opts });
}

export async function finalizeCancelledJob(
  id: string,
  opts: { actor: JobOperationActor; reason: string; expectedClaimGeneration?: number; operationId?: string; audit?: AuditFn },
): Promise<JobOperationResult> {
  return applyJobOperation({ kind: "finalize", jobId: id, ...opts });
}

export async function recoverExpiredVerificationJobs(opts: {
  actor: JobOperationActor;
  reason?: string;
  now?: number;
  audit?: AuditFn;
}): Promise<{ recovered: number; auditStatus: "applied" | "pending" }> {
  const jobs = await readJobs();
  const now = opts.now ?? Date.now();
  let recovered = 0;
  let auditPending = false;
  for (const job of jobs) {
    if ((job.status !== "claimed" && job.status !== "running") || !job.leaseExpiresAt) continue;
    if (new Date(job.leaseExpiresAt).getTime() >= now) continue;
    try {
      const result = await applyJobOperation({
        kind: "recover",
        jobId: job.id,
        actor: opts.actor,
        reason: opts.reason || "expired lease",
        expectedClaimedBy: job.claimedBy,
        expectedClaimGeneration: job.claimGeneration ?? 0,
        audit: opts.audit,
      });
      if (result.auditStatus === "pending") auditPending = true;
      else recovered++;
    } catch {
      auditPending = true;
    }
  }
  return { recovered, auditStatus: auditPending ? "pending" : "applied" };
}

export async function setJobRunning(id: string, runnerId: string): Promise<VerificationJob | undefined> {
  const job = await getJob(id);
  if (!job) return undefined;
  if (job.claimedBy && job.claimedBy !== runnerId && job.runnerId && job.runnerId !== runnerId) return undefined;
  return updateJob(id, { status: "running", startedAt: job.startedAt || nowIso(), runnerId }, { expectedClaimedBy: runnerId, expectedStatus: ["claimed","running"], expectedClaimGeneration: job.claimGeneration ?? 0, requireActiveLease: true });
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
  if (hb.readiness) next.readiness = hb.readiness;
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
    return { status: "disconnected", note: "No runner heartbeat recorded.", readiness: { state: "unknown", ready: false, reason: "No runner heartbeat recorded." } };
  }
  const age = Date.now() - new Date(hb.lastHeartbeat).getTime();
  const connected = age <= HEARTBEAT_TTL_MS;
  return {
    ...hb,
    status: connected ? "connected" : "disconnected",
    note: connected ? hb.note : "Runner heartbeat is stale.",
    readiness: connected ? hb.readiness : { state: "unknown", ready: false, reason: "Runner heartbeat is stale; readiness is unknown." },
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


/** @internal Test/migration-only raw overwrite. */
export async function __unsafeWriteJobsForTests(jobs: VerificationJob[]): Promise<void> {
  if (hasDatabase()) {
    await ensureDb();
    const p = getPool();
    await p.query("DELETE FROM verification_jobs");
    for (const job of jobs.slice(0, 200)) await upsertDbJob(job);
    return;
  }
  await writeJobsFile(jobs);
}
