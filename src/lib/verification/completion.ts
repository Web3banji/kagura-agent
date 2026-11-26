import { ensureDb, getPool, hasDatabase, isProductionRuntime } from "@/lib/db";
import { promises as fs } from "fs";
import path from "path";
import { AccessDeniedError } from "@/lib/auth/scope";
import type { VerificationJob, VerificationJobResult, VerificationJobStatus, VerificationOutcome, VerificationRecord } from "@/types/verification";
import { readVerificationRecords } from "./store";
import { getJob, resolvePersistedJobOwner, updateJob } from "./jobs";

const DATA_DIR = path.join(process.cwd(), "data", "verification");
const RECORDS_FILE = path.join(DATA_DIR, "records.json");
const RES_FILE = path.join(DATA_DIR, "completion-reservations.json");

function nowIso() { return new Date().toISOString(); }
function canUseLocalFs() { return !hasDatabase() && !isProductionRuntime(); }
function recordsKey(projectId?: string) { return `verification:records:${projectId || "default"}`; }
async function ensureDir() { await fs.mkdir(DATA_DIR, { recursive: true }); }

type Reservation = { jobId: string; runnerId: string; claimGeneration: number; recordId: string; outcome: VerificationOutcome; payloadHash: string; result: VerificationJobResult; createdAt: string; status: "reserved" | "record_persisted" | "finalized" };
async function readReservations(): Promise<Reservation[]> {
  if (!canUseLocalFs()) return [];
  await ensureDir();
  try { const raw = await fs.readFile(RES_FILE, "utf8"); const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
}
async function writeReservations(rows: Reservation[]) { await ensureDir(); await fs.writeFile(RES_FILE, JSON.stringify(rows.slice(0, 500), null, 2), "utf8"); }
function stable(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const obj = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) out[k] = norm(obj[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}
function payloadHash(record: VerificationRecord, outcome: VerificationOutcome, result: VerificationJobResult): string {
  return stable({ id: record.id, jobId: record.jobId, projectId: record.projectId ?? null, requestedBy: record.requestedBy ?? null, outcome, result, summary: record.summary ?? null, failingStep: record.failingStep ?? null, exitCode: record.exitCode ?? null });
}

function replayEquivalent(existing: VerificationRecord, incoming: VerificationRecord): boolean {
  const a = { ...existing, investigationIds: existing.investigationIds ?? [], investigationProcessing: existing.investigationProcessing ?? undefined };
  const b = { ...incoming, investigationIds: incoming.investigationIds ?? a.investigationIds, investigationProcessing: incoming.investigationProcessing ?? a.investigationProcessing, requestedBy: a.requestedBy, projectId: a.projectId, jobId: a.jobId, id: a.id };
  return stable(a) === stable(b);
}

function mergeRecord(existing: VerificationRecord | undefined, incoming: VerificationRecord, opts: { expectOwner: string; expectedJobId: string; expectedProjectId: string | null; expectedRecordId: string; allowReplay: boolean }): VerificationRecord {
  const { expectOwner, expectedJobId, expectedProjectId, expectedRecordId, allowReplay } = opts;
  if (incoming.id !== expectedRecordId) throw new AccessDeniedError("Verification record id does not match expected record");
  if (incoming.jobId && incoming.jobId !== expectedJobId) throw new AccessDeniedError("Verification record job does not match expected job");
  if ((incoming.projectId || null) !== (expectedProjectId || null)) throw new AccessDeniedError("Verification record project does not match expected project");
  if (existing) {
    const existingOwner = existing.requestedBy ?? undefined;
    if (existingOwner && existingOwner !== expectOwner) throw new AccessDeniedError("Verification record is owned by another principal");
    if (existing.jobId && existing.jobId !== expectedJobId) throw new AccessDeniedError("Verification record is bound to a different job");
    if ((existing.projectId || null) !== (expectedProjectId || null)) throw new AccessDeniedError("Verification record is bound to a different project");
    if (allowReplay && replayEquivalent(existing, incoming)) return existing;
    const owner = expectOwner ?? existingOwner ?? incoming.requestedBy;
    return { ...existing, ...incoming, id: existing.id, jobId: existing.jobId ?? incoming.jobId, projectId: existing.projectId ?? incoming.projectId, requestedBy: owner };
  }
  if (incoming.requestedBy && incoming.requestedBy !== expectOwner) throw new AccessDeniedError("Verification record owner does not match the claimed job");
  return { ...incoming, requestedBy: expectOwner, jobId: expectedJobId, projectId: expectedProjectId ?? undefined };
}

export type CompletionInput = {
  job: VerificationJob;
  runnerId: string;
  record: VerificationRecord;
  result: VerificationJobResult;
  outcome: VerificationOutcome;
  jobStatus: "completed" | "failed" | "did_not_start";
  finishedAt: string;
};

export type CompletionOutput = { job: VerificationJob; record: VerificationRecord; idempotent: boolean };

export async function completeJobAtomically(input: CompletionInput): Promise<CompletionOutput> {
  if (hasDatabase()) return completeJobAtomicallyDb(input);
  return completeJobFencedFile(input);
}

function rowToJobLite(row: Record<string, unknown>): VerificationJob {
  const payload = (row.payload || {}) as Partial<VerificationJob>;
  return {
    id: String(row.id), status: String(row.status) as VerificationJobStatus, flow: String(payload.flow || ""), objective: String(payload.objective || ""), url: String(payload.url || ""),
    projectId: String(row.project_id || payload.projectId || ""), requestedBy: resolvePersistedJobOwner(row),
    repositoryConnectionId: payload.repositoryConnectionId,
    repositoryOwner: payload.repositoryOwner,
    repositoryName: payload.repositoryName,
    repositoryFullName: payload.repositoryFullName,
    repositoryDefaultBranch: payload.repositoryDefaultBranch,
    chromeProfile: payload.chromeProfile, headless: payload.headless, timeout: payload.timeout, reason: payload.reason,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : String(payload.createdAt || nowIso()),
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : payload.updatedAt,
    claimedAt: row.claimed_at ? new Date(String(row.claimed_at)).toISOString() : payload.claimedAt,
    leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)).toISOString() : payload.leaseExpiresAt,
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : payload.startedAt,
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : payload.completedAt,
    claimedBy: row.claimed_by ? String(row.claimed_by) : payload.claimedBy, runnerId: row.runner_id ? String(row.runner_id) : payload.runnerId,
    attempt: typeof payload.attempt === "number" ? payload.attempt : 0, recordId: row.record_id ? String(row.record_id) : payload.recordId,
    error: row.error ? String(row.error) : payload.error, result: payload.result as VerificationJob["result"], claimGeneration: typeof row.claim_generation === "number" ? row.claim_generation : Number(row.claim_generation || payload.claimGeneration || 0),
  };
}

