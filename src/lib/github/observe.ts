import { readGitHubConfig, repoSlug, hasToken } from "./config";
import { readObservationState, writeObservationState, mergeObservedCommits, readObservedEvents } from "./store";
import { getUserGitHubAccessToken } from "@/lib/auth/users";
import type { GitHubObservationResult, ObservedCommit, ObservedCommitFile } from "@/types/github";

/**
 * Safe diagnostic context for observation. Never logs tokens, secrets, keys, or
 * authorization headers — only the credential source, authenticated GitHub login
 * (masked to first/last char), and the GitHub API response status.
 */
interface ObservationDiag {
  credentialSource: "user-oauth" | "server-env" | "none";
  actorLogin?: string;
  apiStatus?: number;
  error?: string;
}

function diag(entry: ObservationDiag) {
  const masked = entry.actorLogin ? entry.actorLogin.replace(/^.(.*).$/, (s) => s[0] + "*".repeat(Math.max(0, s.length - 2)) + s.slice(-1)) : undefined;
  console.log(
    `[github-observe] source=${entry.credentialSource}` +
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

async function fetchCommitFiles(slug: string, sha: string, token: string): Promise<ObservedCommitFile[]> {
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/commits/${sha}`, {
      headers: ghHeaders(token),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { files?: Array<{ filename: string; status: string; additions?: number; deletions?: number; changes?: number }> };
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

async function fetchGitHubCommits(slug: string, token: string): Promise<ObservedCommit[]> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${slug}/commits?per_page=20`, {
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
  // fetch changed files for a reasonable number (recent) to stay lightweight
  const commits: ObservedCommit[] = [];
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    const files = i < 10 ? await fetchCommitFiles(slug, c.sha, token) : [];
    commits.push({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      author: c.author?.login || c.commit.author.name || "unknown",
      authorEmail: c.commit.author.email,
      date: c.commit.author.date,
      url: c.html_url,
      files,
    });
  }
  return commits;
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

export async function observeGitHub({ actorUserId }: { actorUserId?: string } = {}): Promise<GitHubObservationResult> {
  const cfg = await readGitHubConfig();
  const slug = repoSlug(cfg);
  const state = await readObservationState();
  const observedAt = new Date().toISOString();

  // Candidate credentials in preference order: the authenticated user's own GitHub
  // OAuth token, then the server-level GITHUB_TOKEN/GH_TOKEN. Never expose token
  // values in logs or error messages.
  const candidates: { source: "user-oauth" | "server-env"; token: string }[] = [];
  if (actorUserId) {
    const userToken = await getUserGitHubAccessToken(actorUserId);
    if (userToken) candidates.push({ source: "user-oauth", token: userToken });
  }
  const serverToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (serverToken) candidates.push({ source: "server-env", token: serverToken });

  // Validate each candidate against actual repository access (fetching commits).
  // The first credential that can read the repo wins. HTTP 401 means the credential
  // was rejected (unauthorized): try the next candidate. HTTP 403 means the credential
  // lacks repository access or is forbidden (not classified as invalid credentials):
  // try the next candidate since another credential may authorize this repo. Network
  // or other errors stop the loop rather than retrying indefinitely and must not be
  // reported as authentication failures.
  let selected: {
    source: "user-oauth" | "server-env";
    token: string;
    actorLogin: string | undefined;
    commits: ObservedCommit[];
  } | undefined;
  let last401Source: "user-oauth" | "server-env" | undefined;
  let last403Source: "user-oauth" | "server-env" | undefined;
  let lastNonAuthError: { source: "user-oauth" | "server-env"; message: string; status: number | null } | undefined;

  for (const candidate of candidates) {
    let fetchedCommits: ObservedCommit[] | null = null;
    try {
      fetchedCommits = await fetchGitHubCommits(slug, candidate.token);
    } catch (err) {
      const ghErr = err instanceof GitHubApiError ? err : null;
      const status = ghErr ? ghErr.status : null;
      const safeMsg = ghErr ? ghErr.message : safeGitHubFailureMessage(null, "network");
      diag({ credentialSource: candidate.source, actorLogin: undefined, apiStatus: status ?? undefined, error: safeMsg });
      if (status === 401) {
        last401Source = candidate.source;
        continue;
      }
      if (status === 403) {
        last403Source = candidate.source;
        continue;
      }
      // Network error or other non-auth status: cannot confirm repo access; stop
      // rather than retrying indefinitely. Preserve the error for reporting.
      lastNonAuthError = { source: candidate.source, message: safeMsg, status };
      break;
    }
    // Credential succeeded against the real repository. Resolve the actor login
    // (best-effort, non-fatal) for diagnostics only.
    const actorLogin = (await fetchAuthenticatedUser(candidate.token)).login;
    diag({ credentialSource: candidate.source, actorLogin, apiStatus: 200 });
    selected = { ...candidate, actorLogin, commits: fetchedCommits };
    break;
  }

  if (!selected) {
    let msg: string;
    if (last401Source || last403Source) {
      if (last401Source && !last403Source) {
        msg =
          last401Source === "server-env"
            ? "GitHub server credential was rejected (unauthorized). Verify GITHUB_TOKEN/GH_TOKEN in the production environment."
            : "The authenticated user's GitHub OAuth credential was rejected (unauthorized). Reconnect your GitHub account.";
      } else if (last403Source && !last401Source) {
        msg =
          last403Source === "server-env"
            ? "GitHub server credential lacks repository access or is forbidden. Verify GITHUB_TOKEN/GH_TOKEN permissions for the target repository."
            : "The authenticated user's GitHub OAuth credential lacks repository access or is forbidden. Reconnect your GitHub account or grant repository access.";
      } else {
        // Both 401 and 403 were encountered across candidates. Do not classify 403 as invalid credentials.
        const primary = last403Source ?? last401Source;
        msg =
          primary === "server-env"
            ? "GitHub credentials were rejected or lack repository access. Verify GITHUB_TOKEN/GH_TOKEN and its repository permissions."
            : "GitHub credentials were rejected or lack repository access. Reconnect your GitHub account or verify repository permissions.";
      }
    } else if (lastNonAuthError) {
      msg = `Could not verify GitHub repository access due to a non-authentication error (${lastNonAuthError.source}): ${lastNonAuthError.message}`;
    } else {
      msg = "No valid GitHub credential could access the repository. Connect GitHub or set GITHUB_TOKEN/GH_TOKEN.";
    }
    const failedState = { ...state, lastObservedAt: observedAt, lastStatus: "failed" as const, lastError: msg };
    try {
      await writeObservationState(failedState);
    } catch (persistErr) {
      const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      void pmsg;
      return {
        repo: slug,
        source: "none",
        commits: [],
        newCommits: [],
        state: { ...failedState, lastError: `${msg} (additionally failed to persist observation state)` },
        observedAt,
        error: `${msg} (additionally failed to persist observation state)`,
      };
    }
    return {
      repo: slug,
      source: "none",
      commits: [],
      newCommits: [],
      state: failedState,
      observedAt,
      error: msg,
    };
  }

  const { actorLogin, commits, source: selectedSource } = selected;
  const source: "github-api" | "git-local" | "none" = "github-api";
  let note: string | undefined;

  try {
    diag({ credentialSource: selectedSource, actorLogin, apiStatus: 200 });

    const { added } = await mergeObservedCommits(commits);
    // added are truly new to store (detected since last observation state merge)
    const newCommits = added;

    const nextState = {
      ...state,
      lastObservedAt: observedAt,
      lastSuccessfulSha: commits[0]?.sha || state.lastSuccessfulSha,
      lastStatus: "success" as const,
      lastError: undefined,
      lastNewCount: newCommits.length,
    };
    try {
      await writeObservationState(nextState);
    } catch (persistErr) {
      void persistErr;
      throw new Error("Observation succeeded but failed to persist observation state.");
    }

    return {
      repo: slug,
      source,
      commits,
      newCommits,
      state: nextState,
      observedAt,
      note,
    };
  } catch (err) {
    void err;
    const msg = "Observation failed after repository access was confirmed.";
    const failedState = { ...state, lastObservedAt: observedAt, lastStatus: "failed" as const, lastError: msg };
    try {
      await writeObservationState(failedState);
    } catch (persistErr) {
      void persistErr;
      return {
        repo: slug,
        source: "github-api",
        commits: [],
        newCommits: [],
        state: { ...failedState, lastError: `${msg} (additionally failed to persist observation state)` },
        observedAt,
        error: `${msg} (additionally failed to persist observation state)`,
      };
    }
    return {
      repo: slug,
      source: "github-api",
      commits: [],
      newCommits: [],
      state: failedState,
      observedAt,
      error: msg,
    };
  }
}

export type ObservationOwnership = "system" | "user" | "project" | "unknown-legacy";

export type SafeObservationStatus = {
  /** Global observation is system-owned operational monitoring, not project/user private history. */
  scope: "system";
  ownership: "system";
  repoConfigured: boolean;
  tokenConfigured: boolean;
  eventsCount: number;
  /** Redacted for non-privileged principals. */
  repo: string | null;
  config: { configuredIn: "file" | "env" | "none" };
  state: {
    lastObservedAt?: string;
    lastStatus?: "success" | "failed";
    lastNewCount?: number;
  };
  note: string;
};

export async function getObservationStatus(opts?: { privileged?: boolean }): Promise<SafeObservationStatus> {
  const [state, events] = await Promise.all([readObservationState(), opts?.privileged === true ? readObservedEvents({ privileged: true, system: true }) : Promise.resolve([])]);
  const cfg = await readGitHubConfig();
  const privileged = opts?.privileged === true;
  return {
    scope: "system",
    ownership: "system",
    repoConfigured: !!cfg.owner && !!cfg.repo,
    tokenConfigured: hasToken(),
    eventsCount: privileged ? (Array.isArray(events) ? events.length : 0) : 0,
    repo: privileged && cfg.owner && cfg.repo ? `${cfg.owner}/${cfg.repo}` : null,
    config: { configuredIn: cfg.owner && cfg.repo ? "file" : "none" },
    state: {
      lastObservedAt: state.lastObservedAt,
      lastStatus: state.lastStatus,
      lastNewCount: state.lastNewCount,
    },
    note: "Global GitHub observation is system-owned operational monitoring. Repository identifiers and raw errors are redacted for non-privileged principals. Legacy global events have unknown historical ownership and are not attributed to users/projects.",
  };
}