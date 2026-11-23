const {Pool} = require('pg');
const cs = process.env.DATABASE_URL;
if (!cs) { console.error('No DATABASE_URL'); process.exit(1); }
const p = new Pool({connectionString: cs, ssl: {rejectUnauthorized: false}});
(async () => {
  try {
    const c = await p.connect();
    const tables = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    console.log('TABLES:', tables.rows.map(r => r.table_name));
    c.release();
  } catch (e) {
    console.error('DB connection failed:', e.message);
  } finally {
    await p.end();
  }
})();