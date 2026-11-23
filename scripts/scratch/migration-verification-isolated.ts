import process from "node:process";
import { Pool, type PoolClient } from "pg";

/**
 * Stage 3.3.8 - Isolated PostgreSQL migration verification.
 *
 * Uses disposable databases/schemas on the configured PostgreSQL server only when
 * an explicit ISOLATED_PG_URL/ISOLATED_DATABASE_URL is provided. It never targets
 * the app DATABASE_URL and never runs ensureDb().
 *
 * Run: npx tsx scripts/scratch/migration-verification-isolated.ts
 */

type LinkRow = { id: string; project_id: string; repository_connection_id: string; owner_user_id: string; link_status?: string | null };

const ISOLATED_URL = process.env.ISOLATED_PG_URL || process.env.ISOLATED_DATABASE_URL || "";
const MIGRATION_SQL = `
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
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'project_repository_links'
      AND n.nspname = current_schema()
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%link_status%'
  ) THEN
    ALTER TABLE project_repository_links
      ADD CONSTRAINT project_repository_links_link_status_check
      CHECK (link_status IN ('active', 'legacy'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS project_repository_links_active_project_idx
  ON project_repository_links (project_id) WHERE link_status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS project_repository_links_active_connection_owner_idx
  ON project_repository_links (repository_connection_id, owner_user_id) WHERE link_status = 'active';
`;

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

async function runSql(client: PoolClient, sql: string) {
  await client.query(sql);
}

