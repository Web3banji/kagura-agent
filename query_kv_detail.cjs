const {Pool} = require('pg');
const cs = process.env.DATABASE_URL;
if (!cs) { console.error('No DATABASE_URL'); process.exit(1); }
const p = new Pool({connectionString: cs, ssl: {rejectUnauthorized: false}});
(async () => {
  try {
    const c = await p.connect();
    const kv = await c.query("SELECT key, value FROM echolog_kv WHERE key LIKE 'verification:records:%' ORDER BY key");
    for (const row of kv.rows) {
      const records = row.value || [];
      console.log(`KEY: ${row.key} (${records.length} records)`);
      for (const r of records) {
        console.log(`  ID: ${r.id} | Outcome: ${r.outcome} | Flow: ${r.flow} | JobId: ${r.jobId} | ProjectId: ${r.projectId} | RequestedBy: ${r.requestedBy} | Outcome: ${r.outcome} | Summary: ${(r.summary || '').substring(0, 80)}...`);
      }
    }
    c.release();
  } catch (e) {
    console.error('DB connection failed:', e.message);
  } finally {
    await p.end();
  }
})();