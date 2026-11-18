import { timingSafeEqual } from "crypto";

export function getRunnerToken(): string | undefined {
  return process.env.KAGURA_RUNNER_TOKEN || undefined;
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
  if (!token) return false;
  const auth = req.headers.get("authorization") || "";
  let provided = "";
  if (auth.toLowerCase().startsWith("bearer ")) provided = auth.slice(7).trim();
  if (!provided) {
    provided = (req.headers.get("x-runner-token") || req.headers.get("x-kagura-runner-token") || "").trim();
  }
  if (!provided) return false;
  return safeEqual(provided, token);
}

export function runnerUnauthorized(message = "Unauthorized runner"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
