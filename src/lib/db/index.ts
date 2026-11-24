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
      const client = await p.connect();
      // Serialize DDL across concurrent processes/workers to avoid catalog deadlocks
      // (e.g. concurrent CREATE INDEX IF NOT EXISTS on the same relations).
      await client.query("SELECT pg_advisory_lock($1)", [918273645]);
      try {
        // Additive, idempotent initialization. Preserves existing tables/data.
        // Existing: echolog_kv, verification_jobs (never dropped/renamed/reset).
        await client.query(`
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
          error TEXT,
          claim_generation INTEGER NOT NULL DEFAULT 0
        );
        ALTER TABLE verification_jobs ADD COLUMN IF NOT EXISTS claim_generation INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS verification_jobs_status_lease_idx ON verification_jobs (status, lease_expires_at);
        CREATE INDEX IF NOT EXISTS verification_jobs_project_created_idx ON verification_jobs (project_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS verification_processing_outbox (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          record_id TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          project_id TEXT,
          claim_generation INTEGER NOT NULL DEFAULT 0,
          operation TEXT NOT NULL DEFAULT 'process_verification_result',
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','dead')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 8,
          last_error TEXT,
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          processed_at TIMESTAMPTZ
        );
        CREATE UNIQUE INDEX IF NOT EXISTS verification_processing_outbox_job_gen_op_idx
          ON verification_processing_outbox (job_id, claim_generation, operation);
        CREATE INDEX IF NOT EXISTS verification_processing_outbox_status_available_idx
          ON verification_processing_outbox (status, available_at, lease_expires_at);

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

        -- Multi-repo foundation (Stage 1, additive): repository connections authorized by users
        -- and project-to-repository links. Does not modify existing global GitHub config/observation.
        -- Composite unique (id, owner_user_id) keys support ownership-enforcing composite FKs.
        CREATE UNIQUE INDEX IF NOT EXISTS projects_id_owner_unique_idx ON projects (id, owner_user_id);

        CREATE TABLE IF NOT EXISTS repository_connections (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL DEFAULT 'github',
          provider_account_id TEXT,
          github_repo_id TEXT NOT NULL,
          repo_owner TEXT NOT NULL,
          repo_name TEXT NOT NULL,
          full_name TEXT NOT NULL,
          default_branch TEXT,
          is_private BOOLEAN,
          permissions JSONB,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (id, owner_user_id),
          UNIQUE (owner_user_id, provider, github_repo_id)
        );
        CREATE INDEX IF NOT EXISTS repository_connections_owner_idx ON repository_connections (owner_user_id);
        CREATE INDEX IF NOT EXISTS repository_connections_repo_idx ON repository_connections (provider, github_repo_id);

        CREATE TABLE IF NOT EXISTS project_repository_links (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          repository_connection_id TEXT NOT NULL,
          owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          link_status TEXT NOT NULL DEFAULT 'legacy' CHECK (link_status IN ('active', 'legacy')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (project_id, repository_connection_id),
          FOREIGN KEY (project_id, owner_user_id)
            REFERENCES projects(id, owner_user_id) ON DELETE CASCADE,
          FOREIGN KEY (repository_connection_id, owner_user_id)
            REFERENCES repository_connections(id, owner_user_id) ON DELETE RESTRICT
        );

        -- Existing-table upgrade (Stage 3.3.8, additive/idempotent):
        -- Supports databases created before link_status existed. Preserves valid active/legacy
        -- values, classifies missing/invalid rows as legacy, and never deletes/reassigns links.
        ALTER TABLE project_repository_links
          ADD COLUMN IF NOT EXISTS link_status TEXT DEFAULT 'legacy';
        UPDATE project_repository_links
          SET link_status = 'legacy'
          WHERE link_status IS NULL OR link_status NOT IN ('active', 'legacy');
        ALTER TABLE project_repository_links
          ALTER COLUMN link_status SET DEFAULT 'legacy';
        ALTER TABLE project_repository_links
          ALTER COLUMN link_status SET NOT NULL;
        DO $$
        DECLARE
          constraint_defs text[];
          def text;
          normalized text;
          has_equivalent boolean := false;
        BEGIN
          SELECT array_agg(pg_get_constraintdef(c.oid) ORDER BY c.conname)
          INTO constraint_defs
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE t.relname = 'project_repository_links'
            AND n.nspname = current_schema()
            AND c.contype = 'c'
            AND pg_get_constraintdef(c.oid) LIKE '%link_status%';

          IF constraint_defs IS NOT NULL THEN
            FOREACH def IN ARRAY constraint_defs LOOP
              normalized := lower(regexp_replace(def, '[[:space:]]+', '', 'g'));
              normalized := replace(normalized, '"', '');
              normalized := replace(normalized, '''', '');
              IF normalized = 'check((link_status=any(array[active::text,legacy::text])))'
                 OR normalized = 'check(link_status=any(array[active::text,legacy::text]))'
                 OR normalized = 'check((link_statusin(active,legacy)))'
                 OR normalized = 'check(link_statusin(active,legacy))' THEN
                has_equivalent := true;
              ELSE
                RAISE EXCEPTION 'Incompatible existing link_status CHECK constraint on project_repository_links: %', def;
              END IF;
            END LOOP;
          END IF;

          IF NOT has_equivalent THEN
            ALTER TABLE project_repository_links
              ADD CONSTRAINT project_repository_links_link_status_check
              CHECK (link_status IN ('active', 'legacy'));
          END IF;
        END $$;

        CREATE INDEX IF NOT EXISTS project_repository_links_project_idx ON project_repository_links (project_id);
        CREATE INDEX IF NOT EXISTS project_repository_links_connection_idx ON project_repository_links (repository_connection_id);
        CREATE INDEX IF NOT EXISTS project_repository_links_owner_idx ON project_repository_links (owner_user_id);

        -- Single-repository enforcement (Stage 3.3):
        -- At most one active repository link per project.
        CREATE UNIQUE INDEX IF NOT EXISTS project_repository_links_active_project_idx
          ON project_repository_links (project_id) WHERE link_status = 'active';
        -- At most one active project assignment per repository connection per owner.
        CREATE UNIQUE INDEX IF NOT EXISTS project_repository_links_active_connection_owner_idx
          ON project_repository_links (repository_connection_id, owner_user_id) WHERE link_status = 'active';
      `);
      } finally {
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [918273645]);
        } catch {}
        client.release();
      }
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
