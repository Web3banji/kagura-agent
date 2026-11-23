import { NextResponse } from "next/server";
import { fetchRepositoryById, fetchAuthenticatedGitHubUser } from "@/lib/github/discover";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import {
  createRepositoryConnection,
  findRepositoryConnectionByRepo,
} from "@/lib/repositories/connections";
import { hasDatabase, getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized || principal.kind !== "user") {
    return unauthorizedResponse(principal.reason || "Unauthorized");
  }

  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  let githubRepoId = "";
  try {
    const body = (await req.json()) as { githubRepoId?: string };
    githubRepoId = (body.githubRepoId || "").trim();

    if (!githubRepoId) {
      return NextResponse.json({ error: "githubRepoId is required" }, { status: 400 });
    }

    if (!/^\d+$/.test(githubRepoId)) {
      return NextResponse.json({ error: "Invalid githubRepoId format" }, { status: 400 });
    }

    const existing = await findRepositoryConnectionByRepo(principal.userId, "github", githubRepoId);
    if (existing) {
      return NextResponse.json({ connection: existing, alreadyConnected: true });
    }

    const repo = await fetchRepositoryById(principal.userId, githubRepoId);
    if (!repo) {
      return NextResponse.json(
        { error: "Repository not found or not accessible with your GitHub credentials" },
        { status: 404 },
      );
    }

    // Verify the authenticated GitHub identity matches the stored provider account
    const authUser = await fetchAuthenticatedGitHubUser(principal.userId);
    if (!authUser) {
      return NextResponse.json(
        { error: "Could not verify GitHub identity. Please reauthorize your GitHub account." },
        { status: 401 },
      );
    }

    const accountRes = await getPool().query(
      `SELECT provider_account_id FROM accounts WHERE user_id = $1 AND provider = 'github' LIMIT 1`,
      [principal.userId],
    );
    const providerAccountId = accountRes.rows[0]?.provider_account_id ?? null;

    if (!providerAccountId) {
      return NextResponse.json(
        { error: "No GitHub account linked. Please connect your GitHub account first." },
        { status: 400 },
      );
    }

    if (providerAccountId !== authUser.id) {
      return NextResponse.json(
        { error: "GitHub identity mismatch. The authenticated GitHub account does not match the stored account. Please reauthorize." },
        { status: 409 },
      );
    }

    const connection = await createRepositoryConnection(principal.userId, {
      provider: "github",
      providerAccountId,
      githubRepoId: repo.githubRepoId,
      repoOwner: repo.repoOwner,
      repoName: repo.repoName,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      isPrivate: repo.isPrivate,
      permissions: repo.permissions,
      status: "active",
    });

    return NextResponse.json({ connection, alreadyConnected: false });
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr?.code === "23505" && pgErr?.constraint?.includes("owner_user_id")) {
      const existing = await findRepositoryConnectionByRepo(principal.userId, "github", githubRepoId);
      if (existing) {
        return NextResponse.json({ connection: existing, alreadyConnected: true });
      }
    }
    const message = err instanceof Error ? err.message : "Failed to connect repository";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}