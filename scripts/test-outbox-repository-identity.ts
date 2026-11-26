import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

delete process.env.DATABASE_URL;

let passed = 0;
function check(name: string, cond: unknown) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kagura-outbox-repo-"));
  process.chdir(dir);

  const { enqueueJob, claimNextJob } = await import("@/lib/verification/jobs");
  const { completeJobAtomically } = await import("@/lib/verification/completion");
  const { readOutboxItems } = await import("@/lib/verification/outbox");
  const { processOutboxItem } = await import("@/lib/verification/outbox-worker");
  const { getVerificationRecord } = await import("@/lib/verification/store");
  const { readInvestigations } = await import("@/lib/investigations/store");

  const baseConnection = {
    id: "rc-original",
    ownerUserId: "u1",
    status: "active",
    repoOwner: "acme",
    repoName: "site",
    fullName: "acme/site",
    defaultBranch: "main",
  } as any;

  async function seed(repo: Record<string, unknown>) {
    const job = await enqueueJob({
      flow: "shell-nav",
      objective: "obj",
      url: "https://app.example.com",
      projectId: "p1",
      requestedBy: "u1",
      headless: true,
      timeout: 60,
      reason: "test",
      ...repo,
    } as any);
    const claimed = await claimNextJob({ runnerId: "runner-1", leaseMs: 60_000 });
    assert.ok(claimed && claimed.id === job.id);
    const finishedAt = new Date().toISOString();
    const recordId = `rec-${randomUUID()}`;
    await completeJobAtomically({
      job: claimed!,
      runnerId: "runner-1",
      record: {
        id: recordId,
        jobId: job.id,
        projectId: "p1",
        requestedBy: "u1",
        flow: "shell-nav",
        objective: "obj",
        url: "https://app.example.com",
        outcome: "failed",
        exitCode: 1,
        summary: "fail",
        failingStep: `step-${recordId}`,
        startedAt: finishedAt,
        finishedAt,
        source: "runner",
        evidencePath: "data/verification/runs/x.ndjson",
      } as any,
      result: { outcome: "failed", summary: "fail" },
      outcome: "failed",
      jobStatus: "failed",
      finishedAt,
    });
    const item = (await readOutboxItems()).find((i) => i.jobId === job.id);
    assert.ok(item, "outbox item should be enqueued");
    return { job: claimed!, item: item!, recordId };
  }

  async function investigationFor(id: string) {
    const invs = await readInvestigations({ userId: "u1", privileged: false, includeLegacy: false } as any);
    return invs.find((i) => i.id === id);
  }

  {
    let activeCalls = 0;
    const seeded = await seed({ repositoryConnectionId: "rc-original", repositoryOwner: "acme", repositoryName: "site", repositoryFullName: "acme/site", repositoryDefaultBranch: "main" });
    const result = await processOutboxItem(seeded.item, "w1", {
      getRepositoryConnectionForUser: async () => baseConnection,
      resolveActiveRepositoryConnectionId: async () => { activeCalls++; return "rc-active"; },
    });
    check("persisted connection processes successfully", result.state === "processed");
    check("active project link is not consulted", activeCalls === 0);
    const inv = result.investigationIds?.[0] ? await investigationFor(result.investigationIds[0]) : null;
    check("investigation preserves persisted connection", inv?.repositoryConnectionId === "rc-original");
  }

  {
    let activeCalls = 0;
    const seeded = await seed({ repositoryConnectionId: "rc-original", repositoryOwner: "acme", repositoryName: "site", repositoryFullName: "acme/site", repositoryDefaultBranch: "main" });
    const result = await processOutboxItem(seeded.item, "w2", {
      getRepositoryConnectionForUser: async () => baseConnection,
      resolveActiveRepositoryConnectionId: async () => { activeCalls++; return "rc-changed"; },
    });
    const inv = result.investigationIds?.[0] ? await investigationFor(result.investigationIds[0]) : null;
    check("changed active link does not change job repository", inv?.repositoryConnectionId === "rc-original");
    check("changed active link is never resolved", activeCalls === 0);
  }

  {
    let activeCalls = 0;
    const seeded = await seed({ repositoryConnectionId: "rc-original", repositoryOwner: "acme", repositoryName: "site", repositoryFullName: "acme/site", repositoryDefaultBranch: "main" });
    const result = await processOutboxItem(seeded.item, "w3", {
      getRepositoryConnectionForUser: async () => undefined,
      resolveActiveRepositoryConnectionId: async () => { activeCalls++; return "rc-other"; },
    });
    const record = await getVerificationRecord(seeded.recordId, { requestedBy: "u1", projectId: "p1", includeLegacy: false });
    check("missing persisted connection fails safely", result.state === "failed");
    check("missing persisted connection does not fall back", activeCalls === 0);
    check("missing persisted connection records failure", record?.investigationProcessing?.state === "failed");
  }

  {
    const seeded = await seed({ repositoryConnectionId: "rc-original", repositoryOwner: "acme", repositoryName: "site", repositoryFullName: "acme/site", repositoryDefaultBranch: "main" });
    const result = await processOutboxItem(seeded.item, "w4", {
      getRepositoryConnectionForUser: async () => ({ ...baseConnection, ownerUserId: "u2" }),
      resolveActiveRepositoryConnectionId: async () => "rc-other",
    });
    check("another user's connection is rejected", result.state === "failed");
  }

  {
    const seeded = await seed({ repositoryConnectionId: "rc-original", repositoryOwner: "acme", repositoryName: "site", repositoryFullName: "acme/site", repositoryDefaultBranch: "main" });
    const result = await processOutboxItem(seeded.item, "w5", {
      getRepositoryConnectionForUser: async () => ({ ...baseConnection, fullName: "acme/other" }),
      resolveActiveRepositoryConnectionId: async () => "rc-other",
    });
    check("mismatched repository identity is rejected", result.state === "failed");
  }

  {
    let activeCalls = 0;
    const seeded = await seed({});
    const result = await processOutboxItem(seeded.item, "w6", {
      getRepositoryConnectionForUser: async () => { throw new Error("must not be called"); },
      resolveActiveRepositoryConnectionId: async () => { activeCalls++; return "rc-legacy"; },
    });
    const inv = result.investigationIds?.[0] ? await investigationFor(result.investigationIds[0]) : null;
    check("legacy job keeps active-link fallback", result.state === "processed" && activeCalls === 1);
    check("legacy investigation uses fallback connection", inv?.repositoryConnectionId === "rc-legacy");
  }

  {
    const seeded = await seed({ repositoryConnectionId: "rc-original", repositoryOwner: "acme", repositoryName: "site", repositoryFullName: "acme/site", repositoryDefaultBranch: "main" });
    const stale = { ...seeded.item, id: `stale-${randomUUID()}`, claimGeneration: 999 } as any;
    const result = await processOutboxItem(stale, "w7", {
      getRepositoryConnectionForUser: async () => baseConnection,
      resolveActiveRepositoryConnectionId: async () => "rc-other",
    });
    check("stale claim generation remains fail-closed", result.state === "failed" && result.reason === "claim_generation_mismatch");
  }

  console.log(`\n${passed} outbox repository identity checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });