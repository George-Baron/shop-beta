'use strict';
// Members-only: dropshipped items, the Dropshipping page and the Import & Export form are for signed-in customers; guests can still browse and buy normal items.
// Run with: npm run test:members   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_members_' + tag;
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
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DROPSHIP_ORDERS_ENABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const reg = await call('POST', '/api/auth/register', { name: 'Mem Ber', email: 'mem.ber@example.com', phone: '08031230002', password: 'mango-river-sky-55' }); assert.strictEqual(reg.s, 200, reg.t);
  const prods = (await call('GET', '/api/products')).j.products; assert.ok(prods.length >= 2, 'seed products');
  const own = prods[0], ds = prods[1];
  const sup = Number((await q("INSERT INTO suppliers (name,country,currency,status,created,updated) VALUES ('Shenzhen Co','CN','USD','active',1,1) RETURNING id"))[0].id);
  await q("UPDATE products SET fulfilment='dropship', listing='approved' WHERE id=$1", [ds.id]);
  await q("INSERT INTO dropship_products (product_id,supplier_id,supplier_sku,cost,created,updated) VALUES ($1,$2,'SKU1',10,1,1)", [ds.id, sup]);
  const names = (r) => (r.j.products || []).map((p) => p.id);

  console.log('\nGuests');
  await test('a guest sees normal items but not dropshipped ones in the product list, and can still open normal items', async () => {
    const r = await call('GET', '/api/products?x=2'); assert.ok(names(r).includes(own.id)); assert.ok(!names(r).includes(ds.id));
    assert.strictEqual((await call('GET', '/api/products/' + own.slug)).s, 200); assert.strictEqual((await call('GET', '/api/products/' + ds.slug)).s, 404);
  });
  await test('the Dropshipping page answer is locked for guests', async () => { const r = await call('GET', '/api/dropshipping'); assert.strictEqual(r.j.locked, true); assert.ok(!('count' in r.j)); });
  await test('a guest cannot check out a dropshipped item but can check out a normal one', async () => {
    const r = await call('POST', '/api/cart/price', { items: [{ productId: ds.id, qty: 1 }] }); const issues = (r.j && r.j.issues) || []; assert.ok(issues.some((i) => /sign in|no longer available/i.test(i.message)), r.t.slice(0, 300));
    const ok = await call('POST', '/api/cart/price', { items: [{ productId: own.id, qty: 1 }] }); assert.ok(!((ok.j && ok.j.issues) || []).length, ok.t.slice(0, 300));
  });
  await test('the search-engine page for the shop never lists a dropshipped item', async () => { const r = await call('GET', '/'); assert.ok(!r.t.includes('/product/' + ds.slug)); });
  await test('the guest and member lists do not leak into each other through the cache', async () => {
    for (let i = 0; i < 2; i++) {
      const g = await call('GET', '/api/products?x=3'), m = await call('GET', '/api/products?x=3', undefined, reg.c);
      assert.ok(!names(g).includes(ds.id), 'guest round ' + i); assert.ok(names(m).includes(ds.id), 'member round ' + i);
    }
  });
  console.log('\nRegistered customers');
  await test('a member sees dropshipped items, the page data, and the answer is not kept by shared caches', async () => {
    const r = await call('GET', '/api/products/' + ds.slug, undefined, reg.c); assert.strictEqual(r.s, 200, r.t.slice(0, 200));
    const d = await call('GET', '/api/dropshipping', undefined, reg.c); assert.ok(!d.j.locked); assert.ok(d.j.count >= 1);
    const l = await call('GET', '/api/products', undefined, reg.c); assert.ok(/private/.test(l.h.get('cache-control') || ''), l.h.get('cache-control'));
    assert.ok(/public/.test((await call('GET', '/api/products')).h.get('cache-control') || ''), 'guest answers may still be cached');
  });
  await test('a member can send an Import & Export enquiry', async () => {
    const r = await call('POST', '/api/trade-enquiries', { kind: 'import', name: 'Mem Ber', email: 'mem.ber@example.com', phone: '08031230002', country: 'China', item: 'Solar pumps', quantity: '10', details: 'Need ten solar water pumps for a farm in Ogun.' }, reg.c); assert.strictEqual(r.s, 200, r.t);
  });
  await test('rewards are for signed-in customers only', async () => { assert.strictEqual((await call('GET', '/api/loyalty')).s, 401); assert.strictEqual((await call('GET', '/api/loyalty', undefined, reg.c)).s, 200); });

  console.log(`\n${passed} passed, ${failed} failed`);
  srv.kill(); await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  if (failed) { console.log(log.slice(-1500)); process.exit(1); }
})().catch((e) => { console.error(e); try { srv.kill(); } catch { /* */ } process.exit(1); });
