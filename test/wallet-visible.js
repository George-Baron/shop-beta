'use strict';
// Wallet and rewards are easy to find: balance and points in the header for signed-in customers, a free-account invitation for visitors, and the account opens on the overview.
// Run with: npm run test:wallet-visible   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_wvis_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500);
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
const call = async (method, url, body, cookie, raw) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: raw ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const buf = Buffer.from(await r.arrayBuffer()); const t = buf.toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  if (process.env.DEBUG_V && r.status >= 400) console.log('   [' + r.status + '] ' + method + ' ' + url + ' ' + t.slice(0, 200));
  return { s: r.status, j, t, buf, h: r.headers, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + email + ' ' + r.t); return r.c; };
const PW = 'Wholesale-Test-Pass-2026!';
// Wholesale stock lives in the warehouse (separate from retail products.stock).
const stockOf = async (id) => { const r = (await q('SELECT on_hand - reserved AS a FROM wholesale_stock_balances WHERE product_id=$1', [id]))[0]; return r ? Number(r.a) : 0; };
const setAvail = async (ids, n) => { const wh = (await q("SELECT id FROM wholesale_warehouses WHERE code='MAIN'"))[0].id; for (const id of ids) await q('INSERT INTO wholesale_stock_balances (product_id,warehouse_id,on_hand,reserved,updated) VALUES ($1,$2,$3,0,1) ON CONFLICT (product_id,warehouse_id) DO UPDATE SET on_hand = wholesale_stock_balances.reserved + $3', [id, wh, n]); };
const appBody = (o = {}) => ({ business_name: 'Ada Provisions Ltd', contact_name: 'Ada Obi', phone: '08031234567', address: '5 Trade Fair Road', state: 'Lagos', city: 'Ojo', reg_no: 'RC445566', business_type: 'Retailer', buys: 'Rice, beans and cooking oil for my shops', est_monthly: '₦2m', ...o });

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const reg = await call('POST', '/api/auth/register', { name: 'Wal Let', email: 'wal.let@example.com', phone: '08031230077', password: 'mango-river-sky-55' }); assert.strictEqual(reg.s, 200, reg.t);
  const { chromium } = require('playwright'); const br = await chromium.launch(); const base = `http://127.0.0.1:${PORT}`;
  const ctx = async (cookie) => { const c = await br.newContext({ viewport: { width: 390, height: 800 } }); if (cookie) await c.addCookies(cookie.split('; ').map((kv) => ({ name: kv.split('=')[0], value: kv.split('=').slice(1).join('='), url: base }))); return c.newPage(); };
  try {
    await test('a signed-in customer sees wallet balance and points in the header, and "Wallet & Rewards" in the menu', async () => {
      const p = await ctx(reg.c); await p.goto(base + '/'); await p.waitForSelector('#vchip:not(.hide)', { timeout: 10000 });
      const t = await p.innerText('#vchip'); assert.ok(/₦0/.test(t) && /0 pts/.test(t), t); assert.ok((await p.innerText('#nav2')).includes('Wallet & Rewards'));
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll on a phone');
    });
    await test('the account opens on the overview with wallet and rewards, not on orders', async () => {
      const p = await ctx(reg.c); await p.goto(base + '/account'); await p.waitForFunction(() => /VELTO REWARDS/i.test(document.body.innerText) && /AVAILABLE BALANCE/i.test(document.body.innerText), null, { timeout: 10000 });
    });
    await test('a visitor sees the free-account invitation and no header chip', async () => {
      const p = await ctx(null); await p.goto(base + '/'); await p.waitForSelector('text=Create a free account', { timeout: 10000 }); assert.ok(await p.locator('#vchip.hide').count() === 1);
    });
  } finally { await br.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  srv.kill(); await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  if (failed) { console.log(log.slice(-1500)); process.exit(1); }
})().catch((e) => { console.error(e); try { srv.kill(); } catch { /* */ } process.exit(1); });
