/**
 * Investigation HTTP handler authz regression tests (deterministic, mocked deps, no DB).
 * Exercises real route handlers in src/app/api/investigations/[[...path]]/route.ts.
 * Run: node --require ./scripts/patch-alias.cjs --import file:///C:/Users/HP/AppData/Local/npm-cache/_npx/fd45a72a545557e9/node_modules/tsx/dist/esm/index.mjs scripts/test-investigations-http-authz.ts
 */
import assert from 'node:assert/strict';
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;

const invs = new Map();
const recs = new Map();
const repoConns = new Map();
(globalThis as any).__testInvestigations = invs;
(globalThis as any).__testVerificationRecords = recs;
(globalThis as any).__testRepoConnections = repoConns;
(globalThis as any).__testResolveRepo = null;
(globalThis as any).__testProcessVerificationResult = null;

const userA = { id: 'uA', name: 'A', email: null, image: null, githubId: null, githubLogin: null, isBootstrapOwner: false };
const userB = { id: 'uB', name: 'B', email: null, image: null, githubId: null, githubLogin: null, isBootstrapOwner: false };
const pA = { authorized: true, kind: 'user', userId: 'uA', user: userA };
const pB = { authorized: true, kind: 'user', userId: 'uB', user: userB };
(globalThis as any).__testPrincipal = { authorized: false, kind: 'anonymous', userId: 'anonymous', reason: 'Unauthorized' };

