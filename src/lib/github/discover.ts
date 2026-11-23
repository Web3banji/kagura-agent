import { getUserGitHubAccessToken } from "@/lib/auth/users";

export interface DiscoveredRepository {
  githubRepoId: string;
  repoOwner: string;
  repoName: string;
  fullName: string;
  defaultBranch: string | null;
  isPrivate: boolean | null;
  htmlUrl: string;
  description: string | null;
  permissions: Record<string, unknown> | null;
  archived: boolean;
  disabled: boolean;
}

export interface DiscoverRepositoriesOptions {
  page?: number;
  perPage?: number;
  search?: string;
  owner?: string;
  visibility?: "all" | "public" | "private";
  affiliation?: "owner" | "collaborator" | "organization_member";
  includeArchived?: boolean;
}

export interface DiscoverRepositoriesResult {
  repositories: DiscoveredRepository[];
  pagination: {
    page: number;
    perPage: number;
    totalCount: number | null;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  requiresReauthorization: boolean;
  rateLimit?: RateLimitInfo;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  retryAfterSeconds: number | null;
}

export interface GitHubApiError {
  message: string;
  status: number | null;
  kind: "http" | "network" | "scope" | "auth" | "rate-limit";
}

export interface GitHubUserIdentity {
  id: string;
  login: string;
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "kagura-agent",
  };
}

function safeGitHubFailureMessage(status: number | null, kind: GitHubApiError["kind"]): string {
  if (kind === "network" || status == null) {
    return "Network error while contacting GitHub API.";
  }
  if (status === 401) {
    return "GitHub API request unauthorized (401). Token may be invalid or expired.";
  }
  if (status === 403) {
    return "GitHub API request forbidden (403). Token may lack required permissions or hit rate limit.";
  }
  if (status === 422 && kind === "scope") {
    return "GitHub token lacks required 'repo' scope for repository discovery.";
  }
  if (status === 429 || kind === "rate-limit") {
    return "GitHub API rate limit exceeded.";
  }
  return `GitHub API request failed (${status}).`;
}

