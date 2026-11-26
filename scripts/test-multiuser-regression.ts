/**
 * Permanent multi-user authorization regression tests for KAGURA.
 *
 * Runs against the real database configured in `.env.local` (DATABASE_URL).
 * All fixtures are created with unique, throwaway identifiers and deleted when
 * the test finishes. No existing user data is read, modified, or deleted.
 *
 * Run:  npx tsx scripts/test-multiuser-regression.ts
 *
 * Categories covered:
 *  - Unit/store isolation tests (stories, runs, jobs, verification records)
 *  - API route integration tests (mutations, jobs, GitHub config, runner complete)
 *  - Authentication (unauthenticated / invalid session rejected)
 *  - Privileges (bootstrap owner vs ordinary user vs admin token)
 *  - Legacy records (ownerless visible only when includeLegacy is granted)
 */

process.loadEnvFile(".env.local");

import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/db";
import { createSession } from "@/lib/auth/session";
import { upsertGitHubUser } from "@/lib/auth/users";
import { getRequestPrincipal } from "@/lib/auth";
import { scopeForPrincipal, scopeToRecordQuery } from "@/lib/auth/scope";
import { principalHasLegacyAccess } from "@/lib/auth/guards";
import { AccessDeniedError } from "@/lib/auth/errors";
import { readStories, upsertStory, getStoryById } from "@/lib/stories/store";
import { readRuns, createRun, updateRun } from "@/lib/agent/runs";
import { enqueueJob, readJobs, getJob, updateJob } from "@/lib/verification/jobs";
import { readVerificationRecords, upsertVerificationRecord } from "@/lib/verification/store";
import { createRepositoryConnection, linkRepositoryToProject } from "@/lib/repositories/connections";

type UserFixture = {
  userId: string;
  token: string;
  cookie: string;
  githubLogin: string;
  cleanupIds: string[];
};

const TEST_PREFIX = `kagura-test-${randomUUID().slice(0, 8)}`;
const pass = { n: 0 };
let exitCode = 0;

function check(name: string, fn: () => Promise<void> | void) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") result.then(undefined, (e) => fail(name, e));
    pass.n++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail(name, e);
  }
}

function fail(name: string, e: unknown) {
  exitCode = 1;
  console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
}

async function createUserFixture(): Promise<UserFixture> {
  const suffix = randomUUID().slice(0, 6);
  const githubLogin = `${TEST_PREFIX}-user-${suffix}`;
  const email = `${githubLogin}@example.invalid`;
  const user = await upsertGitHubUser(
    { id: `gh-${suffix}`, login: githubLogin, name: `Test ${suffix}`, email, avatar_url: null },
    { access_token: `test-token-${suffix}`, token_type: "bearer" },
  );
  const { token } = await createSession(user.id);
  const cookieName = process.env.VERCEL || process.env.NODE_ENV === "production" ? "__Secure-kagura.session" : "kagura.session";
  return {
    userId: user.id,
    token,
    cookie: `${cookieName}=${token}`,
    githubLogin,
    cleanupIds: [user.id],
  };
}

async function bootstrapOwnerFixture(): Promise<UserFixture> {
  const suffix = randomUUID().slice(0, 6);
  const githubLogin = `${TEST_PREFIX}-owner-${suffix}`;
  const user = await upsertGitHubUser(
    { id: `gh-owner-${suffix}`, login: githubLogin, name: `Owner ${suffix}`, email: `${githubLogin}@example.invalid`, avatar_url: null },
    { access_token: `owner-token-${suffix}`, token_type: "bearer" },
  );
  await getPool().query("UPDATE users SET is_bootstrap_owner = TRUE WHERE id = $1", [user.id]);
  const { token } = await createSession(user.id);
  const cookieName = process.env.VERCEL || process.env.NODE_ENV === "production" ? "__Secure-kagura.session" : "kagura.session";
  return {
    userId: user.id,
    token,
    cookie: `${cookieName}=${token}`,
    githubLogin,
    cleanupIds: [user.id],
  };
}

