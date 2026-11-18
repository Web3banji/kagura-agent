import { readGitHubConfig, repoSlug } from "@/lib/github/config";

export async function resolveProjectId(): Promise<string> {
  try {
    const cfg = await readGitHubConfig();
    const slug = repoSlug(cfg);
    return slug || "default";
  } catch {
    return "default";
  }
}
