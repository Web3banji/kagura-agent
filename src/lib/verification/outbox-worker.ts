import { getJob } from "@/lib/verification/jobs";
import { getVerificationRecord, upsertVerificationRecord } from "@/lib/verification/store";
import { processVerificationResult } from "@/lib/investigations/processor";
import { claimNextVerificationProcessing, markVerificationProcessingCompleted, markVerificationProcessingFailed, readOutboxItems, type VerificationProcessingOutbox } from "@/lib/verification/outbox";
import { resolveActiveRepositoryConnectionId } from "@/lib/repositories/connections";

export type DrainResult = { processed: number; failed: number; skipped: number; items: Array<{ id: string; status: string; reason?: string }>; investigationIds?: string[]; state?: "pending"|"processing"|"processed"|"failed" };

function backoffMs(attempt: number): number { return Math.min(5 * 60_000, 15_000 * Math.max(1, attempt)); }

async function loadOwnedRecord(item: VerificationProcessingOutbox) {
  const job = await getJob(item.jobId);
  if (!job) return { ok: false as const, reason: "job_missing" };
  if ((job.claimGeneration ?? 0) !== item.claimGeneration) return { ok: false as const, reason: "claim_generation_mismatch" };
  if ((job.requestedBy || null) !== item.ownerUserId) return { ok: false as const, reason: "owner_mismatch" };
  if ((job.projectId || null) !== (item.projectId || null)) return { ok: false as const, reason: "project_mismatch" };
  if (job.recordId && job.recordId !== item.recordId) return { ok: false as const, reason: "record_mismatch" };
  const record = await getVerificationRecord(item.recordId, { requestedBy: item.ownerUserId, projectId: item.projectId ?? undefined, includeLegacy: false });
  if (!record) return { ok: false as const, reason: "record_missing_or_unauthorized" };
  if ((record.requestedBy || null) !== item.ownerUserId) return { ok: false as const, reason: "record_owner_mismatch" };
  if ((record.projectId || null) !== (item.projectId || null)) return { ok: false as const, reason: "record_project_mismatch" };
  if (record.jobId && record.jobId !== item.jobId) return { ok: false as const, reason: "record_job_mismatch" };
  return { ok: true as const, job, record };
}

export async function processOutboxItem(item: VerificationProcessingOutbox, workerId: string): Promise<{ status: string; investigationIds?: string[]; state?: "pending"|"processing"|"processed"|"failed"; reason?: string }> {
  const owned = await loadOwnedRecord(item);
  if (!owned.ok) {
    await markVerificationProcessingFailed(item.id, { workerId, claimGeneration: item.claimGeneration, error: owned.reason, retryDelayMs: 60_000 });
    return { status: "failed", reason: owned.reason, state: "failed" };
  }
  const { record } = owned;
  if (record.outcome === "pending" || record.outcome === "running") {
    await markVerificationProcessingFailed(item.id, { workerId, claimGeneration: item.claimGeneration, error: "record_not_terminal", retryDelayMs: 30_000 });
    return { status: "skipped", reason: "record_not_terminal", state: "pending" };
  }
  const existing = record.investigationProcessing?.state;
  if (existing === "processed") {
    await markVerificationProcessingCompleted(item.id, { workerId, claimGeneration: item.claimGeneration });
    return { status: "completed", investigationIds: record.investigationIds ?? [], state: "processed" };
  }
  const processingStartedAt = record.investigationProcessing?.processingStartedAt || new Date().toISOString();
  await upsertVerificationRecord({ ...record, investigationProcessing: { state: "processing", processingStartedAt, attemptCount: (record.investigationProcessing?.attemptCount ?? 0) + 1 } }, { expectOwner: item.ownerUserId, expectedJobId: item.jobId, expectedProjectId: item.projectId, expectedRecordId: item.recordId, allowReplay: false }).catch(() => undefined);

  try {
    const repositoryConnectionId = await resolveActiveRepositoryConnectionId(item.projectId, item.ownerUserId);
    const resultInv = await processVerificationResult({
      ...record,
      requestedBy: item.ownerUserId,
      projectId: item.projectId ?? undefined,
      jobId: item.jobId,
    }, { ownerUserId: item.ownerUserId, projectId: item.projectId, repositoryConnectionId });
    const investigationIds = resultInv.investigations.map(i => i.id);
    await upsertVerificationRecord({ ...record, investigationIds, investigationProcessing: { state: "processed", processingStartedAt, processedAt: new Date().toISOString(), attemptCount: (record.investigationProcessing?.attemptCount ?? 0) + 1 } }, { expectOwner: item.ownerUserId, expectedJobId: item.jobId, expectedProjectId: item.projectId, expectedRecordId: item.recordId, allowReplay: false });
    await markVerificationProcessingCompleted(item.id, { workerId, claimGeneration: item.claimGeneration });
    return { status: "completed", investigationIds, state: "processed" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await upsertVerificationRecord({ ...record, investigationProcessing: { state: "failed", processingStartedAt, processedAt: new Date().toISOString(), error: msg.slice(0, 500), attemptCount: (record.investigationProcessing?.attemptCount ?? 0) + 1 } }, { expectOwner: item.ownerUserId, expectedJobId: item.jobId, expectedProjectId: item.projectId, expectedRecordId: item.recordId, allowReplay: false }).catch(() => undefined);
    await markVerificationProcessingFailed(item.id, { workerId, claimGeneration: item.claimGeneration, error: msg, retryDelayMs: backoffMs(item.attemptCount + 1) });
    return { status: "failed", reason: msg, state: "failed" };
  }
}

export async function drainVerificationProcessingOutbox(opts?: { limit?: number; workerId?: string; jobId?: string; claimGeneration?: number }): Promise<DrainResult> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 5, 25));
  const workerId = opts?.workerId || `outbox-${process.pid}-${Date.now()}`;
  const result: DrainResult = { processed: 0, failed: 0, skipped: 0, items: [] };
  for (let i = 0; i < limit; i++) {
    const item = await claimNextVerificationProcessing({ workerId, jobId: opts?.jobId, claimGeneration: opts?.claimGeneration });
    if (!item) break;
    const r = await processOutboxItem(item, workerId);
    if (r.status === "completed") result.processed++; else if (r.status === "failed") result.failed++; else result.skipped++;
    result.items.push({ id: item.id, status: r.status, reason: r.reason });
    if (opts?.jobId && item.jobId === opts.jobId) { result.investigationIds = r.investigationIds; result.state = r.state; }
  }
  // If caller asked for specific job and nothing claimed, report current record state for idempotent visibility.
  if (opts?.jobId && result.items.length === 0) {
    const items = await readOutboxItems();
    const match = items.find(i => i.jobId === opts.jobId && (opts.claimGeneration === undefined || i.claimGeneration === opts.claimGeneration));
    if (match) {
      const owned = await loadOwnedRecord(match);
      if (owned.ok) { result.state = owned.record.investigationProcessing?.state as "pending"|"processing"|"processed"|"failed"|undefined; result.investigationIds = owned.record.investigationIds; }
    }
  }
  return result;
}
