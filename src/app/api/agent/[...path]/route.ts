import { NextResponse } from "next/server";
import { getStoryById, upsertStory } from "@/lib/stories/store";
import { readRuns, updateRun } from "@/lib/agent/runs";
import { setPipelineState } from "@/lib/pipeline";
import { runPipeline } from "@/lib/agent/pipeline";
import { getActiveRun } from "@/lib/agent/runs";
import { getCurrentPipelineState } from "@/lib/pipeline";
import { getObservationStatus } from "@/lib/github/observe";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/auth/guards";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handleApprove(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.includeLegacy && !scope.userId) {
    return NextResponse.json({ error: "Legacy workspace actions are not available for this account." }, { status: 403 });
  }
  try {
    const body = (await req.json()) as { id?: string };
    if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const story = await getStoryById(body.id, scope);
    if (!story) return NextResponse.json({ error: "Story not found" }, { status: 404 });
    if (story.status === "published") return NextResponse.json({ story });
    const now = new Date().toISOString();
    const published = { ...story, status: "published" as const, publishedAt: now, updatedAt: now };
    await upsertStory(published, scope);
    const runs = await readRuns(scope);
    const run = runs.find((r) => r.draftId === story.id);
    if (run) {
      await updateRun(run.id, { publishedStoryId: story.id, currentStage: "PUBLISH", stageUpdate: { stage: "PUBLISH", status: "completed", note: "Story published." } }, scope);
    }
    await setPipelineState({ stage: "PUBLISH", note: "Story published.", lastOutcome: "success" });
    return NextResponse.json({ story: published });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

async function handleRun(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.includeLegacy && !scope.userId) {
    return NextResponse.json({ error: "Legacy workspace actions are not available for this account." }, { status: 403 });
  }
  try {
    const active = await getActiveRun(scope);
    if (active) {
      return NextResponse.json({ error: "An agent run is already in progress.", run: active }, { status: 409 });
    }
    const result = await runPipeline("manual", { userId: principal.userId, scope });
    if (result.error && !result.run) {
      return NextResponse.json(result, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function handleStatus(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.includeLegacy && !scope.userId) {
    return NextResponse.json({ state: { agentState: "idle", stage: "OBSERVE", note: "No legacy workspace data is available for this account." }, runs: [], observation: { config: { owner: "", repo: "", configuredIn: "default" }, state: {}, eventsCount: 0, tokenConfigured: false, repo: "" } });
  }
  const [state, runs, obs] = await Promise.all([getCurrentPipelineState(), readRuns(scope), getObservationStatus({ privileged: !!scope.privileged })]);
  return NextResponse.json({ state, runs: runs.slice(0, 10), observation: obs });
}

function notFound() { return NextResponse.json({ error: "Not found" }, { status: 404 }); }

export async function GET(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "status") return handleStatus(req);
  return notFound();
}

export async function POST(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "approve") return handleApprove(req);
  if (path === "run") return handleRun(req);
  return notFound();
}