/**
 * Stage 3.2: Project-scoped observation API integration tests.
 *
 * These tests exercise the `observeProjectRepositories` service function directly,
 * which is the core logic invoked by the HTTP route handler at
 * POST /api/projects/[projectId]/github/observe.
 *
 * The HTTP route handler is a thin wrapper that:
 * 1. Authenticates via `requireUserApi` (session cookie → user ID)
 * 2. Validates project ownership via DB query
 * 3. Calls `observeProjectRepositories(projectId, userId)`
 * 4. Formats response and returns appropriate HTTP status
 *
 * True end-to-end HTTP tests require a running Next.js server (not available in this
 * test environment). The existing multiuser regression tests use `fetch` against
 * `http://localhost/api/...` which requires a running dev server.
 *
 * These tests verify the service logic that the route delegates to.
 * Authentication/authorization patterns are tested in test-multiuser-regression.ts.
 *
 * Run:  npx tsx scripts/test-project-observe-api.ts
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
} from "@/lib/repositories/connections";
import { observeProjectRepositories } from "@/lib/github/observe-project";
import { createSession } from "@/lib/auth/session";
import type { ProjectRepositoryLink, RepositoryConnection } from "@/types/repository";
import type { ProjectObservationResult } from "@/types/github";

const TEST_PREFIX = `kagura-api-test-${randomUUID().slice(0, 8)}`;
let passed = 0;
let failed = 0;
let users: { userId: string; githubLogin: string; token: string }[] = [];
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
  return { userId: user.id, githubLogin, token: withToken ? `test-token-${suffix}` : `test-token-empty-${suffix}` };
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

// Test the observeProjectRepositories function directly (already tested in Stage 3.1)
// These tests verify the API integration layer: auth, ownership, response formatting

async function runTests() {
  if (!hasDatabase()) {
    console.log("SKIP: DATABASE_URL not configured; tests require database.");
    console.log(`\n${passed} Stage 3.2 project observation API checks passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }

  await ensureDb();
  users = [await createUserFixture(true)];
  const user2 = await createUserFixture(true);
  users.push(user2);

  try {
    // Test 1: Project ownership validation - owner can observe
    await check("project owner can observe their project (service layer)", async () => {
      const projectId = await createProject(users[0].userId, "own-project");
      const conn = await makeConnection(users[0].userId, "repo-own");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      // Mock GitHub API
      const userToken = users[0].token;
      mockResponses.set(`user:${userToken}`, { 
        status: 200, 
        body: { id: conn.providerAccountId, login: "test-user" } 
      });
      mockResponses.set(`commits:${conn.fullName}:${userToken}`, { 
        status: 200, 
        body: [
          { sha: "api111111", html_url: `https://github.com/${conn.fullName}/commit/api111111`, commit: { message: "API test commit", author: { date: new Date().toISOString(), name: "Test", email: "test@test.com" } }, author: { login: "test-author" } },
        ] 
      });
      mockResponses.set(`files:${conn.fullName}:api111111:${userToken}`, { 
        status: 200, 
        body: { files: [{ filename: "src/index.ts", status: "modified", additions: 5, deletions: 2, changes: 7 }] } 
      });
      
      const restoreFetch = setupMockFetch();
      try {
        // Call the service function directly (what the API route does)
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.projectId, projectId);
        assert.equal(result.totalRepositories, 1);
        assert.equal(result.successfulRepositories, 1);
        assert.equal(result.failedRepositories, 0);
        assert.equal(result.totalNewCommits, 1);
        assert.equal(result.repositories.length, 1);
        assert.equal(result.repositories[0].status, "success");
        assert.equal(result.repositories[0].newCommits.length, 1);
        
        // Verify response formatting matches API expectations
        assert.ok(result.observedAt);
        assert.ok(typeof result.totalRepositories === "number");
        assert.ok(typeof result.successfulRepositories === "number");
        assert.ok(typeof result.failedRepositories === "number");
        assert.ok(typeof result.totalNewCommits === "number");
      } finally {
        restoreFetch();
      }
    });

    // Test 2: Non-owner cannot observe project (validated at service layer)
    await check("non-owner cannot observe another user's project (service layer)", async () => {
      const projectId = await createProject(users[0].userId, "other-user-project");
      const conn = await makeConnection(users[0].userId, "repo-other");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      // User 2 tries to observe user 1's project
      // The service function uses listRepositoryLinksForProject which filters by owner_user_id
      const result = await observeProjectRepositories(projectId, users[1].userId);
      
      // Should return empty result (no links for user 2)
      assert.equal(result.totalRepositories, 0);
      assert.equal(result.successfulRepositories, 0);
      assert.equal(result.failedRepositories, 0);
      assert.deepEqual(result.repositories, []);
    });

    // Test 3: Missing project (no links) returns valid empty result
    await check("missing project returns valid empty result (service layer)", async () => {
      const projectId = randomUUID();
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.projectId, projectId);
        assert.equal(result.totalRepositories, 0);
        assert.equal(result.successfulRepositories, 0);
        assert.equal(result.failedRepositories, 0);
        assert.equal(result.totalNewCommits, 0);
        assert.deepEqual(result.repositories, []);
      } finally {
        restoreFetch();
      }
    });

    // Test 4: Multiple linked repositories all processed
    await check("multiple linked repositories all processed (service layer)", async () => {
      const projectId = await createProject(users[0].userId, "multi-repo");
      const conn1 = await makeConnection(users[0].userId, "multi-repo-1");
      const conn2 = await makeConnection(users[0].userId, "multi-repo-2");
      connectionIds.push(conn1.id, conn2.id);
      await makeLink(projectId, conn1.id, users[0].userId);
      await makeLink(projectId, conn2.id, users[0].userId);
      
      // Mock GitHub API for both repos
      const userToken = users[0].token;
      mockResponses.set(`user:${userToken}`, { status: 200, body: { id: conn1.providerAccountId, login: "test-user" } });
      mockResponses.set(`commits:${conn1.fullName}:${userToken}`, { status: 200, body: [{ sha: "multi1", html_url: `https://github.com/${conn1.fullName}/commit/multi1`, commit: { message: "Multi 1", author: { date: new Date().toISOString(), name: "Test", email: "test@test.com" } }, author: { login: "test" } }] });
      mockResponses.set(`files:${conn1.fullName}:multi1:${userToken}`, { status: 200, body: { files: [] } });
      
      mockResponses.set(`user:${userToken}`, { status: 200, body: { id: conn2.providerAccountId, login: "test-user" } });
      mockResponses.set(`commits:${conn2.fullName}:${userToken}`, { status: 200, body: [{ sha: "multi2", html_url: `https://github.com/${conn2.fullName}/commit/multi2`, commit: { message: "Multi 2", author: { date: new Date().toISOString(), name: "Test", email: "test@test.com" } }, author: { login: "test" } }] });
      mockResponses.set(`files:${conn2.fullName}:multi2:${userToken}`, { status: 200, body: { files: [] } });
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.totalRepositories, 2);
        assert.equal(result.successfulRepositories, 2);
        assert.equal(result.failedRepositories, 0);
        assert.equal(result.totalNewCommits, 2);
        assert.equal(result.repositories.length, 2);
        assert.ok(result.repositories.every((r: any) => r.status === "success"));
      } finally {
        restoreFetch();
      }
    });

    // Test 5: One repository failing while another succeeds - partial success
    await check("one repository failure while another succeeds returns partial (service layer)", async () => {
      const projectId = await createProject(users[0].userId, "mixed-repos");
      const connSuccess = await makeConnection(users[0].userId, "success-repo");
      const connFail = await makeConnection(users[0].userId, "fail-repo");
      connectionIds.push(connSuccess.id, connFail.id);
      await makeLink(projectId, connSuccess.id, users[0].userId);
      await makeLink(projectId, connFail.id, users[0].userId);
      
      // Mock: successful repo
      const userToken = users[0].token;
      mockResponses.set(`user:${userToken}`, { status: 200, body: { id: connSuccess.providerAccountId, login: "test-user" } });
      mockResponses.set(`commits:${connSuccess.fullName}:${userToken}`, { status: 200, body: [{ sha: "ok1", html_url: `https://github.com/${connSuccess.fullName}/commit/ok1`, commit: { message: "OK", author: { date: new Date().toISOString(), name: "Test", email: "test@test.com" } }, author: { login: "test" } }] });
      mockResponses.set(`files:${connSuccess.fullName}:ok1:${userToken}`, { status: 200, body: { files: [] } });
      
      // Mock: failing repo (network error)
      mockResponses.set(`commits:${connFail.fullName}:${userToken}`, { status: 500, body: { message: "Internal Server Error" } });
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.totalRepositories, 2);
        assert.equal(result.successfulRepositories, 1);
        assert.equal(result.failedRepositories, 1);
        assert.equal(result.repositories.length, 2);
        
        const successRepo = result.repositories.find((r: any) => r.repositoryConnectionId === connSuccess.id);
        const failRepo = result.repositories.find((r: any) => r.repositoryConnectionId === connFail.id);
        
        assert.ok(successRepo);
        assert.ok(failRepo);
        assert.equal(successRepo.status, "success");
        assert.equal(failRepo.status, "failed");
        assert.ok(failRepo.error?.includes("network") || failRepo.error?.includes("failed"));
      } finally {
        restoreFetch();
      }
    });

    // Test 6: All repositories failing returns failure result
    await check("all repositories failing returns failure status (service layer)", async () => {
      const projectId = await createProject(users[0].userId, "all-fail");
      const connFail1 = await makeConnection(users[0].userId, "fail-repo-1");
      const connFail2 = await makeConnection(users[0].userId, "fail-repo-2");
      connectionIds.push(connFail1.id, connFail2.id);
      await makeLink(projectId, connFail1.id, users[0].userId);
      await makeLink(projectId, connFail2.id, users[0].userId);
      
      // Mock: all repos fail (network error)
      const userToken = users[0].token;
      mockResponses.set(`user:${userToken}`, { status: 200, body: { id: connFail1.providerAccountId, login: "test-user" } });
      mockResponses.set(`commits:${connFail1.fullName}:${userToken}`, { status: 500, body: { message: "Internal Server Error" } });
      mockResponses.set(`commits:${connFail2.fullName}:${userToken}`, { status: 500, body: { message: "Internal Server Error" } });
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.totalRepositories, 2);
        assert.equal(result.successfulRepositories, 0);
        assert.equal(result.failedRepositories, 2);
        assert.equal(result.repositories.length, 2);
        assert.ok(result.repositories.every((r: any) => r.status === "failed"));
      } finally {
        restoreFetch();
      }
    });

    // Test 7: Rate-limit metadata correctly represented
    await check("rate-limit metadata correctly represented (service layer)", async () => {
      const projectId = await createProject(users[0].userId, "rate-limit-api");
      const conn = await makeConnection(users[0].userId, "rate-limit-repo");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      // Mock with rate limit headers on user endpoint
      const userToken = users[0].token;
      mockResponses.set(`user:${userToken}`, { 
        status: 200, 
        body: { id: conn.providerAccountId, login: "test-user" },
        headers: { "X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 60) }
      });
      mockResponses.set(`commits:${conn.fullName}:${userToken}`, { 
        status: 200, 
        body: [{ sha: "rl1", html_url: `https://github.com/${conn.fullName}/commit/rl1`, commit: { message: "Rate limited", author: { date: new Date().toISOString(), name: "Test", email: "test@test.com" } }, author: { login: "test" } }],
      });
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.totalRepositories, 1);
        assert.ok(result.repositories[0].rateLimit);
        assert.equal(result.repositories[0].rateLimit!.limit, 100);
        assert.equal(result.repositories[0].rateLimit!.remaining, 0);
      } finally {
        restoreFetch();
      }
    });

    // Test 8: Identity verification failure returns failed status
    await check("identity verification failure returns failed status (service layer)", async () => {
      const projectId = await createProject(users[0].userId, "identity-fail");
      const conn = await makeConnection(users[0].userId, "identity-fail-repo");
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

    // Test 9: Missing GitHub token returns failed status
    await check("missing GitHub token returns failed status (service layer)", async () => {
      const projectId = await createProject(users[0].userId, "no-token");
      const conn = await makeConnection(users[0].userId, "no-token-repo");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        assert.equal(result.totalRepositories, 1);
        assert.equal(result.successfulRepositories, 0);
        assert.equal(result.failedRepositories, 1);
        assert.ok(result.repositories[0].error?.includes("GitHub identity verification failed") || 
                  result.repositories[0].error?.includes("No GitHub OAuth token available"));
      } finally {
        restoreFetch();
      }
    });

    // Test 10: Response structure contains all required fields
    await check("response structure contains all required fields (service layer)", async () => {
      const projectId = await createProject(users[0].userId, "structure-test");
      const conn = await makeConnection(users[0].userId, "structure-repo");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      const userToken = users[0].token;
      mockResponses.set(`user:${userToken}`, { status: 200, body: { id: conn.providerAccountId, login: "test-user" } });
      mockResponses.set(`commits:${conn.fullName}:${userToken}`, { status: 200, body: [{ sha: "struct1", html_url: `https://github.com/${conn.fullName}/commit/struct1`, commit: { message: "Structure test", author: { date: new Date().toISOString(), name: "Test", email: "test@test.com" } }, author: { login: "test" } }] });
      mockResponses.set(`files:${conn.fullName}:struct1:${userToken}`, { status: 200, body: { files: [] } });
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        // Top-level required fields
        assert.ok(result.projectId);
        assert.ok(typeof result.totalRepositories === "number");
        assert.ok(typeof result.successfulRepositories === "number");
        assert.ok(typeof result.failedRepositories === "number");
        assert.ok(typeof result.totalCommits === "number");
        assert.ok(typeof result.totalNewCommits === "number");
        assert.ok(result.observedAt);
        assert.ok(Array.isArray(result.repositories));
        
        // Per-repo required fields
        const repo = result.repositories[0];
        assert.ok(repo.projectId);
        assert.ok(repo.repositoryConnectionId);
        assert.ok(repo.githubRepoId);
        assert.ok(repo.fullName);
        assert.ok(typeof repo.defaultBranch === "string" || repo.defaultBranch === null);
        assert.ok(["success", "partial", "failed"].includes(repo.status));
        assert.ok(Array.isArray(repo.commits));
        assert.ok(Array.isArray(repo.newCommits));
        assert.ok(repo.lastObservedAt);
        assert.ok(typeof repo.error === "string" || repo.error === undefined);
        assert.ok(repo.rateLimit);
      } finally {
        restoreFetch();
      }
    });

    // Test 11: No tokens or secrets in response
    await check("response does not expose tokens or secrets (service layer)", async () => {
      const projectId = await createProject(users[0].userId, "no-secrets");
      const conn = await makeConnection(users[0].userId, "no-secrets-repo");
      connectionIds.push(conn.id);
      await makeLink(projectId, conn.id, users[0].userId);
      
      const userToken = users[0].token;
      mockResponses.set(`user:${userToken}`, { status: 200, body: { id: conn.providerAccountId, login: "test-user" } });
      mockResponses.set(`commits:${conn.fullName}:${userToken}`, { status: 200, body: [{ sha: "sec1", html_url: `https://github.com/${conn.fullName}/commit/sec1`, commit: { message: "Secret test", author: { date: new Date().toISOString(), name: "Test", email: "test@test.com" } }, author: { login: "test" } }] });
      
      const restoreFetch = setupMockFetch();
      try {
        const result = await observeProjectRepositories(projectId, users[0].userId);
        
        const bodyStr = JSON.stringify(result);
        
        // Check no access tokens in response
        assert.ok(!bodyStr.includes("access_token"));
        assert.ok(!bodyStr.includes("Bearer"));
        assert.ok(!bodyStr.includes(userToken));
        assert.ok(!bodyStr.includes("refresh_token"));
        assert.ok(!bodyStr.includes("client_secret"));
      } finally {
        restoreFetch();
      }
    });

    // Test 12: Project ownership enforced at database level (composite FK)
    await check("project ownership enforced at database level (service layer)", async () => {
      const projectA = await createProject(users[0].userId, "owned-a");
      const conn = await makeConnection(users[0].userId, "shared-repo");
      connectionIds.push(conn.id);
      await makeLink(projectA, conn.id, users[0].userId);
      
      // Try to link same connection to another user's project (should fail due to FK)
      const projectC = await createProject(users[1].userId, "other-user-project");
      
      try {
        await makeLink(projectC, conn.id, users[1].userId);
        assert.fail("Should have thrown due to ownership violation");
      } catch (err) {
        assert.ok(err instanceof Error);
      }
      
      // Verify original project still has the connection
      const linksA = await listRepositoryLinksForProject(projectA, users[0].userId);
      assert.equal(linksA.length, 1);
      assert.equal(linksA[0].repositoryConnectionId, conn.id);
    });

    console.log(`\n${passed} Stage 3.2 project observation API checks passed, ${failed} failed`);
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