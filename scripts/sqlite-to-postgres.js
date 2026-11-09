#!/usr/bin/env node
'use strict';
// One-time copy of the old SQLite shop database into PostgreSQL.
//
//   node scripts/sqlite-to-postgres.js --sqlite ./data/shop.db            copy (target must be a fresh, migrated database)
//   node scripts/sqlite-to-postgres.js --sqlite ./data/shop.db --dry-run   do everything, check the numbers, then roll back
//   node scripts/sqlite-to-postgres.js --sqlite ./data/shop.db --replace   empty the Postgres tables first (DESTROYS what is there)
//
// It never changes the SQLite file (opened read-only). Everything is copied in ONE transaction: if anything is wrong,
// nothing is written. Ids are kept, so order references, product links and customer accounts all stay valid.
// Passwords keep working (the hashes are copied unchanged). Logged-in sessions carry over too.
const fs = require('fs');
const path = require('path');
try { for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); } } catch { /* no .env */ }
const { DatabaseSync } = require('node:sqlite');
const { tx, get, all, run, raw, end } = require('../lib/db');
const { migrate } = require('../lib/migrate');

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const SQLITE = path.resolve(opt('sqlite') || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'shop.db'));
const DRY = flag('dry-run'), REPLACE = flag('replace');

// Parents before children.
const TABLES = ['settings', 'stores', 'categories', 'products', 'variants', 'users', 'sessions', 'resets', 'addresses', 'wishlist', 'zones', 'coupons',
  'orders', 'order_items', 'order_events', 'reviews', 'messages', 'newsletter', 'abandoned', 'outbox'];
const LOWER = { users: ['email'], newsletter: ['email'], abandoned: ['email'], orders: ['email'] };
const SKIP_COLS = new Set(['search_text', 'seq']); // filled in by the database itself

class DryRun extends Error {}

(async () => {
  if (!fs.existsSync(SQLITE)) { console.error('SQLite file not found: ' + SQLITE + '\nPass the path with --sqlite <file>.'); process.exit(1); }
  const src = new DatabaseSync(SQLITE, { readOnly: true });
  const have = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  console.log(`Source: ${SQLITE}\nTarget: ${new URL(process.env.DATABASE_URL).host}${new URL(process.env.DATABASE_URL).pathname}${DRY ? '   (DRY RUN, nothing will be kept)' : ''}\n`);
  await migrate();

  const report = [];
  try {
    await tx(async () => {
      await run('SELECT pg_advisory_xact_lock(727311)');
      const existing = (await get('SELECT (SELECT COUNT(*) FROM products) p, (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM stores) s'));
      if (existing.p + existing.o + existing.u + existing.s > 0) {
        if (!REPLACE) throw new Error(`The Postgres database already has data (${existing.p} products, ${existing.o} orders, ${existing.u} users).\nUse a fresh database, or add --replace to empty it first.`);
        await run(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
        console.log('Existing Postgres data removed (--replace).');
      }
      for (const t of TABLES) {
        if (!have.has(t)) { console.log(`  ${t.padEnd(13)} not in the SQLite file, skipped`); report.push({ t, src: 0, dst: 0 }); continue; }
        const pgCols = await all("SELECT column_name, column_default, is_nullable, is_identity FROM information_schema.columns WHERE table_schema='public' AND table_name=? ORDER BY ordinal_position", t);
        const rows = src.prepare(`SELECT * FROM ${t}`).all();
        const srcCols = rows.length ? Object.keys(rows[0]) : src.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
        const cols = pgCols.filter((c) => srcCols.includes(c.column_name) && !SKIP_COLS.has(c.column_name));
        const hasIdentity = cols.some((c) => c.is_identity === 'YES' && c.column_name === 'id');
        const lower = new Set(LOWER[t] || []);
        const per = Math.max(1, Math.floor(60000 / Math.max(1, cols.length)));
        for (let i = 0; i < rows.length; i += per) {
          const chunk = rows.slice(i, i + per), params = [], tuples = [];
          for (const r of chunk) {
            tuples.push('(' + cols.map((c) => {
              let v = r[c.column_name];
              if (v === null || v === undefined) { if (c.is_nullable === 'NO' && c.column_default) return 'DEFAULT'; v = null; }
              else if (lower.has(c.column_name)) v = String(v).toLowerCase();
              params.push(v); return '$' + params.length;
            }).join(',') + ')');
          }
          await raw(`INSERT INTO ${t} (${cols.map((c) => c.column_name).join(',')}) ${hasIdentity ? 'OVERRIDING SYSTEM VALUE' : ''} VALUES ${tuples.join(',')}`, params);
        }
        // Next new row must get an id after the highest copied one.
        for (const c of pgCols.filter((x) => x.is_identity === 'YES')) {
          await run(`SELECT setval(pg_get_serial_sequence('${t}', '${c.column_name}'), COALESCE((SELECT MAX(${c.column_name}) FROM ${t}), 0) + 1, false)`);
        }
        const dst = (await get(`SELECT COUNT(*) n FROM ${t}`)).n;
        report.push({ t, src: rows.length, dst });
        console.log(`  ${t.padEnd(13)} ${String(rows.length).padStart(7)} rows copied`);
      }

      // Cross-check: row counts and money/stock totals must match exactly.
      const sums = [['orders', 'SUM(total)'], ['order_items', 'SUM(price*qty)'], ['products', 'SUM(stock)'], ['products', 'SUM(sold)'], ['variants', 'SUM(stock)'], ['coupons', 'SUM(used)']];
      const bad = report.filter((r) => r.src !== r.dst).map((r) => `${r.t}: ${r.src} in SQLite, ${r.dst} in Postgres`);
      for (const [t, expr] of sums) {
        if (!have.has(t)) continue;
        const a = src.prepare(`SELECT COALESCE(${expr},0) v FROM ${t}`).get().v, b = (await get(`SELECT COALESCE(${expr},0) v FROM ${t}`)).v;
        console.log(`  check ${t}.${expr.padEnd(15)} SQLite ${a}  Postgres ${b}  ${Number(a) === Number(b) ? 'OK' : 'MISMATCH'}`);
        if (Number(a) !== Number(b)) bad.push(`${t} ${expr}: ${a} vs ${b}`);
      }
      if (bad.length) throw new Error('The copy does not match the original:\n  ' + bad.join('\n  '));
      if (DRY) throw new DryRun();
    });
    console.log('\nDone. Every row count and total matches. Start the app as usual.');
  } catch (e) {
    if (e instanceof DryRun) console.log('\nDry run finished: everything matches, and nothing was kept.');
    else { console.error('\nNOTHING WAS COPIED. ' + e.message); process.exitCode = 1; }
  } finally { src.close(); await end(); }
})();
