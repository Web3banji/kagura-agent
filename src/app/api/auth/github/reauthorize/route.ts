import { NextResponse } from "next/server";
import { createOAuthState, getAppBaseUrl, githubOAuthConfigured } from "@/lib/auth/oauth";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized || principal.kind !== "user") {
    return unauthorizedResponse(principal.reason || "Unauthorized");
  }

  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  if (!githubOAuthConfigured()) {
    return NextResponse.json({ error: "GitHub OAuth is not configured" }, { status: 503 });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { redirectTo?: string };
    const redirectTo = body.redirectTo?.trim() || "/settings";
    const base = getAppBaseUrl(req);
    const callback = `${base}/api/auth/callback/github`;
    const state = await createOAuthState(redirectTo);
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID!,
      redirect_uri: callback,
      scope: "read:user user:email repo",
      state,
      allow_signup: "true",
    });
    return NextResponse.json({ authorizeUrl: `https://github.com/login/oauth/authorize?${params.toString()}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to initiate reauthorization";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}