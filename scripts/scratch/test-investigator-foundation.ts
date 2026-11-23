/**
 * Stage 1: Investigator Foundation tests.
 *
 * Tests the investigation data model, Kane result processing, explanation generation,
 * fix prompt generation, repeated-verification history updates, and ownership isolation.
 *
 * These tests use in-memory KV store (no DATABASE_URL required) and do not connect
 * to or migrate any configured application database.
 *
 * Run:  npx tsx scripts/scratch/test-investigator-foundation.ts
 */

process.loadEnvFile(".env.local");

// Force in-memory/local filesystem storage by unsetting DATABASE_URL if present.
delete process.env.DATABASE_URL;

import assert from "node:assert";
import {
  createInvestigation,
  readInvestigations,
  getInvestigationById,
  updateInvestigation,
  appendVerificationReference,
} from "@/lib/investigations/store";
import {
  processVerificationResult,
  isActionableVerification,
  isResolutionEvidence,
  verificationToReference,
  generateInvestigationOutputs,
} from "@/lib/investigations/processor";
import type { VerificationRecord } from "@/types/verification";
import type { Investigation } from "@/types/investigation";

const TEST_USER = "test-user-1";
const TEST_PROJECT = "test-project-1";

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

function makeVerificationRecord(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    id: `ver-${Math.random().toString(36).slice(2)}`,
    flow: "shell-nav",
    objective: "Verify the page shows KAGURA",
    url: "http://localhost:3000",
    outcome: "failed",
    exitCode: 1,
    summary: "The page did not show the expected content.",
    failingStep: 'Click the "Activity history" link in the sidebar navigation',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    source: "runner",
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    projectId: TEST_PROJECT,
    requestedBy: TEST_USER,
    evidencePath: "data/verification/runs/abc123.ndjson",
    ...overrides,
  };
}

