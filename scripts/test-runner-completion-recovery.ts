/**
 * Focused file-fallback completion recovery tests. Deterministic, no DB.
 * Run: npx tsx scripts/test-runner-completion-recovery.ts
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { enqueueJob, claimNextJob, getJob, updateJob, __unsafeWriteJobsForTests } from '@/lib/verification/jobs';
import { __unsafeWriteVerificationRecordsForTests, readVerificationRecords } from '@/lib/verification/store';
import { completeJobAtomically, recoverIncompleteCompletion } from '@/lib/verification/completion';
import type { VerificationRecord, VerificationJobResult } from '@/types/verification';

const RES = path.join(process.cwd(),'data','verification','completion-reservations.json');
let passed=0; function check(n:string,c:unknown){assert.ok(c,n); passed++; console.log(`PASS ${n}`);}
async function reset(){ for(let i=0;i<5;i++){ try{ await __unsafeWriteJobsForTests([]); await __unsafeWriteVerificationRecordsForTests([]); await fs.mkdir(path.dirname(RES),{recursive:true}); await fs.writeFile(RES,'[]','utf8'); return;}catch(e){ if(i===4) throw e; await new Promise(r=>setTimeout(r,50)); } } }
function rec(job:any, outcome:'failed'|'passed'='failed', summary='s'): {record:VerificationRecord; result:VerificationJobResult} {
  const finishedAt=new Date().toISOString();
  return { record:{ id:job.id, jobId:job.id, flow:job.flow, objective:job.objective, url:job.url, outcome, summary, startedAt:job.startedAt||job.createdAt, finishedAt, source:'runner', projectId:job.projectId, requestedBy:job.requestedBy }, result:{ outcome, summary, finishedAt, startedAt:job.startedAt||job.createdAt, exitCode: outcome==='passed'?0:1 } };
}

async function main(){
  await reset();
  // crash window: record persisted, job not finalized -> recovery finalizes same generation
  {
    const j=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'});
    const c=await claimNextJob({runnerId:'r1'});
    const {record,result}=rec(c!,'failed','fail');
    const norm=(x:unknown):unknown=>{ if(Array.isArray(x)) return x.map(norm); if(x&&typeof x==='object'){ const o:Record<string,unknown>={}; for(const k of Object.keys(x as Record<string,unknown>).sort()) o[k]=norm((x as Record<string,unknown>)[k]); return o; } return x; };
    const hashObj={ id: record.id, jobId: record.jobId, projectId: record.projectId ?? null, requestedBy: record.requestedBy ?? null, outcome:'failed', result, summary: record.summary ?? null, failingStep: record.failingStep ?? null, exitCode: record.exitCode ?? null };
    await fs.writeFile(RES, JSON.stringify([{jobId:j.id,runnerId:'r1',claimGeneration:c!.claimGeneration,recordId:j.id,outcome:'failed',payloadHash:JSON.stringify(norm(hashObj)),result,createdAt:new Date().toISOString(),status:'record_persisted'}],null,2));
    await __unsafeWriteVerificationRecordsForTests([record]);
    const r=await recoverIncompleteCompletion(j.id);
    check('recovery finalizes incomplete same-generation completion', r.recovered===true);
    const after=await getJob(j.id);
    check('job finalized after recovery', after?.status==='failed' && after?.recordId===j.id);
  }

  await reset();
  // reclaimed job invalidates old reservation
  {
    const j=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'});
    const c1=await claimNextJob({runnerId:'r1'});
    const {record,result}=rec(c1!,'failed','old');
    await fs.writeFile(RES, JSON.stringify([{jobId:j.id,runnerId:'r1',claimGeneration:c1!.claimGeneration,recordId:j.id,outcome:'failed',payloadHash:'x',createdAt:new Date().toISOString(),status:'record_persisted'}],null,2));
    await __unsafeWriteVerificationRecordsForTests([record]);
    await updateJob(j.id,{leaseExpiresAt:new Date(Date.now()-1000).toISOString()});
    const c2=await claimNextJob({runnerId:'r2'});
    check('reclaimed generation advanced', (c2!.claimGeneration??0)>(c1!.claimGeneration??0));
    const r=await recoverIncompleteCompletion(j.id);
    check('stale reservation not recovered after reclaim', r.recovered===false && r.reason==='generation_mismatch');
  }

  await reset();
  // conflicting payload hash does not recover
  {
    const j=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'});
    const c=await claimNextJob({runnerId:'r1'});
    const {record}=rec(c!,'failed','real');
    await __unsafeWriteVerificationRecordsForTests([record]);
    await fs.writeFile(RES, JSON.stringify([{jobId:j.id,runnerId:'r1',claimGeneration:c!.claimGeneration,recordId:j.id,outcome:'passed',payloadHash:'bad',createdAt:new Date().toISOString(),status:'record_persisted'}],null,2));
    const r=await recoverIncompleteCompletion(j.id);
    check('conflicting payload not recovered', r.recovered===false);
  }

  await reset();
  // repeated recovery is safe
  {
    const j=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'});
    const c=await claimNextJob({runnerId:'r1'});
    const {record,result}=rec(c!,'failed','fail');
    await __unsafeWriteVerificationRecordsForTests([record]);
    const norm=(x:unknown):unknown=>{ if(Array.isArray(x)) return x.map(norm); if(x&&typeof x==='object'){ const o:Record<string,unknown>={}; for(const k of Object.keys(x as Record<string,unknown>).sort()) o[k]=norm((x as Record<string,unknown>)[k]); return o; } return x; };
    const hashObj={ id: record.id, jobId: record.jobId, projectId: record.projectId ?? null, requestedBy: record.requestedBy ?? null, outcome:'failed', result, summary: record.summary ?? null, failingStep: record.failingStep ?? null, exitCode: record.exitCode ?? null };
    await fs.writeFile(RES, JSON.stringify([{jobId:j.id,runnerId:'r1',claimGeneration:c!.claimGeneration,recordId:j.id,outcome:'failed',payloadHash:JSON.stringify(norm(hashObj)),result,createdAt:new Date().toISOString(),status:'record_persisted'}],null,2));
    const r1=await recoverIncompleteCompletion(j.id);
    const r2=await recoverIncompleteCompletion(j.id);
    check('repeated recovery safe', r1.recovered===true && r2.recovered===false);
  }

  console.log(`\n${passed} checks passed`);
}
main().catch(e=>{console.error(e); process.exit(1);});
