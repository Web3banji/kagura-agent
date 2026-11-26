import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeKaneJob, terminateProcessTree } from "./kane-runner.mjs";

let passed = 0;
function check(name, cond) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }
function fakeProc(code, delay = 0) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => {};
  setTimeout(() => p.emit("close", code, null), delay);
  return p;
}

async function main() {
  {
    const start = Date.now();
    const res = await terminateProcessTree({ pid: 123 }, { spawnFn: () => fakeProc(0, 30), timeoutMs: 1000 });
    check("awaited termination waits for taskkill", res.ok === true && Date.now() - start >= 20);
  }
  {
    const res = await terminateProcessTree({ pid: 123 }, { spawnFn: () => fakeProc(1), timeoutMs: 1000 });
    check("termination failure is not confirmed", res.ok === false && res.reason === "taskkill_failed");
  }
  {
    const res = await terminateProcessTree({ pid: 123 }, { spawnFn: () => fakeProc(128), timeoutMs: 1000 });
    check("missing process is explicit and unconfirmed", res.ok === false && res.reason === "process_missing");
  }
  {
    const res = await terminateProcessTree({ pid: 123 }, { spawnFn: () => fakeProc(null, 1000), timeoutMs: 40 });
    check("termination timeout is unconfirmed", res.ok === false && res.timedOut === true);
  }
  {
    let spawned = false;
    const job = { id: "job-pre", flow: "shell-nav", objective: "o", url: "http://localhost", headless: true, timeout: 60, claimGeneration: 1 };
    const res = await executeKaneJob(job, "r1", async () => ({}), {
      onPreSpawn: async () => false,
      spawn: () => { spawned = true; throw new Error("must not spawn"); },
    });
    check("pre-spawn cancellation aborts before spawn", spawned === false && res.outcome === "did_not_start" && res.cancelConfirmed === true);
  }
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kagura-cancel-hb-"));
    const cli = path.join(dir, "kane-cli.cjs");
    await fs.writeFile(cli, "", "utf8");
    process.env.KAGURA_KANE_CLI_JS = cli;
    const child = fakeProc(null, 1000);
    child.pid = 999;
    let heartbeats = 0;
    const job = { id: "job-hb", flow: "shell-nav", objective: "o", url: "http://localhost", headless: true, timeout: 60, claimGeneration: 1 };
    const res = await executeKaneJob(job, "r1", async () => {
      heartbeats++;
      return heartbeats === 1 ? { cancelJobId: job.id } : {};
    }, {
      onPreSpawn: async () => true,
      isolation: { mode: "none", isolateAllJobs: false, workspacesRoot: path.join(dir, "workspaces"), profilesRoot: path.join(dir, "profiles") },
      spawn: () => child,
      terminateSpawn: () => { setTimeout(() => child.emit("close", 1, null), 10); return fakeProc(0); },
      heartbeatMs: 10,
    });
    check("heartbeat cancellation delivery terminates and confirms", res.cancelConfirmed === true && res.outcome === "did_not_start");
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`\n${passed} cancellation checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });