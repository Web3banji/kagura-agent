import { NextResponse } from "next/server";
import { requireUserApi, apiErrorResponse } from "@/lib/auth/guards";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ projectId: string; connectionId: string }> },
) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };

  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }

  await ensureDb();
  const { projectId, connectionId } = await params;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [projectId, user.id],
    );

    const projectRes = await client.query(
      `SELECT id FROM projects WHERE id = $1 AND owner_user_id = $2`,
      [projectId, user.id],
    );
    if (projectRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    await client.query(
      `SELECT 1 FROM repository_connections WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [connectionId, user.id],
    );

    const connRes = await client.query(
      `SELECT id FROM repository_connections WHERE id = $1 AND owner_user_id = $2`,
      [connectionId, user.id],
    );
    if (connRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Repository connection not found" }, { status: 404 });
    }

    const linkToDelete = await client.query(
      `SELECT id, link_status FROM project_repository_links WHERE project_id = $1 AND repository_connection_id = $2 AND owner_user_id = $3 FOR UPDATE`,
      [projectId, connectionId, user.id],
    );
    if (linkToDelete.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Repository link not found" }, { status: 404 });
    }

    await client.query(
      `DELETE FROM project_repository_links WHERE id = $1`,
      [linkToDelete.rows[0].id],
    );

    await client.query("COMMIT");

    return NextResponse.json({ success: true, unlinked: true });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23505") {
      return NextResponse.json({ error: "Repository is already linked to this project" }, { status: 409 });
    }
    if (pgErr?.code === "23503") {
      return NextResponse.json({ error: "Invalid project or repository connection" }, { status: 400 });
    }
    return apiErrorResponse(err);
  } finally {
    client.release();
  }
}