#!/usr/bin/env node
/**
 * Genuine two-principal HTTP/API integration tests against an ISOLATED disposable PostgreSQL DB.
 *
 * SAFETY / FAIL-CLOSED:
 * - Requires ISOLATED_PG_URL or ISOLATED_DATABASE_URL.
 * - Refuses if DATABASE_URL is set and equals isolated URL.
 * - Refuses non-disposable DB names (must include test/isolated/tmp/scratch/disposable).
 * - Never reads .env.local. Loads no app env files.
 * - Creates a fresh disposable database with a unique run id and writes a run marker inside that DB.
 * - Before any destructive cleanup, verifies exact db name + marker match for this run.
 * - Does NOT use DROP DATABASE ... WITH (FORCE). Cleanup terminates sessions for the exact target DB only,
 *   then drops the DB only when CONFIRM_ISOLATED_DB_CLEANUP=YES_DROP_DISPOSABLE is set.
 *   If confirmation is missing, the script leaves the disposable DB in place and reports it.
 *
 * NOT EXECUTED by this task. Do not run against shared/app DB.
 * Run with: node --import tsx scripts/test-security-http-isolated.mjs
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import process from 'node:process';
import { Pool } from 'pg';

const ISOLATED_URL = process.env.ISOLATED_PG_URL || process.env.ISOLATED_DATABASE_URL || '';
const APP_DB = process.env.DATABASE_URL || '';
const ROOT = process.cwd();
const RUN_ID = `kagura-http-isolated-${Date.now()}-${randomUUID()}`;
const CLEANUP_CONFIRM = process.env.CONFIRM_ISOLATED_DB_CLEANUP === 'YES_DROP_DISPOSABLE';

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }
function blocked(msg) { console.log(`BLOCKED: ${msg}`); process.exit(2); }
function assertDisposableDbName(name, label) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) fail(`${label} has unsafe characters: ${name}`);
  if (!/(test|isolated|tmp|scratch|disposable)/i.test(name)) fail(`${label} '${name}' is not disposable-named.`);
}
function sqlIdent(name) { assertDisposableDbName(name, 'SQL identifier'); return `"${name}"`; }

if (!ISOLATED_URL) {
  if (APP_DB) fail('DATABASE_URL is set but ISOLATED_PG_URL/ISOLATED_DATABASE_URL is not. Refusing to use app/shared DB.');
  blocked('set ISOLATED_PG_URL or ISOLATED_DATABASE_URL to an explicit disposable PostgreSQL database.');
}
if (APP_DB && ISOLATED_URL === APP_DB) fail('ISOLATED_URL matches DATABASE_URL; refusing.');
let isolated;
try { isolated = new URL(ISOLATED_URL); } catch { fail('Invalid ISOLATED_PG_URL'); }
const configuredDbName = isolated.pathname.replace(/^\//, '');
assertDisposableDbName(configuredDbName, 'Configured isolated DB name');

const adminUrl = new URL(ISOLATED_URL);
adminUrl.pathname = '/postgres';
const adminSsl = adminUrl.hostname.includes('localhost') || adminUrl.hostname === '127.0.0.1' ? false : { rejectUnauthorized: false };
const isolatedSsl = isolated.hostname.includes('localhost') || isolated.hostname === '127.0.0.1' ? false : { rejectUnauthorized: false };

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : null;
      srv.close((err) => err ? reject(err) : resolve(port));
    });
    srv.on('error', reject);
  });
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
}
async function waitForHttp(url, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url, { redirect: 'manual' }); if (r.status < 500) return r; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

let passed = 0; let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`); }
}
function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }
function makeSessionToken() { return randomBytes(32).toString('base64url'); }

async function assertAdminTarget(adminPool, disposableDb) {
  const r = await adminPool.query('SELECT current_database() AS db, inet_server_addr()::text AS host, inet_server_port() AS port');
  const row = r.rows[0] || {};
  if (row.db !== 'postgres') fail(`Administrative connection unexpected database: ${String(row.db)}`);
  if (row.port && Number(row.port) !== Number(adminUrl.port || 5432)) fail(`Administrative connection port mismatch: ${row.port}`);
  if (row.host && adminUrl.hostname !== 'localhost' && adminUrl.hostname !== '127.0.0.1' && row.host !== adminUrl.hostname) {
    console.warn(`WARN: admin inet_server_addr ${row.host} differs from URL host ${adminUrl.hostname}; continuing with exact DB name+marker checks.`);
  }
  assertDisposableDbName(disposableDb, 'Disposable DB');
}

async function createRunMarker(pool, disposableDb) {
  await pool.query('CREATE TABLE IF NOT EXISTS __kagura_isolated_harness_marker (run_id text primary key, db_name text not null, created_at timestamptz not null default now())');
  await pool.query('INSERT INTO __kagura_isolated_harness_marker (run_id, db_name) VALUES ($1,$2)', [RUN_ID, disposableDb]);
}

async function verifyRunMarker(adminPool, pool, disposableDb) {
  assertDisposableDbName(disposableDb, 'Disposable DB');
  const dbExists = await adminPool.query('SELECT 1 FROM pg_database WHERE datname=$1', [disposableDb]);
  if (dbExists.rowCount !== 1) fail(`Disposable DB does not exist or is not uniquely identifiable: ${disposableDb}`);
  const marker = await pool.query('SELECT run_id, db_name FROM __kagura_isolated_harness_marker WHERE run_id=$1', [RUN_ID]);
  if (marker.rowCount !== 1) fail('Run marker missing in disposable DB; refusing cleanup.');
  const row = marker.rows[0];
  if (row.db_name !== disposableDb) fail(`Run marker DB mismatch: marker=${row.db_name} target=${disposableDb}`);
}

async function cleanupDisposableDb(adminPool, disposableDbUrl, disposableDb) {
  const pool = new Pool({ connectionString: disposableDbUrl, ssl: isolatedSsl });
  try {
    await assertAdminTarget(adminPool, disposableDb);
    await verifyRunMarker(adminPool, pool, disposableDb);
  } finally {
    await pool.end().catch(() => {});
  }
  if (!CLEANUP_CONFIRM) {
    console.warn(`WARN: Disposable DB ${disposableDb} verified as this run's DB but not dropped. Set CONFIRM_ISOLATED_DB_CLEANUP=YES_DROP_DISPOSABLE to allow cleanup.`);
    return { dropped: false, reason: 'confirmation missing' };
  }
  const exists = await adminPool.query('SELECT 1 FROM pg_database WHERE datname=$1', [disposableDb]);
  if (exists.rowCount !== 1) fail(`Cleanup target disappeared or ambiguous: ${disposableDb}`);
  await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [disposableDb]);
  await adminPool.query(`DROP DATABASE ${sqlIdent(disposableDb)}`);
  const after = await adminPool.query('SELECT 1 FROM pg_database WHERE datname=$1', [disposableDb]);
  if (after.rowCount !== 0) fail(`Disposable DB still exists after drop: ${disposableDb}`);
  return { dropped: true };
}

function isFramework404(res, bodyText) {
  // Next.js missing route generally returns 404 with default not-found page or empty-ish body; app routes return JSON {error:...} when handled.
  // We treat as "route missing/unregistered" when status 404 and body does not look like our app JSON error shape for an existing handler.
  if (res.status !== 404) return false;
  const txt = (bodyText || '').trim();
  if (!txt) return true;
  try {
    const j = JSON.parse(txt);
    // Our handlers commonly return { error: "Not found" } for known route path misses inside handler.
    // Framework missing route also may return { error: "Not found" } in app router; therefore we cannot rely on body alone.
    // Route existence is verified separately via a known-good request to same route/method.
    return j?.error === 'Not found' || j?.error === 'Not Found';
  } catch {
    return /This page could not be found|404|not found/i.test(txt);
  }
}

async function main() {
  // Resolve canonical cookie name from actual implementation.
  const { SESSION_COOKIE_NAME } = await import('file://' + ROOT.replace(/\\/g, '/') + '/src/lib/auth/session.ts');
  if (typeof SESSION_COOKIE_NAME !== 'string' || !SESSION_COOKIE_NAME.includes('kagura.session')) {
    fail(`Unexpected SESSION_COOKIE_NAME: ${String(SESSION_COOKIE_NAME)}`);
  }

  const admin = new Pool({ connectionString: adminUrl.toString(), ssl: adminSsl });
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const disposableDb = `${configuredDbName}_run_${suffix}`.toLowerCase();
  assertDisposableDbName(disposableDb, 'Generated disposable DB');
  await assertAdminTarget(admin, disposableDb);

  const pre = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [disposableDb]);
  if (pre.rowCount !== 0) fail(`Refusing to reuse existing database: ${disposableDb}`);

  console.log(`Creating disposable DB ${disposableDb} for run ${RUN_ID}`);
  await admin.query(`CREATE DATABASE ${sqlIdent(disposableDb)}`);

  const isolatedDbUrl = new URL(ISOLATED_URL);
  isolatedDbUrl.pathname = `/${disposableDb}`;
  const dbUrl = isolatedDbUrl.toString();
  const pool = new Pool({ connectionString: dbUrl, ssl: isolatedSsl });

  let server;
  let cleanupState = { dropped: false, reason: 'not attempted' };
  try {
    await createRunMarker(pool, disposableDb);

    const initCode = `import { ensureDb, getPool } from './src/lib/db/index.ts'; await ensureDb(); const p=getPool(); await p.query('SELECT 1'); process.exit(0);`;
    const init = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', initCode], {
      env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: 'test', VERCEL: '', KAGURA_APP_URL: 'http://127.0.0.1:0' },
    });
    if (init.code !== 0) { console.error(init.out); console.error(init.err); fail('Failed to initialize isolated schema'); }

    const userA = randomUUID(); const userB = randomUUID();
    const tokenA = makeSessionToken(); const tokenB = makeSessionToken();
    await pool.query(`INSERT INTO users (id, email, name, is_bootstrap_owner, created_at, updated_at) VALUES ($1,$2,$3,false,NOW(),NOW()), ($4,$5,$6,false,NOW(),NOW())`, [userA, 'a@test.invalid', 'A', userB, 'b@test.invalid', 'B']);
    await pool.query(`INSERT INTO sessions (id, session_token_hash, user_id, expires, created_at, last_seen_at) VALUES ($1,$2,$3,NOW()+interval '1 day',NOW(),NOW()), ($4,$5,$6,NOW()+interval '1 day',NOW(),NOW())`, [randomUUID(), hashToken(tokenA), userA, randomUUID(), hashToken(tokenB), userB]);
    const projectA = randomUUID(); const projectB = randomUUID();
    await pool.query(`INSERT INTO projects (id, owner_user_id, name, slug, is_bootstrap, created_at, updated_at) VALUES ($1,$2,'A','a',false,NOW(),NOW()), ($3,$4,'B','b',false,NOW(),NOW())`, [projectA, userA, projectB, userB]);

    const port = await getFreePort();
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: 'production', PORT: String(port), KAGURA_APP_URL: base },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    await waitForHttp(`${base}/sign-in`, 120000);

    const cookieName = SESSION_COOKIE_NAME;
    const hA = { Cookie: `${cookieName}=${tokenA}`, 'Content-Type': 'application/json' };
    const hB = { Cookie: `${cookieName}=${tokenB}`, 'Content-Type': 'application/json' };
    const hNone = { 'Content-Type': 'application/json' };

    async function req(method, url, headers, body) {
      const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
      const txt = await r.text();
      let json; try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }
      return { status: r.status, json, text: txt, headers: r.headers };
    }

    // Route existence/wiring checks: prove route is registered by a known valid request.
    async function assertRouteExists(name, method, url, headers, body, expectedStatuses) {
      const r = await req(method, url, headers, body);
      const ok = expectedStatuses.includes(r.status);
      check(`route exists: ${name}`, ok, `got ${r.status}`);
      check(`route not framework-missing: ${name}`, !(r.status === 404 && isFramework404({ status: r.status }, r.text) && !expectedStatuses.includes(404)), `status 404 body=${r.text.slice(0,120)}`);
      return r;
    }

    // Unsupported method check: for existing route, unsupported method should be 405 (Next.js route handler default) or explicit 404/405 by app; assert not 200 and not app-auth success.
    async function assertUnsupportedMethod(name, method, url, headers, body) {
      const r = await req(method, url, headers, body);
      const ok = r.status === 405 || r.status === 404;
      check(`unsupported method guarded: ${name} ${method}`, ok, `got ${r.status}`);
      return r;
    }

    // --- Route existence probes (known-good authenticated requests) ---
    await assertRouteExists('GET /api/projects', 'GET', `${base}/api/projects`, hA, undefined, [200]);
    await assertRouteExists('GET /api/projects/:id/repositories', 'GET', `${base}/api/projects/${projectA}/repositories`, hA, undefined, [200]);
    await assertRouteExists('GET /api/verification/jobs', 'GET', `${base}/api/verification/jobs?projectId=${projectA}`, hA, undefined, [200]);
    await assertRouteExists('POST /api/verification/jobs', 'POST', `${base}/api/verification/jobs`, hA, { flow: 'shell-nav', objective: 'probe', url: base, projectId: projectA, timeout: 30 }, [200]);
    await assertRouteExists('POST /api/verification/run', 'POST', `${base}/api/verification/run`, hA, { flow: 'shell-nav', objective: 'probe', url: base, projectId: projectA, timeout: 30 }, [200]);
    await assertRouteExists('GET /api/investigations', 'GET', `${base}/api/investigations`, hA, undefined, [200]);
    await assertRouteExists('POST /api/investigations', 'POST', `${base}/api/investigations`, hA, { title: 'probe', technicalExplanation: 't', simpleExplanation: 's', projectId: projectA, severity: 'low', status: 'open' }, [201]);
    await assertRouteExists('GET /api/agent/status', 'GET', `${base}/api/agent/status`, hA, undefined, [200]);
    await assertRouteExists('POST /api/runner/claim', 'POST', `${base}/api/runner/claim`, hNone, {}, [401]); // route exists, auth required
    await assertRouteExists('POST /api/runner/complete', 'POST', `${base}/api/runner/complete`, hNone, { jobId: 'missing' }, [401]);
    await assertRouteExists('GET /api/github/observe', 'GET', `${base}/api/github/observe`, hA, undefined, [200]);

    // Unsupported method probes
    await assertUnsupportedMethod('GET /api/projects', 'PUT', `${base}/api/projects`, hA, {});
    await assertUnsupportedMethod('POST /api/verification/jobs', 'PUT', `${base}/api/verification/jobs?projectId=${projectA}`, hA, {});
    await assertUnsupportedMethod('GET /api/investigations', 'PUT', `${base}/api/investigations`, hA, {});

    // --- Authentication boundaries (exact 401) ---
    const unauthProjects = await req('GET', `${base}/api/projects`, hNone);
    check('unauth GET /api/projects returns 401', unauthProjects.status === 401, `got ${unauthProjects.status}`);
    const unauthJobs = await req('GET', `${base}/api/verification/jobs?projectId=${projectA}`, hNone);
    check('unauth GET /api/verification/jobs returns 401', unauthJobs.status === 401, `got ${unauthJobs.status}`);
    const unauthInv = await req('GET', `${base}/api/investigations`, hNone);
    check('unauth GET /api/investigations returns 401', unauthInv.status === 401, `got ${unauthInv.status}`);
    const unauthAgent = await req('GET', `${base}/api/agent/status`, hNone);
    check('unauth GET /api/agent/status returns 401', unauthAgent.status === 401, `got ${unauthAgent.status}`);
    const unauthClaim = await req('POST', `${base}/api/runner/claim`, hNone, {});
    check('unauth POST /api/runner/claim returns 401', unauthClaim.status === 401, `got ${unauthClaim.status}`);
    const unauthComplete = await req('POST', `${base}/api/runner/complete`, hNone, { jobId: randomUUID(), runnerId: 'r' });
    check('unauth POST /api/runner/complete returns 401', unauthComplete.status === 401, `got ${unauthComplete.status}`);

    // --- Project ownership ---
    const pA2 = await req('GET', `${base}/api/projects`, hA);
    check('A GET /api/projects returns only A project', pA2.status === 200 && Array.isArray(pA2.json?.projects) && pA2.json.projects.length === 1 && pA2.json.projects[0].id === projectA, `status ${pA2.status}`);
    const pB2 = await req('GET', `${base}/api/projects`, hB);
    check('B GET /api/projects returns only B project', pB2.status === 200 && Array.isArray(pB2.json?.projects) && pB2.json.projects.length === 1 && pB2.json.projects[0].id === projectB, `status ${pB2.status}`);
    check('A cannot see B project id in project list', !JSON.stringify(pA2.json).includes(projectB));
    check('B cannot see A project id in project list', !JSON.stringify(pB2.json).includes(projectA));

    // Cross-project repository access: handleProjectRepositoriesGet returns 404 when project not owned.
    const crossRepos = await req('GET', `${base}/api/projects/${projectB}/repositories`, hA);
    check('A GET B project repositories returns 404', crossRepos.status === 404, `got ${crossRepos.status} body=${crossRepos.text.slice(0,120)}`);
    const crossReposB = await req('GET', `${base}/api/projects/${projectA}/repositories`, hB);
    check('B GET A project repositories returns 404', crossReposB.status === 404, `got ${crossReposB.status}`);

    // --- Verification jobs ownership ---
    const jobA = await req('POST', `${base}/api/verification/jobs`, hA, { flow: 'shell-nav', objective: 'test A', url: base, projectId: projectA, timeout: 30 });
    check('A POST /api/verification/jobs own project returns 200', jobA.status === 200, `got ${jobA.status}`);
    check('A created job owned by A and projectA', jobA.json?.job?.requestedBy === userA && jobA.json?.job?.projectId === projectA, `body=${jobA.text.slice(0,200)}`);
    const jobAId = jobA.json?.job?.id;

    const jobBforA = await req('POST', `${base}/api/verification/jobs`, hB, { flow: 'shell-nav', objective: 'test B', url: base, projectId: projectA, timeout: 30 });
    check('B POST /api/verification/jobs for A project returns 404', jobBforA.status === 404, `got ${jobBforA.status} body=${jobBforA.text.slice(0,120)}`);

    const jobsA = await req('GET', `${base}/api/verification/jobs?projectId=${projectA}`, hA);
    check('A GET /api/verification/jobs own project returns 200', jobsA.status === 200, `got ${jobsA.status}`);
    check('A jobs list only contains A-owned jobs', Array.isArray(jobsA.json?.jobs) && jobsA.json.jobs.every(x => x.requestedBy === userA), `body=${jobsA.text.slice(0,200)}`);

    const jobsBCross = await req('GET', `${base}/api/verification/jobs?projectId=${projectA}`, hB);
    check('B GET /api/verification/jobs for A project returns 404', jobsBCross.status === 404, `got ${jobsBCross.status} body=${jobsBCross.text.slice(0,120)}`);

    // Verification run cross-project: handleRun checks visible projects and returns 404 for invisible project.
    const runBforA = await req('POST', `${base}/api/verification/run`, hB, { flow: 'shell-nav', url: base, objective: 'x', projectId: projectA, timeout: 30 });
    check('B POST /api/verification/run for A project returns 404', runBforA.status === 404, `got ${runBforA.status} body=${runBforA.text.slice(0,120)}`);
    const runNoProject = await req('POST', `${base}/api/verification/run`, hB, { flow: 'shell-nav', url: base, objective: 'x' });
    check('B POST /api/verification/run missing projectId returns 400', runNoProject.status === 400, `got ${runNoProject.status}`);

    // --- Investigations ownership ---
    const invA = await req('POST', `${base}/api/investigations`, hA, { title: 'A', technicalExplanation: 't', simpleExplanation: 's', projectId: projectA, severity: 'low', status: 'open', ownerUserId: userB });
    check('A POST /api/investigations returns 201', invA.status === 201, `got ${invA.status}`);
    check('A investigation owner is A despite foreign owner payload', invA.json?.investigation?.ownerUserId === userA, `body=${invA.text.slice(0,200)}`);
    const invAId = invA.json?.investigation?.id;

    const invBprojA = await req('POST', `${base}/api/investigations`, hB, { title: 'B', technicalExplanation: 't', simpleExplanation: 's', projectId: projectA, severity: 'low', status: 'open' });
    check('B POST /api/investigations for A project returns 404', invBprojA.status === 404, `got ${invBprojA.status} body=${invBprojA.text.slice(0,120)}`);

    const invListA = await req('GET', `${base}/api/investigations`, hA);
    check('A GET /api/investigations returns 200', invListA.status === 200, `got ${invListA.status}`);
    check('A investigation list scoped to A', Array.isArray(invListA.json?.investigations) && invListA.json.investigations.every(x => x.ownerUserId === userA));

    if (invAId) {
      const invGetB = await req('GET', `${base}/api/investigations/${invAId}`, hB);
      check('B GET A investigation returns 404', invGetB.status === 404, `got ${invGetB.status}`);

      const invPatchB = await req('PATCH', `${base}/api/investigations/${invAId}`, hB, { title: 'hijack', ownerUserId: userB });
      check('B PATCH A investigation returns 404', invPatchB.status === 404, `got ${invPatchB.status}`);

      const invPatchAOwner = await req('PATCH', `${base}/api/investigations/${invAId}`, hA, { ownerUserId: userB, projectId: projectB, title: 'owned' });
      check('A PATCH investigation ownership/project reassignment returns 200 (ignored by store) or 4xx; must not reassign', [200, 400, 403].includes(invPatchAOwner.status), `got ${invPatchAOwner.status}`);
      const invReadA = await req('GET', `${base}/api/investigations/${invAId}`, hA);
      check('A investigation owner unchanged after reassignment attempt', invReadA.status === 200 && invReadA.json?.investigation?.ownerUserId === userA, `body=${invReadA.text.slice(0,200)}`);
      check('A investigation project unchanged after reassignment attempt', invReadA.status === 200 && invReadA.json?.investigation?.projectId === projectA, `body=${invReadA.text.slice(0,200)}`);
    }

    // --- Agent status ---
    const agentStatusA = await req('GET', `${base}/api/agent/status`, hA);
    check('A GET /api/agent/status returns 200', agentStatusA.status === 200, `got ${agentStatusA.status}`);
    check('A agent status has runs array', Array.isArray(agentStatusA.json?.runs), `body=${agentStatusA.text.slice(0,120)}`);

    // --- Runner auth (exact 401, route exists) ---
    const claimNoAuth = await req('POST', `${base}/api/runner/claim`, hNone, {});
    check('POST /api/runner/claim without runner key returns 401', claimNoAuth.status === 401, `got ${claimNoAuth.status}`);
    const completeNoAuth = await req('POST', `${base}/api/runner/complete`, hNone, { jobId: jobAId || randomUUID(), runnerId: 'r1' });
    check('POST /api/runner/complete without runner key returns 401', completeNoAuth.status === 401, `got ${completeNoAuth.status}`);

    // --- GitHub observation status (privileged global, redacted for non-privileged) ---
    const obsA = await req('GET', `${base}/api/github/observe`, hA);
    check('A GET /api/github/observe returns 200', obsA.status === 200, `got ${obsA.status}`);
    check('A observation status is system-owned/redacted', obsA.json?.ownership === 'system' && !('events' in (obsA.json || {})), `body=${obsA.text.slice(0,200)}`);
    const obsB = await req('GET', `${base}/api/github/observe`, hB);
    check('B GET /api/github/observe returns 200', obsB.status === 200, `got ${obsB.status}`);
    check('B observation status is system-owned/redacted', obsB.json?.ownership === 'system' && !('events' in (obsB.json || {})), `body=${obsB.text.slice(0,200)}`);

    console.log(`RESULT passed=${passed} failed=${failed} run=${RUN_ID} db=${disposableDb}`);
    if (failed) process.exit(1);
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      if (!server.killed) try { server.kill('SIGKILL'); } catch {}
    }
    await pool.end().catch(() => {});
    try {
      cleanupState = await cleanupDisposableDb(admin, dbUrl, disposableDb);
    } catch (e) {
      console.error(`CLEANUP FAIL: ${e instanceof Error ? e.message : String(e)}`);
      cleanupState = { dropped: false, reason: 'cleanup failed' };
      process.exitCode = process.exitCode || 1;
    } finally {
      await admin.end().catch(() => {});
    }
    console.log(`CLEANUP dropped=${cleanupState.dropped} reason=${cleanupState.reason || 'ok'} db=${disposableDb}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
