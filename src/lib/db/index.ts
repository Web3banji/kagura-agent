import { Pool } from "pg";

let pool: Pool | null = null;

export function hasDatabase(): boolean {
  return !!process.env.DATABASE_URL;
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
    initPromise = (async () => {
      const p = getPool();
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
      `);
    })();
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
