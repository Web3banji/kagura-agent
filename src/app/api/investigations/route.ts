import { NextResponse } from "next/server";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { readInvestigations } from "@/lib/investigations/store";
import type { InvestigationCategory, InvestigationStatus } from "@/types/investigation";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");

  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const requestedBy = scope.privileged ? undefined : principal.userId;
  const includeLegacy = !!scope.includeLegacy;

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId") || undefined;

  const investigations = await readInvestigations(scope);

  // Filter by projectId if provided.
  const filtered = investigations.filter((inv) => {
    if (projectId && inv.projectId !== projectId) return false;
    return true;
  });

  return NextResponse.json({ investigations: filtered, scope: { requestedBy, includeLegacy, privileged: scope.privileged } });
}

export async function POST(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");

  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.includeLegacy && !scope.userId) {
    return NextResponse.json({ error: "Creating investigations is not available for this account." }, { status: 403 });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      title?: string;
      category?: string;
      technicalExplanation?: string;
      simpleExplanation?: string;
      rootCause?: string;
      affectedAreas?: string[];
      expectedBehaviour?: string;
      actualBehaviour?: string;
      severity?: string;
      status?: string;
      projectId?: string;
      repositoryConnectionId?: string;
      verificationReferences?: Array<{
        verificationId: string;
        jobId?: string;
        outcome: string;
        detectedAt: string;
        evidencePath?: string;
        failingStep?: string;
        summary?: string;
      }>;
      evidenceReferences?: string[];
      aiFixPrompt?: string;
    };

    if (!body.title || !body.technicalExplanation || !body.simpleExplanation) {
      return NextResponse.json({ error: "title, technicalExplanation, and simpleExplanation are required" }, { status: 400 });
    }

    const { createInvestigation } = await import("@/lib/investigations/store");

    const investigation = await createInvestigation(
      {
        ownerUserId: scope.userId ?? "",
        projectId: body.projectId ?? null,
        repositoryConnectionId: body.repositoryConnectionId ?? null,
        title: body.title,
        category: body.category as InvestigationCategory,
        technicalExplanation: body.technicalExplanation,
        simpleExplanation: body.simpleExplanation,
        rootCause: body.rootCause ?? null,
        affectedAreas: body.affectedAreas ?? null,
        expectedBehaviour: body.expectedBehaviour ?? null,
        actualBehaviour: body.actualBehaviour ?? null,
        severity: body.severity as "low" | "medium" | "high" | "critical",
        status: body.status as InvestigationStatus,
        verificationReferences: body.verificationReferences ?? [],
        evidenceReferences: body.evidenceReferences ?? null,
        aiFixPrompt: body.aiFixPrompt ?? null,
      },
    );

    return NextResponse.json({ investigation }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create investigation" }, { status: 500 });
  }
}
