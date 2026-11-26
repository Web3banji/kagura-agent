process.loadEnvFile(".env.local");

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/db";
import { upsertGitHubUser } from "@/lib/auth/users";
import { createRepositoryConnection, linkRepositoryToProject } from "@/lib/repositories/connections";
import { resolveJobRepositoryContext } from "@/lib/verification/repository-context";

let passed = 0;
function check(name: string, cond: unknown) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const u1 = await upsertGitHubUser({ id: `gh-${suffix}-1`, login: `test-${suffix}-1`, name: "U1", email: `u1-${suffix}@test.invalid`, avatar_url: null }, { access_token: "t1", token_type: "bearer" });
  const u2 = await upsertGitHubUser({ id: `gh-${suffix}-2`, login: `test-${suffix}-2`, name: "U2", email: `u2-${suffix}@test.invalid`, avatar_url: null }, { access_token: "t2", token_type: "bearer" });
  const projectId = `p-${suffix}`;
  const emptyProjectId = `p-empty-${suffix}`;
  const noUrlProjectId = `p-nourl-${suffix}`;
  const conn = await createRepositoryConnection(u1.id, { provider: "github", providerAccountId: `pa-${suffix}`, githubRepoId: `123-${suffix}`, repoOwner: "acme", repoName: "site", fullName: "acme/site", defaultBranch: "main", isPrivate: false, permissions: {}, status: "active" });
  const conn2 = await createRepositoryConnection(u1.id, { provider: "github", providerAccountId: `pa2-${suffix}`, githubRepoId: `124-${suffix}`, repoOwner: "acme", repoName: "api", fullName: "acme/api", defaultBranch: "dev", isPrivate: false, permissions: {}, status: "active" });
  const pool = getPool();
  try {
    await pool.query(`INSERT INTO projects (id, owner_user_id, name, slug, target_url, is_bootstrap, created_at, updated_at) VALUES ($1,$2,'P','p','https://app.example.com',false,NOW(),NOW()), ($3,$2,'Empty','empty',NULL,false,NOW(),NOW()), ($4,$2,'NoUrl','nourl',NULL,false,NOW(),NOW())`, [projectId, u1.id, emptyProjectId, noUrlProjectId]);
    await linkRepositoryToProject(projectId, conn.id, u1.id);
    await linkRepositoryToProject(noUrlProjectId, conn2.id, u1.id);
    const ctx = await resolveJobRepositoryContext(projectId, u1.id);
    check("active repository resolves trusted metadata", ctx.repositoryConnectionId === conn.id && ctx.repositoryFullName === "acme/site" && ctx.repositoryDefaultBranch === "main");
    check("persisted project target URL is trusted", ctx.targetUrl.replace(/\/$/, "") === "https://app.example.com");
    await pool.query(`UPDATE projects SET target_url = $1 WHERE id = $2 AND owner_user_id = $3`, ["https://edit.example.com", projectId, u1.id]);
    const edited = await resolveJobRepositoryContext(projectId, u1.id);
    check("edited target URL persists and is used", edited.targetUrl.replace(/\/$/, "") === "https://edit.example.com");
    let denied = false; try { await resolveJobRepositoryContext(projectId, u2.id); } catch { denied = true; }
    check("another user cannot resolve the repository", denied);
    let missing = false; try { await resolveJobRepositoryContext(emptyProjectId, u1.id); } catch { missing = true; }
    check("project without active repository is rejected", missing);
    let noUrl = false; try { await resolveJobRepositoryContext(noUrlProjectId, u1.id); } catch { noUrl = true; }
    check("project without target URL is rejected", noUrl);
  } finally {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM project_repository_links WHERE project_id = ANY($1::text[])", [[projectId, emptyProjectId, noUrlProjectId]]);
      await client.query("DELETE FROM repository_connections WHERE id = ANY($1::text[])", [[conn.id, conn2.id]]);
      await client.query("DELETE FROM projects WHERE id = ANY($1::text[])", [[projectId, emptyProjectId, noUrlProjectId]]);
      await client.query("DELETE FROM accounts WHERE user_id = ANY($1::text[])", [[u1.id, u2.id]]);
      await client.query("DELETE FROM users WHERE id = ANY($1::text[])", [[u1.id, u2.id]]);
      await client.query("COMMIT");
    } catch { await client.query("ROLLBACK"); } finally { client.release(); }
  }
  console.log(`\n${passed} repository context checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
