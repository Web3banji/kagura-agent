import { NextResponse } from "next/server";
import { getStoryById, upsertStory } from "@/lib/stories/store";
import { readRuns, updateRun } from "@/lib/agent/runs";
import { setPipelineState } from "@/lib/pipeline";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/auth/guards";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.includeLegacy && !scope.userId) {
    return NextResponse.json({ error: "Publishing is not available for this account." }, { status: 403 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
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
      await updateRun(run.id, {
        publishedStoryId: story.id,
        currentStage: "PUBLISH",
        stageUpdate: { stage: "PUBLISH", status: "completed", note: "Story published." },
      }, scope);
    }
    await setPipelineState({ stage: "PUBLISH", note: "Story published.", lastOutcome: "success", agentState: "completed" });
    return NextResponse.json({ story: published });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
