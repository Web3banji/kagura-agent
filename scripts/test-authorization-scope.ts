/**
 * Authorization scope regression tests (no DB).
 * Run: npx tsx scripts/test-authorization-scope.ts
 */
import assert from "node:assert";
import { canAccessOwnedRecord, canAccessRequestedByRecord, filterVisible, scopeForPrincipal } from "@/lib/auth/scope";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
}

check("ordinary user scope is non-privileged and own-only", () => {
  const scope = scopeForPrincipal({ kind: "user", userId: "u1", user: { id: "u1", isBootstrapOwner: false } as any });
  assert.equal(scope.privileged, false);
  assert.equal(scope.userId, "u1");
  assert.equal(canAccessOwnedRecord("u1", scope), true);
  assert.equal(canAccessOwnedRecord("u2", scope), false);
  assert.equal(canAccessOwnedRecord(null, scope), false);
});

check("bootstrap owner is privileged", () => {
  const scope = scopeForPrincipal({ kind: "user", userId: "u1", user: { id: "u1", isBootstrapOwner: true } as any });
  assert.equal(scope.privileged, true);
  assert.equal(canAccessOwnedRecord("u2", scope), true);
});

check("requestedBy records fail closed for legacy when non-privileged", () => {
  const scope = { userId: "u1", privileged: false, includeLegacy: false };
  assert.equal(canAccessRequestedByRecord("u1", scope), true);
  assert.equal(canAccessRequestedByRecord("u2", scope), false);
  assert.equal(canAccessRequestedByRecord(null, scope), false);
  assert.equal(canAccessRequestedByRecord("", scope), false);
});

check("filterVisible excludes other users and legacy for ordinary scope", () => {
  const scope = { userId: "u1", privileged: false, includeLegacy: false };
  const items = [{ userId: "u1", id: 1 }, { userId: "u2", id: 2 }, { userId: null, id: 3 }];
  assert.deepEqual(filterVisible(items, scope).map((i) => i.id), [1]);
});

console.log(`\n${passed} checks passed`);
