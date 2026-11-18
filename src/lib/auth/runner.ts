import { timingSafeEqual } from "crypto";

export function getRunnerToken(): string | undefined {
  const v = process.env.KAGURA_RUNNER_TOKEN;
  if (v == null) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

export function runnerAuthConfigured(): boolean {
  return !!getRunnerToken();
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export function isRunnerAuthorized(req: Request): boolean {
  const token = getRunnerToken();
  const authHeader = req.headers.get("authorization");
  const hasAuthHeader = authHeader != null && authHeader !== "";
  const bearerPrefixValid =
    hasAuthHeader && authHeader.toLowerCase().startsWith("bearer ") && authHeader.length > 7;

  if (!token) {
    console.warn("[runner-auth] auth_failed reason=config_missing_token env=KAGURA_RUNNER_TOKEN_present=false");
    return false;
  }
  if (!hasAuthHeader) {
    console.warn(
      "[runner-auth] auth_failed reason=missing_authorization_header bearer_prefix_valid=false config_token_present=true",
    );
    return false;
  }
  if (!bearerPrefixValid) {
    console.warn(
      "[runner-auth] auth_failed reason=invalid_bearer_prefix bearer_prefix_valid=false config_token_present=true has_authorization_header=true",
    );
    return false;
  }
  const provided = authHeader.slice(7).trim();
  if (!provided) {
    console.warn(
      "[runner-auth] auth_failed reason=empty_bearer_token_after_trim bearer_prefix_valid=true config_token_present=true",
    );
    return false;
  }
  const ok = safeEqual(provided, token);
  if (!ok) {
    console.warn(
      "[runner-auth] auth_failed reason=token_mismatch bearer_prefix_valid=true config_token_present=true lengths_match=%s",
      provided.length === token.length,
    );
  }
  return ok;
}

export function runnerUnauthorized(message = "Unauthorized runner"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
