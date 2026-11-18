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
    return NextResponse.json({ error: "Rejection is not available for this account." }, { status: 403 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const story = await getStoryById(body.id, scope);
    if (!story) return NextResponse.json({ error: "Story not found" }, { status: 404 });
    const updated = {
      ...story,
      status: "rejected" as const,
      rejectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await upsertStory(updated, scope);
    return NextResponse.json({ story: updated });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
