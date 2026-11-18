import { NextResponse } from "next/server";
import { consumeOAuthState, exchangeGitHubCode, fetchGitHubProfile, getAppBaseUrl, githubOAuthConfigured, sanitizeRedirect } from "@/lib/auth/oauth";
import { upsertGitHubUser, ensureBootstrapProjectForUser } from "@/lib/auth/users";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { hasDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const base = getAppBaseUrl(req);
  const fail = (reason: string) => NextResponse.redirect(`${base}/sign-in?error=${encodeURIComponent(reason)}`);

  try {
    if (!hasDatabase() || !githubOAuthConfigured()) return fail("not_configured");
    const url = new URL(req.url);
    const err = url.searchParams.get("error");
    if (err) return fail(err);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return fail("missing_params");

    const consumed = await consumeOAuthState(state);
    if (!consumed) return fail("invalid_state");

    const callback = `${base}/api/auth/callback/github`;
    const token = await exchangeGitHubCode(code, callback);
    const profile = await fetchGitHubProfile(token.access_token);
    const user = await upsertGitHubUser(profile, token);
    await ensureBootstrapProjectForUser(user.id);

    const session = await createSession(user.id);
    await setSessionCookie(session.token);

    const to = sanitizeRedirect(consumed.redirectTo) || "/command-center";
    return NextResponse.redirect(`${base}${to}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "auth_failed";
    return fail(msg.slice(0, 80));
  }
}