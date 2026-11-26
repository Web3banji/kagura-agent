const assert = require("node:assert/strict");
const { resolveKaneCliEntry } = require("./kane-verify.mjs");

const entry = resolveKaneCliEntry();
console.log("RESOLVED_CLI", entry);
assert.ok(entry.endsWith("node_modules/@testmuai/kane-cli/bin/kane-cli.cjs"));
assert.ok(require("fs").existsSync(entry));

const prev = process.env.KAGURA_KANE_CLI_BIN;
process.env.KAGURA_KANE_CLI_BIN = "C:\\definitely-missing-kane-cli.cjs";
assert.equal(resolveKaneCliEntry(), entry);
process.env.KAGURA_KANE_CLI_BIN = __filename;
assert.equal(resolveKaneCliEntry(), require("path").resolve(__filename));
if (prev === undefined) delete process.env.KAGURA_KANE_CLI_BIN; else process.env.KAGURA_KANE_CLI_BIN = prev;

console.log("ADAPTER_TESTS_PASS");
