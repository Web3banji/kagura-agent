import { NextResponse } from "next/server";
import { getStoryById, upsertStory } from "@/lib/stories/store";
import { readRuns, updateRun } from "@/lib/agent/runs";
import { setPipelineState } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const story = await getStoryById(body.id);
    if (!story) return NextResponse.json({ error: "Story not found" }, { status: 404 });
    if (story.status === "published") return NextResponse.json({ story });
    const now = new Date().toISOString();
    const published = { ...story, status: "published" as const, publishedAt: now, updatedAt: now };
    await upsertStory(published);
    const runs = await readRuns();
    const run = runs.find((r) => r.draftId === story.id);
    if (run) {
      await updateRun(run.id, {
        publishedStoryId: story.id,
        currentStage: "PUBLISH",
        stageUpdate: { stage: "PUBLISH", status: "completed", note: "Story published." },
      });
    }
    await setPipelineState({ stage: "PUBLISH", note: "Story published.", lastOutcome: "success", agentState: "completed" });
    return NextResponse.json({ story: published });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
