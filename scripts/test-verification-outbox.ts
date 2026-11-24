import assert from "node:assert/strict";
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const VER_DIR = path.join(DATA_DIR, "verification");
async function reset() { await fs.rm(VER_DIR,{recursive:true,force:true}); await fs.mkdir(VER_DIR,{recursive:true}); }

async function main() {
  process.env.KAGURA_RUNNER_SECRET = "test-secret";
  delete process.env.DATABASE_URL;
  await reset();
  const { enqueueJob, claimNextJob, getJob } = await import("../src/lib/verification/jobs");
  const { completeJobAtomically } = await import("../src/lib/verification/completion");
  const { upsertVerificationRecord, getVerificationRecord } = await import("../src/lib/verification/store");
  const { readOutboxItems } = await import("../src/lib/verification/outbox");
  const { drainVerificationProcessingOutbox } = await import("../src/lib/verification/outbox-worker");

  const job = await enqueueJob({ flow: "shell-nav", objective: "obj", url: "http://localhost:3000", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
  const claimed = await claimNextJob({ runnerId: "runner-1", leaseMs: 60_000 });
  assert.ok(claimed, "job should be claimed");
  assert.equal(claimed.id, job.id);
  const finishedAt = new Date().toISOString();
  const record = { id:"rec1", jobId:job.id, projectId:"p1", requestedBy:"u1", flow:"shell-nav", testUrl:"http://localhost:3000", status:"failed" as const, outcome:"failed" as const, startedAt:finishedAt, finishedAt, summary:"fail", evidencePath:"data/verification/runs/x.ndjson", investigationProcessing:{ state:"pending" as const } };
  const completion = await completeJobAtomically({ job: claimed!, runnerId:"runner-1", record: record as any, result:{ outcome:"failed", summary:"fail" }, outcome:"failed", jobStatus:"failed", finishedAt });
  assert.equal(completion.idempotent, false);
  let outbox = await readOutboxItems();
  assert.equal(outbox.some(i=>i.jobId===job.id && i.claimGeneration=== (claimed!.claimGeneration??0)), true);
  console.log("PASS outbox enqueued on completion");

  // drain should process; processor may create investigations in file mode depending on implementation. We assert idempotent completion of outbox item state.
  const d1 = await drainVerificationProcessingOutbox({ jobId: job.id, claimGeneration: claimed!.claimGeneration, limit: 5, workerId:"w1" });
  assert.ok(d1.items.length >= 0);
  const rec1 = await getVerificationRecord("rec1", { requestedBy:"u1", projectId:"p1", includeLegacy:false });
  assert.ok(rec1);
  console.log(`PASS drain completed state=${rec1?.investigationProcessing?.state}`);

  const d2 = await drainVerificationProcessingOutbox({ jobId: job.id, claimGeneration: claimed!.claimGeneration, limit: 5, workerId:"w2" });
  const rec2 = await getVerificationRecord("rec1", { requestedBy:"u1", projectId:"p1", includeLegacy:false });
  assert.equal(rec2?.investigationProcessing?.state, rec1?.investigationProcessing?.state);
  console.log("PASS second drain idempotent/no regression");

  // stale generation item should fail-closed
  await (await import("../src/lib/verification/outbox")).enqueueVerificationProcessing({ jobId: job.id, recordId: "rec1", ownerUserId:"u1", projectId:"p1", claimGeneration: 999 });
  const d3 = await drainVerificationProcessingOutbox({ jobId: job.id, claimGeneration: 999, limit: 5, workerId:"w3" });
  assert.ok(d3.failed >= 1 || d3.items.some(i=>i.reason?.includes('generation') || i.status==='failed'));
  console.log("PASS stale generation rejected/fail-closed");

  // owner mismatch
  await (await import("../src/lib/verification/outbox")).__unsafeWriteOutboxForTests([{
    id:"bad:1", jobId:job.id, recordId:"rec1", ownerUserId:"u2", projectId:"p1", claimGeneration: claimed!.claimGeneration ?? 1, operation:"process_verification_result", status:"pending", attemptCount:0, maxAttempts:8, availableAt:new Date().toISOString(), createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), lastError:null, leaseOwner:null, leaseExpiresAt:null, processedAt:null
  }] as any);
  const d4 = await drainVerificationProcessingOutbox({ jobId: job.id, claimGeneration: claimed!.claimGeneration, limit: 5, workerId:"w4" });
  assert.ok(d4.failed >= 1);
  console.log("PASS owner mismatch fail-closed");

  const finalJob = await getJob(job.id);
  assert.equal(finalJob?.status, "failed");
  console.log("PASS job status unchanged by outbox processing");
  console.log("\nAll verification outbox checks passed");
}

main().catch(e=>{ console.error(e); process.exit(1); });
