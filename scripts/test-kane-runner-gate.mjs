/**
 * Deterministic runner gate tests for KANE readiness/isolation lifecycle.
 * No KANE CLI execution, no browser, no DB, no real network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { READINESS_STATES } from "./kane-readiness.mjs";
import { runRunnerLoop } from "./kane-runner.mjs";

let passed = 0;
function check(name, cond) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }

function mkTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-runner-gate-"));
  const pendingSyncDir = path.join(root, "data", "verification", "pending-sync");
  fs.mkdirSync(pendingSyncDir, { recursive: true });
  return { root, pendingSyncDir };
}

function makeDeps(overrides = {}) {
  const calls = { claim: 0, complete: [], heartbeats: [], execute: 0, sync: 0 };
  const readiness = overrides.readiness ?? { state: READINESS_STATES.READY, ready: true, reason: "Kane CLI authenticated." };
  const isolationOk = overrides.isolationOk ?? true;
  const jobs = [...(overrides.jobs ?? [])];
  const completeStatus = overrides.completeStatus ?? 200;
  const completeFailTimes = overrides.completeFailTimes ?? 0;
  const deps = {
    disableSignals: true,
    maxJobs: overrides.maxJobs ?? 1,
    cfg: { base: "http://127.0.0.1:1", token: "t", pollMs: 1, heartbeatMs: 60000, maxBackoffMs: 5 },
    isolation: { mode: "account", isolateAllJobs: overrides.isolateAllJobs ?? false, sandboxUser: "sandbox", profilesRoot: overrides.profilesRoot || os.tmpdir(), workspacesRoot: overrides.workspacesRoot || os.tmpdir(), repoRoot: overrides.root || process.cwd() },
    runnerId: "runner-test",
    version: "test",
    assessReadiness: async () => ({ ...readiness, checkedAt: new Date().toISOString() }),
    assessIsolation: async () => ({ ok: isolationOk, reason: isolationOk ? "ok" : "sandbox account missing" }),
    requiresIsolation: (job, isolateAll) => isolateAll || !!job.requestedBy,
    executeKaneJob: async (job) => {
      calls.execute++;
      return { jobId: job.id, runnerId: "runner-test", claimedBy: "runner-test", outcome: "passed", exitCode: 0, summary: "ok", runEnd: { status: "passed" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    },
    apiRequest: async (_cfg, _method, pathname) => {
      if (pathname === "/api/runner/heartbeat") { calls.heartbeats.push(_method); return { status: 200, data: { ok: true } }; }
      if (pathname === "/api/runner/claim") { calls.claim++; const job = jobs.shift(); return job ? { status: 200, data: { job } } : { status: 204, data: null }; }
      if (pathname === "/api/runner/complete") return { status: 200, data: { ok: true } };
      return { status: 404, data: null };
    },
    syncCompletionWithRetry: async (_cfg, payload) => {
      calls.sync++;
      calls.complete.push(payload);
      if (calls.sync <= completeFailTimes) return { ok: false, status: 503, reason: "unavailable" };
      return { ok: completeStatus >= 200 && completeStatus < 300, status: completeStatus, reason: completeStatus === 200 ? undefined : `HTTP ${completeStatus}` };
    },
    enqueuePendingSync: async (payload, reason, nonRetriable) => { calls.complete.push({ ...payload, __enqueued: true, __reason: reason, __nonRetriable: nonRetriable }); return "/tmp/pending.json"; },
    sleep: async () => {},
    flushSyncQueue: async () => ({ flushed: 0 }),
    pruneStaleWorkspaces: async () => ({ removed: 0 }),
    ...overrides.deps,
  };
  return { deps, calls, jobs };
}

async function main() {
  const baseJob = { id: "job-1", flow: "shell-nav", objective: "o", url: "http://localhost:3000", projectId: "p1", requestedBy: "u1", recordId: "job-1", claimGeneration: 0 };

  {
    const { deps, calls } = makeDeps({ jobs: [{ ...baseJob }] });
    const res = await runRunnerLoop(deps);
    check("ready+isolated allows execution path", res.exitCode === 0 && calls.execute === 1);
    check("ready+isolated completes through completion sync", calls.complete.length === 1 && calls.complete[0].outcome === "passed");
  }

  for (const [name, readiness] of [
    ["unauthenticated", { state: READINESS_STATES.KANE_UNAUTHENTICATED, ready: false, reason: "auth required" }],
    ["expired/rejected", { state: READINESS_STATES.KANE_AUTH_EXPIRED, ready: false, reason: "expired" }],
    ["missing executable", { state: READINESS_STATES.KANE_MISSING, ready: false, reason: "missing" }],
    ["unknown/timeout", { state: READINESS_STATES.UNKNOWN, ready: false, reason: "timeout" }],
  ]) {
    const { deps, calls } = makeDeps({ jobs: [{ ...baseJob, id: `job-${name}` }], readiness });
    await runRunnerLoop(deps);
    check(`${name} does not spawn KANE`, calls.execute === 0);
    check(`${name} completes as did_not_start`, calls.complete[0]?.outcome === "did_not_start");
    check(`${name} completion goes through normal sync path`, calls.sync === 1 && !calls.complete[0]?.__enqueued);
    check(`${name} reason is sanitized readiness block`, String(calls.complete[0]?.summary || "").includes("Runner readiness blocked:"));
  }

  {
    const { deps, calls } = makeDeps({ jobs: [{ ...baseJob, id: "job-iso" }], isolationOk: false });
    await runRunnerLoop(deps);
    check("isolation unavailable does not spawn KANE", calls.execute === 0);
    check("isolation unavailable completes did_not_start", calls.complete[0]?.outcome === "did_not_start");
    check("isolation unavailable reason reported", String(calls.complete[0]?.summary || "").includes("isolation_unavailable"));
  }

  {
    const calls = { execute: 0 };
    const res = await runRunnerLoop({
      disableSignals: true, maxJobs: 1,
      cfg: { base: "", token: "", pollMs: 1, heartbeatMs: 60000, maxBackoffMs: 5 },
      isolation: { mode: "account", isolateAllJobs: false, sandboxUser: "sandbox", profilesRoot: os.tmpdir(), workspacesRoot: os.tmpdir(), repoRoot: process.cwd() },
      runnerId: "r", version: "v",
      assessReadiness: async () => ({ state: READINESS_STATES.READY, ready: true }),
      assessIsolation: async () => ({ ok: true }),
      requiresIsolation: () => false,
      executeKaneJob: async () => { calls.execute++; return {}; },
      apiRequest: async () => ({ status: 204, data: null }),
      syncCompletionWithRetry: async () => ({ ok: true, status: 200 }),
      enqueuePendingSync: async () => "",
      sleep: async () => {}, flushSyncQueue: async () => ({ flushed: 0 }), pruneStaleWorkspaces: async () => ({ removed: 0 }),
    });
    check("missing runner config blocks safely", res.exitCode === 2 && calls.execute === 0);
  }

  {
    const { deps, calls } = makeDeps({ jobs: [{ ...baseJob, id: "job-sync-fail" }], readiness: { state: READINESS_STATES.KANE_MISSING, ready: false, reason: "missing" }, completeFailTimes: 5 });
    await runRunnerLoop(deps);
    check("completion delivery failure preserves pending-sync enqueue", calls.complete.some((c) => c.__enqueued === true));
    check("failed completion delivery still did_not_start payload", calls.complete[0]?.outcome === "did_not_start");
  }

  {
    const { deps, calls } = makeDeps({ jobs: [{ ...baseJob, id: "job-success", requestedBy: "u1" }], isolationOk: true, readiness: { state: READINESS_STATES.READY, ready: true, reason: "ok" } });
    await runRunnerLoop(deps);
    check("successful ready path executes and completes", calls.execute === 1 && calls.complete[0]?.outcome === "passed");
  }

  console.log(`\n${passed} checks passed (runner gate)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