async function completeJobAtomicallyDb(input: CompletionInput): Promise<CompletionOutput> {
  const { job, runnerId, record, result, outcome, jobStatus, finishedAt } = input;
  const owner = job.requestedBy?.trim();
  if (!owner) throw new AccessDeniedError("Job owner missing");
  const expectedRecordId = job.recordId || record.id;
  const expectedProjectId = job.projectId || null;
  const claimGeneration = job.claimGeneration ?? 0;

  await ensureDb();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const jobRes = await client.query("SELECT * FROM verification_jobs WHERE id = $1 FOR UPDATE", [job.id]);
    const row = jobRes.rows[0] as Record<string, unknown> | undefined;
    if (!row) { await client.query("ROLLBACK"); throw new Error("Job not found"); }
    const currentStatus = String(row.status) as VerificationJobStatus;
    const currentClaimedBy = row.claimed_by ? String(row.claimed_by) : undefined;
    const currentLease = row.lease_expires_at ? new Date(String(row.lease_expires_at)).getTime() : undefined;
    const currentGeneration = typeof row.claim_generation === "number" ? row.claim_generation : Number(row.claim_generation || 0);
    const currentRecordId = row.record_id ? String(row.record_id) : undefined;
    const currentProjectId = String(row.project_id || "") || null;
    const currentOwner = resolvePersistedJobOwner(row) || null;

    const terminalSame = (currentStatus === jobStatus && currentClaimedBy === runnerId && currentGeneration === claimGeneration && currentRecordId === expectedRecordId);
    if (terminalSame) {
      // Same checked-out transaction/client: initialize key if missing, then lock row.
      const recKey = recordsKey(currentProjectId ?? undefined);
      await client.query(`INSERT INTO echolog_kv (key, value, updated_at) VALUES ($1, '[]'::jsonb, NOW()) ON CONFLICT (key) DO NOTHING`, [recKey]);
      const recRes = await client.query("SELECT value FROM echolog_kv WHERE key = $1 FOR UPDATE", [recKey]);
      if (!recRes.rows[0]) { await client.query("ROLLBACK"); throw new Error("Verification records key missing after initialization"); }
      const records = Array.isArray(recRes.rows[0]?.value) ? (recRes.rows[0].value as VerificationRecord[]) : [];
      const existing = records.find(r => r.id === expectedRecordId || r.jobId === job.id);
      if (existing && replayEquivalent(existing, { ...record, requestedBy: owner, projectId: currentProjectId ?? undefined, jobId: job.id, id: expectedRecordId })) {
        await client.query("COMMIT");
        return { job: { ...job, ...rowToJobLite(row), status: jobStatus, recordId: expectedRecordId, completedAt: String(row.completed_at || finishedAt), result }, record: existing, idempotent: true };
      }
      await client.query("ROLLBACK");
      throw new AccessDeniedError("Conflicting replay for completed job");
    }

    if (!currentClaimedBy || currentClaimedBy !== runnerId) { await client.query("ROLLBACK"); throw new AccessDeniedError("Job is not claimed by this runner"); }
    if (currentGeneration !== claimGeneration) { await client.query("ROLLBACK"); throw new AccessDeniedError("Job claim generation mismatch"); }
    if (currentStatus !== "claimed" && currentStatus !== "running") { await client.query("ROLLBACK"); throw new Error("Job is not in a completable state"); }
    if (currentLease && currentLease < Date.now()) { await client.query("ROLLBACK"); throw new Error("Job claim lease has expired"); }
    if (!currentOwner || currentOwner !== owner) { await client.query("ROLLBACK"); throw new AccessDeniedError("Job owner mismatch"); }
    if ((currentProjectId || null) !== (expectedProjectId || null)) { await client.query("ROLLBACK"); throw new AccessDeniedError("Job project mismatch"); }
    if (currentRecordId && currentRecordId !== expectedRecordId) { await client.query("ROLLBACK"); throw new AccessDeniedError("Job record mismatch"); }

    // Lock records key on same client/transaction. Missing-row case: INSERT ON CONFLICT DO NOTHING then SELECT FOR UPDATE.
    const recKey = recordsKey(currentProjectId ?? undefined);
    await client.query(`INSERT INTO echolog_kv (key, value, updated_at) VALUES ($1, '[]'::jsonb, NOW()) ON CONFLICT (key) DO NOTHING`, [recKey]);
    const recRes = await client.query("SELECT value FROM echolog_kv WHERE key = $1 FOR UPDATE", [recKey]);
    if (!recRes.rows[0]) { await client.query("ROLLBACK"); throw new Error("Verification records key missing after initialization"); }
    const records = Array.isArray(recRes.rows[0]?.value) ? (recRes.rows[0].value as VerificationRecord[]) : [];
    const idx = records.findIndex(r => r.id === expectedRecordId || (job.id && r.jobId === job.id));
    const merged = mergeRecord(idx >= 0 ? records[idx] : undefined, { ...record, id: expectedRecordId, jobId: job.id, projectId: currentProjectId ?? undefined, requestedBy: owner }, { expectOwner: owner, expectedJobId: job.id, expectedProjectId, expectedRecordId, allowReplay: true });
    if (idx >= 0) records[idx] = merged; else records.unshift(merged);
    const trimmed = records.slice(0, 500);
    await client.query(`UPDATE echolog_kv SET value = $2::jsonb, updated_at = NOW() WHERE key = $1`, [recKey, JSON.stringify(trimmed)]);

    const nextPayload = { ...(typeof row.payload === "object" && row.payload ? (row.payload as Record<string, unknown>) : {}), ...job, status: jobStatus, completedAt: finishedAt, recordId: merged.id, result, error: jobStatus === "failed" || jobStatus === "did_not_start" ? (result.summary || result.failingStep || outcome) : undefined, leaseExpiresAt: undefined, updatedAt: nowIso(), claimGeneration: currentGeneration };
    const jobUpdate = await client.query(
      `UPDATE verification_jobs SET status=$1, payload=$2::jsonb, updated_at=NOW(), completed_at=$3::timestamptz, record_id=$4, error=$5, lease_expires_at=NULL
       WHERE id=$6 AND claimed_by=$7 AND claim_generation=$8 AND status = ANY($9::text[]) AND (lease_expires_at IS NULL OR lease_expires_at >= NOW())
       RETURNING *`,
      [jobStatus, JSON.stringify(nextPayload), finishedAt, merged.id, nextPayload.error ?? null, job.id, runnerId, currentGeneration, ["claimed", "running"]],
    );
    if (!jobUpdate.rows[0]) { await client.query("ROLLBACK"); throw new Error("Job completion could not be applied (claim/status changed)"); }

    // Durable investigation-processing intent: same transaction as record+job completion in PostgreSQL mode.
    if (outcome !== "pending" && outcome !== "running") {
      const outboxId = `${job.id}:${currentGeneration}:process_verification_result`;
      await client.query(
        `INSERT INTO verification_processing_outbox (id, job_id, record_id, owner_user_id, project_id, claim_generation, operation, status, attempt_count, max_attempts, available_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'process_verification_result','pending',0,8,NOW(),NOW(),NOW())
         ON CONFLICT (job_id, claim_generation, operation) DO UPDATE SET updated_at=NOW(), record_id=EXCLUDED.record_id, owner_user_id=EXCLUDED.owner_user_id, project_id=EXCLUDED.project_id`,
        [outboxId, job.id, merged.id, owner, currentProjectId, currentGeneration]
      );
    }

    await client.query("COMMIT");
    return { job: rowToJobLite(jobUpdate.rows[0] as Record<string, unknown>), record: merged, idempotent: false };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function readRecordsFile(): Promise<VerificationRecord[]> {
  if (!canUseLocalFs()) throw new Error("Durable verification record storage is not configured (DATABASE_URL missing in production).");
  await ensureDir();
  try { const raw = await fs.readFile(RECORDS_FILE, "utf8"); const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
}
async function writeRecordsFile(records: VerificationRecord[]): Promise<void> {
  if (!canUseLocalFs()) throw new Error("Durable verification record storage is not configured (DATABASE_URL missing in production).");
  await ensureDir();
  await fs.writeFile(RECORDS_FILE, JSON.stringify(records.slice(0, 500), null, 2), "utf8");
}

async function completeJobFencedFile(input: CompletionInput): Promise<CompletionOutput> {
  const { job, runnerId, record, result, outcome, jobStatus, finishedAt } = input;
  const owner = job.requestedBy?.trim();
  if (!owner) throw new AccessDeniedError("Job owner missing");
  const expectedRecordId = job.recordId || record.id;
  const expectedProjectId = job.projectId || null;
  const claimGeneration = job.claimGeneration ?? 0;
  const hash = payloadHash(record, outcome, result);

  const reservations = await readReservations();
  const existingRes = reservations.find(r => r.jobId === job.id);
  const fresh = await getJob(job.id);
  if (!fresh) throw new Error("Job not found");
  const freshGen = fresh.claimGeneration ?? 0;
  const terminalSame = fresh.status === jobStatus && fresh.claimedBy === runnerId && freshGen === claimGeneration && fresh.recordId === expectedRecordId;
  if (terminalSame) {
    const recs = await readVerificationRecords({ projectId: fresh.projectId, requestedBy: owner, includeLegacy: false });
    const existing = recs.find(r => r.id === expectedRecordId || r.jobId === job.id);
    if (existing && replayEquivalent(existing, { ...record, id: expectedRecordId, jobId: job.id, projectId: fresh.projectId, requestedBy: owner })) {
      return { job: fresh, record: existing, idempotent: true };
    }
    throw new AccessDeniedError("Conflicting replay for completed job");
  }
  if (!fresh.claimedBy || fresh.claimedBy !== runnerId) throw new AccessDeniedError("Job is not claimed by this runner");
  if (freshGen !== claimGeneration) throw new AccessDeniedError("Job claim generation mismatch");
  if (fresh.status !== "claimed" && fresh.status !== "running") throw new Error("Job is not in a completable state");
  if (fresh.leaseExpiresAt && new Date(fresh.leaseExpiresAt).getTime() < Date.now()) throw new Error("Job claim lease has expired");
  if ((fresh.projectId || null) !== (expectedProjectId || null)) throw new AccessDeniedError("Job project mismatch");
  if ((fresh.requestedBy || null) !== owner) throw new AccessDeniedError("Job owner mismatch");
  if (fresh.recordId && fresh.recordId !== expectedRecordId) throw new AccessDeniedError("Job record mismatch");

  if (existingRes && existingRes.claimGeneration !== claimGeneration) throw new AccessDeniedError("Stale completion reservation generation");
  if (existingRes && existingRes.runnerId !== runnerId) throw new AccessDeniedError("Completion reservation owned by another runner");
  if (existingRes && existingRes.payloadHash !== hash) throw new AccessDeniedError("Conflicting completion reservation payload");
  if (!existingRes) {
    reservations.unshift({ jobId: job.id, runnerId, claimGeneration, recordId: expectedRecordId, outcome, payloadHash: hash, result, createdAt: nowIso(), status: "reserved" });
    await writeReservations(reservations);
  }

  const records = await readRecordsFile();
  const idx = records.findIndex(r => r.id === expectedRecordId || r.jobId === job.id);
  const merged = mergeRecord(idx >= 0 ? records[idx] : undefined, { ...record, id: expectedRecordId, jobId: job.id, projectId: fresh.projectId, requestedBy: owner }, { expectOwner: owner, expectedJobId: job.id, expectedProjectId: (fresh.projectId || null), expectedRecordId, allowReplay: true });
  if (idx >= 0) records[idx] = merged; else records.unshift(merged);
  await writeRecordsFile(records);

  const reservations2 = await readReservations();
  const res2 = reservations2.find(r => r.jobId === job.id);
  if (!res2 || res2.runnerId !== runnerId || res2.claimGeneration !== claimGeneration || res2.payloadHash !== hash) throw new AccessDeniedError("Completion reservation invalidated before finalization");
  res2.status = "record_persisted"; await writeReservations(reservations2);

  const fresh2 = await getJob(job.id);
  if (!fresh2) throw new Error("Job missing before finalization");
  if (fresh2.claimedBy !== runnerId || (fresh2.claimGeneration ?? 0) !== claimGeneration) throw new AccessDeniedError("Job claim changed before finalization");
  if (fresh2.status !== "claimed" && fresh2.status !== "running") {
    if (fresh2.status === jobStatus && fresh2.recordId === expectedRecordId) return { job: fresh2, record: merged, idempotent: true };
    throw new Error("Job not completable before finalization");
  }
  const updated = await updateJob(job.id, { status: jobStatus, completedAt: finishedAt, recordId: merged.id, result, error: jobStatus === "failed" || jobStatus === "did_not_start" ? (result.summary || result.failingStep || outcome) : undefined, leaseExpiresAt: undefined }, { expectedClaimedBy: runnerId, expectedStatus: ["claimed", "running"], requireActiveLease: true, expectedClaimGeneration: claimGeneration });
  if (!updated) {
    const after = await getJob(job.id);
    if (after && after.status === jobStatus && after.claimedBy === runnerId && after.recordId === merged.id) return { job: after, record: merged, idempotent: true };
    throw new Error("Job completion could not be applied (claim/status changed)");
  }
  const reservations3 = await readReservations();
  const res3 = reservations3.find(r => r.jobId === job.id);
  if (res3) { res3.status = "finalized"; await writeReservations(reservations3); }
  if (outcome !== "pending" && outcome !== "running") {
    try {
      const { enqueueVerificationProcessing } = await import("@/lib/verification/outbox");
      await enqueueVerificationProcessing({ jobId: job.id, recordId: merged.id, ownerUserId: owner, projectId: (fresh.projectId || null) as string | null, claimGeneration });
    } catch {
      // File fallback has no cross-file transaction; finalized completion stands, outbox can be re-enqueued by recovery.
    }
  }
  return { job: updated, record: merged, idempotent: false };
}


export type RecoveryResult = { recovered: boolean; reason: string; jobId: string };

/**
 * File-fallback recovery for crash window: reservation exists, record persisted, job not finalized.
 * FAIL-CLOSED: only finalizes when current job still matches reserved runner/generation/owner/project/record
 * and reservation payload hash matches persisted record. Never finalizes reclaimed/newer generation.
 * Not cross-file atomic; safe to retry.
 */
export async function recoverIncompleteCompletion(jobId: string): Promise<RecoveryResult> {
  if (hasDatabase()) return { recovered: false, reason: 'db_mode_not_file_recovery', jobId };
  if (!canUseLocalFs()) return { recovered: false, reason: 'no_local_fs', jobId };
  const reservations = await readReservations();
  const resv = reservations.find(r => r.jobId === jobId);
  if (!resv) return { recovered: false, reason: 'no_reservation', jobId };
  if (resv.status === 'finalized') return { recovered: false, reason: 'already_finalized', jobId };
  const job = await getJob(jobId);
  if (!job) return { recovered: false, reason: 'job_missing', jobId };
  if ((job.claimGeneration ?? 0) !== resv.claimGeneration) return { recovered: false, reason: 'generation_mismatch', jobId };
  if (job.claimedBy !== resv.runnerId) return { recovered: false, reason: 'runner_mismatch', jobId };
  if (job.recordId && job.recordId !== resv.recordId) return { recovered: false, reason: 'record_mismatch', jobId };
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'did_not_start') {
    if (job.recordId === resv.recordId) { resv.status = 'finalized'; await writeReservations(reservations); return { recovered: false, reason: 'job_already_terminal', jobId }; }
    return { recovered: false, reason: 'terminal_with_different_record', jobId };
  }
  if (job.status !== 'claimed' && job.status !== 'running') return { recovered: false, reason: 'job_not_completable', jobId };
  if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() < Date.now()) return { recovered: false, reason: 'lease_expired', jobId };

  const records = await readRecordsFile();
  const rec = records.find(r => r.id === resv.recordId || r.jobId === jobId);
  if (!rec) return { recovered: false, reason: 'record_missing', jobId };
  if ((rec.requestedBy || null) !== (job.requestedBy || null)) return { recovered: false, reason: 'owner_mismatch', jobId };
  if ((rec.projectId || null) !== (job.projectId || null)) return { recovered: false, reason: 'project_mismatch', jobId };
  const resultForHash: VerificationJobResult = resv.result ?? { outcome: resv.outcome, summary: rec.summary, failingStep: rec.failingStep, exitCode: rec.exitCode, durationMs: rec.durationMs, creditsConsumed: rec.creditsConsumed, evidencePath: rec.evidencePath, testUrl: rec.testUrl, sessionDir: rec.sessionDir, ndjsonPath: rec.ndjsonPath, runEnd: rec.runEnd, stderr: rec.stderr, startedAt: rec.startedAt, finishedAt: rec.finishedAt };
  const expectedHash = payloadHash(rec, resv.outcome, resultForHash);
  if (expectedHash !== resv.payloadHash) return { recovered: false, reason: 'payload_hash_mismatch', jobId };

  const jobStatus = resv.outcome === 'did_not_start' ? 'did_not_start' : (resv.outcome === 'passed' ? 'completed' : 'failed');
  const result: VerificationJobResult = resv.result ?? { outcome: resv.outcome, summary: rec.summary, failingStep: rec.failingStep, exitCode: rec.exitCode, durationMs: rec.durationMs, creditsConsumed: rec.creditsConsumed, evidencePath: rec.evidencePath, testUrl: rec.testUrl, sessionDir: rec.sessionDir, ndjsonPath: rec.ndjsonPath, runEnd: rec.runEnd, stderr: rec.stderr, startedAt: rec.startedAt, finishedAt: rec.finishedAt };
  const updated = await updateJob(jobId, { status: jobStatus, completedAt: rec.finishedAt || nowIso(), recordId: rec.id, result, error: jobStatus === 'failed' || jobStatus === 'did_not_start' ? (rec.summary || rec.failingStep || resv.outcome) : undefined, leaseExpiresAt: undefined }, { expectedClaimedBy: resv.runnerId, expectedStatus: ['claimed','running'], requireActiveLease: true, expectedClaimGeneration: resv.claimGeneration });
  if (!updated) {
    const after = await getJob(jobId);
    if (after && (after.status === 'completed' || after.status === 'failed' || after.status === 'did_not_start') && after.recordId === rec.id) {
      resv.status = 'finalized'; await writeReservations(reservations); return { recovered: false, reason: 'already_terminal_same_record', jobId };
    }
    return { recovered: false, reason: 'finalization_failed', jobId };
  }
  resv.status = 'finalized';
  await writeReservations(reservations);
  return { recovered: true, reason: 'finalized', jobId };
}
