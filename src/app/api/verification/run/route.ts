import { NextResponse } from "next/server";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { readGitHubConfig, repoSlug } from "@/lib/github/config";
import { enqueueJob } from "@/lib/verification/jobs";
import { appendVerificationRecord } from "@/lib/verification/store";
import type { VerificationRecord } from "@/types/verification";

export const dynamic = "force-dynamic";

const FLOW_OBJECTIVE =
  'Go to the provided URL. Verify the page shows "KAGURA" and "Home & status". Click the "Activity history" link in the sidebar navigation and verify the Activity history page is displayed. Click the "Checks & tests" link in the sidebar navigation and verify the Checks & tests page is displayed. Click the "Published stories" link in the sidebar navigation and verify the Stories page is displayed. Return to "Home & status" and verify it is displayed.';

async function resolveProjectId(): Promise<string> {
  try {
    const cfg = await readGitHubConfig();
    return repoSlug(cfg) || "default";
  } catch {
    return "default";
  }
}

export async function POST(req: Request) {
  try {
    const principal = getRequestPrincipal(req);
    if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");

    const body = (await req.json().catch(() => ({}))) as { flow?: string; url?: string; objective?: string };
    const flow = typeof body.flow === "string" && body.flow ? body.flow : "shell-nav";
    const objective = typeof body.objective === "string" && body.objective.trim() ? body.objective.trim() : FLOW_OBJECTIVE;
    const url =
      (typeof body.url === "string" && body.url.trim()) ||
      process.env.KAGURA_APP_URL ||
      process.env.ECHOLOG_APP_URL ||
      "http://localhost:3000";
    const projectId = await resolveProjectId();
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

    // Backward-compatible shape: include `record` (pending) plus explicit job info.
    return NextResponse.json({ ok: true, status: "pending", jobId: job.id, job, record });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
