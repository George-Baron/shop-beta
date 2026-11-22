'use strict';
// Mobile shopping API: catalogue, cart, checkout (idempotent), orders, server-verified payment, addresses, wishlist, and what a customer can NOT reach.
// Run with: npm run test:mobile-shop
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client: PgClient } = require('pg');
const mock = require('./mock-apis');

const PORT = 3400 + Math.floor(Math.random() * 400), BASE = `http://127.0.0.1:${PORT}`, ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const TEST_DB = 'sb_test_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
const TEST_URL = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + TEST_DB + '$1');
async function pgAdmin(sql) { const c = new PgClient({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } }
async function pgQ(sql, ...p) { const c = new PgClient({ connectionString: TEST_URL }); await c.connect(); try { return (await c.query(sql, p)).rows; } finally { await c.end(); } }
let passed = 0; const failures = [];
const idem = () => crypto.randomBytes(16).toString('hex');

class App {
  constructor() { this.device = { id: 'dev-' + crypto.randomBytes(6).toString('hex'), name: 'Test phone', platform: 'ios', appVersion: '1.0.0' }; this.access = ''; }
  async req(method, url, body, headers = {}) {
    const r = await fetch(BASE + '/api/mobile/v1' + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.access ? { Authorization: 'Bearer ' + this.access } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  }
  get(u) { return this.req('GET', u); } post(u, b = {}, h) { return this.req('POST', u, b, h); } put(u, b) { return this.req('PUT', u, b); } del(u) { return this.req('DELETE', u); }
  async register(name, email) { const r = await this.req('POST', '/auth/register', { name, email, phone: '08030000009', password: 'Shopper-pass-2026!', device: this.device }); this.access = r.json.accessToken; return r; }
}
const web = async (method, url, body) => { const r = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

(async () => {
  const fake = await mock.start();
  await pgAdmin(`CREATE DATABASE ${TEST_DB}`);
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DATABASE_URL: TEST_URL, DATABASE_SSL: 'off', BASE_URL: BASE, PAYSTACK_SECRET_KEY: 'sk_test_mobile', PAYSTACK_API_URL: fake.url, RESEND_API_KEY: '', ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Owner-pass-2026-xyz', RATE_LIMIT_MULTIPLIER: '100', WORKER_POLL_MS: '200' };
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 150; i++) { try { await fetch(BASE + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const ada = new App(), bola = new App(), guest = new App();
  await ada.register('Ada Obi', 'ada.shop@example.com'); await bola.register('Bola Eze', 'bola.shop@example.com');
  const plain = (await pgQ('SELECT id, slug, name, price, stock FROM products WHERE active=1 AND vendor_id IS NULL AND stock>=20 AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 3'));
  const stockOf = async (id) => Number((await pgQ('SELECT stock FROM products WHERE id=$1', id))[0].stock);
  const contact = { name: 'Ada Obi', email: 'ada.shop@example.com', phone: '08031234567' }, address = { state: 'Lagos', city: 'Yaba', address: '5 Herbert Macaulay Way' };
  const order = (p, extra = {}) => ({ items: [{ productId: p.id, qty: 1 }], contact, address, delivery: 'standard', payment: 'pod', ...extra });

  console.log('\nCatalogue (no sign-in needed)');
  await test('config, department home, search with filters, product detail, by-ids and partner stores answer', async () => {
    const cfg = (await guest.get('/config')).json; assert.ok(cfg.stores.length >= 5); assert.ok(cfg.zones.length > 30); assert.ok(!('user' in cfg)); assert.ok(cfg.payments);
    const home = (await guest.get('/home/' + cfg.stores[0].slug)).json; assert.ok(home.featured.length > 0);
    const list = (await guest.get('/products?sort=price_asc&instock=1')).json; assert.ok(list.products.length > 0); assert.ok(list.pages >= 1); assert.ok(list.products.length <= 20);
    const d = (await guest.get('/products/' + plain[0].slug)).json; assert.strictEqual(d.product.id, Number(plain[0].id)); assert.ok(Array.isArray(d.related));
    assert.strictEqual((await guest.get('/products/nope-nope')).status, 404);
    assert.strictEqual((await guest.post('/products/by-ids', { ids: [plain[0].id, 99999999] })).json.products.length, 1);
    assert.strictEqual((await guest.get('/vendors')).status, 200);
  });
  await test('wholesale prices never appear in the public catalogue', async () => {
    const all = JSON.stringify((await guest.get('/products?q=a')).json) + JSON.stringify((await guest.get('/products/' + plain[0].slug)).json);
    assert.ok(!/wholesale_price|wholesale_min_qty/.test(all));
  });
  await test('cart pricing is decided by the server, not the phone', async () => {
    const r = (await guest.post('/cart/price', { items: [{ productId: plain[0].id, qty: 2, price: 1 }], state: 'Lagos' })).json;
    assert.strictEqual(r.lines[0].price, plain[0].price); assert.strictEqual(r.subtotal, plain[0].price * 2); assert.ok(r.delivery.options.standard);
    assert.ok(r.payments.includes('paystack'));
  });

  console.log('\nCheckout');
  await test('checkout needs a signed-in customer and an Idempotency-Key', async () => {
    assert.strictEqual((await guest.post('/checkout', order(plain[0]), { 'Idempotency-Key': idem() })).status, 401);
    const r = await ada.post('/checkout', order(plain[0])); assert.strictEqual(r.status, 400); assert.strictEqual(r.json.code, 'idempotency_key_required');
    assert.strictEqual((await ada.post('/checkout', order(plain[0]), { 'Idempotency-Key': 'short' })).json.code, 'idempotency_key_required');
  });
  let podRef;
  await test('pay on delivery: one order, stock goes down once, even when the same checkout is sent three times', async () => {
    const key = idem(), before = await stockOf(plain[0].id);
    const sent = await Promise.all([ada.post('/checkout', order(plain[0], { items: [{ productId: plain[0].id, qty: 2 }] }), { 'Idempotency-Key': key }), ada.post('/checkout', order(plain[0], { items: [{ productId: plain[0].id, qty: 2 }] }), { 'Idempotency-Key': key }), ada.post('/checkout', order(plain[0], { items: [{ productId: plain[0].id, qty: 2 }] }), { 'Idempotency-Key': key })]);
    for (const r of sent) { assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.next, 'pod'); }
    assert.strictEqual(new Set(sent.map((r) => r.json.ref)).size, 1); podRef = sent[0].json.ref;
    assert.strictEqual(before - await stockOf(plain[0].id), 2);
    assert.strictEqual((await pgQ("SELECT COUNT(*)::int n FROM orders WHERE user_id=(SELECT id FROM users WHERE email='ada.shop@example.com')"))[0].n, 1);
  });
  await test('the same key with a different cart is refused, not silently changed', async () => {
    const key = idem(); assert.strictEqual((await ada.post('/checkout', order(plain[1], { payment: 'paystack' }), { 'Idempotency-Key': key })).status, 200);
    const r = await ada.post('/checkout', order(plain[2], { payment: 'paystack' }), { 'Idempotency-Key': key }); assert.strictEqual(r.status, 409);
  });
  await test('asking for more than is in stock never makes stock negative (the existing website rule: the quantity is reduced to what is left, and /cart/price tells the app first)', async () => {
    await pgQ('UPDATE products SET stock=3 WHERE id=$1', plain[2].id);
    const priced = (await ada.post('/cart/price', { items: [{ productId: plain[2].id, qty: 5 }], state: 'Lagos' })).json;
    assert.strictEqual(priced.lines[0].qty, 3); assert.ok(priced.issues.some((i) => /Only 3/.test(i.message)));
    const r = await ada.post('/checkout', order(plain[2], { payment: 'paystack', items: [{ productId: plain[2].id, qty: 5 }] }), { 'Idempotency-Key': idem() });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(await stockOf(plain[2].id), 0);
    assert.strictEqual(Number((await pgQ('SELECT qty FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.ref=$1', r.json.ref))[0].qty), 3);
    const gone = await ada.post('/checkout', order(plain[2], { payment: 'paystack' }), { 'Idempotency-Key': idem() });   // now fully sold out
    await pgQ('UPDATE products SET stock=50 WHERE id=$1', plain[2].id); assert.ok([400, 409].includes(gone.status), 'sold out answered ' + gone.status);
  });
  await test('invalid delivery details are refused and take no stock', async () => {
    const before = await stockOf(plain[1].id);
    assert.strictEqual((await ada.post('/checkout', order(plain[1], { payment: 'paystack', address: { state: 'Lagos', address: '' } }), { 'Idempotency-Key': idem() })).status, 400);
    assert.strictEqual((await ada.post('/checkout', order(plain[1], { payment: 'cash-in-hand' }), { 'Idempotency-Key': idem() })).status, 400);
    assert.strictEqual(await stockOf(plain[1].id), before);
  });

  console.log('\nOrders belong to their owner');
  await test('list and detail show only my orders; someone else gets 404; detail has the handover/tracking view and actions', async () => {
    const mine = (await ada.get('/orders')).json; assert.ok(mine.orders.some((o) => o.ref === podRef)); assert.ok(mine.orders.every((o) => o.item_count >= 1));
    assert.strictEqual((await bola.get('/orders')).json.orders.length, 0);
    assert.strictEqual((await bola.get('/orders/' + podRef)).status, 404);
    const d = (await ada.get('/orders/' + podRef)).json; assert.strictEqual(d.order.ref, podRef); assert.ok(d.order.events.length >= 1); assert.strictEqual(d.actions.can_cancel, true);
    assert.strictEqual((await guest.get('/orders/' + podRef)).status, 401);
  });
  await test('the orders list pages with a cursor', async () => {
    const first = (await ada.get('/orders?limit=1')).json; assert.strictEqual(first.orders.length, 1); assert.ok(first.next_before);
    const second = (await ada.get('/orders?limit=1&before=' + first.next_before)).json; assert.notStrictEqual(second.orders[0].ref, first.orders[0].ref);
  });
  await test('cancelling returns the stock; someone else cannot cancel; a cancelled order cannot be cancelled twice', async () => {
    const before = await stockOf(plain[0].id);
    assert.strictEqual((await bola.post('/orders/' + podRef + '/cancel')).status, 404);
    assert.strictEqual((await ada.post('/orders/' + podRef + '/cancel')).status, 200);
    assert.strictEqual(await stockOf(plain[0].id) - before, 2);
    assert.strictEqual((await ada.post('/orders/' + podRef + '/cancel')).status, 400);
  });

  console.log('\nPayment is confirmed by the server, never by the phone');
  let payRef, payAmount;
  await test('an online order returns the Paystack page; the app saying "paid" changes nothing', async () => {
    const r = await ada.post('/checkout', order(plain[1], { payment: 'paystack' }), { 'Idempotency-Key': idem() });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.next, 'paystack'); assert.ok(r.json.url); payRef = r.json.ref;
    payAmount = Number((await pgQ('SELECT charge_amount FROM orders WHERE ref=$1', payRef))[0].charge_amount);
    const s = (await ada.get(`/orders/${payRef}/payment-status?paid=true`)).json; assert.strictEqual(s.payment_status, 'unpaid');   // Paystack mock has no record of it yet
    assert.strictEqual((await ada.post(`/orders/${payRef}/pay`)).json.url, r.json.url);                                              // resume: same page, no new order
  });
  await test('a wrong amount from the gateway is not accepted', async () => {
    fake.state.paystack.verify[payRef] = { status: 'success', amount: 100 };
    const s = (await ada.get(`/orders/${payRef}/payment-status`)).json; assert.strictEqual(s.payment_status, 'unpaid');
    assert.match((await pgQ("SELECT string_agg(note, ' | ') n FROM order_events e JOIN orders o ON o.id=e.order_id WHERE o.ref=$1", payRef))[0].n, /Payment check failed/);
  });
  await test('when the gateway confirms the right amount the order is paid once, and checking again changes nothing', async () => {
    fake.state.paystack.verify[payRef] = { status: 'success', amount: payAmount };
    const s = (await ada.get(`/orders/${payRef}/payment-status`)).json; assert.strictEqual(s.payment_status, 'paid'); assert.strictEqual(s.status, 'paid');
    await ada.get(`/orders/${payRef}/payment-status`); await ada.get(`/orders/${payRef}/payment-status`);
    assert.strictEqual((await pgQ("SELECT COUNT(*)::int n FROM order_events e JOIN orders o ON o.id=e.order_id WHERE o.ref=$1 AND e.status='paid'", payRef))[0].n, 1);
    assert.strictEqual((await ada.post(`/orders/${payRef}/pay`)).status, 409);
    assert.strictEqual((await ada.post(`/orders/${payRef}/cancel`)).status, 400);       // paid orders cannot be cancelled by the customer
    assert.strictEqual((await bola.get(`/orders/${payRef}/payment-status`)).status, 404);
  });
  await test('the gateway being unreachable does not break the screen', async () => {
    const r = await ada.post('/checkout', order(plain[2], { payment: 'paystack' }), { 'Idempotency-Key': idem() });
    fake.state.paystack.verifyDown = true; const s = await ada.get(`/orders/${r.json.ref}/payment-status`); fake.state.paystack.verifyDown = false;
    assert.strictEqual(s.status, 200); assert.strictEqual(s.json.payment_status, 'unpaid');
  });

  console.log('\nAddresses and wishlist');
  await test('addresses: add, edit, delete, only mine, validated, limited to 10', async () => {
    const a = (await ada.post('/addresses', { label: 'Home', name: 'Ada', phone: '0803', state: 'Lagos', city: 'Yaba', address: '5 Herbert Macaulay Way' })).json.address;
    assert.ok(a.id); assert.strictEqual((await ada.put('/addresses/' + a.id, { ...a, address: '7 New Road' })).json.address.address, '7 New Road');
    assert.strictEqual((await bola.put('/addresses/' + a.id, { ...a, address: 'hijack here' })).status, 404);
    assert.strictEqual((await bola.get('/addresses')).json.addresses.length, 0);
    assert.strictEqual((await ada.post('/addresses', { state: 'Nowhere', address: '12 Some Street' })).json.code, 'invalid_state');
    assert.strictEqual((await ada.post('/addresses', { state: 'Lagos', address: 'x' })).json.code, 'invalid_address');
    for (let i = 0; i < 9; i++) await ada.post('/addresses', { state: 'Lagos', address: 'Street number ' + i });
    assert.strictEqual((await ada.post('/addresses', { state: 'Lagos', address: 'One too many' })).json.code, 'too_many_addresses');
    await bola.del('/addresses/' + a.id); assert.strictEqual((await ada.get('/addresses')).json.addresses.length, 10);
    assert.strictEqual((await ada.del('/addresses/' + a.id)).status, 200); assert.strictEqual((await ada.get('/addresses')).json.addresses.length, 9);
  });
  await test('wishlist: add, list products, merge, remove; hidden products are ignored', async () => {
    await ada.post('/wishlist/' + plain[0].id); await ada.post('/wishlist/99999999'); await ada.post('/wishlist/merge', { ids: [plain[1].id, 99999999] });
    assert.deepStrictEqual((await ada.get('/wishlist')).json.ids.map(Number).sort(), [Number(plain[0].id), Number(plain[1].id)].sort());
    assert.strictEqual((await ada.get('/wishlist/products')).json.products.length, 2);
    await ada.del('/wishlist/' + plain[0].id); assert.strictEqual((await ada.get('/wishlist')).json.ids.length, 1); assert.strictEqual((await bola.get('/wishlist')).json.ids.length, 0);
  });

  console.log('\nNotifications');
  await test('my order notifications are listed and can be marked read; nobody else sees them', async () => {
    const n = (await ada.get('/notifications')).json; assert.ok(n.notifications.some((x) => /Order SB-/.test(x.title))); assert.ok(n.unread >= 1);
    assert.strictEqual((await ada.post('/notifications/read', { all: true })).json.unread, 0); assert.strictEqual((await bola.get('/notifications')).json.notifications.length, 0);
  });

  console.log('\nWhat a customer cannot reach');
  await test('a customer token cannot use back-office, rider, partner, supplier or warehouse routes (neither through the app API nor the website API)', async () => {
    for (const p of ['/admin/orders', '/admin/staff', '/rider/orders', '/partner/me', '/supplier/me', '/warehouse/stock', '/admin/rider-ops/riders']) {
      const r = await fetch(BASE + '/api' + p, { headers: { Authorization: 'Bearer ' + ada.access } }); assert.ok([401, 403, 404].includes(r.status), p + ' -> ' + r.status);
      const m = await ada.get(p); assert.strictEqual(m.status, 404, 'mobile ' + p);
    }
  });
  await test('the website checkout and order lookup still work the same way (guest, no token)', async () => {
    const g = await web('POST', '/api/checkout', order(plain[1]));
    assert.strictEqual(g.status, 200); assert.strictEqual(g.json.next, 'pod');
  });

  console.log('\nSupport');
  await test('support messages need sign-in, a topic and a message, and can name only the customer\'s own order', async () => {
    assert.strictEqual((await guest.post('/support', { topic: 'other', message: 'Hello there' })).status, 401);
    assert.strictEqual((await ada.post('/support', { topic: 'nonsense', message: 'Hello there' })).json.code, 'invalid_topic');
    assert.strictEqual((await ada.post('/support', { topic: 'other', message: 'hi' })).json.code, 'message_too_short');
    assert.strictEqual((await ada.post('/support', { topic: 'delivery', orderRef: podRef, message: 'Where is my parcel please?' })).status, 200);
    assert.strictEqual((await bola.post('/support', { topic: 'delivery', orderRef: podRef, message: 'This is not my order' })).status, 404, 'another customer cannot name it');
    assert.ok((await ada.get('/support/topics')).json.topics.length >= 5);
  });
  await test('the message reaches the store inbox (admin Messages) with the order and the customer\'s own email', async () => {
    const m = (await pgQ("SELECT name, email, subject, body FROM messages WHERE subject LIKE '[App]%' ORDER BY id DESC LIMIT 5"));
    assert.strictEqual(m.length, 1); assert.strictEqual(m[0].email, 'ada.shop@example.com'); assert.ok(m[0].subject.includes(podRef)); assert.ok(/parcel/.test(m[0].body));
  });

  srv.kill(); fake.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(DATA, { recursive: true, force: true });
  await pgAdmin(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\nServer log:\n' + log.slice(-1800)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
