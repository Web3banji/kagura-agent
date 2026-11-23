import { NextResponse } from "next/server";
import { requireUserApi, apiErrorResponse } from "@/lib/auth/guards";
import { hasDatabase, ensureDb, getPool } from "@/lib/db";
import { observeProjectRepositories } from "@/lib/github/observe-project";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };

  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }

  try {
    await ensureDb();
    const { projectId } = await params;

    const projectRes = await getPool().query(
      `SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
      [projectId, user.id],
    );
    if (projectRes.rowCount === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const result = await observeProjectRepositories(projectId, user.id);

    const statusCode = result.failedRepositories === result.totalRepositories && result.totalRepositories > 0 ? 502 : 200;

    return NextResponse.json(
      {
        projectId: result.projectId,
        status: result.failedRepositories === 0 ? "success" : result.failedRepositories === result.totalRepositories ? "failed" : "partial",
        totalRepositories: result.totalRepositories,
        successfulRepositories: result.successfulRepositories,
        failedRepositories: result.failedRepositories,
        totalNewCommits: result.totalNewCommits,
        observedAt: result.observedAt,
        repositories: result.repositories.map((repo) => ({
          repositoryConnectionId: repo.repositoryConnectionId,
          githubRepoId: repo.githubRepoId,
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          status: repo.status,
          newCommitsCount: repo.newCommits.length,
          commitsCount: repo.commits.length,
          error: repo.error,
          rateLimit: repo.rateLimit,
        })),
      },
      { status: statusCode },
    );
  } catch (err) {
    return apiErrorResponse(err);
  }
}