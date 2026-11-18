import assert from "node:assert/strict";
import {
  buildChildEnv,
  validateObjective,
  validateUrl,
  validateFlow,
  normalizeTimeout,
  normalizeHeadless,
  validateJobForExecution,
  isShellSafeArg,
  isSecretEnvName,
  MAX_TIMEOUT_SEC,
  MIN_TIMEOUT_SEC,
  DEFAULT_TIMEOUT_SEC,
} from "../scripts/runner-security.mjs";

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

check("child env strips platform secrets", () => {
  const env = buildChildEnv({
    Path: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    KAGURA_RUNNER_TOKEN: "runner-secret",
    KAGURA_TOKEN_ENCRYPTION_KEY: "key-material",
    GITHUB_TOKEN: "gh-token",
    GH_TOKEN: "gh-token",
    DATABASE_URL: "postgres://user:pass@host/db",
    NODE_OPTIONS: "--require evil.js",
    NODE_PATH: "C:\\evil",
    PATH_CREDENTIAL: "nope",
    SOME_API_KEY: "nope",
  });
  assert.equal(env.Path, "C:\\Windows", "Path must survive with its original casing");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.windir, "C:\\Windows");
  for (const name of [
    "KAGURA_RUNNER_TOKEN",
    "KAGURA_TOKEN_ENCRYPTION_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "DATABASE_URL",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PATH_CREDENTIAL",
    "SOME_API_KEY",
  ]) {
    assert.equal(env[name], undefined, `${name} leaked into child env`);
  }
});

check("child env honours operator opt-in but still blocks secrets", () => {
  const env = buildChildEnv(
    { HTTP_PROXY: "http://proxy:8080", KAGURA_SECRET: "nope" },
    { extraNames: ["HTTP_PROXY", "KAGURA_SECRET"] },
  );
  assert.equal(env.HTTP_PROXY, "http://proxy:8080");
  assert.equal(env.KAGURA_SECRET, undefined);
});

check("overrides are applied and secret overrides are dropped", () => {
  const env = buildChildEnv({}, { overrides: { KANE_CLI_USER_AGENT: "kilocode", GITHUB_TOKEN: "x" } });
  assert.equal(env.KANE_CLI_USER_AGENT, "kilocode");
  assert.equal(env.GITHUB_TOKEN, undefined);
});

check("isSecretEnvName classifies secrets", () => {
  for (const name of ["KAGURA_X", "GITHUB_TOKEN", "GH_SECRET", "DB_PASSWORD", "MY_API_KEY", "NODE_OPTIONS"]) {
    assert.equal(isSecretEnvName(name), true, `${name} should be secret`);
  }
  for (const name of ["PATH", "TEMP", "LANG", "HTTP_PROXY"]) {
    assert.equal(isSecretEnvName(name), false, `${name} should not be secret`);
  }
});

check("validateObjective rejects empty and overlong input", () => {
  assert.equal(validateObjective("   ").ok, false);
  assert.equal(validateObjective(123).ok, false);
  assert.equal(validateObjective("a".repeat(5000)).ok, false);
  const ok = validateObjective("  sign in and check the dashboard  ");
  assert.equal(ok.ok, true);
  assert.equal(ok.objective, "sign in and check the dashboard");
});

check("validateObjective rejects control characters", () => {
  assert.equal(validateObjective("line1\nline2").ok, false);
  assert.equal(validateObjective("tab\there").ok, false);
});

check("validateUrl only allows absolute http(s)", () => {
  assert.equal(validateUrl("file:///C:/Windows/System32").ok, false);
  assert.equal(validateUrl("javascript:alert(1)").ok, false);
  assert.equal(validateUrl("data:text/html,<script>").ok, false);
  assert.equal(validateUrl("/etc/passwd").ok, false);
  assert.equal(validateUrl("C:\\Windows\\System32").ok, false);
  assert.equal(validateUrl("https://example.com/a b").ok, false);
  assert.equal(validateUrl('https://example.com/"onmouseover="x').ok, false);
  assert.equal(validateUrl("").ok, false);
  const ok = validateUrl("https://example.com/path?q=1");
  assert.equal(ok.ok, true);
  assert.equal(ok.url, "https://example.com/path?q=1");
});

check("validateUrl rejects oversized values", () => {
  assert.equal(validateUrl(`https://example.com/${"a".repeat(3000)}`).ok, false);
});

check("validateFlow enforces strict allowlist", () => {
  assert.equal(validateFlow(undefined).flow, "shell-nav");
  assert.equal(validateFlow("").flow, "shell-nav");
  assert.equal(validateFlow("checkout-flow_1").flow, "checkout-flow_1");
  assert.equal(validateFlow("bad flow").ok, false);
  assert.equal(validateFlow("a".repeat(41)).ok, false);
  assert.equal(validateFlow("../../etc").ok, false);
  assert.equal(validateFlow("a;b").ok, false);
});

check("normalizeTimeout clamps to a safe range", () => {
  assert.equal(normalizeTimeout(undefined), DEFAULT_TIMEOUT_SEC);
  assert.equal(normalizeTimeout(0), DEFAULT_TIMEOUT_SEC);
  assert.equal(normalizeTimeout("nope"), DEFAULT_TIMEOUT_SEC);
  assert.equal(normalizeTimeout(5), MIN_TIMEOUT_SEC);
  assert.equal(normalizeTimeout(999999), MAX_TIMEOUT_SEC);
  assert.equal(normalizeTimeout(90), 90);
});

check("normalizeHeadless defaults to true", () => {
  assert.equal(normalizeHeadless(undefined), true);
  assert.equal(normalizeHeadless(false), false);
  assert.equal(normalizeHeadless(true), true);
});

check("validateJobForExecution validates every field at once", () => {
  const ok = validateJobForExecution({
    objective: "sign in",
    url: "https://example.com",
    flow: "shell-nav",
    timeout: 60,
    headless: true,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.objective, "sign in");
  assert.equal(ok.timeout, 60);

  assert.equal(validateJobForExecution(null).ok, false);
  assert.equal(validateJobForExecution({}).ok, false);
  assert.equal(validateJobForExecution({ objective: "x", url: "file:///etc" }).ok, false);
  assert.equal(validateJobForExecution({ objective: "", url: "https://example.com" }).ok, false);
  assert.equal(validateJobForExecution({ objective: "x", url: "https://example.com", flow: "a;b" }).ok, false);
});

check("isShellSafeArg rejects cmd metacharacters", () => {
  assert.equal(isShellSafeArg("kane-cli"), true);
  assert.equal(isShellSafeArg("C:\\Program Files\\node\\kane-cli"), true);
  assert.equal(isShellSafeArg("kane-cli&calc"), false);
  assert.equal(isShellSafeArg("kane-cli|calc"), false);
  assert.equal(isShellSafeArg("a>b"), false);
  assert.equal(isShellSafeArg("a\"b"), false);
  assert.equal(isShellSafeArg("a\nb"), false);
});

console.log(`\n${pass} runner security checks passed`);