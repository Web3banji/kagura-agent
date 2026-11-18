import { NextResponse } from "next/server";
import { isRunnerAuthorized, runnerUnauthorized } from "@/lib/auth/runner";
import { getJob, markRunnerSuccess, updateJob } from "@/lib/verification/jobs";
import { upsertVerificationRecord } from "@/lib/verification/store";
import type { VerificationJobResult, VerificationOutcome, VerificationRecord } from "@/types/verification";

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
  return "failed"; // failed
}

export async function POST(req: Request) {
  if (!isRunnerAuthorized(req)) return runnerUnauthorized();
  try {
    const body = (await req.json().catch(() => null)) as
      | {
          jobId?: string;
          runnerId?: string;
          claimedBy?: string;
          outcome?: unknown;
          exitCode?: unknown;
          summary?: unknown;
          failingStep?: unknown;
          durationMs?: unknown;
          creditsConsumed?: unknown;
          evidencePath?: unknown;
          testUrl?: unknown;
          sessionDir?: unknown;
          ndjsonPath?: unknown;
          runEnd?: unknown;
          stderr?: unknown;
          command?: unknown;
          startedAt?: unknown;
          finishedAt?: unknown;
          recordId?: unknown;
        }
      | null;
    if (!body || typeof body.jobId !== "string" || !body.jobId.trim()) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const job = await getJob(body.jobId.trim());
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const caller = (typeof body.runnerId === "string" && body.runnerId) || (typeof body.claimedBy === "string" && body.claimedBy) || "";
    if (!job.claimedBy || !caller || job.claimedBy !== caller) {
      return NextResponse.json({ error: "Job is not claimed by this runner" }, { status: 403 });
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
      requestedBy: job.requestedBy,
    };
    await upsertVerificationRecord(record);

    const jobStatus = terminalJobStatus(outcome);
    const updated = await updateJob(job.id, {
      status: jobStatus,
      completedAt: finishedAt,
      recordId,
      result,
      error: jobStatus === "failed" || jobStatus === "did_not_start" ? (result.summary || result.failingStep || outcome) : undefined,
      leaseExpiresAt: undefined,
    });

    if (outcome === "passed") {
      await markRunnerSuccess(finishedAt);
    }

    return NextResponse.json({ ok: true, job: updated, record });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
