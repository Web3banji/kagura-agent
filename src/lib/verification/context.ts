import { readGitHubConfig, repoSlug } from "@/lib/github/config";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";

export async function resolveProjectId(): Promise<string> {
  try {
    const cfg = await readGitHubConfig();
    const slug = repoSlug(cfg);
    return slug || "default";
  } catch {
    return "default";
  }
}

/**
 * Resolve all project IDs owned by the given user.
 * Used for project-scoped observation and verification history retrieval.
 */
export async function resolveProjectIdsForUser(userId: string): Promise<string[]> {
  if (!hasDatabase()) return [];
  await ensureDb();
  const res = await getPool().query(
    "SELECT id FROM projects WHERE owner_user_id = $1 ORDER BY created_at DESC",
    [userId],
  );
  return res.rows.map((r) => String(r.id)).filter(Boolean);
}
