export interface GitHubConfig {
  owner: string;
  repo: string;
  configuredIn: "file" | "env" | "default";
  updatedAt?: string;
}

export interface ObservedCommitFile {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

export interface ObservedCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  authorEmail?: string;
  date: string;
  url: string;
  files: ObservedCommitFile[];
  processed?: boolean;
}

export interface ObservationState {
  lastObservedAt?: string;
  lastSuccessfulSha?: string;
  lastStatus?: "success" | "failed";
  lastError?: string;
  lastNewCount?: number;
}

export interface ProjectObservationState {
  projectId: string;
  repositoryConnectionId: string;
  githubRepoId: string;
  fullName: string;
  lastObservedAt?: string;
  lastSuccessfulSha?: string;
  lastStatus?: "success" | "failed" | "partial";
  lastError?: string;
  lastNewCount?: number;
}

export interface ProjectObservedCommit extends ObservedCommit {
  projectId: string;
  repositoryConnectionId: string;
}

export interface GitHubObservationResult {
  repo: string;
  source: "github-api" | "git-local" | "none";
  commits: ObservedCommit[];
  newCommits: ObservedCommit[];
  state: ObservationState;
  observedAt: string;
  note?: string;
  error?: string;
}

export interface ProjectRepositoryObservationResult {
  projectId: string;
  repositoryConnectionId: string;
  githubRepoId: string;
  fullName: string;
  defaultBranch: string | null;
  status: "success" | "partial" | "failed";
  commits: ObservedCommit[];
  newCommits: ObservedCommit[];
  lastObservedAt: string;
  error?: string;
  rateLimit?: {
    limit: number | null;
    remaining: number | null;
    resetAt: string | null;
    retryAfterSeconds: number | null;
  };
}

export interface ProjectObservationResult {
  projectId: string;
  totalRepositories: number;
  successfulRepositories: number;
  failedRepositories: number;
  totalCommits: number;
  totalNewCommits: number;
  repositories: ProjectRepositoryObservationResult[];
  observedAt: string;
}