export type RepositoryConnectionStatus = "active" | "revoked" | "error";

export interface RepositoryConnection {
  id: string;
  ownerUserId: string;
  provider: string;
  providerAccountId: string | null;
  githubRepoId: string;
  repoOwner: string;
  repoName: string;
  fullName: string;
  defaultBranch: string | null;
  isPrivate: boolean | null;
  permissions: Record<string, unknown> | null;
  status: RepositoryConnectionStatus | string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRepositoryLink {
  id: string;
  projectId: string;
  repositoryConnectionId: string;
  ownerUserId: string;
  link_status: "active" | "legacy";
  createdAt: string;
}

export interface RepositoryConnectionInput {
  provider?: string;
  providerAccountId?: string | null;
  githubRepoId: string;
  repoOwner: string;
  repoName: string;
  fullName: string;
  defaultBranch?: string | null;
  isPrivate?: boolean | null;
  permissions?: Record<string, unknown> | null;
  status?: RepositoryConnectionStatus | string;
}
