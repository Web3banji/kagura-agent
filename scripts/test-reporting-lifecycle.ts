process.loadEnvFile(".env.local");
delete process.env.DATABASE_URL;

import assert from "node:assert/strict";
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const VER_DIR = path.join(DATA_DIR, "verification");
const STORIES_DIR = path.join(DATA_DIR, "stories");
const INVESTIGATIONS_DIR = path.join(DATA_DIR, "investigations");

async function reset() {
  await Promise.all([
    fs.rm(VER_DIR, { recursive: true, force: true }),
    fs.rm(STORIES_DIR, { recursive: true, force: true }),
    fs.rm(INVESTIGATIONS_DIR, { recursive: true, force: true }),
  ]);
  await Promise.all([
    fs.mkdir(VER_DIR, { recursive: true }),
    fs.mkdir(STORIES_DIR, { recursive: true }),
    fs.mkdir(INVESTIGATIONS_DIR, { recursive: true }),
  ]);
}

let passed = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  passed++;
  console.log(`PASS ${name}`);
}

function rec(over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `ver-${Math.random().toString(36).slice(2)}`,
    flow: "shell-nav",
    objective: "Verify",
    url: "http://localhost:3000",
    outcome: "passed",
    exitCode: 0,
    summary: "passed",
    startedAt: now,
    finishedAt: now,
    source: "runner",
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    projectId: "p1",
    requestedBy: "u1",
    ...over,
  } as any;
}

function inv(over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `inv-${Math.random().toString(36).slice(2)}`,
    ownerUserId: "u1",
    projectId: "p1",
    title: "Broken navigation",
    category: "navigation-failure",
    technicalExplanation: "Technical detail",
    simpleExplanation: "Simple detail",
    rootCause: null,
    affectedAreas: ["navigation"],
    expectedBehaviour: "Page opens",
    actualBehaviour: "Page fails",
    severity: "high",
    status: "open",
    firstDetectedAt: now,
    lastDetectedAt: now,
    verificationReferences: [],
    evidenceReferences: null,
    aiFixPrompt: "Fix the navigation link target.",
    createdAt: now,
    updatedAt: now,
    ...over,
  } as any;
}

