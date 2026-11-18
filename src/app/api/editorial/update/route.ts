import { NextResponse } from "next/server";
import { getStoryById, upsertStory } from "@/lib/stories/store";
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
    return NextResponse.json({ error: "Editing is not available for this account." }, { status: 403 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string; title?: string; subtitle?: string; body?: string };
    if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const story = await getStoryById(body.id, scope);
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
    await upsertStory(updated, scope);
    return NextResponse.json({ story: updated });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
