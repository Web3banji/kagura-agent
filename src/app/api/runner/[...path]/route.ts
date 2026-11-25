import { NextResponse } from "next/server";
import { isRunnerAuthorized, runnerUnauthorized } from "@/lib/auth/runner";
import { claimNextJob, countPendingJobs, getJob, markRunnerSuccess, getRunnerHeartbeat, recordHeartbeat } from "@/lib/verification/jobs";
import { completeJobAtomically } from "@/lib/verification/completion";
import { AccessDeniedError } from "@/lib/auth/scope";
import type { RunnerReadiness, RunnerReadinessState, VerificationJobResult, VerificationOutcome, VerificationRecord } from "@/types/verification";

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
    const body = (await req.json().catch(() => ({}))) as { runnerId?: string; version?: string; currentJobId?: string; note?: string; readiness?: unknown };
    const readinessBody = body.readiness && typeof body.readiness === "object" ? (body.readiness as Record<string, unknown>) : undefined;
    const readinessState = typeof readinessBody?.state === "string" ? (readinessBody.state as RunnerReadinessState) : undefined;
    const readiness: RunnerReadiness | undefined = readinessState
      ? {
          state: readinessState,
          ready: readinessBody?.ready === true,
          checkedAt: typeof readinessBody?.checkedAt === "string" ? readinessBody.checkedAt : undefined,
          reason: typeof readinessBody?.reason === "string" ? readinessBody.reason.slice(0, 240) : undefined,
        }
      : undefined;
    const hb = await recordHeartbeat({
      runnerId: typeof body.runnerId === "string" ? body.runnerId : undefined,
      version: typeof body.version === "string" ? body.version : undefined,
      currentJobId: typeof body.currentJobId === "string" ? body.currentJobId : undefined,
      note: typeof body.note === "string" ? body.note.slice(0, 300) : undefined,
      readiness,
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
    const statedRunnerId = typeof body.runnerId === "string" ? body.runnerId.trim() : "";
    if (!statedRunnerId) {
      return NextResponse.json({ error: "runnerId is required" }, { status: 400 });
    }
    if (!job.claimedBy || job.claimedBy !== statedRunnerId) {
      return NextResponse.json({ error: "Job is not claimed by this runner" }, { status: 403 });
    }
    if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() < Date.now()) {
      return NextResponse.json({ error: "Job claim lease has expired" }, { status: 409 });
    }
    const owner = job.requestedBy?.trim() || "";
    if (!owner) {
      return NextResponse.json({ error: "Job owner is missing; refusing to complete" }, { status: 409 });
    }
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
    if (typeof body.projectId === "string" && body.projectId && job.projectId && body.projectId !== job.projectId) {
      return NextResponse.json({ error: "Job project mismatch" }, { status: 403 });
    }
    if (typeof body.requestedBy === "string" && body.requestedBy && body.requestedBy !== owner) {
      return NextResponse.json({ error: "Job owner mismatch" }, { status: 403 });
    }
    if (typeof body.ownerUserId === "string" && body.ownerUserId && body.ownerUserId !== owner) {
      return NextResponse.json({ error: "Job owner mismatch" }, { status: 403 });
    }
    const recordId = (typeof body.recordId === "string" && body.recordId) || job.recordId || job.id;
    if (job.recordId && recordId !== job.recordId) {
      return NextResponse.json({ error: "Job record mismatch" }, { status: 403 });
    }
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
    const claimGeneration = job.claimGeneration ?? 0;
    const freshBeforePersist = await getJob(job.id);
    if (!freshBeforePersist || freshBeforePersist.claimedBy !== statedRunnerId || !["claimed", "running"].includes(freshBeforePersist.status)) {
      return NextResponse.json({ error: "Job claim/status changed before persistence" }, { status: 409 });
    }
    if ((freshBeforePersist.claimGeneration ?? 0) !== claimGeneration) {
      return NextResponse.json({ error: "Job claim generation changed before persistence" }, { status: 409 });
    }
    if (freshBeforePersist.leaseExpiresAt && new Date(freshBeforePersist.leaseExpiresAt).getTime() < Date.now()) {
      return NextResponse.json({ error: "Job claim lease has expired" }, { status: 409 });
    }
    const jobStatus = terminalJobStatus(outcome);
    let completion;
    try {
      completion = await completeJobAtomically({
        job: { ...job, claimGeneration },
        runnerId: statedRunnerId,
        record,
        result,
        outcome,
        jobStatus,
        finishedAt,
      });
    } catch (e) {
      if (e instanceof AccessDeniedError) {
        const msg = e.message || "Forbidden";
        const conflict = /changed|mismatch|reservation|expired|generation/i.test(msg);
        return NextResponse.json({ error: msg }, { status: conflict ? 409 : 403 });
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (/not in a completable state|lease has expired|claim\/status changed|not found/i.test(msg)) {
        return NextResponse.json({ error: msg }, { status: 409 });
      }
      throw e;
    }
    const updated = completion.job;
    const persisted = completion.record;
    let investigationIds: string[] = persisted.investigationIds ?? [];
    let investigationState: "pending" | "processing" | "processed" | "failed" = persisted.investigationProcessing?.state ?? (outcome !== "pending" && outcome !== "running" ? "pending" : "processed");
    if (outcome !== "pending" && outcome !== "running") {
      try {
        const { drainVerificationProcessingOutbox } = await import("@/lib/verification/outbox-worker");
        const drain = await drainVerificationProcessingOutbox({ jobId: job.id, claimGeneration: job.claimGeneration ?? 0, limit: 1, workerId: `runner-complete:${statedRunnerId}` });
        investigationIds = drain.investigationIds ?? investigationIds;
        investigationState = drain.state ?? investigationState;
      } catch {
        investigationState = persisted.investigationProcessing?.state ?? "pending";
      }
    }
    if (outcome === "passed") {
      try { await markRunnerSuccess(finishedAt); } catch { /* heartbeat persistence is best-effort; completion already persisted */ }
    }
    return NextResponse.json({ ok: true, job: updated, record: { ...persisted, investigationIds, investigationProcessing: { ...(persisted.investigationProcessing || {}), state: investigationState } }, investigationProcessed: investigationState === "processed" });
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

async function handleProcessingDrain(req: Request) {
  if (!isRunnerAuthorized(req)) return runnerUnauthorized();
  try {
    const body = await req.json().catch(() => ({}));
    const workerId = typeof body.workerId === "string" && body.workerId.trim() ? body.workerId.trim() : undefined;
    const jobId = typeof body.jobId === "string" && body.jobId.trim() ? body.jobId.trim() : undefined;
    const claimGeneration = typeof body.claimGeneration === "number" && Number.isFinite(body.claimGeneration) ? body.claimGeneration : undefined;
    const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? body.limit : 5;
    const { drainVerificationProcessingOutbox } = await import("@/lib/verification/outbox-worker");
    const result = await drainVerificationProcessingOutbox({ workerId, jobId, claimGeneration, limit });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "claim") return handleClaim(req);
  if (path === "complete") return handleComplete(req);
  if (path === "heartbeat") return handleHeartbeatPost(req);
  if (path === "processing/drain") return handleProcessingDrain(req);
  return notFound();
}