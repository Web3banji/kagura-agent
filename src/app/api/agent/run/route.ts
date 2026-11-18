import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/agent/pipeline";
import { getActiveRun } from "@/lib/agent/runs";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.includeLegacy && !scope.userId) {
    return NextResponse.json({ error: "Legacy workspace actions are not available for this account." }, { status: 403 });
  }
  try {
    const active = await getActiveRun(scope);
    if (active) {
      return NextResponse.json({ error: "An agent run is already in progress.", run: active }, { status: 409 });
    }
    const result = await runPipeline("manual", { userId: principal.userId, scope });
    if (result.error && !result.run) {
      return NextResponse.json(result, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
