process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enqueueJob, claimNextJob, __unsafeWriteJobsForTests } from '@/lib/verification/jobs';
import { appendVerificationRecord, upsertVerificationRecord, readVerificationRecords, __unsafeWriteVerificationRecordsForTests } from '@/lib/verification/store';
import { completeJobAtomically } from '@/lib/verification/completion';
import type { VerificationRecord, VerificationJobResult } from '@/types/verification';

let passed = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  passed++;
  console.log(`PASS ${name}`);
}

async function reset() {
  await __unsafeWriteJobsForTests([]);
  await __unsafeWriteVerificationRecordsForTests([]);
}

function record(id: string, outcome: 'failed' | 'passed' = 'failed'): VerificationRecord {
  const now = new Date().toISOString();
  return {
    id,
    flow: 'shell-nav',
    objective: 'concurrency',
    url: 'http://localhost:3000',
    outcome,
    summary: id,
    startedAt: now,
    finishedAt: now,
    source: 'runner',
    projectId: 'p1',
    requestedBy: 'u1',
  };
}

async function main() {
  await reset();

  const appends = Array.from({ length: 25 }, (_, i) => appendVerificationRecord(record(`append-${i}`)));
  const upserts = Array.from({ length: 25 }, (_, i) => upsertVerificationRecord(record(`upsert-${i}`)));

  const job = await enqueueJob({ flow: 'shell-nav', objective: 'obj', url: 'http://localhost:3000', projectId: 'p1', requestedBy: 'u1', headless: true, timeout: 60, reason: 'concurrency' });
  const claimed = await claimNextJob({ runnerId: 'runner-a' });
  assert.ok(claimed && claimed.id === job.id, 'job should be claimed for concurrency test');
  const finishedAt = new Date().toISOString();
  const completionRecord: VerificationRecord = { ...record(job.id), jobId: job.id, outcome: 'failed' };
  const completionResult: VerificationJobResult = { outcome: 'failed', summary: 'completion', exitCode: 1, startedAt: finishedAt, finishedAt };
  const completion = completeJobAtomically({ job: claimed, runnerId: 'runner-a', record: completionRecord, result: completionResult, outcome: 'failed', jobStatus: 'failed', finishedAt });

  await Promise.all([...appends, ...upserts, completion]);

  const records = await readVerificationRecords({ projectId: 'p1', requestedBy: 'u1', includeLegacy: false });
  const ids = records.map((r) => r.id);
  const expected = [...Array.from({ length: 25 }, (_, i) => `append-${i}`), ...Array.from({ length: 25 }, (_, i) => `upsert-${i}`), job.id];

  check('all concurrent verification records survive', records.length === expected.length && ids.length === expected.length);
  check('concurrent verification records are unique', new Set(ids).size === ids.length);
  check('no expected verification record is missing', expected.every((id) => ids.includes(id)));
  check('completion record survives concurrent mutations', records.some((r) => r.id === job.id && r.outcome === 'failed'));

  const storeSource = readFileSync('src/lib/verification/store.ts', 'utf8');
  const completionSource = readFileSync('src/lib/verification/completion.ts', 'utf8');
  check('store mutations use the shared serialization helper', /export async function mutateVerificationRecords/.test(storeSource) && /kvMutate</.test(storeSource));
  check('file completion uses the shared record mutation helper', /mutateVerificationRecords\(fresh\.projectId/.test(completionSource));

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});