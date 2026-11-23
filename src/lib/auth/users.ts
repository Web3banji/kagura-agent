import { randomUUID } from "crypto";
import { ensureDb, getPool, hasDatabase } from "@/lib/db";
import type { GitHubProfile } from "./oauth";
import { assignBootstrapOwnerIfEligible } from "./guards";
import { encryptStoredToken, decryptStoredToken } from "./token-crypto";

export type DbUser = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  githubId: string | null;
  githubLogin: string | null;
  isBootstrapOwner: boolean;
};

function rowToDbUser(row: Record<string, unknown>): DbUser {
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

export async function upsertGitHubUser(
  profile: GitHubProfile,
  tokens: { access_token: string; token_type?: string; scope?: string; refresh_token?: string | null },
): Promise<DbUser> {
  if (!hasDatabase()) throw new Error("Database not configured");
  await ensureDb();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const encAccessToken = encryptStoredToken(tokens.access_token);
    const encRefreshToken = encryptStoredToken(tokens.refresh_token ?? null);
    const tokenType = tokens.token_type ?? null;
    const scope = tokens.scope ?? null;

    // Find existing account link
    const acct = await client.query(
      `SELECT a.user_id, u.* FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.provider = $1 AND a.provider_account_id = $2 LIMIT 1`,
      ["github", profile.id],
    );

    let userId: string;
    if (acct.rows[0]) {
      userId = String(acct.rows[0].user_id);
      await client.query(
        `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email), image = COALESCE($4, image),
            github_id = $5, github_login = $6, updated_at = NOW()
         WHERE id = $1`,
        [userId, profile.name, profile.email, profile.avatar_url, profile.id, profile.login],
      );
      await client.query(
        `UPDATE accounts SET access_token = $3, refresh_token = COALESCE($4, refresh_token), token_type = $5, scope = $6, updated_at = NOW()
         WHERE provider = $1 AND provider_account_id = $2`,
        ["github", profile.id, encAccessToken, encRefreshToken, tokenType, scope],
      );
    } else {
      // Bind strictly by stable GitHub provider account ID; never link accounts by email.
      let existing: Record<string, unknown> | undefined;
      const byGh = await client.query(`SELECT * FROM users WHERE github_id = $1 LIMIT 1`, [profile.id]);
      if (byGh.rows[0]) existing = byGh.rows[0] as Record<string, unknown>;

      if (existing) {
        userId = String(existing.id);
        await client.query(
          `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email), image = COALESCE($4, image),
              github_id = $5, github_login = $6, updated_at = NOW()
           WHERE id = $1`,
          [userId, profile.name, profile.email, profile.avatar_url, profile.id, profile.login],
        );
      } else {
        userId = randomUUID();
        await client.query(
          `INSERT INTO users (id, name, email, image, github_id, github_login, email_verified, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())`,
          [userId, profile.name, profile.email, profile.avatar_url, profile.id, profile.login, profile.email ? new Date().toISOString() : null],
        );
      }

      await client.query(
        `INSERT INTO accounts (id, user_id, provider, provider_account_id, type, access_token, refresh_token, token_type, scope, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'oauth',$5,$6,$7,$8,NOW(),NOW())
         ON CONFLICT (provider, provider_account_id) DO UPDATE SET
           user_id = EXCLUDED.user_id, access_token = EXCLUDED.access_token,
           refresh_token = COALESCE(EXCLUDED.refresh_token, accounts.refresh_token),
           token_type = EXCLUDED.token_type, scope = EXCLUDED.scope, updated_at = NOW()`,
        [randomUUID(), userId, "github", profile.id, encAccessToken, encRefreshToken, tokenType, scope],
      );
    }

    await client.query("COMMIT");

    // Bootstrap owner assignment (safe, env-gated) outside main transaction side-effects ok
    try {
      await assignBootstrapOwnerIfEligible(userId, profile.email, profile.login);
    } catch {
      // ignore - operator can configure later
    }

    const out = await pool.query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [userId]);
    return rowToDbUser(out.rows[0] as Record<string, unknown>);
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Retrieve the authenticated user's decrypted GitHub OAuth access token, if they
 * have connected GitHub via OAuth. Returns null when no token is stored. This is
 * used so GitHub observation can fall back to the user's own credentials instead of
 * relying solely on a server-level PAT that may be missing or expired.
 */
export async function getUserGitHubAccessToken(userId: string): Promise<string | null> {
  if (!hasDatabase()) return null;
  await ensureDb();
  const pool = getPool();
  const res = await pool.query(
    `SELECT access_token FROM accounts WHERE user_id = $1 AND provider = 'github' AND access_token IS NOT NULL LIMIT 1`,
    [userId],
  );
  if (!res.rows[0]) return null;
  return decryptStoredToken(String(res.rows[0].access_token)) ?? null;
}

/**
 * Create a bootstrap project for the bootstrap owner if none exists yet (safe, additive).
 */
export async function ensureBootstrapProjectForUser(userId: string): Promise<string | null> {
  if (!hasDatabase()) return null;
  await ensureDb();
  const pool = getPool();
  const u = await pool.query(`SELECT is_bootstrap_owner FROM users WHERE id = $1`, [userId]);
  if (!u.rows[0]?.is_bootstrap_owner) return null;
  const existing = await pool.query(
    `SELECT id FROM projects WHERE owner_user_id = $1 AND is_bootstrap = TRUE LIMIT 1`,
    [userId],
  );
  if (existing.rows[0]) return String(existing.rows[0].id);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO projects (id, owner_user_id, name, slug, is_bootstrap, created_at, updated_at)
     VALUES ($1,$2,$3,$4,TRUE,NOW(),NOW())`,
    [id, userId, "KAGURA Bootstrap Project", `bootstrap-${userId.slice(0, 8)}`],
  );
  return id;
}

