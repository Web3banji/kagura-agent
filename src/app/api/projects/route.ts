import { NextResponse } from "next/server";
import { requireUserApi, apiErrorResponse } from "@/lib/auth/guards";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";
import { randomUUID } from "crypto";
import {
  getRepositoryConnectionForUser,
} from "@/lib/repositories/connections";

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
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      slug?: string;
      repositoryConnectionId?: string;
    };
    const name = (body.name || "").trim();
    if (!name) return NextResponse.json({ error: "Project name is required" }, { status: 400 });
    const slug =
      (body.slug || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const repositoryConnectionId = (body.repositoryConnectionId || "").trim();
    if (!repositoryConnectionId) {
      return NextResponse.json(
        { error: "Repository selection is required" },
        { status: 400 },
      );
    }

    // Verify repository connection belongs to authenticated user
    const connection = await getRepositoryConnectionForUser(repositoryConnectionId, user.id);
    if (!connection) {
      return NextResponse.json(
        { error: "Repository connection not found or access denied" },
        { status: 404 },
      );
    }

    // Check if repository is already assigned to another project owned by this user
    const existingProjectLinks = await getPool().query(
      `SELECT project_id FROM project_repository_links WHERE repository_connection_id = $1 AND owner_user_id = $2`,
      [repositoryConnectionId, user.id],
    );
    if (existingProjectLinks.rowCount && existingProjectLinks.rowCount > 0) {
      return NextResponse.json(
        { error: "Repository is already assigned to another project" },
        { status: 409 },
      );
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      // Lock the project row (will be created after insert) and repository connection row
      // Verify repository connection belongs to authenticated user
      const connRes = await client.query(
        `SELECT id FROM repository_connections WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [repositoryConnectionId, user.id],
      );
      if (connRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "Repository connection not found or access denied" },
          { status: 404 },
        );
      }

      // Check if repository is already assigned to another project owned by this user
      const existingProjectLinks = await client.query(
        `SELECT 1 FROM project_repository_links WHERE repository_connection_id = $1 AND owner_user_id = $2`,
        [repositoryConnectionId, user.id],
      );
      if (existingProjectLinks.rowCount && existingProjectLinks.rowCount > 0) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "Repository is already assigned to another project" },
          { status: 409 },
        );
      }

      const id = randomUUID();
      // Create project
      await client.query(
        `INSERT INTO projects (id, owner_user_id, name, slug, is_bootstrap, created_at, updated_at) VALUES ($1,$2,$3,$4,FALSE,NOW(),NOW())`,
        [id, user.id, name, slug],
      );

      // Link repository to project as active
      const linkId = randomUUID();
      await client.query(
        `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at) VALUES ($1,$2,$3,$4,'active',NOW())`,
        [linkId, id, repositoryConnectionId, user.id],
      );

      await client.query("COMMIT");

      return NextResponse.json({
        project: { id, owner_user_id: user.id, name, slug, is_bootstrap: false },
        repositoryConnection: connection,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23505") {
      return NextResponse.json({ error: "Project slug already exists" }, { status: 409 });
    }
    if (pgErr?.code === "23503") {
      return NextResponse.json({ error: "Invalid project or repository connection" }, { status: 400 });
    }
    return apiErrorResponse(err);
  }
}
