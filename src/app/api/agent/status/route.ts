import { NextResponse } from "next/server";
import { getCurrentPipelineState } from "@/lib/pipeline";
import { readRuns } from "@/lib/agent/runs";
import { getObservationStatus } from "@/lib/github/observe";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.includeLegacy && !scope.userId) {
    return NextResponse.json({
      state: { agentState: "idle", stage: "OBSERVE", note: "No legacy workspace data is available for this account." },
      runs: [],
      observation: { config: { owner: "", repo: "", configuredIn: "default" }, state: {}, eventsCount: 0, tokenConfigured: false, repo: "" },
    });
  }
  const [state, runs, obs] = await Promise.all([
    getCurrentPipelineState(),
    readRuns(scope),
    getObservationStatus(),
  ]);
  return NextResponse.json({ state, runs: runs.slice(0, 10), observation: obs });
}
