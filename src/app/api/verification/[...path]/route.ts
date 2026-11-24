import { NextResponse } from "next/server";
import { normalizeJobInput } from "@/lib/kane/security";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { enqueueJob, getJob, readJobs } from "@/lib/verification/jobs";
import { resolveProjectId, resolveProjectIdsForUser } from "@/lib/verification/context";
import { appendVerificationRecord } from "@/lib/verification/store";
import type { VerificationRecord } from "@/types/verification";

export const dynamic = "force-dynamic";

const FLOW_OBJECTIVE =
  'Go to the provided URL. Verify the page shows "KAGURA" and "Home & status". Click the "Activity history" link in the sidebar navigation and verify the Activity history page is displayed. Click the "Checks & tests" link in the sidebar navigation and verify the Checks & tests page is displayed. Click the "Published stories" link in the sidebar navigation and verify the Stories page is displayed. Return to "Home & status" and verify it is displayed.';

async function handleJobs(req: Request) {
  const principal = (await getRequestPrincipal(req));
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.privileged && !scope.userId && !scope.includeLegacy) {
    return NextResponse.json({ error: "Verification jobs are not available for this account." }, { status: 403 });
  }
  const requestedBy = scope.privileged ? undefined : principal.userId;
  const includeLegacy = !!scope.includeLegacy;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const requestedProjectId = searchParams.get("projectId");
  let projectId: string | undefined = scope.privileged ? (requestedProjectId || undefined) : await resolveProjectId();
  if (!scope.privileged && requestedProjectId && principal.userId) {
    const visible = await resolveProjectIdsForUser(principal.userId);
    if (!visible.includes(requestedProjectId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    projectId = requestedProjectId;
  }
  if (id) {
    const job = await getJob(id, { projectId, requestedBy, includeLegacy });
    if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ job });
  }
  const jobs = await readJobs({ projectId, requestedBy, includeLegacy });
  return NextResponse.json({ jobs });
}

async function handleJobsPost(req: Request) {
  try {
    const principal = (await getRequestPrincipal(req));
    if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
    const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
    if (!scope.privileged && !scope.userId && !scope.includeLegacy) {
      return NextResponse.json({ error: "Verification jobs are not available for this account." }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const requestedProjectId = typeof body.projectId === "string" ? body.projectId : undefined;
    let projectId: string | undefined;
    if (scope.privileged) {
      projectId = requestedProjectId;
    } else if (principal.userId) {
      const visible = await resolveProjectIdsForUser(principal.userId);
      if (!requestedProjectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
      if (!visible.includes(requestedProjectId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
      projectId = requestedProjectId;
    } else {
      return NextResponse.json({ error: "Verification jobs are not available for this account." }, { status: 403 });
    }
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

async function handleRun(req: Request) {
  try {
    const principal = (await getRequestPrincipal(req));
    if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
    const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
    if (!scope.privileged && !scope.userId && !scope.includeLegacy) {
      return NextResponse.json({ error: "Verification runs are not available for this account." }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as { flow?: string; url?: string; objective?: string; projectId?: string };
    const flow = typeof body.flow === "string" && body.flow ? body.flow : "shell-nav";
    const objective = typeof body.objective === "string" && body.objective.trim() ? body.objective.trim() : FLOW_OBJECTIVE;
    const url =
      (typeof body.url === "string" && body.url.trim()) ||
      process.env.KAGURA_APP_URL ||
      process.env.ECHOLOG_APP_URL ||
      "http://localhost:3000";
    let projectId: string | undefined;
    if (scope.privileged) {
      projectId = body.projectId;
    } else if (principal.userId) {
      const visible = await resolveProjectIdsForUser(principal.userId);
      if (!body.projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
      if (!visible.includes(body.projectId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
      projectId = body.projectId;
    } else {
      return NextResponse.json({ error: "Verification runs are not available for this account." }, { status: 403 });
    }
    const now = new Date().toISOString();
    const job = await enqueueJob({
      flow,
      objective,
      url,
      projectId,
      requestedBy: principal.userId,
      headless: true,
      timeout: 180,
      reason: "dashboard",
    });
    const record: VerificationRecord = {
      id: job.id,
      flow,
      objective,
      url,
      outcome: "pending",
      summary: "Verification job queued. Awaiting shared runner execution.",
      startedAt: now,
      source: "runner",
      jobId: job.id,
      projectId,
      requestedBy: principal.userId,
      notes: "Queued on server; Kane CLI runs only on the local authenticated runner.",
    };
    await appendVerificationRecord(record);
    return NextResponse.json({ ok: true, status: "pending", jobId: job.id, job, record });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "jobs") return handleJobs(req);
  return notFound();
}

export async function POST(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "jobs") return handleJobsPost(req);
  if (path === "run") return handleRun(req);
  return notFound();
}