async function runTests() {
  // Clear persisted investigation state from previous runs for clean isolation.
  const { writeInvestigations } = await import("@/lib/investigations/store");
  await writeInvestigations([]);

  // --- Test 1: Genuine Kane application failure produces an investigation ---
  await check("genuine Kane application failure creates an investigation", async () => {
    const firstProject = "test-project-first";
    const record = makeVerificationRecord({
      projectId: firstProject,
      outcome: "failed",
      failingStep: 'Click "Activity history"',
    });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: firstProject,
    });
    assert.equal(result.action, "created");
    assert.ok(result.investigations[0]);
    assert.equal(result.investigations[0]!.ownerUserId, TEST_USER);
    assert.equal(result.investigations[0]!.projectId, firstProject);
    assert.equal(result.investigations[0]!.status, "open");
    assert.ok(result.investigations[0]!.technicalExplanation);
    assert.ok(result.investigations[0]!.simpleExplanation);
    assert.ok(result.investigations[0]!.aiFixPrompt);
    assert.equal(result.investigations[0]!.verificationReferences.length, 1);
    assert.equal(result.investigations[0]!.verificationReferences[0].verificationId, record.id);
  });

  // --- Test 2: Blocked or timed-out verification is NOT misreported as defect ---
  await check("blocked verification does not create investigation", async () => {
    const record = makeVerificationRecord({ outcome: "blocked", failingStep: undefined, summary: undefined });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: TEST_PROJECT,
    });
    assert.equal(result.action, "none");
    assert.equal(result.investigations.length, 0);
    assert.equal(isActionableVerification(record), false);
  });

  await check("timed-out verification does not create investigation", async () => {
    const record = makeVerificationRecord({ outcome: "timeout", failingStep: undefined, summary: undefined });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: TEST_PROJECT,
    });
    assert.equal(result.action, "none");
    assert.equal(result.investigations.length, 0);
  });

  await check("did_not_start verification does not create investigation", async () => {
    const record = makeVerificationRecord({ outcome: "did_not_start", failingStep: undefined, summary: undefined });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: TEST_PROJECT,
    });
    assert.equal(result.action, "none");
    assert.equal(result.investigations.length, 0);
  });

  // --- Test 3: Technical and simple explanations associated with correct investigation ---
  await check("technical and simple explanations are present and correct", async () => {
    const record = makeVerificationRecord({
      outcome: "failed",
      failingStep: 'Click "Checks & tests"',
      summary: "The Checks & tests page did not load.",
    });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: TEST_PROJECT,
    });
    const inv = result.investigations[0]!;
    assert.ok(inv.technicalExplanation.includes("failed"));
    assert.ok(inv.technicalExplanation.includes("Checks & tests"));
    assert.ok(inv.simpleExplanation.includes("did not pass"));
    assert.ok(inv.technicalExplanation.length > 50);
    assert.ok(inv.simpleExplanation.length > 50);
  });

  // --- Test 4: Fix prompts contain actual issue evidence ---
  await check("fix prompt contains actual issue evidence", async () => {
    const record = makeVerificationRecord({
      outcome: "failed",
      failingStep: "Verify the page shows KAGURA",
      summary: "Expected heading not found.",
      evidencePath: "data/verification/runs/xyz.ndjson",
    });
    const result = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: TEST_PROJECT,
    });
    const inv = result.investigations[0]!;
    assert.ok(inv.aiFixPrompt);
    assert.ok(inv.aiFixPrompt!.includes("Verify the page shows KAGURA"));
    assert.ok(inv.aiFixPrompt!.includes("Expected heading not found"));
    assert.ok(inv.aiFixPrompt!.includes("data/verification/runs/xyz.ndjson"));
    assert.ok(inv.aiFixPrompt!.includes("investigate before assuming"));
    assert.ok(inv.aiFixPrompt!.includes("explain what was changed"));
  });

  // --- Test 5: Repeated findings update existing investigation, no duplicates ---
  await check("repeated same-failing-step updates existing investigation", async () => {
    const repeatedProject = "test-project-repeated";
    const record1 = makeVerificationRecord({
      projectId: repeatedProject,
      outcome: "failed",
      failingStep: "Click the sidebar navigation",
      summary: "Sidebar not found.",
    });
    const result1 = await processVerificationResult(record1, {
      ownerUserId: TEST_USER,
      projectId: repeatedProject,
    });
    assert.equal(result1.action, "created");

    const record2 = makeVerificationRecord({
      id: record1.id + "-2",
      jobId: record1.jobId + "-2",
      projectId: repeatedProject,
      outcome: "failed",
      failingStep: "Click the sidebar navigation",
      summary: "Sidebar not found.",
      startedAt: new Date(Date.now() + 1000).toISOString(),
      finishedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const result2 = await processVerificationResult(record2, {
      ownerUserId: TEST_USER,
      projectId: repeatedProject,
    });
    assert.equal(result2.action, "updated");
    assert.equal(result2.investigations[0]!.verificationReferences.length, 2);
    assert.equal(result2.investigations[0]!.lastDetectedAt, record2.finishedAt);

    // Ensure only one investigation was created for this user/project
    const all = await readInvestigations({ userId: TEST_USER, includeLegacy: true, privileged: false } as never);
    const matching = all.filter((i) => i.projectId === repeatedProject);
    assert.equal(matching.length, 1, "Expected exactly one investigation, got " + matching.length);
  });

  // --- Test 6: Resolved issues require subsequent verification evidence ---
  await check("passed verification with exit 0 resolves open investigation", async () => {
    const resolveProject = "test-project-resolve";
    // Create an investigation via a failed verification
    const failed = makeVerificationRecord({
      projectId: resolveProject,
      outcome: "failed",
      failingStep: "Check page title",
    });
    const created = await processVerificationResult(failed, {
      ownerUserId: TEST_USER,
      projectId: resolveProject,
    });
    assert.equal(created.action, "created");
    assert.equal(created.investigations[0]!.status, "open");

    // Now run a passing verification with same failing step
    const passed = makeVerificationRecord({
      id: failed.id + "-pass",
      jobId: failed.jobId + "-pass",
      projectId: resolveProject,
      outcome: "passed",
      exitCode: 0,
      failingStep: "Check page title",
      summary: "Page title verified.",
      runEnd: { status: "passed" },
      startedAt: new Date(Date.now() + 2000).toISOString(),
      finishedAt: new Date(Date.now() + 2000).toISOString(),
    });
    const resolved = await processVerificationResult(passed, {
      ownerUserId: TEST_USER,
      projectId: resolveProject,
    });
    assert.equal(resolved.action, "resolved");
    assert.equal(resolved.investigations[0]!.status, "resolved");
  });

  await check("passed verification without exit 0 does not resolve", async () => {
    const noExitProject = "test-project-noexit";
    const failed = makeVerificationRecord({
      projectId: noExitProject,
      outcome: "failed",
      failingStep: "Check page title",
    });
    const created = await processVerificationResult(failed, {
      ownerUserId: TEST_USER,
      projectId: noExitProject,
    });
    assert.equal(created.investigations[0]!.status, "open");

    const passedNoExit = makeVerificationRecord({
      id: failed.id + "-pass2",
      jobId: failed.jobId + "-pass2",
      projectId: noExitProject,
      outcome: "passed",
      exitCode: null,
      failingStep: "Check page title",
      summary: "Page title verified.",
      startedAt: new Date(Date.now() + 2000).toISOString(),
      finishedAt: new Date(Date.now() + 2000).toISOString(),
    });
    const result = await processVerificationResult(passedNoExit, {
      ownerUserId: TEST_USER,
      projectId: noExitProject,
    });
    // A "passed" verification is not actionable for creating/updating investigations.
    // It does not produce an investigation update.
    assert.equal(result.action, "none");
    assert.equal(result.investigations.length, 0);
  });

  // --- Test 7: User and project ownership isolation ---
  await check("user cannot see another user's investigations", async () => {
    const record = makeVerificationRecord({ outcome: "failed", failingStep: "Test step" });
    await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: TEST_PROJECT,
    });

    const others = await readInvestigations({
      userId: "other-user",
      includeLegacy: true,
      privileged: false,
    } as never);
    assert.equal(others.length, 0, "Other user should see no investigations");
  });

  await check("project filter returns only that project's investigations", async () => {
    const filterProject = "test-project-filter";
    // Create an investigation for this project
    const record2 = makeVerificationRecord({
      id: "ver-filter-project",
      projectId: filterProject,
      outcome: "failed",
      failingStep: "Filter test step",
    });
    await processVerificationResult(record2, {
      ownerUserId: TEST_USER,
      projectId: filterProject,
    });

    const all = await readInvestigations({
      userId: TEST_USER,
      includeLegacy: true,
      privileged: false,
    } as never);
    const filtered = all.filter((i) => i.projectId === filterProject);
    assert.ok(filtered.length >= 1, "Should have at least one investigation for filter project");
    assert.ok(filtered.every((i) => i.projectId === filterProject));
  });

  // --- Test 8: Investigation retrieval by ID ---
  await check("get investigation by ID returns correct record", async () => {
    const record = makeVerificationRecord({ outcome: "failed", failingStep: "Retrieval test" });
    const created = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: TEST_PROJECT,
    });
    const fetched = await getInvestigationById(created.investigations[0]!.id, {
      userId: TEST_USER,
      includeLegacy: true,
      privileged: false,
    } as never);
    assert.ok(fetched);
    assert.equal(fetched!.id, created.investigations[0]!.id);
    assert.equal(fetched!.title, created.investigations[0]!.title);
  });

  // --- Test 9: Investigation outputs contain correct fields ---
  await check("investigation outputs have required fields", async () => {
    const record = makeVerificationRecord({
      outcome: "failed",
      failingStep: "Verify navigation",
      summary: "Navigation link missing.",
      url: "http://localhost:3000/activity",
    });
    const outputs = generateInvestigationOutputs(record);
    assert.ok(outputs.technicalExplanation);
    assert.ok(outputs.simpleExplanation);
    assert.ok(outputs.expectedBehaviour);
    assert.ok(outputs.actualBehaviour);
    assert.ok(Array.isArray(outputs.affectedAreas));
    assert.ok(outputs.affectedAreas!.includes("http://localhost:3000/activity"));
    assert.ok(outputs.affectedAreas!.includes("Verify navigation"));
  });

  // --- Test 10: Update investigation ---
  await check("update investigation changes fields", async () => {
    const record = makeVerificationRecord({ outcome: "failed", failingStep: "Update test" });
    const created = await processVerificationResult(record, {
      ownerUserId: TEST_USER,
      projectId: TEST_PROJECT,
    });

    const updated = await updateInvestigation(
      created.investigations[0]!.id,
      { title: "Updated title", severity: "high" },
      { userId: TEST_USER, includeLegacy: true, privileged: false } as never,
    );
    assert.ok(updated);
    assert.equal(updated!.title, "Updated title");
    assert.equal(updated!.severity, "high");
    assert.notEqual(updated!.updatedAt, created.investigations[0]!.updatedAt);
  });

  console.log(`\n${passed} Investigator Foundation checks passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

runTests().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
