import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assessIsolation,
  buildSandboxSpawnCommand,
  quoteWindowsArgument,
} from "./runner-isolation.mjs";
import { executeKaneJob, prepareSandboxPasswordFile, runIsolationPreflight, runProcess } from "./kane-runner.mjs";
import { workspaceDir, profileDir, canonicalRoots } from "./runner-workspace.mjs";

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`PASS ${name}`);
}

async function main() {
  {
    const cmd = buildSandboxSpawnCommand({
      nodeExe: "C:/node/node.exe",
      cliEntry: "C:/app/kane.cjs",
      args: ["run", "objective with spaces", "--url", "https://example.com/a b"],
      cwd: "C:/ws",
      stdoutFile: "C:/ws/out.txt",
      stderrFile: "C:/ws/err.txt",
      sandboxUser: "S",
      passwordFile: "C:/tmp/pw.txt",
    });
    const script = cmd.join(" ");
    check("sandbox command drains stdout and stderr", script.includes("ReadToEndAsync") && script.includes("WriteAllText"));
    check("sandbox command uses output files", script.includes("out.txt") && script.includes("err.txt"));
    check("sandbox command quotes spaced arguments", script.includes("objective with spaces") && script.includes("https://example.com/a b"));
    check("sandbox command never embeds the password", !script.includes("super-secret"));
    assert.throws(() => buildSandboxSpawnCommand({ nodeExe: "n", cliEntry: "c", args: [], cwd: "w", sandboxUser: "S", passwordFile: "p" }), /stdoutFile and stderrFile/);
    passed++;
    console.log("PASS sandbox command fails closed without output files");
  }

  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kagura-sandbox-test-"));
    const pwFile = path.join(dir, "pw.txt");
    let removed = 0;
    const removeFile = async () => { removed++; };
    await assert.rejects(
      prepareSandboxPasswordFile({
        password: "super-secret",
        sandboxUser: "S",
        pwFile,
        removeFile,
        run: async () => ({ code: 1, stdout: "", stderr: "denied" }),
      }),
      /ACL protection failed/,
    );
    check("password ACL failure aborts and cleans up", removed === 1);
    await fs.rm(dir, { recursive: true, force: true });
  }

  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kagura-sandbox-test-"));
    const pwFile = path.join(dir, "pw.txt");
    let calls = 0;
    const run = async () => {
      calls++;
      return calls === 1
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 0, stdout: "S:(R)", stderr: "" };
    };
    await prepareSandboxPasswordFile({ password: "super-secret", sandboxUser: "S", pwFile, run });
    check("password ACL success verifies account access", calls === 2);
    await fs.rm(dir, { recursive: true, force: true });
  }

  {
    const res = await runProcess(process.execPath, ["-e", "process.stdout.write('out');process.stderr.write('err')"], { timeoutMs: 5000 });
    check("process capture returns stdout", res.code === 0 && res.stdout === "out");
    check("process capture returns stderr", res.stderr === "err");
  }

  {
    const res = await runProcess(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { timeoutMs: 300 });
    check("process timeout is reported", res.timedOut === true && res.code === null);
  }

  {
    const res = await runProcess("kagura-command-that-does-not-exist", [], { timeoutMs: 1000 });
    check("process spawn failure is reported", res.code === null && /not recognized|ENOENT|cannot find/i.test(String(res.stderr)));
  }

  {
    const roots = canonicalRoots("C:/repo", { workspacesRoot: "C:/KaguraRunner/workspaces", profilesRoot: "C:/KaguraRunner/profiles" });
    const a = workspaceDir("C:/repo", { id: "a", projectId: "p", requestedBy: "u1" }, roots);
    const b = workspaceDir("C:/repo", { id: "b", projectId: "p", requestedBy: "u1" }, roots);
    const pa = profileDir("C:/repo", { id: "a", projectId: "p", requestedBy: "u1" }, roots);
    const pb = profileDir("C:/repo", { id: "b", projectId: "p", requestedBy: "u1" }, roots);
    check("concurrent jobs get distinct workspaces", a !== b && a.startsWith(roots.workspacesRoot) && b.startsWith(roots.workspacesRoot));
    check("concurrent jobs get distinct profiles", pa !== pb && pa.startsWith(roots.profilesRoot) && pb.startsWith(roots.profilesRoot));
  }

  {
    const none = assessIsolation({ mode: "none", sandboxUser: "S", workspacesRoot: "C:/w", profilesRoot: "C:/p", repoRoot: "C:/repo" }, {});
    check("isolation disabled never authorizes execution", none.ok === false);
    check("windows argument quoting protects spaces", quoteWindowsArgument("a b") === '"a b"');
  }

  {
    let spawned = 0;
    const res = await executeKaneJob(
      { id: "fallback-job", flow: "shell-nav", objective: "objective", url: "https://example.com", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60 },
      "runner-test",
      async () => {},
      {
        isolation: { mode: "none", sandboxUser: "S", workspacesRoot: "C:/w", profilesRoot: "C:/p", repoRoot: "C:/repo", isolateAllJobs: false },
        assessment: { ok: false, reason: "disabled" },
        spawn: () => { spawned++; throw new Error("must not spawn"); },
      },
    );
    check("ordinary-user job never falls back to unsandboxed execution", res.outcome === "did_not_start" && spawned === 0);
  }

  {
    const rollback = await fs.readFile(path.join(process.cwd(), "scripts", "rollback-runner-isolation.ps1"), "utf8");
    check("rollback parses manifest", rollback.includes("$Manifest") && rollback.includes("ConvertFrom-Json"));
    check("rollback restores ACLs", rollback.includes("/restore") && rollback.includes("$failures"));
    check("rollback reports failures visibly", rollback.includes("Write-Error") && rollback.includes("Rollback incomplete"));
    check("rollback does not delete files or accounts", !rollback.includes("Remove-Item") && !rollback.includes("Remove-LocalUser"));
    const setup = await fs.readFile(path.join(process.cwd(), "scripts", "setup-runner-isolation.ps1"), "utf8");
    const descriptionMatch = setup.match(/\$description = "([^"]+)"/);
    check("account description is within the 48-character limit", !!descriptionMatch && descriptionMatch[1].length <= 48);
    check("first-time setup creates the sandbox account", setup.includes("if (-not $existing)") && setup.includes("New-LocalUser"));
    check("existing account without -Force does not reset password", setup.includes("elseif ($Force)") && setup.includes("Set-LocalUser"));
    check("repeated setup handles an existing account", setup.includes("already exists (use -Force to update password)"));
    check("setup resolves the account by name and SID", setup.includes("$resolvedAccount = Get-LocalUser") && setup.includes("$resolvedSid = $resolvedAccount.SID.Value"));
    check("group membership checks are idempotent", setup.includes("Get-LocalGroupMember") && setup.includes("if (Test-LocalGroupMember") && setup.includes("if (-not (Test-LocalGroupMember"));
    check("group cmdlets use the PowerShell 5.1 -Member parameter", setup.includes("Get-LocalGroupMember -Group $Group -Member $Name") && setup.includes("Add-LocalGroupMember -Group $Group -Member $Name") && setup.includes("Remove-LocalGroupMember -Group $Group -Member $Name"));
    check("group cmdlets do not use the invalid -Name member parameter", !setup.includes("Get-LocalGroupMember -Group $Group -Name") && !setup.includes("Add-LocalGroupMember -Group $Group -Name") && !setup.includes("Remove-LocalGroupMember -Group $Group -Name"));
    check("failure handler reports operation and line", setup.includes("$invocation.ScriptLineNumber") && setup.includes("Failing line:"));
    check("missing Users membership is added", setup.includes("Add-LocalGroupMemberChecked -Group \"Users\""));
    check("existing Administrators membership is removed", setup.includes("Remove-LocalGroupMemberChecked -Group \"Administrators\""));
    check("setup does not use failing net localgroup add/delete", !setup.includes("net localgroup Administrators $userName /delete") && !setup.includes("net localgroup Users $userName /add"));
    check("group operations precede ACL grants", setup.indexOf("Add-LocalGroupMemberChecked") < setup.indexOf("Invoke-Icacls $repoRoot /grant"));
    check("setup verifies Users and Administrators after changes", setup.includes("is not a member of 'Users'") && setup.includes("still a member of 'Administrators'"));
    check("setup stops if the account cannot be resolved", setup.includes("$resolvedAccount") && setup.includes("was not created or resolved"));
    check("setup reports partial failures for recovery", setup.includes("trap {") && setup.includes("Partial account/ACL changes"));
    check("setup fails visibly on icacls errors", setup.includes("function Invoke-Icacls") && setup.includes("$LASTEXITCODE -ne 0") && setup.includes("throw"));
    check("setup records workspace/profile ACL backups", setup.includes("Add-ManifestItem ([IO.Path]::GetFileName($root.TrimEnd"));
    check("setup backs up ACLs before changes", setup.indexOf("/save") < setup.indexOf("/inheritance:r"));
    check("setup does not broaden inheritance", setup.includes("/inheritance:r") && !setup.includes("/inheritance:e"));
    check("setup backs up node executable ACL", setup.includes("node-exe") && setup.includes("$nodeBackup"));
    check("setup grants repo traversal for node_modules", setup.includes("repo-root") && setup.includes("${userName}:(RX)"));
    check("setup can grant an explicit Kane CLI entry", setup.includes("kane-entry") && setup.includes("KAGURA_KANE_CLI_JS"));
    check("setup does not delete files or accounts", !setup.includes("Remove-Item") && !setup.includes("Remove-LocalUser"));
  }

  {
    let loopEntered = false;
    const assessment = await runIsolationPreflight({
      loadConfig: () => ({ base: "http://127.0.0.1:1", token: "test" }),
      getIsolation: () => ({ mode: "none", sandboxUser: "S", workspacesRoot: "C:/w", profilesRoot: "C:/p", repoRoot: "C:/repo", isolateAllJobs: false }),
      assess: async () => ({ ok: false, mode: "none", reason: "preflight test" }),
      runLoop: () => { loopEntered = true; },
    });
    const runnerSource = await fs.readFile(path.join(process.cwd(), "scripts", "kane-runner.mjs"), "utf8");
    check("isolation preflight returns the assessment", assessment.ok === false);
    check("isolation preflight never enters the job loop", loopEntered === false);
    check("preflight branch precedes the polling loop", runnerSource.indexOf('process.argv.includes("--preflight")') < runnerSource.indexOf("const res = await runRunnerLoop()"));
  }

  console.log(`\n${passed} sandbox execution checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});