'use strict';
// Global Trade module, phase 6: customs declarations, duty calculator, generated PDF documents, receiving imported stock and landed cost.
// Run with: npm run test:trade-customs   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const http = require('http');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'vm_tcu_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500), FXPORT = PORT + 2000, EPPORT = PORT + 3000;
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
const call = async (method, url, body, cookie, extraHeaders, rawBody) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(extraHeaders || {}) }, body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const buf = Buffer.from(await r.arrayBuffer()); const t = buf.toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { s: r.status, j, t, buf, h: r.headers, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + r.t); return r.c; };

const fx = { rates: { USD: 0.00065, GBP: 0.00051, EUR: 0.0006 } };
const fxServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: 'success', base_code: 'NGN', time_last_update_unix: Math.floor(Date.now() / 1000) - 600, rates: { NGN: 1, ...fx.rates } })); });

const KEY = 'test-key-' + 'x'.repeat(40);
(async () => {
  await new Promise((r) => fxServer.listen(FXPORT, '127.0.0.1', r));
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/vm-tcu-' + tag, ADMIN_EMAIL: 'owner@example.com', TRADE_DATA_KEY: KEY, ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50', FX_API_URL: `http://127.0.0.1:${FXPORT}/latest/{base}`, FX_REFRESH: '0' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, '/api/admin/trade' + u, b, admin);
  const P = (m, u, b, c) => call(m, '/api/trade' + u, b, c);
  const ST = (m, u, b) => call(m, '/api/admin/staff' + u, b, admin); const emp = {};
  const mk = async (key, roleName) => { const roles = (await ST('GET', '')).j.roles; const role = roles.find((r) => r.name === roleName); assert.ok(role, 'role ' + roleName); const r = await ST('POST', '', { name: key + ' Emp', email: key + '@example.com', username: key + '.user', role_id: role.id }); assert.strictEqual(r.s, 200, r.t); emp[key] = await login(key + '@example.com', r.j.temp_password); };

  await A('POST', '/countries/bulk', { codes: ['US', 'CN', 'NG'], flag: 'export_to', on: true }); await A('POST', '/countries/bulk', { codes: ['CN'], flag: 'import_from', on: true }); await A('POST', '/countries/bulk', { codes: ['NG'], flag: 'import_to', on: true });
  assert.strictEqual((await A('POST', '/rates/refresh')).s, 200);
  const prods = await q("SELECT id, name FROM products WHERE is_pharmacy=0 AND active=1 AND vendor_id IS NULL AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id=products.id) ORDER BY id LIMIT 2");
  const complete = { export_enabled: true, intl_eligible: true, origin_country: 'NG', hs_code: '6109.10', customs_description: 'Cotton T-shirt, knitted', weight_kg: 0.5, length_cm: 30, width_cm: 25, height_cm: 3, shipping_category: 'clothing' };
  assert.strictEqual((await A('PUT', '/products/' + prods[0].id, complete)).s, 200);
  await q('UPDATE products SET stock=100 WHERE id=$1', [prods[0].id]);

  console.log('\nDuty and tax calculator');
  await test('no rule means nothing is calculated; an unverified rule gives an ESTIMATE; only a verified rule is "verified"', async () => {
    const body = { destination_country: 'US', currency: 'USD', freight: 20, insurance: 5, lines: [{ hs_code: '6109.10', origin_country: 'NG', value: 100 }] };
    let r = await A('POST', '/customs/calc', body); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.status, 'not_available'); assert.strictEqual(r.j.totals.total_ngn, 0);
    const rule = (await A('POST', '/shipping/duty-rules', { destination_country: 'US', hs_prefix: '6109', duty_pct: 10, vat_pct: 5, valuation: 'CIF' })).j.item; assert.ok(rule && rule.id);
    r = await A('POST', '/customs/calc', body); assert.strictEqual(r.j.status, 'estimated'); assert.match(r.j.note, /ESTIMATE/);
    // CIF base = 100 + 20 + 5 = 125 USD; duty 12.5; VAT on (125 + 12.5) = 6.875; total 19.375 USD
    assert.ok(Math.abs(r.j.totals.total - 19.38) < 0.02, 'total ' + r.j.totals.total);
    await A('PUT', '/shipping/duty-rules/' + rule.id, { source: 'Official tariff', source_url: 'https://example.gov/tariff', verified: true });
    r = await A('POST', '/customs/calc', body); assert.strictEqual(r.j.status, 'verified');
    assert.strictEqual((await A('POST', '/customs/calc', { ...body, destination_country: 'ZZ' })).s, 400); assert.strictEqual((await A('POST', '/customs/calc', { ...body, lines: [{ hs_code: '61', value: 1 }] })).s, 400); assert.strictEqual((await A('POST', '/customs/calc', { ...body, freight: -1 })).s, 400);
  });

  // an international order for the document tests
  const zone = (await A('POST', '/shipping/zones', { name: 'US', countries: ['US'], origin_country: 'NG' })).j.item;
  const svc = (await A('POST', '/shipping/services', { name: 'Express', method: 'express', est_days_min: 3, est_days_max: 6, supports_insurance: true })).j.item;
  await A('POST', '/shipping/rates', { zone_id: zone.id, service_id: svc.id, min_kg: 0, max_kg: 20, base_amount: 15000, per_kg: 4000, currency: 'NGN' });
  const body = (extra = {}) => ({ items: [{ productId: prods[0].id, qty: 2 }], country: 'US', currency: 'USD', contact: { name: 'Jane Doe', email: 'jane@example.com', dial_code: '1', phone: '2025550123' }, address: { line1: '1 Main Street', city: 'Austin', region: 'TX', postal_code: '73301' }, ...extra });
  const qt = (await P('POST', '/quote', body())).j, opt = qt.options[0];
  const placed = await (async () => { const r = await fetch(`http://127.0.0.1:${PORT}/api/trade/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-doc-' + tag + '-aaaaaaaa' }, body: JSON.stringify({ ...body(), service_id: opt.service_id, quote_id: opt.quote_id }) }); return r.json(); })();
  const eref = (await q('SELECT eo.ref FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE o.ref=$1', [placed.ref]))[0].ref;
  let cd, d1;

  console.log('\nCustoms declaration');
  await test('a declaration is built from the order, once; it starts incomplete and lists exactly what to fix', async () => {
    const r = await A('POST', `/customs/from-order/${eref}`); assert.strictEqual(r.s, 200, r.t); cd = r.j; assert.strictEqual(cd.declaration.status, 'incomplete'); assert.strictEqual(cd.declaration.direction, 'export'); assert.strictEqual(cd.declaration.lines.length, 1); assert.strictEqual(cd.declaration.lines[0].hs_code, '6109.10');
    assert.strictEqual(cd.readiness.ready, false); const msgs = cd.readiness.issues.map((i) => i.message).join(' '); assert.match(msgs, /gross weight/i); assert.match(msgs, /packages/i);
    assert.strictEqual((await A('POST', `/customs/from-order/${eref}`)).j.declaration.id, cd.declaration.id); assert.strictEqual((await q('SELECT COUNT(*)::int n FROM customs_declarations'))[0].n, 1);
    assert.strictEqual((await A('POST', `/customs/${cd.declaration.id}/status`, { status: 'submitted' })).s, 409);
  });
  await test('line checks: short HS code, no origin, zero value, net weight above gross weight all block', async () => {
    const id = cd.declaration.id, L = cd.declaration.lines[0];
    let r = await A('PUT', '/customs/' + id, { gross_weight_kg: 1, net_weight_kg: 2, packages: 1, lines: [{ ...L, hs_code: '61', origin_country: '', value: 0 }] }); assert.strictEqual(r.s, 200, r.t); const m = r.j.readiness.issues.map((i) => i.message).join(' | ');
    assert.match(m, /HS code/); assert.match(m, /origin/i); assert.match(m, /above 0/); assert.match(m, /Net weight/); assert.strictEqual(r.j.declaration.status, 'incomplete');
    assert.strictEqual((await A('PUT', '/customs/' + id, { lines: [{ ...L, qty: 0 }] })).s, 400); assert.strictEqual((await A('PUT', '/customs/' + id, { packages: -1 })).s, 400); assert.strictEqual((await A('PUT', '/customs/' + id, { incoterm: 'ZZZ' })).s, 400);
  });
  await test('a product that may not be exported to the destination blocks the declaration', async () => {
    await q("INSERT INTO product_trade_restrictions (product_id,country_code,direction,reason) VALUES ($1,'US','export','Needs licence')", [prods[0].id]);
    const r = await A('PUT', '/customs/' + cd.declaration.id, { gross_weight_kg: 1.5, net_weight_kg: 1, packages: 1, incoterm: 'DAP', lines: cd.declaration.lines }); assert.strictEqual(r.j.readiness.ready, false); assert.match(JSON.stringify(r.j.readiness.issues), /restricted for export/i);
    await q('DELETE FROM product_trade_restrictions WHERE product_id=$1', [prods[0].id]);
    const ok = await A('PUT', '/customs/' + cd.declaration.id, { dimensions: '30x25x6 cm' }); assert.strictEqual(ok.j.readiness.ready, true, JSON.stringify(ok.j.readiness)); assert.strictEqual(ok.j.declaration.status, 'ready');
  });

  console.log('\nGenerated documents');
  await test('documents need the seller address; proforma works before payment, a commercial invoice only after it', async () => {
    assert.strictEqual((await A('POST', `/orders/${eref}/documents/generate`, { doc_type: 'proforma_invoice' })).s, 409, 'no sender address yet');
    assert.strictEqual((await A('PUT', '/settings', { origin_name: 'Velto-Mart Ltd', origin_phone: '+2348012345678', origin_line1: '12 Allen Avenue', origin_city: 'Ikeja', origin_region: 'Lagos', origin_postal: '100271' })).s, 200);
    const p = await A('POST', `/orders/${eref}/documents/generate`, { doc_type: 'proforma_invoice' }); assert.strictEqual(p.s, 200, p.t); assert.strictEqual(p.j.document.version, 1); assert.match(p.j.document.number, /^PRO-/);
    assert.strictEqual((await A('POST', `/orders/${eref}/documents/generate`, { doc_type: 'commercial_invoice' })).s, 409, 'unpaid');
    assert.strictEqual((await A('POST', `/orders/${eref}/documents/generate`, { doc_type: 'air_waybill' })).s, 400, 'cannot be generated');
    assert.strictEqual((await call('POST', '/api/pay/demo/' + placed.ref, { token: placed.token })).s, 200);
    const c = await A('POST', `/orders/${eref}/documents/generate`, { doc_type: 'commercial_invoice' }); assert.strictEqual(c.s, 200, c.t); d1 = c.j.document;
  });
  await test('a generated document is a real PDF, downloadable by staff only, and regenerating voids the old version but keeps it', async () => {
    const f = await A('GET', '/documents/' + d1.id); assert.strictEqual(f.s, 200); assert.ok(f.buf.slice(0, 5).toString() === '%PDF-' && f.buf.length > 1000); assert.strictEqual(f.h.get('content-type'), 'application/pdf');
    assert.ok([401, 403].includes((await call('GET', '/api/admin/trade/documents/' + d1.id)).s));
    const c2 = (await A('POST', `/orders/${eref}/documents/generate`, { doc_type: 'commercial_invoice' })).j.document; assert.strictEqual(c2.version, 2); assert.match(c2.number, /-v2$/);
    const l = (await A('GET', `/orders/${eref}/documents`)).j; const inv = l.documents.filter((x) => x.doc_type === 'commercial_invoice'); assert.strictEqual(inv.length, 2); assert.strictEqual(inv.find((x) => x.version === 1).status, 'void'); assert.strictEqual(inv.find((x) => x.version === 2).status, 'issued');
    assert.strictEqual((await A('GET', '/documents/' + d1.id)).s, 200, 'old version still downloadable');
  });
  await test('packing list, certificate of origin (draft), export and customs declaration summaries can all be produced', async () => {
    for (const t of ['packing_list', 'certificate_of_origin', 'export_declaration', 'customs_declaration']) { const r = await A('POST', `/orders/${eref}/documents/generate`, { doc_type: t }); assert.strictEqual(r.s, 200, t + ' ' + r.t); const f = await A('GET', '/documents/' + r.j.document.id); assert.ok(f.buf.slice(0, 4).toString() === '%PDF', t); }
    assert.strictEqual((await A('GET', '/customs/' + cd.declaration.id)).j.documents.length >= 4, true);
  });
  await test('documents the carrier or authority issues (air waybill, import permit) are uploaded, including files over 100 KB', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300 * 1024, 65)]);
    const r = await A('POST', `/orders/${eref}/documents`, { doc_type: 'air_waybill', number: 'AWB-1', filename: 'awb.pdf', data: big.toString('base64') }); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.document.origin, 'uploaded');
    assert.strictEqual((await A('POST', `/orders/${eref}/documents`, { doc_type: 'air_waybill', filename: 'fake.pdf', data: Buffer.from('nope').toString('base64') })).s, 400);
    assert.ok((await A('GET', `/orders/${eref}/documents`)).j.documents.some((x) => x.doc_type === 'air_waybill'));
  });
  await test('filing: ready -> submitted -> cleared needs an entry number; a filed declaration can no longer be edited', async () => {
    const id = cd.declaration.id;
    assert.strictEqual((await A('POST', `/customs/${id}/status`, { status: 'cleared' })).s, 409, 'cannot skip filing');
    assert.strictEqual((await A('POST', `/customs/${id}/status`, { status: 'submitted' })).s, 200);
    assert.strictEqual((await A('PUT', '/customs/' + id, { packages: 3 })).s, 409);
    assert.strictEqual((await A('POST', `/customs/${id}/status`, { status: 'cleared' })).s, 400, 'entry number needed');
    const c = await A('POST', `/customs/${id}/status`, { status: 'cleared', entry_number: 'C-2026-889900' }); assert.strictEqual(c.s, 200, c.t); assert.strictEqual(c.j.declaration.entry_number, 'C-2026-889900');
    assert.ok((await A('GET', '/customs?direction=export&q=C-2026')).j.declarations.length === 1);
  });

  console.log('\nImporting goods and receiving stock');
  const sup = (await A('POST', '/suppliers', { name: 'Shenzhen Textiles Ltd', country_code: 'CN', currency: 'USD', incoterm: 'FOB' })).j.supplier;
  const spA = (await A('POST', `/suppliers/${sup.id}/products`, { supplier_sku: 'A', name: 'Cotton T-shirt', unit_cost: 4, currency: 'USD', moq: 10, hs_code: '6109.10', product_id: prods[0].id })).j.item;
  const spB = (await A('POST', `/suppliers/${sup.id}/products`, { supplier_sku: 'B', name: 'Hoodie', unit_cost: 10, currency: 'USD', moq: 10, hs_code: '6110.20', product_id: prods[1].id })).j.item;
  const makeShip = async (qa, qb, costs) => {
    const po = (await A('POST', '/purchase-orders', { supplier_id: sup.id, destination_country: 'NG', items: [{ supplier_product_id: spA.id, qty: qa }, { supplier_product_id: spB.id, qty: qb }] })).j.order;
    await A('POST', `/purchase-orders/${po.id}/request-quotation`, {}); const ref = (await A('POST', `/purchase-orders/${po.id}/approve`, {})).j.order.shipment_ref;
    const S2 = (s, x = {}) => A('POST', `/imports/${ref}/status`, { status: s, ...x });
    await S2('supplier_processing'); await S2('dispatched', { carrier: 'Maersk', tracking_number: 'MAEU' + ref }); await S2('arrived_port'); await S2('customs_clearance'); await S2('released'); await A('PUT', '/imports/' + ref, costs);
    return ref;
  };
  let ref1, ref2;
  const COSTS = { freight: 100.01, insurance: 5, customs_duties: 33.33, import_taxes: 12.34, clearing_fees: 20, inland_transport: 7.77 };
  await test('stock cannot be received before the shipment is delivered to the warehouse', async () => {
    ref1 = await makeShip(100, 50, COSTS);
    const r = await A('POST', `/imports/${ref1}/receive`, { to: 'retail', items: [] }); assert.strictEqual(r.s, 409, r.t);
    assert.strictEqual((await A('POST', `/imports/${ref1}/status`, { status: 'stock_received' })).s, 409, 'status cannot be set by hand');
    assert.strictEqual((await A('POST', `/imports/${ref1}/status`, { status: 'completed' })).s, 409);
    assert.strictEqual((await A('POST', `/imports/${ref1}/status`, { status: 'delivered_warehouse' })).s, 200);
  });
  const it1 = async (ref) => (await A('GET', '/imports/' + ref)).j.items;
  await test('counts are checked: every item needed, no more than ordered, damaged within received, a destination chosen', async () => {
    const items = await it1(ref1), good = items.map((i) => ({ id: i.id, qty_received: i.qty_ordered, qty_damaged: 0 })); const R = (b) => A('POST', `/imports/${ref1}/receive-preview`, b);
    assert.strictEqual((await R({ items: [good[0]] })).s, 400, 'second item missing'); assert.strictEqual((await R({ items: [{ ...good[0], qty_received: 999 }, good[1]] })).s, 400); assert.strictEqual((await R({ items: [{ ...good[0], qty_damaged: 101 }, good[1]] })).s, 400);
    assert.strictEqual((await R({ items: [{ ...good[0], qty_received: -1 }, good[1]] })).s, 400); assert.strictEqual((await R({ items: good, basis: 'weight' })).s, 400, 'no weights');
    assert.strictEqual((await A('POST', `/imports/${ref1}/receive`, { items: good })).s, 400, 'destination');
  });
  await test('landed cost: every cost is shared out with no rounding loss; damaged and missing units are carried by the units that sold', async () => {
    const items = await it1(ref1), counts = [{ id: items[0].id, qty_received: 90, qty_damaged: 10 }, { id: items[1].id, qty_received: 50, qty_damaged: 0 }];
    const r = await A('POST', `/imports/${ref1}/receive-preview`, { items: counts }); assert.strictEqual(r.s, 200, r.t); const j = r.j;
    assert.ok(j.can_post, JSON.stringify(j.blockers)); assert.strictEqual(j.lines[0].qty_sellable, 80); assert.strictEqual(j.lines[0].shortage, 10);
    const rate = j.rate_to_ngn, sumLanded = Math.round(j.lines.reduce((a, l) => a + l.landed_ngn, 0) * 100) / 100; assert.strictEqual(sumLanded, j.total_ngn);
    const expected = Math.round((100 * 4 + 50 * 10 + 100.01 + 5 + 33.33 + 12.34 + 20 + 7.77) * rate * 100) / 100; assert.ok(Math.abs(j.total_ngn - expected) <= 0.05, `${j.total_ngn} vs ${expected}`);
    // value basis: A holds 400 of 900 purchase value so it gets 4/9 of the extras
    assert.ok(j.lines[0].unit_cost_ngn > j.lines[0].landed_ngn / 90, 'unit cost uses sellable units only');
    const qw = await A('POST', `/imports/${ref1}/receive-preview`, { items: counts, basis: 'quantity' }); assert.notStrictEqual(qw.j.lines[0].extra_ngn, j.lines[0].extra_ngn);
  });
  await test('receiving adds only sellable units to retail stock, saves the landed cost and a goods received note, and closes the receipt', async () => {
    const items = await it1(ref1), counts = [{ id: items[0].id, qty_received: 90, qty_damaged: 10 }, { id: items[1].id, qty_received: 50, qty_damaged: 0 }];
    const before = Number((await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock), beforeB = Number((await q('SELECT stock FROM products WHERE id=$1', [prods[1].id]))[0].stock);
    const r = await A('POST', `/imports/${ref1}/receive`, { to: 'retail', items: counts }); assert.strictEqual(r.s, 200, r.t); assert.ok(r.j.grn && r.j.document);
    assert.strictEqual(Number((await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock), before + 80); assert.strictEqual(Number((await q('SELECT stock FROM products WHERE id=$1', [prods[1].id]))[0].stock), beforeB + 50);
    const sh = (await q('SELECT status, stock_posted, landed_total_ngn FROM import_shipments WHERE import_ref=$1', [ref1]))[0]; assert.strictEqual(sh.status, 'stock_received'); assert.strictEqual(Number(sh.stock_posted), 1);
    const cost = (await q('SELECT * FROM trade_product_costs WHERE product_id=$1', [prods[0].id]))[0]; assert.ok(Number(cost.avg_cost_ngn) > 0);
    const l = (await A('GET', `/imports/${ref1}/landed`)).j; assert.strictEqual(l.posted, true); const tot = l.items.reduce((a, i) => a + i.allocations.reduce((x, y) => x + y.amount_ngn, 0), 0); assert.ok(Math.abs(tot - Number(sh.landed_total_ngn)) <= 0.02, 'allocations add up to the total');
    assert.strictEqual(l.items[0].qty_damaged, 10); assert.ok(l.items[0].landed_unit_cost_ngn > 0);
    const g = await A('GET', '/documents/' + r.j.document.id); assert.ok(g.buf.slice(0, 4).toString() === '%PDF');
    assert.ok((await A('GET', '/valuation')).j.products.length >= 2);
  });
  await test('receiving cannot be repeated, items cannot be edited afterwards, and the shipment can then be completed', async () => {
    const items = await it1(ref1), counts = items.map((i) => ({ id: i.id, qty_received: i.qty_ordered, qty_damaged: 0 })); const before = Number((await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock);
    assert.strictEqual((await A('POST', `/imports/${ref1}/receive`, { to: 'retail', items: counts })).s, 409); assert.strictEqual(Number((await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock), before, 'no second addition');
    assert.strictEqual((await A('PUT', `/imports/${ref1}/items/${items[0].id}`, { weight_kg: 1 })).s, 409); assert.strictEqual((await A('PUT', '/imports/' + ref1, { freight: 1 })).s, 409);
    assert.strictEqual((await A('POST', `/imports/${ref1}/status`, { status: 'completed' })).s, 200); assert.strictEqual((await q('SELECT status FROM import_shipments WHERE import_ref=$1', [ref1]))[0].status, 'completed');
  });
  await test('goods can go to the wholesale warehouse instead, through its own stock ledger, once; item weights enable sharing by weight', async () => {
    ref2 = await makeShip(20, 10, { freight: 30 }); await A('POST', `/imports/${ref2}/status`, { status: 'delivered_warehouse' });
    const items = await it1(ref2); for (const i of items) assert.strictEqual((await A('PUT', `/imports/${ref2}/items/${i.id}`, { weight_kg: 1.5 })).s, 200);
    assert.strictEqual((await A('PUT', `/imports/${ref2}/items/${items[0].id}`, { weight_kg: -1 })).s, 400);
    const counts = items.map((i) => ({ id: i.id, qty_received: i.qty_ordered, qty_damaged: 0 })), pv = await A('POST', `/imports/${ref2}/receive-preview`, { items: counts, basis: 'weight' }); assert.strictEqual(pv.s, 200, pv.t);
    const beforeRetail = Number((await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock);
    const r = await A('POST', `/imports/${ref2}/receive`, { to: 'warehouse', basis: 'weight', items: counts }); assert.strictEqual(r.s, 200, r.t);
    const bal = (await q('SELECT on_hand FROM wholesale_stock_balances WHERE product_id=$1', [prods[0].id]))[0]; assert.strictEqual(Number(bal.on_hand), 20);
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM wholesale_stock_movements WHERE related_ref=$1 AND type='receipt'", [r.j.grn]))[0].n, 2);
    assert.strictEqual(Number((await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock), beforeRetail, 'retail stock untouched');
    assert.strictEqual((await A('POST', `/imports/${ref2}/receive`, { to: 'warehouse', basis: 'weight', items: counts })).s, 409);
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM wholesale_stock_movements WHERE related_ref=$1", [r.j.grn]))[0].n, 2, 'no duplicate ledger entries');
  });
  await test('an item that is not linked to a product blocks receiving until it is linked', async () => {
    const ref = await makeShip(10, 10, { freight: 5 }); await A('POST', `/imports/${ref}/status`, { status: 'delivered_warehouse' }); const items = await it1(ref);
    await q('UPDATE import_shipment_items SET product_id=NULL WHERE id=$1', [items[0].id]); const counts = items.map((i) => ({ id: i.id, qty_received: i.qty_ordered }));
    const r = await A('POST', `/imports/${ref}/receive`, { to: 'retail', items: counts }); assert.strictEqual(r.s, 409, r.t); assert.match(r.j.error, /Link/);
    assert.strictEqual((await A('PUT', `/imports/${ref}/items/${items[0].id}`, { product_id: prods[0].id })).s, 200); assert.strictEqual((await A('POST', `/imports/${ref}/receive`, { to: 'retail', items: counts })).s, 200);
  });
  await test('an import customs declaration and its summary PDF can be created for a shipment', async () => {
    const r = await A('POST', `/customs/from-import/${ref1}`); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.declaration.direction, 'import'); assert.strictEqual(r.j.declaration.import_country, 'NG');
    const d = await A('POST', `/imports/${ref1}/documents/generate`, { doc_type: 'customs_declaration' }); assert.strictEqual(d.s, 200, d.t);
    assert.strictEqual((await A('POST', `/imports/${ref1}/documents/generate`, { doc_type: 'commercial_invoice' })).s, 400);
  });

  console.log('\nPermissions');
  await test('analysts can read but not change customs, documents or receiving; managers can', async () => {
    await mk('analyst', 'Trade Analyst'); await mk('mgr', 'Trade & Logistics Manager');
    assert.strictEqual((await call('GET', '/api/admin/trade/customs', undefined, emp.analyst)).s, 200);
    assert.strictEqual((await call('POST', `/api/admin/trade/customs/from-order/${eref}`, {}, emp.analyst)).s, 403); assert.strictEqual((await call('POST', `/api/admin/trade/orders/${eref}/documents/generate`, { doc_type: 'packing_list' }, emp.analyst)).s, 403);
    assert.strictEqual((await call('POST', `/api/admin/trade/imports/${ref1}/receive`, { to: 'retail', items: [] }, emp.analyst)).s, 403);
    assert.strictEqual((await call('POST', `/api/admin/trade/orders/${eref}/documents/generate`, { doc_type: 'packing_list' }, emp.mgr)).s, 200);
    assert.ok([401, 403].includes((await call('GET', '/api/admin/trade/customs')).s));
  });
  await test('the new tables have row level security on and no open policies', async () => {
    const t = await q("SELECT relrowsecurity r FROM pg_class WHERE relname='trade_product_costs'"); assert.strictEqual(t[0].r, true);
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM pg_policies WHERE tablename IN ('trade_product_costs','customs_declarations','landed_cost_allocations')"))[0].n, 0);
  });

  if (process.env.UI_CHECK) {   // optional: drive the real admin screens in a browser (needs Playwright); not part of the normal run
    const refUi = await makeShip(30, 20, { freight: 40, customs_duties: 10 }); await A('POST', `/imports/${refUi}/status`, { status: 'delivered_warehouse' });
    const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright'); const b = await chromium.launch(), pgx = await b.newPage(), errs = [];
    await pgx.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort()); pgx.on('pageerror', (e) => errs.push(e.message)); pgx.on('console', (m) => m.type() === 'error' && !/font|net::|Failed to load/i.test(m.text()) && errs.push(m.text()));
    await pgx.goto(`http://127.0.0.1:${PORT}/admin`); await pgx.waitForTimeout(1200); await pgx.fill('#le', 'owner@example.com'); await pgx.fill('#lp', 'Str0ng-Owner-Pass!'); await pgx.keyboard.press('Enter'); await pgx.waitForTimeout(1500);
    await pgx.evaluate(() => { location.hash = '#/trade'; }); await pgx.waitForTimeout(1000);
    await test('UI: order screen offers documents and the declaration opens with its fix list', async () => {
      await pgx.click('[data-tab=orders]'); await pgx.waitForTimeout(800); await pgx.click(`[data-o="${eref}"]`); await pgx.waitForTimeout(1200);
      const t = await pgx.innerText('.modal, #modal, [class*=modal]').catch(async () => pgx.innerText('body')); assert.match(t, /Customs declaration/); assert.match(t, /Create commercial invoice/);
      await pgx.click('#ocd'); await pgx.waitForTimeout(1200); const t2 = await pgx.innerText('body'); assert.match(t2, /Ready to file|Must fix/); assert.match(t2, /Create commercial invoice \(PDF\)/);
      await pgx.screenshot({ path: '/tmp/decl.png' });
    });
    await test('UI: a shipment delivered to the warehouse shows the receive panel and a landed-cost preview', async () => {
      await pgx.keyboard.press('Escape'); await pgx.reload(); await pgx.waitForTimeout(1500); await pgx.evaluate(() => { location.hash = '#/trade'; }); await pgx.waitForTimeout(800);
      await pgx.click('[data-tab=imports]'); await pgx.waitForTimeout(800); await pgx.click(`[data-i="${refUi}"]`); await pgx.waitForTimeout(1500);
      assert.match(await pgx.innerText('body'), /Receive stock/); await pgx.click('#rxp'); await pgx.waitForTimeout(1500); const t = await pgx.innerText('body'); assert.match(t, /Total landed cost/); assert.match(t, /Receive into stock/);
      await pgx.screenshot({ path: '/tmp/receive.png' });
    });
    await test('UI: no script errors', async () => { assert.deepStrictEqual(errs, []); });
    await b.close();
  }

  srv.kill(); fxServer.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.split('\n').slice(-25).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); try { srv.kill(); } catch { /* */ } process.exit(1); });
