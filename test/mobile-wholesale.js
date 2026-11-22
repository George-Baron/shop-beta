'use strict';
// Mobile wholesale: only approved buyers, wholesale prices and warehouse stock kept apart from retail, quote -> accept -> pay (verified by the server).
// Run with: npm run test:mobile-wholesale
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
const PW = 'Wholesale-Test-Pass-2026!';

class App {
  constructor() { this.device = { id: 'dev-' + crypto.randomBytes(6).toString('hex'), name: 'Test phone', platform: 'android', appVersion: '1.0.0' }; this.access = ''; }
  async req(method, url, body) {
    const r = await fetch(BASE + '/api/mobile/v1' + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.access ? { Authorization: 'Bearer ' + this.access } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  }
  get(u) { return this.req('GET', u); } post(u, b = {}) { return this.req('POST', u, b); } put(u, b) { return this.req('PUT', u, b); } del(u) { return this.req('DELETE', u); }
  async register(name, email) { const r = await this.req('POST', '/auth/register', { name, email, phone: '08030000009', password: PW, device: this.device }); this.access = r.json.accessToken; return r; }
}
let adminCookie = '';
const adminCall = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(adminCookie ? { Cookie: adminCookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const c = r.headers.getSetCookie ? r.headers.getSetCookie() : []; if (c[0]) adminCookie = c[0].split(';')[0];
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { status: r.status, json: j, text: t };
};
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); }
}
const appBody = (o = {}) => ({ business_name: 'Ada Provisions Ltd', contact_name: 'Ada Obi', phone: '08031234567', address: '5 Trade Fair Road', state: 'Lagos', city: 'Ojo', reg_no: 'RC445566', business_type: 'Retailer', buys: 'Rice, beans and cooking oil for my shops', est_monthly: '₦2m', ...o });

