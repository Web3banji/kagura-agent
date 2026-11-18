import { NextResponse } from "next/server";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { enqueueJob, getJob, readJobs } from "@/lib/verification/jobs";
import { resolveProjectId } from "@/lib/verification/context";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const principal = getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const projectId = await resolveProjectId();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (id) {
    const job = await getJob(id, { projectId, requestedBy: principal.userId });
    if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ job });
  }
  const jobs = await readJobs({ projectId, requestedBy: principal.userId });
  return NextResponse.json({ jobs });
}

export async function POST(req: Request) {
  try {
    const principal = getRequestPrincipal(req);
    if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
    const projectId = await resolveProjectId();
    const body = (await req.json().catch(() => ({}))) as { flow?: string; objective?: string; url?: string; timeout?: number };
    const flow = typeof body.flow === "string" && body.flow ? body.flow : "shell-nav";
    const objective = typeof body.objective === "string" && body.objective.trim() ? body.objective.trim() : "Shell navigation verification";
    const url =
      (typeof body.url === "string" && body.url.trim()) ||
      process.env.KAGURA_APP_URL ||
      process.env.ECHOLOG_APP_URL ||
      "http://localhost:3000";
    const job = await enqueueJob({
      flow,
      objective,
      url,
      timeout: typeof body.timeout === "number" ? body.timeout : undefined,
      projectId,
      requestedBy: principal.userId,
      reason: "jobs-api",
    });
    return NextResponse.json({ job, status: "pending" });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
