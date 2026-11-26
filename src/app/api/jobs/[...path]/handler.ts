import { NextResponse } from "next/server";
import { getRequestPrincipal } from "@/lib/auth";
import { scopeForPrincipal } from "@/lib/auth/scope";
import {
  cancelVerificationJob,
  finalizeCancelledJob,
  recoverExpiredVerificationJobs,
  reconcileJobOperations,
  retryVerificationJob,
  type JobOperationActor,
} from "@/lib/verification/jobs";

export async function POST(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) {
    return NextResponse.json({ error: principal.reason || "Unauthorized" }, { status: 401 });
  }
  const scope = scopeForPrincipal(principal, { legacyAccess: principal.kind !== "user" || !!principal.user?.isBootstrapOwner });
  if (!scope.privileged) {
    return NextResponse.json({ error: "Privileged job operation required" }, { status: 403 });
  }
  const actor: JobOperationActor = {
    type: principal.kind === "admin-token" ? "admin-token" : "user",
    id: principal.userId || "unknown",
  };
  const body = (await req.json().catch(() => ({}))) as {
    operation?: string;
    jobId?: string;
    reason?: string;
    expectedClaimedBy?: string;
    expectedClaimGeneration?: number;
    operationId?: string;
    terminationConfirmed?: boolean;
  };
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : "operator request";
  try {
    if (body.operation === "recover") {
      return NextResponse.json(await recoverExpiredVerificationJobs({ actor, reason }));
    }
    if (body.operation === "reconcile") {
      return NextResponse.json(await reconcileJobOperations({ actor, reason }));
    }
    if (!body.jobId || typeof body.jobId !== "string") {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    if (body.operation === "cancel") {
      const result = await cancelVerificationJob(body.jobId, {
        actor,
        reason,
        expectedClaimedBy: body.expectedClaimedBy,
        expectedClaimGeneration: body.expectedClaimGeneration,
        operationId: body.operationId,
      });
      return NextResponse.json(result);
    }
    if (body.operation === "finalize-cancel") {
      if (body.terminationConfirmed !== true) {
        return NextResponse.json({ error: "terminationConfirmed must be true for operator finalization" }, { status: 409 });
      }
      const result = await finalizeCancelledJob(body.jobId, {
        actor,
        reason,
        expectedClaimGeneration: body.expectedClaimGeneration,
        operationId: body.operationId,
      });
      return NextResponse.json(result);
    }
    if (body.operation === "retry") {
      const result = await retryVerificationJob(body.jobId, {
        actor,
        reason,
        expectedClaimGeneration: body.expectedClaimGeneration,
        operationId: body.operationId,
      });
      return NextResponse.json(result);
    }
    return NextResponse.json({ error: "Unsupported operation" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}