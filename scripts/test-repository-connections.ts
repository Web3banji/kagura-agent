/**
 * Stage 1: multi-repository database foundation regression tests.
 *
 * Runs against the real database configured in `.env.local` (DATABASE_URL).
 * All fixtures are created with unique, throwaway identifiers and removed on exit.
 * No existing user data is read, modified, or deleted. No mock repos/projects are
 * seeded into application data outside isolated test fixtures.
 *
 * Run:  npx tsx scripts/test-repository-connections.ts
 *
 * Covers (Stage 1):
 *  1. A user can have multiple repository connections.
 *  2. A project can have multiple repository connections.
 *  3. A repository connection can be reused across multiple projects owned by the same user.
 *  4. A user cannot link another user's repository to their project.
 *  5. Duplicate repository connections are handled correctly.
 *  6. Duplicate project-repository relationships are prevented.
 *  7. Deleting a project preserves reusable repository connections.
 *  8. Existing multi-user project behavior remains intact (basic ownership/visibility check).
 */

process.loadEnvFile(".env.local");

import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { ensureDb, getPool, hasDatabase } from "@/lib/db";
import { upsertGitHubUser } from "@/lib/auth/users";
import {
  createRepositoryConnection,
  deleteRepositoryConnection,
  findRepositoryConnectionByRepo,
  getRepositoryConnectionForUser,
  linkRepositoryToProject,
  listProjectsForRepositoryConnection,
  listRepositoryConnectionsForUser,
  listRepositoryLinksForProject,
  unlinkRepositoryFromProject,
} from "@/lib/repositories/connections";

type UserFixture = { userId: string; githubLogin: string };

const TEST_PREFIX = `kagura-repo-test-${randomUUID().slice(0, 8)}`;
let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof Error && e.stack) console.error(e.stack);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23505";
}

function isForeignKeyViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23503";
}

function isRestrictViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23001";
}

async function createUserFixture(): Promise<UserFixture> {
  const suffix = randomUUID().slice(0, 8);
  const githubLogin = `${TEST_PREFIX}-user-${suffix}`;
  const email = `${githubLogin}@example.invalid`;
  const user = await upsertGitHubUser(
    { id: `gh-${TEST_PREFIX}-${suffix}`, login: githubLogin, name: `Test ${suffix}`, email, avatar_url: null },
    { access_token: `test-token-${suffix}`, token_type: "bearer" },
  );
  return { userId: user.id, githubLogin };
}

