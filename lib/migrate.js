'use strict';
// Applies the SQL files in /migrations in order, once each. Safe to run from several instances at the same time.
// Run by hand with:  npm run migrate
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { pool: appPool, poolConfig } = require('./db');

const DIR = path.join(__dirname, '..', 'migrations');
const LOCK = 727274; // any fixed number; shared by all instances

// Migrations take a session-level lock, which a transaction pooler (Supabase port 6543) cannot hold.
// If you use the pooler for the app, set MIGRATE_DATABASE_URL to the direct or session-mode connection string.
async function migrate() {
  const own = process.env.MIGRATE_DATABASE_URL ? new Pool({ ...poolConfig(process.env.MIGRATE_DATABASE_URL), max: 1 }) : null;
  const pool = own || appPool;
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]); // waits if another instance is migrating
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of fs.readdirSync(DIR).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) {
      if (done.has(f)) continue;
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(DIR, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [f, Math.floor(Date.now() / 1000)]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) { await client.query('ROLLBACK'); e.message = `Migration ${f} failed: ${e.message}`; throw e; }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK]); } catch { /* ignore */ }
    client.release();
    if (own) await own.end();
  }
  return applied;
}

module.exports = { migrate };

if (require.main === module) {
  try { for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; } } catch { /* no .env */ }
  migrate().then((a) => { console.log(a.length ? 'Applied: ' + a.join(', ') : 'Database is up to date.'); return require('./db').end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
