import { randomUUID } from "crypto";
import { ensureDb, getPool, hasDatabase } from "@/lib/db";
import type {
  ProjectRepositoryLink,
  RepositoryConnection,
  RepositoryConnectionInput,
} from "@/types/repository";

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}

function mapConnection(row: Record<string, unknown>): RepositoryConnection {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    provider: String(row.provider),
    providerAccountId: row.provider_account_id == null ? null : String(row.provider_account_id),
    githubRepoId: String(row.github_repo_id),
    repoOwner: String(row.repo_owner),
    repoName: String(row.repo_name),
    fullName: String(row.full_name),
    defaultBranch: row.default_branch == null ? null : String(row.default_branch),
    isPrivate: row.is_private == null ? null : Boolean(row.is_private),
    permissions: (row.permissions as Record<string, unknown> | null) ?? null,
    status: String(row.status),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapLink(row: Record<string, unknown>): ProjectRepositoryLink {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    repositoryConnectionId: String(row.repository_connection_id),
    ownerUserId: String(row.owner_user_id),
    link_status: String(row.link_status) as "active" | "legacy",
    createdAt: toIso(row.created_at),
  };
}

export async function createRepositoryConnection(
  ownerUserId: string,
  input: RepositoryConnectionInput,
): Promise<RepositoryConnection> {
  if (!hasDatabase()) throw new Error("Database not configured");
  await ensureDb();
  const id = randomUUID();
  const provider = input.provider ?? "github";
  const res = await getPool().query(
    `INSERT INTO repository_connections (
       id, owner_user_id, provider, provider_account_id, github_repo_id,
       repo_owner, repo_name, full_name, default_branch, is_private, permissions, status,
       created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,NOW(),NOW())
     RETURNING *`,
    [
      id,
      ownerUserId,
      provider,
      input.providerAccountId ?? null,
      input.githubRepoId,
      input.repoOwner,
      input.repoName,
      input.fullName,
      input.defaultBranch ?? null,
      input.isPrivate ?? null,
      input.permissions == null ? null : JSON.stringify(input.permissions),
      input.status ?? "active",
    ],
  );
  return mapConnection(res.rows[0] as Record<string, unknown>);
}

