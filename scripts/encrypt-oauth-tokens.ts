/**
 * Explicit, non-destructive migration: encrypt existing plaintext OAuth token fields in `accounts`.
 * - Reads rows, detects legacy plaintext vs encrypted (`kagenc$v1$...`) values.
 * - Encrypts only plaintext token fields (access_token, refresh_token, id_token) using the configured key.
 * - Idempotent: re-running skips already-encrypted values.
 * - Does NOT delete or overwrite unrelated columns/rows; does NOT run automatically.
 *
 * Usage (local/dev, after setting DATABASE_URL and KAGURA_TOKEN_ENCRYPTION_KEY):
 *   node --experimental-strip-types scripts/encrypt-oauth-tokens.ts
 *   node --experimental-strip-types scripts/encrypt-oauth-tokens.ts --dry-run
 */
import fs from "fs";
import pg from "pg";
import { encryptStoredToken, isEncryptedTokenValue, validateTokenEncryptionKey } from "../src/lib/auth/token-crypto.ts";

function loadDotEnvLocal() {
  try {
    const txt = fs.readFileSync(".env.local", "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith("#")) continue;
      const m = line.match(/^([^=]+)=(.*)$/);
      if (!m) continue;
      const k = m[1].trim();
      if (process.env[k]) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[k] = v;
    }
  } catch {}
}

const TOKEN_FIELDS = ["access_token", "refresh_token", "id_token"] as const;

async function main() {
  loadDotEnvLocal();
  const dryRun = process.argv.includes("--dry-run");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  // Validates key format/length (does not print key material).
  validateTokenEncryptionKey();

  const cs = process.env.DATABASE_URL;
  const local = cs.includes("localhost") || cs.includes("127.0.0.1");
  const pool = new pg.Pool({ connectionString: cs, ssl: local ? false : { rejectUnauthorized: false }, max: 2 });
  let scanned = 0, updated = 0, skippedEncrypted = 0, skippedNull = 0, errors = 0;
  try {
    const res = await pool.query(
      `SELECT id, access_token, refresh_token, id_token FROM accounts ORDER BY id FOR UPDATE`
    ).catch(async () => {
      // Fallback without FOR UPDATE if not in a transaction-friendly context in some drivers; use plain select.
      return pool.query(`SELECT id, access_token, refresh_token, id_token FROM accounts ORDER BY id`);
    });
    for (const row of res.rows as Array<Record<string, unknown>>) {
      scanned++;
      const id = String(row.id);
      const sets: string[] = [];
      const vals: unknown[] = [];
      let idx = 1;
      let rowNeeds = false;
      for (const field of TOKEN_FIELDS) {
        const val = row[field];
        if (val == null) { skippedNull++; continue; }
        const s = String(val);
        if (isEncryptedTokenValue(s)) { skippedEncrypted++; continue; }
        // plaintext -> encrypt
        const enc = encryptStoredToken(s);
        sets.push(`${field} = $${idx++}`);
        vals.push(enc);
        rowNeeds = true;
      }
      if (!rowNeeds) continue;
      sets.push(`updated_at = NOW()`);
      vals.push(id);
      if (dryRun) {
        updated++;
        continue;
      }
      try {
        await pool.query(`UPDATE accounts SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
        updated++;
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({ level: "error", event: "token_migration_row_failed", account_id: id, error: msg }));
      }
    }
    console.log(JSON.stringify({ ok: errors === 0, dryRun, scanned, updated, skippedEncrypted, skippedNullFields: skippedNull, errors }));
    if (errors > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
});

