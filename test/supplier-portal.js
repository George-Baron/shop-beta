'use strict';
// The supplier portal: logins, supplier-only data, confirm / tracking / reject, price and stock proposals that wait for an admin, privacy and the off switch.
// Run with: npm run test:supplier-portal
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_dsp_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1000), FAKE = PORT + 2000;
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '', SEQ = 0;
const call = async (method, url, body, cookie, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const buf = Buffer.from(await r.arrayBuffer()); const t = buf.toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  if (process.env.DEBUG_V && r.status >= 400) console.log('   [' + r.status + '] ' + method + ' ' + url + ' ' + t.slice(0, 300));
  return { s: r.status, j, t, buf, type: r.headers.get('content-type') || '', c: (sc[0] || '').split(';')[0] };
};
const pay = {};
const fake = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const body = Buffer.concat(c).toString(); const send = (s, o) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/transaction/initialize') { const j = JSON.parse(body); pay[j.reference] = { amount: j.amount, currency: j.currency }; return send(200, { status: true, data: { authorization_url: 'http://pay.test/' + j.reference } }); }
    const m = /^\/transaction\/verify\/(.+)$/.exec(req.url);
    if (m) { const ref = decodeURIComponent(m[1]), p = pay[ref] || {}; return send(200, { status: true, data: { status: 'success', reference: ref, amount: p.amount, currency: p.currency } }); }
    send(404, {});
  });
});

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-dso-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50',
    PAYSTACK_SECRET_KEY: 'sk_test_dsp', PAYSTACK_API_URL: 'http://127.0.0.1:' + FAKE, DROPSHIP_ORDERS_ENABLED: '1', SUPPLIER_PORTAL_ENABLED: '1' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' })).c;
  const A = (m, u, b) => call(m, u, b, admin), D = (m, u, b) => A(m, '/api/admin/dropship' + u, b), SO = (m, u, b) => D(m, '/supplier-orders' + u, b);

  /* ---- fixtures: a supplier, three dropship products, one product we hold ourselves ---- */
  const SUPPLIER = { name: 'Acme Supply Ltd', country: 'NG', currency: 'NGN', contact_name: 'Ife Bello', email: 'orders@acme.example', whatsapp: '+234 803 111 2222', address: '12 Ikeja Road', payment_terms: 'Prepaid', payment_days: 0, processing_days: 2, shipping_methods: ['courier'] };
  const sup = (await D('POST', '/suppliers', SUPPLIER)).j.id, sup2 = (await D('POST', '/suppliers', { ...SUPPLIER, name: 'Beta Wholesale', email: 'beta@wholesale.example', whatsapp: '' })).j.id;
  const mk = async (name, sku, supplier, cost, stock, ship = 500) => {
    const r = await D('POST', '/products', { supplier_id: supplier, supplier_sku: sku, name, store: 'electronics', brand: 'Acme', description: name + ' for tests', cost, ship_cost: ship, processing_days: 2, ship_times: { NG: { min: 3, max: 6 } }, weight_kg: 0.3, origin_country: 'NG', supplier_stock: stock });
    assert.strictEqual(r.s, 200, r.t);
    await q("UPDATE products SET images='[\"https://cdn.example.com/a.jpg\"]', listing='approved', active=1 WHERE id=$1", [r.j.id]);
    return r.j.id;
  };
  assert.strictEqual((await D('PUT', '/rates/USD', { ngn_per_unit: 1500 })).s, 200);
  const sup3 = (await D('POST', '/suppliers', { ...SUPPLIER, name: 'Global Gadgets', country: 'CN', currency: 'USD', email: 'g@global.example', payment_terms: 'Net 30', payment_days: 30 })).j.id;
  const P1 = await mk('Quartz Lamp', 'ACM-1', sup, 10000, 40), P2 = await mk('Quartz Fan', 'ACM-2', sup, 8000, null), P3 = await mk('Quartz Heater', 'ACM-3', sup2, 9000, 25), P4 = await mk('Quartz Drone', 'GG-1', sup3, 20, 30, 0.5);
  const own = (await q("SELECT id, price, stock FROM products WHERE active=1 AND stock>=30 AND fulfilment='own' AND vendor_id IS NULL AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 1"))[0];
  const priceOf = async (id) => Number((await q('SELECT price FROM products WHERE id=$1', [id]))[0].price);

  let n = 0;
  // dropshipped items can only be bought by a registered member (docs/MEMBERS.md)
  const MEMBER = (await call('POST', '/api/auth/register', { name: 'Shop Member', email: 'shop.member@example.com', phone: '08031239999', password: 'mango-river-sky-55' })).c;
  const place = async (items, o = {}) => {
    const body = { items, contact: { name: o.name || 'Ada Obi', email: o.email || `ada${++n}@example.com`, phone: '08011112222' }, address: { state: 'Lagos', city: 'Ikeja', address: '5 Allen Avenue' }, delivery: 'standard', payment: o.payment || 'paystack', idempotencyKey: crypto.randomUUID().replace(/-/g, '') };
    const r = await call('POST', '/api/checkout', body, MEMBER); if (r.s !== 200) return r;
    const row = (await q('SELECT * FROM orders WHERE ref=$1', [r.j.ref]))[0];
    return { s: 200, ref: r.j.ref, row, token: row.access_token, email: row.email };
  };
  const payFor = async (o) => (await call('GET', '/api/paystack/verify?reference=' + o.ref)).j;
  const lines = async (orderId) => (await q('SELECT * FROM dropship_lines WHERE order_id=$1 ORDER BY id', [orderId]));
  const orderRow = async (ref) => (await q('SELECT * FROM orders WHERE ref=$1', [ref]))[0];
  const T = (id, to, b = {}) => SO('POST', `/lines/${id}/transition`, { to, ...b });
  const view = (o) => call('POST', '/api/orders/lookup', { ref: o.ref, token: o.token });
  const outbox = async (like) => q('SELECT * FROM outbox WHERE to_email LIKE $1 ORDER BY id', [like]);
  const M = (m, u, b) => D(m, '/money' + u, b);
  const lineOf = async (orderId) => (await q('SELECT * FROM dropship_lines WHERE order_id=$1 ORDER BY id', [orderId]))[0];
  // buys an item, pays, orders it from the supplier and returns { o, line, po }
  const ordered = async (productId, supplierId, qty = 1) => {
    const o = await place([{ productId, qty }]); assert.strictEqual(o.s, 200, o.t); await payFor(o);
    const po = (await SO('POST', '/po', { order_id: o.row.id, supplier_id: supplierId })).j; assert.strictEqual((await SO('POST', `/po/${po.id}/send`, { via: 'manual' })).s, 200);
    return { o, line: await lineOf(o.row.id), po };
  };
  const ship = async (l) => { assert.strictEqual((await T(l.id, 'confirmed', { supplier_order_no: 'S-' + l.id })).s, 200); assert.strictEqual((await T(l.id, 'shipped', { carrier: 'DHL', tracking_no: 'T' + l.id })).s, 200); assert.strictEqual((await T(l.id, 'delivered')).s, 200); };

  const PW = 'Tundra-Pelican-Orbit-81';
  // a supplier login: the admin creates it, the invite link sets the password, and the supplier is signed in
  const makeLogin = async (supplierId, name, email) => {
    const r = await D('POST', `/suppliers/${supplierId}/portal`, { name, email, phone: '08030001111' }); assert.strictEqual(r.s, 200, r.t); assert.ok(r.j.invite_link || r.j.emailed);
    const token = r.j.invite_link ? new URL(r.j.invite_link).searchParams.get('token') : (await q("SELECT 1"))[0] && null;
    const s = await call('POST', '/api/auth/reset', { token, password: PW }); assert.strictEqual(s.s, 200, s.t); return { id: r.j.id, cookie: s.c, user: s.j.user };
  };
  console.log('\nLogins');
  let A1, B1, c1, c2;
  await test('the admin creates a supplier login; the invite link lets the person choose a password; the account is a supplier tied to that supplier only', async () => {
    assert.strictEqual((await D('POST', `/suppliers/${sup}/portal`, { name: 'X', email: 'bad' })).s, 400);
    A1 = await makeLogin(sup, 'Ife Bello', 'ife@acme.example'); B1 = await makeLogin(sup2, 'Bola Beta', 'bola@beta.example');
    assert.strictEqual(A1.user.role, 'supplier'); assert.strictEqual(Number(A1.user.supplier_id), Number(sup));
    assert.strictEqual((await D('POST', `/suppliers/${sup}/portal`, { name: 'Again', email: 'ife@acme.example' })).s, 409, 'one account per email');
    const me = await call('GET', '/api/supplier/me', undefined, A1.cookie); assert.strictEqual(me.s, 200, me.t); assert.strictEqual(me.j.supplier.name, 'Acme Supply Ltd'); assert.strictEqual(me.j.supplier.currency, 'NGN');
    assert.deepStrictEqual((await D('GET', `/suppliers/${sup}/portal`)).j.logins.map((x) => x.email), ['ife@acme.example']);
  });
  await test('only a signed-in supplier reaches the portal; customers, the owner and visitors do not, and a supplier cannot reach the back office', async () => {
    for (const u of ['/me', '/orders', '/products', '/requests']) { assert.strictEqual((await call('GET', '/api/supplier' + u)).s, 401, 'visitor ' + u); assert.strictEqual((await call('GET', '/api/supplier' + u, undefined, admin)).s, 401, 'owner ' + u); }
    for (const u of ['/dropship/money/report', '/dropship/suppliers', '/dropship/portal/inbox', '/dropship/supplier-orders/queue', '/orders', '/settings']) assert.strictEqual((await call('GET', '/api/admin' + u, undefined, A1.cookie)).s, 401, 'supplier on admin ' + u);
    assert.strictEqual((await call('POST', '/api/admin/dropship/portal/requests/1/decide', { decision: 'approved' }, A1.cookie)).s, 401);
  });

  console.log('\nPurchase orders');
  let o1, o2, po1;
  await test('a supplier sees its purchase order only once it is sent, with where to ship and what it earns: never the customer price, our margin or the customer email', async () => {
    o1 = await place([{ productId: P1, qty: 2 }], { name: 'Ada Obi', email: 'ada.private@example.com' }); await payFor(o1);
    po1 = (await SO('POST', '/po', { order_id: o1.row.id, supplier_id: sup })).j;
    assert.strictEqual((await call('GET', '/api/supplier/orders', undefined, A1.cookie)).j.orders.length, 0, 'a draft purchase order is not shown');
    await SO('POST', `/po/${po1.id}/send`, { via: 'manual' });
    const r = await call('GET', '/api/supplier/orders', undefined, A1.cookie); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.orders.length, 1);
    const po = r.j.orders[0], l = po.lines[0]; assert.strictEqual(po.ref, po1.ref); assert.strictEqual(po.ship_to.name, 'Ada Obi'); assert.match(po.ship_to.address, /Allen Avenue/);
    assert.strictEqual(l.qty, 2); assert.strictEqual(l.unit_cost, 10000); assert.strictEqual(l.total, 21000); assert.strictEqual(l.status, 'sent'); assert.strictEqual(l.can_confirm, true);
    const t = r.t; assert.ok(!/ada\.private|sell_price|margin|profit|refund_due|payable|cost_ngn|customer_choice/i.test(t), 'no private data: ' + t.slice(0, 300)); assert.ok(!t.includes(o1.ref), 'no internal order reference');
    assert.strictEqual((await call('GET', '/api/supplier/orders', undefined, B1.cookie)).j.orders.length, 0, 'the other supplier sees nothing');
  });
  await test("another supplier's order and items look like they do not exist: no reading, confirming, tracking or rejecting", async () => {
    const lid = po1 && (await q('SELECT id FROM dropship_lines WHERE order_id=$1', [o1.row.id]))[0].id;
    assert.strictEqual((await call('GET', `/api/supplier/orders/${po1.id}`, undefined, B1.cookie)).s, 404);
    for (const [u, b] of [['confirm', { supplier_order_no: 'X1' }], ['tracking', { carrier: 'DHL', tracking_no: 'T1' }], ['reject', { kind: 'other', note: 'nope' }]]) assert.strictEqual((await call('POST', `/api/supplier/lines/${lid}/${u}`, b, B1.cookie)).s, 404, u);
    assert.strictEqual((await q('SELECT status, supplier_response FROM dropship_lines WHERE id=$1', [lid]))[0].status, 'sent');
  });
  let line1;
  await test('confirming needs the supplier order number, is idempotent, and moves the item to confirmed with the actor recorded', async () => {
    line1 = (await q('SELECT * FROM dropship_lines WHERE order_id=$1', [o1.row.id]))[0];
    assert.strictEqual((await call('POST', `/api/supplier/lines/${line1.id}/confirm`, {}, A1.cookie)).s, 400);
    const r = await call('POST', `/api/supplier/lines/${line1.id}/confirm`, { supplier_order_no: 'ACME-77' }, A1.cookie); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.status, 'confirmed');
    const again = await call('POST', `/api/supplier/lines/${line1.id}/confirm`, { supplier_order_no: 'ACME-77' }, A1.cookie); assert.strictEqual(again.s, 200); assert.strictEqual(again.j.unchanged, true, 'a double click changes nothing');
    const ev = (await q("SELECT actor FROM dropship_events WHERE line_id=$1 AND to_status='confirmed'", [line1.id]))[0]; assert.match(ev.actor, /^supplier: Ife Bello/);
    assert.strictEqual((await q('SELECT supplier_order_no FROM dropship_lines WHERE id=$1', [line1.id]))[0].supplier_order_no, 'ACME-77');
  });
  await test('tracking: needs carrier and number, shipped / in transit / customs only (we confirm delivery), a wrong number can be corrected, and the customer is emailed', async () => {
    const T = (b) => call('POST', `/api/supplier/lines/${line1.id}/tracking`, b, A1.cookie);
    assert.strictEqual((await T({ status: 'shipped' })).s, 400, 'no carrier'); assert.strictEqual((await T({ status: 'delivered', carrier: 'DHL', tracking_no: 'T1' })).s, 400, 'delivery is ours to confirm');
    const r = await T({ status: 'shipped', carrier: 'DHL', tracking_no: 'JD001', tracking_url: 'https://dhl.example/t/JD001' }); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.status, 'shipped');
    const c = await T({ status: 'shipped', carrier: 'DHL', tracking_no: 'JD002' }); assert.strictEqual(c.s, 200); assert.strictEqual(c.j.corrected, true);
    assert.strictEqual((await q('SELECT tracking_no FROM dropship_lines WHERE id=$1', [line1.id]))[0].tracking_no, 'JD002');
    assert.strictEqual((await T({ status: 'in_transit', carrier: 'DHL', tracking_no: 'JD002' })).s, 200);
    const mails = await q("SELECT subject FROM outbox WHERE to_email=$1", [o1.email]); assert.ok(mails.some((m) => /ship/i.test(m.subject)), 'customer told it shipped: ' + JSON.stringify(mails));
    const o = (await call('GET', `/api/supplier/orders/${po1.id}`, undefined, A1.cookie)).j.order.lines[0]; assert.strictEqual(o.label, 'In transit'); assert.strictEqual(o.can_ship, true);
  });
  await test('tracking before confirming is refused with a clear message; "confirm and ship" does both in one step', async () => {
    o2 = await place([{ productId: P2, qty: 1 }]); await payFor(o2); const p2 = (await SO('POST', '/po', { order_id: o2.row.id, supplier_id: sup })).j; await SO('POST', `/po/${p2.id}/send`, { via: 'manual' });
    const l = (await q('SELECT id FROM dropship_lines WHERE order_id=$1', [o2.row.id]))[0].id;
    const t = await call('POST', `/api/supplier/lines/${l}/tracking`, { carrier: 'GIG', tracking_no: 'G1' }, A1.cookie); assert.strictEqual(t.s, 409); assert.match(t.j.error, /Confirm the item first/);
    const r = await call('POST', `/api/supplier/lines/${l}/confirm`, { supplier_order_no: 'ACME-78', carrier: 'GIG', tracking_no: 'G1' }, A1.cookie); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.status, 'shipped');
  });

  console.log('\nRejections wait for an admin');
  let o3, l3;
  await test('"we cannot supply this" changes nothing on the order: it waits for the admin, who is emailed', async () => {
    o3 = await place([{ productId: P1, qty: 1 }]); await payFor(o3); const p3 = (await SO('POST', '/po', { order_id: o3.row.id, supplier_id: sup })).j; await SO('POST', `/po/${p3.id}/send`, { via: 'manual' });
    l3 = (await q('SELECT id FROM dropship_lines WHERE order_id=$1', [o3.row.id]))[0].id;
    const R = (b) => call('POST', `/api/supplier/lines/${l3}/reject`, b, A1.cookie);
    assert.strictEqual((await R({ kind: 'bogus', note: 'x' })).s, 400); assert.strictEqual((await R({ kind: 'out_of_stock', note: '' })).s, 400, 'a reason in words is needed');
    assert.strictEqual((await R({ kind: 'out_of_stock', note: 'Warehouse count is zero' })).s, 200);
    const row = (await q('SELECT status, supplier_response, supplier_response_kind FROM dropship_lines WHERE id=$1', [l3]))[0]; assert.strictEqual(row.status, 'sent', 'the item itself is untouched'); assert.strictEqual(row.supplier_response, 'rejected');
    assert.strictEqual((await R({ kind: 'out_of_stock', note: 'again' })).j.unchanged, true);
    assert.strictEqual((await call('POST', `/api/supplier/lines/${l3}/confirm`, { supplier_order_no: 'Z' }, A1.cookie)).s, 409, 'cannot confirm while the rejection waits');
    const mail = await q("SELECT subject FROM outbox WHERE subject LIKE '%cannot supply%'"); assert.ok(mail.length >= 1, 'admin alerted');
    assert.strictEqual((await q('SELECT COUNT(*) n FROM outbox WHERE to_email=$1 AND subject ILIKE $2', [o3.email, '%problem%']))[0].n, '0', 'the customer is not told yet');
    const lab = (await call('GET', '/api/supplier/orders', undefined, A1.cookie)).j.orders.flatMap((p) => p.lines).find((x) => x.id == l3); assert.strictEqual(lab.rejected, true); assert.strictEqual(lab.can_confirm, false);
  });
  await test('the admin sees it in the inbox; declining clears it and the supplier can confirm; accepting makes it a problem and the customer is told', async () => {
    const inbox = (await D('GET', '/portal/inbox')).j; assert.strictEqual(inbox.rejections.length, 1); assert.strictEqual(inbox.rejections[0].line_id, Number(l3)); assert.strictEqual(inbox.rejections[0].reason, 'Out of stock');
    assert.strictEqual((await D('POST', `/portal/lines/${l3}/decide`, { decision: 'maybe' })).s, 400);
    assert.strictEqual((await D('POST', `/portal/lines/${l3}/decide`, { decision: 'decline', note: 'Please check again' })).s, 200);
    assert.strictEqual((await q('SELECT supplier_response FROM dropship_lines WHERE id=$1', [l3]))[0].supplier_response, '');
    assert.strictEqual((await call('POST', `/api/supplier/lines/${l3}/reject`, { kind: 'supplier_cancelled', note: 'Really cannot' }, A1.cookie)).s, 200);
    const a = await D('POST', `/portal/lines/${l3}/decide`, { decision: 'accept' }); assert.strictEqual(a.s, 200, a.t);
    const row = (await q('SELECT status, issue_kind, supplier_response FROM dropship_lines WHERE id=$1', [l3]))[0]; assert.strictEqual(row.status, 'issue'); assert.strictEqual(row.issue_kind, 'supplier_cancelled'); assert.strictEqual(row.supplier_response, '');
    assert.ok(Number((await q("SELECT COUNT(*) n FROM outbox WHERE to_email=$1", [o3.email]))[0].n) >= 1, 'the customer is emailed and can choose');
    assert.strictEqual((await D('POST', `/portal/lines/${l3}/decide`, { decision: 'accept' })).s, 409, 'nothing left to decide');
    assert.strictEqual((await D('GET', '/portal/inbox')).j.rejections.length, 0);
  });

  console.log('\nPrice and stock proposals');
  let rq, prod1;
  await test('a supplier sees only its own products, with its own price and stock but never our selling price', async () => {
    const r = await call('GET', '/api/supplier/products', undefined, A1.cookie); assert.strictEqual(r.s, 200); prod1 = r.j.products.find((x) => x.sku === 'ACM-1');
    assert.ok(prod1 && prod1.cost === 10000 && prod1.stock === 40); assert.ok(!r.j.products.some((x) => x.sku === 'ACM-3'), "not the other supplier's"); assert.ok(!/"price"|listing|margin/i.test(r.t));
  });
  await test('a price proposal changes nothing until the admin approves it', async () => {
    const before = (await q('SELECT p.price, dp.cost FROM products p JOIN dropship_products dp ON dp.product_id=p.id WHERE p.id=$1', [P1]))[0];
    const R = (b) => call('POST', '/api/supplier/requests', { product_id: P1, ...b }, A1.cookie);
    assert.strictEqual((await R({ kind: 'price', cost: 0 })).s, 400); assert.strictEqual((await R({ kind: 'price', cost: 'abc' })).s, 400); assert.strictEqual((await R({ kind: 'price', cost: 10000, ship_cost: 500 })).s, 400, 'same as now');
    assert.strictEqual((await R({ kind: 'stock', stock: -1 })).s, 400); assert.strictEqual((await R({ kind: 'weird' })).s, 400);
    assert.strictEqual((await call('POST', '/api/supplier/requests', { product_id: P3, kind: 'price', cost: 5 }, A1.cookie)).s, 404, "another supplier's product");
    const r = await R({ kind: 'price', cost: 12000, ship_cost: 600, note: 'Raw material costs went up' }); assert.strictEqual(r.s, 200, r.t); rq = r.j.id;
    const after = (await q('SELECT p.price, dp.cost FROM products p JOIN dropship_products dp ON dp.product_id=p.id WHERE p.id=$1', [P1]))[0]; assert.strictEqual(Number(after.cost), Number(before.cost)); assert.strictEqual(Number(after.price), Number(before.price));
    const r2 = await R({ kind: 'price', cost: 12500 }); const pend = await q("SELECT id, new_cost FROM supplier_requests WHERE product_id=$1 AND kind='price' AND status='pending'", [P1]);
    assert.strictEqual(pend.length, 1, 'a newer proposal replaces the old one'); assert.strictEqual(Number(pend[0].new_cost), 12500); rq = r2.j.id;
    assert.ok((await q("SELECT 1 FROM outbox WHERE subject LIKE '%proposed a price%'")).length >= 1, 'admin alerted');
  });
  await test('the admin sees the proposal beside the current price; rejecting needs a reason; approving applies it through the normal product update and the supplier is emailed', async () => {
    const inbox = (await D('GET', '/portal/inbox')).j, r = inbox.requests.find((x) => x.id === rq); assert.ok(r); assert.strictEqual(r.old_cost, 10000); assert.strictEqual(r.new_cost, 12500); assert.strictEqual(r.supplier, 'Acme Supply Ltd'); assert.ok(r.current_price > 0);
    assert.strictEqual((await D('POST', `/portal/requests/${rq}/decide`, { decision: 'rejected' })).s, 400);
    const priceBefore = r.current_price, orderCost = (await q('SELECT unit_cost FROM dropship_lines WHERE order_id=$1', [o1.row.id]))[0].unit_cost;
    const a = await D('POST', `/portal/requests/${rq}/decide`, { decision: 'approved' }); assert.strictEqual(a.s, 200, a.t); assert.ok(a.j.price_after > priceBefore, 'the automatic price follows the new cost');
    assert.strictEqual(Number((await q('SELECT cost FROM dropship_products WHERE product_id=$1', [P1]))[0].cost), 12500);
    assert.strictEqual(Number((await q('SELECT unit_cost FROM dropship_lines WHERE order_id=$1', [o1.row.id]))[0].unit_cost), Number(orderCost), 'orders already placed keep their price');
    assert.strictEqual((await D('POST', `/portal/requests/${rq}/decide`, { decision: 'rejected', note: 'late' })).s, 409, 'decided once');
    assert.ok((await q("SELECT 1 FROM outbox WHERE to_email='ife@acme.example' AND subject LIKE '%approved%'")).length >= 1);
    const mine = (await call('GET', '/api/supplier/requests', undefined, A1.cookie)).j.requests; assert.strictEqual(mine[0].status, 'approved');
  });
  await test('a stock proposal is applied only on approval; a rejection leaves everything as it was', async () => {
    const s1 = (await call('POST', '/api/supplier/requests', { product_id: P1, kind: 'stock', stock: 0, note: 'Sold out' }, A1.cookie)).j.id;
    assert.strictEqual(Number((await q('SELECT supplier_stock FROM dropship_products WHERE product_id=$1', [P1]))[0].supplier_stock), 40);
    assert.strictEqual((await D('POST', `/portal/requests/${s1}/decide`, { decision: 'approved' })).s, 200);
    assert.strictEqual(Number((await q('SELECT supplier_stock FROM dropship_products WHERE product_id=$1', [P1]))[0].supplier_stock), 0); assert.strictEqual(Number((await q('SELECT stock FROM products WHERE id=$1', [P1]))[0].stock), 0);
    const s2 = (await call('POST', '/api/supplier/requests', { product_id: P2, kind: 'stock', stock: 500 }, A1.cookie)).j.id;
    assert.strictEqual((await D('POST', `/portal/requests/${s2}/decide`, { decision: 'rejected', note: 'We cannot verify that yet' })).s, 200);
    assert.notStrictEqual(Number((await q('SELECT supplier_stock FROM dropship_products WHERE product_id=$1', [P2]))[0].supplier_stock), 500);
    assert.strictEqual((await D('GET', '/portal/history')).j.requests.length, 3);
  });

  console.log('\nAccess control and the off switch');
  await test('switching a login off signs that person out everywhere at once; switching it on again lets them back in; resending the invite works', async () => {
    assert.strictEqual((await call('GET', '/api/supplier/me', undefined, B1.cookie)).s, 200);
    assert.strictEqual((await D('POST', `/suppliers/${sup2}/portal/${B1.id}/active`, { active: false })).s, 200);
    assert.strictEqual((await call('GET', '/api/supplier/me', undefined, B1.cookie)).s, 401);
    assert.strictEqual((await call('POST', '/api/auth/login', { email: 'bola@beta.example', password: PW })).c, '', 'cannot sign in while switched off');
    assert.strictEqual((await D('POST', `/suppliers/${sup2}/portal/${B1.id}/invite`, {})).s, 400, 'no invite for a switched-off login');
    assert.strictEqual((await D('POST', `/suppliers/${sup}/portal/${B1.id}/active`, { active: true })).s, 404, "a login can only be changed through its own supplier");
    assert.strictEqual((await D('POST', `/suppliers/${sup2}/portal/${B1.id}/active`, { active: true })).s, 200);
    const l = await call('POST', '/api/auth/login', { email: 'bola@beta.example', password: PW }); assert.ok(l.c); assert.strictEqual((await call('GET', '/api/supplier/me', undefined, l.c)).s, 200);
    assert.strictEqual((await D('POST', `/suppliers/${sup2}/portal/${B1.id}/invite`, {})).s, 200);
  });
  await test('with SUPPLIER_PORTAL_ENABLED off, no login can be created and a supplier session reaches nothing', async () => {
    const PORT2 = PORT + 1500, off = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT2), BASE_URL: 'http://127.0.0.1:' + PORT2, DATABASE_URL: urlOf(DB), DATA_DIR: process.env.DATA_DIR || '/tmp/sb-dsp-off-' + tag, SUPPLIER_PORTAL_ENABLED: '', PAYSTACK_SECRET_KEY: 'sk_test_dsp' } });
    try {
      for (let i = 0; i < 300; i++) { try { await fetch(`http://127.0.0.1:${PORT2}/health`); break; } catch { await sleep(100); } }
      const login = await fetch(`http://127.0.0.1:${PORT2}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ife@acme.example', password: PW }) });
      const ck = (login.headers.getSetCookie()[0] || '').split(';')[0];
      assert.strictEqual((await fetch(`http://127.0.0.1:${PORT2}/api/supplier/orders`, { headers: { Cookie: ck } })).status, 401);
      const ad = await fetch(`http://127.0.0.1:${PORT2}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' }) });
      const r = await fetch(`http://127.0.0.1:${PORT2}/api/admin/dropship/suppliers/${sup}/portal`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: (ad.headers.getSetCookie()[0] || '').split(';')[0] }, body: JSON.stringify({ name: 'Zed Zed', email: 'zed@acme.example' }) });
      assert.strictEqual(r.status, 403);
    } finally { off.kill(); }
  });
  await test('the migration can run again without changing anything, and supplier actions are in the activity log', async () => {
    const sql = require('fs').readFileSync(path.join(__dirname, '..', 'migrations', '029_supplier_portal.sql'), 'utf8'), c = new Pg({ connectionString: urlOf(DB) }); await c.connect();
    try { await c.query(sql); await c.query(sql); } finally { await c.end(); }
    assert.ok(Number((await q("SELECT COUNT(*) n FROM audit_log WHERE path LIKE '/api/supplier/%' AND method <> 'GET'"))[0].n) >= 8);
    assert.ok(Number((await q("SELECT COUNT(*) n FROM audit_log WHERE path LIKE '/api/admin/dropship/portal/%'"))[0].n) >= 4);
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM supplier_requests'))[0].n), 3);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fake.close(); try { srv.kill(); } catch { /* */ }
  await sleep(300);
  try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ }
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e, '\n--- server log ---\n' + log.slice(-2500)); try { srv.kill(); } catch { /* */ } try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ } process.exit(1); });
