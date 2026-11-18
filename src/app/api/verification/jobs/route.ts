import { NextResponse } from "next/server";
import { normalizeJobInput } from "@/lib/kane/security";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { enqueueJob, getJob, readJobs } from "@/lib/verification/jobs";
import { resolveProjectId } from "@/lib/verification/context";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const principal = (await getRequestPrincipal(req));
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  // Privileged (admin-token / local-dev) principals may inspect all jobs; ordinary users
  // only ever see jobs they requested themselves.
  const requestedBy = scope.privileged ? undefined : principal.userId;
  const includeLegacy = !!scope.includeLegacy;
  const projectId = await resolveProjectId();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (id) {
    const job = await getJob(id, { projectId, requestedBy, includeLegacy });
    if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ job });
  }
  const jobs = await readJobs({ projectId, requestedBy, includeLegacy });
  return NextResponse.json({ jobs });
}

export async function POST(req: Request) {
  try {
    const principal = (await getRequestPrincipal(req));
    if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
    const projectId = await resolveProjectId();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const normalized = normalizeJobInput(body, {
      defaultUrl: process.env.KAGURA_APP_URL || process.env.ECHOLOG_APP_URL || "http://localhost:3000",
    });
    const job = await enqueueJob({
      flow: normalized.flow,
      objective: normalized.objective,
      url: normalized.url,
      timeout: normalized.timeout,
      projectId,
      requestedBy: principal.userId,
      reason: "jobs-api",
    });
    return NextResponse.json({ job, status: "pending" });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
