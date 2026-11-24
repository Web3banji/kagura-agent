/**
 * Focused story ownership/reassignment tests (non-destructive, in-memory KV/local override).
 * Run: npx tsx scripts/test-story-ownership.ts
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import assert from 'node:assert/strict';
import { __unsafeWriteStoriesForTests, getStoryById, upsertStory } from '@/lib/stories/store';
import type { Story } from '@/types/story';

let passed = 0;
function check(name: string, cond: unknown) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }

function story(over: Partial<Story> = {}): Story {
  return {
    id: 's1', userId: 'u1', projectId: 'p1', slug: 's1', title: 'T', subtitle: 'S', body: 'B',
    status: 'draft', source: { repo: 'r', observationSource: 'none', commits: [] }, tags: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  } as Story;
}

async function main() {
  await __unsafeWriteStoriesForTests([story()]);
  const u1 = { userId: 'u1', privileged: false, includeLegacy: false } as any;
  const u2 = { userId: 'u2', privileged: false, includeLegacy: false } as any;

  const own = await getStoryById('s1', u1);
  check('owner can read own story', own?.id === 's1');
  const crossRead = await getStoryById('s1', u2);
  check('cross-user read denied/hidden', crossRead === undefined);

  let threw = false;
  try { await upsertStory({ ...story(), title: 'hijack' }, u2); } catch { threw = true; }
  check('cross-user mutation denied', threw);

  threw = false;
  try { await upsertStory({ ...story(), userId: 'u2' }, u1); } catch { threw = true; }
  check('owner reassignment denied for non-privileged', threw);

  threw = false;
  try { await upsertStory({ ...story(), projectId: 'p2' }, u1); } catch { threw = true; }
  check('project reassignment denied for non-privileged', threw);

  const ok = await upsertStory({ ...story(), title: 'ok' }, u1);
  check('same-owner update allowed', ok.title === 'ok' && ok.userId === 'u1' && ok.projectId === 'p1');

  console.log(`\n${passed} checks passed`);
}
main().catch(e => { console.error(e); process.exit(1); });
