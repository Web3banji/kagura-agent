const {Pool} = require('pg');
const cs = process.env.DATABASE_URL;
if (!cs) { console.error('No DATABASE_URL'); process.exit(1); }
const p = new Pool({connectionString: cs, ssl: {rejectUnauthorized: false}});
(async () => {
  try {
    const c = await p.connect();
    const kv = await c.query("SELECT key, value FROM echolog_kv WHERE key LIKE 'verification:records:%' ORDER BY key");
    console.log('VERIFICATION KV RECORDS:', JSON.stringify(kv.rows.map(r => ({key: r.key, count: r.value ? r.value.length : 0, ids: r.value ? r.value.map(rr => rr.id) : []})), null, 2));
    c.release();
  } catch (e) {
    console.error('DB connection failed:', e.message);
  } finally {
    await p.end();
  }
})();