async function main() {
  const { __unsafeWriteStoriesForTests, getStoryById } = await import("@/lib/stories/store");
  const { __unsafeWriteInvestigationsForTests } = await import("@/lib/investigations/store");
  const { __unsafeWriteVerificationRecordsForTests } = await import("@/lib/verification/store");
  const { ensureVerificationReport, resolveReportPrompts, verificationReportId } = await import("@/lib/reports/store");
  const { backfillVerificationReports } = await import("@/lib/reports/backfill");
  const { resolveGeminiConfig, aiConfigured, generateGeminiVerificationReport } = await import("@/lib/ai/provider");

  await reset();

  const passedRec = rec({ outcome: "passed", summary: "ok" });
  const passedStory = await ensureVerificationReport(passedRec);
  check("passed verification creates report", !!passedStory && passedStory.verification?.outcome === "passed");
  check("report retains project and owner", passedStory?.projectId === "p1" && passedStory?.userId === "u1");
  check("report retains verification and job ids", passedStory?.verification?.id === passedRec.id && passedStory?.verification?.summary === "ok");

  const pendingRec = rec({ id: "pending-1", outcome: "pending", finishedAt: undefined });
  const runningRec = rec({ id: "running-1", outcome: "running", finishedAt: undefined });
  check("pending verification creates no report", (await ensureVerificationReport(pendingRec)) === null);
  check("running verification creates no report", (await ensureVerificationReport(runningRec)) === null);
  check("pending report is absent", !(await getStoryById(verificationReportId(pendingRec), { userId: "u1", privileged: false, includeLegacy: false })));
  check("running report is absent", !(await getStoryById(verificationReportId(runningRec), { userId: "u1", privileged: false, includeLegacy: false })));

  const ownerlessRec = rec({ id: "ownerless-terminal", requestedBy: "" });
  let ownerlessError = "";
  try { await ensureVerificationReport(ownerlessRec); } catch (error) { ownerlessError = error instanceof Error ? error.message : String(error); }
  check("terminal record without owner fails observably", ownerlessError.includes("owner is missing"));
  check("terminal record without owner creates no report", !(await getStoryById(verificationReportId(ownerlessRec), { privileged: true })));

  const failedRec = rec({ id: "failed-1", outcome: "failed", exitCode: 1, summary: "failed", failingStep: "Click nav" });
  const issue = inv({ verificationReferences: [{ verificationId: failedRec.id, jobId: failedRec.jobId, outcome: "failed", detectedAt: new Date().toISOString(), failingStep: "Click nav" }] });
  await __unsafeWriteInvestigationsForTests([issue]);
  const failedStory = await ensureVerificationReport(failedRec);
  check("failed verification creates report", failedStory?.verification?.outcome === "failed");
  check("failed report stores issue snapshot", failedStory?.verification?.issues?.[0]?.title === "Broken navigation");
  check("failed report stores issue-specific prompt", failedStory?.verification?.issues?.[0]?.aiFixPrompt === "Fix the navigation link target.");
  check("snapshot prompts work without live record", resolveReportPrompts(failedStory!, [], null)[0]?.prompt === "Fix the navigation link target.");

  for (const outcome of ["blocked", "timeout", "did_not_start"] as const) {
    const record = rec({ id: `${outcome}-1`, outcome, exitCode: null, summary: outcome });
    const story = await ensureVerificationReport(record);
    const expectedText = outcome === "did_not_start" ? "could not run" : outcome.replace(/_/g, " ");
    check(`${outcome} verification is represented`, story?.verification?.outcome === outcome && story?.body.includes(expectedText));
  }

  const duplicate = await ensureVerificationReport(passedRec);
  const allStories = await (await import("@/lib/stories/store")).readStories({ userId: "u1", privileged: false, includeLegacy: false });
  check("repeated upsert does not duplicate report", allStories.filter((s) => s.id === verificationReportId(passedRec)).length === 1);
  check("repeated upsert returns same report", duplicate?.id === passedStory?.id);

  const aiStory = { ...failedStory!, aiReport: { provider: "gemini", model: "test-model", generatedAt: new Date().toISOString(), body: "AI body" } };
  await __unsafeWriteStoriesForTests([aiStory]);
  const refreshed = await ensureVerificationReport(failedRec);
  check("refresh preserves AI report", refreshed?.aiReport?.body === "AI body");

  const secondRec = rec({ id: "second-1", outcome: "passed" });
  const secondStory = await ensureVerificationReport(secondRec);
  check("new verification creates separate report", secondStory?.id !== passedStory?.id && secondStory?.verification?.id === secondRec.id);

  const fallbackStory = { ...passedStory!, verification: { ...passedStory!.verification!, issues: [] } };
  const fallbackPrompts = resolveReportPrompts(fallbackStory, [issue], failedRec);
  check("fallback uses linked investigation prompt", fallbackPrompts[0]?.prompt === "Fix the navigation link target.");

  const crossOwner = inv({ id: "cross-owner", ownerUserId: "u2", verificationReferences: [{ verificationId: failedRec.id, outcome: "failed", detectedAt: new Date().toISOString() }] });
  const crossProject = inv({ id: "cross-project", projectId: "p2", verificationReferences: [{ verificationId: failedRec.id, outcome: "failed", detectedAt: new Date().toISOString() }] });
  const noLeak = resolveReportPrompts(fallbackStory, [crossOwner, crossProject], failedRec);
  check("fallback does not leak cross-owner prompts", noLeak.length === 0);

  await reset();
  const { enqueueJob, claimNextJob } = await import("@/lib/verification/jobs");
  const { completeJobAtomically } = await import("@/lib/verification/completion");
  const { drainVerificationProcessingOutbox } = await import("@/lib/verification/outbox-worker");
  const { readOutboxItems, __unsafeWriteOutboxForTests } = await import("@/lib/verification/outbox");
  const job = await enqueueJob({ flow: "shell-nav", objective: "obj", url: "http://localhost:3000", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
  const claimed = await claimNextJob({ runnerId: "runner-1", leaseMs: 60_000 });
  assert.ok(claimed);
  const failedRecord = rec({ id: "outbox-report-1", jobId: job.id, outcome: "failed", summary: "fail" });
  await __unsafeWriteStoriesForTests([{ ...failedStory!, id: verificationReportId(failedRecord), userId: "u2", projectId: "p1" }]);
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  let completion: any;
  try {
    completion = await completeJobAtomically({ job: claimed, runnerId: "runner-1", record: failedRecord, result: { outcome: "failed", summary: "fail" }, outcome: "failed", jobStatus: "failed", finishedAt: failedRecord.finishedAt! });
  } finally {
    console.error = originalError;
  }
  check("report failure is returned", completion.report?.created === false && !!completion.report?.error);
  check("report failure is logged", logs.some((line) => line.includes("verification_report_create_failed") && line.includes(job.id)));

  await __unsafeWriteStoriesForTests([]);
  const drained = await drainVerificationProcessingOutbox({ jobId: job.id, claimGeneration: claimed.claimGeneration, limit: 5, workerId: "w1" });
  const recovered = await getStoryById(verificationReportId(failedRecord), { userId: "u1", privileged: false, includeLegacy: false });
  check("retry creates missing report", !!recovered && drained.failed === 0);
  await drainVerificationProcessingOutbox({ jobId: job.id, claimGeneration: claimed.claimGeneration, limit: 5, workerId: "w2" });
  const afterRetry = await (await import("@/lib/stories/store")).readStories({ userId: "u1", privileged: false, includeLegacy: false });
  check("repeated retry does not duplicate report", afterRetry.filter((s) => s.id === verificationReportId(failedRecord)).length === 1);

  await reset();
  const invalidJob = await enqueueJob({ flow: "shell-nav", objective: "obj", url: "http://localhost:3000", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
  const invalidClaimed = await claimNextJob({ runnerId: "runner-1", leaseMs: 60_000 });
  assert.ok(invalidClaimed);
  const invalidRecord = rec({ id: "invalid-report-1", jobId: invalidJob.id, outcome: "failed", summary: "fail" });
  await __unsafeWriteStoriesForTests([{ ...failedStory!, id: verificationReportId(invalidRecord), userId: "u2", projectId: "p1" }]);
  const now = new Date().toISOString();
  await __unsafeWriteOutboxForTests([{
    id: `${invalidJob.id}:${invalidClaimed.claimGeneration}:process_verification_result`,
    jobId: invalidJob.id,
    recordId: invalidRecord.id,
    ownerUserId: "u1",
    projectId: "p1",
    claimGeneration: invalidClaimed.claimGeneration ?? 0,
    operation: "process_verification_result",
    status: "pending",
    attemptCount: 0,
    maxAttempts: 1,
    lastError: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
    processedAt: null,
  }]);
  const deadDrain = await drainVerificationProcessingOutbox({ jobId: invalidJob.id, claimGeneration: invalidClaimed.claimGeneration, limit: 1, workerId: "w-dead" });
  const deadItems = await readOutboxItems();
  check("invalid report reaches explicit dead state", deadDrain.failed === 1 && deadItems.some((item) => item.jobId === invalidJob.id && item.status === "dead"));

  await reset();
  const backfillRecords = [
    rec({ id: "backfill-pass", outcome: "passed" }),
    rec({ id: "backfill-fail", outcome: "failed", summary: "fail" }),
    rec({ id: "backfill-pending", outcome: "pending", finishedAt: undefined }),
    rec({ id: "backfill-ownerless", outcome: "passed", requestedBy: "" }),
  ];
  await __unsafeWriteVerificationRecordsForTests(backfillRecords);
  const dry = await backfillVerificationReports({ apply: false });
  const dryStories = await (await import("@/lib/stories/store")).readStories({ privileged: true });
  check("backfill dry-run performs no writes", dry.dryRun && dry.eligible === 2 && dry.wouldCreate === 2 && dry.created === 0 && dry.invalid === 1 && dry.skipped === 1 && dryStories.length === 0);
  check("backfill dry-run does not claim creations", dry.records.every((record) => record.status !== "created"));
  const applied = await backfillVerificationReports({ apply: true });
  const appliedStories = await (await import("@/lib/stories/store")).readStories({ privileged: true });
  check("backfill apply creates missing reports", applied.created === 2 && applied.failed === 1 && applied.wouldCreate === 0 && appliedStories.length === 2);
  const repeated = await backfillVerificationReports({ apply: true });
  const repeatedStories = await (await import("@/lib/stories/store")).readStories({ privileged: true });
  check("repeated backfill preserves reports", repeated.created === 0 && repeated.existing === 2 && repeated.failed === 1 && repeatedStories.length === 2);

  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_API_KEY: process.env.AI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    AI_MODEL: process.env.AI_MODEL,
  };
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.AI_PROVIDER;
  delete process.env.AI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.AI_MODEL;
  const missing = resolveGeminiConfig();
  check("missing Gemini credential is not configured", !missing.configured && missing.keySource === null);
  let configError = "";
  try { await generateGeminiVerificationReport({ record: passedRec, investigations: [] }); } catch (error) { configError = error instanceof Error ? error.message : String(error); }
  check("missing Gemini credential is actionable", configError.includes("GEMINI_API_KEY") && configError.includes("AI_API_KEY"));
  process.env.GEMINI_API_KEY = "test-key-not-used";
  const configured = resolveGeminiConfig();
  check("GEMINI_API_KEY resolves Gemini", configured.configured && configured.keySource === "GEMINI_API_KEY");
  process.env.GEMINI_MODEL = "custom-model";
  check("model override is deterministic", resolveGeminiConfig().model === "custom-model");
  delete process.env.GEMINI_API_KEY;
  process.env.AI_PROVIDER = "gemini";
  process.env.AI_API_KEY = "test-key-not-used";
  check("AI_PROVIDER=gemini with AI_API_KEY resolves", resolveGeminiConfig().keySource === "AI_API_KEY" && aiConfigured().provider === "gemini");
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  console.log(`\n${passed} reporting checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});