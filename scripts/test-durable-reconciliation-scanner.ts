/**
 * Focused durable reconciliation scanner tests (file fallback).
 * Run: npx tsx scripts/test-durable-reconciliation-scanner.ts
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRun, updateRun, readRuns, reconcilePendingAgentRuns } from '@/lib/agent/runs';
import { enqueueJob, claimNextJob, __unsafeWriteJobsForTests } from '@/lib/verification/jobs';
import { __unsafeWriteVerificationRecordsForTests } from '@/lib/verification/store';
import { completeJobAtomically } from '@/lib/verification/completion';

const RUNS_FILE = path.join(process.cwd(), 'data', 'agent', 'runs.json');

let passed = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); }

async function reset() {
  await fs.promises.mkdir(path.dirname(RUNS_FILE), { recursive: true });
  await fs.promises.writeFile(RUNS_FILE, '[]', 'utf8');
  await __unsafeWriteJobsForTests([]);
  await __unsafeWriteVerificationRecordsForTests([]);
}

function rec(job: any, outcome: 'failed' = 'failed', summary = 's') {
  const finishedAt = new Date().toISOString();
  return {
    record: { id: job.id, jobId: job.id, flow: job.flow, objective: job.objective, url: job.url, outcome, summary, startedAt: job.startedAt || job.createdAt, finishedAt, source: 'runner' as const, projectId: job.projectId, requestedBy: job.requestedBy },
    result: { outcome, summary, finishedAt, startedAt: job.startedAt || job.createdAt, exitCode: 1 },
  };
}

async function main() {
  await reset();

  // Terminal record discovered by scanner
  {
    const job = await enqueueJob({ flow: 'shell-nav', objective: 'o', url: 'http://localhost', projectId: 'p1', requestedBy: 'u1', headless: true, timeout: 60, reason: 't' });
    const run = await createRun('manual');
    await updateRun(run.id, { verificationId: job.id });
    const claim = await claimNextJob({ runnerId: 'r1' });
    const { record, result } = rec(claim!, 'failed', 'scanner summary');
    await completeJobAtomically({ job: claim!, runnerId: 'r1', record, result, outcome: 'failed', jobStatus: 'failed', finishedAt: record.finishedAt! });
    await updateRun(run.id, { status: 'running', verificationOutcome: 'pending' });
    const scan = await reconcilePendingAgentRuns();
    check('scanner discovers terminal record', scan.processed === 1);
    const updated = (await readRuns()).find(r => r.id === run.id);
    check('scanner reconciles run', updated?.status === 'failed');
  }

  await reset();

  // Existing terminal run not downgraded
  {
    const job = await enqueueJob({ flow: 'shell-nav', objective: 'o', url: 'http://localhost', projectId: 'p1', requestedBy: 'u1', headless: true, timeout: 60, reason: 't' });
    const run = await createRun('manual');
    await updateRun(run.id, { verificationId: job.id, status: 'completed', verificationOutcome: 'passed' });
    const claim = await claimNextJob({ runnerId: 'r1' });
    const { record, result } = rec(claim!, 'failed', 'failed summary');
    await completeJobAtomically({ job: claim!, runnerId: 'r1', record, result, outcome: 'failed', jobStatus: 'failed', finishedAt: record.finishedAt! });
    const scan = await reconcilePendingAgentRuns();
    check('scanner does not downgrade terminal run', scan.skipped >= 1);
    const unchanged = (await readRuns()).find(r => r.id === run.id);
    check('terminal run remains completed', unchanged?.status === 'completed');
  }

  await reset();

  // Missing associated run handled safely
  {
    const job = await enqueueJob({ flow: 'shell-nav', objective: 'o', url: 'http://localhost', projectId: 'p1', requestedBy: 'u1', headless: true, timeout: 60, reason: 't' });
    const claim = await claimNextJob({ runnerId: 'r1' });
    const { record, result } = rec(claim!, 'failed', 'missing run summary');
    await completeJobAtomically({ job: claim!, runnerId: 'r1', record, result, outcome: 'failed', jobStatus: 'failed', finishedAt: record.finishedAt! });
    const scan = await reconcilePendingAgentRuns();
    check('missing run handled safely', scan.skipped >= 1);
  }

  console.log(`\n${passed} checks passed`);
}


main().catch((e) => { console.error(e); process.exit(1); });
