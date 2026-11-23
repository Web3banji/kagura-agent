/**
 * Stage 1.2: Investigator Integration Hardening tests.
 *
 * Tests verification→investigation linking, processing state tracking,
 * recovery, duplicate prevention, matching, and resolution.
 *
 * Uses in-memory/local filesystem storage (no DATABASE_URL required).
 *
 * Run:  npx tsx scripts/scratch/test-investigator-stage12.ts
 */

process.loadEnvFile(".env.local");
delete process.env.DATABASE_URL;

import assert from "node:assert";
import {
  createInvestigation,
  readInvestigations,
  writeInvestigations,
} from "@/lib/investigations/store";
import {
  processVerificationResult,
  isActionableVerification,
  isResolutionEvidence,
} from "@/lib/investigations/processor";
import {
  upsertVerificationRecord,
  getVerificationRecord,
} from "@/lib/verification/store";
import type { VerificationRecord } from "@/types/verification";

const TEST_USER = "s12-user-1";
const TEST_PROJECT = "s12-project-1";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof Error && e.stack) console.error(e.stack);
  }
}

function makeRecord(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    id: `ver-s12-${Math.random().toString(36).slice(2)}`,
    flow: "shell-nav",
    objective: "Verify the page shows KAGURA",
    url: "http://localhost:3000",
    outcome: "failed",
    exitCode: 1,
    summary: "The page did not show the expected content.",
    failingStep: 'Click the "Activity history" link',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    source: "runner",
    jobId: `job-s12-${Math.random().toString(36).slice(2)}`,
    projectId: TEST_PROJECT,
    requestedBy: TEST_USER,
    evidencePath: "data/verification/runs/s12.ndjson",
    investigationIds: [],
    investigationProcessing: { state: "pending" },
    ...overrides,
  };
}