(async () => {
  const fake = await mock.start();
  await pgAdmin(`CREATE DATABASE ${TEST_DB}`);
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DATABASE_URL: TEST_URL, DATABASE_SSL: 'off', BASE_URL: BASE, PAYSTACK_SECRET_KEY: 'sk_test_mobile', PAYSTACK_API_URL: fake.url, RESEND_API_KEY: '', ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Owner-pass-2026-xyz', RATE_LIMIT_MULTIPLIER: '100', WORKER_POLL_MS: '200' };
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 150; i++) { try { await fetch(BASE + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  assert.strictEqual((await adminCall('POST', '/api/auth/login', { email: 'owner@example.com', password: 'Owner-pass-2026-xyz' })).status, 200);
  const WA = (m, u, b) => adminCall(m, '/api/admin/wholesale' + u, b);

  const [P1, P2] = await pgQ("SELECT id, name, price, stock FROM products WHERE vendor_id IS NULL AND is_pharmacy=0 AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id=products.id) AND stock >= 30 ORDER BY id LIMIT 2");
  const wh = (await pgQ("SELECT id FROM wholesale_warehouses WHERE code='MAIN'"))[0].id;
  const setAvail = (id, n) => pgQ('INSERT INTO wholesale_stock_balances (product_id,warehouse_id,on_hand,reserved,updated) VALUES ($1,$2,$3,0,1) ON CONFLICT (product_id,warehouse_id) DO UPDATE SET on_hand=$3, reserved=0', id, wh, n);
  const whAvail = async (id) => { const r = (await pgQ('SELECT on_hand - reserved AS a FROM wholesale_stock_balances WHERE product_id=$1', id))[0]; return r ? Number(r.a) : 0; };
  const retail = async (id) => Number((await pgQ('SELECT stock FROM products WHERE id=$1', id))[0].stock);
  const retail1 = await retail(P1.id), retail2 = await retail(P2.id);
  await setAvail(P1.id, 40); await setAvail(P2.id, 20);   // wholesale warehouse stock, different from the retail stock

  const ada = new App(), eve = new App(), bob = new App(), shopper = new App();
  await ada.register('Ada Obi', 'ada.ws@example.com'); await eve.register('Eve', 'eve.ws@example.com'); await bob.register('Bob', 'bob.ws@example.com'); await shopper.register('Sam Shopper', 'sam@example.com');
  let ref;

  console.log('\nApplying and approval');
  await test('wholesale needs sign-in; a customer who has not applied sees no account and no prices', async () => {
    assert.strictEqual((await new App().get('/wholesale/me')).status, 401);
    const me = (await shopper.get('/wholesale/me')).json; assert.strictEqual(me.account, null); assert.ok(me.terms.eval_days > 0);
    assert.strictEqual((await shopper.get('/wholesale/catalog')).status, 403); assert.strictEqual((await shopper.post('/wholesale/quotes', { items: [{ productId: P1.id, qty: 10 }] })).status, 403);
    assert.strictEqual((await shopper.post('/wholesale/rfq', { items: [{ name: 'x', qty: 3 }] })).status, 403);
  });
  await test('applying needs real business details, works once, and the buyer is put under evaluation with no prices', async () => {
    assert.strictEqual((await ada.post('/wholesale/apply', appBody({ reg_no: '' }))).status, 400);
    assert.strictEqual((await ada.post('/wholesale/apply', appBody())).status, 200);
    assert.strictEqual((await ada.post('/wholesale/apply', appBody())).status, 409);
    const me = (await ada.get('/wholesale/me')).json; assert.strictEqual(me.account.status, 'pending');
    assert.strictEqual((await ada.get('/wholesale/catalog')).status, 403);
    assert.strictEqual((await ada.post('/wholesale/quotes', { items: [{ productId: P1.id, qty: 10 }], ship_address: '5 Trade Fair Road', ship_state: 'Lagos' })).status, 403);
  });
  await test('after approval the buyer sees the wholesale price list, from the wholesale warehouse (not from retail stock)', async () => {
    const acc = (await WA('GET', '/accounts')).json.accounts[0];
    assert.strictEqual((await WA('POST', `/accounts/${acc.id}/approve`, { early: true })).status, 200);
    assert.strictEqual((await WA('PUT', `/products/${P1.id}`, { wholesale_price: Math.floor(P1.price * 0.7), wholesale_min_qty: 5 })).status, 200);
    assert.strictEqual((await WA('PUT', `/products/${P2.id}`, { wholesale_price: Math.floor(P2.price * 0.8), wholesale_min_qty: 3 })).status, 200);
    assert.strictEqual((await ada.get('/wholesale/me')).json.account.status, 'approved');
    const cat = (await ada.get('/wholesale/catalog')).json.products; const c1 = cat.find((p) => Number(p.id) === Number(P1.id));
    assert.ok(c1, 'priced product is listed'); assert.strictEqual(c1.price, Math.floor(P1.price * 0.7)); assert.strictEqual(c1.retail_price, P1.price);
    assert.strictEqual(c1.stock, 40, 'availability is the wholesale warehouse figure');
    await pgQ('UPDATE products SET stock=100000 WHERE id=$1', P1.id);                       // plenty of retail stock changes nothing
    assert.strictEqual((await ada.get('/wholesale/catalog')).json.products.find((p) => Number(p.id) === Number(P1.id)).stock, 40);
    await pgQ('UPDATE products SET stock=$2 WHERE id=$1', P1.id, retail1);
  });
  await test('prices and wholesale rules stay out of the public catalogue, and a retail customer or another buyer cannot see them', async () => {
    const pub = JSON.stringify((await shopper.get('/products?q=a')).json) + JSON.stringify((await shopper.get('/products/' + (await pgQ('SELECT slug FROM products WHERE id=$1', P1.id))[0].slug)).json);
    assert.ok(!/wholesale_price|wholesale_min_qty/.test(pub));
    assert.strictEqual((await eve.get('/wholesale/catalog')).status, 403);
  });

  console.log('\nQuotation, acceptance and stock');
  await test('a quotation request is checked against the WHOLESALE warehouse: minimum quantity, available stock, partner products refused', async () => {
    const R = (items) => ada.post('/wholesale/quotes', { items, ship_address: '5 Trade Fair Road', ship_state: 'Lagos' });
    assert.strictEqual((await R([{ productId: P1.id, qty: 2 }])).status, 400, 'below the minimum');
    assert.strictEqual((await R([{ productId: P1.id, qty: 41 }])).status, 400, 'more than the warehouse has, even though retail stock is higher');
    assert.strictEqual((await R([])).status, 400);
    const vend = (await pgQ("INSERT INTO vendors (slug,name,status,created) VALUES ('zz','ZZ','approved',1) RETURNING id"))[0].id;
    const vp = (await pgQ("INSERT INTO products (slug,store,name,price,stock,vendor_id,listing,wholesale_price,created) VALUES ('zz-p','supermarket','Partner thing',1000,50,$1,'approved',500,1) RETURNING id", vend))[0].id;
    assert.strictEqual((await R([{ productId: vp, qty: 5 }])).status, 400, 'partner stock is never sold wholesale');
    const ok = await R([{ productId: P1.id, qty: 10 }, { productId: P2.id, qty: 4 }]); assert.strictEqual(ok.status, 200, ok.text); ref = ok.json.ref; assert.match(ref, /^WQ-/);
    assert.strictEqual((await ada.get('/wholesale/quotes')).json.quotes.length, 1);
  });
  await test('our team sends the proforma; the buyer sees goods, logistics fee, service fee and total; no one else can open it', async () => {
    const d = (await WA('GET', '/quotes/' + ref)).json.quote;
    const sent = await WA('POST', `/quotes/${ref}/send`, { items: d.items.map((i) => ({ id: i.id, qty: i.qty, unit_price: i.unit_price })), logistics_fee: 15000, service_pct: 3, valid_days: 7, shipment_plan: 'Our truck from Lagos, within 3 days of payment' });
    assert.strictEqual(sent.status, 200, sent.text);
    const q = (await ada.get('/wholesale/quotes/' + ref)).json.quote; assert.strictEqual(q.status, 'quoted'); assert.strictEqual(q.logistics_fee, 15000); assert.strictEqual(q.total, q.goods_total + q.logistics_fee + q.service_fee);
    assert.strictEqual((await ada.get(`/wholesale/quotes/${ref}/invoice`)).status, 404, 'the final invoice is issued when payment is received');
    for (const [m, u] of [['get', '/wholesale/quotes/' + ref], ['get', `/wholesale/quotes/${ref}/invoice`], ['post', `/wholesale/quotes/${ref}/accept`], ['post', `/wholesale/quotes/${ref}/pay`], ['get', `/wholesale/quotes/${ref}/payment-status`]]) assert.strictEqual((await bob[m](u)).status === 404 || (await bob[m](u)).status === 403, true, 'bob ' + u);
    assert.strictEqual((await eve.get('/wholesale/quotes/' + ref)).status === 404 || (await eve.get('/wholesale/quotes/' + ref)).status === 403, true);
  });
  await test('accepting sets wholesale stock aside and leaves retail stock alone; you cannot pay before accepting', async () => {
    const r1 = await retail(P1.id);
    assert.strictEqual((await ada.post(`/wholesale/quotes/${ref}/pay`)).status, 409, 'accept first');
    assert.strictEqual((await ada.post(`/wholesale/quotes/${ref}/accept`)).status, 200);
    assert.strictEqual(await whAvail(P1.id), 30, 'warehouse stock is held'); assert.strictEqual(await retail(P1.id), r1, 'retail stock untouched'); assert.strictEqual(await retail(P2.id), retail2);
    assert.strictEqual((await ada.post(`/wholesale/quotes/${ref}/accept`)).status, 409, 'only once');
  });

  console.log('\nPayment is confirmed by the server');
  let total, payUrl;
  await test('paying opens the Paystack page; the phone cannot say "paid"; a wrong amount is refused', async () => {
    const p = await ada.post(`/wholesale/quotes/${ref}/pay`); assert.strictEqual(p.status, 200, p.text); assert.ok(p.json.url); payUrl = p.json.url;
    assert.strictEqual((await ada.post(`/wholesale/quotes/${ref}/pay`)).json.url, payUrl, 'a second tap reuses the same page');
    total = (await ada.get('/wholesale/quotes/' + ref)).json.quote.total;
    assert.strictEqual((await ada.get(`/wholesale/quotes/${ref}/payment-status?paid=true`)).json.paid, false);
    fake.state.paystack.verify[ref] = { status: 'success', amount: 100 };
    assert.strictEqual((await ada.get(`/wholesale/quotes/${ref}/payment-status`)).json.paid, false);
    assert.match((await pgQ("SELECT string_agg(note, ' | ') n FROM wholesale_events e JOIN wholesale_quotes q ON q.id=e.quote_id WHERE q.ref=$1", ref))[0].n, /Payment check failed/);
  });
  await test('the right amount from Paystack marks it paid exactly once; the gateway being down breaks nothing', async () => {
    fake.state.paystack.verifyDown = true; const down = await ada.get(`/wholesale/quotes/${ref}/payment-status`); fake.state.paystack.verifyDown = false;
    assert.strictEqual(down.status, 200); assert.strictEqual(down.json.paid, false);
    fake.state.paystack.verify[ref] = { status: 'success', amount: total * 100 };
    const s = (await ada.get(`/wholesale/quotes/${ref}/payment-status`)).json; assert.strictEqual(s.paid, true); assert.strictEqual(s.status, 'paid');
    await ada.get(`/wholesale/quotes/${ref}/payment-status`); await ada.get(`/wholesale/quotes/${ref}/payment-status`);
    assert.strictEqual((await pgQ("SELECT COUNT(*)::int n FROM wholesale_events e JOIN wholesale_quotes q ON q.id=e.quote_id WHERE q.ref=$1 AND e.status='paid'", ref))[0].n, 1);
    assert.strictEqual((await ada.post(`/wholesale/quotes/${ref}/decline`)).status >= 400, true, 'a paid quotation cannot be declined');
    assert.strictEqual((await ada.get(`/wholesale/quotes/${ref}/invoice`)).status, 200, 'the final invoice now exists');
  });

  console.log('\nRequests for quotation');
  await test('an approved buyer can save, edit, submit and delete requests; others cannot see them', async () => {
    const items = [{ name: 'Smoked mackerel', qty: 25, description: 'Frozen, 20kg carton' }];
    assert.strictEqual((await ada.post('/wholesale/rfq', { items: [] })).status, 400);
    const r = await ada.post('/wholesale/rfq', { items, delivery_location: '12 Port Road, Apapa' }); assert.strictEqual(r.status, 200, r.text); const rf = r.json.ref;
    assert.strictEqual((await ada.put('/wholesale/rfq/' + rf, { items: [...items, { name: 'Added later', qty: 5 }], delivery_location: '12 Port Road, Apapa' })).status, 200);
    assert.strictEqual((await ada.get('/wholesale/rfq/' + rf)).json.request.items.length, 2);
    assert.strictEqual((await bob.get('/wholesale/rfq/' + rf)).status === 404 || (await bob.get('/wholesale/rfq/' + rf)).status === 403, true);
    assert.strictEqual((await ada.post(`/wholesale/rfq/${rf}/submit`)).status, 200); assert.strictEqual((await ada.post(`/wholesale/rfq/${rf}/submit`)).status, 409);
    assert.strictEqual((await ada.get('/wholesale/rfq')).json.summary.total, 1);
    const d = await ada.post('/wholesale/rfq', { items }); assert.strictEqual((await ada.del('/wholesale/rfq/' + d.json.ref)).status, 200);
  });

  console.log('\nWhat is kept separate');
  await test('retail and wholesale stock stayed independent through the whole flow', async () => {
    assert.strictEqual(await retail(P1.id), retail1); assert.strictEqual(await retail(P2.id), retail2);
  });
  await test('admin, staff and other roles cannot use the app wholesale routes; app tokens do not open the website wholesale routes', async () => {
    const owner = new App(); const r = await owner.req('POST', '/auth/login', { email: 'owner@example.com', password: 'Owner-pass-2026-xyz', device: owner.device }); assert.strictEqual(r.status, 403);
    const web = await fetch(BASE + '/api/wholesale/me', { headers: { Authorization: 'Bearer ' + ada.access } }); assert.strictEqual(web.status, 401);
  });

  srv.kill(); fake.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(DATA, { recursive: true, force: true });
  await pgAdmin(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\nServer log:\n' + log.slice(-1800)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
