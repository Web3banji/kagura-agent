import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import { ensureDb } from "../src/lib/db/index.ts";
import { completeJobAtomically } from "../src/lib/verification/completion.ts";

const REPO = process.cwd();
const ISOLATED_URL = process.env.ISOLATED_PG_URL || process.env.ISOLATED_DATABASE_URL || "";
const APP_DB = process.env.DATABASE_URL || "";
const RUN_ID = `kagura-smoke-${Date.now()}-${randomBytes(4).toString("hex")}`;
const PROJECT_ID = `p-${RUN_ID}`;
const RECORD_KEY = `verification:records:${PROJECT_ID}`;
const JOB_PATTERN = `j-${RUN_ID}-%`;
const RUNNER_ID = "smoke-runner";
const TOKEN = randomBytes(32).toString("hex");

let passed = 0;
let appProcess;
let appTempDir;
let pool;

function check(name, condition, detail) {
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  passed++;
  console.log(`PASS ${name}`);
}

function fail(message) {
  throw new Error(message);
}

function validateIsolatedUrl(raw) {
  if (!raw) fail("ISOLATED_PG_URL or ISOLATED_DATABASE_URL is required");
  if (APP_DB && APP_DB === raw) fail("ISOLATED URL matches existing DATABASE_URL; refusing");
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("ISOLATED URL is invalid");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    fail("ISOLATED URL must use PostgreSQL protocol");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    fail("ISOLATED URL host must be loopback");
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) fail("ISOLATED database name has unsafe characters");
  if (!/(test|isolated|tmp|scratch|disposable)/i.test(dbName)) {
    fail("ISOLATED database name is not disposable-named");
  }
  return { url, dbName };
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function waitForHttp(base, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(base, { redirect: "manual" });
      if (res.status < 500) return res;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail("Isolated application did not become ready");
}

async function makeAppDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kagura-smoke-app-"));
  await fs.copyFile(path.join(REPO, "package.json"), path.join(dir, "package.json"));
  await fs.copyFile(path.join(REPO, "next.config.mjs"), path.join(dir, "next.config.mjs"));
  await fs.cp(path.join(REPO, ".next"), path.join(dir, ".next"), { recursive: true });
  await fs.symlink(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "junction");
  return dir;
}

function childEnv(base, port) {
  const env = {
    DATABASE_URL: ISOLATED_URL,
    KAGURA_RUNNER_TOKEN: TOKEN,
    KAGURA_APP_URL: base,
    NODE_ENV: "production",
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: "1",
    PATH: process.env.PATH || "",
    SystemRoot: process.env.SystemRoot || "",
    windir: process.env.windir || "",
    TEMP: process.env.TEMP || "",
    TMP: process.env.TMP || "",
    HOME: process.env.HOME || process.env.USERPROFILE || "",
    USERPROFILE: process.env.USERPROFILE || "",
    APPDATA: process.env.APPDATA || "",
    LOCALAPPDATA: process.env.LOCALAPPDATA || "",
  };
  delete env.VERCEL;
  return env;
}

