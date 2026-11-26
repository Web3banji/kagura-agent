/**
 * Runner processing/drain HTTP handler authz regression tests (deterministic, mocked deps, no DB).
 * Exercises real route handler in src/app/api/runner/[...path]/route.ts.
 * Run: node --experimental-test-module-mocks --require ./scripts/patch-alias.cjs --import file:///C:/Users/HP/AppData/Local/npm-cache/_npx/fd45a72a545557e9/node_modules/tsx/dist/esm/index.mjs scripts/test-runner-drain-http-authz.ts
 */
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
process.env.KAGURA_RUNNER_TOKEN = 'test-runner-token';

const outboxWorkerPath = pathToFileURL(path.resolve('src/lib/verification/outbox-worker.ts')).href;
const calls: any[] = [];
(globalThis as any).__drainResult = { drained: 0, processed: 0, failed: 0, retried: 0, skipped: 0, investigationIds: [], state: 'processed' };
(globalThis as any).__drainImpl = null;
mock.module(outboxWorkerPath, {
  namedExports: {
    drainVerificationProcessingOutbox: async (opts: any) => {
      calls.push(opts);
      const impl = (globalThis as any).__drainImpl;
      if (impl) return impl(opts);
      return (globalThis as any).__drainResult;
    },
  },
});

async function main() {
  const mod = await import('../src/app/api/runner/[...path]/handler.ts');
  async function call(body: any, headers: Record<string, string> = {}) {
    const req = new Request('http://localhost/api/runner/processing/drain', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const res = await mod.POST(req, { params: { path: ['processing', 'drain'] } } as any);
    let json: any; try { json = await res.json(); } catch { json = {}; }
    return { status: res.status, json };
  }

  let passed = 0;
  const check = (n: string, c: any) => { assert.ok(c, n); passed++; console.log('PASS ' + n); };

  // Missing/invalid auth
  calls.length = 0;
  (globalThis as any).__drainImpl = async () => { throw new Error('should not be called'); };
  let r = await call({}, {});
  check('missing runner auth -> 401', r.status === 401);
  check('missing auth did not drain', calls.length === 0);
  r = await call({}, { 'x-runner-token': 'wrong' });
  check('invalid runner auth -> 401', r.status === 401);
  check('invalid auth did not drain', calls.length === 0);

  // Authorized invocation - passes args through
  calls.length = 0;
  (globalThis as any).__drainImpl = null;
  (globalThis as any).__drainResult = { drained: 1, processed: 1, failed: 0, retried: 0, skipped: 0, investigationIds: ['i1'], state: 'processed' };
  r = await call({ workerId: 'w1', jobId: 'j1', claimGeneration: 2, limit: 3 }, { 'x-runner-token': 'test-runner-token' });
  check('authorized drain -> 200', r.status === 200 && r.json.ok === true);
  check('drain args passed through', calls.length === 1 && calls[0].workerId === 'w1' && calls[0].jobId === 'j1' && calls[0].claimGeneration === 2 && calls[0].limit === 3);
  check('drain result returned', r.json.drained === 1 && r.json.processed === 1 && JSON.stringify(r.json.investigationIds) === JSON.stringify(['i1']));

  // Idempotent/repeated drain
  calls.length = 0;
  let n = 0;
  (globalThis as any).__drainImpl = async () => { n++; return { drained: n === 1 ? 1 : 0, processed: n === 1 ? 1 : 0, failed: 0, retried: 0, skipped: n === 1 ? 0 : 1, investigationIds: [], state: 'processed' }; };
  r = await call({ jobId: 'j1', claimGeneration: 2, limit: 1 }, { 'x-runner-token': 'test-runner-token' });
  const r2 = await call({ jobId: 'j1', claimGeneration: 2, limit: 1 }, { 'x-runner-token': 'test-runner-token' });
  check('repeated drain first call 200', r.status === 200 && r.json.ok === true);
  check('repeated drain second call 200 idempotent', r2.status === 200 && r2.json.ok === true && r2.json.skipped === 1);

  // Stale/mismatched claim generation
  (globalThis as any).__drainImpl = async () => { throw new Error('Claim generation mismatch'); };
  r = await call({ jobId: 'j1', claimGeneration: 1 }, { 'x-runner-token': 'test-runner-token' });
  check('mismatched claim generation surfaces error', r.status === 500 && /claim generation mismatch/i.test(String(r.json.error || '')));

  // Defaults
  calls.length = 0;
  (globalThis as any).__drainImpl = null;
  (globalThis as any).__drainResult = { drained: 0, processed: 0, failed: 0, retried: 0, skipped: 0, investigationIds: [], state: 'idle' };
  r = await call({}, { 'x-runner-token': 'test-runner-token' });
  check('default drain 200', r.status === 200);
  check('default limit applied', calls.length === 1 && calls[0].limit === 5);
  check('missing optional ids undefined', calls[0].jobId === undefined && calls[0].claimGeneration === undefined);

  console.log(`\n${passed} checks passed (runner processing/drain HTTP handler tests, mocked deps, no DB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