function inv(over: any = {}) {
  return {
    id: 'iA', ownerUserId: 'uA', projectId: 'pA', repositoryConnectionId: 'rcA',
    title: 'T', category: 'product', technicalExplanation: 'te', simpleExplanation: 'se',
    rootCause: null, affectedAreas: null, expectedBehaviour: null, actualBehaviour: null,
    severity: 'medium', status: 'open', verificationReferences: [], evidenceReferences: null,
    aiFixPrompt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
function rec(over: any = {}) {
  return { id: 'vA', flow: 'shell-nav', objective: 'o', url: 'http://localhost:3000', outcome: 'failed', source: 'runner', requestedBy: 'uA', projectId: 'pA', investigationIds: [], ...over };
}

async function main() {
  const mod = await import('../src/app/api/investigations/[[...path]]/route.ts');
  async function call(method: 'GET'|'POST'|'PATCH', pathArr: string[], body: any, p: any, query='') {
    (globalThis as any).__testPrincipal = p;
    const url = 'http://localhost/api/investigations' + (pathArr.length ? '/' + pathArr.join('/') : '') + query;
    const init: any = { method, headers: { 'content-type': 'application/json' } };
    if (method !== 'GET') init.body = JSON.stringify(body);
    const req = new Request(url, init);
    const ctx = { params: { path: pathArr } } as any;
    const res = method === 'GET' ? await mod.GET(req, ctx) : method === 'POST' ? await mod.POST(req, ctx) : await mod.PATCH(req, ctx);
    let json: any; try { json = await res.json(); } catch { json = {}; }
    return { status: res.status, json };
  }

  let passed = 0;
  const check = (n: string, c: any) => { assert.ok(c, n); passed++; console.log('PASS ' + n); };

  // Unauthenticated
  invs.clear(); invs.set('iA', inv());
  for (const [m, path, body] of [['GET', [], undefined], ['GET',['iA'],undefined], ['POST',[],{title:'t',technicalExplanation:'te',simpleExplanation:'se',category:'product',severity:'medium',status:'open'}], ['POST',['reprocess'],{verificationId:'vA'}], ['PATCH',['iA'],{title:'x'}], ['POST',['iA'],{verificationId:'vA',outcome:'failed',detectedAt:'2026-01-01T00:00:00Z'}]] as any[]) {
    const r = await call(m, path, body, { authorized:false, kind:'anonymous', userId:'anonymous', reason:'Unauthorized' });
    check(`unauth ${m} /investigations/${path.join('/')} -> 401`, r.status === 401);
  }

  // Cross-owner non-disclosing reads/mutations
  invs.clear(); invs.set('iA', inv()); recs.clear(); recs.set('vA', rec());
  let r = await call('GET', ['iA'], undefined, pB);
  check('B GET A investigation -> 404', r.status === 404);
  const beforePatch = structuredClone(invs.get('iA'));
  r = await call('PATCH', ['iA'], { title: 'HACK', ownerUserId:'uB', projectId:'pB' }, pB);
  check('B PATCH A -> 404', r.status === 404);
  check('B PATCH A no mutation', JSON.stringify(invs.get('iA')) === JSON.stringify(beforePatch));
  const beforeAppend = structuredClone(invs.get('iA'));
  r = await call('POST', ['iA'], { verificationId:'vA', outcome:'failed', detectedAt:'2026-01-01T00:00:00Z', ownerUserId:'uB' }, pB);
  check('B append ref A -> 404', r.status === 404);
  check('B append ref no mutation', JSON.stringify(invs.get('iA')) === JSON.stringify(beforeAppend));

  // Same-owner GET/PATCH ok, ownership immutable
  invs.clear(); invs.set('iA', inv());
  r = await call('GET', ['iA'], undefined, pA);
  check('A GET own -> 200', r.status === 200 && r.json.investigation?.id === 'iA');
  r = await call('PATCH', ['iA'], { title: 'New', ownerUserId:'uB', projectId:'pB', repositoryConnectionId:'rcB' }, pA);
  check('A PATCH own -> 200', r.status === 200);
  check('PATCH cannot change owner/project/repo', invs.get('iA').ownerUserId==='uA' && invs.get('iA').projectId==='pA' && invs.get('iA').repositoryConnectionId==='rcA');
  check('PATCH changed allowed field', invs.get('iA').title === 'New');

  // Reprocess: cross-owner verification record non-disclosing/no mutation
  invs.clear(); recs.clear();
  recs.set('vA', rec({ requestedBy:'uA', investigationIds: [] }));
  const recBefore = structuredClone(recs.get('vA'));
  r = await call('POST', ['reprocess'], { verificationId:'vA' }, pB);
  check('B reprocess A record -> 404', r.status === 404);
  check('B reprocess no mutation', JSON.stringify(recs.get('vA')) === JSON.stringify(recBefore));

  // Reprocess: client-supplied owner/project/repo not trusted, uses trusted resolver
  invs.clear(); recs.clear();
  recs.set('vA', rec({ requestedBy:'uA', projectId:'pA', investigationIds: [], investigationProcessing: undefined }));
  let resolverCalls: any[] = [];
  let processorCalls: any[] = [];
  (globalThis as any).__testResolveRepo = async (projectId: any, requestedBy: any) => { resolverCalls.push({projectId,requestedBy}); return 'trusted-rc'; };
  (globalThis as any).__testProcessVerificationResult = async (record: any, opts: any) => { processorCalls.push({recordOwner: record.requestedBy, recordProject: record.projectId, opts}); return { action:'created', investigations:[{id:'i-new'}] }; };
  r = await call('POST', ['reprocess'], { verificationId:'vA', ownerUserId:'uB', requestedBy:'uB', projectId:'pB', repositoryConnectionId:'rc-evil' }, pA);
  check('owner reprocess 200', r.status === 200);
  check('resolver used trusted record owner/project', resolverCalls.length===1 && resolverCalls[0].projectId==='pA' && resolverCalls[0].requestedBy==='uA');
  check('processor received trusted context', processorCalls.length===1 && processorCalls[0].opts.ownerUserId==='uA' && processorCalls[0].opts.projectId==='pA' && processorCalls[0].opts.repositoryConnectionId==='trusted-rc');

  // Reprocess: no active repo link case -> trusted null
  invs.clear(); recs.clear(); resolverCalls=[]; processorCalls=[];
  recs.set('vA', rec({ requestedBy:'uA', projectId:'pA', investigationIds: [] }));
  (globalThis as any).__testResolveRepo = async (projectId: any, requestedBy: any) => { resolverCalls.push({projectId,requestedBy}); return null; };
  (globalThis as any).__testProcessVerificationResult = async (_record: any, opts: any) => { processorCalls.push(opts); return { action:'skipped', investigations:[] }; };
  r = await call('POST', ['reprocess'], { verificationId:'vA' }, pA);
  check('reprocess with no active repo link 200', r.status === 200);
  check('processor received repositoryConnectionId null', processorCalls.length===1 && processorCalls[0].repositoryConnectionId === null);

  // Reprocess missing id / missing record
  (globalThis as any).__testResolveRepo = null; (globalThis as any).__testProcessVerificationResult = null;
  r = await call('POST', ['reprocess'], {}, pA);
  check('reprocess missing verificationId -> 400', r.status === 400);
  recs.clear();
  r = await call('POST', ['reprocess'], { verificationId:'missing' }, pA);
  check('reprocess missing record -> 404', r.status === 404);

  // Append verification reference: must not cross project/owner
  invs.clear(); recs.clear();
  invs.set('iA', inv({ ownerUserId:'uA', projectId:'pA' }));
  recs.set('vB', rec({ id:'vB', requestedBy:'uB', projectId:'pB' }));
  r = await call('POST', ['iA'], { verificationId:'vB', outcome:'failed', detectedAt:'2026-01-01T00:00:00Z' }, pA);
  check('append foreign verification ref rejected', r.status === 404 || r.status === 403);
  check('append foreign verification no mutation', (invs.get('iA').verificationReferences || []).length === 0);

  console.log(`\n${passed} checks passed (investigations HTTP handler tests, mocked deps, no DB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
