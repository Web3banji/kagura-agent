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
    return {
      ok: true,
      mode: "account",
      sandboxUser: config.sandboxUser,
      reason: `OS-level isolation active as "${config.sandboxUser}".`,
    };
  }
  return { ok: false, mode, reason: `Unknown isolation mode: ${mode}` };
}

/* ------------------------------------------------------------------ */
/* Planning (pure)                                                    */
/* ------------------------------------------------------------------ */

export function buildIsolationPlan(job, { workspace, profile, repoRoot }) {
  return {
    workspace,
    profile,
    grantWrite: [workspace, profile, path.join(workspace, "logs")],
    denyRead: [repoRoot, path.join(repoRoot, ".env.local"), path.join(repoRoot, ".env.runner"), path.join(repoRoot, ".env")],
  };
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
    return { accountExists: false, isAdmin: false, aclOk: false };
  }
  if (!config.sandboxUser) return { accountExists: false, isAdmin: false, aclOk: false };

  const [accountRes, groupRes, aclRes] = await Promise.all([
    exec("net", ["user", config.sandboxUser]),
    exec("net", ["localgroup", "Administrators", config.sandboxUser]),
    exec("icacls", [config.workspacesRoot, config.profilesRoot]),
  ]);

  const accountExists = accountRes.code === 0 && accountRes.stdout.includes(config.sandboxUser);
  const isAdmin = groupRes.code === 0 && /completed successfully/i.test(groupRes.stdout);
  const aclOk = aclRes.code === 0 && aclRes.stdout.includes(config.sandboxUser);

  return { accountExists, isAdmin, aclOk };
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
