'use strict';
// PostgreSQL through the `pg` driver, with a connection pool.
// Same call style as before (get / all / run / tx) but every call is now async: always `await` them.
// Timestamps are unix seconds. Write SQL with `?` placeholders; they are converted to $1, $2 ... here.
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types } = require('pg');

// Return bigint and numeric columns (COUNT, SUM, AVG, unix times) as JavaScript numbers, not strings.
types.setTypeParser(20, (v) => parseInt(v, 10));
types.setTypeParser(1700, (v) => parseFloat(v));

// Only used by the local-development photo storage (see lib/storage.js). Production never writes to disk.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

function poolConfig(url) {
  const raw = url || process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and set it (for local development run `npm run db:up` first).');
  }
  const u = new URL(raw);
  const mode = (process.env.PGSSL || u.searchParams.get('sslmode') || '').toLowerCase();
  u.searchParams.delete('sslmode');
  const local = ['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(u.hostname);
  // Supabase (and most hosted Postgres) require TLS. Local development does not.
  const ssl = mode === 'disable' || (!mode && local) ? false : { rejectUnauthorized: mode === 'verify-full' || mode === 'verify' };
  return {
    connectionString: u.toString(), ssl,
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 20000,
    application_name: 'shop-beta',
  };
}

const pool = new Pool(poolConfig());
pool.on('error', (e) => console.error('Idle database connection error:', e.message));

// "?" -> "$1" (skipping anything inside single quotes)
function convert(sql) {
  let out = '', n = 0, q = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") q = !q;
    out += c === '?' && !q ? '$' + (++n) : c;
  }
  return out;
}

const als = new AsyncLocalStorage(); // holds the open transaction's connection, if any
const exec = (sql, params) => (als.getStore() || pool).query(convert(sql), params);
const get = async (sql, ...p) => (await exec(sql, p)).rows[0];
const all = async (sql, ...p) => (await exec(sql, p)).rows;
const run = async (sql, ...p) => { const r = await exec(sql, p); return { changes: r.rowCount }; };
// INSERT that returns the new row's id.
const insert = async (sql, ...p) => (await exec(sql + ' RETURNING id', p)).rows[0].id;
const now = () => Math.floor(Date.now() / 1000);

// Run fn inside a transaction. Every get/all/run/insert called (even deep inside other functions) joins it.
// If two transactions deadlock or conflict, the whole function is retried (up to 3 times), so fn must only touch the database.
async function tx(fn) {
  if (als.getStore()) return fn();
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await als.run(client, fn);
      await client.query('COMMIT');
      return r;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
      if ((err.code === '40P01' || err.code === '40001') && attempt < 3) continue;
      throw err;
    } finally { client.release(); }
  }
}

// For bulk statements that already use $1, $2 placeholders (still joins the open transaction).
const raw = (sql, params) => (als.getStore() || pool).query(sql, params);
const ping = async () => { await pool.query('SELECT 1'); return true; };
const end = () => pool.end();

module.exports = { poolConfig, pool, get, all, run, insert, tx, raw, now, ping, end, DATA_DIR };
