import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

delete process.env.DATABASE_URL;

let passed = 0;
function check(name: string, cond: unknown) {
  assert.ok(cond, name);
  passed++;
  console.log(`PASS ${name}`);
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kagura-job-ops-"));
  process.chdir(dir);
  const {
  cancelVerificationJob,
  claimNextJob,
  finalizeCancelledJob,
  enqueueJob,
    getJob,
  recoverExpiredVerificationJobs,
  reconcileJobOperations,
  retryVerificationJob,
  updateJob,
  __unsafeWriteJobsForTests,
} = await import("@/lib/verification/jobs");
  const { buildRepositoryJobContext, authorizeRepositoryToken, authorizeRepositoryConnectionForToken } = await import("@/lib/verification/repository-context");
  const { readJournalEvents } = await import("@/lib/journal/store");
  const { validateUrl } = await import("@/lib/kane/security");
  const actor = { type: "user" as const, id: "u1" };

  {
    const base = { status: "pending" as const, flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", headless: true, timeout: 60, reason: "legacy", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), claimGeneration: 0 };
    await __unsafeWriteJobsForTests([
      { ...base, id: "ownerless-legacy", requestedBy: "" } as any,
      { ...base, id: "blank-legacy", requestedBy: "   " } as any,
    ]);
    check("ownerless legacy job cannot be claimed", (await claimNextJob({ runnerId: "r1" })) === null);
    const ownerless = await getJob("ownerless-legacy");
    const blank = await getJob("blank-legacy");
    check("legacy ownerless job remains untouched", ownerless?.status === "pending" && !ownerless?.claimedBy && (ownerless?.claimGeneration ?? 0) === 0);
    check("legacy blank-owner job remains untouched", blank?.status === "pending" && !blank?.claimedBy && (blank?.claimGeneration ?? 0) === 0);
    await __unsafeWriteJobsForTests([]);
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
    const claimed = await claimNextJob({ runnerId: "r1" });
    check("owned job can be claimed", claimed?.id === job.id && claimed.requestedBy === "u1");
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
    await assert.rejects(cancelVerificationJob(job.id, { actor, reason: "wrong", expectedClaimGeneration: 99 }), /generation/);
    check("cancellation rejects claim-generation mismatch", true);
    const result = await cancelVerificationJob(job.id, { actor, reason: "operator test", expectedClaimGeneration: 0 });
    check("pending job cancels to cancelled", result.job.status === "cancelled" && result.auditStatus === "applied");
    check("cancelled job cannot be claimed", (await claimNextJob({ runnerId: "r1" })) === null);
    await assert.rejects(retryVerificationJob(job.id, { actor, reason: "no" }), /not retryable/);
    check("cancelled job is not retryable", true);
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
    await assert.rejects(
      cancelVerificationJob(job.id, { actor, reason: "audit fail", audit: async () => { throw new Error("audit down"); } }),
      /audit down/,
    );
    check("audit requested failure prevents state transition", (await getJob(job.id))?.status === "pending");
    const result = await cancelVerificationJob(job.id, {
      actor,
      reason: "applied audit fail",
      audit: async (e: any) => { if (e.summary.includes("phase=applied")) throw new Error("audit applied down"); },
    });
    check("applied audit failure is reported as pending", result.job.status === "cancelled" && result.auditStatus === "pending");
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
    await updateJob(job.id, { status: "running", claimedBy: "r1", runnerId: "r1", claimGeneration: 2, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() });
    const result = await cancelVerificationJob(job.id, { actor, reason: "stop running", expectedClaimedBy: "r1", expectedClaimGeneration: 2 });
    check("running cancellation stays non-terminal", result.job.status === "cancelling" && result.job.completedAt === undefined);
    check("cancelling job cannot be reclaimed", (await claimNextJob({ runnerId: "r2" })) === null);
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
    await updateJob(job.id, { status: "failed", error: "boom", completedAt: new Date().toISOString() });
    const result = await retryVerificationJob(job.id, { actor, reason: "retry after failure", expectedClaimGeneration: 0 });
    check("failed job retries to pending", result.job.status === "pending");
    check("retry preserves attempt history", result.job.attempts?.length === 1 && result.job.attempt === 1);
    check("retry increments claim generation", (result.job.claimGeneration ?? 0) === 1);
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
    await updateJob(job.id, { status: "claimed", claimedBy: "old-runner", runnerId: "old-runner", claimGeneration: 3, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await recoverExpiredVerificationJobs({ actor, reason: "expired lease", now: Date.now() });
    const recovered = await getJob(job.id);
    check("expired lease recovery runs", res.recovered >= 1);
    check("recovery target is pending with bumped generation", recovered?.status === "pending" && (recovered.claimGeneration ?? 0) === 4);
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
    await updateJob(job.id, { requestedBy: "", status: "claimed", claimedBy: "old-runner", claimGeneration: 3, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    await assert.rejects(retryVerificationJob(job.id, { actor, reason: "ownerless" }), /Ownerless/);
    check("ownerless retry is rejected", true);
    const result = await cancelVerificationJob(job.id, { actor, reason: "ownerless incident", expectedClaimGeneration: 3 });
    check("ownerless job can be cancelled", result.job.status === "cancelled");
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
    const first = await cancelVerificationJob(job.id, { actor, reason: "dup", operationId: "op-dup" });
    const second = await cancelVerificationJob(job.id, { actor, reason: "dup", operationId: "op-dup" });
    check("duplicate operation id is idempotent", first.idempotent === false && second.idempotent === true && second.job.status === "cancelled");
    const events = await readJournalEvents({ privileged: true });
    check("duplicate operation id does not duplicate applied audit", events.filter((e) => e.summary.includes("operationId=op-dup") && e.summary.includes("phase=applied")).length === 1);
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
    const results = await Promise.all([
      cancelVerificationJob(job.id, { actor, reason: "race", operationId: "op-race" }),
      cancelVerificationJob(job.id, { actor, reason: "race", operationId: "op-race" }),
    ]);
    check("concurrent cancellation has one applied result", results.filter((r) => !r.idempotent).length === 1 && results.filter((r) => r.idempotent).length === 1);
    check("concurrent cancellation leaves cancelled job", (await getJob(job.id))?.status === "cancelled");
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
    const failed = await cancelVerificationJob(job.id, {
      actor,
      reason: "reconcile me",
      operationId: "op-reconcile",
      audit: async (e: any) => { if (e.summary.includes("phase=applied")) throw new Error("applied down"); },
    });
    check("crash window leaves requested operation pending", failed.auditStatus === "pending" && failed.job.status === "cancelled");
    const rec = await reconcileJobOperations({ actor, reason: "reconcile" });
    check("reconciliation applies requested operation", rec.reconciled >= 1 && rec.auditStatus === "applied");
    const events = await readJournalEvents({ privileged: true });
    check("reconciliation writes applied audit once", events.filter((e) => e.summary.includes("operationId=op-reconcile") && e.summary.includes("phase=applied")).length === 1);
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "test" });
    await updateJob(job.id, { status: "running", claimedBy: "r1", runnerId: "r1", claimGeneration: 2, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() });
    const cancelling = await cancelVerificationJob(job.id, { actor, reason: "disconnect", expectedClaimedBy: "r1", expectedClaimGeneration: 2 });
    await updateJob(job.id, { leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const rec = await recoverExpiredVerificationJobs({ actor, reason: "expired", now: Date.now() });
    check("runner disconnect while cancelling is not reclaimed", rec.recovered === 0 && (await getJob(job.id))?.status === "cancelling");
    const claimed = await claimNextJob({ runnerId: "r2" });
    check("cancelling job cannot be claimed after lease expiry", claimed?.id !== job.id);
    check("cancellation intent survives lease expiry", cancelling.job.status === "cancelling");
    const finalized = await finalizeCancelledJob(job.id, { actor, reason: "operator confirmed termination", expectedClaimGeneration: 2, operationId: "op-finalize" });
    check("operator can finalize cancelling after confirmed termination", finalized.job.status === "cancelled" && finalized.auditStatus === "applied");
  }

  {
    const job = await enqueueJob({ flow: "shell-nav", objective: "o", url: "http://localhost", projectId: "p1", requestedBy: "u1", headless: true, timeout: 60, reason: "repo", repositoryConnectionId: "rc1", repositoryOwner: "acme", repositoryName: "site", repositoryFullName: "acme/site", repositoryDefaultBranch: "main" });
    const loaded = await getJob(job.id);
    check("repository identity persists on new job", loaded?.repositoryConnectionId === "rc1" && loaded?.repositoryFullName === "acme/site" && loaded?.repositoryDefaultBranch === "main");
    const historical = { ...loaded!, repositoryConnectionId: undefined, repositoryOwner: undefined, repositoryName: undefined, repositoryFullName: undefined, repositoryDefaultBranch: undefined };
    await __unsafeWriteJobsForTests([historical]);
    const old = await getJob(job.id);
    check("historical job without repository fields loads", old?.id === job.id && old?.repositoryFullName === undefined);
    const conn: any = { id: "rc2", ownerUserId: "u1", status: "active", repoOwner: "acme", repoName: "api", fullName: "acme/api", defaultBranch: "dev" };
    const ctx = buildRepositoryJobContext(conn, "u1", "https://app.example.com");
    check("repository context uses trusted connection fields", ctx.repositoryFullName === "acme/api" && ctx.repositoryDefaultBranch === "dev" && ctx.targetUrl.replace(/\/$/, "") === "https://app.example.com");
    let denied = false; try { buildRepositoryJobContext(conn, "u2", "https://app.example.com"); } catch { denied = true; }
    check("another user's repository connection is rejected", denied);
    const tokenJob: any = { status: "running", claimedBy: "r1", claimGeneration: 2, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), repositoryFullName: "acme/site", repositoryOwner: "acme", repositoryName: "site", repositoryDefaultBranch: "main" };
    authorizeRepositoryToken(tokenJob, "r1", 2);
    check("claimed runner can request repository credential", true);
    let wrongRunner = false; try { authorizeRepositoryToken(tokenJob, "r2", 2); } catch { wrongRunner = true; }
    check("another runner cannot request repository credential", wrongRunner);
    let wrongGen = false; try { authorizeRepositoryToken(tokenJob, "r1", 1); } catch { wrongGen = true; }
    check("invalid claim generation cannot request credential", wrongGen);
    let expired = false; try { authorizeRepositoryToken({ ...tokenJob, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }, "r1", 2); } catch { expired = true; }
    check("expired lease cannot request credential", expired);
    const tokenJobWithRepo = { ...tokenJob, requestedBy: "u1", repositoryConnectionId: "rc1", repositoryOwner: "acme", repositoryName: "site", repositoryFullName: "acme/site" };
    const validConn: any = { id: "rc1", ownerUserId: "u1", status: "active", repoOwner: "acme", repoName: "site", fullName: "acme/site" };
    authorizeRepositoryConnectionForToken(tokenJobWithRepo, validConn);
    check("valid persisted connection is accepted for token issuance", true);
    let revoked = false; try { authorizeRepositoryConnectionForToken(tokenJobWithRepo, { ...validConn, status: "revoked" }); } catch { revoked = true; }
    check("revoked connection rejected at token issuance", revoked);
    let crossUser = false; try { authorizeRepositoryConnectionForToken(tokenJobWithRepo, { ...validConn, ownerUserId: "u2" }); } catch { crossUser = true; }
    check("cross-user connection rejected at token issuance", crossUser);
    let mismatch = false; try { authorizeRepositoryConnectionForToken(tokenJobWithRepo, { ...validConn, fullName: "acme/other" }); } catch { mismatch = true; }
    check("repository identity mismatch rejected at token issuance", mismatch);
    let missing = false; try { authorizeRepositoryConnectionForToken({ ...tokenJobWithRepo, repositoryConnectionId: undefined }, validConn); } catch { missing = true; }
    check("missing persisted connection rejected at token issuance", missing);
  }

  {
    check("http target URL is accepted", validateUrl("http://localhost:3000").ok);
    check("https target URL is accepted", validateUrl("https://app.example.com").ok);
    check("credentials in target URL are rejected", !validateUrl("https://user:pass@app.example.com").ok);
    check("file target URL is rejected", !validateUrl("file:///tmp/app").ok);
    check("javascript target URL is rejected", !validateUrl("javascript:alert(1)").ok);
    check("data target URL is rejected", !validateUrl("data:text/html,hi").ok);
  }

  {
    const events = await readJournalEvents({ privileged: true });
    const unprivileged = await readJournalEvents();
    check("journal preserves prior entries", events.length > 0);
    check("unprivileged journal reads are empty", unprivileged.length === 0);
  }

  {
    const events = await readJournalEvents({ privileged: true });
    check("job operations are audited", events.some((e) => e.source === "job-operations" && /actor=user:u1/.test(e.summary)));
    check("audit contains requested and applied phases", events.some((e) => e.summary.includes("phase=requested")) && events.some((e) => e.summary.includes("phase=applied")));
  }

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${passed} job operation checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
