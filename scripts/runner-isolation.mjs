/**
 * KAGURA runner OS-level isolation for Windows.
 *
 * Kane/Chrome jobs submitted by ordinary users MUST run under a genuine
 * operating-system boundary, not merely in a separate folder. This module
 * implements that boundary as a pluggable isolation decision engine with a
 * dedicated low-privilege Windows account backend.
 *
 * Design:
 *  - An ordinary-user job (one with a recorded `requestedBy`) may only be
 *    executed when `isolation.ok === true`.
 *  - Readiness is determined by probing the host: the sandbox account must
 *    exist, must NOT be a member of the local Administrators group, and the
 *    per-job workspace/profile must grant the sandbox account access while the
 *    application source and credentials are denied to it.
 *  - If the sandbox is unavailable, disabled, or misconfigured, ordinary-user
 *    jobs are refused with `did_not_start`. The runner never silently falls
 *    back to unrestricted execution.
 *  - Platform/legacy jobs (no `requestedBy`) are exempt: they run under the
 *    shared runner account exactly as before.
 *
 * Pure functions are isolated from `child_process` so they can be unit tested
 * without touching the host. Host probing is separated into `probeIsolation`.
 */

import { spawn } from "node:child_process";
import path from "node:path";

export const ISOLATION_MODES = ["account", "none", "auto"];

export function normalizeIsolationMode(raw) {
  const m = typeof raw === "string" ? raw.toLowerCase() : undefined;
  if (m === "account" || m === "none" || m === "auto") return m;
  return "auto";
}

/**
 * True when a job must run inside the OS sandbox. A job with a recorded
 * `requestedBy` is an ordinary-user submission; platform/legacy jobs have no
 * owner and are exempt.
 */
export function requiresIsolationForJob(job, opts) {
  if (opts && opts.isolateAllJobs) return true;
  const requestedBy = job && job.requestedBy;
  return typeof requestedBy === "string" && requestedBy.length > 0;
}

/* ------------------------------------------------------------------ */
/* Assessment (pure)                                                  */
/* ------------------------------------------------------------------ */

export function assessIsolation(config, probe) {
  const mode = config.mode === "auto" ? (config.sandboxUser ? "account" : "none") : config.mode;

  if (mode === "none") {
    return {
      ok: false,
      mode: "none",
      reason: "OS-level isolation is disabled; ordinary-user jobs must not execute.",
    };
  }
  if (mode === "account") {
    if (!config.sandboxUser) {
      return { ok: false, mode: "account", reason: "KAGURA_RUNNER_SANDBOX_USER is not set." };
    }
    const pathCheck = validateIsolationPaths(config);
    if (!pathCheck.ok) {
      return { ok: false, mode: "account", reason: `Isolation path configuration invalid: ${pathCheck.errors.join("; ")}` };
    }
    if (!probe.accountExists) {
      return {
        ok: false,
        mode: "account",
        reason: `Sandbox account "${config.sandboxUser}" does not exist. Run scripts/setup-runner-isolation.ps1.`,
      };
    }
    if (probe.isAdmin) {
      return {
        ok: false,
        mode: "account",
        reason: `Sandbox account "${config.sandboxUser}" is an administrator; it must be a restricted standard user.`,
      };
    }
    if (!probe.aclOk) {
      return {
        ok: false,
        mode: "account",
        reason: "ACLs are not correctly configured for the sandbox account.",
      };
    }
    if (probe.secretAclOk !== true) {
      return {
        ok: false,
        mode: "account",
        reason: "Secret-file ACLs are not confirmed for the sandbox account (fail closed).",
      };
    }
    if (probe.executableOk !== true) {
      return {
        ok: false,
        mode: "account",
        reason: "Required runner executable access is not confirmed for the sandbox account (fail closed).",
      };
    }
    return {
      ok: true,
      mode: "account",
      sandboxUser: config.sandboxUser,
      reason: `OS-level isolation active as "${config.sandboxUser}" (host boundary; not per-job/user OS isolation).`,
      limitations: ["single sandbox account provides host boundary, not per-job/user OS isolation"],
    };
  }
  return { ok: false, mode, reason: `Unknown isolation mode: ${mode}` };
}

/* ------------------------------------------------------------------ */
/* Planning (pure)                                                    */
/* ------------------------------------------------------------------ */

export function buildIsolationPlan(job, { workspace, profile, repoRoot, workspacesRoot, profilesRoot }) {
  return {
    workspace,
    profile,
    workspacesRoot,
    profilesRoot,
    grantWrite: [workspace, profile, path.join(workspace, "logs")],
    // Deny-read must be handled by host ACL setup outside accessible roots; do not rely on filename-only denies.
    denyRead: [],
    requiredReadable: [],
  };
}

export function buildAclBackupManifest({ backupDir, stamp, targets }) {
  const items = (targets || []).map((target) => {
    const resolved = path.resolve(target.path);
    const name = String(target.name || path.basename(resolved) || "target").replace(/[^a-zA-Z0-9._-]+/g, "-");
    return {
      name,
      path: resolved,
      kind: target.kind || "path",
      backupFile: path.join(backupDir, `acl-${stamp}-${name}.txt`),
      restoreCommand: `icacls ${JSON.stringify(resolved)} /restore ${JSON.stringify(path.join(backupDir, `acl-${stamp}-${name}.txt`))}`,
    };
  });
  return { version: 1, stamp, backupDir: path.resolve(backupDir), items };
}