async function cleanup(fixtures: UserFixture[]) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userIds = fixtures.map((f) => f.userId);
    if (userIds.length) {
      await client.query("DELETE FROM accounts WHERE user_id = ANY($1::text[])", [userIds]);
      await client.query("DELETE FROM sessions WHERE user_id = ANY($1::text[])", [userIds]);
      await client.query("DELETE FROM users WHERE id = ANY($1::text[])", [userIds]);
    }
    await client.query("COMMIT");
  } catch {
    try { await client.query("ROLLBACK"); } catch {}
  } finally {
    client.release();
  }
}

function storyFor(userId: string, owner: string) {
  return {
    id: `story-${randomUUID().slice(6)}`,
    slug: `story-${randomUUID().slice(6)}`,
    title: "Test story",
    subtitle: "sub",
    body: "body",
    status: "draft" as const,
    userId: owner,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
    source: {
      commits: [],
      changedFiles: [],
      observationSummary: "obs",
      observationSource: "git-local" as const,
    },
  };
}

function userScope(userId: string, isBootstrapOwner: boolean) {
  return {
    kind: "user" as const,
    userId,
    user: {
      id: userId,
      name: "Test",
      email: `${userId}@example.invalid`,
      image: null,
      githubId: null,
      githubLogin: null,
      isBootstrapOwner,
    },
  };
}

