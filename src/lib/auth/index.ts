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
