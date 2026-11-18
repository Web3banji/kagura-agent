import { Pool } from "pg";

let pool: Pool | null = null;

export function hasDatabase(): boolean {
  return !!process.env.DATABASE_URL;
}

export function isProductionRuntime(): boolean {
  return !!process.env.VERCEL || process.env.NODE_ENV === "production";
}

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not configured");
  if (!pool) {
    const cs = process.env.DATABASE_URL;
    const local = cs.includes("localhost") || cs.includes("127.0.0.1");
    pool = new Pool({
      connectionString: cs,
      ssl: local ? false : { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

let initPromise: Promise<void> | null = null;

export async function ensureDb(): Promise<void> {
  if (!hasDatabase()) return;
  if (!initPromise) {
    const run = (async () => {
      const p = getPool();
      // Additive, idempotent initialization. Preserves existing tables/data.
      // Existing: echolog_kv, verification_jobs (never dropped/renamed/reset).
      await p.query(`
        CREATE TABLE IF NOT EXISTS echolog_kv (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS verification_jobs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL DEFAULT '',
          requested_by TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          claimed_at TIMESTAMPTZ,
          lease_expires_at TIMESTAMPTZ,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          claimed_by TEXT,
          runner_id TEXT,
          record_id TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS verification_jobs_status_lease_idx ON verification_jobs (status, lease_expires_at);
        CREATE INDEX IF NOT EXISTS verification_jobs_project_created_idx ON verification_jobs (project_id, created_at DESC);

        -- Multi-user auth foundation (Milestone 1, additive)
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT,
          email TEXT,
          email_verified TIMESTAMPTZ,
          image TEXT,
          github_id TEXT,
          github_login TEXT,
          is_bootstrap_owner BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email)) WHERE email IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS users_github_id_unique_idx ON users (github_id) WHERE github_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS users_bootstrap_owner_idx ON users (is_bootstrap_owner) WHERE is_bootstrap_owner = TRUE;

        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'oauth',
          access_token TEXT,
          refresh_token TEXT,
          expires_at BIGINT,
          token_type TEXT,
          scope TEXT,
          id_token TEXT,
          session_state TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (provider, provider_account_id)
        );
        CREATE INDEX IF NOT EXISTS accounts_user_id_idx ON accounts (user_id);

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          session_token_hash TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
        CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires);

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          slug TEXT,
          is_bootstrap BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS projects_owner_user_id_idx ON projects (owner_user_id);
        CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_unique_idx ON projects (slug) WHERE slug IS NOT NULL;

        CREATE TABLE IF NOT EXISTS oauth_states (
          state TEXT PRIMARY KEY,
          code_verifier TEXT,
          redirect_to TEXT,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS oauth_states_expires_idx ON oauth_states (expires_at);
      `);
    })().catch((err) => {
      // Allow retry on subsequent calls if initialization fails (e.g. transient DB error).
      // Do not cache a permanently rejected promise.
      if (initPromise === run) initPromise = null;
      throw err;
    });
    initPromise = run;
  }
  await initPromise;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  await ensureDb();
  const res = await getPool().query("SELECT value FROM echolog_kv WHERE key = $1", [key]);
  if (res.rows.length === 0) return undefined;
  return res.rows[0].value as T;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await ensureDb();
  await getPool().query(
    `INSERT INTO echolog_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

/**
 * Atomically read-modify-write a JSON value in echolog_kv.
 * Uses a transaction with row-level lock to prevent concurrent lost updates.
 */
export async function kvMutate<T>(key: string, mutator: (current: T | undefined) => T): Promise<T> {
  await ensureDb();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Ensure row exists so FOR UPDATE can lock it on first initialization.
    await client.query(
      `INSERT INTO echolog_kv (key, value, updated_at) VALUES ($1, 'null'::jsonb, NOW())
       ON CONFLICT (key) DO NOTHING`,
      [key],
    );
    const res = await client.query("SELECT value FROM echolog_kv WHERE key = $1 FOR UPDATE", [key]);
    const raw = res.rows[0] ? (res.rows[0].value as T | null) : undefined;
    const current = raw === null ? undefined : raw;
    const next = mutator(current);
    await client.query(
      `UPDATE echolog_kv SET value = $2::jsonb, updated_at = NOW() WHERE key = $1`,
      [key, JSON.stringify(next)],
    );
    await client.query("COMMIT");
    return next;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}
