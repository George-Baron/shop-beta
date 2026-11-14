'use strict';
// Partner stores: apply, evaluate, approve, review products, search by store, mixed carts, commission, payouts.
// Run with: npm run test:vendors   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_vend_' + tag;
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
const PW = 'Partner-Test-Pass-2026!';
const applyBody = (o = {}) => ({ name: 'Mama Ngozi Foods', contactName: 'Ngozi Eze', email: 'ngozi.store@example.com', phone: '08031234567', address: '12 Market Road, Yaba', state: 'Lagos', city: 'Yaba', regNo: 'RC1234567', about: 'Fresh foods and groceries.', password: PW, departments: ['supermarket', 'food'], ...o });
const goods = (o = {}) => ({ name: 'Honey Beans 1kg', store: 'supermarket', price: 2500, stock: 20, description: 'Clean beans', active: true, ...o });

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-vend-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, u, b, admin);
  let v1, v1c, prod1, v2, v2c;
  // Delivery needs our own pickup point (for our products) and a rider covering the state, exactly as in the live shop.
  assert.strictEqual((await A('POST', '/api/admin/partners', { name: 'Shop-Beta Main Store', address: 'Ikeja, Lagos', state: 'Lagos', phone: '08000000001', lat: 6.6018, lng: 3.3515, radius_km: 40, is_default: true })).s, 200);
  assert.strictEqual((await A('POST', '/api/admin/riders', { name: 'Rider One', email: 'rider1@example.com', phone: '08033334444', password: 'RiderPass12345', coverage: 'Lagos' })).s, 200);

  console.log('\nApplying');
  await test('an application needs the business details, a strong password and at most 3 departments (no medicines)', async () => {
    assert.strictEqual((await call('POST', '/api/partners/apply', applyBody({ regNo: '' }))).s, 400);
    assert.strictEqual((await call('POST', '/api/partners/apply', applyBody({ password: 'password123' }))).s, 400);
    assert.strictEqual((await call('POST', '/api/partners/apply', applyBody({ departments: ['supermarket', 'food', 'beauty', 'fashion'] }))).s, 400);
    assert.strictEqual((await call('POST', '/api/partners/apply', applyBody({ departments: ['pharmacy'] }))).s, 400);
    assert.strictEqual((await call('POST', '/api/partners/apply', applyBody({ departments: [] }))).s, 400);
    const ok = await call('POST', '/api/partners/apply', applyBody()); assert.strictEqual(ok.s, 200, ok.t);
    assert.strictEqual((await call('POST', '/api/partners/apply', applyBody())).s, 409, 'same email');
    v1 = (await q("SELECT * FROM vendors WHERE email='ngozi.store@example.com'"))[0]; assert.strictEqual(v1.status, 'pending');
  });
  await test('the database itself refuses a 4th department', async () => {
    await q("INSERT INTO vendor_departments (vendor_id, store) VALUES ($1,'beauty')", [v1.id]); // third
    await assert.rejects(() => q("INSERT INTO vendor_departments (vendor_id, store) VALUES ($1,'electronics')", [v1.id]), /at most 3/);
    await q("DELETE FROM vendor_departments WHERE vendor_id=$1 AND store='beauty'", [v1.id]);
  });
  await test('a store under evaluation is invisible to customers', async () => {
    assert.strictEqual((await call('GET', '/api/vendors')).j.stores.length, 0);
    assert.strictEqual((await call('GET', '/api/vendors/' + v1.slug)).s, 404);
  });

  console.log('\nPartner portal');
  await test('only the store itself can open the portal', async () => {
    assert.strictEqual((await call('GET', '/api/partner/me')).s, 401);
    assert.strictEqual((await A('GET', '/api/partner/me')).s, 401, 'admin is not a store');
    v1c = await login('ngozi.store@example.com', PW);
    const me = (await call('GET', '/api/partner/me', undefined, v1c)).j; assert.strictEqual(me.store.status, 'pending'); assert.strictEqual(me.store.departments.length, 2);
    assert.ok(!('commission_pct' in me.store), 'a store does not see its commission through the profile');
  });
  await test('products: only in own departments, never medicines, always pending first', async () => {
    assert.strictEqual((await call('POST', '/api/partner/products', goods({ store: 'fashion' }), v1c)).s, 400);
    assert.strictEqual((await call('POST', '/api/partner/products', goods({ store: 'pharmacy' }), v1c)).s, 400);
    const r = await call('POST', '/api/partner/products', goods(), v1c); assert.strictEqual(r.s, 200, r.t); prod1 = r.j.id;
    assert.strictEqual((await q('SELECT listing FROM products WHERE id=$1', [prod1]))[0].listing, 'pending');
    const f = await call('POST', '/api/partner/products', goods({ name: 'Featured try', featured: true, bestseller: true }), v1c);
    const row = (await q('SELECT featured, bestseller FROM products WHERE id=$1', [f.j.id]))[0]; assert.ok(!row.featured && !row.bestseller, 'stores cannot feature themselves');
    await q('DELETE FROM products WHERE id=$1', [f.j.id]);
  });

  console.log('\nApproval');
  await test('approval needs a map position; then the store becomes a rider pickup point', async () => {
    assert.strictEqual((await A('POST', `/api/admin/vendors/${v1.id}/approve`)).s, 400);
    const u = await A('PUT', `/api/admin/vendors/${v1.id}`, { name: v1.name, commission_pct: 12, lat: 6.5095, lng: 3.3711, address: v1.address, state: 'Lagos', phone: v1.phone, email: v1.email, reg_no: v1.reg_no, departments: [{ store: 'supermarket', commission_pct: 15 }, { store: 'food' }] });
    assert.strictEqual(u.s, 200, u.t);
    assert.strictEqual((await A('PUT', `/api/admin/vendors/${v1.id}`, { name: v1.name, lat: 6.5, lng: 3.3, reg_no: 'x', departments: ['supermarket', 'food', 'beauty', 'fashion'] })).s, 400, 'admin cannot exceed 3 either');
    assert.strictEqual((await A('POST', `/api/admin/vendors/${v1.id}/approve`)).s, 200);
    const v = (await q('SELECT * FROM vendors WHERE id=$1', [v1.id]))[0]; assert.strictEqual(v.status, 'approved'); assert.ok(v.partner_id);
    assert.strictEqual((await q('SELECT partner_id FROM products WHERE id=$1', [prod1]))[0].partner_id, v.partner_id);
  });
  await test('an approved store is listed, but its product stays hidden until we approve that product', async () => {
    assert.strictEqual((await call('GET', '/api/vendors')).j.stores.length, 1);
    assert.strictEqual((await call('GET', '/api/products?q=honey+beans')).j.total, 0);
    assert.strictEqual((await A('POST', `/api/admin/vendors/review/products/${prod1}`, { decision: 'rejected' })).s, 400, 'rejecting needs a reason');
    const rev = (await A('GET', '/api/admin/vendors/review/products')).j.products; assert.ok(rev.some((p) => p.id == prod1));
    assert.strictEqual((await A('POST', `/api/admin/vendors/review/products/${prod1}`, { decision: 'approved' })).s, 200);
    assert.strictEqual((await call('GET', '/api/products?q=honey+beans')).j.total, 1);
  });

  console.log('\nShopping');
  await test('search shows the stores: by product, by store name, and filtered to one store', async () => {
    const s = (await call('GET', '/api/products?q=honey')).j;
    assert.ok(s.stores.some((x) => x.slug === v1.slug && x.n === 1), 'store facet');
    assert.strictEqual(s.products.find((p) => p.vendor).vendor.name, 'Mama Ngozi Foods');
    const byName = (await call('GET', '/api/products?q=ngozi')).j; assert.ok(byName.matchedStores.some((m) => m.slug === v1.slug)); assert.ok(byName.products.some((p) => /Honey/.test(p.name)), 'store name finds its products');
    const only = (await call('GET', `/api/products?vendor=${v1.slug}`)).j; assert.ok(only.products.length === 1);
    const ours = (await call('GET', '/api/products?vendor=ours&store=fashion')).j; assert.ok(ours.products.length > 3 && ours.products.every((p) => !p.vendor));
    assert.ok((await call('GET', '/api/vendors?store=supermarket')).j.stores.length === 1 && (await call('GET', '/api/vendors?store=fashion')).j.stores.length === 0);
  });
  await test('the public store page shows the store but none of its private details', async () => {
    const r = await call('GET', '/api/vendors/' + v1.slug); assert.strictEqual(r.s, 200);
    assert.ok(r.j.departments.length === 2);
    for (const k of ['email', 'phone', 'reg_no', 'commission', 'contact_name', 'address']) assert.ok(!r.t.includes('"' + k + '"'), k + ' must not be public');
  });
  let order;
  await test('one cart can hold our products and a partner store\'s; the order records each store\'s share and commission', async () => {
    const ours = (await call('GET', '/api/products?store=fashion&vendor=ours')).j.products.find((p) => /Tote/.test(p.name));
    const items = [{ productId: prod1, qty: 4 }, { productId: ours.id, qty: 1 }];
    const priced = (await call('POST', '/api/cart/price', { items, state: 'Lagos' })).j;
    assert.strictEqual(priced.lines.length, 2); assert.strictEqual(priced.lines.find((l) => l.productId == prod1).vendorName, 'Mama Ngozi Foods'); assert.strictEqual(priced.lines.find((l) => l.productId == ours.id).vendorName, '');
    const r = await call('POST', '/api/checkout', { items, contact: { name: 'Ada Obi', email: 'ada@example.com', phone: '08011112222' }, address: { state: 'Lagos', city: 'Yaba', address: '9 Private Close, Yaba' }, location: { lat: 6.5095, lng: 3.3711, landmark: 'gate' }, delivery: 'standard', payment: 'pod', idempotencyKey: 'vend-' + tag + '-1' });
    assert.strictEqual(r.s, 200, r.t); order = r.j;
    const rows = await q('SELECT vendor_id, price, qty, commission_pct, commission FROM order_items WHERE order_id=(SELECT id FROM orders WHERE ref=$1) ORDER BY id', [order.ref || order.order.ref]);
    const mine = rows.find((x) => x.vendor_id == v1.id), own = rows.find((x) => x.vendor_id == null);
    assert.strictEqual(Number(mine.commission_pct), 15, 'the department rate beats the store rate'); assert.strictEqual(mine.commission, Math.floor(2500 * 4 * 0.15)); assert.strictEqual(own.commission, 0);
  });
  await test('the store sees its own items only, and no customer address or phone', async () => {
    const o = (await call('GET', '/api/partner/orders', undefined, v1c)).j.orders; assert.strictEqual(o.length, 1);
    assert.strictEqual(o[0].items.length, 1); assert.strictEqual(o[0].gross, 10000); assert.strictEqual(o[0].net, 10000 - 1500);
    const t = JSON.stringify(o); assert.ok(!/Private Close|08011112222|ada@example/.test(t));
  });

  console.log('\nMoney');
  await test('a store is owed money only for delivered orders; payouts cannot exceed the balance', async () => {
    const id = order.id || (await q('SELECT id FROM orders WHERE ref=$1', [order.ref || order.order.ref]))[0].id;
    assert.strictEqual((await call('GET', '/api/partner/earnings', undefined, v1c)).j.balance, 0);
    await q("UPDATE orders SET status='delivered', payment_status='paid' WHERE id=$1", [id]);
    let e = (await call('GET', '/api/partner/earnings', undefined, v1c)).j; assert.strictEqual(e.gross, 10000); assert.strictEqual(e.commission, 1500); assert.strictEqual(e.balance, 8500);
    assert.strictEqual((await A('POST', `/api/admin/vendors/${v1.id}/payouts`, { amount: 9000 })).s, 409);
    assert.strictEqual((await A('POST', `/api/admin/vendors/${v1.id}/payouts`, { amount: 5000, reference: 'TRF-1' })).s, 200);
    e = (await call('GET', '/api/partner/earnings', undefined, v1c)).j; assert.strictEqual(e.balance, 3500); assert.strictEqual(e.payouts.length, 1);
    assert.strictEqual((await A('GET', '/api/admin/vendors/payables')).j.owed, 3500);
    await q("UPDATE orders SET status='refunded' WHERE id=$1", [id]);
    assert.strictEqual((await call('GET', '/api/partner/earnings', undefined, v1c)).j.gross, 0, 'a refunded order is no longer earned');
    await q("UPDATE orders SET status='delivered' WHERE id=$1", [id]);
  });

  console.log('\nChanges and safety');
  await test('changing what a product is sends it back for review; changing price or stock does not', async () => {
    const cur = (await call('GET', '/api/partner/products/' + prod1, undefined, v1c)).j.product;
    let r = await call('PUT', '/api/partner/products/' + prod1, { ...cur, price: 2700, stock: 30 }, v1c); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.resubmitted, false);
    assert.strictEqual((await call('GET', '/api/products?q=honey+beans')).j.total, 1);
    r = await call('PUT', '/api/partner/products/' + prod1, { ...cur, price: 2700, stock: 30, description: 'Now with a new description' }, v1c); assert.strictEqual(r.j.resubmitted, true);
    assert.strictEqual((await call('GET', '/api/products?q=honey+beans')).j.total, 0, 'hidden while re-reviewed');
    assert.strictEqual((await A('POST', `/api/admin/vendors/review/products/${prod1}`, { decision: 'approved' })).s, 200);
  });
  await test('a store cannot touch another store\'s products', async () => {
    assert.strictEqual((await call('POST', '/api/partners/apply', applyBody({ name: 'Beauty Corner', email: 'beauty@example.com', departments: ['beauty'] }))).s, 200);
    v2 = (await q("SELECT * FROM vendors WHERE email='beauty@example.com'"))[0]; v2c = await login('beauty@example.com', PW);
    assert.strictEqual((await call('GET', '/api/partner/products/' + prod1, undefined, v2c)).s, 404);
    assert.strictEqual((await call('PUT', '/api/partner/products/' + prod1, goods(), v2c)).s, 404);
    assert.strictEqual((await call('DELETE', '/api/partner/products/' + prod1, undefined, v2c)).s, 404);
    assert.strictEqual((await call('PUT', `/api/partner/products/${prod1}/stock`, { stock: 0 }, v2c)).s, 404);
    assert.strictEqual((await call('GET', '/api/partner/products', undefined, v2c)).j.products.length, 0);
  });
  await test('pausing a store hides it and its products, and stops new orders for them', async () => {
    assert.strictEqual((await A('POST', `/api/admin/vendors/${v1.id}/suspend`, { note: 'Under review' })).s, 200);
    assert.strictEqual((await call('GET', '/api/vendors')).j.stores.length, 0);
    assert.strictEqual((await call('GET', '/api/products?q=honey+beans')).j.total, 0);
    const p = (await call('POST', '/api/cart/price', { items: [{ productId: prod1, qty: 1 }] })).j; assert.strictEqual(p.lines.length, 0); assert.ok(p.issues.length);
    assert.strictEqual((await A('POST', `/api/admin/vendors/${v1.id}/reinstate`)).s, 200);
    assert.strictEqual((await call('GET', '/api/products?q=honey+beans')).j.total, 1);
  });
  await test('our own shop still works exactly as before (no store involved)', async () => {
    const r = await call('GET', '/api/home/fashion'); assert.ok(r.j.featured.length >= 5 && r.j.featured.every((p) => p.vendor === null));
  });

  srv.kill(); await sleep(300);
  await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); srv && srv.kill(); console.error(log.slice(-2500)); process.exit(1); });
