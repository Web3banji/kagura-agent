import { createHash } from "crypto";

export function getAdminToken(): string | undefined {
  return process.env.KAGURA_ADMIN_TOKEN || process.env.ECHOLOG_ADMIN_TOKEN || process.env.ADMIN_PASSWORD;
}

export function adminAuthConfigured(): boolean {
  return !!getAdminToken();
}

export function isAdminAuthorized(req: Request): boolean {
  const token = getAdminToken();
  if (!token) {
    return process.env.NODE_ENV !== "production" && !process.env.VERCEL;
  }
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ") && auth.slice(7) === token) return true;
  if (auth.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const pass = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
      if (pass === token || decoded === token) return true;
    } catch {}
  }
  const header =
    req.headers.get("x-admin-token") ||
    req.headers.get("x-kagura-admin-token") ||
    req.headers.get("x-echolog-admin-token");
  if (header && header === token) return true;
  return false;
}

export function unauthorizedResponse(message = "Unauthorized"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Basic realm="KAGURA Admin"',
    },
  });
}

export type AuthPrincipal = { userId: string; authorized: boolean; reason?: string };

export function getRequestPrincipal(req: Request): AuthPrincipal {
  const token = getAdminToken();
  if (!token) {
    const devOk = process.env.NODE_ENV !== "production" && !process.env.VERCEL;
    return {
      userId: devOk ? "local-dev" : "anonymous",
      authorized: devOk,
      reason: devOk ? undefined : "Admin authentication required",
    };
  }
  if (isAdminAuthorized(req)) {
    const userId = "admin:" + createHash("sha256").update(token).digest("hex").slice(0, 16);
    return { userId, authorized: true };
  }
  return { userId: "anonymous", authorized: false, reason: "Unauthorized" };
}
