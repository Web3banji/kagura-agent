import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  assessIsolation,
  buildAclBackupManifest,
  buildAclRestoreCommands,
  buildIsolationPlan,
  buildSandboxSpawnCommand,
  probeIsolation,
  validateIsolationPaths,
} from "./runner-isolation.mjs";
import { canonicalRoots, workspaceDir, profileDir } from "./runner-workspace.mjs";
import { buildChildEnv, isSecretEnvName } from "./runner-security.mjs";

let pass = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      r.then(() => { pass++; console.log(`PASS ${name}`); }).catch((e) => fail(name, e));
      return;
    }
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail(name, e);
  }
}
function fail(name, e) {
  process.exitCode = 1;
  console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
}

check("ACL backup manifest includes every target and exact restore metadata", () => {
  const manifest = buildAclBackupManifest({
    backupDir: "C:/backups",
    stamp: "20261124-100000",
    targets: [
      { name: "workspaces", path: "C:/KaguraRunner/workspaces", kind: "directory" },
      { name: "profiles", path: "C:/KaguraRunner/profiles", kind: "directory" },
      { name: "env-runner", path: "C:/repo/.env.runner", kind: "file" },
    ],
  });
  assert.equal(manifest.version, 1);
  assert.equal(manifest.items.length, 3);
  assert.deepEqual(manifest.items.map((i) => i.path), [
    path.resolve("C:/KaguraRunner/workspaces"),
    path.resolve("C:/KaguraRunner/profiles"),
    path.resolve("C:/repo/.env.runner"),
  ]);
  for (const item of manifest.items) {
    assert.ok(item.backupFile.startsWith(path.resolve("C:/backups")));
    assert.ok(item.restoreCommand.includes("/restore"));
    assert.ok(item.restoreCommand.includes(item.backupFile.replace(/\\/g, "\\\\")) || item.restoreCommand.includes(path.basename(item.backupFile)));
  }
});

check("ACL restore commands target exact paths and backup files", () => {
  const cmds = buildAclRestoreCommands({
    items: [
      { name: "a", path: "C:/KaguraRunner/workspaces", backupFile: "C:/backups/acl-a.txt" },
      { name: "b", path: "C:/repo/.env.runner", backupFile: "C:/backups/acl-b.txt" },
    ],
  });
  assert.deepEqual(cmds[0].command, ["icacls", "C:/KaguraRunner/workspaces", "/restore", "C:/backups/acl-a.txt"]);
  assert.deepEqual(cmds[1].command, ["icacls", "C:/repo/.env.runner", "/restore", "C:/backups/acl-b.txt"]);
});

check("restore command generation fails closed for missing manifest items", () => {
  assert.deepEqual(buildAclRestoreCommands(null), []);
  assert.deepEqual(buildAclRestoreCommands({}), []);
  assert.deepEqual(buildAclRestoreCommands({ items: "bad" }), []);
});

check("validateIsolationPaths rejects invalid/insecure layouts", () => {
  const repo = "C:/repo";
  assert.equal(validateIsolationPaths({ repoRoot: repo, workspacesRoot: "C:/KaguraRunner/workspaces", profilesRoot: "C:/KaguraRunner/profiles" }).ok, true);
  assert.equal(validateIsolationPaths({ repoRoot: repo, workspacesRoot: repo, profilesRoot: "C:/KaguraRunner/profiles" }).ok, false);
  assert.equal(validateIsolationPaths({ repoRoot: repo, workspacesRoot: "C:/repo/workspaces", profilesRoot: "C:/KaguraRunner/profiles" }).ok, false);
  assert.equal(validateIsolationPaths({ repoRoot: repo, workspacesRoot: "C:/KaguraRunner/ws", profilesRoot: "C:/KaguraRunner/ws" }).ok, false);
});

check("canonical workspace/profile roots are consistent and outside repo by config", () => {
  const roots = canonicalRoots("C:/repo", { workspacesRoot: "C:/KaguraRunner/workspaces", profilesRoot: "C:/KaguraRunner/profiles" });
  assert.equal(roots.repoRoot, path.resolve("C:/repo"));
  assert.equal(roots.workspacesRoot, path.resolve("C:/KaguraRunner/workspaces"));
  assert.equal(roots.profilesRoot, path.resolve("C:/KaguraRunner/profiles"));
  const job = { id: "job1", projectId: "p1", requestedBy: "u1" };
  const ws = workspaceDir("C:/repo", job, roots);
  const pf = profileDir("C:/repo", job, roots);
  assert.ok(ws.startsWith(roots.workspacesRoot));
  assert.ok(pf.startsWith(roots.profilesRoot));
  assert.notEqual(ws, pf);
});

