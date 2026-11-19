import { NextResponse } from "next/server";
import { createOAuthState, getAppBaseUrl, githubOAuthConfigured } from "@/lib/auth/oauth";
import { hasDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  if (!githubOAuthConfigured()) {
    return NextResponse.json({ error: "GitHub sign-in is not configured" }, { status: 503 });
  }
  const url = new URL(req.url);
  const redirectTo = url.searchParams.get("next") || "/command-center";
  const state = await createOAuthState(redirectTo);
  const base = getAppBaseUrl(req);
  const callback = `${base}/api/auth/callback/github`;
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID!,
    redirect_uri: callback,
    scope: "read:user user:email repo",
    state,
    allow_signup: "true",
  });
  return NextResponse.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
}