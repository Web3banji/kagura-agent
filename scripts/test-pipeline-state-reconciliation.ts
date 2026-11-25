/**
 * Focused pipeline-state reconciliation tests (file fallback).
 * Run: npx tsx scripts/test-pipeline-state-reconciliation.ts
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { reconcilePipelineStateForVerification } from '@/lib/agent/runs';
import { getCurrentPipelineState, setPipelineState } from '@/lib/pipeline';

const STATE_FILE = path.join(process.cwd(), 'data', 'agent', 'pipeline-state.json');

let passed = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); }

async function resetState() {
  await fs.promises.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.promises.writeFile(STATE_FILE, JSON.stringify({ agentState: 'running', stage: 'VERIFY', note: 'queued', lastOutcome: 'blocked', lastError: 'queued', lastVerificationId: 'target-verification', lastDraftId: 'draft-1' }, null, 2), 'utf8');
}

async function main() {
  // failed
  await resetState();
  await reconcilePipelineStateForVerification('target-verification', 'failed', 'failed step');
  let state = await getCurrentPipelineState();
  check('failed updates agentState', state.agentState === 'failed');
  check('failed updates stage', state.stage === 'VERIFY');
  check('failed updates lastOutcome', state.lastOutcome === 'failed');
  check('failed updates lastError', state.lastError === 'failed step');
  check('failed preserves unrelated field', state.lastDraftId === 'draft-1');

  // passed
  await resetState();
  await reconcilePipelineStateForVerification('target-verification', 'passed', 'passed summary');
  state = await getCurrentPipelineState();
  check('passed updates agentState', state.agentState === 'completed');
  check('passed updates lastOutcome', state.lastOutcome === 'success');
  check('passed clears lastError', state.lastError === undefined);

  // blocked
  await resetState();
  await reconcilePipelineStateForVerification('target-verification', 'blocked', 'blocked summary');
  state = await getCurrentPipelineState();
  check('blocked maps to failed agentState', state.agentState === 'failed');
  check('blocked preserves lastOutcome blocked', state.lastOutcome === 'blocked');

  // did_not_start
  await resetState();
  await reconcilePipelineStateForVerification('target-verification', 'did_not_start', 'did not start');
  state = await getCurrentPipelineState();
  check('did_not_start maps to failed', state.agentState === 'failed');
  check('did_not_start maps lastOutcome blocked', state.lastOutcome === 'blocked');

  // timeout
  await resetState();
  await reconcilePipelineStateForVerification('target-verification', 'timeout', 'timeout');
  state = await getCurrentPipelineState();
  check('timeout maps to failed', state.agentState === 'failed');
  check('timeout maps lastOutcome failed', state.lastOutcome === 'failed');

  // pending does not terminate
  await resetState();
  const beforePending = await getCurrentPipelineState();
  await reconcilePipelineStateForVerification('target-verification', 'pending', 'pending');
  const afterPending = await getCurrentPipelineState();
  check('pending leaves state unchanged', JSON.stringify(beforePending) === JSON.stringify(afterPending));

  // running does not terminate
  await resetState();
  const beforeRunning = await getCurrentPipelineState();
  await reconcilePipelineStateForVerification('target-verification', 'running', 'running');
  const afterRunning = await getCurrentPipelineState();
  check('running leaves state unchanged', JSON.stringify(beforeRunning) === JSON.stringify(afterRunning));

  // mismatched id leaves snapshot unchanged
  await resetState();
  const beforeMismatch = await getCurrentPipelineState();
  await reconcilePipelineStateForVerification('different-verification', 'failed', 'failed');
  const afterMismatch = await getCurrentPipelineState();
  check('mismatched id leaves state unchanged', JSON.stringify(beforeMismatch) === JSON.stringify(afterMismatch));

  // idempotency
  await resetState();
  await reconcilePipelineStateForVerification('target-verification', 'failed', 'failed step');
  const first = await getCurrentPipelineState();
  await reconcilePipelineStateForVerification('target-verification', 'failed', 'failed step');
  const second = await getCurrentPipelineState();
  check('repeated reconciliation idempotent', JSON.stringify(first) === JSON.stringify(second));

  console.log(`\n${passed} checks passed`);
}


main().catch((e) => { console.error(e); process.exit(1); });
