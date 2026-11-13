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

// Connection options for a given URL. Exported so the rules can be tested.
//  - SSL: on (default for non-local hosts), off (default for local), no-verify (encrypted, certificate not checked).
//    DATABASE_CA = the certificate text (or base64 of it) of your database host, if it uses a certificate Node does not know (Supabase can need this).
//  - Supabase's transaction pooler (port 6543) does not support session settings, so nothing is sent at connection start there:
//    the time limit is then enforced by the app (query_timeout) instead of by the server (statement_timeout).
function connectionOptions(url, env = process.env) {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
  const sslMode = (env.DATABASE_SSL || (local ? 'off' : 'on')).toLowerCase();
  const transactionPooler = /:6543(\/|\?|$)/.test(url);
  const limit = Number(env.DB_STATEMENT_TIMEOUT_MS) || 15000;
  let ssl = false;
  if (sslMode !== 'off') {
    ssl = { rejectUnauthorized: sslMode !== 'no-verify' };
    if (env.DATABASE_CA) ssl.ca = /-----BEGIN/.test(env.DATABASE_CA) ? env.DATABASE_CA : Buffer.from(env.DATABASE_CA, 'base64').toString('utf8');
  }
  return {
    connectionString: url,
    max: Number(env.DB_POOL_MAX) || 10,           // per app instance; keep (instances x max) below the pooler limit
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    query_timeout: limit + 2000,                   // the app gives up on a query after this (works with every connection type)
    ...(transactionPooler ? {} : { statement_timeout: limit, application_name: 'shop-beta' }),
    ssl,
  };
}
const pool = new Pool(connectionOptions(DATABASE_URL));
pool.on('error', (e) => console.error('Postgres pool error:', e.message));

const als = new AsyncLocalStorage();
// Tables whose INSERTs get "RETURNING id" so run() can report lastInsertRowid.
const ID_TABLES = new Set(['categories', 'products', 'variants', 'users', 'addresses', 'orders', 'order_items', 'order_events', 'reviews', 'messages', 'outbox', 'jobs', 'partners', 'order_pickups', 'rider_points']);

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
  // The lock is taken INSIDE each transaction (pg_advisory_xact_lock) and released by COMMIT. A session-level lock would not be safe through
  // Supabase's transaction pooler (the lock and the unlock could run on different server connections and the lock would stay stuck).
  const LOCK = 'SELECT pg_advisory_xact_lock(727001)';
  try {
    await client.query('BEGIN'); await client.query(LOCK);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied BIGINT NOT NULL)');
    await client.query('COMMIT');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
      try {
        await client.query('BEGIN'); await client.query(LOCK);
        // checked again now that we hold the lock: another instance may have just applied it
        if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f])).rowCount) { await client.query('COMMIT'); continue; }
        await client.query(sqlText);
        await client.query('INSERT INTO schema_migrations (name, applied) VALUES ($1, $2)', [f, now()]);
        await client.query('COMMIT');
        console.log('Applied migration', f);
      } catch (e) { try { await client.query('ROLLBACK'); } catch { /* connection gone */ } throw new Error(`Migration ${f} failed: ${e.message}`); }
    }
  } finally {
    client.release();
  }
}

const health = async () => { await pool.query('SELECT 1'); return true; };
const close = () => pool.end();

module.exports = { connectionOptions, pool, get, all, run, tx, now, migrate, health, close };
