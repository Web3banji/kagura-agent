import { cookies } from "next/headers";
import { createHash, randomBytes, randomUUID } from "crypto";
import { ensureDb, getPool, hasDatabase } from "@/lib/db";

export const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production" ? "__Secure-kagura.session" : "kagura.session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type SessionUser = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  githubId: string | null;
  githubLogin: string | null;
  isBootstrapOwner: boolean;
};

export type SessionInfo = {
  sessionId: string;
  userId: string;
  expiresAt: Date;
  user: SessionUser;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionCookieOptions() {
  const secure = process.env.NODE_ENV === "production";
  return {
    httpOnly: true as const,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  if (!hasDatabase()) throw new Error("Database not configured");
  await ensureDb();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await getPool().query(
    `INSERT INTO sessions (id, session_token_hash, user_id, expires, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4::timestamptz, NOW(), NOW())`,
    [id, tokenHash, userId, expiresAt.toISOString()],
  );
  return { token, expiresAt };
}

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(), maxAge: 0 });
}

export async function deleteSessionByToken(token: string): Promise<void> {
  if (!hasDatabase()) return;
  await ensureDb();
  const tokenHash = hashToken(token);
  await getPool().query(`DELETE FROM sessions WHERE session_token_hash = $1`, [tokenHash]);
}

export async function deleteExpiredSessions(): Promise<void> {
  if (!hasDatabase()) return;
  try {
    await ensureDb();
    await getPool().query(`DELETE FROM sessions WHERE expires <= NOW()`);
  } catch {
    // best-effort cleanup
  }
}

function rowToUser(row: Record<string, unknown>): SessionUser {
  return {
    id: String(row.id),
    name: row.name == null ? null : String(row.name),
    email: row.email == null ? null : String(row.email),
    image: row.image == null ? null : String(row.image),
    githubId: row.github_id == null ? null : String(row.github_id),
    githubLogin: row.github_login == null ? null : String(row.github_login),
    isBootstrapOwner: !!row.is_bootstrap_owner,
  };
}

export async function getSessionFromToken(token: string): Promise<SessionInfo | null> {
  if (!hasDatabase() || !token) return null;
  await ensureDb();
  const tokenHash = hashToken(token);
  const res = await getPool().query(
    `SELECT s.id as session_id, s.user_id, s.expires, s.last_seen_at,
            u.id, u.name, u.email, u.image, u.github_id, u.github_login, u.is_bootstrap_owner
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.session_token_hash = $1 AND s.expires > NOW()
     LIMIT 1`,
    [tokenHash],
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0] as Record<string, unknown>;
  // Opportunistic touch (best-effort, no await blocking correctness)
  void getPool()
    .query(`UPDATE sessions SET last_seen_at = NOW() WHERE id = $1`, [String(row.session_id)])
    .catch(() => {});
  return {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    expiresAt: new Date(String(row.expires)),
    user: rowToUser(row),
  };
}

export async function getCurrentSession(): Promise<SessionInfo | null> {
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE_NAME)?.value;
    if (!token) return null;
    return await getSessionFromToken(token);
  } catch {
    return null;
  }
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getCurrentSession();
  return session?.user ?? null;
}
