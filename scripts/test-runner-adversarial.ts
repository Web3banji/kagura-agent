/**
 * Adversarial runner security tests for KAGURA.
 *
 * These tests prove the defenses that surround Kane execution: input validation,
 * environment stripping, shell metacharacter rejection, path traversal blocking,
 * secret leakage prevention, and fail-closed OS-level isolation gating.
 *
 * They do NOT execute Kane or Chrome (no live runner required).
 *
 * Run:  node scripts/test-runner-adversarial.mjs
 */

import assert from "node:assert/strict";
import path from "node:path";
import {
  buildChildEnv,
  validateObjective,
  validateUrl,
  validateFlow,
  normalizeTimeout,
  validateJobForExecution,
  isShellSafeArg,
  isSecretEnvName,
  MAX_TIMEOUT_SEC,
  MIN_TIMEOUT_SEC,
  DEFAULT_TIMEOUT_SEC,
} from "./runner-security.mjs";
import {
  assessIsolation,
  buildSandboxSpawnCommand,
  normalizeIsolationMode,
  probeIsolation,
  requiresIsolationForJob,
} from "./runner-isolation.mjs";
import { runKane } from "@/lib/kane/runner";
import { safeSegment, isInside, workspaceDir, profileDir } from "./runner-workspace.mjs";

let pass = 0;
function check(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") result.then(undefined, (e: unknown) => fail(name, e));
    pass++;
    console.log(`PASS ${name}`);
  } catch (e: unknown) {
    fail(name, e);
  }
}
function fail(name: string, e: unknown) {
  process.exitCode = 1;
  console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
}

/* ---------- Input validation ---------- */

check("rejects empty / non-string / overlong objectives", () => {
  assert.equal(validateObjective("").ok, false);
  assert.equal(validateObjective(123).ok, false);
  assert.equal(validateObjective("x".repeat(4001)).ok, false);
  assert.equal(validateObjective("  sign in  ").ok, true);
  assert.equal(validateObjective("  sign in  ").objective, "sign in");
});

check("rejects control characters in objectives", () => {
  assert.equal(validateObjective("line1\nline2").ok, false);
  assert.equal(validateObjective("tab\there").ok, false);
  assert.equal(validateObjective("esc\x1b[2J").ok, false);
});

check("rejects non-http(s) and malformed URLs", () => {
  assert.equal(validateUrl("").ok, false);
  assert.equal(validateUrl("file:///C:/Windows/System32").ok, false);
  assert.equal(validateUrl("javascript:alert(1)").ok, false);
  assert.equal(validateUrl("data:text/html,<script>").ok, false);
  assert.equal(validateUrl("/etc/passwd").ok, false);
  assert.equal(validateUrl("C:\\Windows\\System32").ok, false);
  assert.equal(validateUrl("https://example.com/a b").ok, false);
  assert.equal(validateUrl('https://example.com/"x').ok, false);
  assert.equal(validateUrl("\\\\server\\share").ok, false);
  const ok = validateUrl("https://example.com/path?q=1");
  assert.equal(ok.ok, true);
  assert.equal(ok.url, "https://example.com/path?q=1");
});

check("rejects oversized URLs", () => {
  assert.equal(validateUrl(`https://example.com/${"a".repeat(3000)}`).ok, false);
});

check("enforces strict flow allowlist", () => {
  assert.equal(validateFlow(undefined).flow, "shell-nav");
  assert.equal(validateFlow("").flow, "shell-nav");
  assert.equal(validateFlow("checkout-flow_1").flow, "checkout-flow_1");
  assert.equal(validateFlow("bad flow").ok, false);
  assert.equal(validateFlow("a".repeat(41)).ok, false);
  assert.equal(validateFlow("../../etc").ok, false);
  assert.equal(validateFlow("a;b").ok, false);
  assert.equal(validateFlow("flow'").ok, false);
});

check("clamps timeout to a safe range", () => {
  assert.equal(normalizeTimeout(undefined), DEFAULT_TIMEOUT_SEC);
  assert.equal(normalizeTimeout(0), DEFAULT_TIMEOUT_SEC);
  assert.equal(normalizeTimeout("nope"), DEFAULT_TIMEOUT_SEC);
  assert.equal(normalizeTimeout(5), MIN_TIMEOUT_SEC);
  assert.equal(normalizeTimeout(999999), MAX_TIMEOUT_SEC);
  assert.equal(normalizeTimeout(90), 90);
});

check("validateJobForExecution validates every field at once", () => {
  const result = validateJobForExecution({ objective: "sign in", url: "https://example.com", flow: "shell-nav", timeout: 60 }) as { ok: true; objective: string; url: string; flow: string; timeout: number; headless: boolean };
  assert.equal(result.ok, true);
  assert.equal(result.objective, "sign in");
  assert.equal(result.timeout, 60);
  assert.equal(validateJobForExecution(null).ok, false);
  assert.equal(validateJobForExecution({}).ok, false);
  assert.equal(validateJobForExecution({ objective: "", url: "https://example.com" }).ok, false);
  assert.equal(validateJobForExecution({ objective: "x", url: "file:///etc" }).ok, false);
  assert.equal(validateJobForExecution({ objective: "x", url: "https://example.com", flow: "a;b" }).ok, false);
  assert.equal(validateJobForExecution({ objective: "x", url: "https://example.com", timeout: -5 }).ok, true);
});

