import { NextResponse } from "next/server";
import { consumeOAuthState, exchangeGitHubCode, fetchGitHubProfile, getAppBaseUrl, githubOAuthConfigured, sanitizeRedirect, createOAuthState } from "@/lib/auth/oauth";
import { upsertGitHubUser, ensureBootstrapProjectForUser } from "@/lib/auth/users";
import { createSession, setSessionCookie, getCurrentUser, clearSessionCookie, deleteSessionByToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { hasDatabase } from "@/lib/db";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

async function handleCallbackGithub(req: Request) {
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

async function handleSigninGithub(req: Request) {
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

async function handleReauthorize(req: Request) {
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

async function handleSession() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ user: null }, { status: 200 });
  return NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      githubLogin: user.githubLogin,
      isBootstrapOwner: user.isBootstrapOwner,
    },
  });
}

async function doSignOut() {
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE_NAME)?.value;
    if (token) await deleteSessionByToken(token);
  } catch {}
  await clearSessionCookie();
  const base = process.env.KAGURA_APP_URL || process.env.ECHOLOG_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "";
  const to = base ? `${base.replace(/\/+$/, "")}/sign-in?signedout=1` : "/sign-in?signedout=1";
  return NextResponse.redirect(to);
}

function notFound() { return NextResponse.json({ error: "Not found" }, { status: 404 }); }

export async function GET(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "callback/github") return handleCallbackGithub(req);
  if (path === "session") return handleSession();
  if (path === "signin/github") return handleSigninGithub(req);
  if (path === "signout") return doSignOut();
  return notFound();
}

export async function POST(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "github/reauthorize") return handleReauthorize(req);
  if (path === "signout") return doSignOut();
  return notFound();
}