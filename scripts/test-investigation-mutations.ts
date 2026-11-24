/**
 * Focused investigation mutation authorization tests.
 * Run: npx tsx scripts/test-investigation-mutations.ts
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import assert from 'node:assert/strict';
import { __unsafeWriteInvestigationsForTests, createInvestigation, updateInvestigation, appendVerificationReference, getInvestigationById, readInvestigations } from '@/lib/investigations/store';

let passed = 0;
function check(name: string, cond: unknown) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }

async function main() {
  await __unsafeWriteInvestigationsForTests([]);
  const u1 = { userId:'u1', privileged:false, includeLegacy:false } as any;
  const u2 = { userId:'u2', privileged:false, includeLegacy:false } as any;

  const inv = await createInvestigation({ ownerUserId:'u1', projectId:'p1', title:'t', technicalExplanation:'te', simpleExplanation:'se', status:'open', verificationReferences:[], evidenceReferences:[] } as any);
  check('create investigation sets owner/project', inv.ownerUserId==='u1' && inv.projectId==='p1');

  const readU2 = await getInvestigationById(inv.id, u2);
  check('cross-owner read hidden', readU2 === undefined);

  const updCross = await updateInvestigation(inv.id, { title:'hijack', ownerUserId:'u2', projectId:'p2' } as any, u2);
  check('cross-owner update denied', updCross === undefined);

  const updOwner = await updateInvestigation(inv.id, { title:'ok', ownerUserId:'u2', projectId:'p2' } as any, u1);
  check('same-owner update cannot reassign owner/project', updOwner?.ownerUserId==='u1' && updOwner?.projectId==='p1' && updOwner?.title==='ok');

  const appCross = await appendVerificationReference(inv.id, { verificationId:'v2', outcome:'failed', detectedAt:new Date().toISOString(), failingStep:'step' } as any, u2);
  check('cross-owner append denied', appCross === undefined);

  const appOwn = await appendVerificationReference(inv.id, { verificationId:'v2', outcome:'failed', detectedAt:new Date().toISOString(), failingStep:'step' } as any, u1);
  check('same-owner append allowed', !!appOwn && appOwn.verificationReferences.some(r=>r.verificationId==='v2'));

  const listU1 = await readInvestigations(u1);
  const listU2 = await readInvestigations(u2);
  check('lists scoped by owner', listU1.length===1 && listU2.length===0);

  console.log(`\n${passed} checks passed`);
}
main().catch(e => { console.error(e); process.exit(1); });