/* ---------- Shell / argument injection ---------- */

check("rejects shell metacharacters in binary names", () => {
  assert.equal(isShellSafeArg("kane-cli"), true);
  assert.equal(isShellSafeArg("C:\\Program Files\\nodejs\\node.exe"), true);
  assert.equal(isShellSafeArg("kane-cli&calc"), false);
  assert.equal(isShellSafeArg("kane-cli|calc"), false);
  assert.equal(isShellSafeArg("kane-cli>out.txt"), false);
  assert.equal(isShellSafeArg('kane-cli"x'), false);
  assert.equal(isShellSafeArg("kane-cli\ncalc"), false);
  assert.equal(isShellSafeArg(42), false);
});

/* ---------- Environment leakage ---------- */

check("strips platform secrets from the child environment", () => {
  const env = buildChildEnv({
    Path: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    KAGURA_RUNNER_TOKEN: "runner-secret",
    KAGURA_TOKEN_ENCRYPTION_KEY: "key-material",
    GITHUB_TOKEN: "gh-secret",
    GH_TOKEN: "gh-secret",
    DATABASE_URL: "postgres://user:pass@host/db",
    NODE_OPTIONS: "--require evil.js",
    NODE_PATH: "C:\\evil",
    SOME_API_KEY: "nope",
    MY_PASSWORD: "nope",
  }) as Record<string, string | undefined>;
  assert.equal(env["Path"], "C:\\Windows");
  for (const name of [
    "KAGURA_RUNNER_TOKEN",
    "KAGURA_TOKEN_ENCRYPTION_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "DATABASE_URL",
    "NODE_OPTIONS",
    "NODE_PATH",
    "SOME_API_KEY",
    "MY_PASSWORD",
  ]) {
    assert.equal((env as Record<string, string | undefined>)[name], undefined, `${name} leaked into child env`);
  }
});

check("secret pattern detection", () => {
  for (const n of ["KAGURA_X", "GITHUB_TOKEN", "GH_SECRET", "DB_PASSWORD", "MY_API_KEY", "NODE_OPTIONS", "_"]) {
    assert.equal(isSecretEnvName(n), true, `${n} should be secret`);
  }
  for (const n of ["PATH", "TEMP", "LANG", "HTTP_PROXY"]) {
    assert.equal(isSecretEnvName(n), false, `${n} should not be secret`);
  }
});

/* ---------- Path traversal / filesystem ---------- */

check("safeSegment strips traversal and separators", () => {
  assert.ok(!safeSegment("../../etc/passwd").includes(".."));
  assert.ok(!safeSegment("../../etc/passwd").includes("/"));
  assert.ok(!safeSegment("..\\..\\windows").includes("\\"));
  assert.ok(!safeSegment("C:\\secret").includes(":"));
  assert.equal(safeSegment("", "fallback"), "fallback");
  assert.equal(safeSegment("...", "fallback"), "fallback");
});

check("derived workspaces and profiles stay inside their roots", () => {
  const ROOT = "C:\\runner-root";
  const workspacesRoot = path.join(ROOT, "data", "verification", "workspaces");
  const profilesRoot = path.join(ROOT, "data", "verification", "profiles");
  const hostile = { id: "../../../../Windows/System32", projectId: "..\\..\\..", requestedBy: "../../root" };
  const ws = workspaceDir(ROOT, hostile);
  const pf = profileDir(ROOT, hostile);
  assert.ok(isInside(workspacesRoot, ws), `workspace escaped: ${ws}`);
  assert.ok(isInside(profilesRoot, pf), `profile escaped: ${pf}`);
  for (const dir of [ws, pf]) {
    const segment = path.basename(dir);
    assert.ok(!segment.includes("/") && !segment.includes("\\"), `separator leaked: ${segment}`);
    assert.ok(!segment.includes(".."), `traversal leaked: ${segment}`);
    assert.ok(segment.length > 0, "empty segment");
  }
});

check("hostile distinct inputs do not collide", () => {
  const ROOT = "C:\\runner-root";
  const a = workspaceDir(ROOT, { id: "../../a", projectId: "p", requestedBy: "u" });
  const b = workspaceDir(ROOT, { id: "..\\..\\a", projectId: "p", requestedBy: "u" });
  assert.notEqual(a, b);
});

/* ---------- OS-level isolation gating (fail closed) ---------- */

check("ordinary-user jobs require isolation; platform jobs do not", () => {
  assert.equal(requiresIsolationForJob({ requestedBy: "alice" }), true);
  assert.equal(requiresIsolationForJob({ requestedBy: "" }), false);
  assert.equal(requiresIsolationForJob({ requestedBy: undefined }), false);
  assert.equal(requiresIsolationForJob({ requestedBy: "bob" }, { isolateAllJobs: true }), true);
});

