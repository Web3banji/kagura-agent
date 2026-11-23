process.loadEnvFile(".env.local");
const { Pool } = require("pg");
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});
pool.query("SELECT 1")
  .then(r => { 
    console.log("DB connected:", r.rows); 
    pool.end(); 
  })
  .catch(e => { 
    console.error("DB error:", e.message); 
    pool.end(); 
  });