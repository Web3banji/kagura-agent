import { NextResponse } from "next/server";
import { isRunnerAuthorized, runnerUnauthorized } from "@/lib/auth/runner";
import { claimNextJob, countPendingJobs, getJob, markRunnerSuccess, updateJob, getRunnerHeartbeat, recordHeartbeat } from "@/lib/verification/jobs";
import { upsertVerificationRecord } from "@/lib/verification/store";
import type { VerificationJobResult, VerificationOutcome, VerificationRecord } from "@/types/verification";
import { processVerificationResult } from "@/lib/investigations/processor";

export const dynamic = "force-dynamic";

function isValidOutcome(v: unknown): v is VerificationOutcome {
  return v === "pending" || v === "running" || v === "passed" || v === "failed" || v === "blocked" || v === "did_not_start" || v === "timeout";
}

function normalizeOutcome(exitCode: unknown, runEndStatus: unknown, provided: unknown): VerificationOutcome {
  const code = typeof exitCode === "number" ? exitCode : null;
  const status = typeof runEndStatus === "string" ? runEndStatus : undefined;
  if (code === 0 && status === "passed") return "passed";
  if (code === 1) return "failed";
  if (code === 2) return "did_not_start";
  if (code === 3) return "timeout";
  if (status === "failed") return "failed";
  if (isValidOutcome(provided) && provided !== "pending" && provided !== "running") return provided;
  return "blocked";
}

function terminalJobStatus(outcome: VerificationOutcome): "completed" | "failed" | "did_not_start" {
  if (outcome === "did_not_start") return "did_not_start";
  if (outcome === "passed" || outcome === "blocked" || outcome === "timeout") return outcome === "passed" ? "completed" : "failed";
  return "failed";
}

