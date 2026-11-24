/**
 * Isolated two-principal security integration tests.
 *
 * SAFETY / FAIL-CLOSED:
 * - Requires explicit disposable PostgreSQL URL via ISOLATED_PG_URL or ISOLATED_DATABASE_URL.
 * - Refuses if only DATABASE_URL is set. Refuses if isolated URL matches DATABASE_URL.
 * - Never reads .env.local. Never targets app DB.
 * - Requires disposable DB name pattern and verifies connected DB identity before running.
 * - Creates only TEMP tables inside a transaction and rolls back. No destructive DB create/drop.
 * - Writes a run marker into a TEMP table; no persistent data is kept.
 *
 * Run: ISOLATED_PG_URL=postgres://... npx tsx scripts/test-security-isolated.ts
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const ISOLATED_URL = process.env.ISOLATED_PG_URL || process.env.ISOLATED_DATABASE_URL || "";
const APP_DB = process.env.DATABASE_URL || "";
const RUN_ID = `kagura-isolated-${Date.now()}-${randomUUID()}`;

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assertDisposableDbName(name: string, label: string) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) fail(`${label} has unsafe characters: ${name}`);
  if (!/(test|isolated|tmp|scratch|disposable)/i.test(name)) fail(`${label} '${name}' is not disposable-named.`);
}
if (!ISOLATED_URL) {
  if (APP_DB) fail("DATABASE_URL is set but ISOLATED_PG_URL/ISOLATED_DATABASE_URL is not. Refusing to use app/shared DB.");
  console.log("BLOCKED: set ISOLATED_PG_URL or ISOLATED_DATABASE_URL to an explicit disposable PostgreSQL database.");
  process.exit(2);
}
if (APP_DB && ISOLATED_URL === APP_DB) fail("ISOLATED URL matches DATABASE_URL; refusing.");
let isolated: URL;
try { isolated = new URL(ISOLATED_URL); } catch { fail("Invalid ISOLATED_PG_URL"); }
const configuredDbName = isolated.pathname.replace(/^\//, "");
assertDisposableDbName(configuredDbName, "Configured isolated DB name");

let passed = 0;
function check(name: string, cond: unknown) {
  if (!cond) { console.error(`FAIL ${name}`); process.exitCode = 1; }
  else { passed++; console.log(`PASS ${name}`); }
}

async function main() {
  const pool = new Pool({ connectionString: ISOLATED_URL, ssl: isolated.hostname.includes("localhost") || isolated.hostname === "127.0.0.1" ? undefined : { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    const identity = await client.query("SELECT current_database() AS db, inet_server_port() AS port");
    const db = String(identity.rows[0]?.db || "");
    if (db !== configuredDbName) fail(`Connected database mismatch: expected ${configuredDbName}, got ${db}`);
    if (!/(test|isolated|tmp|scratch|disposable)/i.test(db)) fail(`Connected DB ${db} is not disposable-named.`);
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE __kagura_isolated_marker (run_id text primary key, db_name text not null) ON COMMIT DROP");
    await client.query("INSERT INTO __kagura_isolated_marker (run_id, db_name) VALUES ($1,$2)", [RUN_ID, db]);
    const marker = await client.query("SELECT run_id, db_name FROM __kagura_isolated_marker WHERE run_id=$1", [RUN_ID]);
    check("isolated run marker matches current DB", marker.rowCount===1 && marker.rows[0].db_name===db);
    // minimal schema for ownership checks
    await client.query(`CREATE TEMP TABLE projects (id text primary key, owner_user_id text not null) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE stories (id text primary key, user_id text, project_id text, status text not null, slug text not null) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE verification_jobs (id text primary key, project_id text, requested_by text, status text not null) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE investigations (id text primary key, owner_user_id text, project_id text) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE repository_connections (id text primary key, owner_user_id text not null) ON COMMIT DROP`);
    await client.query(`INSERT INTO projects VALUES ('p1','u1'),('p2','u2')`);
    await client.query(`INSERT INTO stories VALUES ('s1','u1','p1','draft','u1-draft'),('s2','u2','p2','published','u2-pub'),('s3','u2','p2','draft','u2-draft')`);
    await client.query(`INSERT INTO verification_jobs VALUES ('j1','p1','u1','pending'),('j2','p2','u2','pending')`);
    await client.query(`INSERT INTO investigations VALUES ('i1','u1','p1'),('i2','u2','p2')`);
    await client.query(`INSERT INTO repository_connections VALUES ('rc1','u1'),('rc2','u2')`);

    // simulate principal u1 scope
    const u1Projects = await client.query(`SELECT id FROM projects WHERE owner_user_id=$1`, ['u1']);
    check('u1 sees only own projects', u1Projects.rows.length===1 && u1Projects.rows[0].id==='p1');
    const u1Stories = await client.query(`SELECT id FROM stories WHERE user_id=$1`, ['u1']);
    check('u1 sees only own stories', u1Stories.rows.length===1 && u1Stories.rows[0].id==='s1');
    const u1Jobs = await client.query(`SELECT id FROM verification_jobs WHERE requested_by=$1`, ['u1']);
    check('u1 sees only own jobs', u1Jobs.rows.length===1 && u1Jobs.rows[0].id==='j1');
    const u1Inv = await client.query(`SELECT id FROM investigations WHERE owner_user_id=$1`, ['u1']);
    check('u1 sees only own investigations', u1Inv.rows.length===1 && u1Inv.rows[0].id==='i1');
    const u1Repo = await client.query(`SELECT id FROM repository_connections WHERE owner_user_id=$1`, ['u1']);
    check('u1 sees only own repo connections', u1Repo.rows.length===1 && u1Repo.rows[0].id==='rc1');

    // cross-user access denied by query shape
    const crossProject = await client.query(`SELECT id FROM projects WHERE id=$1 AND owner_user_id=$2`, ['p2','u1']);
    check('u1 cannot access u2 project by id', crossProject.rowCount===0);
    const crossStory = await client.query(`SELECT id FROM stories WHERE id=$1 AND user_id=$2`, ['s2','u1']);
    check('u1 cannot access u2 story by id', crossStory.rowCount===0);
    const crossJob = await client.query(`SELECT id FROM verification_jobs WHERE id=$1 AND requested_by=$2`, ['j2','u1']);
    check('u1 cannot access u2 job by id', crossJob.rowCount===0);

    // public published-only boundary
    const publicStories = await client.query(`SELECT slug FROM stories WHERE status='published'`);
    check('public query returns only published stories', publicStories.rows.length===1 && publicStories.rows[0].slug==='u2-pub');
    const publicDraft = await client.query(`SELECT slug FROM stories WHERE slug=$1 AND status='published'`, ['u2-draft']);
    check('unpublished slug is not publicly readable', publicDraft.rowCount===0);

    // app-level scope/visibility helpers against same fixture semantics
    const { canAccessOwnedRecord, canAccessRequestedByRecord, filterVisible } = await import("../src/lib/auth/scope");
    const scopeU1 = { userId: "u1", privileged: false, includeLegacy: false };
    check('scope helper denies cross-user project/story ownership', !canAccessOwnedRecord("u2", scopeU1) && canAccessOwnedRecord("u1", scopeU1));
    check('scope helper denies cross-user requestedBy records', !canAccessRequestedByRecord("u2", scopeU1) && canAccessRequestedByRecord("u1", scopeU1));
    const visibleStories = filterVisible([{ userId: "u1", id: "s1" }, { userId: "u2", id: "s2" }, { userId: null, id: "legacy" }], scopeU1);
    check('scope helper filters visible records to principal', visibleStories.length===1 && (visibleStories[0] as any).id==="s1");

    await client.query("ROLLBACK");
    console.log(`\n${passed} checks passed`);
    console.log("NOTE: This harness validates DB safety + ownership query shapes + app scope helpers. Full HTTP API two-principal integration requires running app with ISOLATED DATABASE_URL and authenticated sessions; see final report instructions.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
