/**
 * Deterministic tests for scripts/kane-readiness.mjs.
 * No Kane CLI execution, no browser, no DB.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessKaneReadiness, classifyWhoamiResult, READINESS_STATES, sanitizeReadinessText } from "./kane-readiness.mjs";

let passed = 0;
function check(name, cond) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }

async function main() {
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-profile-"));
  check("missing executable -> kane_missing", (await assessKaneReadiness({ resolveEntry: () => null })).state === READINESS_STATES.KANE_MISSING);

  const fakeEntry = path.join(os.tmpdir(), "kane-fake.cjs");
  fs.writeFileSync(fakeEntry, "module.exports={}", "utf8");

  const ready = await assessKaneReadiness({ resolveEntry: () => fakeEntry, profileDir: tmpProfile, runCommand: async () => ({ exitCode: 0, stdout: "Authenticated", stderr: "", timedOut: false, spawnError: null }) });
  check("authenticated whoami -> ready", ready.ready === true && ready.state === READINESS_STATES.READY);

  const unauth = await assessKaneReadiness({ resolveEntry: () => fakeEntry, profileDir: tmpProfile, runCommand: async () => ({ exitCode: 1, stdout: "whoami: not-authenticated", stderr: "", timedOut: false, spawnError: null }) });
  check("not authenticated -> kane_unauthenticated", unauth.state === READINESS_STATES.KANE_UNAUTHENTICATED);

  const expired = await assessKaneReadiness({ resolveEntry: () => fakeEntry, profileDir: tmpProfile, runCommand: async () => ({ exitCode: 1, stdout: "Credentials rejected by the server — re-login", stderr: "", timedOut: false, spawnError: null }) });
  check("rejected/expired -> kane_auth_expired", expired.state === READINESS_STATES.KANE_AUTH_EXPIRED);

  const refreshExpired = classifyWhoamiResult({ exitCode: 1, stdout: "OAuth token refresh failed — run 'kane-cli login'", stderr: "" });
  check("refresh failed -> kane_auth_expired", refreshExpired.state === READINESS_STATES.KANE_AUTH_EXPIRED);

  const malformed = await assessKaneReadiness({ resolveEntry: () => fakeEntry, profileDir: tmpProfile, runCommand: async () => ({ exitCode: 0, stdout: "\u0000\u0001{{{not-json garbage", stderr: "", timedOut: false, spawnError: null }) });
  check("malformed output does not crash", typeof malformed.state === "string");

  const timedOut = await assessKaneReadiness({ resolveEntry: () => fakeEntry, profileDir: tmpProfile, runCommand: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true, spawnError: null }) });
  check("timeout -> unknown not ready", timedOut.state === READINESS_STATES.UNKNOWN && timedOut.ready === false);

  const badProfile = await assessKaneReadiness({ resolveEntry: () => fakeEntry, chromeProfileDir: "Z:\\nonexistent\\bad?profile", runCommand: async () => ({ exitCode: 0, stdout: "Authenticated", stderr: "" }) });
  check("bad profile path is not ready", badProfile.ready === false && [READINESS_STATES.PROFILE_UNAVAILABLE, READINESS_STATES.UNKNOWN].includes(badProfile.state));

  const sanitized = sanitizeReadinessText("Bearer abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.eyJabc.def KAGURA_RUNNER_TOKEN=supersecret password=hunter2");
  check("sanitization redacts bearer", !/abcdefghijklmnopqrstuvwxyz/i.test(sanitized));
  check("sanitization redacts token assignment", !/supersecret/.test(sanitized));
  check("sanitization redacts password", !/hunter2/.test(sanitized));

  const unreachable = classifyWhoamiResult({ exitCode: 3, stdout: "", stderr: "network unreachable" });
  check("unreachable -> unknown", unreachable.state === READINESS_STATES.UNKNOWN);

  console.log(`\n${passed} checks passed (kane-readiness)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
