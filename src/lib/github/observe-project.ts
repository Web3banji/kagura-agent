import { listRepositoryLinksForProject, getRepositoryConnectionForUser } from "@/lib/repositories/connections";
import { getUserGitHubAccessToken } from "@/lib/auth/users";
import { fetchAuthenticatedGitHubUser } from "@/lib/github/discover";
import {
  readProjectObservationState,
  writeProjectObservationState,
  mergeProjectObservedCommits,
  readProjectObservedEvents,
} from "./store";
import type {
  RepositoryConnection,
  ProjectRepositoryLink,
} from "@/types/repository";
import type {
  ProjectObservationResult,
  ProjectRepositoryObservationResult,
  ProjectObservedCommit,
} from "@/types/github";
import type { RateLimitInfo } from "./discover";

interface ObservationDiag {
  projectId: string;
  repositoryConnectionId: string;
  credentialSource: "user-oauth" | "none";
  actorLogin?: string;
  apiStatus?: number;
  error?: string;
}

function diag(entry: ObservationDiag) {
  const masked = entry.actorLogin
    ? entry.actorLogin.replace(/^.(.*).$/, (s) => s[0] + "*".repeat(Math.max(0, s.length - 2)) + s.slice(-1))
    : undefined;
  console.log(
    `[github-observe-project] project=${entry.projectId} conn=${entry.repositoryConnectionId} source=${entry.credentialSource}` +
      (masked ? ` actor=${masked}` : "") +
      (entry.apiStatus !== undefined ? ` status=${entry.apiStatus}` : "") +
      (entry.error ? ` error=${entry.error}` : ""),
  );
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "kagura-agent",
  };
}

type GitHubFailureKind = "http" | "network";

function safeGitHubFailureMessage(status: number | null, kind: GitHubFailureKind): string {
  if (kind === "network" || status == null) {
    return "Network error while contacting GitHub API.";
  }
  if (status === 401) {
    return "GitHub API request unauthorized (401).";
  }
  if (status === 403) {
    return "GitHub API request forbidden or access denied (403).";
  }
  return `GitHub API request failed (${status}).`;
}

class GitHubApiError extends Error {
  status: number | null;
  kind: GitHubFailureKind;

  constructor(status: number | null, kind: GitHubFailureKind) {
    super(safeGitHubFailureMessage(status, kind));
    this.name = "GitHubApiError";
    this.status = status;
    this.kind = kind;
  }
}

async function fetchCommitFiles(fullName: string, sha: string, token: string): Promise<ProjectObservedCommit["files"]> {
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}/commits/${sha}`, {
      headers: ghHeaders(token),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      files?: Array<{ filename: string; status: string; additions?: number; deletions?: number; changes?: number }>;
    };
    return (data.files || []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    }));
  } catch {
    return [];
  }
}

async function fetchGitHubCommits(
  fullName: string,
  defaultBranch: string | null,
  token: string,
): Promise<ProjectObservedCommit[]> {
  const MAX_PAGES = 5; // Upper bound to prevent unbounded requests (5 pages * 20 = 100 commits max)
  const allCommits: ProjectObservedCommit[] = [];
  
  let pageUrl: string | null = `https://api.github.com/repos/${fullName}/commits?per_page=20${defaultBranch ? `&sha=${defaultBranch}` : ""}`;
  let pagesFetched = 0;

  while (pageUrl && pagesFetched < MAX_PAGES) {
    let res: Response;
    try {
      res = await fetch(pageUrl, {
        headers: ghHeaders(token),
        cache: "no-store",
      });
    } catch {
      throw new GitHubApiError(null, "network");
    }
    if (!res.ok) {
      throw new GitHubApiError(res.status, "http");
    }
    
    let data: Array<{
      sha: string;
      html_url: string;
      commit: { message: string; author: { date: string; name: string; email?: string } };
      author?: { login?: string };
    }>;
    try {
      data = (await res.json()) as Array<{
        sha: string;
        html_url: string;
        commit: { message: string; author: { date: string; name: string; email?: string } };
        author?: { login?: string };
      }>;
    } catch {
      throw new GitHubApiError(null, "network");
    }

    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      const files = i < 10 ? await fetchCommitFiles(fullName, c.sha, token) : [];
      allCommits.push({
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        message: c.commit.message.split("\n")[0],
        author: c.author?.login || c.commit.author.name || "unknown",
        authorEmail: c.commit.author.email,
        date: c.commit.author.date,
        url: c.html_url,
        files,
        projectId: "",
        repositoryConnectionId: "",
      });
    }

    // Parse Link header for pagination
    const linkHeader = res.headers.get("link");
    pageUrl = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        pageUrl = nextMatch[1];
      }
    }
    pagesFetched++;
  }

  return allCommits;
}

