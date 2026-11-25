import {
  isTargetAuthMode,
  isTargetAuthEvidenceType,
  type TargetAuthMode,
  type TargetAuthEvidenceConfig,
  type ProjectTargetAuthConfig,
} from "@/types/target-auth";

const MAX_IDENTITY = 256;
const MAX_URL = 512;
const MAX_SELECTOR = 512;
const SECRET_KEY_PATTERN = /password|secret|token|cookie|credential|access_key|api_key/i;

function rejectSecrets(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (SECRET_KEY_PATTERN.test(key)) return true;
    const v = obj[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (rejectSecrets(v as Record<string, unknown>)) return true;
    }
  }
  return false;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

export function validateTargetAuthMode(value: unknown): ValidationResult<TargetAuthMode> {
  if (value === undefined || value === null) {
    return { ok: true, value: "unconfigured", errors: [] };
  }
  if (!isTargetAuthMode(value)) {
    return { ok: false, errors: ["targetAuthMode must be one of: public, protected, unconfigured"] };
  }
  return { ok: true, value, errors: [] };
}

export function validateTargetAuthEvidence(
  value: unknown,
  mode: TargetAuthMode,
): ValidationResult<TargetAuthEvidenceConfig | undefined> {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined, errors: [] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["targetAuthEvidence must be an object"] };
  }
  const obj = value as Record<string, unknown>;
  if (rejectSecrets(obj)) {
    return { ok: false, errors: ["targetAuthEvidence must not contain secret-bearing fields"] };
  }
  if (!isTargetAuthEvidenceType(obj.type)) {
    return { ok: false, errors: ["targetAuthEvidence.type must be a valid evidence type"] };
  }
  const errors: string[] = [];
  const expectedIdentity = typeof obj.expectedIdentity === "string" ? obj.expectedIdentity.trim() : undefined;
  const protectedUrl = typeof obj.protectedUrl === "string" ? obj.protectedUrl.trim() : undefined;
  const selectorHint = typeof obj.selectorHint === "string" ? obj.selectorHint.trim() : undefined;

  if (mode !== "protected") {
    return { ok: false, errors: ["targetAuthEvidence may only be set when targetAuthMode is protected"] };
  }

  if (expectedIdentity && expectedIdentity.length > MAX_IDENTITY) errors.push("expectedIdentity too long");
  if (protectedUrl && protectedUrl.length > MAX_URL) errors.push("protectedUrl too long");
  if (selectorHint && selectorHint.length > MAX_SELECTOR) errors.push("selectorHint too long");

  if (errors.length > 0) return { ok: false, errors };
  const result: TargetAuthEvidenceConfig = { type: obj.type as TargetAuthEvidenceConfig["type"] };
  if (expectedIdentity) result.expectedIdentity = expectedIdentity;
  if (protectedUrl) result.protectedUrl = protectedUrl;
  if (selectorHint) result.selectorHint = selectorHint;
  return { ok: true, value: result, errors: [] };
}

export function validateProjectTargetAuthConfig(
  body: unknown,
): ValidationResult<ProjectTargetAuthConfig> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: ["request body must be an object"] };
  }
  const obj = body as Record<string, unknown>;
  if (rejectSecrets(obj)) {
    return { ok: false, errors: ["request must not contain secret-bearing fields"] };
  }
  const modeRes = validateTargetAuthMode(obj.targetAuthMode);
  if (!modeRes.ok) return { ok: false, errors: modeRes.errors };
  const mode = modeRes.value as TargetAuthMode;
  const evRes = validateTargetAuthEvidence(obj.targetAuthEvidence, mode);
  if (!evRes.ok) return { ok: false, errors: evRes.errors };
  return {
    ok: true,
    value: {
      targetAuthMode: mode,
      ...(evRes.value ? { targetAuthEvidence: evRes.value } : {}),
    },
    errors: [],
  };
}
