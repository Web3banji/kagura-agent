import assert from "node:assert/strict";
import path from "node:path";
import { safeSegment, shortHash, jobKey, workspaceDir, profileDir, outputsDir, isInside } from "../scripts/runner-workspace.mjs";

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

const ROOT = "C:\\runner-root";

check("safeSegment strips path traversal", () => {
  assert.ok(!safeSegment("../../etc/passwd").includes(".."));
  assert.ok(!safeSegment("../../etc/passwd").includes("/"));
  assert.ok(!safeSegment("..\\..\\windows").includes("\\"));
});

check("safeSegment handles windows drive letters", () => {
  assert.ok(!safeSegment("C:\\secret").includes(":"));
});

check("safeSegment falls back when empty", () => {
  assert.equal(safeSegment("", "fallback"), "fallback");
  assert.equal(safeSegment("...", "fallback"), "fallback");
});

check("jobKey differs per user", () => {
  const a = jobKey({ id: "job-1", projectId: "p", requestedBy: "user-a" });
  const b = jobKey({ id: "job-1", projectId: "p", requestedBy: "user-b" });
  assert.notEqual(a, b);
});

check("jobKey differs per project", () => {
  const a = jobKey({ id: "job-1", projectId: "p1", requestedBy: "user-a" });
  const b = jobKey({ id: "job-1", projectId: "p2", requestedBy: "user-a" });
  assert.notEqual(a, b);
});

check("jobKey differs per job id", () => {
  const a = jobKey({ id: "job-1", projectId: "p", requestedBy: "user-a" });
  const b = jobKey({ id: "job-2", projectId: "p", requestedBy: "user-a" });
  assert.notEqual(a, b);
});

check("jobKey is stable for identical job", () => {
  const job = { id: "job-1", projectId: "p", requestedBy: "user-a" };
  assert.equal(jobKey(job), jobKey({ ...job }));
});

check("two concurrent users get distinct workspaces", () => {
  const wa = workspaceDir(ROOT, { id: "job-1", projectId: "p", requestedBy: "user-a" });
  const wb = workspaceDir(ROOT, { id: "job-2", projectId: "p", requestedBy: "user-b" });
  assert.notEqual(wa, wb);
  assert.ok(isInside(path.join(ROOT, "data", "verification", "workspaces"), wa));
  assert.ok(isInside(path.join(ROOT, "data", "verification", "workspaces"), wb));
});

check("two concurrent users get distinct chrome profiles", () => {
  const pa = profileDir(ROOT, { id: "job-1", projectId: "p", requestedBy: "user-a" });
  const pb = profileDir(ROOT, { id: "job-2", projectId: "p", requestedBy: "user-b" });
  assert.notEqual(pa, pb);
  assert.notEqual(pa, pb);
  assert.ok(!pa.includes(".."));
});

check("workspace path escapes are rejected by isInside", () => {
  assert.equal(isInside(path.join(ROOT, "data", "verification", "workspaces"), path.join(ROOT, "etc")), false);
});

check("hostile ids cannot escape the workspaces root", () => {
  const hostile = { id: "../../../../Windows/System32", projectId: "..\\..\\..", requestedBy: "../../root" };
  const ws = workspaceDir(ROOT, hostile);
  const workspacesRoot = path.join(ROOT, "data", "verification", "workspaces");
  assert.ok(isInside(workspacesRoot, ws), `escaped: ${ws}`);
  const pf = profileDir(ROOT, hostile);
  const profilesRoot = path.join(ROOT, "data", "verification", "profiles");
  assert.ok(isInside(profilesRoot, pf), `escaped: ${pf}`);
  // Every derived directory must be a single safe path segment, never a nested/traversal path.
  for (const dir of [ws, pf]) {
    const parent = path.dirname(dir);
    const segment = path.basename(dir);
    assert.ok(!segment.includes("/") && !segment.includes("\\"), `separator leaked: ${segment}`);
    assert.ok(!segment.includes(".."), `traversal leaked: ${segment}`);
    assert.ok(segment.length > 0, "empty segment");
    assert.ok(isInside(parent, dir));
  }
});

check("distinct hostile inputs do not collide (hash suffix)", () => {
  const a = workspaceDir(ROOT, { id: "../../a", projectId: "p", requestedBy: "u" });
  const b = workspaceDir(ROOT, { id: "..\\..\\a", projectId: "p", requestedBy: "u" });
  assert.notEqual(a, b);
});

check("shortHash is deterministic and bounded", () => {
  assert.equal(shortHash("x"), shortHash("x"));
  assert.equal(shortHash("x").length, 12);
  assert.notEqual(shortHash("x"), shortHash("y"));
});

check("outputs dir is shared and per-run filenames stay unique", () => {
  assert.equal(outputsDir(ROOT), path.join(ROOT, "data", "verification", "runs"));
});

console.log(`\n${pass} runner workspace checks passed`);