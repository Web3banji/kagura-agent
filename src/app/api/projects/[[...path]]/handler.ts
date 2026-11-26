import { NextResponse } from "next/server";
import { requireUserApi, apiErrorResponse } from "@/lib/auth/guards";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";
import { randomUUID } from "crypto";
import { getRepositoryConnectionForUser, linkRepositoryToProject, listRepositoryLinksForProject, listProjectsForRepositoryConnection } from "@/lib/repositories/connections";
import type { ProjectRepositoryLink } from "@/types/repository";
import { observeProjectRepositories } from "@/lib/github/observe-project";
import { validateUrl } from "@/lib/kane/security";

export const dynamic = "force-dynamic";

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

async function handleBaseGet(req: Request) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  if (!hasDatabase()) {
    return NextResponse.json({ projects: [] });
  }
  try {
    await ensureDb();
    const res = await getPool().query(
      `SELECT p.id, p.owner_user_id, p.name, p.slug, p.target_url, p.is_bootstrap, p.created_at, p.updated_at,
              rc.id AS repository_connection_id,
              rc.full_name AS repository_full_name,
              rc.repo_owner,
              rc.repo_name,
              rc.is_private AS repository_is_private,
              rc.default_branch AS repository_default_branch,
              rc.status AS repository_status,
              prl.link_status,
              prl.created_at AS repository_linked_at
       FROM projects p
       LEFT JOIN project_repository_links prl
         ON prl.project_id = p.id AND prl.owner_user_id = p.owner_user_id AND prl.link_status = 'active'
       LEFT JOIN repository_connections rc
         ON rc.id = prl.repository_connection_id AND rc.owner_user_id = p.owner_user_id
       WHERE p.owner_user_id = $1
       ORDER BY p.created_at DESC`,
      [user.id],
    );
    const projects = res.rows.map((row) => {
      const hasRepo = !!row.repository_full_name;
      return {
        id: row.id,
        owner_user_id: row.owner_user_id,
        name: row.name,
        slug: row.slug,
        targetUrl: row.target_url ?? null,
        is_bootstrap: row.is_bootstrap,
        created_at: row.created_at,
        updated_at: row.updated_at,
        repository: hasRepo
          ? {
              connectionId: row.repository_connection_id,
              fullName: row.repository_full_name,
              owner: row.repo_owner,
              name: row.repo_name,
              isPrivate: row.repository_is_private,
              defaultBranch: row.repository_default_branch,
              status: row.repository_status,
              linkStatus: row.link_status,
              linkedAt: row.repository_linked_at,
            }
          : null,
      };
    });
    return NextResponse.json({ projects });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

async function handleBasePost(req: Request) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }
  try {
    await ensureDb();
    const body = (await req.json().catch(() => ({}))) as { name?: string; slug?: string; repositoryConnectionId?: string; targetUrl?: string };
    const name = (body.name || "").trim();
    if (!name) return NextResponse.json({ error: "Project name is required" }, { status: 400 });
    let targetUrl: string | null = null;
    if (typeof body.targetUrl === "string" && body.targetUrl.trim()) {
      const validated = validateUrl(body.targetUrl);
      if (!validated.ok) return NextResponse.json({ error: validated.reason }, { status: 400 });
      targetUrl = validated.url;
    }
    const slug = (body.slug || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const repositoryConnectionId = (body.repositoryConnectionId || "").trim();
    if (!repositoryConnectionId) {
      return NextResponse.json({ error: "Repository selection is required" }, { status: 400 });
    }
    const connection = await getRepositoryConnectionForUser(repositoryConnectionId, user.id);
    if (!connection) {
      return NextResponse.json({ error: "Repository connection not found or access denied" }, { status: 404 });
    }
    const existingProjectLinks = await getPool().query(`SELECT project_id FROM project_repository_links WHERE repository_connection_id = $1 AND owner_user_id = $2`, [repositoryConnectionId, user.id]);
    if (existingProjectLinks.rowCount && existingProjectLinks.rowCount > 0) {
      return NextResponse.json({ error: "Repository is already assigned to another project" }, { status: 409 });
    }
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const connRes = await client.query(`SELECT id FROM repository_connections WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [repositoryConnectionId, user.id]);
      if (connRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Repository connection not found or access denied" }, { status: 404 });
      }
      const existingProjectLinks2 = await client.query(`SELECT 1 FROM project_repository_links WHERE repository_connection_id = $1 AND owner_user_id = $2`, [repositoryConnectionId, user.id]);
      if (existingProjectLinks2.rowCount && existingProjectLinks2.rowCount > 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Repository is already assigned to another project" }, { status: 409 });
      }
      const id = randomUUID();
      await client.query(`INSERT INTO projects (id, owner_user_id, name, slug, target_url, is_bootstrap, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,FALSE,NOW(),NOW())`, [id, user.id, name, slug, targetUrl]);
      const linkId = randomUUID();
      await client.query(`INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at) VALUES ($1,$2,$3,$4,'active',NOW())`, [linkId, id, repositoryConnectionId, user.id]);
      await client.query("COMMIT");
      return NextResponse.json({ project: { id, owner_user_id: user.id, name, slug, targetUrl, is_bootstrap: false }, repositoryConnection: connection });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch {}
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

async function handleProjectObservePost(req: Request, projectId: string) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }
  try {
    await ensureDb();
    const projectRes = await getPool().query(`SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1`, [projectId, user.id]);
    if (projectRes.rowCount === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const result = await observeProjectRepositories(projectId, user.id);
    const statusCode = result.failedRepositories === result.totalRepositories && result.totalRepositories > 0 ? 502 : 200;
    return NextResponse.json({
      projectId: result.projectId,
      status: result.failedRepositories === 0 ? "success" : result.failedRepositories === result.totalRepositories ? "failed" : "partial",
      totalRepositories: result.totalRepositories,
      successfulRepositories: result.successfulRepositories,
      failedRepositories: result.failedRepositories,
      totalNewCommits: result.totalNewCommits,
      observedAt: result.observedAt,
      repositories: result.repositories.map((repo) => ({
        repositoryConnectionId: repo.repositoryConnectionId,
        githubRepoId: repo.githubRepoId,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        status: repo.status,
        newCommitsCount: repo.newCommits.length,
        commitsCount: repo.commits.length,
        error: repo.error,
        rateLimit: repo.rateLimit,
      })),
    }, { status: statusCode });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

async function handleProjectRepositoriesGet(req: Request, projectId: string) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  if (!hasDatabase()) {
    return NextResponse.json({ repositories: [] });
  }
  try {
    await ensureDb();
    const projectRes = await getPool().query(`SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1`, [projectId, user.id]);
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

async function handleProjectRepositoriesPost(req: Request, projectId: string) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }
  try {
    await ensureDb();
    const projectRes = await getPool().query(`SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1`, [projectId, user.id]);
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
      return NextResponse.json({ error: "Project already has an active repository linked" }, { status: 409 });
    }
    const existingLegacyLink = existingLinks.find(l => l.repositoryConnectionId === repositoryConnectionId);
    if (existingLegacyLink) {
      return NextResponse.json({ error: "Repository is already linked to this project as legacy. Use promotion endpoint." }, { status: 409 });
    }
    const existingRepoLinks = await listProjectsForRepositoryConnection(repositoryConnectionId, user.id);
    const otherProjectLinks = existingRepoLinks.filter(l => l.projectId !== projectId);
    if (otherProjectLinks.length > 0) {
      return NextResponse.json({ error: "Repository is already assigned to another project" }, { status: 409 });
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

async function handleProjectRepositoriesPatch(req: Request, projectId: string) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }
  await ensureDb();
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
    await client.query(`SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [projectId, user.id]);
    const projectRes = await client.query(`SELECT id FROM projects WHERE id = $1 AND owner_user_id = $2`, [projectId, user.id]);
    if (projectRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    await client.query(`SELECT 1 FROM repository_connections WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [repositoryConnectionId, user.id]);
    const connRes = await client.query(`SELECT id FROM repository_connections WHERE id = $1 AND owner_user_id = $2`, [repositoryConnectionId, user.id]);
    if (connRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Repository connection not found" }, { status: 404 });
    }
    const activeProjectLink = await client.query(`SELECT 1 FROM project_repository_links WHERE project_id = $1 AND owner_user_id = $2 AND link_status = 'active'`, [projectId, user.id]);
    if (activeProjectLink.rowCount && activeProjectLink.rowCount > 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Project already has an active repository linked" }, { status: 409 });
    }
    const legacyLink = await client.query(`SELECT id FROM project_repository_links WHERE project_id = $1 AND repository_connection_id = $2 AND owner_user_id = $3 AND link_status = 'legacy' FOR UPDATE`, [projectId, repositoryConnectionId, user.id]);
    if (legacyLink.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "No legacy link found to promote" }, { status: 404 });
    }
    const otherProjectLink = await client.query(`SELECT 1 FROM project_repository_links WHERE repository_connection_id = $1 AND owner_user_id = $2 AND project_id != $3`, [repositoryConnectionId, user.id, projectId]);
    if (otherProjectLink.rowCount && otherProjectLink.rowCount > 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Repository is already associated with another project" }, { status: 409 });
    }
    await client.query(`UPDATE project_repository_links SET link_status = 'active' WHERE id = $1`, [legacyLink.rows[0].id]);
    await client.query("COMMIT");
    const updatedLink = await client.query(`SELECT * FROM project_repository_links WHERE id = $1`, [legacyLink.rows[0].id]);
    const link = updatedLink.rows[0];
    return NextResponse.json({ link: mapLink(link as Record<string, unknown>) });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
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

function notFound() { return NextResponse.json({ error: "Not found" }, { status: 404 }); }

export async function GET(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "") return handleBaseGet(req);
  const m = path.match(/^([^/]+)\/repositories$/);
  if (m) return handleProjectRepositoriesGet(req, decodeURIComponent(m[1]));
  return notFound();
}

export async function POST(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "") return handleBasePost(req);
  const m1 = path.match(/^([^/]+)\/github\/observe$/);
  if (m1) return handleProjectObservePost(req, decodeURIComponent(m1[1]));
  const m2 = path.match(/^([^/]+)\/repositories$/);
  if (m2) return handleProjectRepositoriesPost(req, decodeURIComponent(m2[1]));
  return notFound();
}

async function handleBasePatch(req: Request) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }
  await ensureDb();
  const body = (await req.json().catch(() => ({}))) as { id?: string; targetUrl?: string | null };
  const projectId = typeof body.id === "string" ? body.id : "";
  if (!projectId) return NextResponse.json({ error: "Project id is required" }, { status: 400 });
  let targetUrl: string | null = null;
  if (typeof body.targetUrl === "string" && body.targetUrl.trim()) {
    const validated = validateUrl(body.targetUrl);
    if (!validated.ok) return NextResponse.json({ error: validated.reason }, { status: 400 });
    targetUrl = validated.url;
  }
  const res = await getPool().query(
    `UPDATE projects SET target_url = $1, updated_at = NOW() WHERE id = $2 AND owner_user_id = $3 RETURNING id, name, slug, target_url`,
    [targetUrl, projectId, user.id],
  );
  if (res.rowCount === 0) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const row = res.rows[0];
  return NextResponse.json({ project: { id: row.id, name: row.name, slug: row.slug, targetUrl: row.target_url } });
}

export async function PATCH(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "") return handleBasePatch(req);
  const m = path.match(/^([^/]+)\/repositories$/);
  if (m) return handleProjectRepositoriesPatch(req, decodeURIComponent(m[1]));
  return notFound();
}
async function handleProjectConnectionDelete(req: Request, projectId: string, connectionId: string) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }
  await ensureDb();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [projectId, user.id]);
    const projectRes = await client.query(`SELECT id FROM projects WHERE id = $1 AND owner_user_id = $2`, [projectId, user.id]);
    if (projectRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    await client.query(`SELECT 1 FROM repository_connections WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [connectionId, user.id]);
    const connRes = await client.query(`SELECT id FROM repository_connections WHERE id = $1 AND owner_user_id = $2`, [connectionId, user.id]);
    if (connRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Repository connection not found" }, { status: 404 });
    }
    const linkToDelete = await client.query(`SELECT id, link_status FROM project_repository_links WHERE project_id = $1 AND repository_connection_id = $2 AND owner_user_id = $3 FOR UPDATE`, [projectId, connectionId, user.id]);
    if (linkToDelete.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Repository link not found" }, { status: 404 });
    }
    await client.query(`DELETE FROM project_repository_links WHERE id = $1`, [linkToDelete.rows[0].id]);
    await client.query("COMMIT");
    return NextResponse.json({ success: true, unlinked: true });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
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
export async function DELETE(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  const m = path.match(/^([^/]+)\/repositories\/([^/]+)$/);
  if (m) return handleProjectConnectionDelete(req, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  return notFound();
}