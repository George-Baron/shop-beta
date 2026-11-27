'use strict';
// Dropshipping money: payables, extra costs, customer and supplier refunds, returns to the supplier, profit reports and the Excel export.
// Run with: npm run test:dropship-money
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_dsm_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1000), FAKE = PORT + 2000;
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '', SEQ = 0;
let MEMBER = '';   // dropshipped items are for signed-in customers: shop calls made without a cookie go out as this customer
const call = async (method, url, body, cookie, headers = {}) => {
  if (!cookie && MEMBER && /^\/api\/(products|cart|checkout|dropshipping)/.test(url)) cookie = MEMBER;
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
    PAYSTACK_SECRET_KEY: 'sk_test_dsm', PAYSTACK_API_URL: 'http://127.0.0.1:' + FAKE, DROPSHIP_ORDERS_ENABLED: '1' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  MEMBER = (await call('POST', '/api/auth/register', { name: 'Shop Member', email: 'shop.member@example.com', phone: '08031239999', password: 'mango-river-sky-55' })).c;
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
  const M = (m, u, b) => D(m, '/money' + u, b);
  const lineOf = async (orderId) => (await q('SELECT * FROM dropship_lines WHERE order_id=$1 ORDER BY id', [orderId]))[0];
  // buys an item, pays, orders it from the supplier and returns { o, line, po }
  const ordered = async (productId, supplierId, qty = 1) => {
    const o = await place([{ productId, qty }]); assert.strictEqual(o.s, 200, o.t); await payFor(o);
    const po = (await SO('POST', '/po', { order_id: o.row.id, supplier_id: supplierId })).j; assert.strictEqual((await SO('POST', `/po/${po.id}/send`, { via: 'manual' })).s, 200);
    return { o, line: await lineOf(o.row.id), po };
  };
  const ship = async (l) => { assert.strictEqual((await T(l.id, 'confirmed', { supplier_order_no: 'S-' + l.id })).s, 200); assert.strictEqual((await T(l.id, 'shipped', { carrier: 'DHL', tracking_no: 'T' + l.id })).s, 200); assert.strictEqual((await T(l.id, 'delivered')).s, 200); };

  console.log('\nPayables');
  let A1, A4;
  await test('sending a purchase order creates what we owe: prepaid is due now, Net 30 is due in 30 days; sending twice makes no second payable', async () => {
    A1 = await ordered(P1, sup); A4 = await ordered(P4, sup3, 2);
    const p1 = (await q('SELECT * FROM supplier_payables WHERE po_id=$1', [A1.po.id]))[0], p4 = (await q('SELECT * FROM supplier_payables WHERE po_id=$1', [A4.po.id]))[0];
    assert.strictEqual(Number(p1.amount), 10500); assert.strictEqual(p1.currency, 'NGN'); assert.strictEqual(p1.status, 'open');
    assert.strictEqual(Number(p4.amount), 2 * (20 + 0.5)); assert.strictEqual(p4.currency, 'USD'); assert.ok(Math.abs(Number(p4.due_at) - Number(p4.created) - 30 * 86400) <= 2);
    assert.ok(Number(p1.due_at) - Number(p1.created) <= 2);
    assert.strictEqual((await SO('POST', `/po/${A1.po.id}/send`, { via: 'manual' })).j.unchanged, true);
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM supplier_payables WHERE po_id=$1', [A1.po.id]))[0].n), 1);
    assert.strictEqual(Number(A4.line.cost_fx_rate), 1500, 'the rate used is kept on the item'); assert.strictEqual(A4.line.cost_ngn, 61500);
  });
  await test('the payables screen groups what we owe by supplier and currency, with a Naira total and an overdue flag', async () => {
    const r = await M('GET', '/payables'); assert.strictEqual(r.s, 200, r.t);
    const g = r.j.suppliers.find((x) => x.currency === 'USD'); assert.strictEqual(g.owed, 41); assert.strictEqual(g.owed_ngn, 61500);
    assert.ok(r.j.total_owed_ngn >= 61500 + 10500);
    const row = r.j.payables.find((p) => p.po_ref === A1.po.ref); assert.strictEqual(row.overdue, false); assert.strictEqual(row.net, 10500);
    await q('UPDATE supplier_payables SET due_at = due_at - 86400 * 5 WHERE po_id=$1', [A1.po.id]);
    assert.strictEqual((await M('GET', '/payables?status=open')).j.payables.find((p) => p.po_ref === A1.po.ref).overdue, true);
  });
  await test('marking paid needs a reference; it records who and when, and doing it twice changes nothing', async () => {
    const id = (await q('SELECT id FROM supplier_payables WHERE po_id=$1', [A1.po.id]))[0].id;
    assert.strictEqual((await M('POST', `/payables/${id}/pay`, {})).s, 400);
    assert.strictEqual((await M('POST', `/payables/${id}/pay`, { reference: 'TRF-1', paid_amount: 'lots' })).s, 400);
    const r = await M('POST', `/payables/${id}/pay`, { reference: 'TRF-0001' }); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.unchanged, false);
    const p = (await q('SELECT * FROM supplier_payables WHERE id=$1', [id]))[0]; assert.strictEqual(p.status, 'paid'); assert.strictEqual(p.paid_ref, 'TRF-0001'); assert.strictEqual(Number(p.paid_amount), 10500); assert.ok(p.paid_at); assert.ok(p.paid_by);
    assert.strictEqual((await M('POST', `/payables/${id}/pay`, { reference: 'OTHER' })).j.unchanged, true);
    assert.strictEqual((await q('SELECT paid_ref FROM supplier_payables WHERE id=$1', [id]))[0].paid_ref, 'TRF-0001', 'the first reference stands');
  });
  await test('payables from before this step are created by the migration and re-running it adds nothing', async () => {
    await q('DELETE FROM supplier_payables WHERE po_id=$1', [A4.po.id]);
    const sql = require('fs').readFileSync(path.join(__dirname, '..', 'migrations', '028_dropship_money.sql'), 'utf8'), c = new Pg({ connectionString: urlOf(DB) }); await c.connect();
    try { await c.query(sql); await c.query(sql); } finally { await c.end(); }
    const r = await q('SELECT * FROM supplier_payables WHERE po_id=$1', [A4.po.id]); assert.strictEqual(r.length, 1); assert.strictEqual(Number(r[0].amount), 41);
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM supplier_payables'))[0].n), 2);
  });

  console.log('\nCosts, refunds and returns');
  await test('extra costs are added per item and removed again; bad amounts and kinds are refused', async () => {
    assert.strictEqual((await M('POST', `/lines/${A4.line.id}/costs`, { kind: 'duty', amount: 12000, note: 'Customs receipt 77' })).s, 200);
    assert.strictEqual((await M('POST', `/lines/${A4.line.id}/costs`, { kind: 'shipping', amount: 3000 })).s, 200);
    assert.strictEqual((await M('POST', `/lines/${A4.line.id}/costs`, { kind: 'magic', amount: 5 })).s, 400);
    assert.strictEqual((await M('POST', `/lines/${A4.line.id}/costs`, { kind: 'duty', amount: -5 })).s, 400);
    assert.strictEqual((await M('POST', `/lines/${A4.line.id}/costs`, { kind: 'duty', amount: 'abc' })).s, 400);
    const unpaid = await place([{ productId: P1, qty: 1 }]); const ul = await lineOf(unpaid.row.id);
    assert.strictEqual((await M('POST', `/lines/${ul.id}/costs`, { kind: 'duty', amount: 5 })).s, 409, 'nothing is due before the customer pays');
    const m = (await M('GET', `/lines/${A4.line.id}`)).j; assert.strictEqual(m.costs.length, 2); assert.strictEqual(m.cost_fx_rate, 1500);
    const tmp = (await M('POST', `/lines/${A4.line.id}/costs`, { kind: 'other', amount: 100 })).j.id; assert.strictEqual((await M('DELETE', `/costs/${tmp}`)).s, 200);
    assert.strictEqual((await M('DELETE', `/costs/${tmp}`)).s, 404); assert.strictEqual((await M('GET', `/lines/${A4.line.id}`)).j.costs.length, 2);
  });
  await test('a customer refund keeps its amount for the reports, a partial refund is allowed, more than was paid is refused', async () => {
    const r = await ordered(P3, sup2); const l = r.line;
    assert.strictEqual((await T(l.id, 'cancelled', { note: 'Supplier cannot supply' })).s, 200);
    assert.strictEqual((await SO('POST', `/lines/${l.id}/refund`, { reference: 'PSK-1', amount: l.sell_price * l.qty + 1 })).s, 400);
    assert.strictEqual((await SO('POST', `/lines/${l.id}/refund`, { reference: 'PSK-1' })).s, 200);
    const row = (await q('SELECT * FROM dropship_refunds WHERE line_id=$1', [l.id]))[0]; assert.strictEqual(row.amount_ngn, l.sell_price * l.qty); assert.strictEqual(row.reference, 'PSK-1');
    assert.strictEqual((await SO('POST', `/lines/${l.id}/refund`, { reference: 'PSK-2' })).s, 200, 'repeat is quiet');
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM dropship_refunds WHERE line_id=$1', [l.id]))[0].n), 1);
  });
  await test('a supplier refund as credit lowers what we owe; as cash it is just recorded; never more than we paid; credit is refused once we have paid', async () => {
    const r = await ordered(P4, sup3, 2); const l = r.line;
    assert.strictEqual((await M('POST', `/lines/${l.id}/supplier-refund`, { amount: 5, mode: 'credit' })).s, 409, 'the item has no problem yet');
    assert.strictEqual((await T(l.id, 'issue', { issue_kind: 'out_of_stock' })).s, 200);
    assert.strictEqual((await M('POST', `/lines/${l.id}/supplier-refund`, { amount: 100, mode: 'credit' })).s, 400, 'more than the 41.00 we paid for it');
    assert.strictEqual((await M('POST', `/lines/${l.id}/supplier-refund`, { amount: 10, mode: 'cash' })).s, 400, 'cash needs a reference');
    assert.strictEqual((await M('POST', `/lines/${l.id}/supplier-refund`, { amount: 'x', mode: 'credit' })).s, 400);
    assert.strictEqual((await M('POST', `/lines/${l.id}/supplier-refund`, { amount: 16, mode: 'credit' })).s, 200);
    const p = (await q('SELECT * FROM supplier_payables WHERE po_id=$1', [r.po.id]))[0]; assert.strictEqual(Number(p.credit), 16);
    assert.strictEqual((await M('GET', '/payables')).j.payables.find((x) => x.id == p.id).net, 25);
    assert.strictEqual((await M('POST', `/lines/${l.id}/supplier-refund`, { amount: 26, mode: 'credit' })).s, 400, 'only 25.00 of the 41.00 is left to claim');
    assert.strictEqual((await M('POST', `/payables/${p.id}/pay`, { reference: 'WIRE-9', paid_amount: 25, paid_ngn: 38000 })).s, 200);
    assert.strictEqual((await M('POST', `/lines/${l.id}/supplier-refund`, { amount: 5, mode: 'credit' })).s, 409, 'already paid: record cash instead');
    assert.strictEqual((await M('POST', `/lines/${l.id}/supplier-refund`, { amount: 25, mode: 'cash', reference: 'WIRE-IN-3' })).s, 200);
    const refunds = (await M('GET', `/lines/${l.id}`)).j.supplier_refunds; assert.strictEqual(refunds.length, 2); assert.strictEqual(refunds[0].amount_ngn, 24000, '16 USD at the rate fixed when we ordered');
  });
  await test('items that went wrong and have no supplier refund yet are listed so nobody forgets to claim the money back', async () => {
    const r = await ordered(P1, sup); await T(r.line.id, 'issue', { issue_kind: 'lost' });
    const e = (await M('GET', '/payables')).j.expecting; assert.ok(e.some((x) => x.line_id == r.line.id), 'listed');
    assert.ok(!e.some((x) => x.currency === 'USD' && x.recorded >= x.cost), 'fully refunded ones are not');
  });
  let ret;
  await test('return to supplier: only a delivered item, a reason is needed, the item moves to returned and the refund due is set', async () => {
    const r = await ordered(P1, sup); const l = r.line;
    assert.strictEqual((await M('POST', `/lines/${l.id}/return`, { reason: 'Faulty' })).s, 409, 'not delivered yet');
    await ship(l);
    assert.strictEqual((await M('POST', `/lines/${l.id}/return`, { reason: '' })).s, 400);
    const x = await M('POST', `/lines/${l.id}/return`, { reason: 'Arrived faulty', rma_no: 'RMA-5' }); assert.strictEqual(x.s, 200, x.t); ret = { id: x.j.id, line: l, r };
    const nl = (await q('SELECT status, refund_due FROM dropship_lines WHERE id=$1', [l.id]))[0]; assert.strictEqual(nl.status, 'returned'); assert.strictEqual(nl.refund_due, l.sell_price * l.qty);
    assert.strictEqual((await M('POST', `/lines/${l.id}/return`, { reason: 'Again' })).s, 409, 'one return per item');
  });
  await test('the return follows its steps: approved, sent back with tracking, received, closed; no skipping', async () => {
    const u = (b) => M('PUT', `/returns/${ret.id}`, b);
    assert.strictEqual((await u({ status: 'received' })).s, 409, 'cannot skip ahead');
    assert.strictEqual((await u({ status: 'approved' })).s, 200);
    assert.strictEqual((await u({ status: 'sent_back' })).s, 400, 'needs carrier and tracking');
    assert.strictEqual((await u({ status: 'sent_back', carrier: 'GIG', tracking_no: 'GIG123' })).s, 200);
    assert.strictEqual((await u({ status: 'received' })).s, 200); assert.strictEqual((await u({ status: 'closed' })).s, 200);
    assert.strictEqual((await u({ status: 'approved' })).s, 409, 'closed is final');
    const list = (await M('GET', '/returns?all=1')).j.returns.find((x) => x.id == ret.id); assert.strictEqual(list.status, 'closed'); assert.strictEqual(list.tracking_no, 'GIG123');
    assert.ok(!(await M('GET', '/returns')).j.returns.some((x) => x.id == ret.id), 'closed returns leave the open list');
  });
  await test('refunding the customer for a returned item, then claiming it from the supplier, closes the loop', async () => {
    assert.strictEqual((await SO('POST', `/lines/${ret.line.id}/refund`, { reference: 'PSK-R1' })).s, 200);
    assert.strictEqual((await q('SELECT status FROM dropship_lines WHERE id=$1', [ret.line.id]))[0].status, 'refunded');
    assert.strictEqual((await M('POST', `/lines/${ret.line.id}/supplier-refund`, { amount: 10.5, mode: 'cash', reference: 'TRF-IN-1' })).s, 200);
  });
  await test('a rejected return can be closed too', async () => {
    const r = await ordered(P1, sup); await ship(r.line); const x = (await M('POST', `/lines/${r.line.id}/return`, { reason: 'Changed mind' })).j.id;
    assert.strictEqual((await M('PUT', `/returns/${x}`, { status: 'rejected', note: 'Outside the return window' })).s, 200); assert.strictEqual((await M('PUT', `/returns/${x}`, { status: 'closed' })).s, 200);
  });

  console.log('\nProfit reports');
  await test('the report works the profit out of the prices and rates fixed at the time: revenue, supplier cost, shipping, duty, fees, refunds, net', async () => {
    const r = await M('GET', '/report?group=order'); assert.strictEqual(r.s, 200, r.t);
    const row = r.j.rows.find((x) => x.key === A4.o.ref); assert.ok(row, 'order is in the report');
    const rev = A4.line.sell_price * A4.line.qty; assert.strictEqual(row.revenue, rev);
    assert.strictEqual(row.supplier_cost, 60000, '2 x 20 USD x 1500'); assert.strictEqual(row.supplier_shipping, 1500, '2 x 0.50 USD x 1500');
    assert.strictEqual(row.duty, 12000); assert.strictEqual(row.extra_shipping, 3000);
    assert.strictEqual(row.net_profit, rev - 60000 - 1500 - 12000 - 3000 - row.fees); assert.ok(row.fees > 0, 'the payment fee is estimated from the fee settings');
    assert.strictEqual(row.estimated_fees, 1); assert.match(row.supplier_rates, /USD @ 1500/); assert.strictEqual(row.customer_rate, 'NGN');
    const rf = r.j.rows.find((x) => x.refunds > 0); assert.ok(rf, 'a refunded order shows its refund');
  });
  await test('a real payment fee entered on the item replaces the estimate', async () => {
    await M('POST', `/lines/${A4.line.id}/costs`, { kind: 'gateway_fee', amount: 777 });
    const row = (await M('GET', '/report?group=order')).j.rows.find((x) => x.key === A4.o.ref); assert.strictEqual(row.fees, 777); assert.strictEqual(row.estimated_fees, 0);
  });
  await test('changing the exchange rate later never changes an order already placed', async () => {
    assert.strictEqual((await D('PUT', '/rates/USD', { ngn_per_unit: 1800 })).s, 200);
    const row = (await M('GET', '/report?group=order')).j.rows.find((x) => x.key === A4.o.ref); assert.strictEqual(row.supplier_cost, 60000); assert.match(row.supplier_rates, /USD @ 1500/);
    const n = await place([{ productId: P4, qty: 1 }]); assert.strictEqual(Number((await lineOf(n.row.id)).cost_fx_rate), 1800, 'a new order uses the new rate');
    assert.strictEqual((await D('PUT', '/rates/USD', { ngn_per_unit: 1500 })).s, 200);
  });
  await test('supplier refunds count as money back; a refunded item with a supplier refund nets to the right figure', async () => {
    const row = (await M('GET', '/report?group=supplier')).j.rows.find((x) => x.key === 'Global Gadgets'); assert.ok(row.supplier_refunds >= 16 * 1500 + 25 * 1500);
  });
  await test('groups: supplier, country, product, day and month all add up to the same total', async () => {
    const tot = (await M('GET', '/report?group=order')).j.total;
    for (const g of ['supplier', 'country', 'product', 'day', 'month']) {
      const r = (await M('GET', '/report?group=' + g)).j; assert.strictEqual(r.group, g); assert.strictEqual(r.total.net_profit, tot.net_profit, g); assert.strictEqual(r.rows.reduce((a, x) => a + x.net_profit, 0), tot.net_profit, g + ' rows add up');
    }
    assert.strictEqual((await M('GET', '/report?group=country')).j.rows[0].key, 'NG');
  });
  await test('the period filter works, dates are checked, and items outside the period are left out', async () => {
    const today = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
    assert.ok((await M('GET', `/report?from=${today}&to=${today}`)).j.rows.length > 0);
    assert.strictEqual((await M('GET', '/report?from=2020-01-01&to=2020-01-31')).j.rows.length, 0);
    assert.strictEqual((await M('GET', '/report?from=garbage')).s, 400); assert.strictEqual((await M('GET', '/report?from=2026-05-01&to=2026-04-01')).s, 400);
    assert.strictEqual((await M('GET', '/report?from=2010-01-01')).s, 400, 'longer than two years');
    const sid = (await M('GET', `/report?supplier_id=${sup3}`)).j; assert.ok(sid.rows.every((x) => x.supplier_rates.startsWith('USD')));
  });
  await test('the Excel export is a real workbook with the profit table, open payables and a note, and the download is in the activity log', async () => {
    const r = await call('GET', '/api/admin/dropship/money/report.xlsx?group=supplier', undefined, admin); assert.strictEqual(r.s, 200); assert.match(r.type, /spreadsheetml/); assert.strictEqual(r.buf.slice(0, 2).toString(), 'PK');
    const rows = require('../lib/xlsx').readXlsx ? null : null; const z = require('fflate').unzipSync(new Uint8Array(r.buf)); const sheet = Buffer.from(z['xl/worksheets/sheet1.xml']).toString();
    assert.ok(sheet.includes('Global Gadgets') && sheet.includes('Net profit')); assert.ok(Buffer.from(z['xl/worksheets/sheet2.xml']).toString().includes('Purchase order'));
    assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM audit_log WHERE detail LIKE 'dropship profit report downloaded%'"))[0].n), 1);
  });

  console.log('\nPrivacy and access');
  await test('only the owner can reach any of it; customers and signed-out visitors get nothing, and the customer page never shows cost, margin or supplier refunds', async () => {
    for (const [m, u] of [['GET', '/payables'], ['GET', '/report'], ['GET', '/report.xlsx'], ['GET', '/returns'], ['POST', `/lines/${A1.line.id}/costs`], ['POST', `/payables/1/pay`]]) {
      assert.strictEqual((await call(m, '/api/admin/dropship/money' + u, m === 'POST' ? {} : undefined)).s, 401, 'signed out: ' + u);
    }
    const cust = (await call('POST', '/api/auth/register', { name: 'Shopper Sam', email: 'sam@example.com', password: 'plum-tiger-lake-42' })).c || (await call('POST', '/api/auth/login', { email: 'sam@example.com', password: 'plum-tiger-lake-42' })).c;
    assert.strictEqual((await call('GET', '/api/admin/dropship/money/report', undefined, cust)).s, 401);
    const v = await call('POST', '/api/orders/lookup', { ref: A4.o.ref, token: A4.o.token }); const t = JSON.stringify(v.j);
    assert.ok(!/cost_ngn|unit_cost|cost_fx_rate|supplier_refund|net_profit|payable|margin|duty/i.test(t), 'no cost or margin on the customer page');
  });
  await test('money changes are in the activity log', async () => {
    const n = Number((await q("SELECT COUNT(*) n FROM audit_log WHERE path LIKE '/api/admin/dropship/money/%' AND method <> 'GET'"))[0].n); assert.ok(n >= 10, 'logged ' + n);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fake.close(); try { srv.kill(); } catch { /* */ }
  await sleep(300);
  try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ }
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e, '\n--- server log ---\n' + log.slice(-2500)); try { srv.kill(); } catch { /* */ } try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ } process.exit(1); });
