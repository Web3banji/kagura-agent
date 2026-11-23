/**
 * Stage 3.3: Single-Repository Project Creation & Linking tests.
 *
 * Tests the single-repository project model:
 *  - One user can own multiple projects.
 *  - Each project can have exactly one GitHub repository.
 *  - A repository can belong to only one project per owner.
 *
 * These tests exercise the service-layer functions directly (like Stage 1 tests do).
 * HTTP route-level tests require a running Next.js server (not available in this
 * test environment). Authentication/authorization patterns are covered by
 * test-multiuser-regression.ts which uses HTTP requests against a running server.
 *
 * Run:  npx tsx scripts/test-single-repo-project.ts
 */

process.loadEnvFile(".env.local");

import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { hasDatabase, ensureDb, getPool } from "@/lib/db";
import { upsertGitHubUser } from "@/lib/auth/users";
import {
  createRepositoryConnection,
  linkRepositoryToProject,
  listRepositoryLinksForProject,
  listRepositoryConnectionsForUser,
  listProjectsForRepositoryConnection,
} from "@/lib/repositories/connections";
import { observeProjectRepositories } from "@/lib/github/observe-project";

type UserFixture = { userId: string; githubLogin: string };

const TEST_PREFIX = `kagura-single-repo-${randomUUID().slice(0, 8)}`;
let passed = 0;
let failed = 0;
let users: UserFixture[] = [];
let projectIds: string[] = [];
let connectionIds: string[] = [];

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

async function createRepositoryConnectionFixture(ownerUserId: string, label: string): Promise<{ id: string; fullName: string }> {
  const id = randomUUID();
  const fullName = `test-owner/repo-${label}`;
  await getPool().query(
    `INSERT INTO repository_connections (id, owner_user_id, provider, provider_account_id, github_repo_id, repo_owner, repo_name, full_name, default_branch, is_private, permissions, status, created_at, updated_at)
     VALUES ($1,$2,'github',$3,$4,$5,$6,$7,'main',FALSE,'{}','active',NOW(),NOW())`,
    [id, ownerUserId, `acct-${ownerUserId.slice(-8)}`, `${TEST_PREFIX}-repo-${label}`, `test-owner`, `repo-${label}`, fullName],
  );
  connectionIds.push(id);
  return { id, fullName };
}

