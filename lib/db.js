'use strict';
// PostgreSQL data layer (Supabase or local). Every helper is async.
//   get(sql, ...params)  -> first row or undefined
//   all(sql, ...params)  -> array of rows
//   run(sql, ...params)  -> { changes, lastInsertRowid }  (lastInsertRowid is filled for INSERTs into tables that have an id column)
//   tx(async () => {...}) -> runs the callback in one transaction; get/all/run called inside use that transaction automatically.
// SQL is written with "?" placeholders and converted to $1, $2 ... here, so route code stays readable.
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Return numbers, not strings, for bigint (COUNT, BIGINT columns) and numeric (SUM, AVG).
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/shopbeta_dev';
const local = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(DATABASE_URL);
const sslMode = (process.env.DATABASE_SSL || (local ? 'off' : 'on')).toLowerCase();
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 10,           // per app instance; keep (instances x max) below the pooler limit
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 15000,
  application_name: 'shop-beta',
  ssl: sslMode === 'off' ? false : { rejectUnauthorized: sslMode !== 'no-verify' },
});
pool.on('error', (e) => console.error('Postgres pool error:', e.message));

const als = new AsyncLocalStorage();
// Tables whose INSERTs get "RETURNING id" so run() can report lastInsertRowid.
const ID_TABLES = new Set(['categories', 'products', 'variants', 'users', 'addresses', 'orders', 'order_items', 'order_events', 'reviews', 'messages', 'outbox', 'jobs']);

// "?" -> "$n" (skipping ? inside single-quoted strings)
function convert(sql) {
  let out = '', n = 0, q = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") q = !q;
    out += ch === '?' && !q ? '$' + (++n) : ch;
  }
  return out;
}
const execOn = (client) => async (sql, params) => {
  const text = convert(sql);
  return client.query({ text, values: params });
};
const exec = (sql, params) => {
  const store = als.getStore();
  return store ? execOn(store.client)(sql, params) : pool.query({ text: convert(sql), values: params });
};

const get = async (sql, ...p) => (await exec(sql, p)).rows[0];
const all = async (sql, ...p) => (await exec(sql, p)).rows;
async function run(sql, ...p) {
  let text = sql;
  const m = /^\s*INSERT\s+INTO\s+([a-z_]+)/i.exec(sql);
  const wantsId = m && ID_TABLES.has(m[1].toLowerCase()) && !/\bRETURNING\b/i.test(sql) && !/ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i.test(sql);
  if (wantsId) text = sql.replace(/;?\s*$/, '') + ' RETURNING id';
  const r = await exec(text, p);
  return { changes: r.rowCount, lastInsertRowid: wantsId && r.rows[0] ? Number(r.rows[0].id) : 0 };
}
const now = () => Math.floor(Date.now() / 1000);

// Run fn in one transaction. Retries once on deadlock (40P01) or serialization failure (40001).
async function tx(fn, attempt = 0) {
  if (als.getStore()) return fn(); // already inside a transaction: join it
  const client = await pool.connect();
  let retry = false;
  try {
    await client.query('BEGIN');
    const result = await als.run({ client }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    if (attempt < 1 && err && (err.code === '40P01' || err.code === '40001')) retry = true;
    else throw err;
  } finally {
    client.release();
  }
  if (retry) return tx(fn, attempt + 1);
  return undefined;
}

/* ---------- migrations: plain .sql files in /migrations, applied once, in name order ---------- */
async function migrate() {
  const dir = path.join(__dirname, '..', 'migrations');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)'); // so two instances starting together do not both migrate
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied BIGINT NOT NULL)');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sqlText);
        await client.query('INSERT INTO schema_migrations (name, applied) VALUES ($1, $2)', [f, now()]);
        await client.query('COMMIT');
        console.log('Applied migration', f);
      } catch (e) { await client.query('ROLLBACK'); throw new Error(`Migration ${f} failed: ${e.message}`); }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(727001)'); } catch { /* ignore */ }
    client.release();
  }
}

const health = async () => { await pool.query('SELECT 1'); return true; };
const close = () => pool.end();

module.exports = { pool, get, all, run, tx, now, migrate, health, close };
