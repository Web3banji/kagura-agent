import assert from "node:assert/strict";
const { mapOutcome } = await import("./kane-verify.mjs");

assert.equal(mapOutcome(0, "passed"), "passed");
assert.equal(mapOutcome(0, "failed"), "failed");
assert.equal(mapOutcome(1, "passed"), "failed");
assert.equal(mapOutcome(1, undefined), "failed");
assert.equal(mapOutcome(2, undefined), "did_not_start");
assert.equal(mapOutcome(3, undefined), "timeout");
assert.equal(mapOutcome(0, undefined), "blocked");
assert.equal(mapOutcome(0, "blocked"), "blocked");

console.log("TERMINAL_EVENT_TESTS_PASS: 8");
