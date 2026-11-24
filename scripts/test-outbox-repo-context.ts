/**
 * Focused repo-context resolution tests for outbox/investigation processing.
 * Run: npx tsx scripts/test-outbox-repo-context.ts
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import assert from 'node:assert/strict';
import { resolveActiveRepositoryConnectionId } from '@/lib/repositories/connections';
import { processVerificationResult } from '@/lib/investigations/processor';
import { __unsafeWriteInvestigationsForTests, readInvestigations } from '@/lib/investigations/store';
import type { VerificationRecord } from '@/types/verification';

let passed = 0;
function check(name: string, cond: unknown) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }

function rec(over: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    id: `ver-${Math.random().toString(36).slice(2)}`,
    flow: 'shell-nav', objective: 'Verify', url: 'http://localhost:3000',
    outcome: 'failed', exitCode: 1, summary: 'failed', failingStep: 'Click nav',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    source: 'runner', jobId: `job-${Math.random().toString(36).slice(2)}`,
    projectId: 'p1', requestedBy: 'u1', evidencePath: 'data/verification/runs/x.ndjson',
    ...over,
  } as VerificationRecord;
}

async function main() {
  // Resolver fail-closed behavior without trusted context/DB.
  check('null project returns null', await resolveActiveRepositoryConnectionId(null, 'u1') === null);
  check('null owner returns null', await resolveActiveRepositoryConnectionId('p1', null) === null);
  check('empty project returns null', await resolveActiveRepositoryConnectionId('', 'u1') === null);
  check('empty owner returns null', await resolveActiveRepositoryConnectionId('p1', '') === null);
  check('no DB configured returns null (fail-closed, no guess)', await resolveActiveRepositoryConnectionId('p1', 'u1') === null);

  // Investigation processing accepts trusted null repositoryConnectionId (no repo-linked project / no DB).
  await __unsafeWriteInvestigationsForTests([]);
  const res = await processVerificationResult(rec(), { ownerUserId: 'u1', projectId: 'p1', repositoryConnectionId: null });
  check('processing succeeds with trusted null repositoryConnectionId', res.action === 'created');
  const invs = await readInvestigations({ userId: 'u1', privileged: false, includeLegacy: false } as any);
  check('created investigation stores null repositoryConnectionId when none resolved', invs.length === 1 && invs[0].repositoryConnectionId == null);

  // Explicit trusted repositoryConnectionId is preserved on created investigation.
  await __unsafeWriteInvestigationsForTests([]);
  const res2 = await processVerificationResult(rec({ failingStep: 'Click submit' }), { ownerUserId: 'u1', projectId: 'p1', repositoryConnectionId: 'repo-conn-1' });
  check('processing preserves trusted repositoryConnectionId', res2.action === 'created' && res2.investigations[0].repositoryConnectionId === 'repo-conn-1');

  // Mismatched owner/project still fail closed even when repositoryConnectionId is supplied.
  let threw = false;
  try { await processVerificationResult(rec({ requestedBy: 'u2' }), { ownerUserId: 'u1', projectId: 'p1', repositoryConnectionId: 'repo-conn-1' }); } catch { threw = true; }
  check('mismatched owner fails closed with repositoryConnectionId present', threw);

  threw = false;
  try { await processVerificationResult(rec({ projectId: 'p2' }), { ownerUserId: 'u1', projectId: 'p1', repositoryConnectionId: 'repo-conn-1' }); } catch { threw = true; }
  check('mismatched project fails closed with repositoryConnectionId present', threw);

  console.log(`\n${passed} checks passed`);
}
main().catch(e => { console.error(e); process.exit(1); });
