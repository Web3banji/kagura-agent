import { NextResponse } from "next/server";
import { getStoryById, upsertStory } from "@/lib/stories/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string; title?: string; subtitle?: string; body?: string };
    if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const story = await getStoryById(body.id);
    if (!story) return NextResponse.json({ error: "Story not found" }, { status: 404 });
    if (story.status === "published") return NextResponse.json({ error: "Published stories cannot be edited here" }, { status: 400 });
    const updated = {
      ...story,
      title: typeof body.title === "string" ? body.title.slice(0, 200) : story.title,
      subtitle: typeof body.subtitle === "string" ? body.subtitle.slice(0, 300) : story.subtitle,
      body: typeof body.body === "string" ? body.body : story.body,
      updatedAt: new Date().toISOString(),
      status: "review" as const,
    };
    await upsertStory(updated);
    return NextResponse.json({ story: updated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
