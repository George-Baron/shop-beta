'use strict';
// Wholesale orders: order numbers, final invoices, pick / pack / dispatch / deliver, reports.
// Run with: npm run test:fulfilment   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_ful_' + tag;
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
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-ful-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, '/api/admin/warehouse' + u, b, admin);
  const W = (m, u, b) => call(m, '/api/admin/wholesale' + u, b, admin);
  const O = (ref, m, u, b, c) => call(m, '/api/admin/warehouse/orders/' + ref + u, b, c || admin);
  const ST = (m, u, b) => call(m, '/api/admin/staff' + u, b, admin);
  const appBody = (o = {}) => ({ business_name: 'Ada Provisions Ltd', contact_name: 'Ada Obi', phone: '08031234567', address: '5 Trade Fair Road', state: 'Lagos', city: 'Ojo', reg_no: 'RC445566', business_type: 'Retailer', buys: 'Rice and beans for my shops', est_monthly: '₦2m', ...o });
  const [P1, P2] = await q("SELECT id, name, price FROM products WHERE vendor_id IS NULL AND is_pharmacy=0 AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id=products.id) AND stock >= 30 ORDER BY id LIMIT 2");
  assert.ok(P1 && P2);
  assert.strictEqual((await A('POST', '/stock/receipt', { items: [{ productId: P1.id, qty: 400 }, { productId: P2.id, qty: 200 }], opening: true })).s, 200);
  assert.strictEqual((await W('PUT', `/products/${P1.id}`, { wholesale_price: Math.floor(P1.price * 0.7), wholesale_min_qty: 5 })).s, 200);
  assert.strictEqual((await W('PUT', `/products/${P2.id}`, { wholesale_price: Math.floor(P2.price * 0.8), wholesale_min_qty: 3 })).s, 200);
  const bal = async (id) => { const r = (await q('SELECT on_hand, reserved FROM wholesale_stock_balances WHERE product_id=$1', [id]))[0]; return { on_hand: Number(r.on_hand), reserved: Number(r.reserved) }; };
  const buyers = {};
  const mkBuyer = async (key) => {
    await call('POST', '/api/auth/register', { name: key + ' Buyer', email: key + '@example.com', phone: '0803000' + String(Math.floor(1000 + Math.random() * 8999)), password: PW });
    const c = await login(key + '@example.com', PW);
    assert.strictEqual((await call('POST', '/api/wholesale/apply', appBody({ business_name: key + ' Trading Ltd' }), c)).s, 200);
    const acc = (await W('GET', '/accounts')).j.accounts.find((a) => a.business_name === key + ' Trading Ltd');
    assert.strictEqual((await W('POST', `/accounts/${acc.id}/approve`, { early: true })).s, 200);
    return (buyers[key] = { c, id: acc.id });
  };
  const mkOrder = async (b, { pay = true, qty1 = 10, qty2 = 4 } = {}) => {
    const r = await call('POST', '/api/wholesale/quotes', { items: [{ productId: P1.id, qty: qty1 }, { productId: P2.id, qty: qty2 }], ship_name: 'Store manager', ship_phone: '08035550000', ship_address: '5 Trade Fair Road', ship_city: 'Ojo', ship_state: 'Lagos' }, b.c);
    assert.strictEqual(r.s, 200, r.t); const ref = r.j.ref;
    assert.strictEqual((await W('POST', `/quotes/${ref}/send`, { logistics_fee: 15000, service_pct: 3, valid_days: 7, shipment_plan: 'Our truck from Lagos' })).s, 200);
    assert.strictEqual((await call('POST', `/api/wholesale/quotes/${ref}/accept`, {}, b.c)).s, 200);
    if (pay) { await call('POST', `/api/wholesale/quotes/${ref}/pay`, {}, b.c); assert.strictEqual((await call('POST', `/api/wholesale/quotes/${ref}/pay/demo`, {}, b.c)).s, 200); }
    return ref;
  };
  const myQuote = async (b, ref) => (await call('GET', '/api/wholesale/quotes/' + ref, undefined, b.c)).j.quote;
  const walk = async (ref, c) => {                                   // pick everything and pack
    assert.strictEqual((await O(ref, 'POST', '/start', {}, c)).s, 200);
    const lines = (await O(ref, 'GET', '', undefined, c)).j.order.lines;
    assert.strictEqual((await O(ref, 'POST', '/pick', { lines: lines.map((l) => ({ id: l.id, qty_picked: l.qty })) }, c)).s, 200);
    assert.strictEqual((await O(ref, 'POST', '/picked', {}, c)).s, 200);
    assert.strictEqual((await O(ref, 'POST', '/pack', { packages: 3, note: '2 cartons, 1 bag' }, c)).s, 200);
  };
  let ada, bola, refA, refB, refUnpaid;

  console.log('\nOrder numbers and final invoices');
  await test('paying a quote makes it an order with an order number and a final invoice; an unpaid quote has neither', async () => {
    ada = await mkBuyer('ada'); bola = await mkBuyer('bola');
    refUnpaid = await mkOrder(ada, { pay: false });
    const u = await myQuote(ada, refUnpaid); assert.strictEqual(u.order_no, null); assert.strictEqual(u.invoice_no, null);
    assert.strictEqual((await call('GET', `/api/wholesale/quotes/${refUnpaid}/invoice`, undefined, ada.c)).s, 404, 'no invoice before payment');
    refA = await mkOrder(ada); refB = await mkOrder(bola);
    const a = await myQuote(ada, refA), b = await myQuote(bola, refB);
    assert.match(a.order_no, /^ORD-\d{4}-\d{6}$/); assert.match(a.invoice_no, /^INV-\d{4}-\d{6}$/);
    const num = (x) => Number(x.slice(-6));
    assert.strictEqual(num(b.order_no), num(a.order_no) + 1, 'order numbers run one after another'); assert.strictEqual(num(b.invoice_no), num(a.invoice_no) + 1);
    assert.strictEqual(a.fulfilment.stage, 'to_pick'); assert.strictEqual(a.fulfilment.label, 'We are preparing your order');
  });
  await test('paying again does not issue another number or invoice', async () => {
    const before = await myQuote(ada, refA);
    await call('POST', `/api/wholesale/quotes/${refA}/pay/demo`, {}, ada.c);
    const after = await myQuote(ada, refA); assert.strictEqual(after.order_no, before.order_no); assert.strictEqual(after.invoice_no, before.invoice_no);
    assert.strictEqual((await q('SELECT COUNT(*)::int AS n FROM wholesale_invoices WHERE order_no=$1', [before.order_no]))[0].n, 1);
  });
  await test('the final invoice is a frozen copy: it carries the paid amounts and does not change when prices change later', async () => {
    const inv = (await call('GET', `/api/wholesale/quotes/${refA}/invoice`, undefined, ada.c)).j.invoice, quote = await myQuote(ada, refA);
    assert.strictEqual(inv.lines.length, 2); assert.strictEqual(inv.total, quote.total); assert.strictEqual(inv.goods_total, quote.goods_total); assert.strictEqual(inv.logistics_fee, 15000); assert.strictEqual(inv.service_fee, quote.service_fee);
    assert.strictEqual(inv.payment.status, 'PAID'); assert.strictEqual(inv.order_no, quote.order_no); assert.ok(inv.seller.name); assert.strictEqual(inv.buyer.business, 'ada Trading Ltd'); assert.match(inv.deliver_to.address, /Trade Fair/);
    assert.strictEqual(inv.lines.reduce((t, l) => t + l.line_total, 0), inv.goods_total);
    await q('UPDATE products SET wholesale_price=1 WHERE id IN ($1,$2)', [P1.id, P2.id]);
    const again = (await call('GET', `/api/wholesale/quotes/${refA}/invoice`, undefined, ada.c)).j.invoice; assert.deepStrictEqual(again, inv);
    await q('UPDATE products SET wholesale_price=floor(price*0.7), wholesale_min_qty=5 WHERE id=$1', [P1.id]); await q('UPDATE products SET wholesale_price=floor(price*0.8), wholesale_min_qty=3 WHERE id=$1', [P2.id]);
  });
  await test('a buyer can read only their own invoice; staff can read it from the warehouse screen', async () => {
    assert.strictEqual((await call('GET', `/api/wholesale/quotes/${refA}/invoice`, undefined, bola.c)).s, 404);
    assert.strictEqual((await call('GET', `/api/wholesale/quotes/${refA}/invoice`)).s, 401);
    assert.strictEqual((await A('GET', '/invoices/' + refA)).s, 200); assert.strictEqual((await A('GET', '/invoices/' + refUnpaid)).s, 404);
  });
  await test('an order paid before order numbers existed gets its number, invoice and warehouse record the first time it is opened', async () => {
    const old = await mkBuyer('olga'), ref = await mkOrder(old);
    const f = (await q('SELECT f.id FROM wholesale_fulfilments f JOIN wholesale_quotes q ON q.id=f.quote_id WHERE q.ref=$1', [ref]))[0].id;
    await q('DELETE FROM wholesale_fulfilments WHERE id=$1', [f]); await q('DELETE FROM wholesale_invoices WHERE quote_id=(SELECT id FROM wholesale_quotes WHERE ref=$1)', [ref]); await q('UPDATE wholesale_quotes SET order_no=NULL, invoice_no=NULL WHERE ref=$1', [ref]);
    const got = await myQuote(old, ref); assert.match(got.order_no, /^ORD-/); assert.match(got.invoice_no, /^INV-/); assert.strictEqual(got.fulfilment.stage, 'to_pick');
    assert.strictEqual((await call('GET', `/api/wholesale/quotes/${ref}/invoice`, undefined, old.c)).s, 200);
    assert.ok((await O(ref, 'GET', '')).j.order.lines.length === 2);
  });

  console.log('\nPicking, packing, dispatch and delivery');
  let stockBefore;
  await test('the order appears in the warehouse list; nothing can be skipped', async () => {
    const l = (await A('GET', '/orders')).j; const row = l.orders.find((o) => o.ref === refA); assert.ok(row); assert.strictEqual(row.stage, 'to_pick'); assert.strictEqual(row.units, 14); assert.ok(l.counts.to_pick >= 2);
    assert.strictEqual((await O(refA, 'POST', '/picked')).s, 409, 'cannot finish picking before starting');
    assert.strictEqual((await O(refA, 'POST', '/pack', { packages: 1 })).s, 409);
    assert.strictEqual((await O(refA, 'POST', '/dispatch', { carrier: 'Our truck' })).s, 409, 'cannot dispatch an unpacked order');
    assert.strictEqual((await W('POST', `/quotes/${refA}/ship`, { carrier: 'Our truck' })).s, 409, 'the old ship button cannot skip the warehouse either');
  });
  await test('picking: quantities are checked, a short pick blocks "picked", and starting twice is refused', async () => {
    stockBefore = await bal(P1.id);
    assert.strictEqual((await O(refA, 'POST', '/start')).s, 200); assert.strictEqual((await O(refA, 'POST', '/start')).s, 409);
    const lines = (await O(refA, 'GET', '')).j.order.lines; assert.strictEqual(lines.length, 2);
    assert.strictEqual((await O(refA, 'POST', '/pick', { lines: [{ id: lines[0].id, qty_picked: 9999 }] })).s, 400, 'more than ordered');
    assert.strictEqual((await O(refA, 'POST', '/pick', { lines: [{ id: lines[0].id, qty_picked: -1 }] })).s, 400);
    assert.strictEqual((await O(refA, 'POST', '/pick', { lines: [{ id: 999999, qty_picked: 1 }] })).s, 400, 'a line from another order');
    assert.strictEqual((await O(refA, 'POST', '/pick', { lines: [{ id: lines[0].id, qty_picked: 3, short_note: 'only 3 on the shelf' }] })).s, 200);
    const r = await O(refA, 'POST', '/picked'); assert.strictEqual(r.s, 409); assert.ok(r.j.error.includes(lines[0].name), r.j.error);
    assert.strictEqual((await O(refA, 'POST', '/pick', { lines: lines.map((l) => ({ id: l.id, qty_picked: l.qty })) })).s, 200);
    assert.strictEqual((await O(refA, 'POST', '/picked')).s, 200);
  });
  await test('packing needs a package count; a step can be taken back; stock is not deducted until dispatch', async () => {
    assert.strictEqual((await O(refA, 'POST', '/pack', { packages: 0 })).s, 400);
    assert.strictEqual((await O(refA, 'POST', '/undo')).s, 200); assert.strictEqual((await O(refA, 'GET', '')).j.order.stage, 'picking');
    assert.strictEqual((await O(refA, 'POST', '/picked')).s, 200);
    const p = await O(refA, 'POST', '/pack', { packages: 3, note: '2 cartons, 1 bag' }); assert.strictEqual(p.s, 200); assert.strictEqual(p.j.order.stage, 'packed'); assert.strictEqual(p.j.order.packages, 3); assert.strictEqual(p.j.order.packer, 'Store owner');
    assert.deepStrictEqual(await bal(P1.id), stockBefore, 'picking and packing do not move stock');
  });
  await test('dispatch records the carrier and driver, deducts the warehouse stock once, and the buyer sees it', async () => {
    assert.strictEqual((await O(refA, 'POST', '/dispatch', {})).s, 400, 'carrier required');
    const d = await O(refA, 'POST', '/dispatch', { carrier: 'Our truck', tracking: 'TRK-77', driver_name: 'Musa Bello', driver_phone: '08031112222', vehicle_no: 'LND-123XY', expected_note: 'Tomorrow before 2pm' });
    assert.strictEqual(d.s, 200, d.t); assert.strictEqual(d.j.order.stage, 'dispatched'); assert.strictEqual(d.j.order.status, 'shipped');
    assert.strictEqual((await O(refA, 'POST', '/dispatch', { carrier: 'Our truck' })).s, 409, 'cannot dispatch twice');
    const after = await bal(P1.id); assert.strictEqual(after.on_hand, stockBefore.on_hand - 10); assert.strictEqual(after.reserved, stockBefore.reserved - 10);
    const mv = (await A('GET', '/movements?related=' + refA)).j.movements.filter((m) => m.type === 'dispatch'); assert.strictEqual(mv.length, 2, 'one dispatch movement per product line');
    const bq = await myQuote(ada, refA); assert.strictEqual(bq.status, 'shipped'); assert.strictEqual(bq.fulfilment.label, 'On its way to you'); assert.strictEqual(bq.fulfilment.driver_name, 'Musa Bello'); assert.strictEqual(bq.fulfilment.vehicle_no, 'LND-123XY');
  });
  await test('a failed delivery attempt is recorded, the buyer is told, and the order stays on its way', async () => {
    assert.strictEqual((await O(refA, 'POST', '/failed', {})).s, 400, 'a reason is required');
    assert.strictEqual((await O(refA, 'POST', '/failed', { reason: 'Shop was closed' })).s, 200);
    const d = (await O(refA, 'GET', '')).j.order; assert.strictEqual(d.failed_attempts, 1); assert.strictEqual(d.stage, 'dispatched');
    const bq = await myQuote(ada, refA); assert.ok(bq.events.some((e) => /did not succeed.*Shop was closed/.test(e.note))); assert.strictEqual(bq.fulfilment.failed_attempts, 1);
    assert.ok((await q("SELECT 1 FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.email='ada@example.com' AND n.title LIKE '%did not succeed%'")).length === 1);
  });
  await test('delivery needs the name of the person who received the goods, and only happens once', async () => {
    assert.strictEqual((await O(refA, 'POST', '/delivered', {})).s, 400);
    const d = await O(refA, 'POST', '/delivered', { received_by: 'Mrs Eze', note: 'Counted and signed' }); assert.strictEqual(d.s, 200, d.t);
    assert.strictEqual(d.j.order.stage, 'delivered'); assert.strictEqual(d.j.order.received_by, 'Mrs Eze'); assert.strictEqual(d.j.order.status, 'delivered');
    assert.strictEqual((await O(refA, 'POST', '/delivered', { received_by: 'X' })).s, 409);
    const bq = await myQuote(ada, refA); assert.strictEqual(bq.fulfilment.received_by, 'Mrs Eze'); assert.ok(bq.delivered_at);
    const trail = (await O(refA, 'GET', '')).j.order.events.map((e) => e.stage); assert.deepStrictEqual(trail.filter((x, i) => trail.indexOf(x) === i), ['to_pick', 'picking', 'picked', 'packed', 'dispatched', 'delivered']);
  });
  await test('two people starting the same order at once: exactly one succeeds', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => O(refB, 'POST', '/start'))); assert.deepStrictEqual(rs.map((r) => r.s).sort(), [200, 409, 409]);
  });
  await test('cancelling a paid order before dispatch returns the goods and removes it from the work list', async () => {
    const b2 = await mkBuyer('cara'), ref = await mkOrder(b2); const before = await bal(P1.id);
    assert.strictEqual((await W('POST', `/quotes/${ref}/cancel`, { reason: 'Buyer changed their mind' })).s, 200);
    assert.strictEqual((await bal(P1.id)).reserved, before.reserved - 10);
    assert.ok(!(await A('GET', '/orders')).j.orders.some((o) => o.ref === ref)); assert.strictEqual((await O(ref, 'POST', '/start')).s, 404);
  });

  console.log('\nWho may do what');
  let disp, inv, sales;
  await test('dispatch officers send goods out but do not pick; inventory officers pick and pack; sales reps see nothing here', async () => {
    const roleId = async (n) => (await ST('GET', '')).j.roles.find((r) => r.name === n).id;
    const mk = async (key, role) => { const r = await ST('POST', '', { name: key + ' Staff', email: key + '@example.com', password: PW, role_id: await roleId(role) }); assert.strictEqual(r.s, 200, r.t); return login(key + '@example.com', PW); };
    disp = await mk('dispatchx', 'Dispatch Officer'); inv = await mk('invx', 'Inventory Officer'); sales = await mk('salesx', 'Sales Representative');
    const c1 = await mkBuyer('dora'), refC = await mkOrder(c1), c2 = await mkBuyer('emeka'), refD = await mkOrder(c2);
    assert.strictEqual((await call('GET', '/api/admin/warehouse/orders', undefined, disp)).s, 200, 'can look');
    assert.strictEqual((await O(refC, 'POST', '/start', {}, disp)).s, 403, 'dispatch cannot pick'); assert.strictEqual((await O(refC, 'POST', '/pack', { packages: 1 }, disp)).s, 403);
    assert.strictEqual((await call('GET', '/api/admin/warehouse/orders', undefined, sales)).s, 403);
    await walk(refC, inv);                                                                      // inventory officer picks and packs
    assert.strictEqual((await O(refC, 'POST', '/dispatch', { carrier: 'GIG Logistics', tracking: 'G-1' }, disp)).s, 200, 'dispatch officer sends it out');
    assert.strictEqual((await O(refC, 'POST', '/delivered', { received_by: 'Store clerk' }, disp)).s, 200);
    assert.strictEqual((await O(refD, 'POST', '/dispatch', { carrier: 'x' }, sales)).s, 403);
    assert.strictEqual((await call('GET', '/api/admin/warehouse/orders', undefined, undefined)).s, 401);
  });
  await test('the right people are told: the buyer when paid, warehouse staff when there is something to pick', async () => {
    assert.ok((await q("SELECT 1 FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.email='ada@example.com' AND n.title LIKE 'Payment received: order ORD-%'")).length >= 1);
    assert.ok((await q("SELECT 1 FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.email='invx@example.com' AND n.title LIKE 'New order to pick: ORD-%'")).length >= 1);
    assert.ok((await q("SELECT 1 FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.email='salesx@example.com' AND n.title LIKE 'New order to pick%'")).length === 0, 'people without warehouse access are not told');
  });

  console.log('\nReports');
  await test('every report answers in the same shape; money reports need the reports or finance permission', async () => {
    const list = (await A('GET', '/reports')).j.reports; assert.ok(list.length >= 8);
    for (const r of list) { const x = await A('GET', '/reports/' + r.name); assert.strictEqual(x.s, 200, r.name + ' ' + x.t); const rep = x.j.report; assert.ok(Array.isArray(rep.summary) && Array.isArray(rep.columns) && Array.isArray(rep.rows) && rep.title, r.name); for (const c of rep.columns) assert.ok(c.key && c.label && c.type); }
    assert.strictEqual((await call('GET', '/api/admin/warehouse/reports/stock', undefined, disp)).s, 200);
    for (const n of ['sales', 'buyers', 'invoices', 'receivables']) assert.strictEqual((await call('GET', '/api/admin/warehouse/reports/' + n, undefined, disp)).s, 403, n + ' is a money report');
    assert.strictEqual((await call('GET', '/api/admin/warehouse/reports/stock', undefined, sales)).s, 403);
    assert.strictEqual((await A('GET', '/reports/nothing')).s, 404); assert.strictEqual((await A('GET', '/reports/__proto__')).s, 404);
  });
  await test('stock, sales and invoice reports add up to what is really in the database', async () => {
    const st = (await A('GET', '/reports/stock')).j.report; const dbUnits = Number((await q('SELECT SUM(on_hand) AS n FROM wholesale_stock_balances'))[0].n);
    assert.strictEqual(st.summary.find((s) => s.label === 'Units on hand').value, dbUnits);
    const dbTotal = Number((await q("SELECT COALESCE(SUM(total),0) AS n FROM wholesale_quotes WHERE order_no IS NOT NULL AND status IN ('paid','shipped','delivered')"))[0].n), dbOrders = Number((await q("SELECT COUNT(*) AS n FROM wholesale_quotes WHERE order_no IS NOT NULL AND status IN ('paid','shipped','delivered')"))[0].n);
    const sales_ = (await A('GET', '/reports/sales')).j.report; assert.strictEqual(sales_.summary.find((s) => s.label === 'Total received').value, dbTotal); assert.strictEqual(sales_.summary.find((s) => s.label === 'Paid orders').value, dbOrders);
    assert.strictEqual(sales_.rows.reduce((t, r) => t + r.revenue, 0), Number((await q("SELECT COALESCE(SUM(goods_total),0) AS n FROM wholesale_quotes WHERE order_no IS NOT NULL AND status IN ('paid','shipped','delivered')"))[0].n), 'product rows add up to goods sold');
    const byBuyer = (await A('GET', '/reports/buyers')).j.report; assert.strictEqual(byBuyer.rows.reduce((t, r) => t + r.total, 0), dbTotal);
    const inv_ = (await A('GET', '/reports/invoices')).j.report; assert.strictEqual(inv_.rows.length, Number((await q('SELECT COUNT(*) AS n FROM wholesale_invoices'))[0].n)); assert.strictEqual(inv_.summary.find((s) => s.label === 'Total').value, Number((await q('SELECT SUM(total) AS n FROM wholesale_invoices'))[0].n));
    assert.strictEqual(inv_.summary.find((s) => s.label === 'Cancelled after payment').value, 1, 'the cancelled order keeps its invoice but is flagged'); assert.ok(inv_.rows.some((r) => /Cancelled/.test(r.order_status)));
  });
  await test('receivables, low stock, movements and fulfilment speed show the right things', async () => {
    const rec = (await A('GET', '/reports/receivables')).j.report; const row = rec.rows.find((r) => r.ref === refUnpaid); assert.ok(row, 'the accepted but unpaid quote is listed'); assert.strictEqual(row.total, (await call('GET', '/api/wholesale/quotes/' + refUnpaid, undefined, ada.c)).j.quote.total);
    assert.ok(!rec.rows.some((r) => r.ref === refA), 'a paid quote is not listed');
    assert.strictEqual((await A('PUT', `/stock/${P2.id}/reorder-level`, { level: 100000 })).s, 200);
    const low = (await A('GET', '/reports/low-stock')).j.report; assert.ok(low.rows.some((r) => r.name === P2.name && r.shortfall > 0)); assert.ok(!low.rows.some((r) => r.name === P1.name));
    const mv = (await A('GET', '/reports/movements')).j.report; assert.ok(mv.summary.find((s) => s.label === 'Dispatched to buyers').value >= 28, 'at least the two delivered orders went out'); assert.ok(mv.summary.find((s) => s.label === 'Received').value >= 600);
    const fl = (await A('GET', '/reports/fulfilment')).j.report; assert.ok(fl.rows.some((r) => r.hours_to_deliver !== null)); assert.ok(fl.rows.some((r) => r.failed_attempts === 1)); assert.strictEqual(fl.summary.find((s) => s.label === 'Failed delivery attempts').value, 1);
  });
  await test('report periods are checked: a future window is empty, a backwards one is refused, bad dates fall back to the last 30 days', async () => {
    const e = (await A('GET', '/reports/sales?from=2099-01-01&to=2099-01-31')).j.report; assert.strictEqual(e.rows.length, 0); assert.strictEqual(e.summary.find((s) => s.label === 'Total received').value, 0);
    assert.strictEqual((await A('GET', '/reports/sales?from=2026-12-31&to=2026-01-01')).s, 400);
    assert.strictEqual((await A('GET', '/reports/sales?from=2020-01-01&to=2026-12-31')).s, 400, 'more than two years');
    const d = await A('GET', '/reports/sales?from=garbage&to=\'; drop table x;--'); assert.strictEqual(d.s, 200); assert.ok(d.j.report.summary.find((s) => s.label === 'Paid orders').value >= 1);
  });

  srv.kill(); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { srv.kill(); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ } process.exit(1); });
