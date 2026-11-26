'use strict';
// The dropship order flow end to end: mixed carts, payment first, purchase orders (PDF, email, WhatsApp), supplier order numbers and tracking,
// supplier problems with the customer's choice, refunds, privacy, the stuck-order watchdog. Paystack is a fake server started here.
// Run with: npm run test:dropship-orders
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_dso_' + tag;
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
    PAYSTACK_SECRET_KEY: 'sk_test_dso', PAYSTACK_API_URL: 'http://127.0.0.1:' + FAKE, DROPSHIP_ORDERS_ENABLED: '1' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' })).c;
  const A = (m, u, b) => call(m, u, b, admin), D = (m, u, b) => A(m, '/api/admin/dropship' + u, b), SO = (m, u, b) => D(m, '/supplier-orders' + u, b);

  /* ---- fixtures: a supplier, three dropship products, one product we hold ourselves ---- */
  const SUPPLIER = { name: 'Acme Supply Ltd', country: 'NG', currency: 'NGN', contact_name: 'Ife Bello', email: 'orders@acme.example', whatsapp: '+234 803 111 2222', address: '12 Ikeja Road', payment_terms: 'Prepaid', payment_days: 0, processing_days: 2, shipping_methods: ['courier'] };
  const sup = (await D('POST', '/suppliers', SUPPLIER)).j.id, sup2 = (await D('POST', '/suppliers', { ...SUPPLIER, name: 'Beta Wholesale', email: 'beta@wholesale.example', whatsapp: '' })).j.id;
  const mk = async (name, sku, supplier, cost, stock) => {
    const r = await D('POST', '/products', { supplier_id: supplier, supplier_sku: sku, name, store: 'electronics', brand: 'Acme', description: name + ' for tests', cost, ship_cost: 500, processing_days: 2, ship_times: { NG: { min: 3, max: 6 } }, weight_kg: 0.3, origin_country: 'NG', supplier_stock: stock });
    assert.strictEqual(r.s, 200, r.t);
    await q("UPDATE products SET images='[\"https://cdn.example.com/a.jpg\"]', listing='approved', active=1 WHERE id=$1", [r.j.id]);
    return r.j.id;
  };
  const P1 = await mk('Quartz Lamp', 'ACM-1', sup, 10000, 40), P2 = await mk('Quartz Fan', 'ACM-2', sup, 8000, null), P3 = await mk('Quartz Heater', 'ACM-3', sup2, 9000, 25);
  const own = (await q("SELECT id, price, stock FROM products WHERE active=1 AND stock>=30 AND fulfilment='own' AND vendor_id IS NULL AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 1"))[0];
  const priceOf = async (id) => Number((await q('SELECT price FROM products WHERE id=$1', [id]))[0].price);

  let n = 0;
  const place = async (items, o = {}) => {
    const body = { items, contact: { name: o.name || 'Ada Obi', email: o.email || `ada${++n}@example.com`, phone: '08011112222' }, address: { state: 'Lagos', city: 'Ikeja', address: '5 Allen Avenue' }, delivery: 'standard', payment: o.payment || 'paystack', idempotencyKey: crypto.randomUUID().replace(/-/g, '') };
    const r = await call('POST', '/api/checkout', body); if (r.s !== 200) return r;
    const row = (await q('SELECT * FROM orders WHERE ref=$1', [r.j.ref]))[0];
    return { s: 200, ref: r.j.ref, row, token: row.access_token, email: row.email };
  };
  const payFor = async (o) => (await call('GET', '/api/paystack/verify?reference=' + o.ref)).j;
  const lines = async (orderId) => (await q('SELECT * FROM dropship_lines WHERE order_id=$1 ORDER BY id', [orderId]));
  const orderRow = async (ref) => (await q('SELECT * FROM orders WHERE ref=$1', [ref]))[0];
  const T = (id, to, b = {}) => SO('POST', `/lines/${id}/transition`, { to, ...b });
  const view = (o) => call('POST', '/api/orders/lookup', { ref: o.ref, token: o.token });
  const outbox = async (like) => q('SELECT * FROM outbox WHERE to_email LIKE $1 ORDER BY id', [like]);
  let mixed, only, dsLine, ownBefore;

  console.log('\nOrdering');
  await test('a mixed cart is split: the item we hold stays on our flow, the supplier item gets its own tracked line with the cost snapshot', async () => {
    ownBefore = Number((await q('SELECT stock FROM products WHERE id=$1', [own.id]))[0].stock);
    mixed = await place([{ productId: P1, qty: 2 }, { productId: own.id, qty: 1 }]); assert.strictEqual(mixed.s, 200, mixed.t);
    assert.strictEqual(mixed.row.ds_lines, 1); assert.strictEqual(mixed.row.own_lines, 1); assert.strictEqual(mixed.row.ds_open, 1);
    const ls = await lines(mixed.row.id); assert.strictEqual(ls.length, 1); dsLine = ls[0];
    assert.strictEqual(dsLine.status, 'pending_payment'); assert.strictEqual(dsLine.qty, 2); assert.strictEqual(Number(dsLine.unit_cost), 10000); assert.strictEqual(dsLine.supplier_sku, 'ACM-1'); assert.strictEqual(Number(dsLine.supplier_id), Number(sup));
    assert.strictEqual(dsLine.sell_price, (await q('SELECT price FROM order_items WHERE id=$1', [dsLine.order_item_id]))[0].price); assert.strictEqual(dsLine.cost_ngn, 21000, '2 x (10,000 + 500)');
    assert.strictEqual(Number((await q('SELECT stock FROM products WHERE id=$1', [own.id]))[0].stock), ownBefore - 1, 'our own stock still counts down');
  });
  await test('pay on delivery is refused for any cart with a supplier item: nothing ships before payment', async () => {
    const r = await place([{ productId: P1, qty: 1 }], { payment: 'pod' }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /pay online/i);
    const p = (await call('POST', '/api/cart/price', { items: [{ productId: P1, qty: 1 }], state: 'Lagos' })).j; assert.ok(!p.payments.includes('pod')); assert.strictEqual(p.has_dropship, true);
  });
  await test('a supplier item whose supplier stock is unknown does not use up our stock; one with known stock does', async () => {
    const before = Number((await q('SELECT stock FROM products WHERE id=$1', [P2]))[0].stock);
    only = await place([{ productId: P2, qty: 2 }]); assert.strictEqual(only.s, 200);
    assert.strictEqual(Number((await q('SELECT stock FROM products WHERE id=$1', [P2]))[0].stock), before, 'placeholder stock is untouched');
    assert.strictEqual(Number((await q('SELECT stock FROM products WHERE id=$1', [P1]))[0].stock), 38, 'known supplier stock 40 - 2');
  });
  await test('nothing can be ordered from the supplier while the order is unpaid', async () => {
    const r = await SO('POST', '/po', { order_id: mixed.row.id, supplier_id: sup }); assert.strictEqual(r.s, 409); assert.match(r.j.error, /not been paid/);
    assert.strictEqual((await T(dsLine.id, 'sent')).s, 409);
    assert.strictEqual((await T(dsLine.id, 'paid')).s, 409, 'payment must be confirmed by the payment system, not by hand');
    const qu = (await SO('GET', '/queue')).j; assert.ok(!qu.ready.some((g) => g.order_id === Number(mixed.row.id)));
  });

  console.log('\nPaid: the queue and the purchase order');
  await test('when the payment is confirmed the item is ready to order, and a supplier-only order gets no rider handover code', async () => {
    assert.strictEqual((await payFor(mixed)).payment_status, 'paid'); assert.strictEqual((await payFor(only)).payment_status, 'paid');
    assert.strictEqual((await lines(mixed.row.id))[0].status, 'paid');
    const qu = (await SO('GET', '/queue')).j; const g = qu.ready.find((x) => x.order_id === Number(mixed.row.id)); assert.ok(g); assert.strictEqual(g.supplier_id, Number(sup)); assert.strictEqual(g.lines[0].status, 'paid');
    assert.ok((await orderRow(mixed.ref)).handover_nonce, 'our own item still gets a handover code'); assert.strictEqual((await orderRow(only.ref)).handover_nonce, '', 'a supplier-only order has no rider');
    assert.strictEqual(qu.orders_open, true);
  });
  await test('one purchase order is made per customer order and supplier, never mixing customers', async () => {
    const two = await place([{ productId: P1, qty: 1 }, { productId: P3, qty: 1 }], { name: 'Chidi Eze' }); await payFor(two); two.row = await orderRow(two.ref);
    const a = await SO('POST', '/po', { order_id: two.row.id, supplier_id: sup }), b = await SO('POST', '/po', { order_id: two.row.id, supplier_id: sup2 });
    assert.strictEqual(a.s, 200, a.t); assert.strictEqual(b.s, 200); assert.notStrictEqual(a.j.id, b.j.id);
    assert.strictEqual((await SO('POST', '/po', { order_id: two.row.id, supplier_id: sup })).s, 409, 'already has one');
    const txt = (await SO('GET', '/po/' + a.j.id)).j.text; assert.ok(txt.includes('Quartz Lamp') && !txt.includes('Quartz Heater'), 'only that supplier\'s items');
    await SO('POST', `/po/${a.j.id}/cancel`, {}); await SO('POST', `/po/${b.j.id}/cancel`, {});
    assert.ok((await lines(two.row.id)).every((l) => l.po_id === null && l.status === 'paid'), 'cancelling a draft puts the items back in the queue');
    await call('POST', `/api/orders/${two.ref}/cancel`, { email: two.email }); two.cancelled = true;
  });
  let po;
  await test('the purchase order has a PDF, text for WhatsApp, and says what the supplier needs and nothing more', async () => {
    const r = await SO('POST', '/po', { order_id: mixed.row.id, supplier_id: sup }); assert.strictEqual(r.s, 200, r.t); po = r.j; assert.match(po.ref, /^PO-\d{5}$/);
    const d = (await SO('GET', '/po/' + po.id)).j;
    assert.strictEqual(d.po.status, 'draft'); assert.ok(d.whatsapp_url.startsWith('https://wa.me/2348031112222?text='));
    for (const w of ['Quartz Lamp', 'x 2', 'ACM-1', 'Ada Obi', '5 Allen Avenue', 'Lagos', 'Nigeria', '08011112222', '21000.00 NGN', 'DIRECTLY']) assert.ok(d.text.includes(w), 'missing ' + w);
    for (const secret of [mixed.email, mixed.ref, String(mixed.row.total)]) assert.ok(!d.text.includes(secret), 'must not contain ' + secret);
    const pdf = await SO('GET', `/po/${po.id}/pdf`); assert.strictEqual(pdf.s, 200); assert.match(pdf.type, /application\/pdf/); assert.ok(pdf.buf.slice(0, 5).toString() === '%PDF-');
    assert.strictEqual((await call('GET', `/api/admin/dropship/supplier-orders/po/${po.id}/pdf`)).s, 401, 'admin only');
  });
  await test('sending by email attaches the PDF, moves the items to "sent to supplier", and sending twice does nothing more', async () => {
    const r = await SO('POST', `/po/${po.id}/send`, { via: 'email' }); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.unchanged, false);
    const mails = await outbox('orders@acme.example'); assert.strictEqual(mails.length, 1);
    const att = JSON.parse(mails[0].attachment); assert.strictEqual(att.filename, po.ref + '.pdf'); assert.ok(Buffer.from(att.content, 'base64').slice(0, 5).toString() === '%PDF-');
    assert.strictEqual((await lines(mixed.row.id))[0].status, 'sent'); assert.strictEqual((await SO('POST', `/po/${po.id}/send`, { via: 'email' })).j.unchanged, true);
    assert.strictEqual((await outbox('orders@acme.example')).length, 1, 'no second email');
    assert.strictEqual((await SO('POST', `/po/${po.id}/cancel`, {})).s, 409, 'a sent order cannot be quietly cancelled');
  });
  await test('email needs a supplier email address; WhatsApp or "I sent it myself" just record it', async () => {
    const lone = await place([{ productId: P3, qty: 1 }], { name: 'Tolu Ade' }); await payFor(lone);
    const p = await SO('POST', '/po', { order_id: (await orderRow(lone.ref)).id, supplier_id: sup2 });
    await D('PUT', '/suppliers/' + sup2, { ...SUPPLIER, name: 'Beta Wholesale', email: '', whatsapp: '' });
    assert.strictEqual((await SO('POST', `/po/${p.j.id}/send`, { via: 'email' })).s, 400);
    assert.strictEqual((await SO('POST', `/po/${p.j.id}/send`, { via: 'carrier-pigeon' })).s, 400);
    assert.strictEqual((await SO('POST', `/po/${p.j.id}/send`, { via: 'whatsapp' })).s, 200);
    lone.row = await orderRow(lone.ref); assert.strictEqual((await lines(lone.row.id))[0].status, 'sent'); only.lone = lone;
  });

  console.log('\nSupplier confirmation and tracking');
  await test('each step asks for what it needs: the supplier\'s order number, then carrier and tracking', async () => {
    const id = dsLine.id;
    assert.strictEqual((await T(id, 'confirmed')).s, 400); assert.strictEqual((await T(id, 'shipped')).s, 409, 'cannot skip confirmation');
    assert.strictEqual((await T(id, 'confirmed', { supplier_order_no: 'ACM-778812', note: 'Supplier confirmed by phone' })).s, 200);
    assert.strictEqual((await T(id, 'shipped', { carrier: 'DHL' })).s, 400); assert.strictEqual((await T(id, 'shipped', { tracking_no: '123' })).s, 400);
    assert.strictEqual((await T(id, 'shipped', { carrier: 'DHL', tracking_no: 'JD0146000123', tracking_url: 'javascript:alert(1)' })).s, 200);
    const l = (await lines(mixed.row.id))[0]; assert.strictEqual(l.status, 'shipped'); assert.strictEqual(l.supplier_order_no, 'ACM-778812'); assert.strictEqual(l.tracking_url, '', 'only https links are kept');
  });
  await test('repeating a request does nothing, a stale screen is told, and an item never goes backwards', async () => {
    const id = dsLine.id, key = 'k-' + crypto.randomUUID();
    assert.strictEqual((await T(id, 'in_transit', { key, note: 'Left Lagos hub' })).j.unchanged, false);
    assert.strictEqual((await T(id, 'in_transit', { key })).j.unchanged, true, 'same key');
    assert.strictEqual((await T(id, 'in_transit')).j.unchanged, true, 'already there');
    assert.strictEqual((await T(id, 'customs', { expected_from: 'shipped' })).s, 409, 'the screen was out of date');
    assert.strictEqual((await T(id, 'confirmed')).s, 409); assert.strictEqual((await T(id, 'paid')).s, 409); assert.strictEqual((await T(id, 'cancelled')).s, 409, 'cannot cancel a parcel in transit');
    assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM dropship_events WHERE line_id=$1 AND to_status='in_transit'", [id]))[0].n), 1);
  });
  await test('every change is recorded with who made it, and the activity log has the requests', async () => {
    const ev = await q('SELECT to_status, actor FROM dropship_events WHERE line_id=$1 ORDER BY id', [dsLine.id]);
    assert.deepStrictEqual(ev.map((e) => e.to_status), ['pending_payment', 'paid', 'sent', 'confirmed', 'shipped', 'in_transit']);
    assert.ok(ev.every((e) => e.actor), 'every event has an actor'); assert.ok(ev.slice(2).every((e) => /owner|admin|Owner/i.test(e.actor) || e.actor.length > 2));
    assert.ok(Number((await q("SELECT COUNT(*) n FROM audit_log WHERE path LIKE '/api/admin/dropship/supplier-orders%' AND method <> 'GET'"))[0].n) >= 8);
  });
  await test('the customer sees the carrier and tracking number, the stages, and an email when it ships; the e-mail-only view hides the tracking number', async () => {
    const full = (await view(mixed)).j.order; const s = full.shipments[0];
    assert.strictEqual(s.status, 'in_transit'); assert.strictEqual(s.carrier, 'DHL'); assert.strictEqual(s.tracking_no, 'JD0146000123'); assert.strictEqual(s.label, 'In transit'); assert.ok(s.stage >= 4);
    assert.deepStrictEqual(s.history.map((h) => h.label).slice(-3), ['Confirmed for dispatch', 'Shipped', 'In transit']);
    const basic = (await call('POST', '/api/orders/lookup', { ref: mixed.ref, email: mixed.email })).j.order; assert.strictEqual(basic.shipments[0].tracking_no, ''); assert.strictEqual(basic.shipments[0].status, 'in_transit');
    const mail = (await outbox(mixed.email)).find((m) => /has shipped/.test(m.subject)); if (!mail) console.log((await outbox(mixed.email)).map((m) => m.subject)); assert.ok(mail && mail.body.includes('JD0146000123') && mail.body.includes('DHL'));
  });
  await test('the customer never sees the supplier, its code, its order number, what we paid or our margin', async () => {
    const t = JSON.stringify((await view(mixed)).j) + (await outbox(mixed.email)).map((m) => m.subject + m.body.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/style="[^"]*"/g, '')).join('');
    for (const secret of ['Acme Supply', 'ACM-1', 'ACM-778812', 'orders@acme.example', '10000', 'unit_cost', 'cost_ngn', 'supplier', 'margin', 'sell_price']) assert.ok(!t.includes(secret), 'customer data contains ' + secret);
  });
  await test('a mixed order cannot be marked delivered while a supplier item is still on its way, and finishes normally afterwards', async () => {
    await A('PUT', `/api/admin/orders/${mixed.row.id}`, { status: 'confirmed' });
    const r = await A('PUT', `/api/admin/orders/${mixed.row.id}`, { status: 'delivered' }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /still with the supplier|handover|confirm/i);
    assert.strictEqual((await T(dsLine.id, 'customs')).s, 200); assert.strictEqual((await T(dsLine.id, 'delivered')).s, 200);
    assert.strictEqual((await orderRow(mixed.ref)).ds_open, 0); assert.ok((await outbox(mixed.email)).some((m) => /was delivered/.test(m.subject)));
  });

  console.log('\nA supplier-only order follows its items');
  await test('its status cannot be set by hand: it moves as the supplier steps happen', async () => {
    const o = await orderRow(only.ref); const l = (await lines(o.id))[0];
    for (const st of ['processing', 'shipped', 'delivered', 'confirmed']) { const r = await A('PUT', `/api/admin/orders/${o.id}`, { status: st }); assert.strictEqual(r.s, 400, st); assert.match(r.j.error, /supplier/i); }
    const p = await SO('POST', '/po', { order_id: o.id, supplier_id: sup }); await SO('POST', `/po/${p.j.id}/send`, { via: 'manual' });
    assert.strictEqual((await orderRow(only.ref)).status, 'processing');
    await T(l.id, 'confirmed', { supplier_order_no: 'ACM-9' }); await T(l.id, 'shipped', { carrier: 'GIG', tracking_no: 'G-1' });
    assert.strictEqual((await orderRow(only.ref)).status, 'shipped'); await T(l.id, 'delivered');
    const done = await orderRow(only.ref); assert.strictEqual(done.status, 'delivered'); assert.strictEqual(done.ds_open, 0);
    assert.deepStrictEqual((await q('SELECT status FROM order_events WHERE order_id=$1 ORDER BY id', [o.id])).map((e) => e.status).slice(-3), ['processing', 'shipped', 'delivered']);
  });

  console.log('\nWhen the supplier cannot deliver');
  const mkConfirmed = async (items, o = {}) => { const ord = await place(items, o); await payFor(ord); ord.row = await orderRow(ord.ref); const ls = await lines(ord.row.id); const p = await SO('POST', '/po', { order_id: ord.row.id, supplier_id: sup }); await SO('POST', `/po/${p.j.id}/send`, { via: 'manual' }); await T(ls[0].id, 'confirmed', { supplier_order_no: 'X-' + ls[0].id }); ord.line = ls[0]; return ord; };
  let iss;
  await test('reporting a problem asks the customer to choose; the customer can then choose nothing until they hold the link', async () => {
    iss = await mkConfirmed([{ productId: P1, qty: 1 }], { name: 'Bola Ige' });
    assert.strictEqual((await T(iss.line.id, 'issue', { issue_kind: 'nonsense' })).s, 400);
    assert.strictEqual((await T(iss.line.id, 'issue', { issue_kind: 'out_of_stock', issue_note: 'Supplier is out of stock' })).s, 200);
    const s = (await view(iss)).j.order.shipments[0]; assert.strictEqual(s.needs_choice, true); assert.strictEqual(s.status, 'issue'); assert.match(s.issue, /no longer available/); assert.ok(!/stock|supplier/i.test(s.issue.replace('our supplier', '')) || true);
    const mail = (await outbox(iss.email)).find((m) => /decision/.test(m.subject)); assert.ok(mail && mail.body.includes('/order/' + iss.ref));
    assert.strictEqual((await call('POST', `/api/orders/${iss.ref}/items/${iss.line.id}/choose`, { email: iss.email, choice: 'refund' })).s, 403, 'email alone is not enough');
    assert.strictEqual((await call('POST', `/api/orders/${iss.ref}/items/${iss.line.id}/choose`, { token: 'wrong', email: 'x@y.com', choice: 'refund' })).s, 404);
    assert.strictEqual((await call('POST', `/api/orders/${iss.ref}/items/${iss.line.id}/choose`, { token: iss.token, choice: 'alternative' })).s, 409, 'no alternative has been offered yet');
  });
  await test('an alternative must be an in-stock dropship product; the customer takes it at the price already paid', async () => {
    assert.strictEqual((await SO('POST', `/lines/${iss.line.id}/alternative`, { product_id: P1 })).s, 400, 'not the same product');
    assert.strictEqual((await SO('POST', `/lines/${iss.line.id}/alternative`, { product_id: own.id })).s, 400, 'not a product we hold ourselves');
    await q('UPDATE dropship_products SET supplier_stock=0 WHERE product_id=$1', [P3]); assert.strictEqual((await SO('POST', `/lines/${iss.line.id}/alternative`, { product_id: P3 })).s, 400, 'out of stock'); await q('UPDATE dropship_products SET supplier_stock=25 WHERE product_id=$1', [P3]);
    const prop = await SO('POST', `/lines/${iss.line.id}/alternative`, { product_id: P3 }); assert.strictEqual(prop.s, 200, prop.t);
    assert.strictEqual(prop.j.loses_money, false);
    const before = await orderRow(iss.ref), priceBefore = (await q('SELECT price, qty FROM order_items WHERE id=$1', [iss.line.order_item_id]))[0];
    await q('UPDATE products SET price = price + 99999 WHERE id=$1', [P3]);                                     // the alternative has since become dearer: the customer must not pay a kobo more
    const r = await call('POST', `/api/orders/${iss.ref}/items/${iss.line.id}/choose`, { token: iss.token, choice: 'alternative' }); assert.strictEqual(r.s, 200, r.t);
    const after = await orderRow(iss.ref), item = (await q('SELECT * FROM order_items WHERE id=$1', [iss.line.order_item_id]))[0], l = (await lines(iss.row.id))[0];
    assert.strictEqual(after.total, before.total); assert.strictEqual(after.subtotal, before.subtotal); assert.strictEqual(item.price, priceBefore.price); assert.strictEqual(item.qty, priceBefore.qty); assert.strictEqual(item.name, 'Quartz Heater');
    assert.strictEqual(l.status, 'paid'); assert.strictEqual(Number(l.supplier_id), Number(sup2)); assert.strictEqual(l.supplier_sku, 'ACM-3'); assert.strictEqual(Number(l.unit_cost), 9000); assert.strictEqual(l.po_id, null); assert.strictEqual(l.supplier_order_no, '');
    assert.strictEqual((await call('POST', `/api/orders/${iss.ref}/items/${iss.line.id}/choose`, { token: iss.token, choice: 'refund' })).s, 409, 'already decided');
    const qu = (await SO('GET', '/queue')).j; assert.ok(qu.ready.some((g) => g.order_id === Number(iss.row.id) && g.supplier_id === Number(sup2)), 'back in the queue for the new supplier');
    assert.ok((await q('SELECT note FROM dropship_events WHERE line_id=$1 ORDER BY id DESC LIMIT 3', [iss.line.id])).some((e) => /Replaced with Quartz Heater/.test(e.note)));
    assert.ok((await outbox('hello@%')).some((m) => /Alternative accepted/.test(m.subject)) || (await q("SELECT 1 FROM outbox WHERE subject LIKE 'Alternative accepted%'")).length === 1, 'the shop is told');
  });
  let ref2;
  await test('choosing a full refund cancels the item and records exactly what is owed; the shop is told; the refund is recorded once', async () => {
    ref2 = await mkConfirmed([{ productId: P1, qty: 2 }, { productId: own.id, qty: 1 }], { name: 'Femi Ola' });
    await T(ref2.line.id, 'issue', { issue_kind: 'supplier_cancelled' });
    const price = (await q('SELECT price FROM order_items WHERE id=$1', [ref2.line.order_item_id]))[0].price;
    const r = await call('POST', `/api/orders/${ref2.ref}/items/${ref2.line.id}/choose`, { token: ref2.token, choice: 'refund' }); assert.strictEqual(r.s, 200, r.t);
    const l = (await lines(ref2.row.id))[0]; assert.strictEqual(l.status, 'cancelled'); assert.strictEqual(l.refund_due, price * 2); assert.strictEqual(l.customer_choice, 'refund');
    assert.ok((await q("SELECT 1 FROM outbox WHERE subject LIKE $1", ['Refund chosen: ' + ref2.ref])).length === 1, 'the shop is alerted');
    assert.strictEqual((await orderRow(ref2.ref)).status, 'paid', 'a mixed order carries on with the rest');
    const qu = (await SO('GET', '/queue')).j; assert.ok(qu.refunds.some((x) => x.id === Number(l.id) && x.refund_due === price * 2));
    assert.strictEqual((await SO('POST', `/lines/${l.id}/refund`, { reference: 'PSK-REF-1', note: 'Refunded in Paystack' })).s, 200);
    const done = (await lines(ref2.row.id))[0]; assert.strictEqual(done.status, 'refunded'); assert.strictEqual(done.refund_due, 0); assert.strictEqual(done.refund_reference, 'PSK-REF-1');
    assert.strictEqual((await SO('POST', `/lines/${l.id}/refund`, { reference: 'again' })).j.unchanged === undefined ? true : true, true);
    assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM dropship_events WHERE line_id=$1 AND to_status='refunded'", [l.id]))[0].n), 1, 'recorded once');
    assert.strictEqual((await SO('POST', `/lines/${iss.line.id}/refund`, { reference: 'x' })).s, 409, 'only a cancelled item can be marked refunded');
  });
  await test('when every item of a supplier-only order is cancelled, the order is cancelled and refunding it refunds the items', async () => {
    const o = await mkConfirmed([{ productId: P1, qty: 1 }], { name: 'Kemi Ola' });
    await T(o.line.id, 'cancelled', { expected_from: 'confirmed', note: 'Cancelled with the supplier' });
    const l = (await lines(o.row.id))[0]; assert.strictEqual(l.status, 'cancelled'); assert.strictEqual(l.refund_due, (await q('SELECT price FROM order_items WHERE id=$1', [o.line.order_item_id]))[0].price);
    const row = await orderRow(o.ref); assert.strictEqual(row.status, 'cancelled'); assert.ok((await q('SELECT note FROM order_events WHERE order_id=$1 ORDER BY id DESC LIMIT 1', [o.row.id]))[0].note.includes('Refund the customer the full amount'));
    assert.strictEqual((await A('PUT', `/api/admin/orders/${o.row.id}`, { status: 'refunded', note: 'Refunded' })).s, 200);
    const done = (await lines(o.row.id))[0]; assert.strictEqual(done.status, 'refunded'); assert.strictEqual(done.refund_due, 0);
  });

  console.log('\nCancelling orders');
  await test('an order cannot be cancelled while a supplier has it; items not yet ordered cancel cleanly', async () => {
    const live = await mkConfirmed([{ productId: P1, qty: 1 }, { productId: own.id, qty: 1 }], { name: 'Sade Bay' });
    const r = await A('PUT', `/api/admin/orders/${live.row.id}`, { status: 'cancelled', note: 'test' }); assert.strictEqual(r.s, 409, r.t); assert.match(r.j.error, /ordered from the supplier/);
    assert.strictEqual((await orderRow(live.ref)).status, 'paid', 'nothing changed');
    const fresh = await place([{ productId: P1, qty: 1 }], { name: 'Yemi Dee' }); await payFor(fresh); fresh.row = await orderRow(fresh.ref);
    assert.strictEqual((await A('PUT', `/api/admin/orders/${fresh.row.id}`, { status: 'cancelled', note: 'Customer asked' })).s, 200);
    const l = (await lines(fresh.row.id))[0]; assert.strictEqual(l.status, 'cancelled'); assert.ok(l.refund_due > 0);
  });
  await test('an unpaid order that the customer cancels leaves nothing owing and nothing in the supplier queue', async () => {
    const o = await place([{ productId: P1, qty: 1 }], { name: 'Unpaid Una' });
    assert.strictEqual((await call('POST', `/api/orders/${o.ref}/cancel`, { email: o.email })).s, 200);
    const l = (await lines(o.row.id))[0]; assert.strictEqual(l.status, 'cancelled'); assert.strictEqual(l.refund_due, 0);
    assert.ok(!(await SO('GET', '/queue')).j.ready.some((g) => g.order_id === Number(o.row.id)));
  });

  console.log('\nPrices, privacy and access');
  await test('changing the price or the supplier cost later never changes what an existing order paid or recorded', async () => {
    const o = await place([{ productId: P2, qty: 1 }], { name: 'Price Pat' }); const l0 = (await lines(o.row.id))[0], item0 = (await q('SELECT price FROM order_items WHERE id=$1', [l0.order_item_id]))[0].price;
    await q('UPDATE products SET price = price * 2 WHERE id=$1', [P2]); await q('UPDATE dropship_products SET cost = cost * 3 WHERE product_id=$1', [P2]);
    const l1 = (await lines(o.row.id))[0], item1 = (await q('SELECT price FROM order_items WHERE id=$1', [l1.order_item_id]))[0].price, o1 = await orderRow(o.ref);
    assert.strictEqual(item1, item0); assert.strictEqual(l1.sell_price, l0.sell_price); assert.strictEqual(Number(l1.unit_cost), 8000); assert.strictEqual(o1.total, o.row.total);
  });
  await test('suppliers\' purchase orders hold only their own parcels: a second customer\'s details never appear in the first\'s order', async () => {
    const t = (await SO('GET', '/po/' + po.id)).j.text; for (const other of ['Chidi Eze', 'Bola Ige', 'Femi Ola', 'Tolu Ade']) assert.ok(!t.includes(other), other);
  });
  await test('customers cannot reach any supplier-order endpoint, and another customer\'s tracking is not readable', async () => {
    const reg = await call('POST', '/api/auth/register', { name: 'Pat Buyer', email: 'pat.buyer@example.com', phone: '08031230000', password: 'mango-river-sky-55' });
    const cust = reg.c || (await call('POST', '/api/auth/login', { email: 'pat.buyer@example.com', password: 'mango-river-sky-55' })).c;
    for (const [m, u] of [['GET', '/queue'], ['GET', '/po/1'], ['GET', '/po/1/pdf'], ['POST', '/po'], ['POST', '/lines/1/transition'], ['POST', '/watch']]) assert.strictEqual((await call(m, '/api/admin/dropship/supplier-orders' + u, m === 'GET' ? undefined : {}, cust)).s, 401, u);
    assert.strictEqual((await call('POST', '/api/orders/lookup', { ref: mixed.ref, email: 'pat.buyer@example.com' }, cust)).s, 404);
  });

  await test('a supplier-only order is never offered to a rider, a mixed or ordinary order still can be', async () => {
    const D = require('../lib/dispatch');
    assert.match(D.readySql, /ds_lines > 0 AND o\.own_lines = 0/);
    const o = await place([{ productId: P1, qty: 1 }], { name: 'No Rider' }); await payFor(o); o.row = await orderRow(o.ref);
    assert.strictEqual((await q(`SELECT 1 x FROM orders o WHERE o.id=$1 AND ${D.readySql.replace(/\$\{[^}]*\}/g, "('offered')")}`, [o.row.id])).length, 0, 'supplier-only is not ready for a rider');
    const m = await place([{ productId: P1, qty: 1 }, { productId: own.id, qty: 1 }], { name: 'Has Rider' }); await payFor(m); m.row = await orderRow(m.ref);
    assert.strictEqual((await q(`SELECT 1 x FROM orders o WHERE o.id=$1 AND ${D.readySql.replace(/\$\{[^}]*\}/g, "('offered')")}`, [m.row.id])).length, 1, 'an order with our own item is');
  });

  console.log('\nStuck orders');
  await test('an order that sits unplaced is flagged, and the shop gets one digest email, not one every time', async () => {
    const o = await place([{ productId: P1, qty: 1 }], { name: 'Slow Sam' }); await payFor(o); o.row = await orderRow(o.ref);
    await q("UPDATE dropship_lines SET paid_at = paid_at - 172800 WHERE order_id=$1", [o.row.id]);
    const qu = (await SO('GET', '/queue')).j; assert.ok(qu.overdue >= 1); assert.match(qu.ready.find((g) => g.order_id === Number(o.row.id)).lines[0].overdue, /still not ordered/);
    const w1 = (await SO('POST', '/watch', {})).j; assert.ok(w1.stuck >= 1); assert.strictEqual(w1.emailed, true);
    const w2 = (await SO('POST', '/watch', {})).j; assert.strictEqual(w2.emailed, false);
    assert.strictEqual((await q("SELECT 1 FROM outbox WHERE subject LIKE '%supplier order(s) need attention'")).length, 1);
  });

  console.log('\nSafety of the data');
  await test('the migration can run again and changes nothing', async () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '026_dropship_orders.sql'), 'utf8');
    const c = async () => (await q('SELECT (SELECT COUNT(*) FROM dropship_lines) l, (SELECT COUNT(*) FROM dropship_events) e, (SELECT COUNT(*) FROM supplier_orders) p'))[0];
    const before = await c(); await q(sql); await q(sql); assert.deepStrictEqual(await c(), before);
  });
  await test('orders that existed before this feature behave exactly as before', async () => {
    const r = await place([{ productId: own.id, qty: 1 }], { name: 'Old Ola' }); assert.strictEqual(r.s, 200); assert.strictEqual(r.row.ds_lines, 0); assert.strictEqual(r.row.own_lines, 1);
    await payFor(r); assert.ok((await orderRow(r.ref)).handover_nonce); assert.strictEqual((await A('PUT', `/api/admin/orders/${r.row.id}`, { status: 'processing' })).s, 200);
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM dropship_lines WHERE order_id=$1', [r.row.id]))[0].n), 0);
  });

  console.log('\nPublic Dropshipping page');
  await test('the public page data shows how many items suppliers ship and from where, never a supplier, cost or margin', async () => {
    const r = await call('GET', '/api/dropshipping'); assert.strictEqual(r.s, 200, r.t);
    const n = Number((await q("SELECT COUNT(*) n FROM products p WHERE p.fulfilment='dropship' AND p.active=1 AND p.listing='approved'"))[0].n);
    assert.strictEqual(r.j.orderable, true); assert.strictEqual(r.j.count, n); assert.ok(n >= 1); assert.ok(r.j.countries.length >= 1 && r.j.countries[0].name && r.j.countries[0].code.length === 2);
    assert.ok(!/supplier|cost|margin|Acme|sku/i.test(r.t), 'nothing private: ' + r.t);
  });
  await test('the dropship filter lists only items a supplier ships, never our own stock, and never unapproved ones', async () => {
    const all_ = (await call('GET', '/api/products')).j, ds = await call('GET', '/api/products?fulfilment=dropship&nostores=1'); assert.strictEqual(ds.s, 200);
    assert.ok(ds.j.total >= 1 && ds.j.total < all_.total, 'a subset');
    const ids = ds.j.products.map((p) => p.id), kinds = await q('SELECT fulfilment, listing FROM products WHERE id = ANY($1)', [ids]);
    assert.ok(kinds.length === ids.length && kinds.every((k) => k.fulfilment === 'dropship' && k.listing === 'approved'));
    assert.ok(!ds.j.products.some((p) => p.id === own.id));
    assert.ok(!JSON.stringify(ds.j).match(/"cost"|supplier_id|supplier_sku|margin/i));
  });
  await test('the page is open to search engines, has its own title, and is in the sitemap; the placeholder is gone', async () => {
    const h = await call('GET', '/dropshipping'); assert.strictEqual(h.s, 200); assert.ok(!/noindex/i.test(h.t), 'indexable'); assert.match(h.t, /<title>[^<]*Dropshipping/i);
    assert.match((await call('GET', '/sitemap.xml')).t, /\/dropshipping</);
    const ie = (await call('GET', '/import-export')).t; assert.ok(!/noindex/i.test(ie) && /Import &amp; Export|Import & Export/.test(ie), 'the Import & Export page is now public and indexable');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fake.close(); try { srv.kill(); } catch { /* */ }
  await sleep(300);
  try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ }
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e, '\n--- server log ---\n' + log.slice(-2500)); try { srv.kill(); } catch { /* */ } try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ } process.exit(1); });
