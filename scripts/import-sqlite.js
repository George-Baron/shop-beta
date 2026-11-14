#!/usr/bin/env node
'use strict';
// One-time copy of the old SQLite database (data/shop.db) into PostgreSQL.
//
//   DATABASE_URL=postgres://... node --disable-warning=ExperimentalWarning scripts/import-sqlite.js [path/to/shop.db] [--dry-run] [--force]
//
// - Reads the SQLite file read-only; never changes it.
// - Creates the Postgres tables first (runs the migrations).
// - Refuses to run if Postgres already has users, products or orders, unless you pass --force (which empties the shop tables first).
// - Keeps every id, so order numbers, product links, wishlists and photo paths stay the same.
// - Does everything in one transaction: if anything fails, nothing is imported.
// - Finishes by comparing row counts table by table and by re-aligning the id counters.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { pool, migrate, close } = require('../lib/db');

const args = process.argv.slice(2);
const dry = args.includes('--dry-run'), force = args.includes('--force');
const file = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'data', 'shop.db'));

// Parents first so foreign keys are satisfied. "identity" = tables whose id is a generated counter to realign.
const TABLES = [
  { t: 'settings' }, { t: 'stores' }, { t: 'zones' },
  { t: 'categories', identity: true }, { t: 'users', identity: true }, { t: 'coupons' },
  { t: 'products', identity: true }, { t: 'variants', identity: true },
  { t: 'sessions' }, { t: 'resets' }, { t: 'addresses', identity: true }, { t: 'wishlist' },
  { t: 'orders', identity: true }, { t: 'order_items', identity: true }, { t: 'order_events', identity: true },
  { t: 'reviews', identity: true }, { t: 'messages', identity: true }, { t: 'newsletter' }, { t: 'abandoned' }, { t: 'outbox', identity: true },
];

(async () => {
  if (!fs.existsSync(file)) { console.error('SQLite file not found: ' + file); process.exit(2); }
  const src = new DatabaseSync(file, { readOnly: true });
  const srcCount = (t) => src.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const has = (t) => !!src.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?").get(t);

  await migrate();
  const used = (await pool.query("SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM products) p, (SELECT COUNT(*) FROM orders) o")).rows[0];
  if ((Number(used.u) || Number(used.p) || Number(used.o)) && !force) {
    console.error(`Postgres already has data (users ${used.u}, products ${used.p}, orders ${used.o}). Nothing was imported.\nIf this is a test database you can empty, run again with --force.`);
    await close(); process.exit(3);
  }

  const client = await pool.connect();
  const report = [];
  try {
    await client.query('BEGIN');
    if (used.u || used.p || used.o || force) await client.query(`TRUNCATE ${TABLES.map((x) => x.t).join(', ')} RESTART IDENTITY CASCADE`);
    for (const { t, identity } of TABLES) {
      if (!has(t)) { report.push({ t, src: 0, dst: 0, note: 'not in SQLite' }); continue; }
      const cols = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' AND column_name<>'created_seq' ORDER BY ordinal_position", [t])).rows.map((r) => r.column_name);
      const srcCols = src.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const use = cols.filter((c) => srcCols.includes(c));
      const rows = src.prepare(`SELECT ${use.map((c) => `"${c}"`).join(', ')} FROM ${t}${t === 'coupons' ? ' ORDER BY rowid' : ''}`).all();
      const sql = `INSERT INTO ${t} (${use.map((c) => `"${c}"`).join(', ')}) ${identity ? 'OVERRIDING SYSTEM VALUE ' : ''}VALUES (${use.map((_, i) => '$' + (i + 1)).join(', ')})`;
      for (const r of rows) await client.query(sql, use.map((c) => (r[c] === undefined ? null : r[c])));
      if (identity) await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${t}), 0), 1), (SELECT COUNT(*) > 0 FROM ${t}))`);
      const dst = Number((await client.query(`SELECT COUNT(*) n FROM ${t}`)).rows[0].n);
      report.push({ t, src: srcCount(t), dst });
    }
    // Totals that matter to the business must match to the naira.
    const money = Number(src.prepare("SELECT COALESCE(SUM(total),0) n FROM orders").get().n);
    const moneyPg = Number((await client.query('SELECT COALESCE(SUM(total),0) n FROM orders')).rows[0].n);
    const stock = Number(src.prepare('SELECT COALESCE(SUM(stock),0) n FROM products').get().n);
    const stockPg = Number((await client.query('SELECT COALESCE(SUM(stock),0) n FROM products')).rows[0].n);
    const bad = report.filter((r) => r.src !== r.dst);
    console.table(report);
    console.log(`Order totals: SQLite ${money} / Postgres ${moneyPg}.  Product stock: SQLite ${stock} / Postgres ${stockPg}.`);
    if (bad.length || money !== moneyPg || stock !== stockPg) throw new Error('Counts or totals do not match: ' + bad.map((b) => b.t).join(', '));
    if (dry) { await client.query('ROLLBACK'); console.log('Dry run finished: all counts match. Nothing was saved.'); }
    else { await client.query('COMMIT'); console.log('Import finished and verified. Keep data/shop.db and data/uploads until you have checked the site.'); }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('Import failed, nothing was saved: ' + e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    src.close();
    await close();
  }
})();
