import { execFile } from "child_process";
import { promisify } from "util";
import type { CommitInfo } from "@/lib/journal/activity";
import { getRecentCommits } from "@/lib/journal/activity";

const execFileAsync = promisify(execFile);

export interface Observation {
  repo: string;
  source: "github-api" | "git-local" | "none";
  commits: CommitInfo[];
  changedFiles: string[];
  summary: string;
  observedAt: string;
  note?: string;
}

async function tryGitHub(repoSlug: string, limit: number): Promise<CommitInfo[] | null> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return null;
  try {
    const url = `https://api.github.com/repos/${repoSlug}/commits?per_page=${limit}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{
      sha: string;
      commit: { message: string; author: { date: string; name: string } };
    }>;
    return data.map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      date: c.commit.author.date,
      author: c.commit.author.name,
    }));
  } catch {
    return null;
  }
}

export async function observeRepo(): Promise<Observation> {
  const repo = process.env.GITHUB_REPO || "Web3banji/kagura-agent";
  const limit = 8;
  const gh = await tryGitHub(repo, limit);
  const commits = gh ?? (await getRecentCommits(limit));
  const source: Observation["source"] = gh ? "github-api" : "git-local";

  let changedFiles: string[] = [];
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD~1..HEAD"], {
      cwd: process.cwd(),
      windowsHide: true,
    });
    changedFiles = stdout.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    // single commit or unavailable
  }

  const summary =
    commits.length === 0
      ? "No commits observed."
      : `Observed ${commits.length} recent commit(s) via ${source}. Latest: "${commits[0].message}".`;

  return {
    repo,
    source,
    commits,
    changedFiles,
    summary,
    observedAt: new Date().toISOString(),
    note: gh ? undefined : "GitHub token not configured; fell back to local git history (real data).",
  };
}