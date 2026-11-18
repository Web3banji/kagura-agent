import { NextResponse } from "next/server";
import { requireUserApi, apiErrorResponse } from "@/lib/auth/guards";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  if (!hasDatabase()) {
    return NextResponse.json({ projects: [] });
  }
  try {
    await ensureDb();
    const res = await getPool().query(
      "SELECT id, owner_user_id, name, slug, is_bootstrap, created_at, updated_at FROM projects WHERE owner_user_id = $1 ORDER BY created_at DESC",
      [user.id],
    );
    return NextResponse.json({ projects: res.rows });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function POST(req: Request) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }
  try {
    await ensureDb();
    const body = (await req.json().catch(() => ({}))) as { name?: string; slug?: string };
    const name = (body.name || "").trim();
    if (!name) return NextResponse.json({ error: "Project name is required" }, { status: 400 });
    const slug =
      (body.slug || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const id = randomUUID();
    await getPool().query(
      "INSERT INTO projects (id, owner_user_id, name, slug, is_bootstrap, created_at, updated_at) VALUES ($1,$2,$3,$4,FALSE,NOW(),NOW())",
      [id, user.id, name, slug],
    );
    return NextResponse.json({ project: { id, owner_user_id: user.id, name, slug, is_bootstrap: false } });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
