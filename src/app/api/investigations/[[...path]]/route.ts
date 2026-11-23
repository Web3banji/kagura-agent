import { NextResponse } from "next/server";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { readInvestigations } from "@/lib/investigations/store";
import type { InvestigationCategory, InvestigationStatus } from "@/types/investigation";
import { getVerificationRecord, upsertVerificationRecord } from "@/lib/verification/store";
import { processVerificationResult } from "@/lib/investigations/processor";
import { getInvestigationById, updateInvestigation, appendVerificationReference } from "@/lib/investigations/store";
import type { Investigation } from "@/types/investigation";

export const dynamic = "force-dynamic";

async function handleBaseGet(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const requestedBy = scope.privileged ? undefined : principal.userId;
  const includeLegacy = !!scope.includeLegacy;
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId") || undefined;
  const investigations = await readInvestigations(scope);
  const filtered = investigations.filter((inv) => {
    if (projectId && inv.projectId !== projectId) return false;
    return true;
  });
  return NextResponse.json({ investigations: filtered, scope: { requestedBy, includeLegacy, privileged: scope.privileged } });
}

async function handleBasePost(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.includeLegacy && !scope.userId) {
    return NextResponse.json({ error: "Creating investigations is not available for this account." }, { status: 403 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!body.title || !body.technicalExplanation || !body.simpleExplanation) {
      return NextResponse.json({ error: "title, technicalExplanation, and simpleExplanation are required" }, { status: 400 });
    }
    const { createInvestigation } = await import("@/lib/investigations/store");
    const investigation = await createInvestigation({
      ownerUserId: scope.userId ?? "",
      projectId: (body.projectId as string) ?? null,
      repositoryConnectionId: (body.repositoryConnectionId as string) ?? null,
      title: body.title as string,
      category: body.category as InvestigationCategory,
      technicalExplanation: body.technicalExplanation as string,
      simpleExplanation: body.simpleExplanation as string,
      rootCause: (body.rootCause as string) ?? null,
      affectedAreas: (body.affectedAreas as string[]) ?? null,
      expectedBehaviour: (body.expectedBehaviour as string) ?? null,
      actualBehaviour: (body.actualBehaviour as string) ?? null,
      severity: body.severity as "low" | "medium" | "high" | "critical",
      status: body.status as InvestigationStatus,
      verificationReferences: (body.verificationReferences ?? []) as never,
      evidenceReferences: (body.evidenceReferences as string[]) ?? null,
      aiFixPrompt: (body.aiFixPrompt as string) ?? null,
    });
    return NextResponse.json({ investigation }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create investigation" }, { status: 500 });
  }
}

async function handleReprocess(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const requestedBy = scope.privileged ? undefined : principal.userId;
  try {
    const body = (await req.json().catch(() => ({}))) as { verificationId?: string; jobId?: string };
    const verificationId =
      typeof body.verificationId === "string" && body.verificationId.trim()
        ? body.verificationId.trim()
        : typeof body.jobId === "string" && body.jobId.trim()
          ? body.jobId.trim()
          : undefined;
    if (!verificationId) {
      return NextResponse.json({ error: "verificationId or jobId is required" }, { status: 400 });
    }
    const record = await getVerificationRecord(verificationId, { projectId: undefined, requestedBy });
    if (!record) {
      return NextResponse.json({ error: "Verification record not found" }, { status: 404 });
    }
    if (!scope.privileged) {
      const owner = record.requestedBy ?? null;
      if (!owner || owner !== principal.userId) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }
    const existingState = record.investigationProcessing?.state;
    const processingStartedAt = record.investigationProcessing?.processingStartedAt;
    const STALE_PROCESSING_MS = Number(process.env.KAGURA_INVESTIGATOR_STALE_PROCESSING_MS || 300000);
    const isStaleProcessing =
      existingState === "processing" &&
      processingStartedAt &&
      Date.now() - new Date(processingStartedAt).getTime() > STALE_PROCESSING_MS;
    if (existingState === "processing" && !isStaleProcessing) {
      return NextResponse.json({ ok: true, message: "Verification processing is already in progress", investigationIds: record.investigationIds ?? [], record });
    }
    const alreadyProcessed = existingState === "processed" && record.investigationIds && record.investigationIds.length > 0;
    if (alreadyProcessed && !record.outcome?.startsWith("failed")) {
      return NextResponse.json({ ok: true, message: "Verification already processed", investigationIds: record.investigationIds, record });
    }
    await upsertVerificationRecord({ ...record, investigationProcessing: { state: "processing", processingStartedAt: isStaleProcessing ? new Date().toISOString() : processingStartedAt } }, { expectOwner: requestedBy });
    let result;
    try {
      result = await processVerificationResult(record, { ownerUserId: principal.userId, projectId: record.projectId || undefined, repositoryConnectionId: undefined });
    } catch (err) {
      await upsertVerificationRecord({ ...record, investigationProcessing: { state: "failed", processedAt: new Date().toISOString(), error: err instanceof Error ? err.message : "Investigator recovery processing failed" } }, { expectOwner: requestedBy });
      return NextResponse.json({ ok: false, error: "Investigator recovery processing failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
    const investigationIds = result.investigations.map((i) => i.id);
    const existingIds = record.investigationIds ?? [];
    const mergedIds = [...existingIds, ...investigationIds];
    const uniqueIds = mergedIds.filter((id, idx) => mergedIds.indexOf(id) === idx);
    const updated = await upsertVerificationRecord({ ...record, investigationIds: uniqueIds, investigationProcessing: { state: "processed", processingStartedAt: undefined, processedAt: new Date().toISOString() } }, { expectOwner: requestedBy });
    return NextResponse.json({ ok: true, action: result.action, investigationIds: updated.investigationIds, record: updated });
  } catch (err) {
    return NextResponse.json({ ok: false, error: "Investigator recovery processing failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function handleIdGet(req: Request, id: string) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const investigation = await getInvestigationById(id, scope);
  if (!investigation) return NextResponse.json({ error: "Investigation not found" }, { status: 404 });
  return NextResponse.json({ investigation });
}

async function handleIdPatch(req: Request, id: string) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const updated = await updateInvestigation(id, body as unknown as Partial<Investigation>, scope);
    if (!updated) return NextResponse.json({ error: "Investigation not found or access denied" }, { status: 404 });
    return NextResponse.json({ investigation: updated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update investigation" }, { status: 500 });
  }
}

async function handleIdPost(req: Request, id: string) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!body.verificationId || !body.outcome || !body.detectedAt) {
      return NextResponse.json({ error: "verificationId, outcome, and detectedAt are required" }, { status: 400 });
    }
    const updated = await appendVerificationReference(id, {
      verificationId: body.verificationId as string,
      jobId: body.jobId as string | undefined,
      outcome: body.outcome as string,
      detectedAt: body.detectedAt as string,
      evidencePath: body.evidencePath as string | undefined,
      failingStep: body.failingStep as string | undefined,
      summary: body.summary as string | undefined,
    }, scope);
    if (!updated) return NextResponse.json({ error: "Investigation not found or access denied" }, { status: 404 });
    return NextResponse.json({ investigation: updated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update investigation" }, { status: 500 });
  }
}

function notFound() { return NextResponse.json({ error: "Not found" }, { status: 404 }); }

export async function GET(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "") return handleBaseGet(req);
  if (!path.includes("/")) return handleIdGet(req, path);
  return notFound();
}

export async function POST(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "") return handleBasePost(req);
  if (path === "reprocess") return handleReprocess(req);
  if (!path.includes("/")) return handleIdPost(req, path);
  return notFound();
}

export async function PATCH(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (!path.includes("/")) return handleIdPatch(req, path);
  return notFound();
}