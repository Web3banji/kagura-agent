/**
 * Shared error types for authorization and input validation.
 *
 * Kept in a dependency-free module so that both the store layer and the HTTP
 * guards can use them without creating an import cycle.
 */

/** Thrown when a principal attempts to read or mutate a record it does not own. */
export class AccessDeniedError extends Error {
  readonly status = 403;
  constructor(message = "Access denied") {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function isAccessDeniedError(err: unknown): err is AccessDeniedError {
  return err instanceof AccessDeniedError || (err instanceof Error && err.name === "AccessDeniedError");
}

/** Thrown when user-supplied input fails validation before anything is persisted. */
export class InputValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

export function isInputValidationError(err: unknown): err is InputValidationError {
  return err instanceof InputValidationError || (err instanceof Error && err.name === "InputValidationError");
}