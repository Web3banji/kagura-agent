/**
 * Public story boundary regression tests.
 * Run: npx tsx scripts/test-story-public-boundary.ts
 */
import assert from "node:assert";
import { toPublicStory } from "@/lib/stories/public";
import type { Story } from "@/types/story";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
}

const base: Story = {
  id: "story-secret-id",
  userId: "user-secret",
  projectId: "project-secret",
  slug: "published-story",
  title: "Title",
  subtitle: "Sub",
  body: "Body",
  status: "published",
  tags: ["development"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  publishedAt: "2026-01-01T00:00:00.000Z",
  source: {
    repo: "owner/repo",
    observationSource: "github-api",
    commits: [{ sha: "abc123secret", message: "secret commit", author: "alice", date: "2026-01-01T00:00:00.000Z", url: "https://github.com/secret" }],
    changedFiles: ["secret/file.ts"],
    observationSummary: "summary",
  },
  verification: {
    id: "ver-secret",
    outcome: "passed",
    summary: "ok",
    url: "https://internal.example",
    exitCode: 0,
    creditsConsumed: 3,
    testUrl: "https://testmu.ai/internal",
    evidencePath: "data/verification/secret.ndjson",
    ndjsonPath: "data/verification/secret.ndjson",
  },
};

check("published story maps to public shape only", () => {
  const pub = toPublicStory(base);
  assert.ok(pub);
  const json = JSON.stringify(pub);
  for (const secret of ["story-secret-id","user-secret","project-secret","abc123secret","secret/file.ts","ver-secret","exitCode","creditsConsumed","testUrl","evidencePath","ndjsonPath","logPath","https://internal.example","https://github.com/secret"]) {
    assert.equal(json.includes(secret), false, `leaked ${secret}`);
  }
  assert.equal(pub.slug, "published-story");
  assert.equal(pub.status, "published");
  assert.equal(pub.verification?.outcome, "passed");
});

check("unpublished stories are not public", () => {
  for (const status of ["draft","review","rejected"] as const) {
    assert.equal(toPublicStory({ ...base, status, publishedAt: undefined }), null);
  }
});

check("public story has no internal ownership or evidence fields", () => {
  const pub = toPublicStory(base) as unknown as Record<string, unknown>;
  for (const key of ["id","userId","projectId","rejectedAt","evidence"]) {
    assert.equal(key in pub, false, `unexpected key ${key}`);
  }
  assert.equal("id" in ((pub.verification as Record<string, unknown>) || {}), false);
});

console.log(`\n${passed} checks passed`);
