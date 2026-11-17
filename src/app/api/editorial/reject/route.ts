import { NextResponse } from "next/server";
import { getStoryById, upsertStory } from "@/lib/stories/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const story = await getStoryById(body.id);
    if (!story) return NextResponse.json({ error: "Story not found" }, { status: 404 });
    const updated = {
      ...story,
      status: "rejected" as const,
      rejectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await upsertStory(updated);
    return NextResponse.json({ story: updated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
