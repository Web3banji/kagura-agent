import { execFile } from "child_process";
import { promisify } from "util";
import { readGitHubConfig, repoSlug, hasToken } from "./config";
import { readObservationState, writeObservationState, mergeObservedCommits, readObservedEvents } from "./store";
import type { GitHubObservationResult, ObservedCommit, ObservedCommitFile } from "@/types/github";

const execFileAsync = promisify(execFile);

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "kagura-agent",
  };
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
  const res = await fetch(`https://api.github.com/repos/${slug}/commits?per_page=20`, {
    headers: ghHeaders(token),
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${txt.slice(0, 200) || res.statusText}`);
  }
  const data = (await res.json()) as Array<{
    sha: string;
    html_url: string;
    commit: { message: string; author: { date: string; name: string; email?: string } };
    author?: { login?: string };
  }>;
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

async function localCommitsFallback(limit = 15): Promise<ObservedCommit[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", `-${limit}`, "--pretty=format:%H|%h|%s|%cI|%an|%ae"],
      { cwd: process.cwd(), windowsHide: true },
    );
    const rows = stdout.trim().split(/\r?\n/).filter(Boolean);
    const out: ObservedCommit[] = [];
    for (const line of rows) {
      const [sha, shortSha, message, date, author, email] = line.split("|");
      let files: ObservedCommitFile[] = [];
      try {
        const { stdout: fsout } = await execFileAsync(
          "git",
          ["show", "--name-status", "--format=", sha],
          { cwd: process.cwd(), windowsHide: true },
        );
        files = fsout
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => {
            const [status, ...rest] = l.split(/\t/);
            return { filename: rest.join("\t") || l, status: status || "M" };
          });
      } catch {}
      out.push({
        sha,
        shortSha,
        message,
        author: author || "unknown",
        authorEmail: email,
        date,
        url: "",
        files,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function observeGitHub(): Promise<GitHubObservationResult> {
  const cfg = await readGitHubConfig();
  const slug = repoSlug(cfg);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const state = await readObservationState();
  const observedAt = new Date().toISOString();

  try {
    let commits: ObservedCommit[] = [];
    let source: "github-api" | "git-local" = "git-local";
    let note: string | undefined;

    if (token) {
      commits = await fetchGitHubCommits(slug, token);
      source = "github-api";
    } else {
      commits = await localCommitsFallback(15);
      source = "git-local";
      note = "GITHUB_TOKEN not configured; fell back to local git history. Configure a token in .env.local for real GitHub API observation.";
    }

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
      const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      throw new Error(`Observation succeeded but failed to persist state: ${pmsg}`);
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
    const msg = err instanceof Error ? err.message : String(err);
    const failedState = { ...state, lastObservedAt: observedAt, lastStatus: "failed" as const, lastError: msg };
    try {
      await writeObservationState(failedState);
    } catch (persistErr) {
      const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      return {
        repo: slug,
        source: hasToken() ? "github-api" : "git-local",
        commits: [],
        newCommits: [],
        state: { ...failedState, lastError: `${msg} (also failed to persist state: ${pmsg})` },
        observedAt,
        error: `${msg} (also failed to persist state: ${pmsg})`,
      };
    }
    return {
      repo: slug,
      source: hasToken() ? "github-api" : "git-local",
      commits: [],
      newCommits: [],
      state: failedState,
      observedAt,
      error: msg,
    };
  }
}

export async function getObservationStatus() {
  const cfg = await readGitHubConfig();
  const state = await readObservationState();
  const events = await readObservedEvents();
  return { config: cfg, state, eventsCount: events.length, tokenConfigured: hasToken(), repo: repoSlug(cfg) };
}