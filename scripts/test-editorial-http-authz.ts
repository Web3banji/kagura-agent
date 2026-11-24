/**
 * Editorial HTTP handler authz regression tests (deterministic, mocked deps via loader, no DB).
 * Run: node --experimental-test-module-mocks --import ./scripts/register-editorial-mocks.mjs --import file:///C:/Users/HP/AppData/Local/npm-cache/_npx/fd45a72a545557e9/node_modules/tsx/dist/esm/index.mjs scripts/test-editorial-http-authz.ts
 */
import assert from 'node:assert/strict';
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;

const stories = new Map();
(globalThis as any).__testStories = stories;
const userA = { id: 'uA', name: 'A', email: null, image: null, githubId: null, githubLogin: null, isBootstrapOwner: false };
const pA = { authorized: true, kind: 'user', userId: 'uA', user: userA };
const pB = { authorized: true, kind: 'user', userId: 'uB', user: { ...userA, id:'uB', name:'B' } };
(globalThis as any).__testPrincipal = { authorized: false, kind: 'anonymous', userId: 'anonymous', reason: 'Unauthorized' };

function story(over: any={}){
  return { id:'sA', userId:'uA', projectId:'pA', slug:'slug-a', title:'TA', subtitle:'SA', body:'BA', status:'review', source:{repo:'r/a',observationSource:'none',commits:[],changedFiles:[],observationSummary:'sum'}, tags:['development'], createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z', ...over };
}

async function main(){
  const { POST } = await import('../src/app/api/editorial/[...path]/route.ts');
  async function call(pathArr: string[], body: any, p: any){
    (globalThis as any).__testPrincipal = p;
    const req = new Request('http://localhost/api/editorial/'+pathArr.join('/'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const res = await POST(req, { params: { path: pathArr } } as any);
    let json: any; try { json = await res.json(); } catch { json = {}; }
    return { status: res.status, json };
  }
  let passed=0; const check=(n:string,c:any)=>{ assert.ok(c,n); passed++; console.log('PASS '+n); };

  for (const ep of ['publish','reject','update','regenerate']) {
    stories.clear(); stories.set('sA', story());
    const before = structuredClone(stories.get('sA'));
    const r = await call([ep], {id:'sA'}, {authorized:false,kind:'anonymous',userId:'anonymous',reason:'Unauthorized'});
    check(`unauth POST /api/editorial/${ep} -> 401`, r.status===401);
    check(`unauth ${ep} no mutation`, JSON.stringify(stories.get('sA'))===JSON.stringify(before));
  }

  for (const ep of ['publish','reject','update','regenerate']) {
    stories.clear(); stories.set('sA', story());
    const before = structuredClone(stories.get('sA'));
    const r = await call([ep], {id:'sA', title:'HACK', subtitle:'H', body:'H', userId:'uB', projectId:'pB'}, pB);
    check(`B ${ep} A -> 404 non-disclosing`, r.status===404);
    check(`B ${ep} A no mutation`, JSON.stringify(stories.get('sA'))===JSON.stringify(before));
  }

  stories.clear(); stories.set('sA', story());
  let r = await call(['update'], {id:'sA', title:'New', userId:'uB', projectId:'pB', ownerUserId:'uB'}, pA);
  check('owner update 200', r.status===200);
  check('update owner/project immutable', stories.get('sA').userId==='uA' && stories.get('sA').projectId==='pA');
  check('update changed allowed field', stories.get('sA').title==='New');

  stories.clear(); stories.set('sA', story());
  r = await call(['regenerate'], {id:'sA', userId:'uB', projectId:'pB'}, pA);
  check('owner regenerate 200', r.status===200);
  check('regenerate preserves owner/project', stories.get('sA').userId==='uA' && stories.get('sA').projectId==='pA');

  stories.clear(); stories.set('sA', story());
  r = await call(['publish'], {}, pA);
  check('missing id -> 400', r.status===400);

  stories.clear(); stories.set('sA', story());
  r = await call(['publish'], {id:'sA'}, pA);
  check('owner publish 200', r.status===200 && stories.get('sA').status==='published');
  stories.clear(); stories.set('sA', story());
  r = await call(['reject'], {id:'sA'}, pA);
  check('owner reject 200', r.status===200 && stories.get('sA').status==='rejected');

  console.log(`\n${passed} checks passed (editorial HTTP handler tests, mocked deps, no DB)`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
