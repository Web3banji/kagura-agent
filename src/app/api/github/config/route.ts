import { NextResponse } from "next/server";
import { readGitHubConfig, writeGitHubConfig } from "@/lib/github/config";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  return NextResponse.json(await readGitHubConfig());
}

export async function POST(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  // The GitHub repository binding is platform-owned infrastructure shared by all users.
  // Only privileged principals (admin-token infra access, local-dev, or the bootstrap owner)
  // may change it, so one ordinary user cannot repoint the platform at another user's
  // private repository or expose its commits to everyone else.
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.privileged && !(scope.userId && scope.includeLegacy)) {
    return NextResponse.json(
      { error: "Only the workspace owner can change the platform repository configuration." },
      { status: 403 },
    );
  }
  try {
    const body = (await req.json()) as { owner?: string; repo?: string };
    const owner = (body.owner || "").trim();
    const repo = (body.repo || "").trim();
    if (!owner || !repo) return NextResponse.json({ error: "owner and repo are required" }, { status: 400 });
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
      return NextResponse.json({ error: "Invalid owner or repo name" }, { status: 400 });
    }
    const cfg = await writeGitHubConfig(owner, repo);
    return NextResponse.json(cfg);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