check("isolation mode normalization", () => {
  assert.equal(normalizeIsolationMode("account"), "account");
  assert.equal(normalizeIsolationMode("AUTO"), "auto");
  assert.equal(normalizeIsolationMode("none"), "none");
  assert.equal(normalizeIsolationMode("bogus"), "auto");
});

check("assessment fails closed when the sandbox account is missing", () => {
  const result = assessIsolation(
    { mode: "account", sandboxUser: "DOES_NOT_EXIST", workspacesRoot: "C:\\KaguraRunner\\workspaces", profilesRoot: "C:\\KaguraRunner\\profiles", repoRoot: "C:\\repo", isolateAllJobs: false },
    { accountExists: false, isAdmin: false, aclOk: false, secretAclOk: false, executableOk: false },
  );
  assert.equal(result.ok, false);
  assert.equal(result.mode, "account");
});

check("assessment fails closed when the sandbox account is an administrator", () => {
  const result = assessIsolation(
    { mode: "account", sandboxUser: "ADMIN_ACCOUNT", workspacesRoot: "C:\\KaguraRunner\\workspaces", profilesRoot: "C:\\KaguraRunner\\profiles", repoRoot: "C:\\repo", isolateAllJobs: false },
    { accountExists: true, isAdmin: true, aclOk: true, secretAclOk: true, executableOk: true },
  );
  assert.equal(result.ok, false);
});

check("assessment passes only for a non-admin account with ACLs", () => {
  const result = assessIsolation(
    { mode: "account", sandboxUser: "KAGURA_SANDBOX", workspacesRoot: "C:\\KaguraRunner\\workspaces", profilesRoot: "C:\\KaguraRunner\\profiles", repoRoot: "C:\\repo", isolateAllJobs: false },
    { accountExists: true, isAdmin: false, aclOk: true, secretAclOk: true, executableOk: true },
  );
  assert.equal(result.ok, true);
  assert.equal(result.sandboxUser, "KAGURA_SANDBOX");
});

check("isolation disabled mode always fails closed", () => {
  const result = assessIsolation(
    { mode: "none", sandboxUser: "KAGURA_SANDBOX", workspacesRoot: "x", profilesRoot: "x", repoRoot: "x", isolateAllJobs: false },
    { accountExists: true, isAdmin: false, aclOk: true },
  );
  assert.equal(result.ok, false);
});

/* ---------- Sandbox spawn command (no cmd.exe, args as data) ---------- */

check("sandbox spawn command uses PowerShell, never cmd.exe, and passes args as data", () => {
  const cmd = buildSandboxSpawnCommand({
    nodeExe: "C:\\Program Files\\nodejs\\node.exe",
    cliEntry: "C:\\runner-root\\node_modules\\@testmuai\\kane-cli\\bin\\kane-cli.cjs",
    args: ["run", "sign in", "--agent", "--url", "https://example.com"],
    cwd: "C:\\runner-root\\data\\verification\\workspaces\\job-1",
    stdoutFile: "C:\\runner-root\\data\\verification\\workspaces\\job-1\\logs\\stdout-abc.txt",
    stderrFile: "C:\\runner-root\\data\\verification\\workspaces\\job-1\\logs\\stderr-abc.txt",
    sandboxUser: "KAGURA_SANDBOX",
    passwordFile: "C:\\runner-root\\data\\verification\\workspaces\\job-1\\logs\\.sandbox-pw-abc.txt",
  });
  assert.equal(cmd[0], "powershell.exe");
  assert.ok(cmd.includes("-Command"));
  assert.ok(!cmd.some((a) => a.toLowerCase().includes("cmd.exe")));
  const commandIndex = cmd.indexOf("-Command");
  const ps = cmd[commandIndex + 1];
  assert.ok(ps.includes("Get-Content"), "password must be read from a file");
  assert.ok(ps.includes("ConvertTo-SecureString -AsPlainText -Force"));
  assert.ok(!ps.includes("s3cr3t"), "plaintext password must not appear in the PowerShell command");
  assert.ok(ps.includes("kane-cli.cjs"));
  assert.ok(ps.includes("sign in"));
  assert.ok(ps.includes("https://example.com"));
});

/* ---------- runKane rejects invalid input without spawning ---------- */

check("runKane rejects empty objective (did_not_start, no spawn)", async () => {
  const res = await runKane({ objective: "", url: "https://example.com" });
  assert.equal(res.outcome, "did_not_start");
  assert.equal(res.exitCode, 2);
});

check("runKane rejects file: URL (did_not_start, no spawn)", async () => {
  const res = await runKane({ objective: "sign in", url: "file:///C:/Windows/win.ini" });
  assert.equal(res.outcome, "did_not_start");
  assert.equal(res.exitCode, 2);
});

console.log(`\n${pass} runner adversarial checks passed`);
