const {Pool} = require('pg');
const cs = process.env.DATABASE_URL;
if (!cs) { console.error('No DATABASE_URL'); process.exit(1); }
const p = new Pool({connectionString: cs, ssl: {rejectUnauthorized: false}});
(async () => {
  try {
    const c = await p.connect();
    const userId = 'test-user-' + Date.now();
    const projectId = 'test-project-' + Date.now();
    const connId = 'test-conn-' + Date.now();
    
    // Create user first
    await c.query(`INSERT INTO users (id, github_login) VALUES ($1, $2)`, [userId, 'testuser']);
    console.log('User created');
    
    // Create project
    await c.query(`INSERT INTO projects (id, owner_user_id, name, slug) VALUES ($1, $2, $3, $4)`, [projectId, userId, 'test-project', 'test-project']);
    console.log('Project created');
    
    // Create repo connection
    await c.query(`INSERT INTO repository_connections (id, owner_user_id, github_repo_id, repo_owner, repo_name, full_name) VALUES ($1, $2, $3, $4, $5, $6)`, [connId, userId, '123', 'owner', 'repo', 'owner/repo']);
    console.log('Repo connection created');
    
    // Insert first link
    await c.query(
      `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at)
       VALUES ($1,$2,$3,$4,'active',NOW())`,
      ['test-id-1', projectId, connId, userId]
    );
    console.log('First insert succeeded');
    
    // Try second insert (should fail)
    try {
      await c.query(
        `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at)
         VALUES ($1,$2,$3,$4,'active',NOW())`,
        ['test-id-2', projectId, connId, userId]
      );
      console.log('Second insert succeeded (UNEXPECTED - should have failed)');
    } catch (e) {
      console.log('Second insert failed as expected:', e.code, e.message);
    }
    
    c.release();
  } catch (e) {
    console.error('DB connection failed:', e.message);
  } finally {
    await p.end();
  }
})();