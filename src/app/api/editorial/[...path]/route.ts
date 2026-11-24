import { NextResponse } from "next/server";
import { getStoryById, upsertStory } from "@/lib/stories/store";
import { readRuns, updateRun } from "@/lib/agent/runs";
import { setPipelineState } from "@/lib/pipeline";
import { generateDraft } from "@/lib/agent/write";
import { readVerificationRecords } from "@/lib/verification/store";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/auth/guards";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function handlePublish(req: Request) {
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

async function handleRegenerate(req: Request) {
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
        source: story.source.observationSource || "none",
        commits: story.source.commits.map((c) => ({ sha: c.sha, message: c.message, date: c.date, author: c.author, url: c.url })),
        changedFiles: story.source.changedFiles || [],
        summary: story.source.observationSummary,
      },
      { focus: story.tags.find((t) => !["development", "kane-cli"].includes(t)) || "general", reason: "Regenerated from existing real evidence." },
      verification,
      { userId: story.userId ?? principal.userId, projectId: story.projectId ?? verification?.projectId ?? null },
    );
    const updated = {
      ...draft,
      id: story.id,
      slug: story.slug,
      userId: story.userId,
      projectId: story.projectId ?? draft.projectId ?? null,
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

async function handleReject(req: Request) {
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

async function handleUpdate(req: Request) {
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

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "publish") return handlePublish(req);
  if (path === "regenerate") return handleRegenerate(req);
  if (path === "reject") return handleReject(req);
  if (path === "update") return handleUpdate(req);
  return notFound();
}