async function handleClaim(req: Request) {
  if (!isRunnerAuthorized(req)) return runnerUnauthorized();
  try {
    const body = (await req.json().catch(() => ({}))) as { runnerId?: string; version?: string };
    const runnerId = typeof body.runnerId === "string" && body.runnerId.trim() ? body.runnerId.trim() : "shared-runner";
    const job = await claimNextJob({ runnerId });
    if (!job) {
      return new NextResponse(null, { status: 204 });
    }
    const pendingJobs = await countPendingJobs(job.projectId);
    return NextResponse.json({ job, pendingJobs });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function handleHeartbeatGet(req: Request) {
  if (!isRunnerAuthorized(req)) return runnerUnauthorized();
  try {
    const hb = await getRunnerHeartbeat();
    const pendingJobs = await countPendingJobs();
    return NextResponse.json({ ...hb, pendingJobs });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function handleHeartbeatPost(req: Request) {
  if (!isRunnerAuthorized(req)) return runnerUnauthorized();
  try {
    const body = (await req.json().catch(() => ({}))) as { runnerId?: string; version?: string; currentJobId?: string; note?: string };
    const hb = await recordHeartbeat({
      runnerId: typeof body.runnerId === "string" ? body.runnerId : undefined,
      version: typeof body.version === "string" ? body.version : undefined,
      currentJobId: typeof body.currentJobId === "string" ? body.currentJobId : undefined,
      note: typeof body.note === "string" ? body.note.slice(0, 300) : undefined,
    });
    const pendingJobs = await countPendingJobs();
    return NextResponse.json({ ...hb, pendingJobs });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function handleComplete(req: Request) {
  if (!isRunnerAuthorized(req)) return runnerUnauthorized();
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.jobId !== "string" || !body.jobId.trim()) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const job = await getJob(body.jobId.trim());
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    const statedRunnerId = typeof body.runnerId === "string" && body.runnerId ? body.runnerId : "";
    const statedClaimedBy = typeof body.claimedBy === "string" && body.claimedBy ? body.claimedBy : "";
    const caller = statedRunnerId || statedClaimedBy;
    if (!job.claimedBy || !caller || job.claimedBy !== caller) {
      return NextResponse.json({ error: "Job is not claimed by this runner" }, { status: 403 });
    }
    if (statedRunnerId && job.claimedBy !== statedRunnerId) {
      return NextResponse.json({ error: "Job is not claimed by this runner" }, { status: 403 });
    }
    const owner = job.requestedBy || "";
    if (job.status !== "claimed" && job.status !== "running") {
      return NextResponse.json({ error: "Job is not in a completable state", status: job.status }, { status: 409 });
    }
    const runEnd = body.runEnd && typeof body.runEnd === "object" ? (body.runEnd as Record<string, unknown>) : undefined;
    const runEndStatus = runEnd?.status;
    const outcome = normalizeOutcome(body.exitCode, runEndStatus, body.outcome);
    const finishedAt = typeof body.finishedAt === "string" ? body.finishedAt : new Date().toISOString();
    const startedAt = typeof body.startedAt === "string" ? body.startedAt : job.startedAt || job.claimedAt || job.createdAt;
    const result: VerificationJobResult = {
      exitCode: typeof body.exitCode === "number" ? body.exitCode : undefined,
      outcome,
      summary: typeof body.summary === "string" ? body.summary : typeof runEnd?.summary === "string" ? String(runEnd.summary) : undefined,
      failingStep: typeof body.failingStep === "string" ? body.failingStep : undefined,
      durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
      creditsConsumed: typeof body.creditsConsumed === "number" ? body.creditsConsumed : undefined,
      evidencePath: typeof body.evidencePath === "string" ? body.evidencePath : undefined,
      testUrl: typeof body.testUrl === "string" ? body.testUrl : typeof runEnd?.test_url === "string" ? String(runEnd.test_url) : undefined,
      sessionDir: typeof body.sessionDir === "string" ? body.sessionDir : typeof runEnd?.session_dir === "string" ? String(runEnd.session_dir) : undefined,
      ndjsonPath: typeof body.ndjsonPath === "string" ? body.ndjsonPath : undefined,
      runEnd,
      stderr: typeof body.stderr === "string" ? body.stderr : undefined,
      startedAt,
      finishedAt,
    };
    const recordId = (typeof body.recordId === "string" && body.recordId) || job.recordId || job.id;
    const record: VerificationRecord = {
      id: recordId,
      flow: job.flow,
      objective: job.objective,
      command: typeof body.command === "string" ? body.command : undefined,
      url: job.url,
      outcome,
      exitCode: result.exitCode,
      summary: result.summary,
      failingStep: result.failingStep,
      durationMs: result.durationMs,
      creditsConsumed: result.creditsConsumed,
      evidencePath: result.evidencePath,
      testUrl: result.testUrl,
      sessionDir: result.sessionDir,
      ndjsonPath: result.ndjsonPath,
      runEnd: result.runEnd,
      stderr: result.stderr,
      startedAt,
      finishedAt,
      source: "runner",
      jobId: job.id,
      projectId: job.projectId,
      requestedBy: owner,
    };
    await upsertVerificationRecord(record, { expectOwner: owner });
    let investigationIds: string[] = [];
    let investigationState: "pending" | "processing" | "processed" | "failed" = "processed";
    if (outcome !== "pending" && outcome !== "running") {
      const existingProcessing = record.investigationProcessing?.state;
      if (existingProcessing === "processing" || existingProcessing === "processed") {
        investigationIds = record.investigationIds ?? [];
        investigationState = existingProcessing === "processed" ? "processed" : "processing";
      } else {
        await upsertVerificationRecord({ ...record, investigationProcessing: { state: "processing", processingStartedAt: new Date().toISOString() } }, { expectOwner: owner });
        try {
          const result = await processVerificationResult(record, { ownerUserId: owner || undefined, projectId: job.projectId || undefined, repositoryConnectionId: undefined });
          investigationIds = result.investigations.map((i) => i.id);
          await upsertVerificationRecord({ ...record, investigationIds, investigationProcessing: { state: "processed", processedAt: new Date().toISOString() } }, { expectOwner: owner });
        } catch {
          investigationState = "failed";
          await upsertVerificationRecord({ ...record, investigationIds, investigationProcessing: { state: "failed", processingStartedAt: record.investigationProcessing?.processingStartedAt, processedAt: new Date().toISOString(), error: "Investigator processing failed; see recovery endpoint." } }, { expectOwner: owner });
        }
      }
    }
    const jobStatus = terminalJobStatus(outcome);
    const updated = await updateJob(job.id, { status: jobStatus, completedAt: finishedAt, recordId, result, error: jobStatus === "failed" || jobStatus === "did_not_start" ? (result.summary || result.failingStep || outcome) : undefined, leaseExpiresAt: undefined });
    if (outcome === "passed") {
      await markRunnerSuccess(finishedAt);
    }
    return NextResponse.json({ ok: true, job: updated, record: { ...record, investigationIds, investigationProcessing: { state: investigationState, processedAt: new Date().toISOString() } }, investigationProcessed: outcome !== "pending" && outcome !== "running" });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

function notFound() { return NextResponse.json({ error: "Not found" }, { status: 404 }); }

export async function GET(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "heartbeat") return handleHeartbeatGet(req);
  return notFound();
}

export async function POST(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "claim") return handleClaim(req);
  if (path === "complete") return handleComplete(req);
  if (path === "heartbeat") return handleHeartbeatPost(req);
  return notFound();
}