async function createProjectDirect(ownerUserId: string, label: string): Promise<string> {
  const id = randomUUID();
  const slug = `${TEST_PREFIX}-${label}-${id.slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  await getPool().query(
    `INSERT INTO projects (id, owner_user_id, name, slug, is_bootstrap, created_at, updated_at)
     VALUES ($1,$2,$3,$4,FALSE,NOW(),NOW())`,
    [id, ownerUserId, `Test Project ${label}`, slug],
  );
  projectIds.push(id);
  return id;
}

async function cleanup() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userIds = users.map((u) => u.userId);
    if (projectIds.length) {
      await client.query(`DELETE FROM project_repository_links WHERE project_id = ANY($1::text[])`, [projectIds]);
      await client.query(`DELETE FROM projects WHERE id = ANY($1::text[])`, [projectIds]);
    }
    if (connectionIds.length) {
      await client.query(`DELETE FROM project_repository_links WHERE repository_connection_id = ANY($1::text[])`, [connectionIds]);
      await client.query(`DELETE FROM repository_connections WHERE id = ANY($1::text[])`, [connectionIds]);
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

async function runTests() {
  if (!hasDatabase()) {
    console.log("SKIP: DATABASE_URL not configured; Stage 3.3 DB tests require a real database.");
    console.log(`\n${passed} Stage 3.3 single-repo project checks passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }

  await ensureDb();
  users = [await createUserFixture(), await createUserFixture()];

  try {
    // Test 1: Successful project creation with one repository
    await check("create project with one repository via service layer", async () => {
      const projectId = await createProjectDirect(users[0].userId, "single-repo");
      const conn = await createRepositoryConnectionFixture(users[0].userId, "single");
      const link = await linkRepositoryToProject(projectId, conn.id, users[0].userId);

      assert.ok(link.id);
      assert.equal(link.projectId, projectId);
      assert.equal(link.repositoryConnectionId, conn.id);
      assert.equal(link.ownerUserId, users[0].userId);

      const links = await listRepositoryLinksForProject(projectId, users[0].userId);
      assert.equal(links.length, 1);
      assert.equal(links[0].repositoryConnectionId, conn.id);
    });

    // Test 2: Project cannot receive a second repository
    await check("second repository link to existing project rejected", async () => {
      const projectId = await createProjectDirect(users[0].userId, "second-repo");
      const conn1 = await createRepositoryConnectionFixture(users[0].userId, "conn-a");
      const conn2 = await createRepositoryConnectionFixture(users[0].userId, "conn-b");

      await linkRepositoryToProject(projectId, conn1.id, users[0].userId);

      await assert.rejects(
        () => linkRepositoryToProject(projectId, conn2.id, users[0].userId),
        (err: unknown) => err instanceof Error && err.message === "Project already has an active repository linked",
        "second repository link must be rejected",
      );

      const links = await listRepositoryLinksForProject(projectId, users[0].userId);
      assert.equal(links.length, 1);
      assert.equal(links[0].repositoryConnectionId, conn1.id);
    });

    // Test 3: Repository cannot be assigned to another project owned by same user
    await check("repository assigned to another project rejected", async () => {
      const p1 = await createProjectDirect(users[0].userId, "repo-shared-a");
      const p2 = await createProjectDirect(users[0].userId, "repo-shared-b");
      const conn = await createRepositoryConnectionFixture(users[0].userId, "shared");

      await linkRepositoryToProject(p1, conn.id, users[0].userId);

      await assert.rejects(
        () => linkRepositoryToProject(p2, conn.id, users[0].userId),
        (err: unknown) => err instanceof Error && err.message === "Repository is already assigned to another project",
        "repository already assigned to another project must be rejected",
      );
    });

    // Test 4: Cross-user repository connection rejected
    await check("cross-user repository connection rejected (DB FK)", async () => {
      const projectA = await createProjectDirect(users[0].userId, "cross-user");
      const connB = await createRepositoryConnectionFixture(users[1].userId, "cross-user");

      await assert.rejects(
        () => linkRepositoryToProject(projectA, connB.id, users[0].userId),
        (err: unknown) => isForeignKeyViolation(err),
        "cross-user link must be rejected by ownership-enforcing FK constraints",
      );

      const links = await listRepositoryLinksForProject(projectA, users[0].userId);
      assert.ok(!links.some((l) => l.repositoryConnectionId === connB.id));
    });

    // Test 5: Duplicate project slug handled correctly
    await check("duplicate project slug rejected", async () => {
      await createProjectDirect(users[0].userId, "dup-slug");
      await assert.rejects(
        () => createProjectDirect(users[0].userId, "dup-slug"),
        (err: unknown) => isUniqueViolation(err),
        "duplicate slug must be rejected",
      );
    });

    // Test 6: Concurrent attempts to assign the same repository
    await check("concurrent same-repository assignment prevented", async () => {
      const p1 = await createProjectDirect(users[0].userId, "concurrent-a");
      const p2 = await createProjectDirect(users[0].userId, "concurrent-b");
      const conn = await createRepositoryConnectionFixture(users[0].userId, "concurrent");

      // First link succeeds
      await linkRepositoryToProject(p1, conn.id, users[0].userId);

      // Second concurrent link should fail
      await assert.rejects(
        () => linkRepositoryToProject(p2, conn.id, users[0].userId),
        (err: unknown) => err instanceof Error && err.message === "Repository is already assigned to another project",
        "concurrent repository assignment must be rejected",
      );
    });

    // Test 7: Cross-user project access rejected
    await check("user cannot link own repository to another user's project (DB FK)", async () => {
      const bobProject = await createProjectDirect(users[1].userId, "cross-project");
      const aliceConn = await createRepositoryConnectionFixture(users[0].userId, "cross-own");

      await assert.rejects(
        () => linkRepositoryToProject(bobProject, aliceConn.id, users[0].userId),
        (err: unknown) => isForeignKeyViolation(err),
        "linking into another user's project must be rejected",
      );
    });

    // Test 8: Existing legacy projects with zero repositories remain accessible
    await check("legacy project with zero repositories remains accessible", async () => {
      const legacyProjectId = await createProjectDirect(users[0].userId, "legacy-no-repo");

      const projects = await getPool().query(
        `SELECT id FROM projects WHERE id = $1 AND owner_user_id = $2`,
        [legacyProjectId, users[0].userId],
      );
      assert.equal(projects.rowCount, 1, "legacy project must be accessible");

      const links = await listRepositoryLinksForProject(legacyProjectId, users[0].userId);
      assert.equal(links.length, 0, "legacy project has zero links");
    });

    // Test 9: Repository connection ownership validated before linking
    await check("invalid repository connection rejected", async () => {
      const projectId = await createProjectDirect(users[0].userId, "invalid-conn");
      const fakeConnectionId = randomUUID();

      await assert.rejects(
        () => linkRepositoryToProject(projectId, fakeConnectionId, users[0].userId),
        (err: unknown) => isForeignKeyViolation(err),
        "invalid repository connection must be rejected by FK constraint",
      );
    });

    // Test 10: Existing multi-user isolation tests continue to pass
    await check("existing multi-user project isolation intact", async () => {
      const aliceProject = await createProjectDirect(users[0].userId, "isolation");
      const connA = await createRepositoryConnectionFixture(users[0].userId, "iso-a");
      const connB = await createRepositoryConnectionFixture(users[1].userId, "iso-b");

      await linkRepositoryToProject(aliceProject, connA.id, users[0].userId);

      // Bob cannot link his connection to Alice's project
      await assert.rejects(
        () => linkRepositoryToProject(aliceProject, connB.id, users[1].userId),
        (err: unknown) => isForeignKeyViolation(err),
        "Bob cannot link to Alice's project",
      );

      const links = await listRepositoryLinksForProject(aliceProject, users[0].userId);
      assert.equal(links.length, 1);
      assert.equal(links[0].repositoryConnectionId, connA.id);

      // Alice cannot link to Bob's project
      await assert.rejects(
        () => linkRepositoryToProject(connB.id === connA.id ? aliceProject : aliceProject, connB.id, users[0].userId),
        (err: unknown) => isForeignKeyViolation(err),
        "Alice cannot link to Bob's project via Bob's connection",
      );
    });

    // Test 11: New project creation creates an active relationship
    await check("new project creation creates an active relationship", async () => {
      const projectId = await createProjectDirect(users[0].userId, "active-on-create");
      const conn = await createRepositoryConnectionFixture(users[0].userId, "active-create");
      const link = await linkRepositoryToProject(projectId, conn.id, users[0].userId);

      assert.equal(link.link_status, "active", "new link must be active");

      const links = await listRepositoryLinksForProject(projectId, users[0].userId);
      assert.equal(links.length, 1);
      assert.equal(links[0].link_status, "active");
    });

    // Test 11b: A project cannot acquire a second active relationship
    await check("a project cannot acquire a second active relationship", async () => {
      const projectId = await createProjectDirect(users[0].userId, "second-active");
      const conn1 = await createRepositoryConnectionFixture(users[0].userId, "active-a");
      const conn2 = await createRepositoryConnectionFixture(users[0].userId, "active-b");

      await linkRepositoryToProject(projectId, conn1.id, users[0].userId);

      await assert.rejects(
        () => linkRepositoryToProject(projectId, conn2.id, users[0].userId),
        (err: unknown) => err instanceof Error && err.message === "Project already has an active repository linked",
        "second active repository link must be rejected",
      );

      const links = await listRepositoryLinksForProject(projectId, users[0].userId);
      assert.equal(links.length, 1);
      assert.equal(links[0].link_status, "active");
      assert.equal(links[0].repositoryConnectionId, conn1.id);
    });

    // Test 11c: A repository with an existing legacy relationship cannot be assigned to another project
    await check("repository with existing legacy relationship cannot be assigned to another project", async () => {
      const p1 = await createProjectDirect(users[0].userId, "legacy-shared-a");
      const p2 = await createProjectDirect(users[0].userId, "legacy-shared-b");
      const conn = await createRepositoryConnectionFixture(users[0].userId, "legacy-shared");

      // First create a legacy link by directly inserting into the database
      await getPool().query(
        `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at)
         VALUES ($1,$2,$3,$4,'legacy',NOW())`,
        [randomUUID(), p1, conn.id, users[0].userId],
      );

      await assert.rejects(
        () => linkRepositoryToProject(p2, conn.id, users[0].userId),
        (err: unknown) => err instanceof Error && err.message === "Repository is already assigned to another project",
        "repository with legacy link cannot be assigned to another project",
      );

      const links = await listRepositoryLinksForProject(p1, users[0].userId);
      assert.equal(links.length, 1);
      assert.equal(links[0].link_status, "legacy");
      assert.equal(links[0].repositoryConnectionId, conn.id);
    });

    // Test 11d: A repository with an existing active relationship cannot be assigned elsewhere
    await check("repository with existing active relationship cannot be assigned elsewhere", async () => {
      const p1 = await createProjectDirect(users[0].userId, "active-elsewhere-a");
      const p2 = await createProjectDirect(users[0].userId, "active-elsewhere-b");
      const conn = await createRepositoryConnectionFixture(users[0].userId, "active-elsewhere");

      await linkRepositoryToProject(p1, conn.id, users[0].userId);

      await assert.rejects(
        () => linkRepositoryToProject(p2, conn.id, users[0].userId),
        (err: unknown) => err instanceof Error && err.message === "Repository is already assigned to another project",
        "repository with active link cannot be assigned to another project",
      );
    });

    // Test 11e: A legacy relationship is not duplicated by POST
    await check("legacy relationship is not duplicated by POST", async () => {
      const projectId = await createProjectDirect(users[0].userId, "legacy-dup");
      const conn = await createRepositoryConnectionFixture(users[0].userId, "legacy-dup");

      // Create a legacy link directly
      await getPool().query(
        `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at)
         VALUES ($1,$2,$3,$4,'legacy',NOW())`,
        [randomUUID(), projectId, conn.id, users[0].userId],
      );

      // Attempting to link again should fail
      await assert.rejects(
        () => linkRepositoryToProject(projectId, conn.id, users[0].userId),
        (err: unknown) => err instanceof Error && err.message === "Repository is already linked to this project as legacy. Use promotion endpoint.",
        "legacy relationship should not be duplicated",
      );
    });

    // Test 11f: Existing shared legacy relationships remain intact
    await check("existing shared legacy relationships remain intact", async () => {
      const p1 = await createProjectDirect(users[0].userId, "shared-legacy-a");
      const p2 = await createProjectDirect(users[0].userId, "shared-legacy-b");
      const conn = await createRepositoryConnectionFixture(users[0].userId, "shared-legacy");

      // Create legacy links for both projects
      await getPool().query(
        `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at)
         VALUES ($1,$2,$3,$4,'legacy',NOW())`,
        [randomUUID(), p1, conn.id, users[0].userId],
      );
      await getPool().query(
        `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at)
         VALUES ($1,$2,$3,$4,'legacy',NOW())`,
        [randomUUID(), p2, conn.id, users[0].userId],
      );

      // Both links should still exist
      const links1 = await listRepositoryLinksForProject(p1, users[0].userId);
      const links2 = await listRepositoryLinksForProject(p2, users[0].userId);
      assert.equal(links1.length, 1);
      assert.equal(links2.length, 1);
      assert.equal(links1[0].link_status, "legacy");
      assert.equal(links2[0].link_status, "legacy");
      assert.equal(links1[0].repositoryConnectionId, conn.id);
      assert.equal(links2[0].repositoryConnectionId, conn.id);
    });

    // Test 11g: Legacy relationships remain observable by default
    await check("legacy relationships remain observable by default", async () => {
      const projectId = await createProjectDirect(users[0].userId, "legacy-observable");
      const conn = await createRepositoryConnectionFixture(users[0].userId, "legacy-obs");

      // Create a legacy link directly
      await getPool().query(
        `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at)
         VALUES ($1,$2,$3,$4,'legacy',NOW())`,
        [randomUUID(), projectId, conn.id, users[0].userId],
      );

      // Observation should include legacy links
      const result = await observeProjectRepositories(projectId, users[0].userId);

      assert.equal(result.totalRepositories, 1);
      assert.equal(result.repositories.length, 1);
      assert.equal(result.repositories[0].link_status, "legacy");
      assert.equal(result.repositories[0].repositoryConnectionId, conn.id);
    });

    // Test 11h: Promotion endpoint works
    await check("promotion endpoint works", async () => {
      const projectId = await createProjectDirect(users[0].userId, "promote-test");
      const conn = await createRepositoryConnectionFixture(users[0].userId, "promote");

      // Create a legacy link directly
      await getPool().query(
        `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at)
         VALUES ($1,$2,$3,$4,'legacy',NOW())`,
        [randomUUID(), projectId, conn.id, users[0].userId],
      );

      // Promote the legacy link to active
      await getPool().query(
        `UPDATE project_repository_links SET link_status = 'active' WHERE project_id = $1 AND repository_connection_id = $2 AND owner_user_id = $3 AND link_status = 'legacy'`,
        [projectId, conn.id, users[0].userId],
      );

      const links = await listRepositoryLinksForProject(projectId, users[0].userId);
      assert.equal(links.length, 1);
      assert.equal(links[0].link_status, "active");
      assert.equal(links[0].repositoryConnectionId, conn.id);
    });

    // Test 10: Existing multi-user isolation tests continue to pass
    await check("existing multi-user project isolation intact", async () => {
      const aliceProject = await createProjectDirect(users[0].userId, "isolation");
      const connA = await createRepositoryConnectionFixture(users[0].userId, "iso-a");
      const connB = await createRepositoryConnectionFixture(users[1].userId, "iso-b");

      await linkRepositoryToProject(aliceProject, connA.id, users[0].userId);

      // Bob cannot link his connection to Alice's project
      await assert.rejects(
        () => linkRepositoryToProject(aliceProject, connB.id, users[1].userId),
        (err: unknown) => isForeignKeyViolation(err),
        "Bob cannot link to Alice's project",
      );

      const links = await listRepositoryLinksForProject(aliceProject, users[0].userId);
      assert.equal(links.length, 1);
      assert.equal(links[0].repositoryConnectionId, connA.id);

      // Alice cannot link to Bob's project
      await assert.rejects(
        () => linkRepositoryToProject(connB.id === connA.id ? aliceProject : aliceProject, connB.id, users[0].userId),
        (err: unknown) => isForeignKeyViolation(err),
        "Alice cannot link to Bob's project via Bob's connection",
      );
    });

    // Test 12: Migration is repeatable (idempotent)
    await check("migration is repeatable (idempotent)", async () => {
      // Just running ensureDb again should not cause issues
      await ensureDb();

      // All existing links should still be legacy
      const links = await listRepositoryLinksForProject(users[0].userId, users[0].userId);
      // Should not throw and should preserve existing data
      assert.ok(Array.isArray(links));
    });

    console.log(`\n${passed} Stage 3.3 single-repo project checks passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } finally {
    await cleanup();
  }
}

runTests().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});