const {Pool} = require('pg');
const cs = process.env.DATABASE_URL;
if (!cs) { console.error('No DATABASE_URL'); process.exit(1); }
const p = new Pool({connectionString: cs, ssl: {rejectUnauthorized: false}});
(async () => {
  try {
    const c = await p.connect();
    // Check indexes
    const idx = await c.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'project_repository_links' ORDER BY indexname");
    console.log('INDEXES:', JSON.stringify(idx.rows, null, 2));
    // Check constraints
    const cons = await c.query("SELECT conname, pg_get_constraintdef(oid) as def FROM pg_constraint WHERE conrelid = 'project_repository_links'::regclass");
    console.log('CONSTRAINTS:', JSON.stringify(cons.rows, null, 2));
    c.release();
  } catch (e) {
    console.error('DB connection failed:', e.message);
  } finally {
    await p.end();
  }
})();