async function setupPreMigration(client: PoolClient) {
  await client.query(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      UNIQUE (id, owner_user_id)
    );
    CREATE TABLE repository_connections (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'github',
      github_repo_id TEXT NOT NULL,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      UNIQUE (id, owner_user_id)
    );
    CREATE TABLE project_repository_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      repository_connection_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, repository_connection_id),
      FOREIGN KEY (project_id, owner_user_id) REFERENCES projects(id, owner_user_id) ON DELETE CASCADE,
      FOREIGN KEY (repository_connection_id, owner_user_id) REFERENCES repository_connections(id, owner_user_id) ON DELETE RESTRICT
    );
  `);
  await client.query(`INSERT INTO users(id) VALUES ('u1'),('u2')`);
  await client.query(`INSERT INTO projects(id,owner_user_id,name,slug) VALUES
    ('p-multi','u1','Multi','multi'),
    ('p-shared-a','u1','Shared A','shared-a'),
    ('p-shared-b','u1','Shared B','shared-b'),
    ('p-legacy-active','u1','Legacy Active','legacy-active')`);
  await client.query(`INSERT INTO repository_connections(id,owner_user_id,provider,github_repo_id,repo_owner,repo_name,full_name) VALUES
    ('c1','u1','github','1','o','r1','o/r1'),
    ('c2','u1','github','2','o','r2','o/r2'),
    ('c-shared','u1','github','3','o','shared','o/shared'),
    ('c4','u1','github','4','o','r4','o/r4'),
    ('c5','u1','github','5','o','r5','o/r5')`);
  await client.query(`INSERT INTO project_repository_links(id,project_id,repository_connection_id,owner_user_id) VALUES
    ('l-multi-1','p-multi','c1','u1'),
    ('l-multi-2','p-multi','c2','u1'),
    ('l-shared-a','p-shared-a','c-shared','u1'),
    ('l-shared-b','p-shared-b','c-shared','u1'),
    ('l-legacy','p-legacy-active','c4','u1')`);
}

async function verify(dbName: string) {
  const admin = new Pool({ connectionString: ISOLATED_URL, ssl: { rejectUnauthorized: false } });
  const dbPool = new Pool({ connectionString: ISOLATED_URL.replace(/\/[^/?#]+(\?|#|$)/, `/${dbName}$1`), ssl: { rejectUnauthorized: false } });
  const client = await dbPool.connect();
  try {
    console.log(`Using isolated database: ${dbName}`);
    await setupPreMigration(client);

    const before = await client.query<LinkRow>(`SELECT id,project_id,repository_connection_id,owner_user_id FROM project_repository_links ORDER BY id`);
    assert(before.rowCount === 5, "pre-migration link count");

    await runSql(client, "BEGIN");
    await runSql(client, MIGRATION_SQL);
    await runSql(client, "COMMIT");

    const cols = await client.query(`SELECT column_name,column_default,is_nullable FROM information_schema.columns WHERE table_name='project_repository_links' AND column_name='link_status'`);
    assert(cols.rowCount === 1, "link_status column exists");
    assert(String(cols.rows[0].column_default).includes("legacy"), "default legacy");
    assert(cols.rows[0].is_nullable === "NO", "not null");

    const after = await client.query<LinkRow>(`SELECT id,project_id,repository_connection_id,owner_user_id,link_status FROM project_repository_links ORDER BY id`);
    assert(after.rowCount === 5, "no rows lost");
    for (const r of after.rows) assert(r.link_status === "legacy", `row ${r.id} became legacy`);

    const indexes = await client.query(`SELECT indexdef FROM pg_indexes WHERE tablename='project_repository_links'`);
    const defs = indexes.rows.map((r) => String(r.indexdef));
    assert(defs.some((d) => d.includes("project_repository_links_active_project_idx") && d.includes("WHERE (link_status = 'active'::text)")), "active project index");
    assert(defs.some((d) => d.includes("project_repository_links_active_connection_owner_idx") && d.includes("WHERE (link_status = 'active'::text)")), "active connection-owner index");

    // Preserve valid active on repeated run
    await client.query(`UPDATE project_repository_links SET link_status='active' WHERE id='l-legacy'`);
    await runSql(client, "BEGIN");
    await runSql(client, MIGRATION_SQL);
    await runSql(client, "COMMIT");
    const preserved = await client.query<LinkRow>(`SELECT id,link_status FROM project_repository_links WHERE id='l-legacy'`);
    assert(preserved.rows[0].link_status === "active", "valid active preserved on repeat");

    // Historical multi-link/shared legacy preserved
    const multi = await client.query(`SELECT count(*)::int AS c FROM project_repository_links WHERE project_id='p-multi' AND link_status='legacy'`);
    assert(multi.rows[0].c === 2, "multiple legacy links for one project preserved");
    const shared = await client.query(`SELECT count(*)::int AS c FROM project_repository_links WHERE repository_connection_id='c-shared' AND link_status='legacy'`);
    assert(shared.rows[0].c === 2, "shared legacy repo relationship preserved");

    // Active uniqueness enforcement
    let rejected = false;
    try {
      await client.query(`INSERT INTO project_repository_links(id,project_id,repository_connection_id,owner_user_id,link_status) VALUES ('l-dupe-project','p-legacy-active','c5','u1','active')`);
    } catch (e) {
      rejected = String((e as { code?: string }).code) === "23505";
    }
    assert(rejected, "second active for project rejected");

    rejected = false;
    try {
      await client.query(`UPDATE project_repository_links SET link_status='active' WHERE id='l-shared-b'`);
      await client.query(`UPDATE project_repository_links SET link_status='active' WHERE id='l-shared-a'`); // same repo+owner active in other project
    } catch (e) {
      rejected = String((e as { code?: string }).code) === "23505";
    }
    assert(rejected, "active repo shared across projects rejected");

    console.log("PASS: migration verification on isolated database");
  } finally {
    client.release();
    await dbPool.end();
    await admin.end();
  }
}

async function main() {
  if (!ISOLATED_URL) {
    console.log("SKIP: set ISOLATED_PG_URL (or ISOLATED_DATABASE_URL) to a disposable PostgreSQL server URL. No configured app DB used.");
    process.exit(0);
  }
  const admin = new Pool({ connectionString: ISOLATED_URL, ssl: { rejectUnauthorized: false } });
  const dbName = `kagura_mig_${Date.now().toString(36)}`;
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  const admin2 = new Pool({ connectionString: ISOLATED_URL, ssl: { rejectUnauthorized: false } });
  try {
    await verify(dbName);
  } finally {
    await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin2.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });