const {Pool} = require('pg');
const cs = process.env.DATABASE_URL;
if (!cs) { console.error('No DATABASE_URL'); process.exit(1); }
const p = new Pool({connectionString: cs, ssl: {rejectUnauthorized: false}});
(async () => {
  try {
    const c = await p.connect();
    const inv = await c.query("SELECT id, status, project_id, title, technical_explanation FROM kagura_investigations ORDER BY created_at DESC LIMIT 20");
    console.log('INVESTIGATIONS:', JSON.stringify(inv.rows, null, 2));
    c.release();
  } catch (e) {
    console.error('DB connection failed:', e.message);
  } finally {
    await p.end();
  }
})();