async function startApp() {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  appTempDir = await makeAppDir();
  const nextBin = path.join(REPO, "node_modules", "next", "dist", "bin", "next");
  appProcess = spawn(process.execPath, [nextBin, "start", "--dir", appTempDir, "-p", String(port)], {
    cwd: appTempDir,
    env: childEnv(base, port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  appProcess.stdout.on("data", (chunk) => {
    logs = `${logs}${chunk}`.slice(-4000);
  });
  appProcess.stderr.on("data", (chunk) => {
    logs = `${logs}${chunk}`.slice(-4000);
  });
  appProcess.on("error", () => {});
  await waitForHttp(base);
  return base;
}

async function stopApp() {
  if (!appProcess || appProcess.exitCode !== null) return;
  appProcess.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    appProcess.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (appProcess.exitCode === null) appProcess.kill("SIGKILL");
}

async function claim(base, runnerId = RUNNER_ID) {
  const res = await fetch(`${base}/api/runner/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId }),
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  return { status: res.status, body };
}

async function complete(base, body) {
  const res = await fetch(`${base}/api/runner/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: res.status, body: parsed };
}

function completionBody(job, extra = {}) {
  const finishedAt = new Date().toISOString();
  return {
    jobId: job.id,
    runnerId: RUNNER_ID,
    exitCode: 1,
    outcome: "failed",
    summary: "isolated smoke",
    startedAt: job.startedAt || finishedAt,
    finishedAt,
    ...extra,
  };
}

function completionInput(job, generation = job.claimGeneration ?? 0) {
  const finishedAt = new Date().toISOString();
  const startedAt = job.startedAt || finishedAt;
  return {
    job: { ...job, claimGeneration: generation },
    runnerId: RUNNER_ID,
    record: {
      id: job.id,
      jobId: job.id,
      flow: job.flow,
      objective: job.objective,
      url: job.url,
      outcome: "failed",
      summary: "isolated smoke",
      startedAt,
      finishedAt,
      source: "runner",
      projectId: job.projectId,
      requestedBy: job.requestedBy,
    },
    result: {
      outcome: "failed",
      summary: "isolated smoke",
      exitCode: 1,
      startedAt,
      finishedAt,
    },
    outcome: "failed",
    jobStatus: "failed",
    finishedAt,
  };
}

async function insertJob({ id, status, requestedBy, payload, claimed = false, generation = 0 }) {
  const lease = claimed ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null;
  await pool.query(
    `INSERT INTO verification_jobs (
      id, project_id, requested_by, status, payload, created_at, updated_at,
      claimed_at, lease_expires_at, claimed_by, runner_id, record_id, claim_generation
    ) VALUES ($1,$2,$3,$4,$5::jsonb,NOW(),NOW(),$6,$7,$8,$9,NULL,$10)`,
    [
      id,
      PROJECT_ID,
      requestedBy,
      status,
      JSON.stringify(payload),
      claimed ? new Date().toISOString() : null,
      lease,
      claimed ? RUNNER_ID : null,
      claimed ? RUNNER_ID : null,
      generation,
    ],
  );
}

async function jobRow(id) {
  const res = await pool.query("SELECT * FROM verification_jobs WHERE id = $1", [id]);
  return res.rows[0] || null;
}

async function recordValue() {
  const res = await pool.query("SELECT value FROM echolog_kv WHERE key = $1", [RECORD_KEY]);
  if (!res.rows[0]) return [];
  return Array.isArray(res.rows[0].value) ? res.rows[0].value : [];
}

async function outboxRows() {
  const res = await pool.query(
    "SELECT job_id, status FROM verification_processing_outbox WHERE job_id LIKE $1 ORDER BY job_id",
    [JOB_PATTERN],
  );
  return res.rows;
}

function payloadFor(owner) {
  return {
    flow: "shell-nav",
    objective: "isolated smoke",
    url: "http://127.0.0.1",
    ...(owner ? { requestedBy: owner } : {}),
  };
}

async function cleanup() {
  if (!pool) return;
  await pool.query("DELETE FROM verification_processing_outbox WHERE job_id LIKE $1", [JOB_PATTERN]);
  await pool.query("DELETE FROM verification_jobs WHERE id LIKE $1", [JOB_PATTERN]);
  await pool.query("DELETE FROM echolog_kv WHERE key = $1", [RECORD_KEY]);
  const jobs = await pool.query("SELECT COUNT(*)::int AS count FROM verification_jobs WHERE id LIKE $1", [JOB_PATTERN]);
  const outbox = await pool.query("SELECT COUNT(*)::int AS count FROM verification_processing_outbox WHERE job_id LIKE $1", [JOB_PATTERN]);
  const records = await pool.query("SELECT COUNT(*)::int AS count FROM echolog_kv WHERE key = $1", [RECORD_KEY]);
  check("cleanup removes only this run namespace", jobs.rows[0].count === 0 && outbox.rows[0].count === 0 && records.rows[0].count === 0);
}

async function main() {
  const { dbName } = validateIsolatedUrl(ISOLATED_URL);
  console.log(`ISOLATED_DB ${dbName}`);
  console.log(`RUN_ID ${RUN_ID}`);

  process.env.DATABASE_URL = ISOLATED_URL;
  process.env.NODE_ENV = "production";
  delete process.env.VERCEL;

  await ensureDb();

  pool = new pg.Pool({ connectionString: ISOLATED_URL, ssl: false });
  const identity = await pool.query("SELECT current_database() AS db, inet_server_port() AS port");
  check("connected database identity matches isolated target", identity.rows[0].db === dbName, `port=${identity.rows[0].port}`);

  const base = await startApp();

  const aId = `j-${RUN_ID}-a`;
  const bId = `j-${RUN_ID}-b`;
  const cId = `j-${RUN_ID}-c`;
  const c2Id = `j-${RUN_ID}-c2`;
  const staleId = `j-${RUN_ID}-stale`;

  await insertJob({ id: aId, status: "pending", requestedBy: "smoke-owner", payload: payloadFor("smoke-owner") });
  await insertJob({ id: bId, status: "pending", requestedBy: "", payload: payloadFor("smoke-owner") });
  await insertJob({ id: cId, status: "pending", requestedBy: "", payload: payloadFor("") });
  await insertJob({ id: c2Id, status: "claimed", requestedBy: "", payload: payloadFor(""), claimed: true, generation: 1 });
  await insertJob({ id: staleId, status: "claimed", requestedBy: "smoke-owner", payload: payloadFor("smoke-owner"), claimed: true, generation: 1 });

  const aClaim = await claim(base);
  check("Case A claim returns 200", aClaim.status === 200, `status=${aClaim.status}`);
  check("Case A claim preserves database owner", aClaim.body?.job?.requestedBy === "smoke-owner");

  const aWrongRunner = await complete(base, completionBody(aClaim.body.job, { runnerId: "other-runner" }));
  check("wrong runner is rejected with 403", aWrongRunner.status === 403, `status=${aWrongRunner.status}`);
  check("wrong runner does not mutate job", (await jobRow(aId)).status === "claimed");

  const aComplete = await complete(base, completionBody(aClaim.body.job));
  check("Case A completion returns 200", aComplete.status === 200, `status=${aComplete.status}`);
  check("Case A completion body is ok", aComplete.body?.ok === true);
  const aRow = await jobRow(aId);
  check("Case A persisted job is failed", aRow.status === "failed");
  const aRecord = (await recordValue()).find((r) => r.jobId === aId);
  check("Case A completion record preserves owner", aRecord?.requestedBy === "smoke-owner");

  const bClaim = await claim(base);
  check("Case B claim returns 200", bClaim.status === 200, `status=${bClaim.status}`);
  check("Case B payload-only owner is resolved", bClaim.body?.job?.requestedBy === "smoke-owner");

  const bConflict = await complete(base, completionBody(bClaim.body.job, { requestedBy: "intruder" }));
  check("conflicting body owner is rejected with 403", bConflict.status === 403, `status=${bConflict.status}`);
  check("conflicting body owner does not mutate job", (await jobRow(bId)).status === "claimed");
  check("conflicting body owner creates no record", !(await recordValue()).some((r) => r.jobId === bId));

  const bComplete = await complete(base, completionBody(bClaim.body.job));
  check("Case B completion returns 200", bComplete.status === 200, `status=${bComplete.status}`);
  const bRow = await jobRow(bId);
  check("Case B persisted job is failed", bRow.status === "failed");
  const bRecord = (await recordValue()).find((r) => r.jobId === bId);
  check("Case B completion record preserves payload owner", bRecord?.requestedBy === "smoke-owner");

  const cClaim = await claim(base);
  check("Case C claim returns 204", cClaim.status === 204, `status=${cClaim.status}`);
  check("Case C claim has no job body", cClaim.body === null);
  check("Case C pending job remains unclaimed", (await jobRow(cId)).status === "pending");

  const cComplete = await complete(base, completionBody({ id: c2Id, startedAt: new Date().toISOString() }));
  check("Case C completion returns 409", cComplete.status === 409, `status=${cComplete.status}`);
  const c2Row = await jobRow(c2Id);
  check("Case C job remains claimed", c2Row.status === "claimed");
  check("Case C job has no record id", c2Row.record_id === null);
  check("Case C creates no completion record", !(await recordValue()).some((r) => r.jobId === c2Id));

  const staleRow = await jobRow(staleId);
  let staleError;
  try {
    await completeJobAtomically(completionInput(staleRow, 0));
  } catch (err) {
    staleError = err;
  }
  check("stale claim generation is rejected", !!staleError && /claim generation mismatch/i.test(String(staleError.message)));
  check("stale claim generation does not mutate job", (await jobRow(staleId)).status === "claimed");

  const outbox = await outboxRows();
  check("successful completions create outbox rows", outbox.some((r) => r.job_id === aId) && outbox.some((r) => r.job_id === bId));
  check("failed cases create no outbox rows", !outbox.some((r) => r.job_id === c2Id || r.job_id === staleId));

  await cleanup();
  await stopApp();
  await pool.end();
  pool = null;
  await fs.rm(appTempDir, { recursive: true, force: true });
  appTempDir = null;
  console.log(`\n${passed} isolated PostgreSQL checks passed`);
}

main().catch(async (err) => {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  try {
    await cleanup();
  } catch {}
  await stopApp();
  if (pool) await pool.end();
  if (appTempDir) await fs.rm(appTempDir, { recursive: true, force: true });
  process.exit(1);
});