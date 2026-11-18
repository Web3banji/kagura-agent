import crypto from "crypto";

const PREFIX = "kagenc";
const VERSION = "v1";
const ALG = "aes-256-gcm" as const;
const IV_LEN = 12;
const KEY_LEN = 32;

type KeyEntry = { kid: string; key: Buffer };

let cachedKeyring: { primary: KeyEntry; fallbacks: KeyEntry[] } | null = null;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function isHex32(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

function decodeBase64Like(s: string): Buffer | null {
  // Accept base64url and standard base64. Validate by length and conservative char set.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  try {
    const buf = s.includes("-") || s.includes("_") ? Buffer.from(s, "base64url") : Buffer.from(s, "base64");
    return buf;
  } catch {
    return null;
  }
}

function parseKeyMaterial(raw: string, source: string): Buffer {
  const s = raw.trim();
  let buf: Buffer | null = null;
  if (isHex32(s)) {
    buf = Buffer.from(s, "hex");
  } else {
    buf = decodeBase64Like(s);
  }
  if (!buf || buf.length !== KEY_LEN) {
    throw new Error(`${source} must decode to exactly 32 bytes (base64/base64url or 64-char hex)`);
  }
  return buf;
}

function computeKid(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("base64url").slice(0, 12);
}

function splitKeyEntries(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadKeyring(): { primary: KeyEntry; fallbacks: KeyEntry[] } {
  if (cachedKeyring) return cachedKeyring;
  const primaryRaw = process.env.KAGURA_TOKEN_ENCRYPTION_KEY;
  if (!primaryRaw || !primaryRaw.trim()) {
    throw new Error("KAGURA_TOKEN_ENCRYPTION_KEY is not configured");
  }
  const primaryKey = parseKeyMaterial(primaryRaw, "KAGURA_TOKEN_ENCRYPTION_KEY");
  const primary: KeyEntry = { kid: computeKid(primaryKey), key: primaryKey };
  const fallbacks: KeyEntry[] = [];
  const prev = process.env.KAGURA_TOKEN_ENCRYPTION_KEY_PREVIOUS;
  if (prev && prev.trim()) {
    for (const part of splitKeyEntries(prev)) {
      const k = parseKeyMaterial(part, "KAGURA_TOKEN_ENCRYPTION_KEY_PREVIOUS");
      const kid = computeKid(k);
      if (kid !== primary.kid && !fallbacks.some((f) => f.kid === kid)) {
        fallbacks.push({ kid, key: k });
      }
    }
  }
  cachedKeyring = { primary, fallbacks };
  return cachedKeyring;
}

export function resetTokenCryptoCacheForTests(): void {
  cachedKeyring = null;
}

export function validateTokenEncryptionKey(): { ok: true; kid: string } {
  const { primary } = loadKeyring();
  return { ok: true, kid: primary.kid };
}

export function isEncryptedTokenValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(`${PREFIX}$${VERSION}$`);
}

export function encryptToken(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new Error("Token value must be a string");
  }
  const { primary } = loadKeyring();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, primary.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: kagenc$v1$<kid>$<iv_b64url>$<ct_b64url>$<tag_b64url>
  return `${PREFIX}$${VERSION}$${primary.kid}$${b64url(iv)}$${b64url(ciphertext)}$${b64url(tag)}`;
}

export function decryptToken(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Token value must be a string");
  }
  if (!isEncryptedTokenValue(value)) {
    // Backward-compatible plaintext read (including when encryption key is not configured).
    return value;
  }
  const parts = value.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX || parts[1] !== VERSION) {
    throw new Error("Unsupported encrypted token format");
  }
  const kid = parts[2];
  const iv = fromB64url(parts[3]);
  const ciphertext = fromB64url(parts[4]);
  const tag = fromB64url(parts[5]);
  if (iv.length !== IV_LEN) {
    throw new Error("Invalid encrypted token payload");
  }

  const { primary, fallbacks } = loadKeyring();
  const ordered: KeyEntry[] = [];
  if (primary.kid === kid) ordered.push(primary);
  for (const fb of fallbacks) if (fb.kid === kid) ordered.push(fb);
  // Future-compat/key-id mismatch fallback: try all configured keys.
  for (const k of [primary, ...fallbacks]) if (!ordered.some((o) => o.kid === k.kid)) ordered.push(k);

  for (const entry of ordered) {
    try {
      const decipher = crypto.createDecipheriv(ALG, entry.key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString("utf8");
    } catch {
      // try next candidate
    }
  }
  throw new Error("Failed to decrypt token value");
}

export function encryptStoredToken(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  if (isEncryptedTokenValue(value)) return value;
  return encryptToken(value);
}

export function decryptStoredToken(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  return decryptToken(value);
}

export type AccountTokenFields = {
  access_token?: string | null;
  refresh_token?: string | null;
  id_token?: string | null;
};

export function encryptAccountTokenFields<T extends AccountTokenFields>(fields: T): T {
  return {
    ...fields,
    access_token: encryptStoredToken(fields.access_token) as T["access_token"],
    refresh_token: encryptStoredToken(fields.refresh_token) as T["refresh_token"],
    id_token: encryptStoredToken(fields.id_token) as T["id_token"],
  };
}

export function decryptAccountTokenFields<T extends AccountTokenFields>(fields: T): T {
  return {
    ...fields,
    access_token: decryptStoredToken(fields.access_token) as T["access_token"],
    refresh_token: decryptStoredToken(fields.refresh_token) as T["refresh_token"],
    id_token: decryptStoredToken(fields.id_token) as T["id_token"],
  };
}
