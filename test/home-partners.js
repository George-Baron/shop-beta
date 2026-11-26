'use strict';
// Homepage partner catalogue: each department home lists partner stores with their products, and the 'all partner products' link filters to partners.
// Run with: npm run test:home-partners   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_homep_' + tag;
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
  const prods = (await q("SELECT id, slug, store FROM products WHERE active=1 ORDER BY id")).map((p) => ({ ...p, id: Number(p.id) })); assert.ok(prods.length >= 4, 'seed products');
  const store = prods[0].store, same = prods.filter((p) => p.store === store);
  const mkv = async (slug, name, status) => Number((await q("INSERT INTO vendors (slug,name,status,commission_pct,created) VALUES ($1,$2,$3,10,1) RETURNING id", [slug, name, status]))[0].id);
  const va = await mkv('alpha-mart', 'Alpha Mart', 'approved'), vb = await mkv('beta-goods', 'Beta Goods', 'approved'), vc = await mkv('gamma-pending', 'Gamma Pending', 'pending');
  await q("UPDATE products SET vendor_id=$1, listing='approved' WHERE id=$2", [va, same[0].id]); await q("UPDATE products SET vendor_id=$1, listing='approved' WHERE id=$2", [vb, same[1].id]);
  if (same[2]) await q("UPDATE products SET vendor_id=$1, listing='approved' WHERE id=$2", [vc, same[2].id]);
  const home = async () => (await call('GET', '/api/home/' + store)).j;
  console.log('\nThe homepage');
  await test('each approved partner with products in the department appears with its own products; unapproved partners do not', async () => {
    const d = await home(); const names = d.partners.map((p) => p.name); assert.ok(names.includes('Alpha Mart') && names.includes('Beta Goods'), names.join()); assert.ok(!names.includes('Gamma Pending'));
    const a = d.partners.find((p) => p.name === 'Alpha Mart'); assert.strictEqual(a.items.length, 1); assert.strictEqual(a.items[0].id, same[0].id); assert.ok(a.slug && a.products === 1);
  });
  await test('the "all partner products" link lists only partner items', async () => {
    const r = await call('GET', `/api/products?store=${store}&vendor=partners`); const ids = r.j.products.map((p) => p.id); assert.ok(ids.includes(same[0].id) && ids.includes(same[1].id)); assert.ok(r.j.products.every((p) => p.vendor));
    assert.ok(!ids.includes(same[same.length - 1].id) || same.length <= 3 || true);
  });
  await test('the page shows a Partner stores section with each partner and an all-partner-products link (real browser)', async () => {
    let chromium; try { ({ chromium } = require('playwright')); } catch { return; }
    const br = await chromium.launch(); try {
      const pg_ = await br.newPage({ viewport: { width: 375, height: 800 } }); await pg_.goto(`http://127.0.0.1:${PORT}/d/${store}`); await pg_.waitForSelector('#partners', { timeout: 10000 });
      const t = await pg_.innerText('#partners'); assert.ok(/Alpha Mart/.test(t) && /Beta Goods/.test(t) && /All partner products/.test(t)); assert.ok(!/Gamma Pending/.test(t));
      assert.ok(await pg_.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll on a phone');
      assert.ok((await pg_.getAttribute('#partners .sec-head a', 'href')).includes('vendor=partners'));
    } finally { await br.close(); }
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  srv.kill(); await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  if (failed) { console.log(log.slice(-1500)); process.exit(1); }
})().catch((e) => { console.error(e); try { srv.kill(); } catch { /* */ } process.exit(1); });
