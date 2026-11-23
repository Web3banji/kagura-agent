import { NextResponse } from "next/server";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { getVerificationRecord, upsertVerificationRecord } from "@/lib/verification/store";
import { processVerificationResult } from "@/lib/investigations/processor";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");

  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const requestedBy = scope.privileged ? undefined : principal.userId;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      verificationId?: string;
      jobId?: string;
    };

    const verificationId =
      typeof body.verificationId === "string" && body.verificationId.trim()
        ? body.verificationId.trim()
        : typeof body.jobId === "string" && body.jobId.trim()
          ? body.jobId.trim()
          : undefined;

    if (!verificationId) {
      return NextResponse.json({ error: "verificationId or jobId is required" }, { status: 400 });
    }

    // Retrieve the actual persisted verification record. Never trust client-supplied
    // data as evidence.
    const record = await getVerificationRecord(verificationId, {
      projectId: undefined,
      requestedBy,
    });

    if (!record) {
      return NextResponse.json({ error: "Verification record not found" }, { status: 404 });
    }

    // Ownership check: ordinary users can only reprocess their own records.
    if (!scope.privileged) {
      const owner = record.requestedBy ?? null;
      if (!owner || owner !== principal.userId) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }

    // Only reprocess terminal outcomes that haven't been successfully processed.
    const existingState = record.investigationProcessing?.state;
    const processingStartedAt = record.investigationProcessing?.processingStartedAt;
    const STALE_PROCESSING_MS = Number(process.env.KAGURA_INVESTIGATOR_STALE_PROCESSING_MS || 300000); // 5 minutes
    const isStaleProcessing =
      existingState === "processing" &&
      processingStartedAt &&
      Date.now() - new Date(processingStartedAt).getTime() > STALE_PROCESSING_MS;

    if (existingState === "processing" && !isStaleProcessing) {
      return NextResponse.json({
        ok: true,
        message: "Verification processing is already in progress",
        investigationIds: record.investigationIds ?? [],
        record,
      });
    }
    const alreadyProcessed =
      existingState === "processed" &&
      record.investigationIds &&
      record.investigationIds.length > 0;
    if (alreadyProcessed && !record.outcome?.startsWith("failed")) {
      return NextResponse.json({
        ok: true,
        message: "Verification already processed",
        investigationIds: record.investigationIds,
        record,
      });
    }

    // Mark processing as in-progress before starting.
    await upsertVerificationRecord(
      {
        ...record,
        investigationProcessing: {
          state: "processing",
          processingStartedAt: isStaleProcessing ? new Date().toISOString() : processingStartedAt,
        },
      },
      { expectOwner: requestedBy },
    );

    // Re-run investigation processing against the actual persisted result.
    // This is idempotent: processVerificationResult deduplicates verification
    // references and does not create duplicate investigations.
    let result;
    try {
      result = await processVerificationResult(record, {
        ownerUserId: principal.userId,
        projectId: record.projectId || undefined,
        repositoryConnectionId: undefined,
      });
    } catch (err) {
      // Record the failure without marking the Kane verification itself as failed.
      await upsertVerificationRecord(
        {
          ...record,
          investigationProcessing: {
            state: "failed",
            processedAt: new Date().toISOString(),
            error: err instanceof Error ? err.message : "Investigator recovery processing failed",
          },
        },
        { expectOwner: requestedBy },
      );
      return NextResponse.json(
        {
          ok: false,
          error: "Investigator recovery processing failed",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }

    const investigationIds = result.investigations.map((i) => i.id);

    // Persist the link between verification record and investigation(s).
    const existingIds = record.investigationIds ?? [];
    const mergedIds = [...existingIds, ...investigationIds];
    const uniqueIds = mergedIds.filter((id, idx) => mergedIds.indexOf(id) === idx);

    const updated = await upsertVerificationRecord(
      {
        ...record,
        investigationIds: uniqueIds,
        investigationProcessing: {
          state: "processed",
          processingStartedAt: undefined,
          processedAt: new Date().toISOString(),
        },
      },
      { expectOwner: requestedBy },
    );

    return NextResponse.json({
      ok: true,
      action: result.action,
      investigationIds: updated.investigationIds,
      record: updated,
    });
  } catch (err) {
    // Record the failure without marking the Kane verification itself as failed.
    return NextResponse.json(
      {
        ok: false,
        error: "Investigator recovery processing failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
