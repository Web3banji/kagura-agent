import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeKaneJob } from "./kane-runner.mjs";
import { cloneRepository, gitAuthEnv } from "./runner-repository.mjs";

let passed = 0;
function check(name, cond) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }
function fakeProc(code, delay = 0) { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {}; setTimeout(() => p.emit("close", code, null), delay); return p; }

async function main() {
  {
    const env = gitAuthEnv("super-secret-token");
    check("git auth uses header not URL credentials", !String(env.GIT_CONFIG_VALUE_0).includes("super-secret-token") && String(env.GIT_CONFIG_VALUE_0).startsWith("Authorization: Basic "));
    let spawned = false;
    try {
      await cloneRepository({ repoFullName: "acme/site", branch: "main", token: "super-secret-token", checkoutDir: path.join(os.tmpdir(), "nope"), spawnFn: () => { spawned = true; return fakeProc(1); } });
    } catch (err) {
      check("clone failure prevents checkout", spawned === true && /clone failed/.test(err.message) && !err.message.includes("super-secret-token"));
    }
  }
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kagura-repo-exec-"));
    const cli = path.join(dir, "kane-cli.cjs"); await fs.writeFile(cli, "", "utf8"); process.env.KAGURA_KANE_CLI_JS = cli;
    const job = { id: "job-repo", flow: "shell-nav", objective: "o", url: "http://localhost", headless: true, timeout: 60, claimGeneration: 1, repositoryFullName: "acme/site", repositoryOwner: "acme", repositoryName: "site", repositoryDefaultBranch: "main" };
    let spawned = false;
    const failed = await executeKaneJob(job, "r1", async () => ({}), {
      onPreSpawn: async () => true,
      isolation: { mode: "none", isolateAllJobs: false, workspacesRoot: path.join(dir, "workspaces"), profilesRoot: path.join(dir, "profiles") },
      getRepositoryToken: async () => ({ token: "t" }),
      cloneRepository: async () => { throw new Error("checkout denied"); },
      spawn: () => { spawned = true; return fakeProc(0); },
    });
    check("clone failure prevents Kane execution", spawned === false && failed.outcome === "did_not_start" && /checkout failed/.test(failed.summary));
    let captured;
    const child = fakeProc(0, 20);
    const ok = await executeKaneJob(job, "r1", async () => ({}), {
      onPreSpawn: async () => true,
      isolation: { mode: "none", isolateAllJobs: false, workspacesRoot: path.join(dir, "workspaces"), profilesRoot: path.join(dir, "profiles") },
      isRepositoryTargetAllowed: () => true,
      getRepositoryToken: async () => ({ token: "t" }),
      cloneRepository: async ({ checkoutDir }) => {
        await fs.mkdir(path.join(checkoutDir, ".testmuai"), { recursive: true });
        await fs.writeFile(path.join(checkoutDir, ".testmuai", "context.md"), "repo context", "utf8");
        return { checkoutDir };
      },
      spawn: (_cmd, args, opts) => { captured = { args, opts }; return child; },
    });
    check("Kane receives local checkout as cwd", captured?.opts?.cwd?.endsWith(path.join("repo")) === true);
    check("existing local context is passed explicitly", captured?.args?.includes("--local-context") === true && ok.localContextMissing === false);
    check("Kane still receives persisted target URL", captured?.args?.includes("--url") === true && captured?.args?.some((a) => String(a).startsWith(job.url)) === true);

    let missingCaptured;
    const missingJob = { ...job, id: "job-repo-missing" };
    const missingChild = fakeProc(0, 20);
    const missing = await executeKaneJob(missingJob, "r1", async () => ({}), {
      onPreSpawn: async () => true,
      isolation: { mode: "none", isolateAllJobs: false, workspacesRoot: path.join(dir, "workspaces"), profilesRoot: path.join(dir, "profiles") },
      isRepositoryTargetAllowed: () => true,
      getRepositoryToken: async () => ({ token: "t" }),
      cloneRepository: async ({ checkoutDir }) => ({ checkoutDir }),
      spawn: (_cmd, args, opts) => { missingCaptured = { args, opts }; return missingChild; },
    });
    check("missing local context is reported accurately", missing.localContextMissing === true && missing.localContextPath === undefined);
    check("missing local context does not fabricate an argument", missingCaptured?.args?.includes("--local-context") === false);
    check("missing local context still uses checkout and target URL", missingCaptured?.opts?.cwd?.endsWith(path.join("repo")) === true && missingCaptured?.args?.includes("--url") === true && missingCaptured?.args?.some((a) => String(a).startsWith(job.url)) === true);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`\n${passed} repository execution checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });