/**
 * Remediation 1: Command Center project context tests.
 * Run: npx tsx scripts/test-command-center-context.ts
 */
import assert from "node:assert";
import { resolveSelectedProjectId, recordVisibleInContext } from "@/lib/command-center/context";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
}

check("default to All projects when no selection", () => {
  assert.equal(resolveSelectedProjectId(undefined, ["p1", "p2"]), "all");
  assert.equal(resolveSelectedProjectId("", ["p1"]), "all");
  assert.equal(resolveSelectedProjectId("all", ["p1"]), "all");
});

check("accept visible project selection", () => {
  assert.equal(resolveSelectedProjectId("p2", ["p1", "p2"]), "p2");
});

check("invalid/inaccessible project falls back to All projects", () => {
  assert.equal(resolveSelectedProjectId("p-other", ["p1", "p2"]), "all");
  assert.equal(resolveSelectedProjectId("p-deleted", []), "all");
});

check("single-project filter scopes project-tagged records", () => {
  const ctx = { selectedProjectId: "p1", visibleProjectIds: ["p1", "p2"], allowLegacy: true };
  assert.equal(recordVisibleInContext({ projectId: "p1" }, ctx), true);
  assert.equal(recordVisibleInContext({ projectId: "p2" }, ctx), false);
});

check("single-project filter excludes legacy/unattributed records", () => {
  const ctx = { selectedProjectId: "p1", visibleProjectIds: ["p1", "p2"], allowLegacy: true };
  assert.equal(recordVisibleInContext({ projectId: undefined }, ctx), false);
  assert.equal(recordVisibleInContext({}, ctx), false);
});

check("All projects includes visible project records and legacy only when allowed", () => {
  const ctx = { selectedProjectId: "all" as const, visibleProjectIds: ["p1", "p2"], allowLegacy: true };
  assert.equal(recordVisibleInContext({ projectId: "p1" }, ctx), true);
  assert.equal(recordVisibleInContext({ projectId: "p2" }, ctx), true);
  assert.equal(recordVisibleInContext({ projectId: "p3" }, ctx), false);
  assert.equal(recordVisibleInContext({}, ctx), true);
  const noLegacy = { ...ctx, allowLegacy: false };
  assert.equal(recordVisibleInContext({}, noLegacy), false);
});

check("All projects aggregate does not misattribute by selecting first project", () => {
  const records = [
    { projectId: "p1", name: "A" },
    { projectId: "p2", name: "B" },
    { projectId: "p3", name: "C-other" },
  ];
  const ctx = { selectedProjectId: "all" as const, visibleProjectIds: ["p1", "p2"], allowLegacy: false };
  const visible = records.filter((r) => recordVisibleInContext(r, ctx));
  assert.deepEqual(visible.map((r) => r.projectId).sort(), ["p1", "p2"]);
});

check("project with no records yields empty scoped set", () => {
  const ctx = { selectedProjectId: "p-empty", visibleProjectIds: ["p-empty", "p1"], allowLegacy: true };
  const records = [{ projectId: "p1" }, { projectId: "p1" }];
  assert.deepEqual(records.filter((r) => recordVisibleInContext(r, ctx)), []);
});

console.log(`\n${passed} checks passed`);