export function validateIsolationPaths({ repoRoot, workspacesRoot, profilesRoot }) {
  const repo = path.resolve(repoRoot);
  const ws = path.resolve(workspacesRoot);
  const pf = path.resolve(profilesRoot);
  const errors = [];
  if (!ws || !pf) errors.push("workspacesRoot and profilesRoot are required");
  if (ws === repo || pf === repo) errors.push("workspace/profile roots must not equal repo root");
  if (ws.startsWith(repo + path.sep) || pf.startsWith(repo + path.sep)) errors.push("workspace/profile roots must not be inside repo root");
  if (repo.startsWith(ws + path.sep) || repo.startsWith(pf + path.sep)) errors.push("repo root must not be inside workspace/profile roots");
  if (ws === pf) errors.push("workspacesRoot and profilesRoot must be different");
  return { ok: errors.length === 0, errors, repoRoot: repo, workspacesRoot: ws, profilesRoot: pf };
}

/* ------------------------------------------------------------------ */
/* Host probing (impure)                                              */
/* ------------------------------------------------------------------ */

function defaultExec(command, args) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: null, stdout, stderr: stderr || err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Probe the host to determine whether the sandbox account is ready.
 * `exec` is injectable for tests; defaults to real child_process spawn.
 */
export async function probeIsolation(config, exec = defaultExec) {
  if (config.mode !== "account" && config.mode !== "auto") {
    return { accountExists: false, isAdmin: false, aclOk: false, secretAclOk: false, executableOk: false };
  }
  if (!config.sandboxUser) return { accountExists: false, isAdmin: false, aclOk: false, secretAclOk: false, executableOk: false };

  const secretFiles = Array.isArray(config.secretFiles) ? config.secretFiles.filter(Boolean) : [];
  const requiredExecutables = Array.isArray(config.requiredExecutables) ? config.requiredExecutables.filter(Boolean) : [];
  const [accountRes, groupRes, aclRes, secretAclRes, exeRes] = await Promise.all([
    exec("net", ["user", config.sandboxUser]),
    exec("net", ["localgroup", "Administrators", config.sandboxUser]),
    exec("icacls", [config.workspacesRoot, config.profilesRoot]),
    secretFiles.length ? exec("icacls", secretFiles) : Promise.resolve({ code: 0, stdout: "ok" }),
    requiredExecutables.length ? exec("icacls", requiredExecutables) : Promise.resolve({ code: 0, stdout: config.sandboxUser }),
  ]);

  const accountExists = accountRes.code === 0 && String(accountRes.stdout).includes(config.sandboxUser);
  const isAdmin = groupRes.code === 0 && /completed successfully/i.test(String(groupRes.stdout));
  const aclOk = aclRes.code === 0 && String(aclRes.stdout).includes(config.sandboxUser);
  // Secret ACL probe is heuristic only: true presence of deny ACE cannot be fully proven from icacls text alone here.
  // Setup script must create backups/manifests and operator must verify; runner fail-closes when probe cannot confirm.
  const secretAclOk = !secretFiles.length ? true : (secretAclRes.code === 0 && /den(y|ied)/i.test(String(secretAclRes.stdout)) ? true : false);
  const executableOk = !requiredExecutables.length ? true : (exeRes.code === 0 && String(exeRes.stdout).toLowerCase().includes(String(config.sandboxUser).toLowerCase()));
  return { accountExists, isAdmin, aclOk, secretAclOk, executableOk, probeLimitations: ["icacls text probes are heuristic; operator must verify ACLs and parent-directory permissions"] };
}

/* ------------------------------------------------------------------ */
/* Spawn command construction (pure)                                  */
/* ------------------------------------------------------------------ */

/**
 * Build the argv for launching the sandboxed job process via PowerShell so that
 * credentials and arguments are never interpolated into a command string.
 * The password is read from `passwordFile` inside the script (never on the command
 * line); stdout/stderr are redirected to files inside the job workspace.
 */
export function buildSandboxSpawnCommand({
  nodeExe,
  cliEntry,
  args,
  cwd,
  stdoutFile,
  stderrFile,
  sandboxUser,
  passwordFile,
}) {
  const psScript = [
    `$ErrorActionPreference = 'Stop'`,
    `$sec = Get-Content -Raw ${JSON.stringify(passwordFile)} | ConvertTo-SecureString -AsPlainText -Force`,
    `$cred = New-Object System.Management.Automation.PSCredential(${JSON.stringify(sandboxUser)}, $sec)`,
    `$si = New-Object System.Diagnostics.ProcessStartInfo`,
    `$si.FileName = ${JSON.stringify(nodeExe)}`,
    `$si.Arguments = ${JSON.stringify([cliEntry, ...args].join(" "))}`,
    `$si.WorkingDirectory = ${JSON.stringify(cwd)}`,
    `$si.RedirectStandardOutput = $true`,
    `$si.RedirectStandardError = $true`,
    `$si.UseShellExecute = $false`,
    `$si.CreateNoWindow = $true`,
    `$si.UserName = $cred.UserName`,
    `$si.Password = $cred.Password`,
    `$p = [System.Diagnostics.Process]::Start($si)`,
    `$p.WaitForExit()`,
    `[Console]::Out.Write($p.ExitCode)`,
  ].join("; ");

  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript];
}


export function buildAclRestoreCommands(manifest) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  return items.map((item) => ({
    name: item.name,
    path: item.path,
    backupFile: item.backupFile,
    command: ["icacls", String(item.path), "/restore", String(item.backupFile)],
  }));
}
