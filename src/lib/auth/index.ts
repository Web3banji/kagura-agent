import { createHash } from "crypto";
import { cookies } from "next/headers";
import { getSessionFromToken, SESSION_COOKIE_NAME, type SessionUser } from "./session";

export function getAdminToken(): string | undefined {
  return process.env.KAGURA_ADMIN_TOKEN || process.env.ECHOLOG_ADMIN_TOKEN || process.env.ADMIN_PASSWORD;
}

export function adminAuthConfigured(): boolean {
  return !!getAdminToken();
}

export function isAdminAuthorized(req: Request): boolean {
  const token = getAdminToken();
  if (!token) {
    // No auto-admin bypass in production/Vercel; preserve local-dev convenience only.
    return process.env.NODE_ENV !== "production" && !process.env.VERCEL;
  }
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ") && auth.slice(7) === token) return true;
  if (auth.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const pass = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
      if (pass === token || decoded === token) return true;
    } catch {}
  }
  const header =
    req.headers.get("x-admin-token") ||
    req.headers.get("x-kagura-admin-token") ||
    req.headers.get("x-echolog-admin-token");
  if (header && header === token) return true;
  return false;
}

export function unauthorizedResponse(message = "Unauthorized"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Basic realm="KAGURA Admin"',
    },
  });
}

export type AuthPrincipal = {
  userId: string;
  authorized: boolean;
  reason?: string;
  kind?: "user" | "admin-token" | "dev" | "anonymous";
  user?: SessionUser;
};

async function getSessionUserFromRequest(req: Request): Promise<SessionUser | null> {
  // Prefer next/headers cookie jar (works in route handlers); fall back to parsing Cookie header.
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE_NAME)?.value;
    if (token) {
      const session = await getSessionFromToken(token);
      if (session?.user) return session.user;
    }
  } catch {}
  try {
    const cookie = req.headers.get("cookie") || "";
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}=([^;]+)`));
    if (m?.[1]) {
      const session = await getSessionFromToken(decodeURIComponent(m[1]));
      if (session?.user) return session.user;
    }
  } catch {}
  return null;
}

/**
 * Resolves principal from a verified user session first, then (separately) from the
 * admin infrastructure token mechanism. Never trusts user identity supplied by the client.
 * Production does not rely on local-dev auto-admin bypass.
 */
export async function getRequestPrincipal(req: Request): Promise<AuthPrincipal> {
  const sessionUser = await getSessionUserFromRequest(req);
  if (sessionUser) {
    return { userId: sessionUser.id, authorized: true, kind: "user", user: sessionUser };
  }

  const token = getAdminToken();
  if (!token) {
    const devOk = process.env.NODE_ENV !== "production" && !process.env.VERCEL;
    return {
      userId: devOk ? "local-dev" : "anonymous",
      authorized: devOk,
      kind: devOk ? "dev" : "anonymous",
      reason: devOk ? undefined : "Authentication required",
    };
  }
  if (isAdminAuthorized(req)) {
    const userId = "admin:" + createHash("sha256").update(token).digest("hex").slice(0, 16);
    return { userId, authorized: true, kind: "admin-token" };
  }
  return { userId: "anonymous", authorized: false, kind: "anonymous", reason: "Unauthorized" };
}
