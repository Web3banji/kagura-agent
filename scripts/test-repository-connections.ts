/**
 * Focused repository connection/linking authorization tests.
 * Run: npx tsx scripts/test-repository-connections.ts
 *
 * Covers deterministic, DB-absent behavior and static contract checks. DB-backed
 * transaction/race/constraint guarantees are NOT executed here.
 */
process.loadEnvFile('.env.local');
delete process.env.DATABASE_URL;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getRepositoryConnectionForUser,
  listRepositoryConnectionsForUser,
  findRepositoryConnectionByRepo,
  deleteRepositoryConnection,
  listRepositoryLinksForProject,
  listProjectsForRepositoryConnection,
  linkRepositoryToProject,
  unlinkRepositoryFromProject,
  createRepositoryConnection,
} from '@/lib/repositories/connections';

let passed=0; function check(n:string,c:unknown){assert.ok(c,n);passed++;console.log(`PASS ${n}`)}

async function main(){
  // DB-absent safe behavior
  check('getRepositoryConnectionForUser returns undefined when DB absent', (await getRepositoryConnectionForUser('c1','u1'))===undefined);
  check('listRepositoryConnectionsForUser returns empty when DB absent', (await listRepositoryConnectionsForUser('u1')).length===0);
  check('findRepositoryConnectionByRepo returns undefined when DB absent', (await findRepositoryConnectionByRepo('u1','github','123'))===undefined);
  check('deleteRepositoryConnection returns false when DB absent', (await deleteRepositoryConnection('c1','u1'))===false);
  check('listRepositoryLinksForProject returns empty when DB absent', (await listRepositoryLinksForProject('p1','u1')).length===0);
  check('listProjectsForRepositoryConnection returns empty when DB absent', (await listProjectsForRepositoryConnection('c1','u1')).length===0);
  check('unlinkRepositoryFromProject returns false when DB absent', (await unlinkRepositoryFromProject('p1','c1','u1'))===false);
  await assert.rejects(()=>createRepositoryConnection('u1',{githubRepoId:'1',repoOwner:'o',repoName:'r',fullName:'o/r'} as any), /Database not configured/);
  check('createRepositoryConnection fails closed without DB', true);
  await assert.rejects(()=>linkRepositoryToProject('p1','c1','u1'), /Database not configured/);
  check('linkRepositoryToProject fails closed without DB', true);

  // Static contract checks (not DB execution proof)
  const src = fs.readFileSync(path.join(process.cwd(),'src/lib/repositories/connections.ts'),'utf8');
  check('link query scopes project by owner', src.includes('SELECT id FROM projects WHERE id = $1 AND owner_user_id = $2'));
  check('link query scopes connection by owner', src.includes('SELECT id FROM repository_connections WHERE id = $1 AND owner_user_id = $2'));
  check('link uses transaction', src.includes('BEGIN') && src.includes('COMMIT') && src.includes('ROLLBACK'));
  check('link locks project row FOR UPDATE', src.includes('SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 FOR UPDATE'));
  check('link locks connection row FOR UPDATE', src.includes('SELECT 1 FROM repository_connections WHERE id = $1 AND owner_user_id = $2 FOR UPDATE'));
  check('link rejects active project duplicate', src.includes('Project already has an active repository linked'));
  check('link rejects active repo reassignment', src.includes('Repository is already assigned to another project'));

  const projectApi = fs.readFileSync(path.join(process.cwd(),'src/app/api/projects/[[...path]]/route.ts'),'utf8');
  check('project link route validates project ownership', projectApi.includes('SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1'));
  check('project link route validates connection ownership', projectApi.includes('getRepositoryConnectionForUser(repositoryConnectionId, user.id)'));
  check('project unlink route validates project ownership', projectApi.includes('Project not found') && projectApi.includes('Repository link not found'));

  const githubApi = fs.readFileSync(path.join(process.cwd(),'src/app/api/github/[[...path]]/route.ts'),'utf8');
  check('github connection delete scoped to principal', githubApi.includes('deleteRepositoryConnection(connectionId, principal.userId)'));

  console.log(`\n${passed} checks passed`);
  console.log('NOTE: DB-backed cross-owner link/link-race/transaction/constraint behavior NOT EXECUTED. Requires disposable PostgreSQL integration.');
}
main().catch(e=>{console.error(e);process.exit(1)});
