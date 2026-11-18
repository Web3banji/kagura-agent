import { randomBytes } from "crypto";
import { ensureDb, getPool, hasDatabase } from "@/lib/db";

const STATE_TTL_MINUTES = 10;

export function getAppBaseUrl(req?: Request): string {
  const envUrl = process.env.KAGURA_APP_URL || process.env.ECHOLOG_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (envUrl) return envUrl.replace(/\/+$/, "");
  if (req) {
    const proto = req.headers.get("x-forwarded-proto") || "http";
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    if (host) return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}

export async function createOAuthState(redirectTo?: string): Promise<string> {
  if (!hasDatabase()) throw new Error("Database not configured");
  await ensureDb();
  const state = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000);
  const safeRedirect = sanitizeRedirect(redirectTo);
  await getPool().query(
    `INSERT INTO oauth_states (state, redirect_to, expires_at, created_at) VALUES ($1, $2, $3::timestamptz, NOW())`,
    [state, safeRedirect, expiresAt.toISOString()],
  );
  return state;
}

export async function consumeOAuthState(state: string): Promise<{ redirectTo?: string } | null> {
  if (!hasDatabase() || !state) return null;
  await ensureDb();
  const res = await getPool().query(
    `DELETE FROM oauth_states WHERE state = $1 AND expires_at > NOW() RETURNING redirect_to`,
    [state],
  );
  if (!res.rows[0]) return null;
  const redirectTo = res.rows[0].redirect_to ? String(res.rows[0].redirect_to) : undefined;
  return { redirectTo };
}

export function sanitizeRedirect(target?: string | null): string | undefined {
  if (!target) return undefined;
  if (!target.startsWith("/")) return undefined;
  if (target.startsWith("//")) return undefined;
  if (target.includes("\\")) return undefined;
  return target.slice(0, 500);
}

export function githubOAuthConfigured(): boolean {
  return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

export type GitHubProfile = {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

export async function exchangeGitHubCode(code: string, redirectUri: string): Promise<{ access_token: string; token_type?: string; scope?: string }> {
  const clientId = process.env.GITHUB_CLIENT_ID!;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET!;
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "kagura-agent",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !data.access_token || data.error) {
    const msg = typeof data.error_description === "string" ? data.error_description : typeof data.error === "string" ? data.error : `GitHub token exchange failed (${res.status})`;
    throw new Error(msg);
  }
  return {
    access_token: String(data.access_token),
    token_type: typeof data.token_type === "string" ? data.token_type : undefined,
    scope: typeof data.scope === "string" ? data.scope : undefined,
  };
}

export async function fetchGitHubProfile(accessToken: string): Promise<GitHubProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "kagura-agent",
  };
  const userRes = await fetch("https://api.github.com/user", { headers, cache: "no-store" });
  if (!userRes.ok) throw new Error(`GitHub user fetch failed (${userRes.status})`);
  const user = (await userRes.json()) as Record<string, unknown>;
  let email: string | null = typeof user.email === "string" ? user.email : null;
  if (!email) {
    try {
      const emailsRes = await fetch("https://api.github.com/user/emails", { headers, cache: "no-store" });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
        const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0];
        if (primary?.email) email = primary.email;
      }
    } catch {
      // ignore
    }
  }
  return {
    id: String(user.id),
    login: String(user.login || ""),
    name: typeof user.name === "string" ? user.name : null,
    email,
    avatar_url: typeof user.avatar_url === "string" ? user.avatar_url : null,
  };
}
