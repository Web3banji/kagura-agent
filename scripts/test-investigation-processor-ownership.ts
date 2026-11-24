/**
 * Focused ownership tests for processVerificationResult.
 * Run: npx tsx scripts/test-investigation-processor-ownership.ts
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import assert from 'node:assert/strict';
import { processVerificationResult } from '@/lib/investigations/processor';
import { __unsafeWriteInvestigationsForTests, readInvestigations } from '@/lib/investigations/store';
import type { VerificationRecord } from '@/types/verification';

let passed = 0;
function check(name: string, cond: unknown) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }

function rec(over: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    id: `ver-${Math.random().toString(36).slice(2)}`,
    flow: 'shell-nav',
    objective: 'Verify',
    url: 'http://localhost:3000',
    outcome: 'failed',
    exitCode: 1,
    summary: 'failed',
    failingStep: 'Click nav',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    source: 'runner',
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    projectId: 'p1',
    requestedBy: 'u1',
    evidencePath: 'data/verification/runs/x.ndjson',
    ...over,
  } as VerificationRecord;
}

async function main() {
  await __unsafeWriteInvestigationsForTests([]);

  // valid same-owner processing
  const ok = await processVerificationResult(rec({ requestedBy: 'u1', projectId: 'p1' }), { ownerUserId: 'u1', projectId: 'p1' });
  check('valid same-owner creates investigation', ok.action === 'created' && ok.investigations[0]?.ownerUserId === 'u1');

  // mismatched owner
  let threw = false;
  try { await processVerificationResult(rec({ requestedBy: 'u2', projectId: 'p1' }), { ownerUserId: 'u1', projectId: 'p1' }); } catch { threw = true; }
  check('mismatched owner fails closed', threw);

  // mismatched project
  threw = false;
  try { await processVerificationResult(rec({ requestedBy: 'u1', projectId: 'p2' }), { ownerUserId: 'u1', projectId: 'p1' }); } catch { threw = true; }
  check('mismatched project fails closed', threw);

  // existing investigation owned by another user cannot be modified
  await __unsafeWriteInvestigationsForTests([{
    id: 'inv-other', ownerUserId: 'u2', projectId: 'p1', title: 'other', category: 'other', technicalExplanation: 't', simpleExplanation: 's', rootCause: null, affectedAreas: null, expectedBehaviour: null, actualBehaviour: null, severity: 'low', status: 'open', firstDetectedAt: new Date().toISOString(), lastDetectedAt: new Date().toISOString(), verificationReferences: [{ verificationId: 'v-old', outcome: 'failed', detectedAt: new Date().toISOString(), failingStep: 'Click nav' }], evidenceReferences: null, aiFixPrompt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as any]);
  const cross = await processVerificationResult(rec({ requestedBy: 'u1', projectId: 'p1', failingStep: 'Click nav' }), { ownerUserId: 'u1', projectId: 'p1' });
  check('cross-owner existing investigation is not modified; creates separate owner-scoped investigation', cross.action === 'created' && cross.investigations[0]?.ownerUserId === 'u1');
  const allU2 = await readInvestigations({ userId: 'u2', privileged: false, includeLegacy: false } as any);
  check('u2 investigation remains owned by u2', allU2.length === 1 && allU2[0].ownerUserId === 'u2' && allU2[0].verificationReferences.length === 1);

  // missing owner
  threw = false;
  try { await processVerificationResult(rec({ requestedBy: 'u1' }), { ownerUserId: '' as any, projectId: 'p1' }); } catch { threw = true; }
  check('missing owner fails closed', threw);

  console.log(`\n${passed} checks passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
