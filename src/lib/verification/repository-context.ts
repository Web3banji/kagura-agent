import { getRepositoryConnectionForUser, resolveActiveRepositoryConnectionId } from "@/lib/repositories/connections";
import { ensureDb, getPool, hasDatabase } from "@/lib/db";
import { validateUrl } from "@/lib/kane/security";
import type { RepositoryConnection } from "@/types/repository";

export type RepositoryJobContext = {
  repositoryConnectionId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryFullName: string;
  repositoryDefaultBranch: string | null;
  targetUrl: string;
};

export class RepositoryContextError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "RepositoryContextError";
    this.status = status;
  }
}

export function buildRepositoryJobContext(connection: RepositoryConnection, ownerUserId: string, targetUrl: string): RepositoryJobContext {
  if (connection.ownerUserId !== ownerUserId) {
    throw new RepositoryContextError("Repository connection does not belong to the authenticated user", 403);
  }
  if (connection.status === "revoked" || connection.status === "error") {
    throw new RepositoryContextError("Repository connection is not active");
  }
  if (!connection.repoOwner.trim() || !connection.repoName.trim() || !connection.fullName.trim()) {
    throw new RepositoryContextError("Repository connection has incomplete repository identity");
  }
  return {
    repositoryConnectionId: connection.id,
    repositoryOwner: connection.repoOwner,
    repositoryName: connection.repoName,
    repositoryFullName: connection.fullName,
    repositoryDefaultBranch: connection.defaultBranch ?? null,
    targetUrl,
  };
}

export async function resolveJobRepositoryContext(projectId: string, ownerUserId: string): Promise<RepositoryJobContext> {
  if (!hasDatabase()) {
    throw new RepositoryContextError("Database is not configured", 503);
  }
  await ensureDb();
  const projectRes = await getPool().query<{ target_url: string | null }>(
    `SELECT target_url FROM projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
    [projectId, ownerUserId],
  );
  if (projectRes.rowCount === 0) {
    throw new RepositoryContextError("Project not found for authenticated user", 404);
  }
  const targetValidation = validateUrl(projectRes.rows[0].target_url);
  if (!targetValidation.ok) {
    throw new RepositoryContextError("Project has no valid application target URL");
  }
  const connectionId = await resolveActiveRepositoryConnectionId(projectId, ownerUserId);
  if (!connectionId) {
    throw new RepositoryContextError("Project has no active GitHub repository connection");
  }
  const connection = await getRepositoryConnectionForUser(connectionId, ownerUserId);
  if (!connection) {
    throw new RepositoryContextError("Repository connection not found for authenticated user", 403);
  }
  return buildRepositoryJobContext(connection, ownerUserId, targetValidation.url);
}

export function authorizeRepositoryConnectionForToken(
  job: { requestedBy?: string; repositoryConnectionId?: string; repositoryOwner?: string; repositoryName?: string; repositoryFullName?: string },
  connection: RepositoryConnection,
): void {
  const owner = typeof job.requestedBy === "string" ? job.requestedBy.trim() : "";
  if (!owner) throw new RepositoryContextError("Job owner is missing", 409);
  if (!job.repositoryConnectionId) throw new RepositoryContextError("Job has no persisted repository connection", 409);
  if (connection.ownerUserId !== owner) throw new RepositoryContextError("Repository connection does not belong to the job owner", 403);
  if (connection.status !== "active") throw new RepositoryContextError("Repository connection is not active", 409);
  if (!job.repositoryFullName || connection.fullName !== job.repositoryFullName) {
    throw new RepositoryContextError("Repository connection identity does not match the job", 409);
  }
  if (job.repositoryOwner && connection.repoOwner !== job.repositoryOwner) {
    throw new RepositoryContextError("Repository connection owner does not match the job", 409);
  }
  if (job.repositoryName && connection.repoName !== job.repositoryName) {
    throw new RepositoryContextError("Repository connection name does not match the job", 409);
  }
}

export function authorizeRepositoryToken(
  job: { status?: string; claimedBy?: string; claimGeneration?: number; leaseExpiresAt?: string; repositoryFullName?: string; repositoryOwner?: string; repositoryName?: string; repositoryDefaultBranch?: string | null },
  runnerId: string,
  claimGeneration: number,
): void {
  if (!job.repositoryFullName || !job.repositoryOwner || !job.repositoryName || !job.repositoryDefaultBranch) {
    throw new RepositoryContextError("Job has no trusted repository metadata");
  }
  if (job.status !== "claimed" && job.status !== "running") {
    throw new RepositoryContextError("Job is not in a claimable execution state");
  }
  if (job.claimedBy !== runnerId) {
    throw new RepositoryContextError("Job is not claimed by this runner", 403);
  }
  if ((job.claimGeneration ?? 0) !== claimGeneration) {
    throw new RepositoryContextError("Claim generation does not match");
  }
  if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() < Date.now()) {
    throw new RepositoryContextError("Job claim lease has expired");
  }
}