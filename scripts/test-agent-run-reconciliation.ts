/**
 * Deterministic agent-run reconciliation tests (file fallback, no DB required).
 * Run: npx tsx scripts/test-agent-run-reconciliation.ts
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRun, updateRun, readRuns, reconcileAgentRunForVerification, recoverStaleAgentRunForVerification, mapVerificationOutcomeToAgentRunStatus } from '@/lib/agent/runs';
import { enqueueJob, claimNextJob, __unsafeWriteJobsForTests } from '@/lib/verification/jobs';
import { __unsafeWriteVerificationRecordsForTests } from '@/lib/verification/store';
import { completeJobAtomically } from '@/lib/verification/completion';

const DATA_DIR = path.join(process.cwd(), 'data');
const RUNS_FILE = path.join(DATA_DIR, 'agent', 'runs.json');

let passed = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); }

async function reset() {
  await fs.promises.mkdir(path.dirname(RUNS_FILE), { recursive: true });
  await fs.promises.writeFile(RUNS_FILE, '[]', 'utf8');
  await __unsafeWriteJobsForTests([]);
  await __unsafeWriteVerificationRecordsForTests([]);
}

function rec(job: any, outcome: 'passed' | 'failed' = 'failed', summary = 's') {
  const finishedAt = new Date().toISOString();
  return {
    record: { id: job.id, jobId: job.id, flow: job.flow, objective: job.objective, url: job.url, outcome, summary, startedAt: job.startedAt || job.createdAt, finishedAt, source: 'runner' as const, projectId: job.projectId, requestedBy: job.requestedBy },
    result: { outcome, summary, finishedAt, startedAt: job.startedAt || job.createdAt, exitCode: outcome === 'passed' ? 0 : 1 },
  };
}

async function makeRun(verificationId: string) {
  const run = await createRun('manual');
  await updateRun(run.id, { verificationId });
  return run;
}

async function main() {
  await reset();

  {
    const job = await enqueueJob({ flow: 'shell-nav', objective: 'o', url: 'http://localhost', projectId: 'p1', requestedBy: 'u1', headless: true, timeout: 60, reason: 't' });
    const run = await makeRun(job.id);
    const claim = await claimNextJob({ runnerId: 'r1' });
    const { record, result } = rec(claim!, 'failed', 'failed summary');
    await completeJobAtomically({ job: claim!, runnerId: 'r1', record, result, outcome: 'failed', jobStatus: 'failed', finishedAt: record.finishedAt! });
    const recon = await reconcileAgentRunForVerification(job.id, 'failed', 'failed summary');
    check('failed reconciliation updates run', recon.updated === true);
    const updatedRun = (await readRuns()).find(r => r.id === run.id);
    check('failed run status', updatedRun?.status === 'failed');
    check('failed verify stage', updatedRun?.stages.find(s => s.stage === 'VERIFY')?.status === 'failed');
  }

  await reset();

  {
    const job = await enqueueJob({ flow: 'shell-nav', objective: 'o', url: 'http://localhost', projectId: 'p1', requestedBy: 'u1', headless: true, timeout: 60, reason: 't' });
    const run = await makeRun(job.id);
    const claim = await claimNextJob({ runnerId: 'r1' });
    const { record, result } = rec(claim!, 'passed', 'passed summary');
    await completeJobAtomically({ job: claim!, runnerId: 'r1', record, result, outcome: 'passed', jobStatus: 'completed', finishedAt: record.finishedAt! });
    const recon = await reconcileAgentRunForVerification(job.id, 'passed', 'passed summary');
    check('passed reconciliation updates run', recon.updated === true);
    const updatedRun = (await readRuns()).find(r => r.id === run.id);
    check('passed run status', updatedRun?.status === 'completed');
    check('passed verify stage', updatedRun?.stages.find(s => s.stage === 'VERIFY')?.status === 'completed');
  }

  await reset();

  {
    check('blocked maps', mapVerificationOutcomeToAgentRunStatus('blocked')?.runStatus === 'blocked');
    check('timeout maps to incomplete', mapVerificationOutcomeToAgentRunStatus('timeout')?.runStatus === 'incomplete');
    check('did_not_start maps to incomplete', mapVerificationOutcomeToAgentRunStatus('did_not_start')?.runStatus === 'incomplete');
  }

  await reset();

  {
    const job = await enqueueJob({ flow: 'shell-nav', objective: 'o', url: 'http://localhost', projectId: 'p1', requestedBy: 'u1', headless: true, timeout: 60, reason: 't' });
    const run = await makeRun(job.id);
    const recon = await reconcileAgentRunForVerification(job.id, 'pending', 'pending');
    check('pending does not update', recon.updated === false && recon.reason === 'nonterminal_outcome');
    const unchanged = (await readRuns()).find(r => r.id === run.id);
    check('pending keeps running', unchanged?.status === 'running');
  }

  await reset();

  {
    const job = await enqueueJob({ flow: 'shell-nav', objective: 'o', url: 'http://localhost', projectId: 'p1', requestedBy: 'u1', headless: true, timeout: 60, reason: 't' });
    const run = await makeRun(job.id);
    const claim = await claimNextJob({ runnerId: 'r1' });
    const { record, result } = rec(claim!, 'failed', 'failed summary');
    await completeJobAtomically({ job: claim!, runnerId: 'r1', record, result, outcome: 'failed', jobStatus: 'failed', finishedAt: record.finishedAt! });
    await reconcileAgentRunForVerification(job.id, 'failed', 'failed summary');
    const second = await reconcileAgentRunForVerification(job.id, 'failed', 'failed summary');
    check('second reconciliation idempotent', second.reason === 'already_reconciled');
  }

  await reset();

  {
    const job = await enqueueJob({ flow: 'shell-nav', objective: 'o', url: 'http://localhost', projectId: 'p1', requestedBy: 'u1', headless: true, timeout: 60, reason: 't' });
    const run = await createRun('manual');
    await updateRun(run.id, { verificationId: 'other-id' });
    const recon = await reconcileAgentRunForVerification(job.id, 'failed', 'x');
    check('mismatched id not updated', recon.reason === 'no_associated_run');
  }

  await reset();

  {
    const job = await enqueueJob({ flow: 'shell-nav', objective: 'o', url: 'http://localhost', projectId: 'p1', requestedBy: 'u1', headless: true, timeout: 60, reason: 't' });
    const run = await createRun('manual');
    await updateRun(run.id, { verificationId: 'newer-id', status: 'completed' });
    const recon = await reconcileAgentRunForVerification(job.id, 'failed', 'x');
    check('newer association preserved', recon.reason === 'no_associated_run');
    const unchanged = (await readRuns()).find(r => r.id === run.id);
    check('newer run unchanged', unchanged?.verificationId === 'newer-id' && unchanged?.status === 'completed');
  }

  await reset();

  {
    const job = await enqueueJob({ flow: 'shell-nav', objective: 'o', url: 'http://localhost', projectId: 'p1', requestedBy: 'u1', headless: true, timeout: 60, reason: 't' });
    const run = await makeRun(job.id);
    const claim = await claimNextJob({ runnerId: 'r1' });
    const { record, result } = rec(claim!, 'failed', 'recovery summary');
    await completeJobAtomically({ job: claim!, runnerId: 'r1', record, result, outcome: 'failed', jobStatus: 'failed', finishedAt: record.finishedAt! });
    await updateRun(run.id, { status: 'running', verificationOutcome: 'pending' });
    const recovery = await recoverStaleAgentRunForVerification(run.id, job.id);
    check('historical recovery succeeds', recovery.updated === true);
    const recovered = (await readRuns()).find(r => r.id === run.id);
    check('recovered run failed', recovered?.status === 'failed');
  }

  console.log(`\n${passed} checks passed`);
}


main().catch((e) => { console.error(e); process.exit(1); });
