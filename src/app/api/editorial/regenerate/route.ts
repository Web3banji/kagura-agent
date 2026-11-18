import { NextResponse } from "next/server";
import { getStoryById, upsertStory } from "@/lib/stories/store";
import { generateDraft } from "@/lib/agent/write";
import { readVerificationRecords } from "@/lib/verification/store";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/auth/guards";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.includeLegacy && !scope.userId) {
    return NextResponse.json({ error: "Regeneration is not available for this account." }, { status: 403 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const story = await getStoryById(body.id, scope);
    if (!story) return NextResponse.json({ error: "Story not found" }, { status: 404 });
    if (story.status === "published") return NextResponse.json({ error: "Cannot regenerate a published story" }, { status: 400 });

    let verification = null as Awaited<ReturnType<typeof readVerificationRecords>>[number] | null;
    if (story.verification?.id) {
      const records = await readVerificationRecords({ requestedBy: scope.userId, includeLegacy: !!scope.includeLegacy });
      verification = records.find((r) => r.id === story.verification?.id) || null;
    }
    const draft = await generateDraft(
      {
        repo: story.source.repo,
        source: story.source.observationSource || "git-local",
        commits: story.source.commits.map((c) => ({ sha: c.sha, message: c.message, date: c.date, author: c.author, url: c.url })),
        changedFiles: story.source.changedFiles || [],
        summary: story.source.observationSummary,
      },
      { focus: story.tags.find((t) => !["development", "kane-cli"].includes(t)) || "general", reason: "Regenerated from existing real evidence." },
      verification,
      { userId: story.userId ?? principal.userId },
    );
    const updated = {
      ...draft,
      id: story.id,
      slug: story.slug,
      userId: story.userId,
      createdAt: story.createdAt,
      updatedAt: new Date().toISOString(),
      status: "review" as const,
    };
    await upsertStory(updated, scope);
    return NextResponse.json({ story: updated });
  } catch (err) {
    return apiErrorResponse(err);
  }
}