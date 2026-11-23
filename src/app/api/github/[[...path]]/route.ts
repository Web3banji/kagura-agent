import { NextResponse } from "next/server";
import { readGitHubConfig, writeGitHubConfig } from "@/lib/github/config";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { discoverRepositories, fetchRepositoryById, fetchAuthenticatedGitHubUser } from "@/lib/github/discover";
import { createRepositoryConnection, findRepositoryConnectionByRepo } from "@/lib/repositories/connections";
import { hasDatabase, getPool } from "@/lib/db";
import { listRepositoryConnectionsForUser, getRepositoryConnectionForUser, deleteRepositoryConnection } from "@/lib/repositories/connections";

export const dynamic = "force-dynamic";

async function handleConfigGet(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  return NextResponse.json(await readGitHubConfig());
}

async function handleConfigPost(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.privileged && !(scope.userId && scope.includeLegacy)) {
    return NextResponse.json({ error: "Only the workspace owner can change the platform repository configuration." }, { status: 403 });
  }
  try {
    const body = (await req.json()) as { owner?: string; repo?: string };
    const owner = (body.owner || "").trim();
    const repo = (body.repo || "").trim();
    if (!owner || !repo) return NextResponse.json({ error: "owner and repo are required" }, { status: 400 });
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
      return NextResponse.json({ error: "Invalid owner or repo name" }, { status: 400 });
    }
    const cfg = await writeGitHubConfig(owner, repo);
    return NextResponse.json(cfg);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function handleObserveGet(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const { getObservationStatus } = await import("@/lib/github/observe");
  return NextResponse.json(await getObservationStatus());
}

async function handleObservePost(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized) return unauthorizedResponse(principal.reason || "Unauthorized");
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  if (!scope.privileged) {
    return NextResponse.json({ error: "GitHub observation may only be triggered by a workspace owner." }, { status: 403 });
  }
  try {
    const { observeGitHub } = await import("@/lib/github/observe");
    const result = await observeGitHub({ actorUserId: principal.userId });
    if (result.error) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function handleRepositoriesGet(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized || principal.kind !== "user") {
    return unauthorizedResponse(principal.reason || "Unauthorized");
  }
  try {
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const perPage = parseInt(url.searchParams.get("perPage") || "30", 10);
    const search = url.searchParams.get("search")?.trim() || undefined;
    const owner = url.searchParams.get("owner")?.trim() || undefined;
    const visibility = (url.searchParams.get("visibility") as "all" | "public" | "private") || "all";
    const affiliation = (url.searchParams.get("affiliation") as "owner" | "collaborator" | "organization_member") || undefined;
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    if (page < 1 || page > 1000) {
      return NextResponse.json({ error: "Invalid page parameter" }, { status: 400 });
    }
    if (perPage < 1 || perPage > 100) {
      return NextResponse.json({ error: "Invalid perPage parameter (max 100)" }, { status: 400 });
    }
    if (search && search.length > 200) {
      return NextResponse.json({ error: "Search query too long" }, { status: 400 });
    }
    if (owner && !/^[\w.-]+$/.test(owner)) {
      return NextResponse.json({ error: "Invalid owner parameter" }, { status: 400 });
    }
    const result = await discoverRepositories(principal.userId, { page, perPage, search, owner, visibility, affiliation, includeArchived });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to discover repositories";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handleConnectPost(req: Request) {
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
      return NextResponse.json({ error: "Repository not found or not accessible with your GitHub credentials" }, { status: 404 });
    }
    const authUser = await fetchAuthenticatedGitHubUser(principal.userId);
    if (!authUser) {
      return NextResponse.json({ error: "Could not verify GitHub identity. Please reauthorize your GitHub account." }, { status: 401 });
    }
    const accountRes = await getPool().query(`SELECT provider_account_id FROM accounts WHERE user_id = $1 AND provider = 'github' LIMIT 1`, [principal.userId]);
    const providerAccountId = accountRes.rows[0]?.provider_account_id ?? null;
    if (!providerAccountId) {
      return NextResponse.json({ error: "No GitHub account linked. Please connect your GitHub account first." }, { status: 400 });
    }
    if (providerAccountId !== authUser.id) {
      return NextResponse.json({ error: "GitHub identity mismatch. The authenticated GitHub account does not match the stored account. Please reauthorize." }, { status: 409 });
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

async function handleConnectionsGet(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized || principal.kind !== "user") {
    return unauthorizedResponse(principal.reason || "Unauthorized");
  }
  try {
    const connections = await listRepositoryConnectionsForUser(principal.userId);
    return NextResponse.json({ connections });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list repository connections";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handleConnectionDelete(req: Request, id: string) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized || principal.kind !== "user") {
    return unauthorizedResponse(principal.reason || "Unauthorized");
  }
  try {
    const connectionId = id.trim();
    if (!connectionId) {
      return NextResponse.json({ error: "Connection ID is required" }, { status: 400 });
    }
    const connection = await getRepositoryConnectionForUser(connectionId, principal.userId);
    if (!connection) {
      return NextResponse.json({ error: "Repository connection not found" }, { status: 404 });
    }
    const deleted = await deleteRepositoryConnection(connectionId, principal.userId);
    if (!deleted) {
      return NextResponse.json({ error: "Failed to disconnect repository" }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23001") {
      return NextResponse.json({ error: "Cannot disconnect repository: it is linked to one or more projects. Unlink from all projects first." }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Failed to disconnect repository";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function notFound() { return NextResponse.json({ error: "Not found" }, { status: 404 }); }

export async function GET(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "config") return handleConfigGet(req);
  if (path === "observe") return handleObserveGet(req);
  if (path === "repositories") return handleRepositoriesGet(req);
  if (path === "repositories/connections") return handleConnectionsGet(req);
  return notFound();
}

export async function POST(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  if (path === "config") return handleConfigPost(req);
  if (path === "observe") return handleObservePost(req);
  if (path === "repositories/connect") return handleConnectPost(req);
  return notFound();
}

export async function DELETE(req: Request, ctx: { params: { path?: string[] } }) {
  const path = (ctx.params.path || []).join("/");
  const match = path.match(/^repositories\/connections\/([^/]+)$/);
  if (match) return handleConnectionDelete(req, decodeURIComponent(match[1]));
  return notFound();
}