import { NextResponse } from "next/server";
import { requireUserApi, apiErrorResponse } from "@/lib/auth/guards";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";
import {
  getRepositoryConnectionForUser,
  linkRepositoryToProject,
  listRepositoryLinksForProject,
  listProjectsForRepositoryConnection,
} from "@/lib/repositories/connections";
import type { ProjectRepositoryLink } from "@/types/repository";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };

  if (!hasDatabase()) {
    return NextResponse.json({ repositories: [] });
  }

  try {
    await ensureDb();
    const { projectId } = await params;

    const projectRes = await getPool().query(
      `SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
      [projectId, user.id],
    );
    if (projectRes.rowCount === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const links = await listRepositoryLinksForProject(projectId, user.id);

    const connections = [];
    for (const link of links) {
      const conn = await getRepositoryConnectionForUser(link.repositoryConnectionId, user.id);
      if (conn) {
        connections.push({ ...conn, linkedAt: link.createdAt, link_status: link.link_status });
      }
    }

    return NextResponse.json({ repositories: connections });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };

  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }

  try {
    await ensureDb();
    const { projectId } = await params;

    const projectRes = await getPool().query(
      `SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
      [projectId, user.id],
    );
    if (projectRes.rowCount === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as { repositoryConnectionId?: string };
    const repositoryConnectionId = (body.repositoryConnectionId || "").trim();

    if (!repositoryConnectionId) {
      return NextResponse.json({ error: "repositoryConnectionId is required" }, { status: 400 });
    }

    const connection = await getRepositoryConnectionForUser(repositoryConnectionId, user.id);
    if (!connection) {
      return NextResponse.json({ error: "Repository connection not found" }, { status: 404 });
    }

    const existingLinks = await listRepositoryLinksForProject(projectId, user.id);
    const activeLink = existingLinks.find(l => l.link_status === 'active');
    if (activeLink) {
      return NextResponse.json(
        { error: "Project already has an active repository linked" },
        { status: 409 },
      );
    }

    // Check if this repository is already linked to this project as legacy
    const existingLegacyLink = existingLinks.find(l => l.repositoryConnectionId === repositoryConnectionId);
    if (existingLegacyLink) {
      return NextResponse.json(
        { error: "Repository is already linked to this project as legacy. Use promotion endpoint." },
        { status: 409 },
      );
    }

    // Check if repository is already assigned to another project (legacy or active)
    const existingRepoLinks = await listProjectsForRepositoryConnection(repositoryConnectionId, user.id);
    const otherProjectLinks = existingRepoLinks.filter(l => l.projectId !== projectId);
    if (otherProjectLinks.length > 0) {
      return NextResponse.json(
        { error: "Repository is already assigned to another project" },
        { status: 409 },
      );
    }

    const link = await linkRepositoryToProject(projectId, repositoryConnectionId, user.id);

    return NextResponse.json({ link, connection });
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23505") {
      return NextResponse.json({ error: "Repository is already linked to this project" }, { status: 409 });
    }
    if (pgErr?.code === "23503") {
      return NextResponse.json({ error: "Invalid project or repository connection" }, { status: 400 });
    }
    return apiErrorResponse(err);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };

  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }

  await ensureDb();
  const { projectId } = await params;

  const body = (await req.json().catch(() => ({}))) as { repositoryConnectionId?: string };
  const repositoryConnectionId = (body.repositoryConnectionId || "").trim();

  if (!repositoryConnectionId) {
    return NextResponse.json({ error: "repositoryConnectionId is required" }, { status: 400 });
  }

  const connection = await getRepositoryConnectionForUser(repositoryConnectionId, user.id);
  if (!connection) {
    return NextResponse.json({ error: "Repository connection not found" }, { status: 404 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Lock the project row first
    await client.query(
      `SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [projectId, user.id],
    );

    // Verify the project exists and is owned by the user
    const projectRes = await client.query(
      `SELECT id FROM projects WHERE id = $1 AND owner_user_id = $2`,
      [projectId, user.id],
    );
    if (projectRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Lock the repository connection row
    await client.query(
      `SELECT 1 FROM repository_connections WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [repositoryConnectionId, user.id],
    );

    // Verify the repository connection exists and is owned by the user
    const connRes = await client.query(
      `SELECT id FROM repository_connections WHERE id = $1 AND owner_user_id = $2`,
      [repositoryConnectionId, user.id],
    );
    if (connRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Repository connection not found" }, { status: 404 });
    }

    // Check if the project already has an active link
    const activeProjectLink = await client.query(
      `SELECT 1 FROM project_repository_links WHERE project_id = $1 AND owner_user_id = $2 AND link_status = 'active'`,
      [projectId, user.id],
    );
    if (activeProjectLink.rowCount && activeProjectLink.rowCount > 0) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "Project already has an active repository linked" },
        { status: 409 },
      );
    }

    // Find the legacy link to promote (lock it for update)
    const legacyLink = await client.query(
      `SELECT id FROM project_repository_links WHERE project_id = $1 AND repository_connection_id = $2 AND owner_user_id = $3 AND link_status = 'legacy' FOR UPDATE`,
      [projectId, repositoryConnectionId, user.id],
    );
    if (legacyLink.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "No legacy link found to promote" }, { status: 404 });
    }

// Check if this repository connection has ANY relationship with another project (legacy or active)
      const otherProjectLink = await client.query(
        `SELECT 1 FROM project_repository_links WHERE repository_connection_id = $1 AND owner_user_id = $2 AND project_id != $3`,
        [repositoryConnectionId, user.id, projectId],
      );
      if (otherProjectLink.rowCount && otherProjectLink.rowCount > 0) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "Repository is already associated with another project" },
          { status: 409 },
        );
      }

    // Promote the legacy link to active
    await client.query(
      `UPDATE project_repository_links SET link_status = 'active' WHERE id = $1`,
      [legacyLink.rows[0].id],
    );

    await client.query("COMMIT");

    const updatedLink = await client.query(
      `SELECT * FROM project_repository_links WHERE id = $1`,
      [legacyLink.rows[0].id],
    );

    const link = updatedLink.rows[0];
    return NextResponse.json({ link: mapLink(link as Record<string, unknown>) });
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

// No DELETE handler here: canonical unlink is DELETE /api/projects/[projectId]/repositories/[connectionId].

// Add mapLink function here since it's not imported
function mapLink(row: Record<string, unknown>): ProjectRepositoryLink {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    repositoryConnectionId: String(row.repository_connection_id),
    ownerUserId: String(row.owner_user_id),
    link_status: String(row.link_status) as "active" | "legacy",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(String(row.created_at)).toISOString(),
  };
}