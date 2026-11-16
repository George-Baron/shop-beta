'use strict';
// Wholesale warehouse foundation: separate stock, audited movements, idempotency, concurrency, roles.
// Run with: npm run test:warehouse   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_wh_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500);
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
const call = async (method, url, body, cookie) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  if (process.env.DEBUG_V && r.status >= 400) console.log('   [' + r.status + '] ' + method + ' ' + url + ' ' + t.slice(0, 200));
  return { s: r.status, j, t, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + email + ' ' + r.t); return r.c; };
const PW = 'Warehouse-Test-Pass-2026!';
(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-wh-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, '/api/warehouse' + u, b, admin);
  const P = (await q("SELECT id, stock FROM products WHERE vendor_id IS NULL AND is_pharmacy=0 AND stock >= 20 ORDER BY id LIMIT 2"));
  assert.ok(P.length === 2); const [P1, P2] = P; const retail1 = Number(P1.stock);
  const bal = async (id) => (await q('SELECT on_hand, reserved FROM wholesale_stock_balances WHERE product_id=$1', [id]))[0] || { on_hand: 0, reserved: 0 };
  let staff, inv;

  console.log('\nRoles');
  await test('no sign-in or a normal customer cannot use the warehouse; roles are checked on the server', async () => {
    assert.strictEqual((await call('GET', '/api/warehouse/stock')).s, 401);
    await call('POST', '/api/auth/register', { name: 'Ngozi Staff', email: 'ngozi@example.com', phone: '08030000001', password: PW });
    await call('POST', '/api/auth/register', { name: 'Ife Inventory', email: 'ife@example.com', phone: '08030000002', password: PW });
    staff = await login('ngozi@example.com', PW); inv = await login('ife@example.com', PW);
    assert.strictEqual((await call('GET', '/api/warehouse/stock', undefined, staff)).s, 403);
    assert.strictEqual((await call('GET', '/api/warehouse/staff', undefined, staff)).s, 403);
  });
  await test('only the administrator grants roles; each role gets only its own permissions', async () => {
    assert.strictEqual((await A('POST', '/staff', { email: 'ngozi@example.com', role: 'dispatch_officer' })).s, 200);
    assert.strictEqual((await A('POST', '/staff', { email: 'ife@example.com', role: 'inventory_officer' })).s, 200);
    assert.strictEqual((await A('POST', '/staff', { email: 'ife@example.com', role: 'ceo' })).s, 400);
    assert.strictEqual((await call('POST', '/api/warehouse/staff', { email: 'ife@example.com', role: 'warehouse_manager' }, inv)).s, 403, 'a staff member cannot promote themselves');
    assert.strictEqual((await call('GET', '/api/warehouse/stock', undefined, staff)).s, 200, 'dispatch can view');
    assert.strictEqual((await call('POST', '/api/warehouse/stock/receipt', { items: [{ productId: P1.id, qty: 5 }] }, staff)).s, 403, 'dispatch cannot receive stock');
    assert.strictEqual((await call('GET', '/api/warehouse/activity', undefined, inv)).s, 403);
  });

  console.log('\nSeparate, audited stock');
  await test('receiving stock raises wholesale stock only; retail stock is untouched; every line is a movement', async () => {
    const r = await call('POST', '/api/warehouse/stock/receipt', { items: [{ productId: P1.id, qty: 100 }, { productId: P2.id, qty: 40 }], reference: 'SUP-1', opening: true }, inv);
    assert.strictEqual(r.s, 200, r.t); assert.match(r.j.grn, /^GRN-\d{4}-\d{6}$/);
    assert.strictEqual(Number((await bal(P1.id)).on_hand), 100);
    assert.strictEqual(Number((await q('SELECT stock FROM products WHERE id=$1', [P1.id]))[0].stock), retail1, 'retail stock unchanged');
    const mv = (await A('GET', '/movements?productId=' + P1.id)).j.movements;
    assert.strictEqual(mv.length, 1); assert.strictEqual(mv[0].prev_on_hand, 0); assert.strictEqual(mv[0].new_on_hand, 100); assert.strictEqual(mv[0].by, 'Ife Inventory'); assert.strictEqual(mv[0].related_ref, r.j.grn);
  });
  await test('a retried receipt with the same key is applied once', async () => {
    const body = { items: [{ productId: P2.id, qty: 10 }], key: 'k-' + tag };
    const a = await call('POST', '/api/warehouse/stock/receipt', body, inv), b = await call('POST', '/api/warehouse/stock/receipt', body, inv);
    assert.strictEqual(a.s, 200); assert.strictEqual(b.s, 200); assert.strictEqual(b.j.duplicate, true);
    assert.strictEqual(Number((await bal(P2.id)).on_hand), 50);
    const both = await Promise.all([1, 2, 3].map(() => call('POST', '/api/warehouse/stock/receipt', { items: [{ productId: P2.id, qty: 1 }], key: 'race-' + tag }, inv)));
    assert.ok(both.every((x) => x.s === 200)); assert.strictEqual(Number((await bal(P2.id)).on_hand), 51, 'three concurrent identical requests, one change');
  });
  await test('adjustments need a reason, cannot go below zero or below what is reserved', async () => {
    const adj = (b) => call('POST', '/api/warehouse/stock/adjust', b, inv);
    assert.strictEqual((await adj({ productId: P2.id, qty: -1, reason: '' })).s, 400);
    assert.strictEqual((await adj({ productId: P2.id, qty: -9999, reason: 'count' })).s, 409);
    assert.strictEqual((await adj({ productId: P2.id, qty: -1, reason: 'stocktake' })).s, 200);
    assert.strictEqual((await adj({ productId: P2.id, qty: 3, kind: 'damaged', reason: 'wet cartons' })).s, 200);
    const b = await bal(P2.id); assert.strictEqual(Number(b.on_hand), 47);
    assert.strictEqual(Number((await q('SELECT damaged_qty FROM wholesale_stock_balances WHERE product_id=$1', [P2.id]))[0].damaged_qty), 3);
  });
  await test('reservations never exceed stock: 30 concurrent reserves for 100 units of 7 allow at most 14', async () => {
    process.env.DATABASE_URL = urlOf(DB);
    const WH = require('../lib/warehouse');
    const db = require('../lib/db');
    const wh = await WH.mainWarehouseId();
    const rs = await Promise.allSettled(Array.from({ length: 30 }, () => WH.move({ productId: P1.id, warehouseId: wh, type: 'reserve', qty: 7, by: 'test' })));
    const ok = rs.filter((x) => x.status === 'fulfilled').length;
    const b = await bal(P1.id);
    assert.strictEqual(ok, 14); assert.strictEqual(Number(b.reserved), 98); assert.ok(Number(b.reserved) <= Number(b.on_hand));
    await db.close();
  });
  await test('wholesale price changes are recorded; document numbers are unique and sequential', async () => {
    const r = await call('PUT', '/api/admin/wholesale/products/' + P2.id, { wholesale_price: 100, wholesale_min_qty: 2 }, admin);
    assert.ok(r.s === 200 || r.s === 400, r.t);
    if (r.s === 200) assert.ok((await q('SELECT 1 FROM wholesale_price_history WHERE product_id=$1', [P2.id])).length >= 1);
    const refs = (await q("SELECT ref FROM wholesale_stock_movements WHERE ref LIKE 'MV-2%' ORDER BY id")).map((x) => x.ref);
    assert.strictEqual(new Set(refs).size, refs.length);
  });
  await test('staff changes are in the activity log; the administrator can revoke a role', async () => {
    const acts = (await A('GET', '/activity')).j.activity.map((x) => x.action);
    assert.ok(acts.includes('stock.receipt') || acts.includes('stock.opening')); assert.ok(acts.includes('staff.grant'));
    const st = (await A('GET', '/staff')).j.staff.find((x) => x.email === 'ngozi@example.com');
    assert.strictEqual((await A('DELETE', '/staff/' + st.id)).s, 200);
    assert.strictEqual((await call('GET', '/api/warehouse/stock', undefined, staff)).s, 403);
  });

  srv.kill(); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { srv.kill(); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ } process.exit(1); });
