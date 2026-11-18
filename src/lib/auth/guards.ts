import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { getCurrentUser, type SessionUser } from "./session";
import { isAdminAuthorized, getAdminToken, type AuthPrincipal } from "./index";
import { ensureDb, getPool, hasDatabase } from "@/lib/db";
import { isAccessDeniedError, isInputValidationError } from "./errors";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Convert a thrown error into an API response.
 * Authorization failures become 403, validation failures 400, everything else 500.
 * The raw error message is never echoed for 500s so internal details cannot leak.
 */
export function apiErrorResponse(err: unknown, fallback = "Internal server error"): NextResponse {
  if (isAccessDeniedError(err)) {
    return NextResponse.json({ error: err.message || "Access denied" }, { status: 403 });
  }
  if (isInputValidationError(err)) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/sign-in");
  }
  return user;
}

export async function requireUserApi(req?: Request): Promise<SessionUser | Response> {
  const user = await getCurrentUser();
  if (user) return user;
  // Allow existing admin-token mechanism as separate protected admin access (infrastructure)
  if (req && isAdminAuthorized(req)) {
    // Represent admin-token principal as a synthetic bootstrap-capable context is handled separately;
    // for user-identity APIs we still require a real session. Return 401 to force proper auth.
    return NextResponse.json({ error: "Authenticated user session required" }, { status: 401 });
  }
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function getRequestAuthContext(req: Request): Promise<
  | { type: "user"; user: SessionUser }
  | { type: "admin-token"; userId: string }
  | { type: "none" }
> {
  const user = await getCurrentUser();
  if (user) return { type: "user", user };
  if (isAdminAuthorized(req)) {
    // Preserve admin infra access (separate mechanism)
    const crypto = await import("crypto");
    const token =
      process.env.KAGURA_ADMIN_TOKEN || process.env.ECHOLOG_ADMIN_TOKEN || process.env.ADMIN_PASSWORD || "";
    const userId = "admin:" + crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
    return { type: "admin-token", userId };
  }
  return { type: "none" };
}

/**
 * Server-component equivalent of getRequestPrincipal: resolves from the verified user
 * session first, then from the separate admin-token infrastructure mechanism.
 * Never trusts client-supplied identity.
 */
export async function getServerPrincipal(): Promise<AuthPrincipal> {
  const user = await getCurrentUser();
  if (user) {
    return { userId: user.id, authorized: true, kind: "user", user };
  }
  try {
    const h = await headers();
    const req = new Request("http://localhost/internal-server-principal", { headers: h });
    if (isAdminAuthorized(req)) {
      const token = getAdminToken() || "";
      const userId = "admin:" + createHash("sha256").update(token).digest("hex").slice(0, 16);
      return { userId, authorized: true, kind: "admin-token" };
    }
  } catch {
    // fall through to unauthenticated
  }
  return {
    userId: "anonymous",
    authorized: false,
    kind: "anonymous",
    reason: "Authentication required",
  };
}

export async function requireProjectAccess(userId: string, projectId: string): Promise<boolean> {
  if (!hasDatabase() || !projectId) return false;
  await ensureDb();
  const res = await getPool().query(
    `SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
    [projectId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function canAccessLegacyData(user: SessionUser | null, opts?: { adminTokenAuthorized?: boolean }): Promise<boolean> {
  // Existing global/single-owner data must not be exposed to newly registered users.
  // Accessible to: bootstrap owner user, or requests authorized via separate admin-token mechanism.
  if (opts?.adminTokenAuthorized) return true;
  if (!user) return false;
  return !!user.isBootstrapOwner;
}

/**
 * Safe default for Milestone 1:
 * - No signed-in user session => allow (covers admin-token dashboard access and pre-multi-user local-dev).
 * - Signed-in non-bootstrap user => deny access to existing global/legacy data.
 * - Signed-in bootstrap owner => allow.
 */
export async function canAccessLegacyGlobalData(): Promise<boolean> {
  try {
    const user = await getCurrentUser();
    if (!user) return true;
    return !!user.isBootstrapOwner;
  } catch {
    return false;
  }
}

export function principalHasLegacyAccess(principal: { kind?: string; user?: { isBootstrapOwner?: boolean } | null }): boolean {
  // Admin-token infra access and local-dev (no user session) retain access to existing global data.
  if (!principal.kind || principal.kind === "admin-token" || principal.kind === "dev") return true;
  if (principal.kind === "user") return !!principal.user?.isBootstrapOwner;
  return false;
}

export async function getBootstrapOwnerUserId(): Promise<string | null> {
  if (!hasDatabase()) return null;
  await ensureDb();
  const res = await getPool().query(
    `SELECT id FROM users WHERE is_bootstrap_owner = TRUE ORDER BY created_at ASC LIMIT 1`,
  );
  if (!res.rows[0]) return null;
  return String(res.rows[0].id);
}

export async function assignBootstrapOwnerIfEligible(userId: string, email: string | null, githubLogin: string | null): Promise<boolean> {
  if (!hasDatabase()) return false;
  await ensureDb();
  const current = await getBootstrapOwnerUserId();
  if (current) return current === userId;

  const allowedEmail = (process.env.KAGURA_BOOTSTRAP_OWNER_EMAIL || "").trim().toLowerCase();
  const allowedGithub = (process.env.KAGURA_BOOTSTRAP_OWNER_GITHUB_LOGIN || "").trim().toLowerCase();
  let eligible = false;
  if (allowedEmail && email && email.toLowerCase() === allowedEmail) eligible = true;
  if (allowedGithub && githubLogin && githubLogin.toLowerCase() === allowedGithub) eligible = true;
  // Safe fallback: if there are no users marked bootstrap and this is the only user AND an explicit bootstrap env is not set,
  // do NOT auto-assign (prevents first arbitrary registrant from claiming legacy data). Operator must configure env or claim via admin flow.
  if (!eligible) return false;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const again = await client.query(`SELECT id FROM users WHERE is_bootstrap_owner = TRUE LIMIT 1`);
    if ((again.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return String(again.rows[0].id) === userId;
    }
    await client.query(`UPDATE users SET is_bootstrap_owner = TRUE, updated_at = NOW() WHERE id = $1`, [userId]);
    await client.query("COMMIT");
    return true;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}
