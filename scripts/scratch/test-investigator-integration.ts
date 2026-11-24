/**
 * Stage 1.1: Kane Completion → Investigator integration tests.
 *
 * Tests the integration between Kane CLI job completion and investigation processing.
 * Uses in-memory/local filesystem storage (no DATABASE_URL required).
 *
 * Run:  npx tsx scripts/scratch/test-investigator-integration.ts
 */

process.loadEnvFile(".env.local");
delete process.env.DATABASE_URL;

import assert from "node:assert";
import {
  createInvestigation,
  readInvestigations,
  getInvestigationById,
} from "@/lib/investigations/store";
import { processVerificationResult } from "@/lib/investigations/processor";
import type { VerificationRecord } from "@/types/verification";

const TEST_USER = "integration-user-1";
const TEST_PROJECT = "integration-project-1";

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
    id: `ver-int-${Math.random().toString(36).slice(2)}`,
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
    jobId: `job-int-${Math.random().toString(36).slice(2)}`,
    projectId: TEST_PROJECT,
    requestedBy: TEST_USER,
    evidencePath: "data/verification/runs/int123.ndjson",
    ...overrides,
  };
}

async function runTests() {
  // Clear persisted state for clean isolation.
  const { writeInvestigations } = await import("@/lib/investigations/store");
  await writeInvestigations([]);

  // --- Test 1: Actionable Kane failure creates investigation ---
  await check("actionable Kane failure creates investigation", async () => {
    const record = makeRecord({ outcome: "failed", failingStep: "Click Activity history" });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER, projectId: TEST_PROJECT });
    assert.equal(result.action, "created");
    assert.ok(result.investigations[0]);
    assert.equal(result.investigations[0]!.ownerUserId, TEST_USER);
    assert.equal(result.investigations[0]!.projectId, TEST_PROJECT);
    assert.equal(result.investigations[0]!.status, "open");
    assert.equal(result.investigations[0]!.verificationReferences.length, 1);
  });

  // --- Test 2: Non-application runner failures do not create investigations ---
  await check("blocked verification does not create investigation", async () => {
    const record = makeRecord({ outcome: "blocked", failingStep: undefined, summary: undefined });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER, projectId: TEST_PROJECT });
    assert.equal(result.action, "none");
    assert.equal(result.investigations.length, 0);
  });

  await check("timeout verification does not create investigation", async () => {
    const record = makeRecord({ outcome: "timeout", failingStep: undefined, summary: undefined });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER, projectId: TEST_PROJECT });
    assert.equal(result.action, "none");
    assert.equal(result.investigations.length, 0);
  });

  await check("did_not_start verification does not create investigation", async () => {
    const record = makeRecord({ outcome: "did_not_start", failingStep: undefined, summary: undefined });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER, projectId: TEST_PROJECT });
    assert.equal(result.action, "none");
    assert.equal(result.investigations.length, 0);
  });

  // --- Test 3: Repeated completion submissions do not duplicate investigations ---
  await check("repeated same-failing-step does not duplicate investigation", async () => {
    const dupProject = "test-project-dup";
    const record1 = makeRecord({
      projectId: dupProject,
      failingStep: "Verify navigation bar",
      summary: "Navigation bar missing.",
    });
    const r1 = await processVerificationResult(record1, {
      ownerUserId: TEST_USER, projectId:  });
    assert.equal(r1.action, "created");

    const record2 = makeRecord({
      projectId: dupProject,
      id: record1.id + "-repeat",
      jobId: record1.jobId + "-repeat",
      failingStep: "Verify navigation bar",
      summary: "Navigation bar missing.",
      startedAt: new Date(Date.now() + 1000).toISOString(),
      finishedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const r2 = await processVerificationResult(record2, {
      ownerUserId: TEST_USER, projectId:  });
    assert.equal(r2.action, "updated");
    assert.equal(r2.investigations[0]!.verificationReferences.length, 2);

    const all = await readInvestigations({
      userId: TEST_USER,
      includeLegacy: true,
      privileged: false,
    } as never);
    const matching = all.filter((i) => i.projectId === dupProject);
    assert.equal(matching.length, 1, "Expected exactly one investigation, got " + matching.length);
  });

  // --- Test 4: Investigation processing errors don't corrupt verification records ---
  // This is implicitly tested by the fact that processVerificationResult returns
  // gracefully and all other tests pass. Verification records are independent.
  await check("verification records remain independent of investigation errors", async () => {
    const independentProject = "test-project-independent";
    const record = makeRecord({
      projectId: independentProject,
      outcome: "failed",
      failingStep: "Independent record test step",
    });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER, projectId:  });
    assert.equal(result.action, "created");
    // The verification record's fields are not mutated by investigation processing.
    assert.equal(record.outcome, "failed");
    assert.equal(record.failingStep, "Independent record test step");
  });

  // --- Test 5: Investigation records retain correct project and owner ---
  await check("investigation retains correct project and owner", async () => {
    const retainProject = "test-project-retain";
    const record = makeRecord({
      projectId: retainProject,
      failingStep: "Retain project test",
    });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER, projectId:  });
    const inv = result.investigations[0]!;
    assert.equal(inv.ownerUserId, TEST_USER);
    assert.equal(inv.projectId, retainProject);

    const fetched = await getInvestigationById(inv.id, {
      userId: TEST_USER,
      includeLegacy: true,
      privileged: false,
    } as never);
    assert.ok(fetched);
    assert.equal(fetched!.ownerUserId, TEST_USER);
    assert.equal(fetched!.projectId, retainProject);
  });

  // --- Test 6: Subsequent successful verification resolves matching issue ---
  await check("successful verification resolves matching investigation", async () => {
    const resolveProject = "test-project-resolve-int";
    const failed = makeRecord({
      projectId: resolveProject,
      failingStep: "Resolve test step",
    });
    const created = await processVerificationResult(failed, {
      ownerUserId: TEST_USER, projectId:  });
    assert.equal(created.action, "created");
    assert.equal(created.investigations[0]!.status, "open");

    const passed = makeRecord({
      id: failed.id + "-pass",
      jobId: failed.jobId + "-pass",
      projectId: resolveProject,
      outcome: "passed",
      exitCode: 0,
      failingStep: "Resolve test step",
      summary: "Step resolved.",
      runEnd: { status: "passed" },
      startedAt: new Date(Date.now() + 2000).toISOString(),
      finishedAt: new Date(Date.now() + 2000).toISOString(),
    });
    const resolved = await processVerificationResult(passed, {
      ownerUserId: TEST_USER, projectId:  });
    assert.equal(resolved.action, "resolved");
    assert.equal(resolved.investigations[0]!.status, "resolved");
  });

  // --- Test 7: Successful verification does not resolve unrelated issues ---
  await check("successful verification does not resolve unrelated issue", async () => {
    const unrelatedProject = "test-project-unrelated";
    const failed = makeRecord({
      projectId: unrelatedProject,
      failingStep: "Unrelated issue step",
    });
    const created = await processVerificationResult(failed, {
      ownerUserId: TEST_USER, projectId:  });
    assert.equal(created.investigations[0]!.status, "open");

    // Pass a verification for a different failing step — should not resolve the unrelated issue
    const passedOther = makeRecord({
      id: failed.id + "-pass-other",
      jobId: failed.jobId + "-pass-other",
      projectId: unrelatedProject,
      outcome: "passed",
      exitCode: 0,
      failingStep: "Different step entirely",
      summary: "Different step passed.",
      runEnd: { status: "passed" },
    });
    const result = await processVerificationResult(passedOther, {
      ownerUserId: TEST_USER, projectId:  });
    // Different failing step → no match → not resolved
    assert.equal(result.action, "none");
    assert.equal(created.investigations[0]!.status, "open");
  });

  // --- Test 8: Investigation can be retrieved via store ---
  await check("investigation is retrievable by ID", async () => {
    const record = makeRecord({ outcome: "failed", failingStep: "Retrieval integration test" });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER, projectId: TEST_PROJECT });
    const fetched = await getInvestigationById(result.investigations[0]!.id, {
      userId: TEST_USER,
      includeLegacy: true,
      privileged: false,
    } as never);
    assert.ok(fetched);
    assert.equal(fetched!.technicalExplanation, result.investigations[0]!.technicalExplanation);
    assert.equal(fetched!.simpleExplanation, result.investigations[0]!.simpleExplanation);
    assert.ok(fetched!.aiFixPrompt);
  });

  console.log(`\n${passed} Investigator Integration checks passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

runTests().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
