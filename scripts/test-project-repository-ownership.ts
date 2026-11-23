process.loadEnvFile(".env.local");

import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { ensureDb, hasDatabase } from "@/lib/db";
import { upsertGitHubUser } from "@/lib/auth/users";
import { createRepositoryConnection, getRepositoryConnectionForUser, deleteRepositoryConnection } from "@/lib/repositories/connections";

async function main() {
  if (!hasDatabase()) {
    console.error("Database not configured");
    process.exit(1);
  }
  await ensureDb();
  const suffix = randomUUID().slice(0, 8);
  const userA = await upsertGitHubUser({ id: `test-a-${suffix}`, login: `test-a-${suffix}`, name: "A", email: null, avatar_url: null } as any, { access_token: "token-a", token_type: "bearer", scope: "repo" });
  const userB = await upsertGitHubUser({ id: `test-b-${suffix}`, login: `test-b-${suffix}`, name: "B", email: null, avatar_url: null } as any, { access_token: "token-b", token_type: "bearer", scope: "repo" });
  const connB = await createRepositoryConnection(userB.id, { provider: "github", providerAccountId: `acct-b-${suffix}`, githubRepoId: `repo-b-${suffix}`, repoOwner: "ownerb", repoName: "repob", fullName: "ownerb/repob", defaultBranch: "main", isPrivate: false, permissions: null, status: "active" });
  const retrieved = await getRepositoryConnectionForUser(connB.id, userA.id);
  assert.strictEqual(retrieved, undefined, "cross-user connection lookup should return undefined");
  const own = await getRepositoryConnectionForUser(connB.id, userB.id);
  assert.ok(own, "owner can retrieve own connection");
  await deleteRepositoryConnection(connB.id, userB.id);
  console.log("PASS ownership regression checks");
}

main().catch((e) => { console.error(e); process.exit(1); });