export async function getRepositoryConnectionForUser(
  id: string,
  ownerUserId: string,
): Promise<RepositoryConnection | undefined> {
  if (!hasDatabase()) return undefined;
  await ensureDb();
  const res = await getPool().query(
    `SELECT * FROM repository_connections WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
    [id, ownerUserId],
  );
  if (!res.rows[0]) return undefined;
  return mapConnection(res.rows[0] as Record<string, unknown>);
}

export async function listRepositoryConnectionsForUser(
  ownerUserId: string,
): Promise<RepositoryConnection[]> {
  if (!hasDatabase()) return [];
  await ensureDb();
  const res = await getPool().query(
    `SELECT * FROM repository_connections WHERE owner_user_id = $1 ORDER BY created_at DESC`,
    [ownerUserId],
  );
  return res.rows.map((r) => mapConnection(r as Record<string, unknown>));
}

export async function findRepositoryConnectionByRepo(
  ownerUserId: string,
  provider: string,
  githubRepoId: string,
): Promise<RepositoryConnection | undefined> {
  if (!hasDatabase()) return undefined;
  await ensureDb();
  const res = await getPool().query(
    `SELECT * FROM repository_connections
     WHERE owner_user_id = $1 AND provider = $2 AND github_repo_id = $3
     LIMIT 1`,
    [ownerUserId, provider, githubRepoId],
  );
  if (!res.rows[0]) return undefined;
  return mapConnection(res.rows[0] as Record<string, unknown>);
}

export async function deleteRepositoryConnection(
  id: string,
  ownerUserId: string,
): Promise<boolean> {
  if (!hasDatabase()) return false;
  await ensureDb();
  const res = await getPool().query(
    `DELETE FROM repository_connections WHERE id = $1 AND owner_user_id = $2`,
    [id, ownerUserId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Link a repository connection to a project owned by the same user.
 * Ownership consistency is enforced at the database level via composite foreign keys:
 * the link's (project_id, owner_user_id) must reference the owner's project and
 * (repository_connection_id, owner_user_id) must reference the owner's connection.
 * A cross-user link is rejected by the database even if application code is incorrect.
 *
 * Single-repository enforcement (Stage 3.3):
 * - A project cannot have more than one active repository link.
 * - A repository connection cannot receive a new assignment if it already has any
 *   relationship (active or legacy) to another project for the same owner.
 * - Legacy relationships are preserved and never overwritten.
 * - All checks and the insert happen inside a transaction with row-level locking
 *   to prevent race conditions.
 */
export async function linkRepositoryToProject(
  projectId: string,
  repositoryConnectionId: string,
  ownerUserId: string,
): Promise<ProjectRepositoryLink> {
  if (!hasDatabase()) throw new Error("Database not configured");
  await ensureDb();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Lock the project row to serialize concurrent link operations for this project
    await client.query(
      `SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [projectId, ownerUserId],
    );

    // Verify the project exists and is owned by the user
    const projectRes = await client.query(
      `SELECT id FROM projects WHERE id = $1 AND owner_user_id = $2`,
      [projectId, ownerUserId],
    );
    if (projectRes.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new Error("Project not found or access denied");
    }

    // Lock the repository connection row to serialize concurrent assignments
    await client.query(
      `SELECT 1 FROM repository_connections WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [repositoryConnectionId, ownerUserId],
    );

    // Verify the repository connection exists and is owned by the user
    const connRes = await client.query(
      `SELECT id FROM repository_connections WHERE id = $1 AND owner_user_id = $2`,
      [repositoryConnectionId, ownerUserId],
    );
    if (connRes.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new Error("Repository connection not found or access denied");
    }

    // Check if this project already has an active repository link
    const activeProjectLink = await client.query(
      `SELECT 1 FROM project_repository_links WHERE project_id = $1 AND owner_user_id = $2 AND link_status = 'active'`,
      [projectId, ownerUserId],
    );
    if (activeProjectLink.rowCount && activeProjectLink.rowCount > 0) {
      await client.query("ROLLBACK");
      throw new Error("Project already has an active repository linked");
    }

    // Check if this repository connection already has an ACTIVE relationship
    const existingActiveRepoLinks = await client.query(
      `SELECT 1 FROM project_repository_links WHERE repository_connection_id = $1 AND owner_user_id = $2 AND link_status = 'active'`,
      [repositoryConnectionId, ownerUserId],
    );
    if (existingActiveRepoLinks.rowCount && existingActiveRepoLinks.rowCount > 0) {
      await client.query("ROLLBACK");
      throw new Error("Repository is already assigned to another project");
    }

    const id = randomUUID();
    const res = await client.query(
      `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at)
       VALUES ($1,$2,$3,$4,'active',NOW())
       RETURNING *`,
      [id, projectId, repositoryConnectionId, ownerUserId],
    );
    await client.query("COMMIT");
    return mapLink(res.rows[0] as Record<string, unknown>);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

export async function unlinkRepositoryFromProject(
  projectId: string,
  repositoryConnectionId: string,
  ownerUserId: string,
): Promise<boolean> {
  if (!hasDatabase()) return false;
  await ensureDb();
  const res = await getPool().query(
    `DELETE FROM project_repository_links
     WHERE project_id = $1 AND repository_connection_id = $2 AND owner_user_id = $3`,
    [projectId, repositoryConnectionId, ownerUserId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listRepositoryLinksForProject(
  projectId: string,
  ownerUserId: string,
): Promise<ProjectRepositoryLink[]> {
  if (!hasDatabase()) return [];
  await ensureDb();
  const res = await getPool().query(
    `SELECT * FROM project_repository_links
     WHERE project_id = $1 AND owner_user_id = $2
     ORDER BY created_at DESC`,
    [projectId, ownerUserId],
  );
  return res.rows.map((r) => mapLink(r as Record<string, unknown>));
}

/**
 * Resolve the single active repository connection for a project, ownership-scoped.
 * Returns null when there is no project/DB context or no active link.
 * Fails closed (throws) on ambiguous active-link state to avoid cross-project attribution.
 */
export async function resolveActiveRepositoryConnectionId(
  projectId: string | null | undefined,
  ownerUserId: string | null | undefined,
): Promise<string | null> {
  const pid = typeof projectId === "string" ? projectId.trim() : "";
  const uid = typeof ownerUserId === "string" ? ownerUserId.trim() : "";
  if (!pid || !uid) return null;
  if (!hasDatabase()) return null;
  await ensureDb();
  const res = await getPool().query(
    `SELECT repository_connection_id, link_status
     FROM project_repository_links
     WHERE project_id = $1 AND owner_user_id = $2 AND link_status = 'active'
     ORDER BY created_at DESC
     LIMIT 2`,
    [pid, uid],
  );
  if (res.rowCount === 0) return null;
  if ((res.rowCount ?? 0) > 1) {
    throw new Error("Ambiguous active repository link state for project");
  }
  const id = res.rows[0]?.repository_connection_id;
  return typeof id === "string" && id.trim() ? id : null;
}

export async function listProjectsForRepositoryConnection(
  repositoryConnectionId: string,
  ownerUserId: string,
): Promise<ProjectRepositoryLink[]> {
  if (!hasDatabase()) return [];
  await ensureDb();
  const res = await getPool().query(
    `SELECT * FROM project_repository_links
     WHERE repository_connection_id = $1 AND owner_user_id = $2
     ORDER BY created_at DESC`,
    [repositoryConnectionId, ownerUserId],
  );
  return res.rows.map((r) => mapLink(r as Record<string, unknown>));
}
