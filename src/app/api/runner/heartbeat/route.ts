import { NextResponse } from "next/server";
import { isRunnerAuthorized, runnerUnauthorized } from "@/lib/auth/runner";
import { countPendingJobs, getRunnerHeartbeat, recordHeartbeat } from "@/lib/verification/jobs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isRunnerAuthorized(req)) return runnerUnauthorized();
  try {
    const hb = await getRunnerHeartbeat();
    const pendingJobs = await countPendingJobs();
    return NextResponse.json({ ...hb, pendingJobs });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
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
