import { NextResponse } from "next/server";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import {
  getInvestigationById,
  updateInvestigation,
  appendVerificationReference,
} from "@/lib/investigations/store";
import type { Investigation } from "@/types/investigation";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");

  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const { id } = await params;

  const investigation = await getInvestigationById(id, scope);
  if (!investigation) {
    return NextResponse.json({ error: "Investigation not found" }, { status: 404 });
  }

  return NextResponse.json({ investigation });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");

  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const { id } = await params;

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const updated = await updateInvestigation(id, body as unknown as Partial<Investigation>, scope);
    if (!updated) {
      return NextResponse.json({ error: "Investigation not found or access denied" }, { status: 404 });
    }

    return NextResponse.json({ investigation: updated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update investigation" }, { status: 500 });
  }
}

/**
 * Append a new verification reference to an existing investigation.
 * Used by the Kane result processor when a repeated verification matches
 * an existing investigation.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");

  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const { id } = await params;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      verificationId: string;
      jobId?: string;
      outcome: string;
      detectedAt: string;
      evidencePath?: string;
      failingStep?: string;
      summary?: string;
    };

    if (!body.verificationId || !body.outcome || !body.detectedAt) {
      return NextResponse.json({ error: "verificationId, outcome, and detectedAt are required" }, { status: 400 });
    }

    const updated = await appendVerificationReference(
      id,
      {
        verificationId: body.verificationId,
        jobId: body.jobId,
        outcome: body.outcome,
        detectedAt: body.detectedAt,
        evidencePath: body.evidencePath,
        failingStep: body.failingStep,
        summary: body.summary,
      },
      scope,
    );

    if (!updated) {
      return NextResponse.json({ error: "Investigation not found or access denied" }, { status: 404 });
    }

    return NextResponse.json({ investigation: updated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update investigation" }, { status: 500 });
  }
}
