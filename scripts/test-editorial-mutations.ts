/**
 * Focused editorial mutation authorization tests (store/logic level, no fake sessions).
 * Exercises actual mutation constraints used by editorial handlers.
 * Run: npx tsx scripts/test-editorial-mutations.ts
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import assert from 'node:assert/strict';
import { __unsafeWriteStoriesForTests, getStoryById, upsertStory } from '@/lib/stories/store';
import type { Story } from '@/types/story';

let passed=0; function check(n:string,c:unknown){assert.ok(c,n);passed++;console.log(`PASS ${n}`)}
const u1={userId:'u1',privileged:false,includeLegacy:false} as any;
const u2={userId:'u2',privileged:false,includeLegacy:false} as any;
function story(over:Partial<Story>={}):Story{return {id:'s1',userId:'u1',projectId:'p1',slug:'slug-1',title:'T',subtitle:'S',body:'B',status:'review',source:{repo:'r',observationSource:'none',commits:[],changedFiles:[],observationSummary:'sum'},tags:['development'],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),...over} as Story}

async function main(){
  await __unsafeWriteStoriesForTests([story()]);
  // publish/update/reject/regenerate-equivalent mutations through upsertStory scope checks
  let threw=false; try{await upsertStory({...story(),status:'published',publishedAt:new Date().toISOString()},u2);}catch{threw=true;}
  check('cross-user publish denied', threw);
  threw=false; try{await upsertStory({...story(),status:'rejected',rejectedAt:new Date().toISOString()},u2);}catch{threw=true;}
  check('cross-user reject denied', threw);
  threw=false; try{await upsertStory({...story(),title:'X'},u2);}catch{threw=true;}
  check('cross-user update denied', threw);
  threw=false; try{await upsertStory({...story(),body:'regen',status:'review'},u2);}catch{threw=true;}
  check('cross-user regenerate-equivalent denied', threw);
  threw=false; try{await upsertStory({...story(),userId:'u2',projectId:'p2',status:'published'},u1);}catch{threw=true;}
  check('owner/project reassignment denied', threw);
  const ok = await upsertStory({...story(),status:'published',publishedAt:new Date().toISOString()},u1);
  check('same-owner publish allowed', ok.status==='published' && ok.userId==='u1' && ok.projectId==='p1');
  const crossRead = await getStoryById('s1',u2);
  check('cross-user editorial read hidden', crossRead===undefined);
  console.log(`\n${passed} checks passed (HTTP handler mutation paths not executed; store-level authz exercised)`);
}
main().catch(e=>{console.error(e);process.exit(1)});
