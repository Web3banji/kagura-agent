import { NextResponse } from "next/server";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { getStoryById, upsertStory } from "@/lib/stories/store";
import { getVerificationRecord } from "@/lib/verification/store";
import { readInvestigations } from "@/lib/investigations/store";
import { generateGeminiVerificationReport } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";

async function handleGenerateAi(req: Request) {
  try {
    const principal = await getRequestPrincipal(req);
    if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
    const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
    const body = (await req.json().catch(() => ({}))) as { reportId?: string };
    const reportId = typeof body.reportId === "string" ? body.reportId.trim() : "";
    if (!reportId) return NextResponse.json({ error: "reportId is required" }, { status: 400 });

    const story = await getStoryById(reportId, scope);
    if (!story) return NextResponse.json({ error: "Report not found" }, { status: 404 });
    if (!story.verification?.id) return NextResponse.json({ error: "This report has no verification run attached." }, { status: 400 });
    if (story.aiReport?.body) return NextResponse.json({ ok: true, aiReport: story.aiReport, idempotent: true });

    const record = await getVerificationRecord(story.verification.id, {
      requestedBy: scope.privileged ? undefined : principal.userId ?? undefined,
      includeLegacy: !!scope.includeLegacy,
    });
    if (!record) return NextResponse.json({ error: "Verification record not found" }, { status: 404 });

    const investigations = (await readInvestigations(scope).catch(() => [])).filter((inv) =>
      (inv.verificationReferences || []).some((ref) => ref.verificationId === record.id || (record.jobId && ref.jobId === record.jobId)),
    );
    const result = await generateGeminiVerificationReport({ record, investigations, projectName: story.projectId });
    const aiReport = { provider: result.provider, model: result.model, generatedAt: new Date().toISOString(), body: result.body };
    const updated = await upsertStory({ ...story, aiReport, updatedAt: new Date().toISOString() }, scope);
    return NextResponse.json({ ok: true, aiReport, report: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI report generation failed.";
    const safe = message.includes("Gemini") ? message : "AI report generation failed.";
    return NextResponse.json({ error: safe }, { status: 502 });
  }
}

export async function POST(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "generate-ai") return handleGenerateAi(req);
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}