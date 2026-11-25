export type TargetAuthMode = "public" | "protected" | "unconfigured";

export type TargetAuthState =
  | "not_required"
  | "authenticated"
  | "login_required"
  | "session_expired"
  | "blocked"
  | "unknown"
  | "unavailable";

export type TargetAuthEvidenceType =
  | "authenticated_identity"
  | "protected_resource_access"
  | "authenticated_dashboard_element";

export interface TargetAuthEvidenceConfig {
  type: TargetAuthEvidenceType;
  expectedIdentity?: string;
  protectedUrl?: string;
  selectorHint?: string;
}

export interface ProjectTargetAuthConfig {
  targetAuthMode: TargetAuthMode;
  targetAuthEvidence?: TargetAuthEvidenceConfig;
}

export const TARGET_AUTH_MODES: readonly TargetAuthMode[] = [
  "public",
  "protected",
  "unconfigured",
] as const;

export const TARGET_AUTH_STATES: readonly TargetAuthState[] = [
  "not_required",
  "authenticated",
  "login_required",
  "session_expired",
  "blocked",
  "unknown",
  "unavailable",
] as const;

export const TARGET_AUTH_EVIDENCE_TYPES: readonly TargetAuthEvidenceType[] = [
  "authenticated_identity",
  "protected_resource_access",
  "authenticated_dashboard_element",
] as const;

export function isTargetAuthMode(value: unknown): value is TargetAuthMode {
  return typeof value === "string" && (TARGET_AUTH_MODES as readonly string[]).includes(value);
}

export function isTargetAuthState(value: unknown): value is TargetAuthState {
  return typeof value === "string" && (TARGET_AUTH_STATES as readonly string[]).includes(value);
}

export function isTargetAuthEvidenceType(value: unknown): value is TargetAuthEvidenceType {
  return typeof value === "string" && (TARGET_AUTH_EVIDENCE_TYPES as readonly string[]).includes(value);
}
