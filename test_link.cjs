const {Pool} = require('pg');
const cs = process.env.DATABASE_URL;
if (!cs) { console.error('No DATABASE_URL'); process.exit(1); }
const p = new Pool({connectionString: cs, ssl: {rejectUnauthorized: false}});
let counter = 0;
function nextId() { return 'id-' + Date.now() + '-' + (++counter); }
(async () => {
  try {
    const c = await p.connect();
    const userId = 'test-user-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const projectId = 'test-project-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const connId = 'test-conn-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    
    // Create user first
    await c.query(`INSERT INTO users (id, github_login) VALUES ($1, $2)`, [userId, 'testuser']);
    console.log('User created');
    
    // Create project
    await c.query(`INSERT INTO projects (id, owner_user_id, name, slug) VALUES ($1, $2, $3, $4)`, [projectId, userId, 'test-project', 'test-project-' + Math.random().toString(36).slice(2)]);
    console.log('Project created');
    
    // Create repo connection
    await c.query(`INSERT INTO repository_connections (id, owner_user_id, github_repo_id, repo_owner, repo_name, full_name) VALUES ($1, $2, $3, $4, $5, $6)`, [connId, userId, '123', 'owner', 'repo', 'owner/repo']);
    console.log('Repo connection created');
    
    // Test linkRepositoryToProject logic directly
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      
      // Lock project row
      await client.query(
        `SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [projectId, userId],
      );
      console.log('Project locked');
      
      // Lock repo connection row
      await client.query(
        `SELECT 1 FROM repository_connections WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [connId, userId],
      );
      console.log('Repo connection locked');
      
      // Check if this repository connection already has an ACTIVE relationship
      const existingActiveRepoLinks = await client.query(
        `SELECT 1 FROM project_repository_links WHERE repository_connection_id = $1 AND owner_user_id = $2 AND link_status = 'active'`,
        [connId, userId],
      );
      console.log('Existing active repo links:', existingActiveRepoLinks.rowCount);
      
      const id = nextId();
      const res = await client.query(
        `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at)
         VALUES ($1,$2,$3,$4,'active',NOW())
         RETURNING *`,
        [nextId(), projectId, connId, userId]
      );
      console.log('First insert succeeded');
      
      await client.query("COMMIT");
      console.log('First commit succeeded');
      
      // Now try second insert
      await client.query("BEGIN");
      
      const existingActiveRepoLinks2 = await client.query(
        `SELECT 1 FROM project_repository_links WHERE repository_connection_id = $1 AND owner_user_id = $2 AND link_status = 'active'`,
        [connId, userId],
      );
      console.log('Existing active repo links (second):', existingActiveRepoLinks2.rowCount);
      
      if (existingActiveRepoLinks2.rowCount && existingActiveRepoLinks2.rowCount > 0) {
        console.log('Would throw: Repository is already assigned to another project');
        await client.query("ROLLBACK");
      } else {
        const res2 = await client.query(
          `INSERT INTO project_repository_links (id, project_id, repository_connection_id, owner_user_id, link_status, created_at)
           VALUES ($1,$2,$3,$4,'active',NOW())
           RETURNING *`,
          [nextId(), projectId, connId, userId]
        );
        console.log('Second insert succeeded (UNEXPECTED)');
        await client.query("COMMIT");
      }
      
      await client.query("COMMIT");
    } catch (e) {
      console.error('Error:', e.code, e.message);
      try { await client.query("ROLLBACK"); } catch {}
    } finally {
      client.release();
    }
    
    c.release();
  } catch (e) {
    console.error('DB connection failed:', e.message);
  } finally {
    await p.end();
  }
})();