function parseRateLimitHeaders(headers: Headers): RateLimitInfo {
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

class GitHubApiErrorClass extends Error {
  status: number | null;
  kind: GitHubApiError["kind"];
  rateLimit?: RateLimitInfo;

  constructor(status: number | null, kind: GitHubApiError["kind"], rateLimit?: RateLimitInfo) {
    super(safeGitHubFailureMessage(status, kind));
    this.name = "GitHubApiError";
    this.status = status;
    this.kind = kind;
    this.rateLimit = rateLimit;
  }
}

function normalizeRepository(repo: Record<string, unknown>): DiscoveredRepository {
  const permissions = (repo.permissions as Record<string, unknown> | null) ?? null;
  return {
    githubRepoId: String(repo.id),
    repoOwner: String((repo.owner as Record<string, unknown>)?.login ?? ""),
    repoName: String(repo.name ?? ""),
    fullName: String(repo.full_name ?? ""),
    defaultBranch: repo.default_branch == null ? null : String(repo.default_branch),
    isPrivate: repo.private == null ? null : Boolean(repo.private),
    htmlUrl: String(repo.html_url ?? ""),
    description: repo.description == null ? null : String(repo.description),
    permissions,
    archived: Boolean(repo.archived ?? false),
    disabled: Boolean(repo.disabled ?? false),
  };
}

async function fetchUserRepositoriesPage(
  token: string,
  page: number,
  perPage: number,
  options: Pick<DiscoverRepositoriesOptions, "search" | "owner" | "visibility" | "affiliation" | "includeArchived">,
): Promise<{ repositories: DiscoveredRepository[]; totalCount: number | null; hasNextPage: boolean; rateLimit: RateLimitInfo }> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
    sort: "updated",
    direction: "desc",
    type: "all",
  });

  if (options.search) {
    params.set("q", `${options.search} in:name,description`);
  }
  if (options.owner) {
    params.set("q", `${(params.get("q") || "")} user:${options.owner}`.trim());
  }
  if (options.visibility && options.visibility !== "all") {
    params.set("visibility", options.visibility);
  }
  if (options.affiliation) {
    params.set("affiliation", options.affiliation);
  }
  if (options.includeArchived !== undefined) {
    params.set("archived", options.includeArchived ? "true" : "false");
  }

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/user/repos?${params.toString()}`, {
      headers: ghHeaders(token),
      cache: "no-store",
    });
  } catch {
    throw new GitHubApiErrorClass(null, "network");
  }

  const rateLimit = parseRateLimitHeaders(res.headers);

  if (!res.ok) {
    let kind: GitHubApiError["kind"] = "http";
    if (res.status === 422) kind = "scope";
    else if (res.status === 401) kind = "auth";
    else if (res.status === 403 || res.status === 429) kind = "rate-limit";
    throw new GitHubApiErrorClass(res.status, kind, rateLimit);
  }

  let data: Array<Record<string, unknown>>;
  try {
    data = (await res.json()) as Array<Record<string, unknown>>;
  } catch {
    throw new GitHubApiErrorClass(null, "network");
  }

  const linkHeader = res.headers.get("link");
  const hasNextPage = linkHeader !== null && linkHeader.includes('rel="next"');

  const totalCount = linkHeader
    ? (() => {
        const lastMatch = linkHeader.match(/page=(\d+)>; rel="last"/);
        return lastMatch ? parseInt(lastMatch[1], 10) * perPage : null;
      })()
    : data.length < perPage
    ? page * perPage
    : null;

  return {
    repositories: data.map(normalizeRepository),
    totalCount,
    hasNextPage,
    rateLimit,
  };
}

export async function discoverRepositories(
  userId: string,
  options: DiscoverRepositoriesOptions = {},
): Promise<DiscoverRepositoriesResult> {
  const token = await getUserGitHubAccessToken(userId);

  if (!token) {
    return {
      repositories: [],
      pagination: {
        page: 1,
        perPage: 30,
        totalCount: 0,
        hasNextPage: false,
        hasPrevPage: false,
      },
      requiresReauthorization: true,
    };
  }

  const page = Math.max(1, Math.floor(options.page ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.floor(options.perPage ?? 30)));

  try {
    const result = await fetchUserRepositoriesPage(token, page, perPage, {
      search: options.search?.trim(),
      owner: options.owner?.trim(),
      visibility: options.visibility ?? "all",
      affiliation: options.affiliation,
      includeArchived: options.includeArchived ?? false,
    });

    return {
      repositories: result.repositories,
      pagination: {
        page,
        perPage,
        totalCount: result.totalCount,
        hasNextPage: result.hasNextPage,
        hasPrevPage: page > 1,
      },
      requiresReauthorization: false,
      rateLimit: result.rateLimit,
    };
  } catch (err) {
    const ghErr = err instanceof GitHubApiErrorClass ? err : null;
    if (ghErr?.status === 401 || ghErr?.status === 403 || ghErr?.kind === "scope") {
      return {
        repositories: [],
        pagination: {
          page,
          perPage,
          totalCount: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
        requiresReauthorization: true,
        rateLimit: ghErr.rateLimit,
      };
    }
    if (ghErr?.kind === "rate-limit") {
      return {
        repositories: [],
        pagination: {
          page,
          perPage,
          totalCount: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
        requiresReauthorization: false,
        rateLimit: ghErr.rateLimit,
      };
    }
    throw err;
  }
}

export async function fetchRepositoryById(
  userId: string,
  githubRepoId: string,
): Promise<DiscoveredRepository | null> {
  const token = await getUserGitHubAccessToken(userId);

  if (!token) {
    return null;
  }

  try {
    const res = await fetch(`https://api.github.com/repositories/${githubRepoId}`, {
      headers: ghHeaders(token),
      cache: "no-store",
    });

    const rateLimit = parseRateLimitHeaders(res.headers);

    if (!res.ok) {
      if (res.status === 404) return null;
      let kind: GitHubApiError["kind"] = "http";
      if (res.status === 401 || res.status === 403) kind = "auth";
      else if (res.status === 429) kind = "rate-limit";
      throw new GitHubApiErrorClass(res.status, kind, rateLimit);
    }

    const data = (await res.json()) as Record<string, unknown>;
    return normalizeRepository(data);
  } catch (err) {
    const ghErr = err instanceof GitHubApiErrorClass ? err : null;
    if (ghErr?.status === 401 || ghErr?.status === 403 || ghErr?.kind === "scope") {
      return null;
    }
    if (ghErr?.kind === "rate-limit") {
      throw new GitHubApiErrorClass(ghErr.status, "rate-limit", ghErr.rateLimit);
    }
    throw err;
  }
}

export async function fetchAuthenticatedGitHubUser(
  userId: string,
): Promise<GitHubUserIdentity | null> {
  const token = await getUserGitHubAccessToken(userId);

  if (!token) {
    return null;
  }

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: ghHeaders(token),
      cache: "no-store",
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return null;
      }
      throw new GitHubApiErrorClass(res.status, "http");
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      id: String(data.id),
      login: String(data.login || ""),
    };
  } catch {
    return null;
  }
}