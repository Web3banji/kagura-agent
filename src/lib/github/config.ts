import { promises as fs } from "fs";
import path from "path";
import type { GitHubConfig } from "@/types/github";
import { hasDatabase, kvGet, kvSet } from "@/lib/db";

const DATA_DIR = path.join(process.cwd(), "data", "github");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const CONFIG_KEY = "github:config";

const DEFAULT_CONFIG: GitHubConfig = {
  owner: "Web3banji",
  repo: "kagura-agent",
  configuredIn: "default",
};

function isProdRuntime(): boolean {
  return !!process.env.VERCEL || process.env.NODE_ENV === "production";
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export function getEnvRepo(): { owner?: string; repo?: string; slug?: string; token?: string } {
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;
  const slug = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return { owner, repo, slug, token };
}

async function readLegacyFileConfig(): Promise<Partial<GitHubConfig> | undefined> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as Partial<GitHubConfig>;
  } catch {
    return undefined;
  }
}

export async function readGitHubConfig(): Promise<GitHubConfig> {
  const env = getEnvRepo();
  if (env.slug) {
    const [o, r] = env.slug.split("/");
    if (o && r) return { owner: o, repo: r, configuredIn: "env" };
  }
  if (env.owner && env.repo) return { owner: env.owner, repo: env.repo, configuredIn: "env" };

  if (hasDatabase()) {
    const db = await kvGet<GitHubConfig>(CONFIG_KEY);
    if (db?.owner && db?.repo) {
      return { owner: db.owner, repo: db.repo, configuredIn: "file", updatedAt: db.updatedAt };
    }
    const legacy = await readLegacyFileConfig();
    if (legacy?.owner && legacy?.repo) {
      const cfg: GitHubConfig = {
        owner: String(legacy.owner),
        repo: String(legacy.repo),
        configuredIn: "file",
        updatedAt: legacy.updatedAt,
      };
      try {
        await kvSet(CONFIG_KEY, cfg);
      } catch {
        // Best-effort import; still return legacy without discarding it.
      }
      return cfg;
    }
    return { ...DEFAULT_CONFIG };
  }

  // Development fallback: local file (if present) when DATABASE_URL is absent.
  if (!isProdRuntime()) {
    const legacy = await readLegacyFileConfig();
    if (legacy?.owner && legacy?.repo) {
      return { owner: String(legacy.owner), repo: String(legacy.repo), configuredIn: "file", updatedAt: legacy.updatedAt };
    }
  }

  return { ...DEFAULT_CONFIG };
}

export async function writeGitHubConfig(owner: string, repo: string): Promise<GitHubConfig> {
  const cfg: GitHubConfig = {
    owner: owner.trim(),
    repo: repo.trim(),
    configuredIn: "file",
    updatedAt: new Date().toISOString(),
  };
  if (hasDatabase()) {
    await kvSet(CONFIG_KEY, cfg);
    return cfg;
  }
  if (isProdRuntime()) {
    throw new Error(
      "Durable GitHub storage is not configured (DATABASE_URL missing in production); cannot save project configuration to local filesystem.",
    );
  }
  await ensureDir();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  return cfg;
}

export function repoSlug(cfg: GitHubConfig): string {
  return `${cfg.owner}/${cfg.repo}`;
}

export function hasToken(): boolean {
  return !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
}
