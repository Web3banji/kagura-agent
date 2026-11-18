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