async function createProject(ownerUserId: string, label: string): Promise<string> {
  const id = randomUUID();
  const slug = `${TEST_PREFIX}-${label}-${id.slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  await getPool().query(
    `INSERT INTO projects (id, owner_user_id, name, slug, is_bootstrap, created_at, updated_at)
     VALUES ($1,$2,$3,$4,FALSE,NOW(),NOW())`,
    [id, ownerUserId, `Test Project ${label}`, slug],
  );
  return id;
}

async function cleanup(users: UserFixture[], extraProjectIds: string[], extraConnectionIds: string[]) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userIds = users.map((u) => u.userId);
    // Defensive cleanup of fixtures by known ids/prefix in case FK paths differ.
    if (extraProjectIds.length) {
      await client.query(
        `DELETE FROM project_repository_links WHERE project_id = ANY($1::text[])`,
        [extraProjectIds],
      );
      await client.query(`DELETE FROM projects WHERE id = ANY($1::text[])`, [extraProjectIds]);
    }
    if (extraConnectionIds.length) {
      await client.query(
        `DELETE FROM project_repository_links WHERE repository_connection_id = ANY($1::text[])`,
        [extraConnectionIds],
      );
      await client.query(`DELETE FROM repository_connections WHERE id = ANY($1::text[])`, [
        extraConnectionIds,
      ]);
    }
    if (userIds.length) {
      await client.query(`DELETE FROM project_repository_links WHERE owner_user_id = ANY($1::text[])`, [userIds]);
      await client.query(`DELETE FROM repository_connections WHERE owner_user_id = ANY($1::text[])`, [userIds]);
      await client.query(`DELETE FROM projects WHERE owner_user_id = ANY($1::text[])`, [userIds]);
      await client.query(`DELETE FROM accounts WHERE user_id = ANY($1::text[])`, [userIds]);
      await client.query(`DELETE FROM sessions WHERE user_id = ANY($1::text[])`, [userIds]);
      await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds]);
    }
    await client.query("COMMIT");
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {}
  } finally {
    client.release();
  }
}

async function main() {
  if (!hasDatabase()) {
    console.error("SKIP: DATABASE_URL is not configured; Stage 1 DB tests require a real database.");
    console.error("Migration validation and DB-backed tests were not run.");
    process.exit(2);
  }

  await ensureDb();

  const users: UserFixture[] = [];
  const projectIds: string[] = [];
  const connectionIds: string[] = [];

  try {
    const alice = await createUserFixture();
    const bob = await createUserFixture();
    users.push(alice, bob);

    await check("user can have multiple repository connections", async () => {
      const c1 = await createRepositoryConnection(alice.userId, {
        provider: "github",
        providerAccountId: "acct-alice",
        githubRepoId: `${TEST_PREFIX}-repo-1`,
        repoOwner: "alice-owner",
        repoName: "repo-one",
        fullName: "alice-owner/repo-one",
        defaultBranch: "main",
        isPrivate: false,
        permissions: { admin: true },
        status: "active",
      });
      const c2 = await createRepositoryConnection(alice.userId, {
        provider: "github",
        providerAccountId: "acct-alice",
        githubRepoId: `${TEST_PREFIX}-repo-2`,
        repoOwner: "alice-owner",
        repoName: "repo-two",
        fullName: "alice-owner/repo-two",
        defaultBranch: "main",
        isPrivate: true,
        status: "active",
      });
      connectionIds.push(c1.id, c2.id);
      assert.ok(c1.id && c2.id && c1.id !== c2.id);
      assert.equal(c1.ownerUserId, alice.userId);
      const listed = await listRepositoryConnectionsForUser(alice.userId);
      assert.ok(listed.some((c) => c.id === c1.id));
      assert.ok(listed.some((c) => c.id === c2.id));
    });

    await check("project can have multiple repository connections", async () => {
      const projectId = await createProject(alice.userId, "multi-repo");
      projectIds.push(projectId);
      const c1 = await createRepositoryConnection(alice.userId, {
        githubRepoId: `${TEST_PREFIX}-repo-3`,
        repoOwner: "alice-owner",
        repoName: "repo-three",
        fullName: "alice-owner/repo-three",
      });
      const c2 = await createRepositoryConnection(alice.userId, {
        githubRepoId: `${TEST_PREFIX}-repo-4`,
        repoOwner: "alice-owner",
        repoName: "repo-four",
        fullName: "alice-owner/repo-four",
      });
      connectionIds.push(c1.id, c2.id);
      const l1 = await linkRepositoryToProject(projectId, c1.id, alice.userId);
      const l2 = await linkRepositoryToProject(projectId, c2.id, alice.userId);
      assert.ok(l1.id && l2.id);
      const links = await listRepositoryLinksForProject(projectId, alice.userId);
      assert.equal(links.filter((l) => l.projectId === projectId).length >= 2, true);
      assert.ok(links.some((l) => l.repositoryConnectionId === c1.id));
      assert.ok(links.some((l) => l.repositoryConnectionId === c2.id));
    });

    await check("repository connection can be reused across multiple projects owned by the same user", async () => {
      const p1 = await createProject(alice.userId, "reuse-a");
      const p2 = await createProject(alice.userId, "reuse-b");
      projectIds.push(p1, p2);
      const conn = await createRepositoryConnection(alice.userId, {
        githubRepoId: `${TEST_PREFIX}-repo-reuse`,
        repoOwner: "alice-owner",
        repoName: "shared-repo",
        fullName: "alice-owner/shared-repo",
      });
      connectionIds.push(conn.id);
      await linkRepositoryToProject(p1, conn.id, alice.userId);
      await linkRepositoryToProject(p2, conn.id, alice.userId);
      const projectsForConn = await listProjectsForRepositoryConnection(conn.id, alice.userId);
      const ids = projectsForConn.map((l) => l.projectId);
      assert.ok(ids.includes(p1), "connection should be linked to project 1");
      assert.ok(ids.includes(p2), "connection should be linked to project 2");
      const l1 = await listRepositoryLinksForProject(p1, alice.userId);
      const l2 = await listRepositoryLinksForProject(p2, alice.userId);
      assert.ok(l1.some((l) => l.repositoryConnectionId === conn.id));
      assert.ok(l2.some((l) => l.repositoryConnectionId === conn.id));
    });

    await check("user cannot link another user's repository to their project (DB-enforced)", async () => {
      const aliceProject = await createProject(alice.userId, "alice-owned");
      projectIds.push(aliceProject);
      const bobConn = await createRepositoryConnection(bob.userId, {
        githubRepoId: `${TEST_PREFIX}-repo-bob-private`,
        repoOwner: "bob-owner",
        repoName: "bob-repo",
        fullName: "bob-owner/bob-repo",
      });
      connectionIds.push(bobConn.id);
      await assert.rejects(
        () => linkRepositoryToProject(aliceProject, bobConn.id, alice.userId),
        (err: unknown) => isForeignKeyViolation(err),
        "cross-user link must be rejected by ownership-enforcing FK constraints",
      );
      const links = await listRepositoryLinksForProject(aliceProject, alice.userId);
      assert.ok(!links.some((l) => l.repositoryConnectionId === bobConn.id));
    });

    await check("user cannot link own repository to another user's project (DB-enforced)", async () => {
      const bobProject = await createProject(bob.userId, "bob-owned");
      projectIds.push(bobProject);
      const aliceConn = await createRepositoryConnection(alice.userId, {
        githubRepoId: `${TEST_PREFIX}-repo-alice-only`,
        repoOwner: "alice-owner",
        repoName: "alice-only",
        fullName: "alice-owner/alice-only",
      });
      connectionIds.push(aliceConn.id);
      await assert.rejects(
        () => linkRepositoryToProject(bobProject, aliceConn.id, alice.userId),
        (err: unknown) => isForeignKeyViolation(err),
        "linking into another user's project must be rejected",
      );
    });

    await check("duplicate repository connections for same user and GitHub repo are prevented", async () => {
      const githubRepoId = `${TEST_PREFIX}-repo-dup-conn`;
      const c1 = await createRepositoryConnection(alice.userId, {
        githubRepoId,
        repoOwner: "alice-owner",
        repoName: "dup-repo",
        fullName: "alice-owner/dup-repo",
      });
      connectionIds.push(c1.id);
      await assert.rejects(
        () =>
          createRepositoryConnection(alice.userId, {
            githubRepoId,
            repoOwner: "alice-owner-renamed",
            repoName: "dup-repo-renamed",
            fullName: "alice-owner-renamed/dup-repo-renamed",
          }),
        (err: unknown) => isUniqueViolation(err),
        "duplicate (owner_user_id, provider, github_repo_id) must be rejected",
      );
      const found = await findRepositoryConnectionByRepo(alice.userId, "github", githubRepoId);
      assert.equal(found?.id, c1.id);
    });

    await check("same GitHub repo can be connected by different users independently", async () => {
      const githubRepoId = `${TEST_PREFIX}-repo-shared-external`;
      const ca = await createRepositoryConnection(alice.userId, {
        githubRepoId,
        repoOwner: "org",
        repoName: "shared",
        fullName: "org/shared",
      });
      const cb = await createRepositoryConnection(bob.userId, {
        githubRepoId,
        repoOwner: "org",
        repoName: "shared",
        fullName: "org/shared",
      });
      connectionIds.push(ca.id, cb.id);
      assert.notEqual(ca.id, cb.id);
      assert.equal(ca.ownerUserId, alice.userId);
      assert.equal(cb.ownerUserId, bob.userId);
    });

    await check("duplicate project-repository relationships are prevented", async () => {
      const p = await createProject(alice.userId, "dup-link");
      projectIds.push(p);
      const conn = await createRepositoryConnection(alice.userId, {
        githubRepoId: `${TEST_PREFIX}-repo-dup-link`,
        repoOwner: "alice-owner",
        repoName: "dup-link-repo",
        fullName: "alice-owner/dup-link-repo",
      });
      connectionIds.push(conn.id);
      await linkRepositoryToProject(p, conn.id, alice.userId);
      await assert.rejects(
        () => linkRepositoryToProject(p, conn.id, alice.userId),
        (err: unknown) => isUniqueViolation(err),
        "duplicate (project_id, repository_connection_id) must be rejected",
      );
      const links = await listRepositoryLinksForProject(p, alice.userId);
      assert.equal(
        links.filter((l) => l.repositoryConnectionId === conn.id).length,
        1,
        "exactly one link should exist",
      );
    });

    await check("deleting a project preserves reusable repository connections and other project links", async () => {
      const pKeep = await createProject(alice.userId, "keep");
      const pDelete = await createProject(alice.userId, "delete");
      projectIds.push(pKeep, pDelete);
      const conn = await createRepositoryConnection(alice.userId, {
        githubRepoId: `${TEST_PREFIX}-repo-preserve`,
        repoOwner: "alice-owner",
        repoName: "preserve-repo",
        fullName: "alice-owner/preserve-repo",
      });
      connectionIds.push(conn.id);
      await linkRepositoryToProject(pKeep, conn.id, alice.userId);
      await linkRepositoryToProject(pDelete, conn.id, alice.userId);

      await getPool().query(`DELETE FROM projects WHERE id = $1 AND owner_user_id = $2`, [
        pDelete,
        alice.userId,
      ]);

      const stillThere = await getRepositoryConnectionForUser(conn.id, alice.userId);
      assert.ok(stillThere, "repository connection must remain after project deletion");
      const keepLinks = await listRepositoryLinksForProject(pKeep, alice.userId);
      assert.ok(
        keepLinks.some((l) => l.repositoryConnectionId === conn.id),
        "link to other project must remain",
      );
      const projectsForConn = await listProjectsForRepositoryConnection(conn.id, alice.userId);
      assert.ok(projectsForConn.some((l) => l.projectId === pKeep));
      assert.ok(!projectsForConn.some((l) => l.projectId === pDelete));
    });

    await check("deleting a linked repository connection is restricted (no silent corruption)", async () => {
      const p = await createProject(alice.userId, "restrict-delete");
      projectIds.push(p);
      const conn = await createRepositoryConnection(alice.userId, {
        githubRepoId: `${TEST_PREFIX}-repo-restrict`,
        repoOwner: "alice-owner",
        repoName: "restrict-repo",
        fullName: "alice-owner/restrict-repo",
      });
      connectionIds.push(conn.id);
      await linkRepositoryToProject(p, conn.id, alice.userId);
      await assert.rejects(
        () => deleteRepositoryConnection(conn.id, alice.userId),
        (err: unknown) => isRestrictViolation(err),
        "deleting a linked connection must be rejected (RESTRICT) to avoid silent corruption",
      );
      const still = await getRepositoryConnectionForUser(conn.id, alice.userId);
      assert.ok(still, "connection must still exist");
      const links = await listRepositoryLinksForProject(p, alice.userId);
      assert.ok(links.some((l) => l.repositoryConnectionId === conn.id));
      // Safe explicit removal path remains possible (Stage 2 will expose via API/UI).
      await unlinkRepositoryFromProject(p, conn.id, alice.userId);
      const deleted = await deleteRepositoryConnection(conn.id, alice.userId);
      assert.equal(deleted, true);
    });

    await check("existing multi-user project behavior remains intact (ownership isolation)", async () => {
      const aliceProject = await createProject(alice.userId, "isolation");
      projectIds.push(aliceProject);
      const resAlice = await getPool().query(
        `SELECT id FROM projects WHERE owner_user_id = $1 AND id = $2`,
        [alice.userId, aliceProject],
      );
      const resBob = await getPool().query(
        `SELECT id FROM projects WHERE owner_user_id = $1 AND id = $2`,
        [bob.userId, aliceProject],
      );
      assert.equal(resAlice.rowCount, 1, "owner must see own project");
      assert.equal(resBob.rowCount, 0, "other user must not see project");
    });

    console.log(`\n${passed} Stage 1 repository-connection checks passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } finally {
    await cleanup(users, projectIds, connectionIds);
  }
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