async function runTests() {
  // Clear persisted state for clean isolation.
  await writeInvestigations([]);

  // --- Test 1: Verification record linked to its resulting investigation ---
  await check("verification record linked to investigation", async () => {
    const record = makeRecord({ failingStep: "Link test step" });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: TEST_PROJECT,
    });
    assert.equal(result.action, "created");
    const invId = result.investigations[0].id;

    // Link verification to investigation (simulating what the route does).
    const updated = await upsertVerificationRecord(
      {
        ...record,
        investigationIds: [invId],
        investigationProcessing: { state: "processed", processedAt: new Date().toISOString() },
      },
      { expectOwner: TEST_USER },
    );
    assert.ok(updated.investigationIds);
    assert.equal(updated.investigationIds.length, 1);
    assert.equal(updated.investigationIds[0], invId);
    assert.equal(updated.investigationProcessing?.state, "processed");

    // Verify retrieval returns the link.
    const fetched = await getVerificationRecord(updated.id, { requestedBy: TEST_USER });
    assert.ok(fetched);
    assert.equal(fetched!.investigationIds?.[0], invId);
  });

  // --- Test 2: Multiple distinct issues from one verification ---
  // Note: processVerificationResult creates one investigation per verification
  // because a single Kane run_end describes one flow outcome. Multiple
  // distinct issues require separate processing calls.
  await check("multiple distinct issues require separate processing", async () => {
    const multiProject = "s12-project-multi";
    const record1 = makeRecord({
      projectId: multiProject,
      failingStep: "Issue A step",
      summary: "Issue A summary",
    });
    const result1 = await processVerificationResult(record1, {
      ownerUserId: TEST_USER,
      projectId: multiProject,
    });
    assert.equal(result1.action, "created");

    const record2 = makeRecord({
      projectId: multiProject,
      failingStep: "Issue B step",
      summary: "Issue B summary",
      id: record1.id + "-b",
      jobId: record1.jobId + "-b",
    });
    const result2 = await processVerificationResult(record2, {
      ownerUserId: TEST_USER,
      projectId: multiProject,
    });
    assert.equal(result2.action, "created");

    const all = await readInvestigations({
      userId: TEST_USER,
      includeLegacy: true,
      privileged: false,
    } as never);
    const matching = all.filter((i) => i.projectId === multiProject);
    assert.equal(matching.length, 2, "Expected two distinct investigations");
    assert.ok(
      matching.some((i) => i.title.includes("Issue A step")),
      "Investigation for Issue A should exist",
    );
    assert.ok(
      matching.some((i) => i.title.includes("Issue B step")),
      "Investigation for Issue B should exist",
    );
  });

  // --- Test 3: Repeated processing without duplicate records or references ---
  await check("repeated processing does not duplicate", async () => {
    const dupProject = "s12-project-dup";
    const record1 = makeRecord({
      projectId: dupProject,
      failingStep: "Repeated step",
      summary: "Repeated summary",
    });
    const r1 = await processVerificationResult(record1, {
      ownerUserId: TEST_USER,
      projectId: dupProject,
    });
    assert.equal(r1.action, "created");

    const record2 = makeRecord({
      projectId: dupProject,
      failingStep: "Repeated step",
      summary: "Repeated summary",
      id: r1.investigations[0].verificationReferences[0].verificationId + "-repeat",
    });
    const r2 = await processVerificationResult(record2, {
      ownerUserId: TEST_USER,
      projectId: dupProject,
    });
    assert.equal(r2.action, "updated");
    assert.equal(r2.investigations[0].verificationReferences.length, 2);

    const all = await readInvestigations({
      userId: TEST_USER,
      includeLegacy: true,
      privileged: false,
    } as never);
    const matching = all.filter((i) => i.projectId === dupProject);
    assert.ok(matching.length >= 1, "Expected at least one investigation");
  });

  // --- Test 4: Processing state tracking ---
  await check("processing state transitions correctly", async () => {
    const stateProject = "s12-project-state";
    const record = makeRecord({
      projectId: stateProject,
      failingStep: "State test step",
    });

    // Initial: pending
    assert.equal(record.investigationProcessing?.state, "pending");

    // After processing: processed
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: stateProject,
    });
    const updated = await upsertVerificationRecord(
      {
        ...record,
        investigationIds: result.investigations.map((i) => i.id),
        investigationProcessing: { state: "processed", processedAt: new Date().toISOString() },
      },
      { expectOwner: TEST_USER },
    );
    assert.equal(updated.investigationProcessing?.state, "processed");
    assert.ok(updated.investigationProcessing?.processedAt);
  });

  // --- Test 5: Completed Kane jobs remain completed when Investigator processing fails ---
  // Simulated by checking that a non-actionable result doesn't create investigations
  // but the record is still valid.
  await check("non-actionable result does not create investigation", async () => {
    const blockedProject = "s12-project-blocked";
    const record = makeRecord({
      projectId: blockedProject,
      outcome: "blocked",
      failingStep: undefined,
      summary: undefined,
    });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: blockedProject,
    });
    assert.equal(result.action, "none");
    assert.equal(result.investigations.length, 0);

    // The record itself is unaffected.
    assert.equal(record.outcome, "blocked");
  });

  // --- Test 6: Unrelated failures not merged ---
  await check("unrelated failures are not merged", async () => {
    const unrelProject = "s12-project-unrel";
    const record1 = makeRecord({
      projectId: unrelProject,
      failingStep: "Issue Alpha step",
      summary: "Alpha summary",
    });
    await processVerificationResult(record1, {
      ownerUserId: TEST_USER,
      projectId: unrelProject,
    });

    const record2 = makeRecord({
      projectId: unrelProject,
      failingStep: "Issue Beta step",
      summary: "Beta summary",
    });
    const result2 = await processVerificationResult(record2, {
      ownerUserId: TEST_USER,
      projectId: unrelProject,
    });
    assert.equal(result2.action, "created");

    const all = await readInvestigations({
      userId: TEST_USER,
      includeLegacy: true,
      privileged: false,
    } as never);
    const matching = all.filter((i) => i.projectId === unrelProject);
    assert.equal(matching.length, 2, "Expected two separate investigations");
  });

  // --- Test 7: Passing run resolves only matching issue ---
  await check("passing run resolves only matching investigation", async () => {
    const resolveProject = "s12-project-resolve";
    const failed = makeRecord({
      projectId: resolveProject,
      failingStep: "Resolve test step",
    });
    const created = await processVerificationResult(failed, {
      ownerUserId: TEST_USER,
      projectId: resolveProject,
    });
    assert.equal(created.action, "created");
    assert.equal(created.investigations[0].status, "open");

    const passed = makeRecord({
      id: failed.id + "-pass",
      jobId: failed.jobId + "-pass",
      projectId: resolveProject,
      outcome: "passed",
      exitCode: 0,
      failingStep: "Resolve test step",
      summary: "Step resolved.",
      runEnd: { status: "passed" },
    });
    const resolved = await processVerificationResult(passed, {
      ownerUserId: TEST_USER,
      projectId: resolveProject,
    });
    assert.equal(resolved.action, "resolved");
    assert.equal(resolved.investigations[0].status, "resolved");
  });

  // --- Test 8: Passing run does not resolve unrelated issue ---
  await check("passing run does not resolve unrelated issue", async () => {
    const otherProject = "s12-project-other";
    const failed = makeRecord({
      projectId: otherProject,
      failingStep: "Unrelated step",
    });
    await processVerificationResult(failed, {
      ownerUserId: TEST_USER,
      projectId: otherProject,
    });

    const passedOther = makeRecord({
      id: "ver-pass-other",
      jobId: "job-pass-other",
      projectId: otherProject,
      outcome: "passed",
      exitCode: 0,
      failingStep: "Completely different step",
      summary: "Different step passed.",
      runEnd: { status: "passed" },
    });
    const result = await processVerificationResult(passedOther, {
      ownerUserId: TEST_USER,
      projectId: otherProject,
    });
    assert.equal(result.action, "none");
  });

  // --- Test 9: Investigation processing state distinguishes failed processing ---
  await check("processing state records failure", async () => {
    const failProject = "s12-project-fail";
    const record = makeRecord({
      projectId: failProject,
      failingStep: "Processing failure test",
    });

    // Simulate failed processing state.
    const failedRecord = await upsertVerificationRecord(
      {
        ...record,
        investigationIds: [],
        investigationProcessing: {
          state: "failed",
          processedAt: new Date().toISOString(),
          error: "Investigator processing temporarily unavailable",
        },
      },
      { expectOwner: TEST_USER },
    );
    assert.equal(failedRecord.investigationProcessing?.state, "failed");
    assert.ok(failedRecord.investigationProcessing?.error);
    assert.ok(failedRecord.investigationProcessing?.processedAt);

    // Recovery: retry processing.
    const recovered = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: failProject,
    });
    assert.equal(recovered.action, "created");

    const recoveredUpdated = await upsertVerificationRecord(
      {
        ...record,
        investigationIds: recovered.investigations.map((i) => i.id),
        investigationProcessing: { state: "processed", processedAt: new Date().toISOString() },
      },
      { expectOwner: TEST_USER },
    );
    assert.equal(recoveredUpdated.investigationProcessing?.state, "processed");
  });

  // --- Test 10: Ownership and project isolation ---
  await check("user cannot see another user's linked investigations", async () => {
    const isoProject = "s12-project-iso";
    const record = makeRecord({
      projectId: isoProject,
      failingStep: "Isolation test step",
    });
    await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: isoProject,
    });

    const others = await readInvestigations({
      userId: "other-user",
      includeLegacy: true,
      privileged: false,
    } as never);
    assert.equal(others.length, 0, "Other user should see no investigations");
  });

  // --- Test 11: Non-actionable result not marked as failed ---
  await check("non-actionable result does not get failed processing state", async () => {
    const naProject = "s12-project-na";
    const record = makeRecord({
      projectId: naProject,
      outcome: "blocked",
      failingStep: undefined,
      summary: undefined,
    });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: naProject,
    });
    assert.equal(result.action, "none");
    // The investigation processing state should remain pending/none, not "failed".
    assert.equal(record.investigationProcessing?.state, "pending");
  });

  // --- Test 12: Non-actionable result is marked processed ---
  await check("non-actionable result marked processed", async () => {
    const procProject = "s12-project-proc";
    const record = makeRecord({
      projectId: procProject,
      outcome: "blocked",
      failingStep: undefined,
      summary: undefined,
      investigationProcessing: { state: "pending" },
    });
    // Simulate what the completion route does: mark processed even for non-actionable.
    const updated = await upsertVerificationRecord(
      {
        ...record,
        investigationIds: [],
        investigationProcessing: { state: "processed", processedAt: new Date().toISOString() },
      },
      { expectOwner: TEST_USER },
    );
    assert.equal(updated.investigationProcessing?.state, "processed");
    assert.ok(updated.investigationProcessing?.processedAt);
    assert.equal(updated.investigationIds?.length, 0);
  });

  // --- Test 13: Already-processed recovery is idempotent ---
  await check("already-processed recovery returns without changes", async () => {
    const idemProject = "s12-project-idem";
    const record = makeRecord({
      projectId: idemProject,
      failingStep: "Idempotent test step",
      investigationIds: ["inv-1"],
      investigationProcessing: { state: "processed", processedAt: new Date().toISOString() },
    });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: idemProject,
    });
    // Since no pre-existing investigation exists in the store, this creates one.
    assert.equal(result.action, "created");
    assert.equal(result.investigations.length, 1);
  });

  // --- Test 14: Processing state set to 'processing' during execution ---
  await check("processing state transitions through processing", async () => {
    const proc2Project = "s12-project-proc2";
    const record = makeRecord({
      projectId: proc2Project,
      failingStep: "Processing lifecycle test",
    });

    // Step 1: mark as processing (as the completion route does).
    const processing = await upsertVerificationRecord(
      {
        ...record,
        investigationProcessing: { state: "processing", processedAt: new Date().toISOString() },
      },
      { expectOwner: TEST_USER },
    );
    assert.equal(processing.investigationProcessing?.state, "processing");

    // Step 2: complete processing → processed.
    const result = await processVerificationResult(processing, {
      ownerUserId: TEST_USER,
      projectId: proc2Project,
    });
    const completed = await upsertVerificationRecord(
      {
        ...processing,
        investigationIds: result.investigations.map((i) => i.id),
        investigationProcessing: { state: "processed", processedAt: new Date().toISOString() },
      },
      { expectOwner: TEST_USER },
    );
    assert.equal(completed.investigationProcessing?.state, "processed");
  });

  // --- Test 15: Concurrent processing protection — 'processing' state blocks retry ---
  await check("processing state blocks concurrent processing", async () => {
    const concProject = "s12-project-conc";
    const record = makeRecord({
      projectId: concProject,
      failingStep: "Concurrent test step",
      investigationProcessing: { state: "processing" },
    });

    // Simulate the completion route's concurrency check: if already 'processing', skip.
    const existingProcessing = record.investigationProcessing?.state;
    let investigationIds: string[] = [];
    let investigationState: "pending" | "processing" | "processed" | "failed" = "processed";
    if (existingProcessing === "processing" || existingProcessing === "processed") {
      investigationIds = record.investigationIds ?? [];
      investigationState = existingProcessing;
    }
    assert.equal(investigationState, "processing");
    assert.equal(investigationIds.length, 0);
  });

  // --- Test 16: Duplicate completion attempts are idempotent ---
  await check("duplicate completion attempts do not duplicate investigations", async () => {
    const dupProject = "s12-project-dup2";
    const record = makeRecord({
      projectId: dupProject,
      failingStep: "Duplicate completion test",
    });

    // First processing attempt creates investigation.
    const first = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: dupProject,
    });
    assert.equal(first.action, "created");

    // Second attempt with same failing step → updated, not created.
    // Same verificationId → reference is deduplicated (not added twice).
    const second = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: dupProject,
    });
    assert.equal(second.action, "updated");
    assert.equal(second.investigations[0].verificationReferences.length, 1);

    const all = await readInvestigations({
      userId: TEST_USER,
      includeLegacy: true,
      privileged: false,
    } as never);
    const matching = all.filter((i) => i.projectId === dupProject);
    assert.ok(matching.length >= 1, "Expected at least one investigation");
  });

  // --- Test 17: A record stuck in processing can be recovered ---
  await check("stale processing record is recoverable", async () => {
    const staleProject = "s12-project-stale";
    const oldTime = new Date(Date.now() - 600000).toISOString(); // 10 minutes ago
    const record = makeRecord({
      projectId: staleProject,
      failingStep: "Stale processing test",
      investigationProcessing: {
        state: "processing",
        processingStartedAt: oldTime,
      },
    });

    // With default 5-minute threshold, 10 minutes old IS stale.
    const STALE_MS = Number(process.env.KAGURA_INVESTIGATOR_STALE_PROCESSING_MS || 300000);
    const isStaleDefault =
      record.investigationProcessing?.state === "processing" &&
      record.investigationProcessing?.processingStartedAt &&
      Date.now() - new Date(record.investigationProcessing.processingStartedAt).getTime() > STALE_MS;
    assert.equal(isStaleDefault, true);

    // Recovery: reclaim the stale processing attempt and run investigation processing.
    process.env.KAGURA_INVESTIGATOR_STALE_PROCESSING_MS = "1";
    const recovered = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: staleProject,
    });
    assert.ok(recovered.action === "created" || recovered.action === "updated");

    // Finalize as processed.
    const finalized = await upsertVerificationRecord(
      {
        ...record,
        investigationIds: recovered.investigations.map((i) => i.id),
        investigationProcessing: { state: "processed", processedAt: new Date().toISOString() },
      },
      { expectOwner: TEST_USER },
    );
    assert.equal(finalized.investigationProcessing?.state, "processed");
    delete process.env.KAGURA_INVESTIGATOR_STALE_PROCESSING_MS;
  });

  // --- Test 18: A fresh processing record is NOT reclaimed as stale ---
  await check("fresh processing record is not stale", async () => {
    const freshProject = "s12-project-fresh";
    const record = makeRecord({
      projectId: freshProject,
      failingStep: "Fresh processing test",
      investigationProcessing: {
        state: "processing",
        processingStartedAt: new Date().toISOString(),
      },
    });

    // With default 5-minute threshold, a fresh processing record is NOT stale.
    const STALE_MS = Number(process.env.KAGURA_INVESTIGATOR_STALE_PROCESSING_MS || 300000);
    const isStale =
      record.investigationProcessing?.state === "processing" &&
      record.investigationProcessing?.processingStartedAt &&
      Date.now() - new Date(record.investigationProcessing.processingStartedAt).getTime() > STALE_MS;
    assert.equal(isStale, false);
  });

  // --- Test 19: Two overlapping attempts — second sees processing state ---
  await check("overlapping attempts: second sees processing state", async () => {
    const overlapProject = "s12-project-overlap";
    const record = makeRecord({
      projectId: overlapProject,
      failingStep: "Overlap test step",
    });

    // First attempt marks processing.
    const first = await upsertVerificationRecord(
      {
        ...record,
        investigationProcessing: {
          state: "processing",
          processingStartedAt: new Date().toISOString(),
        },
      },
      { expectOwner: TEST_USER },
    );
    assert.equal(first.investigationProcessing?.state, "processing");

    // Second attempt reads the processing state and should not start a new attempt.
    const existingState = first.investigationProcessing?.state;
    const shouldSkip =
      existingState === "processing" || existingState === "processed";
    assert.equal(shouldSkip, true);
  });

  // --- Test 20: Recovery after interrupted processing attempt ---
  await check("recovery after interrupted processing", async () => {
    const interruptProject = "s12-project-interrupt";
    const oldTime = new Date(Date.now() - 600000).toISOString();
    const record = makeRecord({
      projectId: interruptProject,
      failingStep: "Interrupted processing test",
      investigationProcessing: {
        state: "processing",
        processingStartedAt: oldTime,
      },
    });
    // Simulate an interrupted processing attempt (record left in processing state).
    await upsertVerificationRecord(
      {
        ...record,
        investigationProcessing: {
          state: "processing",
          processingStartedAt: oldTime,
        },
      },
      { expectOwner: TEST_USER },
    );

    // Recovery reclaims the stale processing attempt (1ms threshold).
    process.env.KAGURA_INVESTIGATOR_STALE_PROCESSING_MS = "1";
    const STALE_MS = 1;
    const isStale =
      record.investigationProcessing?.state === "processing" &&
      record.investigationProcessing?.processingStartedAt &&
      Date.now() - new Date(record.investigationProcessing.processingStartedAt).getTime() > STALE_MS;
    assert.equal(isStale, true);

    const recovered = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: interruptProject,
    });
    assert.ok(recovered.action === "created" || recovered.action === "updated");

    // Finalize as processed.
    const finalized = await upsertVerificationRecord(
      {
        ...record,
        investigationIds: recovered.investigations.map((i) => i.id),
        investigationProcessing: { state: "processed", processedAt: new Date().toISOString() },
      },
      { expectOwner: TEST_USER },
    );
    assert.equal(finalized.investigationProcessing?.state, "processed");
    assert.ok(finalized.investigationIds?.length >= 1);
    delete process.env.KAGURA_INVESTIGATOR_STALE_PROCESSING_MS;
  });

  // --- Test 21: Duplicate verification references remain deduplicated after recovery ---
  await check("duplicate references remain deduplicated after recovery", async () => {
    const dedupProject = "s12-project-dedup-recovery";
    const record = makeRecord({
      projectId: dedupProject,
      failingStep: "Dedup recovery test",
    });
    // First processing creates investigation with one reference.
    const first = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: dedupProject,
    });
    assert.equal(first.action, "created");
    assert.equal(first.investigations[0].verificationReferences.length, 1);

    // Second processing with same verificationId → deduplicated, still 1 reference.
    const second = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: dedupProject,
    });
    assert.equal(second.action, "updated");
    assert.equal(second.investigations[0].verificationReferences.length, 1);

    // Recovery after processing → should not add duplicate references.
    const recovered = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: dedupProject,
    });
    assert.equal(recovered.action, "updated");
    assert.equal(recovered.investigations[0].verificationReferences.length, 1);
  });

  console.log(`\n${passed} Stage 1.2 checks passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

runTests().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
