import { NextResponse } from "next/server";
import { isRunnerAuthorized, runnerUnauthorized } from "@/lib/auth/runner";
import { claimNextJob, countPendingJobs } from "@/lib/verification/jobs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
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
