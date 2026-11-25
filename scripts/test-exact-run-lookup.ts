process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRun, updateRun, findAgentRunByVerificationId } from '@/lib/agent/runs';

const RUNS_FILE = path.join(process.cwd(), 'data', 'agent', 'runs.json');
const INDEX_FILE = path.join(process.cwd(), 'data', 'agent', 'run-verification-index.json');

async function main() {
  await fs.promises.mkdir(path.dirname(RUNS_FILE), { recursive: true });
  await fs.promises.writeFile(RUNS_FILE, '[]', 'utf8');
  await fs.promises.writeFile(INDEX_FILE, '{}', 'utf8');

  let targetId = '';
  for (let i = 0; i < 55; i++) {
    const run = await createRun('manual');
    if (i === 0) {
      await updateRun(run.id, { verificationId: 'target-verification-id' });
      targetId = run.id;
    }
  }

  const found = await findAgentRunByVerificationId('target-verification-id');
  assert.ok(found, 'target run found');
  assert.equal(found.id, targetId, 'correct target run found');
  console.log('PASS exact lookup outside 50-run window');
}


main().catch((e) => { console.error(e); process.exit(1); });
