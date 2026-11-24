/**
 * Focused runner lifecycle authorization tests.
 * Run: npx tsx scripts/test-runner-lifecycle.ts
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { POST as runnerPost } from '@/app/api/runner/[...path]/route';
import { enqueueJob, claimNextJob, getJob, updateJob, __unsafeWriteJobsForTests } from '@/lib/verification/jobs';
import { __unsafeWriteVerificationRecordsForTests, readVerificationRecords } from '@/lib/verification/store';
import { __unsafeWriteInvestigationsForTests, readInvestigations } from '@/lib/investigations/store';

process.env.KAGURA_RUNNER_TOKEN = 'runner-token-test';

let passed = 0;
function check(name: string, cond: unknown) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }

async function call(path: string, body: any, token = 'runner-token-test') {
  const req = new NextRequest(`http://localhost/api/runner/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const res = await runnerPost(req, { params: { path: [path] } } as any);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function reset() {
  for (let i=0;i<5;i++) {
    try {
      await __unsafeWriteJobsForTests([]);
      await __unsafeWriteVerificationRecordsForTests([]);
      await __unsafeWriteInvestigationsForTests([]);
      return;
    } catch (e) {
      if (i===4) throw e;
      await new Promise(r=>setTimeout(r,50));
    }
  }
}

async function makeClaimed(owner='u1', project='p1', runner='runner-a') {
  const job = await enqueueJob({ flow:'shell-nav', objective:'obj', url:'http://localhost:3000', projectId:project, requestedBy:owner, headless:true, timeout:60, reason:'test' });
  const claimed = await claimNextJob({ runnerId: runner });
  assert.equal(claimed?.id, job.id);
  return claimed!;
}

async function main() {
  await reset();

  // missing auth
  {
    const job = await makeClaimed();
    const r = await call('complete', { jobId: job.id, runnerId:'runner-a', exitCode:1, runEnd:{status:'failed'} }, '');
    check('missing runner auth denied', r.status === 401);
  }

  await reset();
  // valid same-runner completion
  {
    const job = await makeClaimed('u1','p1','runner-a');
    const r = await call('complete', { jobId: job.id, runnerId:'runner-a', exitCode:1, runEnd:{status:'failed'}, summary:'fail', failingStep:'step' });
    check('valid same-runner completion accepted', r.status === 200 && r.json?.job?.status === 'failed');
    const recs = await readVerificationRecords({ requestedBy:'u1', includeLegacy:false });
    check('verification record stored for same owner', recs.length===1 && recs[0].requestedBy==='u1' && recs[0].projectId==='p1');
  }

  await reset();
  // wrong runner
  {
    const job = await makeClaimed('u1','p1','runner-a');
    const r = await call('complete', { jobId: job.id, runnerId:'runner-b', exitCode:1, runEnd:{status:'failed'} });
    check('wrong-runner completion denied', r.status === 403);
  }

  await reset();
  // wrong job
  {
    const a = await makeClaimed('u1','p1','runner-a');
    const b = await makeClaimed('u1','p1','runner-b');
    const r = await call('complete', { jobId: a.id, runnerId:'runner-b', exitCode:1, runEnd:{status:'failed'} });
    check('wrong-job completion denied', r.status === 403);
    assert.equal(b.status, 'claimed');
  }

  await reset();
  // expired claim
  {
    const job = await makeClaimed('u1','p1','runner-a');
    await updateJob(job.id, { leaseExpiresAt: new Date(Date.now()-1000).toISOString() });
    const r = await call('complete', { jobId: job.id, runnerId:'runner-a', exitCode:1, runEnd:{status:'failed'} });
    check('expired claim completion denied', r.status === 409);
  }

  await reset();
  // owner substitution attempt
  {
    const job = await makeClaimed('u1','p1','runner-a');
    const r = await call('complete', { jobId: job.id, runnerId:'runner-a', requestedBy:'u2', ownerUserId:'u2', exitCode:1, runEnd:{status:'failed'} });
    check('owner substitution attempt denied', r.status === 403);
  }

  await reset();
  // project substitution attempt
  {
    const job = await makeClaimed('u1','p1','runner-a');
    const r = await call('complete', { jobId: job.id, runnerId:'runner-a', projectId:'p2', exitCode:1, runEnd:{status:'failed'} });
    check('project substitution attempt denied', r.status === 403);
  }

  await reset();
  // verification record owner mismatch preexisting record
  {
    const job = await makeClaimed('u1','p1','runner-a');
    await __unsafeWriteVerificationRecordsForTests([{ id: job.id, jobId: job.id, flow:'shell-nav', objective:'o', url:'http://localhost:3000', outcome:'failed', startedAt:new Date().toISOString(), source:'runner', projectId:'p1', requestedBy:'u2' } as any]);
    const r = await call('complete', { jobId: job.id, runnerId:'runner-a', recordId: job.id, exitCode:1, runEnd:{status:'failed'}, summary:'x' });
    check('verification record owner mismatch denied/fails closed', r.status >= 400);
  }

  await reset();
  // duplicate completion replay should not create cross-owner mutations / should be idempotent
  {
    const job = await makeClaimed('u1','p1','runner-a');
    const body = { jobId: job.id, runnerId:'runner-a', exitCode:1, runEnd:{status:'failed'}, summary:'same fail', failingStep:'step A' };
    const r1 = await call('complete', body);
    const r2 = await call('complete', body);
    check('duplicate completion accepted as idempotent or safely rejected', r1.status===200 && (r2.status===200 || r2.status===409));
    const inv = await readInvestigations({ userId:'u1', privileged:false, includeLegacy:false } as any);
    check('duplicate completion does not duplicate cross-owner mutation', inv.every(i=>i.ownerUserId==='u1'));
  }

  await reset();
  // valid same-owner investigation processing
  {
    const job = await makeClaimed('u1','p1','runner-a');
    const r = await call('complete', { jobId: job.id, runnerId:'runner-a', exitCode:1, runEnd:{status:'failed'}, summary:'app defect', failingStep:'Click X' });
    check('completion with valid owner processed', r.status===200);
    const inv = await readInvestigations({ userId:'u1', privileged:false, includeLegacy:false } as any);
    check('investigation created for same owner', inv.length>=1 && inv[0].ownerUserId==='u1' && inv[0].projectId==='p1');
  }

  await reset();
  // stale runner cannot overwrite newer completion
  {
    const job = await makeClaimed('u1','p1','runner-a');
    await updateJob(job.id, { leaseExpiresAt: new Date(Date.now()-1000).toISOString() });
    const reclaimed = await claimNextJob({ runnerId: 'runner-b' });
    assert.equal(reclaimed?.claimedBy, 'runner-b');
    const stale = await call('complete', { jobId: job.id, runnerId:'runner-a', exitCode:1, runEnd:{status:'failed'}, summary:'stale' });
    check('stale runner cannot complete reclaimed job', stale.status === 403 || stale.status === 409);
    const fresh = await call('complete', { jobId: job.id, runnerId:'runner-b', exitCode:0, runEnd:{status:'passed'}, summary:'fresh pass' });
    check('new runner can complete reclaimed job', fresh.status === 200);
    const recs = await readVerificationRecords({ requestedBy:'u1', includeLegacy:false });
    check('new runner result preserved', recs.length===1 && recs[0].outcome === 'passed');
  }

  await reset();
  // conflicting replay payload after completion should not overwrite
  {
    const job = await makeClaimed('u1','p1','runner-a');
    const first = await call('complete', { jobId: job.id, runnerId:'runner-a', exitCode:1, runEnd:{status:'failed'}, summary:'fail-one', failingStep:'A' });
    const replayConflict = await call('complete', { jobId: job.id, runnerId:'runner-a', exitCode:0, runEnd:{status:'passed'}, summary:'conflicting' });
    check('conflicting replay rejected or cannot overwrite terminal result', first.status===200 && (replayConflict.status===409 || replayConflict.status===403 || replayConflict.status>=400));
    const recs = await readVerificationRecords({ requestedBy:'u1', includeLegacy:false });
    check('conflicting replay did not overwrite outcome', recs.length===1 && recs[0].outcome === 'failed');
  }

  await reset();
  // completed job cannot be reclaimed
  {
    const job = await makeClaimed('u1','p1','runner-a');
    const done = await call('complete', { jobId: job.id, runnerId:'runner-a', exitCode:1, runEnd:{status:'failed'}, summary:'done' });
    check('completion succeeds', done.status===200);
    const reclaimed = await claimNextJob({ runnerId:'runner-b' });
    check('completed job not reclaimable', reclaimed === null);
  }

  await reset();
  // pending job cannot be completed
  {
    const job = await enqueueJob({ flow:'shell-nav', objective:'obj', url:'http://localhost:3000', projectId:'p1', requestedBy:'u1', headless:true, timeout:60, reason:'test' });
    const r = await call('complete', { jobId: job.id, runnerId:'runner-a', exitCode:1, runEnd:{status:'failed'} });
    check('pending unclaimed job cannot be completed', r.status===403 || r.status===409);
  }

  console.log(`\n${passed} checks passed`);
}
main().catch(e => { console.error(e); process.exit(1); });