check("assessIsolation fails closed when ACL/executable probes are unavailable or unconfirmed", () => {
  const cfg = { mode: "account", sandboxUser: "S", workspacesRoot: "C:/KaguraRunner/workspaces", profilesRoot: "C:/KaguraRunner/profiles", repoRoot: "C:/repo", isolateAllJobs: false };
  for (const probe of [
    { accountExists: false, isAdmin: false, aclOk: false, secretAclOk: false, executableOk: false, passwordAvailable: true },
    { accountExists: true, isAdmin: false, aclOk: true, secretAclOk: false, executableOk: true, passwordAvailable: true },
    { accountExists: true, isAdmin: false, aclOk: true, secretAclOk: true, executableOk: false, passwordAvailable: true },
    { accountExists: true, isAdmin: false, aclOk: true, secretAclOk: true, executableOk: true, passwordAvailable: false },
    { accountExists: true, isAdmin: false, aclOk: true, secretAclOk: undefined, executableOk: true, passwordAvailable: true },
  ]) {
    const res = assessIsolation(cfg, probe);
    assert.equal(res.ok, false, `expected fail-closed for ${JSON.stringify(probe)}`);
  }
});

check("assessIsolation reports host-boundary limitation on success", () => {
  const cfg = { mode: "account", sandboxUser: "S", workspacesRoot: "C:/KaguraRunner/workspaces", profilesRoot: "C:/KaguraRunner/profiles", repoRoot: "C:/repo", isolateAllJobs: false };
  const res = assessIsolation(cfg, { accountExists: true, isAdmin: false, aclOk: true, secretAclOk: true, executableOk: true, passwordAvailable: true });
  assert.equal(res.ok, true);
  assert.match(res.reason, /host boundary/i);
  assert.ok(Array.isArray(res.limitations));
  assert.match(res.limitations.join(" "), /not per-job\/user OS isolation/i);
});

check("probeIsolation surfaces heuristic limitation and probe booleans", async () => {
  const exec = async (cmd, args) => {
    if (cmd === "net" && args[0] === "user") return { code: 0, stdout: "S" };
    if (cmd === "net") return { code: 0, stdout: "The command completed successfully." };
    if (cmd === "icacls" && args.some((a) => String(a).endsWith(".env.runner"))) return { code: 0, stdout: "DENY S:(R)" };
    return { code: 0, stdout: "S:(OI)(CI)(RX)" };
  };
  const res = await probeIsolation({ mode: "account", sandboxUser: "S", workspacesRoot: "C:/w", profilesRoot: "C:/p", secretFiles: ["C:/repo/.env.runner"], requiredExecutables: ["C:/node/node.exe"] }, exec);
  assert.equal(res.secretAclOk, true);
  assert.equal(res.executableOk, true);
  assert.ok(Array.isArray(res.probeLimitations));
});

check("credential safeguards: sandbox password treated as secret and not passed to child env or command args", () => {
  assert.equal(isSecretEnvName("KAGURA_RUNNER_SANDBOX_PASSWORD"), true);
  const child = buildChildEnv({ PATH: "C:/bin", KAGURA_RUNNER_SANDBOX_PASSWORD: "super-secret", GITHUB_TOKEN: "tok" });
  assert.equal(child.PATH, "C:/bin");
  assert.equal(child.KAGURA_RUNNER_SANDBOX_PASSWORD, undefined);
  assert.equal(child.GITHUB_TOKEN, undefined);
  const cmd = buildSandboxSpawnCommand({
    nodeExe: "C:/node/node.exe",
    cliEntry: "C:/app/node_modules/@testmuai/kane-cli/bin/kane-cli.cjs",
    args: ["run", "objective"],
    cwd: "C:/ws",
    stdoutFile: "C:/ws/out.txt",
    stderrFile: "C:/ws/err.txt",
    sandboxUser: "S",
    passwordFile: "C:/tmp/pw.txt",
  });
  const joined = cmd.join(" ");
  assert.ok(!joined.includes("super-secret"));
  assert.ok(joined.includes("pw.txt"));
  assert.ok(joined.includes("-Command"));
});

check("isolation plan does not rely on filename-only deny list", () => {
  const plan = buildIsolationPlan({ id: "j1" }, { workspace: "C:/w/j1", profile: "C:/p/j1", repoRoot: "C:/repo", workspacesRoot: "C:/w", profilesRoot: "C:/p" });
  assert.deepEqual(plan.denyRead, []);
  assert.ok(Array.isArray(plan.grantWrite));
});

process.on("exit", () => console.log(`\n${pass} isolation gap checks passed`));
