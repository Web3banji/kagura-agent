import { NextResponse } from "next/server";
import { observeGitHub } from "@/lib/github/observe";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.privileged) {
    return NextResponse.json({ error: "GitHub observation may only be triggered by a workspace owner." }, { status: 403 });
  }
  try {
    const result = await observeGitHub();
    if (result.error) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const { getObservationStatus } = await import("@/lib/github/observe");
  return NextResponse.json(await getObservationStatus());
}