async function fetchAuthenticatedUser(token: string): Promise<{ status: number | null; login: string | undefined }> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: ghHeaders(token),
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as { login?: string };
      return { status: res.status, login: data.login };
    }
    return { status: res.status, login: undefined };
  } catch {
    return { status: null, login: undefined };
  }
}

async function parseRateLimitHeaders(headers: Headers): Promise<RateLimitInfo> {
  const limit = headers.get("X-RateLimit-Limit");
  const remaining = headers.get("X-RateLimit-Remaining");
  const reset = headers.get("X-RateLimit-Reset");
  const retryAfter = headers.get("Retry-After");

  return {
    limit: limit ? parseInt(limit, 10) : null,
    remaining: remaining ? parseInt(remaining, 10) : null,
    resetAt: reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : null,
    retryAfterSeconds: retryAfter ? parseInt(retryAfter, 10) : null,
  };
}

async function observeSingleRepository(
  projectId: string,
  link: ProjectRepositoryLink,
  connection: RepositoryConnection,
): Promise<ProjectRepositoryObservationResult> {
  const observedAt = new Date().toISOString();
  const repositoryConnectionId = connection.id;
  const { githubRepoId, fullName, defaultBranch } = connection;

  // Get the owner user's GitHub OAuth token
  const token = await getUserGitHubAccessToken(link.ownerUserId);

  if (!token) {
    return {
      projectId,
      repositoryConnectionId,
      githubRepoId,
      fullName,
      defaultBranch,
      status: "failed",
      commits: [],
      newCommits: [],
      lastObservedAt: observedAt,
      error: "No GitHub OAuth token available for repository owner. Reconnect GitHub account.",
      rateLimit: { limit: null, remaining: null, resetAt: null, retryAfterSeconds: null },
      link_status: link.link_status,
    };
  }

  // Verify identity matches the stored provider_account_id
  const identity = await fetchAuthenticatedGitHubUser(link.ownerUserId);
  if (!identity || identity.id !== connection.providerAccountId) {
    return {
      projectId,
      repositoryConnectionId,
      githubRepoId,
      fullName,
      defaultBranch,
      status: "failed",
      commits: [],
      newCommits: [],
      lastObservedAt: observedAt,
      error:
        "GitHub identity verification failed. The connected account does not match the repository owner. Reconnect GitHub account.",
      rateLimit: { limit: null, remaining: null, resetAt: null, retryAfterSeconds: null },
      link_status: link.link_status,
    };
  }

  let fetchedCommits: ProjectObservedCommit[] | null = null;
  let rateLimit: RateLimitInfo = { limit: null, remaining: null, resetAt: null, retryAfterSeconds: null };
  let actorLogin: string | undefined;

  try {
    fetchedCommits = await fetchGitHubCommits(fullName, defaultBranch, token);
    // Get rate limit info from the last fetch (fetchGitHubCommits doesn't return it directly)
    // We'll fetch it from the user endpoint as a best-effort
    const userRes = await fetch("https://api.github.com/user", { headers: ghHeaders(token), cache: "no-store" });
    rateLimit = await parseRateLimitHeaders(userRes.headers);
    actorLogin = (await fetchAuthenticatedUser(token)).login;
    diag({ projectId, repositoryConnectionId, credentialSource: "user-oauth", actorLogin, apiStatus: 200 });
  } catch (err) {
    const ghErr = err instanceof GitHubApiError ? err : null;
    const status = ghErr ? ghErr.status : null;
    const safeMsg = ghErr ? ghErr.message : safeGitHubFailureMessage(null, "network");
    diag({ projectId, repositoryConnectionId, credentialSource: "user-oauth", actorLogin, apiStatus: status ?? undefined, error: safeMsg });
    return {
      projectId,
      repositoryConnectionId,
      githubRepoId,
      fullName,
      defaultBranch,
      status: "failed",
      commits: [],
      newCommits: [],
      lastObservedAt: observedAt,
      error: safeMsg,
      rateLimit: { limit: null, remaining: null, resetAt: null, retryAfterSeconds: null },
      link_status: link.link_status,
    };
  }

  // Add project/repo context to each commit
  const commitsWithContext = fetchedCommits.map((c) => ({
    ...c,
    projectId,
    repositoryConnectionId,
  }));

  // Merge with project-scoped storage
  try {
    const { added } = await mergeProjectObservedCommits(projectId, repositoryConnectionId, commitsWithContext);
    const newCommits = added;

    const nextState = {
      projectId,
      repositoryConnectionId,
      githubRepoId,
      fullName,
      lastObservedAt: observedAt,
      lastSuccessfulSha: commitsWithContext[0]?.sha,
      lastStatus: "success" as const,
      lastError: undefined,
      lastNewCount: newCommits.length,
    };
    await writeProjectObservationState(nextState);

    return {
      projectId,
      repositoryConnectionId,
      githubRepoId,
      fullName,
      defaultBranch,
      status: "success",
      commits: commitsWithContext,
      newCommits,
      lastObservedAt: observedAt,
      rateLimit,
      link_status: link.link_status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Observation failed after repository access was confirmed.";
    return {
      projectId,
      repositoryConnectionId,
      githubRepoId,
      fullName,
      defaultBranch,
      status: "failed",
      commits: [],
      newCommits: [],
      lastObservedAt: observedAt,
      error: msg,
      rateLimit: { limit: null, remaining: null, resetAt: null, retryAfterSeconds: null },
      link_status: link.link_status,
    };
  }
}

export async function observeProjectRepositories(
  projectId: string,
  userId: string,
): Promise<ProjectObservationResult> {
  const observedAt = new Date().toISOString();

  // Validate project ownership by loading links
  const links = await listRepositoryLinksForProject(projectId, userId);

  if (links.length === 0) {
    return {
      projectId,
      totalRepositories: 0,
      successfulRepositories: 0,
      failedRepositories: 0,
      totalCommits: 0,
      totalNewCommits: 0,
      repositories: [],
      observedAt,
    };
  }

  const results: ProjectRepositoryObservationResult[] = [];
  let totalCommits = 0;
  let totalNewCommits = 0;
  let successful = 0;
  let failed = 0;

  for (const link of links) {
    // Load the full repository connection for the owner user
    const connection = await getRepositoryConnectionForUser(link.repositoryConnectionId, link.ownerUserId);

    if (!connection) {
      results.push({
        projectId,
        repositoryConnectionId: link.repositoryConnectionId,
        githubRepoId: "",
        fullName: link.repositoryConnectionId,
        defaultBranch: null,
        status: "failed",
        commits: [],
        newCommits: [],
        lastObservedAt: observedAt,
        error: "Repository connection not found or access denied.",
        rateLimit: { limit: null, remaining: null, resetAt: null, retryAfterSeconds: null },
        link_status: link.link_status,
      });
      failed++;
      continue;
    }

    const result = await observeSingleRepository(projectId, link, connection);
    results.push(result);

    if (result.status === "success") {
      successful++;
      totalCommits += result.commits.length;
      totalNewCommits += result.newCommits.length;
    } else if (result.status === "partial") {
      successful++; // partial counts as successful for high-level counts
      totalCommits += result.commits.length;
      totalNewCommits += result.newCommits.length;
    } else {
      failed++;
    }
  }

  return {
    projectId,
    totalRepositories: links.length,
    successfulRepositories: successful,
    failedRepositories: failed,
    totalCommits,
    totalNewCommits,
    repositories: results,
    observedAt,
  };
}

export async function getProjectObservationStatus(projectId: string, userId: string) {
  const links = await listRepositoryLinksForProject(projectId, userId);
  const repoStatuses = await Promise.all(
    links.map(async (link) => {
      const connection = await getRepositoryConnectionForUser(link.repositoryConnectionId, link.ownerUserId);
      if (!connection) return { connectionId: link.repositoryConnectionId, state: null, eventsCount: 0 };

      const state = await readProjectObservationState(projectId, link.repositoryConnectionId);
      const events = await readProjectObservedEvents(projectId, link.repositoryConnectionId);
      return {
        connectionId: link.repositoryConnectionId,
        repoFullName: connection.fullName,
        state,
        eventsCount: events.length,
      };
    }),
  );
  return { projectId, repositories: repoStatuses };
}