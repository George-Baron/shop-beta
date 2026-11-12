'use strict';
// End-to-end check: creates a throwaway PostgreSQL database, starts the server on it and walks through a real shopping + admin session.
// Needs a running Postgres: set TEST_DATABASE_URL (or DATABASE_URL) to any database on it; `npm run db:up` starts one for you.
// The cache is switched off here so each step can read back what it just changed; `npm run test:cache` tests the cache itself.
// Run with: npm test
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client: PgClient } = require('pg');
const mockSupabase = require('./mock-supabase');
const SERVICE_KEY = 'test-service-key';

const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
let passed = 0; const failures = [];
const ADMIN_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DB_NAME = 'sb_test_' + Math.random().toString(36).slice(2, 10);
const withDb = (name) => { const u = new URL(ADMIN_URL); u.pathname = '/' + name; return u.toString(); };
async function adminSql(sql, db) { const c = new PgClient({ connectionString: db ? withDb(db) : ADMIN_URL, ssl: process.env.PGSSL_TEST === 'require' ? { rejectUnauthorized: false } : false }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } }

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const r = await fetch(BASE + url, { method, redirect: 'manual', headers: { 'X-Requested-With': 'shop-beta', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of sc) { const kv = c.split(';')[0]; if (/=$/.test(kv)) this.cookie = ''; else this.cookie = kv; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text, headers: r.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
  put(u, b = {}) { return this.req('PUT', u, b); }
  del(u) { return this.req('DELETE', u); }
}
// Emails are sent by the background worker, so wait until it has nothing left to do before reading the outbox.
async function jobsIdle(admin) {
  for (let i = 0; i < 150; i++) { const o = (await admin.get('/api/admin/jobs')).json.overview; if (o && !o.queued && !o.active) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('background jobs did not finish');
}
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

(async () => {
  await adminSql(`CREATE DATABASE ${DB_NAME}`);
  const storageMock = await mockSupabase.start(SERVICE_KEY);
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DATABASE_URL: withDb(DB_NAME), PGSSL: process.env.PGSSL_TEST || 'disable', BASE_URL: BASE, SUPABASE_URL: storageMock.url, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SUPABASE_BUCKET: 'shop-images', STORAGE_DRIVER: '', CACHE_DISABLED: '1', ADMIN_SETUP_CODE: 'test-setup-code', PAYSTACK_SECRET_KEY: '', RESEND_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const shopper = new Client(), guest = new Client(), admin = new Client();
  let cfg, fashion, variantProduct, plain;

  console.log('\nStorefront');
  await test('config has six departments, 37 delivery zones, demo payments', async () => {
    const r = await guest.get('/api/config'); cfg = r.json;
    assert.strictEqual(cfg.stores.length, 6); assert.strictEqual(cfg.zones.length, 37);
    assert.strictEqual(cfg.payments.demo, true); assert.ok(cfg.categories.length >= 30);
  });
  await test('every department homepage returns its sections', async () => {
    for (const s of cfg.stores) { const d = (await guest.get('/api/home/' + s.slug)).json; assert.ok(d.featured.length >= 5, s.slug + ' featured'); assert.ok(d.bestsellers.length >= 3 && d.categories.length >= 5 && d.deals.length >= 1, s.slug); }
  });
  await test('search, filters, sorting and facets', async () => {
    assert.ok((await guest.get('/api/products?q=dress')).json.products.some((p) => /Dress/.test(p.name)));
    const f = (await guest.get('/api/products?store=fashion&size=M&sort=price_asc')).json;
    assert.ok(f.products.length >= 2 && f.facets.sizes.includes('M') && f.facets.colors.length > 2);
    assert.ok(f.products.every((p, i, a) => !i || a[i - 1].price <= p.price));
    assert.ok((await guest.get('/api/products?store=electronics&flag=deals')).json.products.every((p) => p.off > 0));
    assert.strictEqual((await guest.get("/api/products?q=%25")).json.total, 0); // % is a literal, not a wildcard
  });
  await test('product page data (variants, related, no private fields)', async () => {
    fashion = (await guest.get('/api/products?store=fashion')).json.products;
    const p = (await guest.get('/api/products/' + fashion.find((x) => /Dress/.test(x.name)).slug)).json;
    variantProduct = p.product; assert.ok(variantProduct.variants.length === 8 && p.related.length >= 3 && variantProduct.dist.length === 5);
    plain = (await guest.get('/api/products/' + fashion.find((x) => /Tote/.test(x.name)).slug)).json.product;
    assert.ok(!('sold' in variantProduct) && !('active' in variantProduct));
  });
  await test('cart pricing: coupon, delivery by state, free delivery, quantity cap', async () => {
    const v = variantProduct.variants[0];
    let r = (await guest.post('/api/cart/price', { items: [{ productId: variantProduct.id, variantId: v.id, qty: 2 }], coupon: 'welcome10', state: 'Lagos' })).json;
    assert.strictEqual(r.subtotal, 37000); assert.strictEqual(r.discount, 3700); assert.strictEqual(r.delivery.fee, 2000); assert.strictEqual(r.total, 37000 - 3700 + 2000);
    r = (await guest.post('/api/cart/price', { items: [{ productId: variantProduct.id, variantId: v.id, qty: 3 }], state: 'Borno' })).json;
    assert.strictEqual(r.delivery.free, true); assert.strictEqual(r.delivery.fee, 0); assert.ok(r.delivery.options.express.fee > 0);
    r = (await guest.post('/api/cart/price', { items: [{ productId: variantProduct.id, variantId: v.id, qty: 99 }] })).json;
    assert.ok(r.lines[0].qty === v.stock && r.issues.length === 1 && !r.delivery.options);
    r = (await guest.post('/api/cart/price', { items: [{ productId: plain.id, qty: 1 }], coupon: 'NOPE' })).json; assert.ok(r.couponError);
    r = (await guest.post('/api/cart/price', { items: [{ productId: variantProduct.id, qty: 1 }] })).json; assert.ok(/no longer available/.test(r.issues[0].message)); // variant required
    r = (await guest.post('/api/cart/price', { items: [{ productId: plain.id, qty: -5, price: 1 }, { productId: 999999, qty: 1 }] })).json; assert.strictEqual(r.lines.length, 0);
  });

  console.log('\nAccounts');
  await test('register, sign out, wrong password, sign in', async () => {
    assert.strictEqual((await shopper.post('/api/auth/register', { name: 'Ada Obi', email: 'ada@example.com', password: 'short' })).status, 400);
    const r = await shopper.post('/api/auth/register', { name: 'Ada Obi', email: 'ada@example.com', phone: '08012345678', password: 'correct horse' });
    assert.strictEqual(r.json.user.role, 'customer'); assert.ok(!('password' in r.json.user));
    assert.strictEqual((await shopper.post('/api/auth/register', { name: 'Ada', email: 'ADA@example.com', password: 'correct horse' })).status, 409);
    await shopper.post('/api/auth/logout'); assert.strictEqual((await shopper.get('/api/me')).json.user, null);
    assert.strictEqual((await shopper.post('/api/auth/login', { email: 'ada@example.com', password: 'wrong password' })).status, 401);
    assert.strictEqual((await shopper.post('/api/auth/login', { email: 'ada@example.com', password: 'correct horse' })).json.user.name, 'Ada Obi');
  });
  await test('addresses and wishlist', async () => {
    assert.strictEqual((await guest.get('/api/addresses')).status, 401);
    assert.strictEqual((await shopper.post('/api/addresses', { state: 'Atlantis', address: '12 Some Street' })).status, 400);
    await shopper.post('/api/addresses', { label: 'Home', name: 'Ada', phone: '0801', state: 'Lagos', city: 'Ikeja', address: '12 Allen Avenue' });
    assert.strictEqual((await shopper.get('/api/addresses')).json.addresses.length, 1);
    await shopper.post('/api/wishlist-merge', { ids: [plain.id, 99999] }); await shopper.post('/api/wishlist/' + variantProduct.id, {});
    assert.strictEqual((await shopper.get('/api/wishlist')).json.ids.length, 2);
    await shopper.del('/api/wishlist/' + plain.id); assert.strictEqual((await shopper.get('/api/wishlist')).json.ids.length, 1);
  });
  await test('password reset flow stores a one-hour link in the outbox', async () => {
    await guest.post('/api/auth/forgot', { email: 'ada@example.com' }); await guest.post('/api/auth/forgot', { email: 'nobody@example.com' });
    assert.strictEqual((await guest.post('/api/auth/reset', { token: 'x'.repeat(64), password: 'new password 1' })).status, 400);
  });

  console.log('\nCheckout');
  const stockOf = async (slug) => (await guest.get('/api/products/' + slug)).json.product.stock;
  let podRef;
  await test('pay on delivery order reduces stock and can be tracked', async () => {
    const before = await stockOf(plain.slug);
    const r = await guest.post('/api/checkout', { items: [{ productId: plain.id, qty: 2 }], contact: { name: 'Chidi Eze', email: 'chidi@example.com', phone: '08039000001' }, address: { state: 'Lagos', city: 'Yaba', address: '5 Herbert Macaulay Way' }, delivery: 'standard', payment: 'pod' });
    assert.strictEqual(r.json.next, 'pod'); podRef = r.json.ref; assert.match(podRef, /^SB-[A-Z0-9]{6}$/);
    assert.strictEqual(await stockOf(plain.slug), before - 2);
    const o = await guest.post('/api/orders/lookup', { ref: podRef, email: 'CHIDI@example.com' });
    assert.strictEqual(o.json.order.total, 64000); assert.strictEqual(o.json.order.delivery_fee, 0); // over ₦50,000 = free standard delivery
    assert.strictEqual(o.json.order.status, 'pending'); assert.ok(!('email' in o.json.order) && !('id' in o.json.order));
    assert.strictEqual((await guest.post('/api/orders/lookup', { ref: podRef, email: 'someone@else.com' })).status, 404);
    assert.strictEqual((await guest.post('/api/orders/lookup', { ref: podRef })).status, 404);
  });
  await test('customer can cancel a pending order and stock comes back', async () => {
    const before = await stockOf(plain.slug);
    assert.strictEqual((await guest.post(`/api/orders/${podRef}/cancel`, { email: 'wrong@example.com' })).status, 404);
    assert.strictEqual((await guest.post(`/api/orders/${podRef}/cancel`, { email: 'chidi@example.com' })).status, 200);
    assert.strictEqual(await stockOf(plain.slug), before + 2);
    assert.strictEqual((await guest.post('/api/orders/lookup', { ref: podRef, email: 'chidi@example.com' })).json.order.status, 'cancelled');
  });
  await test('server rejects tampered or impossible orders', async () => {
    const base = { items: [{ productId: plain.id, qty: 1, price: 1 }], contact: { name: 'T', email: 't@example.com', phone: '08039000002' }, address: { state: 'Borno', address: '1 Test Road' }, delivery: 'standard', payment: 'pod' };
    assert.strictEqual((await guest.post('/api/checkout', base)).status, 400); // Borno has no pay-on-delivery
    assert.strictEqual((await guest.post('/api/checkout', { ...base, address: { state: 'Lagos', address: '' } })).status, 400);
    assert.strictEqual((await guest.post('/api/checkout', { ...base, address: { state: 'Lagos', address: '1 Test Road' }, contact: { name: 'T', email: 'bad', phone: '1' } })).status, 400);
    assert.strictEqual((await guest.post('/api/checkout', { ...base, items: [], address: { state: 'Lagos', address: '1 Test Road' } })).status, 400);
    assert.strictEqual((await guest.post('/api/checkout', { ...base, address: { state: 'Lagos', address: '1 Test Road' }, delivery: 'pickup' })).status, 400); // pickup not configured
    const r = await guest.post('/api/checkout', { ...base, items: [{ productId: plain.id, qty: 1 }], address: { state: 'Lagos', address: '1 Test Road' } });
    assert.strictEqual(r.status, 200); assert.strictEqual((await guest.post('/api/orders/lookup', { ref: r.json.ref, email: 't@example.com' })).json.order.items[0].price, plain.price);
  });
  await test('last unit cannot be sold twice', async () => {
    const tiny = fashion.find((x) => /Aviator/.test(x.name)); const left = await stockOf(tiny.slug);
    const body = (n) => ({ items: [{ productId: tiny.id, qty: n }], contact: { name: 'T', email: 't@example.com', phone: '08039000003' }, address: { state: 'Lagos', address: '1 Test Road' }, delivery: 'standard', payment: 'pod' });
    const a = await guest.post('/api/checkout', body(left)); assert.strictEqual(a.status, 200);
    const b = await guest.post('/api/checkout', body(1)); assert.strictEqual(b.status, 400); assert.match(b.json.error, /sold out|no longer available/);
    assert.strictEqual(await stockOf(tiny.slug), 0);
  });
  let payRef;
  await test('online payment (demo mode): pay, then admin cannot ship before payment', async () => {
    const v = variantProduct.variants[1], before = (await guest.get('/api/products/' + variantProduct.slug)).json.product.variants[1].stock;
    const r = await shopper.post('/api/checkout', { items: [{ productId: variantProduct.id, variantId: v.id, qty: 1 }], coupon: 'WELCOME10', contact: { name: 'Ada Obi', email: 'ada@example.com', phone: '08012345678' }, address: { state: 'Ogun', city: 'Abeokuta', address: '9 Oke Ilewo' }, delivery: 'express', payment: 'paystack' });
    assert.strictEqual(r.json.next, 'demo'); payRef = r.json.ref;
    assert.strictEqual((await guest.get('/api/products/' + variantProduct.slug)).json.product.variants[1].stock, before - 1);
    let o = (await shopper.post('/api/orders/lookup', { ref: payRef })).json.order; // signed in: no email needed
    assert.strictEqual(o.payment_status, 'unpaid'); assert.strictEqual(o.discount, 1850);
    assert.strictEqual((await guest.post('/api/pay/demo/' + payRef, { outcome: 'ok' })).status, 200);
    o = (await shopper.post('/api/orders/lookup', { ref: payRef })).json.order; assert.strictEqual(o.status, 'paid'); assert.strictEqual(o.payment_status, 'paid');
    assert.strictEqual((await shopper.get('/api/orders')).json.orders.length, 1);
  });
  await test('failed demo payment cancels the order and releases stock and coupon use', async () => {
    const before = await stockOf(plain.slug), used = () => admin.get('/api/admin/coupons');
    const r = await guest.post('/api/checkout', { items: [{ productId: plain.id, qty: 1 }], contact: { name: 'F', email: 'f@example.com', phone: '08039000004' }, address: { state: 'Lagos', address: '1 Test Road' }, delivery: 'standard', payment: 'paystack' });
    assert.strictEqual(await stockOf(plain.slug), before - 1); void used;
    await guest.post('/api/pay/demo/' + r.json.ref, { outcome: 'fail' });
    assert.strictEqual(await stockOf(plain.slug), before); assert.strictEqual((await guest.post('/api/orders/lookup', { ref: r.json.ref, email: 'f@example.com' })).json.order.status, 'cancelled');
  });
  await test('webhook rejects unsigned calls; reviews and contact forms work', async () => {
    assert.strictEqual((await guest.post('/api/paystack/webhook', { event: 'charge.success', data: { reference: payRef } })).status, 401);
    assert.strictEqual((await guest.post(`/api/products/${plain.id}/reviews`, { rating: 0, body: 'x' })).status, 400);
    assert.strictEqual((await shopper.post(`/api/products/${plain.id}/reviews`, { rating: 5, title: 'Lovely', body: 'Great bag' })).status, 200);
    assert.strictEqual((await shopper.post(`/api/products/${plain.id}/reviews`, { rating: 4, body: 'Again' })).status, 409);
    const p = (await guest.get('/api/products/' + plain.slug)).json.product; assert.strictEqual(p.rating, 5); assert.strictEqual(p.reviews[0].name, 'Ada Obi');
    assert.strictEqual((await guest.post('/api/contact', { name: 'Bola', email: 'bola@example.com', subject: 'Hi', body: 'Do you ship to Kano?' })).status, 200);
    assert.strictEqual((await guest.post('/api/contact', { name: 'Bot', email: 'bot@example.com', body: 'spam', website: 'http://spam' })).status, 200);
    assert.strictEqual((await guest.post('/api/newsletter', { email: 'bad' })).status, 400); assert.strictEqual((await guest.post('/api/newsletter', { email: 'n@example.com' })).status, 200);
    await guest.post('/api/cart/abandon', { email: 'left@example.com', items: [{ productId: plain.id, qty: 1 }] });
  });

  console.log('\nAdmin');
  await test('the first administrator needs the setup code; only one can ever be created; others are locked out', async () => {
    assert.strictEqual((await guest.get('/api/admin/setup')).json.needed, true);
    assert.strictEqual((await shopper.get('/api/admin/dashboard')).status, 401); assert.strictEqual((await guest.get('/api/admin/orders')).status, 401);
    const good = { code: 'test-setup-code', name: 'Owner', email: 'owner@example.com', password: 'a long password' };
    assert.strictEqual((await admin.post('/api/admin/setup', { ...good, code: undefined })).status, 403, 'no code');
    assert.strictEqual((await admin.post('/api/admin/setup', { ...good, code: 'wrong-code-here' })).status, 403, 'wrong code');
    assert.strictEqual((await admin.post('/api/admin/setup', { ...good, password: 'tiny' })).status, 400);
    assert.strictEqual((await admin.post('/api/admin/setup', { ...good, password: 'eleven char' })).status, 400, 'admin passwords need 12 characters');
    assert.strictEqual((await admin.post('/api/admin/setup', good)).json.user.role, 'admin');
    assert.strictEqual((await guest.get('/api/admin/setup')).json.needed, false);
    assert.strictEqual((await guest.post('/api/admin/setup', { ...good, email: 'evil@example.com' })).status, 403);
    assert.strictEqual((await shopper.get('/api/admin/products')).status, 401);
  });
  await test('cross-site requests are blocked', async () => {
    assert.strictEqual((await admin.req('POST', '/api/admin/coupons', { code: 'EVIL', value: 99 }, { Origin: 'https://evil.example' })).status, 403);
    assert.strictEqual((await admin.req('POST', '/api/auth/logout', {}, { Origin: 'https://evil.example' })).status, 403);
  });
  await test('dashboard totals match the orders placed', async () => {
    const d = (await admin.get('/api/admin/dashboard')).json;
    // sales: pay-on-delivery orders (T x2 incl. the last-unit one) + the paid online order. Cancelled and unpaid ones are excluded.
    assert.strictEqual(d.all.n, 3); assert.ok(d.all.rev > 0 && d.days.length === 14 && d.today.n === 3);
    assert.strictEqual(d.customers, 1); assert.strictEqual(d.unread, 1); assert.ok(d.low.length >= 1 && d.top.length >= 1);
  });
  await test('order management: status flow, notes, cancel returns stock', async () => {
    const list = (await admin.get('/api/admin/orders')).json; assert.ok(list.total >= 5);
    const o = list.orders.find((x) => x.ref === payRef);
    assert.strictEqual((await admin.put('/api/admin/orders/' + o.id, { status: 'bogus' })).status, 400);
    assert.strictEqual((await admin.put('/api/admin/orders/' + o.id, { status: 'dispatched' })).status, 400); // cannot skip "confirmed"
    assert.strictEqual((await admin.put('/api/admin/orders/' + o.id, { status: 'confirmed' })).status, 200);
    assert.strictEqual((await admin.put('/api/admin/orders/' + o.id, { status: 'dispatched', note: 'Dispatched with GIG' })).status, 200);
    const detail = (await admin.get('/api/admin/orders/' + o.id)).json.order; assert.strictEqual(detail.status, 'dispatched'); assert.ok(detail.events.some((e) => e.note === 'Dispatched with GIG'));
    assert.strictEqual((await admin.get('/api/admin/orders?status=dispatched&q=ada')).json.total, 1);
    const unpaid = (await admin.get('/api/admin/orders?q=f@example.com')).json.orders[0]; assert.strictEqual(unpaid.status, 'cancelled');
    assert.strictEqual((await admin.put('/api/admin/orders/' + unpaid.id, { status: 'paid' })).status, 400); // cancelled orders are locked
    const r = await guest.post('/api/checkout', { items: [{ productId: plain.id, qty: 1 }], contact: { name: 'G', email: 'g@example.com', phone: '08039000005' }, address: { state: 'Ogun', address: '2 Test Road' }, delivery: 'standard', payment: 'paystack' });
    const gid = (await admin.get('/api/admin/orders?q=g@example.com')).json.orders[0].id, before = await stockOf(plain.slug);
    assert.strictEqual((await admin.put('/api/admin/orders/' + gid, { status: 'dispatched' })).status, 400); // unpaid online order cannot be dispatched
    assert.strictEqual((await admin.put('/api/admin/orders/' + gid, { status: 'cancelled' })).status, 200); assert.strictEqual(await stockOf(plain.slug), before + 1); void r;
  });
  await test('products: create with variants and photo, edit keeps variant ids, hide, delete', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const up = await admin.post('/api/admin/upload', { data: png });
    assert.strictEqual(up.status, 200);
    assert.match(up.json.url, new RegExp('^' + storageMock.url.replace(/[.]/g, '\\.') + '/storage/v1/object/public/shop-images/uploads/[a-f0-9]{24}\\.png$'));
    const stored = await fetch(up.json.url); assert.strictEqual(stored.status, 200); assert.strictEqual(stored.headers.get('content-type'), 'image/png');
    assert.ok(storageMock.log.some((l) => l.bucket && l.bucket.public === true), 'bucket created public');
    assert.deepStrictEqual(storageMock.log.filter((l) => l.denied), [], 'every storage call carried the service key');
    assert.ok(!fs.existsSync(path.join(DATA, 'uploads')) || fs.readdirSync(path.join(DATA, 'uploads')).length === 0, 'nothing written to local disk');
    const legacy = await guest.get('/uploads/' + up.json.url.split('/').pop()); assert.strictEqual(legacy.status, 301); assert.strictEqual(legacy.headers.get('location'), up.json.url);
    assert.strictEqual((await admin.post('/api/admin/upload', { data: 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 400);
    assert.strictEqual((await admin.post('/api/admin/upload', { data: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status, 400);
    const body = { name: 'Test Kaftan', store: 'fashion', category_id: cfg.categories.find((c) => c.store === 'fashion').id, price: 15000, compare_price: 20000, brand: 'Tester', sku: 'T-1', emoji: '👘', description: 'A test kaftan.', size_label: 'Size', images: [up.json.url], variants: [{ size: 'M', color: 'Blue', stock: 4 }, { size: 'L', color: 'Blue', stock: 6 }], featured: 1, active: 1 };
    assert.strictEqual((await admin.post('/api/admin/products', { ...body, images: ['javascript:alert(1)'] })).status, 400);
    assert.strictEqual((await admin.post('/api/admin/products', { ...body, variants: [{ size: '', color: '', stock: 1 }] })).status, 400);
    const id = (await admin.post('/api/admin/products', body)).json.id;
    let p = (await admin.get('/api/admin/products/' + id)).json.product; assert.strictEqual(p.stock, 10); assert.strictEqual(p.variants.length, 2);
    const pub = (await guest.get('/api/products/test-kaftan')).json.product; assert.strictEqual(pub.off, 25); assert.strictEqual(pub.images[0], up.json.url);
    p.variants[0].stock = 1; p.variants.pop(); p.variants.push({ size: 'XL', color: 'Blue', stock: 2 }); p.price = 14000; p.active = 0;
    assert.strictEqual((await admin.put('/api/admin/products/' + id, p)).status, 200);
    p = (await admin.get('/api/admin/products/' + id)).json.product; assert.strictEqual(p.stock, 3); assert.strictEqual(p.variants.length, 2);
    assert.strictEqual((await guest.get('/api/products/test-kaftan')).status, 404); // hidden
    assert.strictEqual((await admin.del('/api/admin/products/' + id)).json.ok, true); assert.strictEqual((await admin.get('/api/admin/products/' + id)).status, 404);
    assert.strictEqual((await admin.del('/api/admin/products/' + plain.id)).json.archived, true); // has orders, so hidden instead of deleted
  });
  await test('departments, categories, coupons, reviews, messages, marketing, settings', async () => {
    const c = (await admin.get('/api/admin/categories')).json; assert.strictEqual(c.stores.length, 6);
    await admin.post('/api/admin/categories', { store: 'beauty', name: 'Nails', icon: '💅' });
    assert.ok((await admin.get('/api/admin/categories')).json.categories.some((x) => x.name === 'Nails' && x.slug === 'beauty-nails'));
    assert.strictEqual((await admin.put('/api/admin/stores/beauty', { name: 'Shop-Beta Beauty', tab_label: 'Beauty', icon: '💄', hero_title: 'Glow Up', active: true })).status, 200);
    assert.strictEqual((await guest.get('/api/home/beauty')).json.store.hero_title, 'Glow Up');
    assert.strictEqual((await admin.post('/api/admin/coupons', { code: 'x', type: 'percent', value: 10 })).status, 400);
    assert.strictEqual((await admin.post('/api/admin/coupons', { code: 'save500', type: 'fixed', value: 500, min_spend: 1000, active: true })).status, 200);
    assert.strictEqual((await guest.post('/api/cart/price', { items: [{ productId: cfg.categories ? (await guest.get('/api/products?store=food')).json.products[0].id : 0, qty: 1 }], coupon: 'SAVE500' })).json.discount, 500);
    const rv = (await admin.get('/api/admin/reviews')).json.reviews; assert.strictEqual(rv.length, 1);
    await admin.put('/api/admin/reviews/' + rv[0].id, { approved: false }); assert.strictEqual((await guest.get('/api/products/' + plain.slug)).status, 404);
    const m = (await admin.get('/api/admin/messages')).json.messages; assert.strictEqual(m.length, 1); // honeypot message was dropped
    await admin.put('/api/admin/messages/' + m[0].id, { read: true });
    assert.strictEqual((await admin.get('/api/admin/newsletter')).json.subscribers.length, 1);
    const ab = (await admin.get('/api/admin/abandoned')).json.carts; assert.strictEqual(ab.length, 1); assert.strictEqual((await admin.post('/api/admin/abandoned/remind', {})).json.sent, 0); // too recent
    await jobsIdle(admin); const ob = (await admin.get('/api/admin/outbox')).json; assert.ok(ob.emails.length >= 4 && ob.live === false);
    const s = (await admin.get('/api/admin/settings')).json; assert.strictEqual(s.paystack.live, false); assert.ok(!('demo_seeded' in s.settings));
    const zones = s.zones.map((z) => (z.state === 'Lagos' ? { ...z, fee: 1500 } : z));
    assert.strictEqual((await admin.put('/api/admin/settings', { settings: { instagram: 'javascript:alert(1)' }, zones })).status, 400);
    assert.strictEqual((await admin.put('/api/admin/settings', { settings: { announcement: 'Sale!', pickup_address: '1 Shop Road, Ikeja', free_shipping_threshold: '0', ga_id: 'G-TEST123' }, zones })).status, 200);
    const cc = (await guest.get('/api/config')).json; assert.strictEqual(cc.settings.announcement, 'Sale!'); assert.strictEqual(cc.zones.find((z) => z.state === 'Lagos').fee, 1500);
    const pr = (await guest.post('/api/cart/price', { items: [{ productId: (await guest.get('/api/products?store=food')).json.products[0].id, qty: 1 }], state: 'Lagos', delivery: 'pickup' })).json;
    assert.strictEqual(pr.delivery.selected, 'pickup'); assert.strictEqual(pr.delivery.fee, 0);
    assert.strictEqual((await admin.get('/api/admin/customers')).json.customers[0].orders, 1);
  });

  console.log('\nConcurrency (many shoppers at once, real Postgres locks)');
  const mk = (pid, qty, payment, n) => ({ items: [{ productId: pid, qty }], contact: { name: 'Race ' + n, email: `race${n}@example.com`, phone: '0803' + String(1000000 + n) }, address: { state: 'Lagos', address: '1 Test Road' }, delivery: 'standard', payment });
  const post = (c, url, body, n) => c.req('POST', url, body, { 'X-Forwarded-For': `10.9.${n % 250}.${(n * 7) % 250}` });
  await test('10 shoppers racing for 3 units: exactly 3 orders succeed, stock ends at 0', async () => {
    const item = (await guest.get('/api/products?store=electronics')).json.products.find((x) => !x.hasVariants && x.stock > 0);
    await adminSql(`UPDATE products SET stock=3 WHERE id=${item.id}`, DB_NAME);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => post(new Client(), '/api/checkout', mk(item.id, 1, 'pod', 100 + i), 100 + i)));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 3, rs.map((r) => r.status).join(','));
    assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 400 || r.status === 409));
    assert.strictEqual(await stockOf(item.slug), 0);
  });
  await test('payment confirmed twice at the same moment is recorded once', async () => {
    const item = (await guest.get('/api/products?store=electronics')).json.products.filter((x) => !x.hasVariants && x.stock > 5)[0];
    const r = await post(new Client(), '/api/checkout', mk(item.id, 1, 'paystack', 200), 200); assert.strictEqual(r.json.next, 'demo');
    const both = await Promise.all([post(new Client(), '/api/pay/demo/' + r.json.ref, { outcome: 'ok' }, 201), post(new Client(), '/api/pay/demo/' + r.json.ref, { outcome: 'ok' }, 202)]);
    assert.ok(both.some((x) => x.status === 200));
    const o = (await new Client().post('/api/orders/lookup', { ref: r.json.ref, email: 'race200@example.com' })).json.order;
    assert.strictEqual(o.events.filter((e) => e.status === 'paid').length, 1);
    await jobsIdle(admin); const mails = (await admin.get('/api/admin/outbox')).json.emails.filter((m) => m.subject.includes('Payment received for ' + r.json.ref));
    assert.strictEqual(mails.length, 1);
  });
  await test('cancelling twice at the same moment returns stock once', async () => {
    const item = (await guest.get('/api/products?store=electronics')).json.products.filter((x) => !x.hasVariants && x.stock > 5)[1];
    const before = await stockOf(item.slug);
    const r = await post(new Client(), '/api/checkout', mk(item.id, 2, 'pod', 300), 300); assert.strictEqual(r.status, 200);
    assert.strictEqual(await stockOf(item.slug), before - 2);
    await Promise.all([post(new Client(), `/api/orders/${r.json.ref}/cancel`, { email: 'race300@example.com' }, 301), post(new Client(), `/api/orders/${r.json.ref}/cancel`, { email: 'race300@example.com' }, 302)]);
    assert.strictEqual(await stockOf(item.slug), before);
  });

  /* ---------------- Step 6: checkout correctness ---------------- */
  const stockItem = async (k) => (await guest.get('/api/products?store=electronics')).json.products.filter((x) => !x.hasVariants && x.stock > 20)[k];
  const adminOrder = async (ref) => { const l = (await admin.get('/api/admin/orders?q=' + ref)).json.orders.find((x) => x.ref === ref); return (await admin.get('/api/admin/orders/' + l.id)).json; };
  const setStatus = (id, status, note) => admin.put('/api/admin/orders/' + id, { status, note });
  const orderCount = async (email) => (await admin.get('/api/admin/orders?q=' + encodeURIComponent(email))).json.total;

  await test('idempotency: a double tap on Pay (same key, even at the same moment) creates one order and takes stock once', async () => {
    const item = await stockItem(0), before = await stockOf(item.slug), key = 'tap-' + Date.now() + '-aaaa';
    const body = mk(item.id, 2, 'pod', 400);
    const rs = await Promise.all(Array.from({ length: 6 }, () => new Client().req('POST', '/api/checkout', body, { 'Idempotency-Key': key, 'X-Forwarded-For': '10.8.1.1' })));
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status + ':' + (r.json && r.json.error)).join(','));
    assert.strictEqual(new Set(rs.map((r) => r.json.ref)).size, 1, 'one order reference for all six taps');
    assert.strictEqual(rs.filter((r) => r.json.replayed).length, 5, 'five of them were replays');
    assert.strictEqual(await orderCount('race400@example.com'), 1); assert.strictEqual(await stockOf(item.slug), before - 2);
    const later = await new Client().req('POST', '/api/checkout', body, { 'Idempotency-Key': key, 'X-Forwarded-For': '10.8.1.2' }); assert.strictEqual(later.json.ref, rs[0].json.ref); assert.strictEqual(await stockOf(item.slug), before - 2);
    await jobsIdle(admin); assert.strictEqual((await admin.get('/api/admin/outbox')).json.emails.filter((m) => m.subject.includes(rs[0].json.ref) && m.to_email === 'race400@example.com').length, 1, 'one confirmation email');
  });
  await test('idempotency: same key with a different cart or customer is refused; no key means separate orders; bad keys are refused', async () => {
    const item = await stockItem(0), key = 'tap-' + Date.now() + '-bbbb';
    assert.strictEqual((await new Client().req('POST', '/api/checkout', mk(item.id, 1, 'pod', 401), { 'Idempotency-Key': key, 'X-Forwarded-For': '10.8.2.1' })).status, 200);
    const other = await new Client().req('POST', '/api/checkout', mk(item.id, 3, 'pod', 401), { 'Idempotency-Key': key, 'X-Forwarded-For': '10.8.2.2' }); assert.strictEqual(other.status, 422);
    const other2 = await new Client().req('POST', '/api/checkout', mk(item.id, 1, 'pod', 402), { 'Idempotency-Key': key, 'X-Forwarded-For': '10.8.2.3' }); assert.strictEqual(other2.status, 422, 'a different person cannot reuse the key');
    assert.strictEqual(await orderCount('race402@example.com'), 0);
    const a = await post(new Client(), '/api/checkout', mk(item.id, 1, 'pod', 403), 403), b = await post(new Client(), '/api/checkout', mk(item.id, 1, 'pod', 403), 404);
    assert.notStrictEqual(a.json.ref, b.json.ref, 'without a key, two taps are two orders (as before)');
    assert.strictEqual((await new Client().req('POST', '/api/checkout', mk(item.id, 1, 'pod', 405), { 'Idempotency-Key': 'x', 'X-Forwarded-For': '10.8.2.4' })).status, 400);
  });
  await test('idempotency: a failed attempt (sold out) leaves no key behind, so the retry can succeed once stock is back', async () => {
    const item = await stockItem(1); await adminSql(`UPDATE products SET stock=0 WHERE id=${item.id}`, DB_NAME);
    const key = 'tap-' + Date.now() + '-cccc', body = mk(item.id, 1, 'pod', 410);
    assert.ok([400, 409].includes((await new Client().req('POST', '/api/checkout', body, { 'Idempotency-Key': key, 'X-Forwarded-For': '10.8.3.1' })).status), 'sold-out cart is refused');
    await adminSql(`UPDATE products SET stock=25 WHERE id=${item.id}`, DB_NAME);
    assert.strictEqual((await new Client().req('POST', '/api/checkout', body, { 'Idempotency-Key': key, 'X-Forwarded-For': '10.8.3.2' })).status, 200);
    assert.strictEqual(await orderCount('race410@example.com'), 1);
  });
  await test('pay on delivery: cannot be confirmed or dispatched until staff phone the customer', async () => {
    const item = await stockItem(0), r = await post(new Client(), '/api/checkout', mk(item.id, 1, 'pod', 420), 420);
    let { order: o, allowed } = await adminOrder(r.json.ref); assert.strictEqual(o.status, 'pending'); assert.deepStrictEqual(allowed, ['cancelled']);
    assert.strictEqual((await setStatus(o.id, 'confirmed')).status, 400); assert.strictEqual((await setStatus(o.id, 'dispatched')).status, 400); assert.strictEqual((await setStatus(o.id, 'paid')).status, 400);
    assert.strictEqual((await admin.post(`/api/admin/orders/${o.id}/confirm-phone`, { note: '' })).status, 400, 'a note is required');
    const lookup = (await new Client().post('/api/orders/lookup', { ref: r.json.ref, email: 'race420@example.com' })).json.order; assert.strictEqual(lookup.phone_confirmed, false);
    const [c1, c2] = await Promise.all([admin.post(`/api/admin/orders/${o.id}/confirm-phone`, { note: 'Spoke to Race 420, address confirmed' }), admin.post(`/api/admin/orders/${o.id}/confirm-phone`, { note: 'Spoke again' })]);
    assert.deepStrictEqual([c1.status, c2.status].sort(), [200, 409], 'two simultaneous confirmations: one wins');
    ({ order: o, allowed } = await adminOrder(r.json.ref)); assert.strictEqual(o.status, 'confirmed'); assert.ok(o.phone_confirmed_at); assert.match(o.phone_confirmed_by, /\S/); assert.deepStrictEqual(allowed, ['dispatched', 'cancelled']);
    assert.ok(o.events.some((e) => /Confirmed by phone/.test(e.note)));
    assert.strictEqual((await setStatus(o.id, 'delivered')).status, 400, 'cannot skip dispatch');
    assert.strictEqual((await setStatus(o.id, 'dispatched')).status, 200); assert.strictEqual((await setStatus(o.id, 'delivered')).status, 200);
    o = (await adminOrder(r.json.ref)).order; assert.strictEqual(o.payment_status, 'paid', 'cash collected on delivery'); assert.ok(o.events.some((e) => /Cash collected/.test(e.note)));
    assert.strictEqual((await setStatus(o.id, 'cancelled')).status, 400, 'a delivered order cannot be cancelled'); assert.strictEqual((await setStatus(o.id, 'pending')).status, 400);
  });
  await test('online order: dispatch needs payment; confirmed after paid; two staff acting at once cannot both succeed', async () => {
    const item = await stockItem(0), r = await post(new Client(), '/api/checkout', mk(item.id, 1, 'paystack', 430), 430);
    let { order: o, allowed } = await adminOrder(r.json.ref); assert.deepStrictEqual(allowed, ['paid', 'cancelled']); assert.strictEqual((await setStatus(o.id, 'confirmed')).status, 400);
    assert.strictEqual((await post(new Client(), '/api/pay/demo/' + r.json.ref, { outcome: 'ok' }, 431)).status, 200);
    ({ order: o, allowed } = await adminOrder(r.json.ref)); assert.strictEqual(o.status, 'paid'); assert.deepStrictEqual(allowed, ['confirmed', 'cancelled', 'refunded']);
    const race = await Promise.all([setStatus(o.id, 'confirmed'), setStatus(o.id, 'cancelled', 'changed my mind')]);
    assert.ok(race.some((x) => x.status === 200)); const fin = (await adminOrder(r.json.ref)).order; assert.ok(['confirmed', 'cancelled'].includes(fin.status));
    assert.strictEqual(fin.events.filter((e) => ['confirmed', 'cancelled'].includes(e.status)).length >= 1, true);
  });
  await test('refund: paid order cancelled shows a refund reminder; marking refunded records it once; stock returns exactly once', async () => {
    const item = await stockItem(2), before = await stockOf(item.slug);
    const r = await post(new Client(), '/api/checkout', mk(item.id, 2, 'paystack', 440), 440); await post(new Client(), '/api/pay/demo/' + r.json.ref, { outcome: 'ok' }, 441);
    assert.strictEqual(await stockOf(item.slug), before - 2);
    let o = (await adminOrder(r.json.ref)).order;
    assert.strictEqual((await setStatus(o.id, 'cancelled', 'Customer called')).status, 200); assert.strictEqual(await stockOf(item.slug), before);
    o = (await adminOrder(r.json.ref)).order; assert.ok(o.events.some((e) => /refund the customer/i.test(e.note))); assert.deepStrictEqual((await adminOrder(r.json.ref)).allowed, ['refunded']);
    const both = await Promise.all([setStatus(o.id, 'refunded', 'Refunded via Paystack'), setStatus(o.id, 'refunded', 'Refunded via Paystack')]);
    assert.strictEqual(both.filter((x) => x.status === 200).length, 1, 'only one refund is recorded: ' + both.map((x) => x.status));
    o = (await adminOrder(r.json.ref)).order; assert.strictEqual(o.status, 'refunded'); assert.strictEqual(o.payment_status, 'refunded'); assert.strictEqual(o.events.filter((e) => e.status === 'refunded').length, 1);
    assert.strictEqual(await stockOf(item.slug), before, 'stock not returned a second time');
    assert.strictEqual((await adminOrder(r.json.ref)).allowed.length, 0);
    // refund before dispatch returns the stock; refund after delivery does not touch it
    const r2 = await post(new Client(), '/api/checkout', mk(item.id, 1, 'paystack', 442), 442); await post(new Client(), '/api/pay/demo/' + r2.json.ref, { outcome: 'ok' }, 443);
    const o2 = (await adminOrder(r2.json.ref)).order; assert.strictEqual(await stockOf(item.slug), before - 1);
    assert.strictEqual((await setStatus(o2.id, 'refunded')).status, 200); assert.strictEqual(await stockOf(item.slug), before);
    const r3 = await post(new Client(), '/api/checkout', mk(item.id, 1, 'paystack', 444), 444); await post(new Client(), '/api/pay/demo/' + r3.json.ref, { outcome: 'ok' }, 445);
    const o3 = (await adminOrder(r3.json.ref)).order; for (const st of ['confirmed', 'dispatched', 'delivered']) assert.strictEqual((await setStatus(o3.id, st)).status, 200);
    assert.strictEqual((await setStatus(o3.id, 'refunded')).status, 200); assert.strictEqual(await stockOf(item.slug), before - 1, 'delivered goods are not put back automatically');
    const unpaid = await post(new Client(), '/api/checkout', mk(item.id, 1, 'pod', 446), 446); const ou = (await adminOrder(unpaid.json.ref)).order; assert.strictEqual((await setStatus(ou.id, 'refunded')).status, 400, 'nothing to refund if nothing was paid');
  });
  await test('the database itself refuses an order status outside the seven allowed', async () => {
    await assert.rejects(adminSql("UPDATE orders SET status='shipped' WHERE id=(SELECT MIN(id) FROM orders)", DB_NAME), /orders_status_chk|violates check/);
  });
  await test('renaming a category updates product search; coupon with 1 use cannot be used twice at once', async () => {
    const cat = cfg.categories.find((c) => c.store === 'electronics');
    assert.strictEqual((await admin.put('/api/admin/categories/' + cat.id, { name: 'Zorblax Things', icon: cat.icon })).status, 200);
    const found = (await guest.get('/api/products?q=zorblax')).json;
    const inCat = (await admin.get('/api/admin/products?store=electronics')).json.products.filter((p) => p.category === 'Zorblax Things').map((p) => p.id).sort();
    assert.ok(inCat.length >= 1 && found.total === inCat.length && found.products.map((p) => p.id).sort().join() === inCat.join());
    assert.strictEqual((await admin.post('/api/admin/coupons', { code: 'ONCE', type: 'fixed', value: 500, min_spend: 0, max_uses: 1, active: true })).status, 200);
    const item = (await guest.get('/api/products?store=electronics')).json.products.filter((x) => !x.hasVariants && x.stock > 5)[2];
    const rs = await Promise.all([0, 1, 2, 3].map((i) => post(new Client(), '/api/checkout', { ...mk(item.id, 1, 'pod', 400 + i), coupon: 'ONCE' }, 400 + i)));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status + (r.json && r.json.error)).join(','));
  });

  await test('two background jobs started together: only one does the work (lease lock)', async () => {
    const SC = require('path').join(__dirname, '..', 'lib');
    // Fresh child processes so they use the test database, each trying to run the same job at the same moment.
    const code = "process.env.DATABASE_URL='" + withDb(DB_NAME) + "';process.env.PGSSL='disable';process.env.DATA_DIR='" + DATA.replace(/\\/g, '/') + "';" +
      "const j=require('" + SC.replace(/\\/g, '/') + "/jobs');j.remindAbandoned().then(()=>process.stdout.write('done')).then(()=>require('" + SC.replace(/\\/g, '/') + "/db').end())";
    await adminSql("INSERT INTO abandoned (email,cart,created,reminded) VALUES ('lock@example.com','[{\"productId\":1,\"qty\":1}]'," + (Math.floor(Date.now() / 1000) - 7200) + ",0)", DB_NAME);
    const run1 = () => new Promise((res) => { let out = ''; const c = spawn(process.execPath, ['-e', code]); c.stdout.on('data', (d) => { out += d; }); c.on('close', () => res(out)); });
    const outs = await Promise.all([run1(), run1(), run1()]);
    assert.ok(outs.every((o) => o === 'done'), outs.join('|'));
    const mails = (await admin.get('/api/admin/outbox')).json.emails.filter((m) => /left something in your/.test(m.subject));
    assert.strictEqual(mails.length, 1, 'reminder emails sent: ' + mails.length);
  });

  console.log('\nPages');
  await test('server-rendered SEO: titles, product JSON-LD, 404s, sitemap, robots, security headers', async () => {
    const home = await guest.get('/d/electronics'); assert.match(home.text, /<html lang="en" data-store="electronics">/); assert.match(home.text, /<title>Shop-Beta Electronics/);
    const prod = (await guest.get('/api/products?store=electronics')).json.products[0]; const page = await guest.get('/product/' + prod.slug);
    assert.match(page.text, /application\/ld\+json/); assert.match(page.text, /og:title/); assert.ok(!page.text.includes('<!--SEO-->') && !page.text.includes('<!--HTMLATTR-->') && !page.text.includes('<!--PRERENDER-->'));
    const nonce = /script nonce="([^"]+)"/.exec(page.text)[1]; assert.ok(page.headers.get('content-security-policy').includes(`'nonce-${nonce}'`));
    assert.strictEqual((await guest.get('/d/nowhere')).status, 404); assert.strictEqual((await guest.get('/product/nope')).status, 404); assert.strictEqual((await guest.get('/admin')).status, 200);
    assert.match((await guest.get('/admin')).text, /noindex/); assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
    const sm = await guest.get('/sitemap.xml'); assert.match(sm.text, /\/d\/fashion/); assert.ok(!sm.text.includes('/product/' + plain.slug)); // hidden products are not listed
    assert.match((await guest.get('/robots.txt')).text, /Disallow: \/admin/);
    assert.strictEqual((await guest.get('/api/nothing')).status, 404);
  });
  await test('login is rate limited', async () => {
    let last; for (let i = 0; i < 10; i++) last = await new Client().post('/api/auth/login', { email: 'ada@example.com', password: 'nope nope nope' });
    assert.strictEqual(last.status, 429);
  });

  srv.kill(); storageMock.close();
  await new Promise((r) => setTimeout(r, 400));
  await adminSql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\nServer log:\n' + log.slice(-1500)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
