/**
 * Deterministic runner completion protocol tests (file fallback, no DB required).
 * Run: npx tsx scripts/test-runner-completion-protocol.ts
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import assert from 'node:assert/strict';
import { enqueueJob, claimNextJob, getJob, updateJob, __unsafeWriteJobsForTests } from '@/lib/verification/jobs';
import { __unsafeWriteVerificationRecordsForTests, readVerificationRecords } from '@/lib/verification/store';
import { completeJobAtomically } from '@/lib/verification/completion';
import type { VerificationRecord, VerificationJobResult } from '@/types/verification';

let passed=0; function check(n:string,c:unknown){assert.ok(c,n); passed++; console.log(`PASS ${n}`);}
async function reset(){ for(let i=0;i<5;i++){ try{ await __unsafeWriteJobsForTests([]); await __unsafeWriteVerificationRecordsForTests([]); return;}catch(e){ if(i===4) throw e; await new Promise(r=>setTimeout(r,50)); } } }
function rec(job:any, outcome:'failed'|'passed'='failed', summary='s'): {record:VerificationRecord; result:VerificationJobResult} {
  const finishedAt=new Date().toISOString();
  return {
    record:{ id:job.id, jobId:job.id, flow:job.flow, objective:job.objective, url:job.url, outcome, summary, startedAt:job.startedAt||job.createdAt, finishedAt, source:'runner', projectId:job.projectId, requestedBy:job.requestedBy },
    result:{ outcome, summary, finishedAt, startedAt:job.startedAt||job.createdAt, exitCode: outcome==='passed'?0:1 }
  };
}

async function main(){
  await reset();
  // claim generation changes on reclaim
  {
    const job=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'});
    const c1=await claimNextJob({runnerId:'r1'}); check('first claim gen >=1', (c1?.claimGeneration??0)>=1);
    await updateJob(job.id,{leaseExpiresAt:new Date(Date.now()-1000).toISOString()});
    const c2=await claimNextJob({runnerId:'r2'}); check('reclaim increments generation', (c2?.claimGeneration??0) > (c1?.claimGeneration??0));
  }

  await reset();
  // old generation cannot complete
  {
    const job=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'});
    const c1=await claimNextJob({runnerId:'r1'});
    await updateJob(job.id,{leaseExpiresAt:new Date(Date.now()-1000).toISOString()});
    const c2=await claimNextJob({runnerId:'r2'});
    const {record,result}=rec(c1!,'failed','stale');
    let err:any; try{ await completeJobAtomically({job:c1!,runnerId:'r1',record,result,outcome:'failed',jobStatus:'failed',finishedAt:record.finishedAt!}); }catch(e){err=e;}
    check('old generation cannot complete', !!err);
    const {record:r2,result:res2}=rec(c2!,'passed','fresh');
    const ok=await completeJobAtomically({job:c2!,runnerId:'r2',record:r2,result:res2,outcome:'passed',jobStatus:'completed',finishedAt:r2.finishedAt!});
    check('new generation can complete', ok.job.status==='completed');
  }

  await reset();
  // wrong runner cannot complete
  {
    const job=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'});
    const c1=await claimNextJob({runnerId:'r1'});
    const {record,result}=rec(c1!);
    let err:any; try{ await completeJobAtomically({job:c1!,runnerId:'r2',record,result,outcome:'failed',jobStatus:'failed',finishedAt:record.finishedAt!}); }catch(e){err=e;}
    check('wrong runner cannot complete', !!err);
  }

  await reset();
  // expired lease cannot complete
  {
    const job=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'});
    const c1=await claimNextJob({runnerId:'r1'});
    await updateJob(job.id,{leaseExpiresAt:new Date(Date.now()-1000).toISOString()});
    const fresh=await getJob(job.id);
    const {record,result}=rec(fresh!);
    let err:any; try{ await completeJobAtomically({job:fresh!,runnerId:'r1',record,result,outcome:'failed',jobStatus:'failed',finishedAt:record.finishedAt!}); }catch(e){err=e;}
    check('expired lease cannot complete', !!err);
  }

  await reset();
  // identical retry idempotent
  {
    const c1=await claimNextJob({runnerId:'r1'});
    if(!c1){ const j=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'}); }
  }
  await reset();
  {
    const j=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'});
    const c1=await claimNextJob({runnerId:'r1'});
    const {record,result}=rec(c1!,'failed','same');
    const a=await completeJobAtomically({job:c1!,runnerId:'r1',record,result,outcome:'failed',jobStatus:'failed',finishedAt:record.finishedAt!});
    const b=await completeJobAtomically({job:c1!,runnerId:'r1',record,result,outcome:'failed',jobStatus:'failed',finishedAt:record.finishedAt!});
    check('identical retry idempotent', a.idempotent===false && b.idempotent===true);
    const recs=await readVerificationRecords({requestedBy:'u1',includeLegacy:false});
    check('identical retry does not duplicate record', recs.length===1);
  }

  await reset();
  // conflicting retry rejected
  {
    const j=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'});
    const c1=await claimNextJob({runnerId:'r1'});
    const {record,result}=rec(c1!,'failed','fail');
    await completeJobAtomically({job:c1!,runnerId:'r1',record,result,outcome:'failed',jobStatus:'failed',finishedAt:record.finishedAt!});
    const {record:r2,result:res2}=rec(c1!,'passed','pass');
    let err:any; try{ await completeJobAtomically({job:c1!,runnerId:'r1',record:r2,result:res2,outcome:'passed',jobStatus:'completed',finishedAt:r2.finishedAt!}); }catch(e){err=e;}
    check('conflicting retry rejected', !!err);
    const recs=await readVerificationRecords({requestedBy:'u1',includeLegacy:false});
    check('conflicting retry did not overwrite', recs[0].outcome==='failed');
  }

  await reset();
  // two concurrent completions - deterministic simulation by sequence: first wins, second loses
  {
    const j=await enqueueJob({flow:'shell-nav',objective:'o',url:'http://localhost',projectId:'p1',requestedBy:'u1',headless:true,timeout:60,reason:'t'});
    const c1=await claimNextJob({runnerId:'r1'});
    assert.ok(c1, 'job should be claimed for concurrent completion test');
    const p1rec=rec(c1,'failed','r1');
    const p2rec=rec(c1,'passed','r2'); // wrong runner
    const ok=await completeJobAtomically({job:c1,runnerId:'r1',record:p1rec.record,result:p1rec.result,outcome:'failed',jobStatus:'failed',finishedAt:p1rec.record.finishedAt!});
    let err:any; try{ await completeJobAtomically({job:c1,runnerId:'r2',record:p2rec.record,result:p2rec.result,outcome:'passed',jobStatus:'completed',finishedAt:p2rec.record.finishedAt!}); }catch(e){err=e;}
    check('concurrent completion: second runner rejected', ok.job.status==='failed' && !!err);
  }

  console.log(`\n${passed} checks passed`);
}
main().catch(e=>{console.error(e); process.exit(1);});
