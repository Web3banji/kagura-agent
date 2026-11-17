import { promises as fs } from "fs";
import path from "path";
import type { GitHubConfig } from "@/types/github";

const DATA_DIR = path.join(process.cwd(), "data", "github");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const DEFAULT_CONFIG: GitHubConfig = {
  owner: "Web3banji",
  repo: "kagura-agent",
  configuredIn: "default",
};

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export function getEnvRepo(): { owner?: string; repo?: string; slug?: string; token?: string } {
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;
  const slug = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return { owner, repo, slug, token };
}

export async function readGitHubConfig(): Promise<GitHubConfig> {
  const env = getEnvRepo();
  if (env.slug) {
    const [o, r] = env.slug.split("/");
    if (o && r) return { owner: o, repo: r, configuredIn: "env" };
  }
  if (env.owner && env.repo) return { owner: env.owner, repo: env.repo, configuredIn: "env" };
  await ensure();
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<GitHubConfig>;
    if (parsed.owner && parsed.repo) {
      return { owner: parsed.owner, repo: parsed.repo, configuredIn: "file", updatedAt: parsed.updatedAt };
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

export async function writeGitHubConfig(owner: string, repo: string): Promise<GitHubConfig> {
  await ensure();
  const cfg: GitHubConfig = { owner: owner.trim(), repo: repo.trim(), configuredIn: "file", updatedAt: new Date().toISOString() };
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  return cfg;
}

export function repoSlug(cfg: GitHubConfig): string {
  return `${cfg.owner}/${cfg.repo}`;
}

export function hasToken(): boolean {
  return !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
}