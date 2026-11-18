/**
 * Typed facade over the canonical runner security module.
 *
 * The single implementation lives in `scripts/runner-security.mjs` so that the
 * standalone runner (`scripts/kane-runner.mjs`) and the Next.js application share
 * exactly the same validation rules. This module only adds compile-time types; it
 * contains no security logic of its own and must never be used to re-implement a
 * check that already exists there.
 */
import * as canonical from "../../../scripts/runner-security.mjs";

export type ValidationFailure = { ok: false; reason: string };
export type ObjectiveValidation = { ok: true; objective: string } | ValidationFailure;
export type UrlValidation = { ok: true; url: string } | ValidationFailure;
export type FlowValidation = { ok: true; flow: string } | ValidationFailure;

export type ValidatedJob = {
  ok: true;
  objective: string;
  url: string;
  flow: string;
  timeout: number;
  headless: boolean;
};

export const MAX_OBJECTIVE_LEN: number = canonical.MAX_OBJECTIVE_LEN;
export const MAX_URL_LEN: number = canonical.MAX_URL_LEN;
export const MAX_FLOW_LEN: number = canonical.MAX_FLOW_LEN;
export const MIN_TIMEOUT_SEC: number = canonical.MIN_TIMEOUT_SEC;
export const MAX_TIMEOUT_SEC: number = canonical.MAX_TIMEOUT_SEC;
export const DEFAULT_TIMEOUT_SEC: number = canonical.DEFAULT_TIMEOUT_SEC;
export const SAFE_CHILD_ENV_NAMES: readonly string[] = canonical.SAFE_CHILD_ENV_NAMES;

export function isSecretEnvName(name: string): boolean {
  return canonical.isSecretEnvName(name);
}

export function buildChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  options?: { overrides?: Record<string, string>; extraNames?: string[] },
): Record<string, string | undefined> {
  return canonical.buildChildEnv(baseEnv, options) as Record<string, string | undefined>;
}

export function validateObjective(raw: unknown): ObjectiveValidation {
  return canonical.validateObjective(raw) as ObjectiveValidation;
}

export function validateUrl(raw: unknown): UrlValidation {
  return canonical.validateUrl(raw) as UrlValidation;
}

export function validateFlow(raw: unknown): FlowValidation {
  return canonical.validateFlow(raw) as FlowValidation;
}

export function normalizeTimeout(raw: unknown): number {
  return canonical.normalizeTimeout(raw) as number;
}

export function normalizeHeadless(raw: unknown): boolean {
  return canonical.normalizeHeadless(raw) as boolean;
}

export function validateJobForExecution(job: unknown): ValidatedJob | ValidationFailure {
  return canonical.validateJobForExecution(job) as ValidatedJob | ValidationFailure;
}

export function isShellSafeArg(value: unknown): boolean {
  return canonical.isShellSafeArg(value) as boolean;
}

export function hasUnsafeCmdChars(value: unknown): boolean {
  return canonical.hasUnsafeCmdChars(value) as boolean;
}

/**
 * Normalize an untrusted `{ flow, objective, url, timeout, headless }` request body
 * into values that are safe to store on a job. Throws `InputValidationError` when a
 * field cannot be validated, so callers can return HTTP 400 before anything is
 * persisted or scheduled.
 */
export class InputValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

export type NormalizedJobInput = {
  flow: string;
  objective: string;
  url: string;
  timeout: number;
  headless: boolean;
};

export function normalizeJobInput(body: unknown, opts?: { defaultUrl?: string }): NormalizedJobInput {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const flowResult = validateFlow(raw.flow);
  if (!flowResult.ok) throw new InputValidationError(flowResult.reason);

  const objectiveResult = validateObjective(raw.objective);
  if (!objectiveResult.ok) throw new InputValidationError(objectiveResult.reason);

  const candidateUrl =
    typeof raw.url === "string" && raw.url.trim()
      ? raw.url
      : typeof opts?.defaultUrl === "string" && opts.defaultUrl.trim()
        ? opts.defaultUrl
        : "";
  const urlResult = validateUrl(candidateUrl);
  if (!urlResult.ok) throw new InputValidationError(urlResult.reason);

  const timeout = raw.timeout === undefined || raw.timeout === null ? normalizeTimeout(undefined) : normalizeTimeout(raw.timeout);

  return {
    flow: flowResult.flow,
    objective: objectiveResult.objective,
    url: urlResult.url,
    timeout,
    headless: normalizeHeadless(raw.headless),
  };
}