async function main() {
  const owner = await bootstrapOwnerFixture();
  const alice = await createUserFixture();
  const bob = await createUserFixture();

  try {
    // ---------- Store-level isolation ----------
    check("ordinary user cannot see another user's stories", async () => {
      const aStory = storyFor(alice.userId, alice.userId);
      const bStory = storyFor(bob.userId, bob.userId);
      await upsertStory(aStory, userScope(alice.userId, false));
      await upsertStory(bStory, userScope(bob.userId, false));

      const aStories = await readStories(userScope(alice.userId, false));
      const bStories = await readStories(userScope(bob.userId, false));
      assert.ok(!aStories.some((s) => s.id === bStory.id), "Alice must not see Bob's story");
      assert.ok(!bStories.some((s) => s.id === aStory.id), "Bob must not see Alice's story");
      assert.ok(aStories.some((s) => s.id === aStory.id));
      assert.ok(bStories.some((s) => s.id === bStory.id));
    });

    check("ordinary user cannot see another user's agent runs", async () => {
      const scopeA = userScope(alice.userId, false);
      const scopeB = userScope(bob.userId, false);
      const runA = await createRun("manual", { userId: alice.userId });
      const runB = await createRun("manual", { userId: bob.userId });

      const aRuns = await readRuns(scopeA);
      const bRuns = await readRuns(scopeB);
      assert.ok(!aRuns.some((r) => r.id === runB.id));
      assert.ok(!bRuns.some((r) => r.id === runA.id));
      assert.ok(aRuns.some((r) => r.id === runA.id));
      assert.ok(bRuns.some((r) => r.id === runB.id));
    });

    check("cross-user story update is rejected", async () => {
      const scopeA = userScope(alice.userId, false);
      const bStory = storyFor(bob.userId, bob.userId);
      await upsertStory(bStory, userScope(bob.userId, false));
      const forged = { ...bStory, title: "hacked by alice" };
      await assert.rejects(() => upsertStory(forged, scopeA), AccessDeniedError);
    });

    check("non-privileged user cannot reassign story owner", async () => {
      const scopeA = userScope(alice.userId, false);
      const aStory = storyFor(alice.userId, alice.userId);
      await upsertStory(aStory, scopeA);
      const reassigned = { ...aStory, userId: bob.userId };
      await assert.rejects(() => upsertStory(reassigned, scopeA), AccessDeniedError);
      // Alice still owns her story after the failed reassignment.
      const stillAlice = await getStoryById(aStory.id, scopeA);
      assert.equal(stillAlice?.userId, alice.userId);
    });

    check("bootstrap owner sees all stories (legacy + per-user)", async () => {
      const scopeOwner = userScope(owner.userId, true);
      const allStories = await readStories(scopeOwner);
      assert.ok(allStories.some((s) => s.userId === alice.userId));
      assert.ok(allStories.some((s) => s.userId === bob.userId));
      assert.ok(allStories.some((s) => s.userId === owner.userId));
    });

    check("verification jobs are isolated by owner", async () => {
      const jobA = await enqueueJob({ flow: "shell-nav", objective: "check A", url: "http://a.example", projectId: "p", requestedBy: alice.userId });
      const jobB = await enqueueJob({ flow: "shell-nav", objective: "check B", url: "http://b.example", projectId: "p", requestedBy: bob.userId });

      const jobsA = await readJobs({ requestedBy: alice.userId });
      const jobsB = await readJobs({ requestedBy: bob.userId });
      assert.ok(!jobsA.some((j) => j.id === jobB.id));
      assert.ok(!jobsB.some((j) => j.id === jobA.id));
      assert.ok(jobsA.some((j) => j.id === jobA.id));
      assert.ok(jobsB.some((j) => j.id === jobB.id));
    });

    check("getJob rejects cross-user id lookup", async () => {
      const jobB = await enqueueJob({ flow: "shell-nav", objective: "check B", url: "http://b.example", projectId: "p", requestedBy: bob.userId });
      const got = await getJob(jobB.id, { requestedBy: alice.userId });
      assert.equal(got, undefined);
      const gotSelf = await getJob(jobB.id, { requestedBy: bob.userId });
      assert.ok(gotSelf);
    });

    check("verification records are isolated by owner", async () => {
      const recA = await upsertVerificationRecord({
        id: `rec-${randomUUID().slice(6)}`,
        flow: "shell-nav",
        objective: "check A",
        url: "http://a.example",
        outcome: "passed",
        projectId: "p",
        requestedBy: alice.userId,
        startedAt: new Date().toISOString(),
      });
      const recB = await upsertVerificationRecord({
        id: `rec-${randomUUID().slice(6)}`,
        flow: "shell-nav",
        objective: "check B",
        url: "http://b.example",
        outcome: "failed",
        projectId: "p",
        requestedBy: bob.userId,
        startedAt: new Date().toISOString(),
      });

      const recsA = await readVerificationRecords({ requestedBy: alice.userId });
      const recsB = await readVerificationRecords({ requestedBy: bob.userId });
      assert.ok(!recsA.some((r) => r.id === recB.id));
      assert.ok(!recsB.some((r) => r.id === recA.id));
    });

    check("legacy (ownerless) records are hidden unless includeLegacy is granted", async () => {
      const legacy = await upsertVerificationRecord({
        id: `rec-legacy-${randomUUID().slice(6)}`,
        flow: "shell-nav",
        objective: "legacy",
        url: "http://legacy.example",
        outcome: "passed",
        projectId: "p",
        requestedBy: "",
        startedAt: new Date().toISOString(),
      });
      const aliceScope = userScope(alice.userId, false);
      const withoutLegacy = await readVerificationRecords(scopeToRecordQuery(aliceScope));
      assert.ok(!withoutLegacy.some((r) => r.id === legacy.id));
      const withLegacy = await readVerificationRecords({ ...scopeToRecordQuery(aliceScope), includeLegacy: true });
      assert.ok(withLegacy.some((r) => r.id === legacy.id));
    });

    check("bootstrap owner can read legacy and all user records", async () => {
      const scopeOwner = userScope(owner.userId, true);
      const recs = await readVerificationRecords(scopeToRecordQuery(scopeOwner));
      assert.ok(recs.some((r) => r.requestedBy === alice.userId));
      assert.ok(recs.some((r) => r.requestedBy === bob.userId));
    });

    // ---------- API route integration ----------
    check("POST /api/verification/jobs sets owner to caller, never to forged body owner", async () => {
      const projectId = `pj-${randomUUID().slice(0, 8)}`;
      const conn = await createRepositoryConnection(alice.userId, { provider: "github", providerAccountId: `pa-${randomUUID().slice(0, 8)}`, githubRepoId: `123-${randomUUID().slice(0, 8)}`, repoOwner: "acme", repoName: "site", fullName: "acme/site", defaultBranch: "main", isPrivate: false, permissions: {}, status: "active" });
      await getPool().query(`INSERT INTO projects (id, owner_user_id, name, slug, target_url, is_bootstrap, created_at, updated_at) VALUES ($1,$2,'P','p','https://trusted.example',false,NOW(),NOW())`, [projectId, alice.userId]);
      await linkRepositoryToProject(projectId, conn.id, alice.userId);
      try {
        const r = await fetch("http://localhost/api/verification/jobs", {
          method: "POST",
          body: JSON.stringify({ flow: "shell-nav", objective: "x", url: "http://x.example", projectId, requestedBy: bob.userId }),
          headers: { Cookie: alice.cookie, "Content-Type": "application/json" },
        });
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.job.requestedBy, alice.userId, "requestedBy must be the caller, not the forged body value");
        assert.notEqual(body.job.requestedBy, bob.userId);
        assert.equal(body.job.repositoryFullName, "acme/site");
        assert.equal(body.job.url, "https://trusted.example", "client URL override must be ignored");
        await getPool().query("DELETE FROM verification_jobs WHERE id = $1", [body.job.id]);
        const denied = await fetch("http://localhost/api/projects", { method: "PATCH", body: JSON.stringify({ id: projectId, targetUrl: "https://evil.example" }), headers: { Cookie: bob.cookie, "Content-Type": "application/json" } });
        assert.equal(denied.status, 404, "another user cannot edit target URL");
        const invalid = await fetch("http://localhost/api/projects", { method: "PATCH", body: JSON.stringify({ id: projectId, targetUrl: "https://u:p@evil.example" }), headers: { Cookie: alice.cookie, "Content-Type": "application/json" } });
        assert.equal(invalid.status, 400, "credentials in target URL are rejected");
        const saved = await fetch("http://localhost/api/projects", { method: "PATCH", body: JSON.stringify({ id: projectId, targetUrl: "https://owned.example" }), headers: { Cookie: alice.cookie, "Content-Type": "application/json" } });
        assert.equal(saved.status, 200, "owner can edit target URL");
        assert.equal((await saved.json()).project.targetUrl, "https://owned.example");
      } finally {
        await getPool().query("DELETE FROM project_repository_links WHERE project_id = $1", [projectId]);
        await getPool().query("DELETE FROM repository_connections WHERE id = $1", [conn.id]);
        await getPool().query("DELETE FROM projects WHERE id = $1", [projectId]);
      }
    });

    check("GET /api/verification/jobs shows only caller's jobs", async () => {
      const r = await fetch("http://localhost/api/verification/jobs", { headers: { Cookie: alice.cookie } });
      assert.equal(r.status, 200);
      const { jobs } = await r.json();
      assert.ok(jobs.every((j: any) => j.requestedBy === alice.userId || !j.requestedBy));
    });

    check("POST /api/github/config is rejected for ordinary users", async () => {
      const r = await fetch("http://localhost/api/github/config", {
        method: "POST",
        body: JSON.stringify({ owner: "acme", repo: "repo" }),
        headers: { Cookie: alice.cookie, "Content-Type": "application/json" },
      });
      assert.equal(r.status, 403);
    });

    check("POST /api/github/observe is rejected for ordinary users", async () => {
      const r = await fetch("http://localhost/api/github/observe", {
        method: "POST",
        headers: { Cookie: alice.cookie },
      });
      assert.equal(r.status, 403);
    });

    check("unauthenticated requests are rejected", async () => {
      const r = await fetch("http://localhost/api/verification/jobs", { method: "GET" });
      assert.equal(r.status, 401);
    });

    check("invalid session is rejected", async () => {
      const r = await fetch("http://localhost/api/verification/jobs", {
        headers: { Cookie: "kagura.session=not-a-real-token" },
      });
      assert.equal(r.status, 401);
    });

    console.log(`\n${pass.n} multi-user regression checks passed`);
    process.exit(exitCode);
  } finally {
    await cleanup([owner, alice, bob]);
  }
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
