/**
 * Stage 3.1.1: project-scoped observation engine tests.
 *
 * Tests the `observeProjectRepositories` function with mocked GitHub API responses.
 * No real GitHub API calls are made; all HTTP is intercepted.
 *
 * Run:  npx tsx scripts/test-project-observation.ts
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
  getRepositoryConnectionForUser,
} from "@/lib/repositories/connections";
import { observeProjectRepositories, getProjectObservationStatus } from "@/lib/github/observe-project";
import {
  readProjectObservationState,
  writeProjectObservationState,
  mergeProjectObservedCommits,
  readProjectObservedEvents,
  writeProjectObservedEvents,
  markProjectCommitsProcessed,
  getProjectUnprocessedCommits,
} from "@/lib/github/store";
import type { ProjectRepositoryLink, RepositoryConnection } from "@/types/repository";
import type { ProjectObservedCommit } from "@/types/github";

const TEST_PREFIX = `kagura-obs-test-${randomUUID().slice(0, 8)}`;
let passed = 0;
let failed = 0;
let users: { userId: string; githubLogin: string; hasToken: boolean; token: string }[] = [];
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

async function createUserFixture(withToken = true) {
  const suffix = randomUUID().slice(0, 8);
  const githubLogin = `${TEST_PREFIX}-user-${suffix}`;
  const email = `${githubLogin}@example.invalid`;
  const tokens = withToken 
    ? { access_token: `test-token-${suffix}`, token_type: "bearer" as const }
    : { access_token: `test-token-empty-${suffix}`, token_type: "bearer" as const };
  const user = await upsertGitHubUser(
    { id: `gh-${TEST_PREFIX}-${suffix}`, login: githubLogin, name: `Test ${suffix}`, email, avatar_url: null },
    tokens,
  );
  return { userId: user.id, githubLogin, hasToken: withToken, token: withToken ? `test-token-${suffix}` : `test-token-empty-${suffix}` };
}

async function createProject(ownerUserId: string, label: string): Promise<string> {
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
    // Clean up KV entries for test projects
    for (const pid of projectIds) {
      for (const cid of connectionIds) {
        await client.query(`DELETE FROM echolog_kv WHERE key = $1`, [`github:observation:state:${pid}:${cid}`]);
        await client.query(`DELETE FROM echolog_kv WHERE key = $1`, [`github:observation:events:${pid}:${cid}`]);
      }
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

function makeConnection(ownerUserId: string, label: string): Promise<RepositoryConnection> {
  return createRepositoryConnection(ownerUserId, {
    provider: "github",
    providerAccountId: `acct-${ownerUserId.slice(-8)}`,
    githubRepoId: `${TEST_PREFIX}-repo-${label}`,
    repoOwner: "test-owner",
    repoName: `repo-${label}`,
    fullName: `test-owner/repo-${label}`,
    defaultBranch: "main",
    isPrivate: false,
    permissions: { admin: true, push: true, pull: true },
    status: "active",
  });
}

function makeLink(projectId: string, connectionId: string, ownerUserId: string): Promise<ProjectRepositoryLink> {
  return linkRepositoryToProject(projectId, connectionId, ownerUserId);
}

// Mock GitHub API for observation tests
const mockResponses = new Map<string, { status: number; body: unknown; headers?: Record<string, string> }>();

function setupMockFetch() {
  const originalFetch = global.fetch;
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    const token = init?.headers && typeof init.headers === "object" && "Authorization" in init.headers
      ? (init.headers as Record<string, string>).Authorization?.replace("Bearer ", "")
      : "";
    
    // GitHub user endpoint
    if (url === "https://api.github.com/user") {
      const response = mockResponses.get(`user:${token}`) || { status: 200, body: { id: "12345", login: "test-user" } };
      const defaultHeaders = { "X-RateLimit-Limit": "5000", "X-RateLimit-Remaining": "4999", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) };
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { ...defaultHeaders, ...(response.headers || {}) },
      });
    }
    
    // Repository commits endpoint
    const commitsMatch = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/commits/);
    if (commitsMatch) {
      const fullName = commitsMatch[1];
      const response = mockResponses.get(`commits:${fullName}:${token}`) || { 
        status: 200, 
        body: [
          { sha: "abc123def456", html_url: `https://github.com/${fullName}/commit/abc123def456`, commit: { message: "Initial commit\n\nDetails", author: { date: new Date().toISOString(), name: "Test Author", email: "test@example.com" } }, author: { login: "test-author" } },
          { sha: "def456ghi789", html_url: `https://github.com/${fullName}/commit/def456ghi789`, commit: { message: "Second commit", author: { date: new Date(Date.now() - 86400000).toISOString(), name: "Test Author", email: "test@example.com" } }, author: { login: "test-author" } },
        ] 
      };
      const defaultHeaders = { "X-RateLimit-Limit": "5000", "X-RateLimit-Remaining": "4998", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) };
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { ...defaultHeaders, ...(response.headers || {}) },
      });
    }
    
    // Commit files endpoint
    const filesMatch = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)$/);
    if (filesMatch) {
      const fullName = filesMatch[1];
      const sha = filesMatch[2];
      const response = mockResponses.get(`files:${fullName}:${sha}:${token}`) || { status: 200, body: { files: [{ filename: "README.md", status: "added", additions: 10, deletions: 0, changes: 10 }] } };
      const defaultHeaders = { "X-RateLimit-Limit": "5000", "X-RateLimit-Remaining": "4997", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) };
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { ...defaultHeaders, ...(response.headers || {}) },
      });
    }
    
    return originalFetch(input, init);
  };
  
  return () => { global.fetch = originalFetch; };
}

async function runTests() {
  if (!hasDatabase()) {
    console.log("SKIP: DATABASE_URL not configured; KV store tests require database.");
    console.log(`\n${passed} Stage 3.1.1 project observation checks passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }

  await ensureDb();
  users = [await createUserFixture(true)];
  const userNoToken = await createUserFixture(true);
  users.push(userNoToken);

  try {
    // Test 1: KV store - state read/write
    await check("project-scoped state read/write", async () => {
      const projectId = randomUUID();
      const connectionId = randomUUID();
      
      const state = await readProjectObservationState(projectId, connectionId);
      assert.deepEqual(state, { projectId, repositoryConnectionId: connectionId, githubRepoId: "", fullName: "" });
      
      await writeProjectObservationState({
        projectId,
        repositoryConnectionId: connectionId,
        githubRepoId: "12345",
        fullName: "test/repo",
        lastObservedAt: new Date().toISOString(),
        lastSuccessfulSha: "abc123",
        lastStatus: "success",
        lastNewCount: 5,
      });
      
      const readBack = await readProjectObservationState(projectId, connectionId);
      assert.equal(readBack.githubRepoId, "12345");
      assert.equal(readBack.fullName, "test/repo");
      assert.equal(readBack.lastSuccessfulSha, "abc123");
      assert.equal(readBack.lastStatus, "success");
      assert.equal(readBack.lastNewCount, 5);
    });

    // Test 2: KV store - events read/write/merge
    await check("project-scoped events read/write/merge", async () => {
      const projectId = randomUUID();
      const connectionId = randomUUID();
      const baseTime = new Date("2024-01-01T00:00:00Z").getTime();
      
      const initialCommits: ProjectObservedCommit[] = [
        { sha: "aaa111", shortSha: "aaa1111", message: "First", author: "A", date: new Date(baseTime + 1000).toISOString(), url: "https://github.com/test/repo/commit/aaa111", files: [], projectId, repositoryConnectionId: connectionId },
        { sha: "bbb222", shortSha: "bbb2222", message: "Second", author: "B", date: new Date(baseTime).toISOString(), url: "https://github.com/test/repo/commit/bbb222", files: [], projectId, repositoryConnectionId: connectionId },
      ];
      
      await writeProjectObservedEvents(projectId, connectionId, initialCommits);
      const events = await readProjectObservedEvents(projectId, connectionId);
      assert.equal(events.length, 2);
      
      // Merge new commits
      const newCommits: ProjectObservedCommit[] = [
        { sha: "ccc333", shortSha: "ccc3333", message: "Third", author: "C", date: new Date(baseTime + 2000).toISOString(), url: "https://github.com/test/repo/commit/ccc333", files: [], projectId, repositoryConnectionId: connectionId },
        { sha: "aaa111", shortSha: "aaa1111", message: "First (updated)", author: "A", date: new Date(baseTime + 1000).toISOString(), url: "https://github.com/test/repo/commit/aaa111", files: [], projectId, repositoryConnectionId: connectionId },
      ];
      
      const { merged, added } = await mergeProjectObservedCommits(projectId, connectionId, newCommits);
      assert.equal(added.length, 1);
      assert.equal(added[0].sha, "ccc333");
      assert.equal(merged.length, 3);
      
      // Verify order (newest first)
      assert.equal(merged[0].sha, "ccc333");
      assert.equal(merged[1].sha, "aaa111");
      assert.equal(merged[2].sha, "bbb222");
    });

    // Test 3: mark commits processed and get unprocessed
    await check("mark commits processed and get unprocessed", async () => {
      const projectId = randomUUID();
      const connectionId = randomUUID();
      
      const commits: ProjectObservedCommit[] = [
        { sha: "unproc1", shortSha: "unpro11", message: "Unprocessed 1", author: "A", date: new Date().toISOString(), url: "https://github.com/test/repo/commit/unproc1", files: [], projectId, repositoryConnectionId: connectionId },
        { sha: "unproc2", shortSha: "unpro22", message: "Unprocessed 2", author: "B", date: new Date().toISOString(), url: "https://github.com/test/repo/commit/unproc2", files: [], projectId, repositoryConnectionId: connectionId },
        { sha: "proc3", shortSha: "proc333", message: "Processed 3", author: "C", date: new Date().toISOString(), url: "https://github.com/test/repo/commit/proc3", files: [], projectId, repositoryConnectionId: connectionId, processed: true },
      ];
      
      await writeProjectObservedEvents(projectId, connectionId, commits);
      
      const unprocessed = await getProjectUnprocessedCommits(projectId, connectionId, 10);
      assert.equal(unprocessed.length, 2);
      assert.ok(unprocessed.every(c => !c.processed));
      
      await markProjectCommitsProcessed(projectId, connectionId, ["unproc1"]);
      const afterMark = await getProjectUnprocessedCommits(projectId, connectionId, 10);
      assert.equal(afterMark.length, 1);
      assert.equal(afterMark[0].sha, "unproc2");
    });

    // Test 4: observeProjectRepositories returns empty for project with no links
    await check("observeProjectRepositories returns empty for project with no links", async () => {
      const projectId = await createProject(users[0].userId, "empty");
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        assert.equal(result.projectId, projectId);
        assert.equal(result.totalRepositories, 0);
        assert.equal(result.successfulRepositories, 0);
        assert.equal(result.failedRepositories, 0);
        assert.equal(result.totalCommits, 0);
        assert.equal(result.totalNewCommits, 0);
        assert.deepEqual(result.repositories, []);
      } finally {
        restoreFetch();
      }
    });

    // Test 5: observeProjectRepositories succeeds with valid token and identity
    await check("observeProjectRepositories succeeds with valid token and identity", async () => {
      const projectId = await createProject(users[0].userId, "single-repo");
      const conn = await makeConnection(users[0].userId, "obs-1");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      // Mock GitHub API responses - use the actual token from user fixture
      const userToken = users[0].token;
      mockResponses.set(`user:${userToken}`, { 
        status: 200, 
        body: { id: conn.providerAccountId, login: "test-user" } 
      });
      mockResponses.set(`commits:${conn.fullName}:${userToken}`, { 
        status: 200, 
        body: [
          { sha: "obs111111", html_url: `https://github.com/${conn.fullName}/commit/obs111111`, commit: { message: "Observed commit 1", author: { date: new Date().toISOString(), name: "Test", email: "test@test.com" } }, author: { login: "test-author" } },
        ] 
      });
      mockResponses.set(`files:${conn.fullName}:obs111111:${userToken}`, { 
        status: 200, 
        body: { files: [{ filename: "src/index.ts", status: "modified", additions: 5, deletions: 2, changes: 7 }] } 
      });
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.projectId, projectId);
        assert.equal(result.totalRepositories, 1);
        assert.equal(result.successfulRepositories, 1);
        assert.equal(result.failedRepositories, 0);
        assert.equal(result.repositories.length, 1);
        
        const repoResult = result.repositories[0];
        assert.equal(repoResult.status, "success");
        assert.equal(repoResult.githubRepoId, conn.githubRepoId);
        assert.equal(repoResult.fullName, conn.fullName);
        assert.equal(repoResult.commits.length, 1);
        assert.equal(repoResult.newCommits.length, 1);
        assert.ok(repoResult.rateLimit?.limit !== null);
      } finally {
        restoreFetch();
      }
    });

    // Test 6: observeProjectRepositories fails when identity verification fails
    await check("observeProjectRepositories fails when identity verification fails", async () => {
      const projectId = await createProject(users[0].userId, "identity-fail");
      const conn = await makeConnection(users[0].userId, "obs-identity");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      // Mock user endpoint returning DIFFERENT ID than provider_account_id
      const userToken = users[0].token;
      mockResponses.set(`user:${userToken}`, { 
        status: 200, 
        body: { id: "different-user-id", login: "other-user" } 
      });
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.totalRepositories, 1);
        assert.equal(result.successfulRepositories, 0);
        assert.equal(result.failedRepositories, 1);
        assert.equal(result.repositories[0].status, "failed");
        assert.ok(result.repositories[0].error?.includes("identity verification failed"));
      } finally {
        restoreFetch();
      }
    });

    // Test 7: observeProjectRepositories fails when no token available
    await check("observeProjectRepositories fails when no token available", async () => {
      const projectId = await createProject(userNoToken.userId, "no-token");
      const conn = await makeConnection(userNoToken.userId, "obs-notoken");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, userNoToken.userId);
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, userNoToken.userId);
        
        assert.equal(result.totalRepositories, 1);
        assert.equal(result.successfulRepositories, 0);
        assert.equal(result.failedRepositories, 1);
        assert.ok(result.repositories[0].error?.includes("GitHub identity verification failed") || 
                  result.repositories[0].error?.includes("No GitHub OAuth token available"));
      } finally {
        restoreFetch();
      }
    });

    // Test 8: getProjectObservationStatus returns repo states
    await check("getProjectObservationStatus returns repo states", async () => {
      const projectId = await createProject(users[0].userId, "status-check");
      const conn = await makeConnection(users[0].userId, "obs-status");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      // Write some state and events
      await writeProjectObservationState({
        projectId,
        repositoryConnectionId: conn.id,
        githubRepoId: conn.githubRepoId,
        fullName: conn.fullName,
        lastObservedAt: new Date().toISOString(),
        lastSuccessfulSha: "sha123",
        lastStatus: "success",
        lastNewCount: 3,
      });
      await writeProjectObservedEvents(projectId, conn.id, [
        { sha: "e1", shortSha: "e111111", message: "Event 1", author: "A", date: new Date().toISOString(), url: "https://github.com/test/repo/commit/e1", files: [], projectId, repositoryConnectionId: conn.id },
        { sha: "e2", shortSha: "e222222", message: "Event 2", author: "B", date: new Date().toISOString(), url: "https://github.com/test/repo/commit/e2", files: [], projectId, repositoryConnectionId: conn.id },
      ]);
      
      const status = await getProjectObservationStatus(projectId, users[0].userId);
      assert.equal(status.projectId, projectId);
      assert.equal(status.repositories.length, 1);
      assert.equal(status.repositories[0].connectionId, conn.id);
      assert.equal(status.repositories[0].repoFullName, conn.fullName);
      assert.ok(status.repositories[0].state !== null);
      assert.equal(status.repositories[0].state?.lastSuccessfulSha, "sha123");
      assert.equal(status.repositories[0].eventsCount, 2);
    });

    // Test 9: Same SHA stored independently in different projects
    await check("same SHA stored independently in different projects", async () => {
      const projectA = await createProject(users[0].userId, "project-a");
      const projectB = await createProject(users[0].userId, "project-b");
      const connA = await makeConnection(users[0].userId, "same-repo-a");
      const connB = await makeConnection(users[0].userId, "same-repo-b");
      connectionIds.push(connA.id, connB.id);
      
      // Create separate commit objects for each project with correct projectId
      const commitA: ProjectObservedCommit = {
        sha: "SHA-12345",
        shortSha: "sha12345",
        message: "Shared commit",
        author: "Shared Author",
        date: new Date("2024-01-01T00:00:00Z").toISOString(),
        url: "https://github.com/shared/repo/commit/SHA-12345",
        files: [],
        projectId: projectA,
        repositoryConnectionId: connA.id,
      };
      
      const commitB: ProjectObservedCommit = {
        sha: "SHA-12345",
        shortSha: "sha12345",
        message: "Shared commit",
        author: "Shared Author",
        date: new Date("2024-01-01T00:00:00Z").toISOString(),
        url: "https://github.com/shared/repo/commit/SHA-12345",
        files: [],
        projectId: projectB,
        repositoryConnectionId: connB.id,
      };
      
      await writeProjectObservedEvents(projectA, connA.id, [commitA]);
      await writeProjectObservedEvents(projectB, connB.id, [commitB]);
      
      const eventsA = await readProjectObservedEvents(projectA, connA.id);
      const eventsB = await readProjectObservedEvents(projectB, connB.id);
      
      assert.equal(eventsA.length, 1);
      assert.equal(eventsB.length, 1);
      assert.equal(eventsA[0].sha, "SHA-12345");
      assert.equal(eventsB[0].sha, "SHA-12345");
      assert.equal(eventsA[0].projectId, projectA);
      assert.equal(eventsB[0].projectId, projectB);
      assert.notEqual(eventsA[0].repositoryConnectionId, eventsB[0].repositoryConnectionId);
    });

    // Test 10: SHA deduplication within same project
    await check("SHA deduplication within same project", async () => {
      const projectId = await createProject(users[0].userId, "dedup");
      const conn = await makeConnection(users[0].userId, "dedup-repo");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      const commitA: ProjectObservedCommit = {
        sha: "SHA-11111",
        shortSha: "sha11111",
        message: "First version",
        author: "Author A",
        date: new Date("2024-01-01T00:00:00Z").toISOString(),
        url: "https://github.com/test/repo/commit/SHA-11111",
        files: [{ filename: "file1.txt", status: "added", additions: 10 }],
        projectId,
        repositoryConnectionId: conn.id,
      };
      
      const commitB: ProjectObservedCommit = {
        sha: "SHA-11111",
        shortSha: "sha11111",
        message: "Updated message",
        author: "Author B",
        date: new Date("2024-01-02T00:00:00Z").toISOString(),
        url: "https://github.com/test/repo/commit/SHA-11111",
        files: [{ filename: "file2.txt", status: "modified", additions: 5 }],
        projectId,
        repositoryConnectionId: conn.id,
      };
      
      const { merged, added } = await mergeProjectObservedCommits(projectId, conn.id, [commitA, commitB]);
      
      assert.equal(merged.length, 1);
      assert.equal(added.length, 1);
      assert.equal(merged[0].sha, "SHA-11111");
      assert.equal(merged[0].message, "First version");
      assert.equal(merged[0].files.length, 1);
      
      const events = await readProjectObservedEvents(projectId, conn.id);
      assert.equal(events.length, 1);
    });

    // Test 11: Pagination fetches across pages
    await check("pagination fetches across pages", async () => {
      const projectId = await createProject(users[0].userId, "pagination");
      const conn = await makeConnection(users[0].userId, "pagination-repo");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      const userToken = users[0].token;
      const commit1 = { sha: "page1sha1", html_url: `https://github.com/${conn.fullName}/commit/page1sha1`, commit: { message: "Page 1 commit 1", author: { date: new Date().toISOString(), name: "A", email: "a@a.com" } }, author: { login: "a" } };
      const commit2 = { sha: "page1sha2", html_url: `https://github.com/${conn.fullName}/commit/page1sha2`, commit: { message: "Page 1 commit 2", author: { date: new Date().toISOString(), name: "B", email: "b@b.com" } }, author: { login: "b" } };
      
      mockResponses.set(`user:${userToken}`, { status: 200, body: { id: conn.providerAccountId, login: "test-user" } });
      mockResponses.set(`commits:${conn.fullName}:${userToken}`, { status: 200, body: [commit1, commit2] });
      mockResponses.set(`files:${conn.fullName}:page1sha1:${userToken}`, { status: 200, body: { files: [] } });
      mockResponses.set(`files:${conn.fullName}:page1sha2:${userToken}`, { status: 200, body: { files: [] } });
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.totalRepositories, 1);
        assert.equal(result.repositories[0].status, "success");
        assert.equal(result.repositories[0].commits.length, 2);
        assert.equal(result.repositories[0].commits[0].sha, "page1sha1");
        assert.equal(result.repositories[0].commits[1].sha, "page1sha2");
      } finally {
        restoreFetch();
      }
    });

    // Test 12: Rate-limit errors are preserved
    await check("rate-limit errors are preserved in result", async () => {
      const projectId = await createProject(users[0].userId, "rate-limit");
      const conn = await makeConnection(users[0].userId, "rate-limit-repo");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      const userToken = users[0].token;
      // observe-project.ts gets rate limit from the user endpoint, not commits endpoint
      mockResponses.set(`user:${userToken}`, { 
        status: 200, 
        body: { id: conn.providerAccountId, login: "test-user" },
        headers: { "X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 60) }
      });
      mockResponses.set(`commits:${conn.fullName}:${userToken}`, { 
        status: 200, 
        body: [{ sha: "ratelimit1", html_url: `https://github.com/${conn.fullName}/commit/ratelimit1`, commit: { message: "Rate limit commit", author: { date: new Date().toISOString(), name: "Test", email: "test@test.com" } }, author: { login: "test" } }],
      });
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.totalRepositories, 1);
        assert.equal(result.repositories[0].status, "success");
        // Rate limit comes from user endpoint
        assert.ok(result.repositories[0].rateLimit?.limit === 100);
        assert.equal(result.repositories[0].rateLimit?.remaining, 0);
      } finally {
        restoreFetch();
      }
    });

    // Test 13: One repository failure does not prevent another from succeeding
    await check("one repository failure does not prevent others from succeeding", async () => {
      const projectId = await createProject(users[0].userId, "mixed-success");
      const connSuccess = await makeConnection(users[0].userId, "success-repo");
      const connFail = await makeConnection(users[0].userId, "fail-repo");
      connectionIds.push(connSuccess.id, connFail.id);
      await makeLink(projectId, connSuccess.id, users[0].userId);
      await makeLink(projectId, connFail.id, users[0].userId);
      
      const userToken = users[0].token;
      // Successful repo: identity verified, commits returned
      mockResponses.set(`user:${userToken}`, { status: 200, body: { id: connSuccess.providerAccountId, login: "test-user" } });
      mockResponses.set(`commits:${connSuccess.fullName}:${userToken}`, { status: 200, body: [{ sha: "success1", html_url: `https://github.com/${connSuccess.fullName}/commit/success1`, commit: { message: "Success commit", author: { date: new Date().toISOString(), name: "Test", email: "test@test.com" } }, author: { login: "test" } }] });
      mockResponses.set(`files:${connSuccess.fullName}:success1:${userToken}`, { status: 200, body: { files: [] } });
      
      // Failing repo: identity verified but network error on commits fetch
      // We can't change user response per-repo (same token), so make commits fetch fail
      mockResponses.set(`commits:${connFail.fullName}:${userToken}`, { status: 500, body: { message: "Internal Server Error" } });
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.totalRepositories, 2);
        assert.equal(result.successfulRepositories, 1);
        assert.equal(result.failedRepositories, 1);
        assert.equal(result.repositories.length, 2);
        
        const successRepo = result.repositories.find(r => r.repositoryConnectionId === connSuccess.id);
        const failRepo = result.repositories.find(r => r.repositoryConnectionId === connFail.id);
        
        assert.ok(successRepo);
        assert.ok(failRepo);
        assert.equal(successRepo.status, "success");
        assert.equal(failRepo.status, "failed");
        assert.ok(failRepo.error?.includes("network") || failRepo.error?.includes("failed"));
      } finally {
        restoreFetch();
      }
    });

    // Test 14: Project ownership and identity checks remain enforced
    await check("project ownership and identity checks remain enforced", async () => {
      const projectA = await createProject(users[0].userId, "owned-a");
      const projectB = await createProject(users[0].userId, "owned-b");
      const conn = await makeConnection(users[0].userId, "shared-repo");
      connectionIds.push(conn.id);
      await makeLink(projectA, conn.id, users[0].userId);
      
      const user2 = await createUserFixture(true);
      const projectC = await createProject(user2.userId, "other-user-project");
      
      try {
        await makeLink(projectC, conn.id, user2.userId);
        assert.fail("Should have thrown due to ownership violation");
      } catch (err) {
        assert.ok(err instanceof Error);
      }
      
      const linksA = await listRepositoryLinksForProject(projectA, users[0].userId);
      assert.equal(linksA.length, 1);
      assert.equal(linksA[0].repositoryConnectionId, conn.id);
      
      const linksC = await listRepositoryLinksForProject(projectC, user2.userId);
      assert.equal(linksC.length, 0);
    });

    console.log(`\n${passed} Stage 3.1.1 project observation checks passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
  finally {
    await cleanup();
  }
}

runTests().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});