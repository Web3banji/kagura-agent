import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { resolveKaneCliEntry } = await import("./kane-verify.mjs");

const entry = resolveKaneCliEntry();
console.log("RESOLVED_CLI", entry);
assert.ok(entry.endsWith("node_modules\\@testmuai\\kane-cli\\bin\\kane-cli.cjs"));
assert.ok(fs.existsSync(entry));

const prev = process.env.KAGURA_KANE_CLI_BIN;
process.env.KAGURA_KANE_CLI_BIN = "C:\\definitely-missing-kane-cli.cjs";
assert.equal(resolveKaneCliEntry(), entry);
process.env.KAGURA_KANE_CLI_BIN = import.meta.filename;
assert.equal(resolveKaneCliEntry(), path.resolve(process.env.KAGURA_KANE_CLI_BIN));
if (prev === undefined) delete process.env.KAGURA_KANE_CLI_BIN; else process.env.KAGURA_KANE_CLI_BIN = prev;

console.log("ADAPTER_TESTS_PASS");
