'use strict';
// Global Trade module, phase 4: import procurement and international suppliers.
// Run with: npm run test:trade-import   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const http = require('http');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');
const X = require('../lib/xlsx');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'vm_ti_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500), FXPORT = PORT + 2000;
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
const call = async (method, url, body, cookie, raw) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const buf = Buffer.from(await r.arrayBuffer()); const t = buf.toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { s: r.status, j, t, buf, h: r.headers, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + email + ' ' + r.t); return r.c; };

// A fake exchange-rate provider (same shape as open.er-api.com) so the test never touches the internet.
const fx = { up: true, calls: 0, rates: { USD: 0.00065, GBP: 0.00051, EUR: 0.0006, CAD: 0.00089, AUD: 0.00099 } };
const fxServer = http.createServer((req, res) => {
  fx.calls++;
  if (!fx.up) { res.writeHead(500); return res.end('down'); }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: 'success', base_code: 'NGN', time_last_update_unix: Math.floor(Date.now() / 1000) - 600, rates: { NGN: 1, ...fx.rates } }));
});

const KEY = 'test-key-' + 'x'.repeat(40);
(async () => {
  await new Promise((r) => fxServer.listen(FXPORT, '127.0.0.1', r));
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/vm-ti-' + tag, ADMIN_EMAIL: 'owner@example.com', TRADE_DATA_KEY: KEY, ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50', FX_API_URL: `http://127.0.0.1:${FXPORT}/latest/{base}`, FX_REFRESH: '0' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, '/api/admin/trade' + u, b, admin);
  const P = (m, u, b, c) => call(m, '/api/trade' + u, b, c);

  const ST = (m, u, b) => call(m, '/api/admin/staff' + u, b, admin); const emp = {};
  const mk = async (key, roleName) => { const roles = (await ST('GET', '')).j.roles; const role = roles.find((r) => r.name === roleName); assert.ok(role, 'role ' + roleName); const r = await ST('POST', '', { name: key + ' Emp', email: key + '@example.com', username: key + '.user', role_id: role.id }); assert.strictEqual(r.s, 200, r.t); emp[key] = await login(key + '@example.com', r.j.temp_password); };
  await A('POST', '/countries/bulk', { codes: ['CN', 'NG', 'IN'], flag: 'import_from', on: true }); await A('POST', '/countries/bulk', { codes: ['NG'], flag: 'import_to', on: true });
  assert.strictEqual((await A('POST', '/rates/refresh')).s, 200);
  const sup = { name: 'Shenzhen Textiles Ltd', country_code: 'CN', contact_person: 'Li Wei', email: 'sales@szt.example.com', currency: 'USD', incoterm: 'FOB', payment_terms: '30% deposit, 70% before shipping', rating: 4.5 };
  let s1, po, ref;

  console.log('\nSuppliers');
  await test('a supplier can be registered; bad email, website, Incoterm, or a duplicate name is refused', async () => {
    const r = await A('POST', '/suppliers', sup); assert.strictEqual(r.s, 200, r.t); s1 = r.j.supplier; assert.strictEqual(s1.has_bank_details, false);
    assert.strictEqual((await A('POST', '/suppliers', { ...sup, name: 'X Co', email: 'nope' })).s, 400);
    assert.strictEqual((await A('POST', '/suppliers', { ...sup, name: 'X Co', website: 'javascript:alert(1)' })).s, 400);
    assert.strictEqual((await A('POST', '/suppliers', { ...sup, name: 'X Co', incoterm: 'ZZZ' })).s, 400);
    assert.strictEqual((await A('POST', '/suppliers', { ...sup, name: 'shenzhen textiles ltd' })).s, 409);
  });
  await test('bank details are encrypted at rest, never shown in lists or profiles, and every view is audited', async () => {
    const secret = 'Bank of China · Acct 6222 0000 1111 · SWIFT BKCHCNBJ';
    assert.strictEqual((await A('PUT', `/suppliers/${s1.id}/bank`, { details: secret })).s, 200);
    const raw = (await q('SELECT bank_details_enc FROM international_suppliers WHERE id=$1', [s1.id]))[0].bank_details_enc; assert.ok(raw.startsWith('v1:') && !raw.includes('Bank of China'));
    assert.ok(!JSON.stringify((await A('GET', '/suppliers')).j).includes('6222') && !JSON.stringify((await A('GET', '/suppliers/' + s1.id)).j).includes('6222'));
    assert.strictEqual((await A('GET', `/suppliers/${s1.id}/bank`)).j.details, secret);
    assert.ok((await q("SELECT COUNT(*)::int n FROM trade_audit_logs WHERE action='supplier.bank.view'"))[0].n >= 1);
    assert.ok(!(await q("SELECT detail::text d FROM trade_audit_logs WHERE entity='international_suppliers'")).some((r) => r.d.includes('6222')), 'audit log never holds the bank details');
  });
  await test('permissions: managers can run suppliers but cannot read bank details; Finance can; analysts and sales cannot change anything', async () => {
    await mk('mgr', 'Trade & Logistics Manager'); await mk('analyst', 'Trade Analyst'); await mk('fin', 'Finance Officer');
    assert.strictEqual((await call('GET', '/api/admin/trade/suppliers', undefined, emp.mgr)).s, 200);
    assert.strictEqual((await call('GET', `/api/admin/trade/suppliers/${s1.id}/bank`, undefined, emp.mgr)).s, 403);
    assert.strictEqual((await call('GET', `/api/admin/trade/suppliers/${s1.id}/bank`, undefined, emp.fin)).s, 200);
    assert.strictEqual((await call('POST', '/api/admin/trade/suppliers', { ...sup, name: 'Y Co' }, emp.analyst)).s, 403);
    const d = (await call('GET', '/api/admin/trade/suppliers/' + s1.id, undefined, emp.analyst)).j; assert.strictEqual(d.money_hidden, true);
    assert.strictEqual((await call('POST', `/api/admin/trade/payments/suppliers/${s1.id}`, { amount: 1, currency: 'USD', paid_on: '2026-11-01' }, emp.mgr)).s, 403, 'recording money needs Finance');
  });

  console.log('\nCatalogue and comparison');
  const prods = await q("SELECT id, name FROM products WHERE is_pharmacy=0 AND active=1 ORDER BY id LIMIT 2");
  let sp1;
  await test('catalogue items validate cost, HS code and MOQ; duplicates of a supplier SKU are refused', async () => {
    const r = await A('POST', `/suppliers/${s1.id}/products`, { supplier_sku: 'TS-100', name: 'Cotton T-shirt', unit_cost: 4.5, currency: 'USD', moq: 100, lead_time_days: 21, hs_code: '6109.10', product_id: prods[0].id }); assert.strictEqual(r.s, 200, r.t); sp1 = r.j.item;
    assert.strictEqual((await A('POST', `/suppliers/${s1.id}/products`, { supplier_sku: 'ts-100', name: 'Dup', unit_cost: 1 })).s, 409);
    assert.strictEqual((await A('POST', `/suppliers/${s1.id}/products`, { name: 'Bad', unit_cost: -1 })).s, 400);
    assert.strictEqual((await A('POST', `/suppliers/${s1.id}/products`, { name: 'Bad', unit_cost: 1, hs_code: 'abc' })).s, 400);
  });
  await test('an Excel/CSV catalogue can be previewed and imported; rows with errors are reported, good rows still load', async () => {
    const csv = 'Supplier SKU,Product name,HS code,Unit cost,Currency,Minimum order quantity,Lead time (days)\nTS-200,Hoodie,6110.20,9.8,USD,50,25\nTS-100,Cotton T-shirt,6109.10,4.2,USD,100,21\nTS-300,Broken,6109.10,abc,USD,1,1\n';
    const body = { filename: 'cat.csv', data: Buffer.from(csv).toString('base64') };
    const pv = await A('POST', `/suppliers/${s1.id}/catalogue/preview`, body); assert.strictEqual(pv.s, 200, pv.t); assert.strictEqual(pv.j.ok, 2); assert.strictEqual(pv.j.errors.length, 1);
    const cm = await A('POST', `/suppliers/${s1.id}/catalogue/commit`, body); assert.strictEqual(cm.s, 200, cm.t); assert.strictEqual(cm.j.created, 1); assert.strictEqual(cm.j.updated, 1);
    const row = (await q('SELECT unit_cost, product_id FROM supplier_products WHERE id=$1', [sp1.id]))[0]; assert.strictEqual(Number(row.unit_cost), 4.2); assert.strictEqual(Number(row.product_id), Number(prods[0].id), 'link to the Velto-Mart product is kept');
  });
  await test('prices from several suppliers can be compared, cheapest first, with NGN equivalents', async () => {
    const s2 = (await A('POST', '/suppliers', { ...sup, name: 'Mumbai Garments', country_code: 'IN', email: '', incoterm: '' })).j.supplier;
    await A('POST', `/suppliers/${s2.id}/products`, { supplier_sku: 'MG-1', name: 'Cotton T-shirt', unit_cost: 3.9, currency: 'USD', moq: 200, product_id: prods[0].id });
    const r = await A('GET', '/suppliers/compare?product_id=' + prods[0].id); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.items.length, 2); assert.strictEqual(r.j.items[0].supplier, 'Mumbai Garments'); assert.ok(r.j.items[0].unit_cost_ngn > 0);
    assert.strictEqual((await A('GET', '/suppliers/compare')).s, 400);
  });

  console.log('\nPurchase orders');
  const items = (n = 100) => [{ supplier_product_id: sp1.id, qty: n }];
  await test('an order needs lines, respects the minimum order quantity and the order currency, and totals are computed on the server', async () => {
    assert.strictEqual((await A('POST', '/purchase-orders', { supplier_id: s1.id, destination_country: 'NG', items: [] })).s, 400);
    assert.strictEqual((await A('POST', '/purchase-orders', { supplier_id: s1.id, destination_country: 'NG', items: items(10) })).s, 400, 'below MOQ');
    assert.strictEqual((await A('POST', '/purchase-orders', { supplier_id: s1.id, destination_country: 'NG', currency: 'EUR', items: items() })).s, 400, 'currency mismatch');
    assert.strictEqual((await A('POST', '/purchase-orders', { supplier_id: s1.id, destination_country: 'US', items: items() })).s, 400, 'destination not enabled for import');
    const r = await A('POST', '/purchase-orders', { supplier_id: s1.id, destination_country: 'NG', items: items(150), total: 1 }); assert.strictEqual(r.s, 200, r.t); po = r.j.order;
    assert.strictEqual(po.total, 630); assert.strictEqual(po.status, 'draft'); assert.match(po.po_number, /^PO-/);
  });
  await test('requesting a quotation moves the order forward and can email the supplier only when asked', async () => {
    const before = (await q('SELECT COUNT(*)::int n FROM outbox'))[0].n;
    const r = await A('POST', `/purchase-orders/${po.id}/request-quotation`, { send_email: true }); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.order.status, 'quotation_requested'); assert.strictEqual(r.j.emailed, true);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM outbox'))[0].n, before + 1);
    assert.strictEqual((await A('POST', `/purchase-orders/${po.id}/request-quotation`, {})).s, 409);
  });
  await test('the quoted price can be updated before approval; approval creates the import shipment once', async () => {
    const u = await A('PUT', `/purchase-orders/${po.id}`, { supplier_id: s1.id, destination_country: 'NG', items: [{ supplier_product_id: sp1.id, qty: 150, unit_cost: 4.0 }], expected_dispatch: '2026-12-10', expected_arrival: '2027-01-15' }); assert.strictEqual(u.s, 200, u.t); assert.strictEqual(u.j.order.total, 600);
    assert.strictEqual((await A('PUT', `/purchase-orders/${po.id}`, { supplier_id: s1.id, destination_country: 'NG', items: items(), expected_dispatch: '2026-12-10', expected_arrival: '2026-12-01' })).s, 400);
    const a = await A('POST', `/purchase-orders/${po.id}/approve`, {}); assert.strictEqual(a.s, 200, a.t); assert.strictEqual(a.j.order.status, 'approved'); ref = a.j.order.shipment_ref; assert.match(ref, /^IMP-/);
    assert.strictEqual((await A('POST', `/purchase-orders/${po.id}/approve`, {})).s, 409);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM import_shipments WHERE po_id=$1', [po.id]))[0].n, 1);
    assert.strictEqual((await A('PUT', `/purchase-orders/${po.id}`, { supplier_id: s1.id, destination_country: 'NG', items: items(1000) })).s, 200, 'only dates and notes change after approval'); assert.strictEqual(Number((await q('SELECT total FROM import_purchase_orders WHERE id=$1', [po.id]))[0].total), 600);
  });
  await test('a blocked or paused supplier cannot have orders approved', async () => {
    const d = (await A('POST', '/purchase-orders', { supplier_id: s1.id, destination_country: 'NG', items: items() })).j.order;
    await A('PUT', '/suppliers/' + s1.id, { ...sup, status: 'paused' }); assert.strictEqual((await A('POST', `/purchase-orders/${d.id}/approve`, {})).s, 409);
    await A('PUT', '/suppliers/' + s1.id, { ...sup, status: 'active' }); assert.strictEqual((await A('POST', `/purchase-orders/${d.id}/cancel`, {})).s, 200);
    assert.strictEqual((await A('POST', `/purchase-orders/${d.id}/approve`, {})).s, 409, 'cancelled orders cannot be approved');
  });

  console.log('\nImport shipments');
  await test('shipment statuses only move along the allowed path; dispatch needs a carrier or tracking number', async () => {
    const S2 = (st, b = {}) => A('POST', `/imports/${ref}/status`, { status: st, ...b });
    assert.strictEqual((await S2('dispatched')).s, 409, 'cannot skip supplier processing');
    assert.strictEqual((await S2('supplier_processing')).s, 200);
    assert.strictEqual((await S2('dispatched')).s, 400, 'needs carrier');
    assert.strictEqual((await S2('dispatched', { carrier: 'Maersk', tracking_number: 'MAEU123456', eta: '2027-01-20' })).s, 200);
    assert.strictEqual((await S2('stock_received')).s, 409, 'stock receiving belongs to phase 6');
    assert.strictEqual((await S2('arrived_port')).s, 200); assert.strictEqual((await S2('customs_clearance')).s, 200); assert.strictEqual((await S2('customs_hold')).s, 200); assert.strictEqual((await S2('released')).s, 200);
    const g = (await A('GET', '/imports/' + ref)).j; assert.strictEqual(g.shipment.status, 'released'); assert.ok(g.events.length >= 6); assert.ok(g.shipment.dispatched_at && g.shipment.arrived_at);
  });
  await test('costs are entered in the shipment currency, the exchange rate is frozen at first entry, and landed cost is the sum', async () => {
    const r = await A('PUT', '/imports/' + ref, { freight: 120, insurance: 10, customs_duties: 55.5, clearing_fees: 20 }); assert.strictEqual(r.s, 200, r.t);
    const sh = r.j.shipment; assert.strictEqual(sh.purchase_value, 600); assert.strictEqual(sh.landed_cost, 805.5); assert.ok(sh.fx_rate_to_ngn > 0); assert.ok(sh.landed_cost_ngn > 0);
    const rate1 = sh.fx_rate_to_ngn; await A('POST', '/rates/refresh'); const r2 = await A('PUT', '/imports/' + ref, { other_charges: 5 }); assert.strictEqual(r2.j.shipment.fx_rate_to_ngn, rate1, 'rate not changed by later rate updates');
    assert.strictEqual((await A('PUT', '/imports/' + ref, { freight: -5 })).s, 400);
  });
  await test('manual tracking updates are accepted for valid stages only', async () => {
    assert.strictEqual((await A('POST', `/imports/${ref}/event`, { stage: 'delayed', description: 'Port congestion' })).s, 200);
    assert.strictEqual((await A('POST', `/imports/${ref}/event`, { stage: 'bogus', description: 'x' })).s, 400);
    assert.strictEqual((await A('POST', `/imports/${ref}/event`, { stage: 'delayed' })).s, 400);
  });
  await test('a started order cannot be cancelled, and the dashboard counts it', async () => {
    assert.strictEqual((await A('POST', `/purchase-orders/${po.id}/cancel`, {})).s, 409);
    const d = (await A('GET', '/dashboard')).j; assert.ok(d.kpi.import_orders >= 1);
  });

  console.log('\nSupplier payments and balances');
  await test('payments are recorded per currency, reduce the outstanding balance, and are Finance-only', async () => {
    let r = await A('POST', `/payments/suppliers/${s1.id}`, { amount: 180, currency: 'USD', paid_on: '2026-11-10', reference: 'TT-1', po_id: po.id, fx_rate_to_ngn: 1500 }); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual(r.j.balances.find((b) => b.currency === 'USD').outstanding, 420); assert.strictEqual(r.j.payment.amount_ngn, 270000);
    assert.strictEqual((await A('POST', `/payments/suppliers/${s1.id}`, { amount: 5, currency: 'EUR', paid_on: '2026-11-10', po_id: po.id })).s, 400, 'order is in USD');
    assert.strictEqual((await A('POST', `/payments/suppliers/${s1.id}`, { amount: 5, currency: 'USD', paid_on: '2099-01-01' })).s, 400, 'no future dates');
    const pay = (await A('GET', '/payments/payables')).j.payables[0]; assert.strictEqual(pay.outstanding, 420);
    assert.strictEqual((await call('GET', '/api/admin/trade/payments/payables', undefined, emp.fin)).s, 200);
    assert.strictEqual((await call('GET', '/api/admin/trade/payments/payables', undefined, emp.analyst)).s, 403);
    assert.ok((await A('GET', '/dashboard')).j.kpi.outstanding_supplier_ngn > 0);
  });
  await test('a supplier with orders or payments cannot be deleted', async () => { assert.strictEqual((await A('DELETE', '/suppliers/' + s1.id)).s, 409); });

  console.log('\nSupporting documents');
  await test('supplier invoices can be attached privately, checked for type and size, downloaded only by staff, and removed', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const up = await A('POST', `/purchase-orders/${po.id}/documents`, { doc_type: 'supplier_invoice', number: 'INV-77', filename: 'inv77.pdf', data: pdf.toString('base64') }); assert.strictEqual(up.s, 200, up.t); const id = up.j.document.id;
    assert.strictEqual((await A('POST', `/purchase-orders/${po.id}/documents`, { doc_type: 'supplier_invoice', filename: 'fake.pdf', data: Buffer.from('not a pdf').toString('base64') })).s, 400);
    assert.strictEqual((await A('POST', `/purchase-orders/${po.id}/documents`, { doc_type: 'supplier_invoice', filename: 'run.exe', data: pdf.toString('base64') })).s, 400);
    assert.strictEqual((await A('POST', `/purchase-orders/${po.id}/documents`, { doc_type: 'nonsense', filename: 'a.pdf', data: pdf.toString('base64') })).s, 400);
    const dl = await call('GET', '/api/admin/trade/documents/' + id, undefined, admin); assert.strictEqual(dl.s, 200); assert.ok(dl.buf.equals(pdf)); assert.match(dl.h.get('content-disposition'), /attachment/);
    assert.strictEqual((await call('GET', '/api/admin/trade/documents/' + id)).s, 401);
    assert.strictEqual((await A('GET', '/purchase-orders/' + po.id)).j.documents.length, 1);
    assert.strictEqual((await A('DELETE', '/documents/' + id)).s, 200); assert.strictEqual((await call('GET', '/api/admin/trade/documents/' + id, undefined, admin)).s, 404);
  });

  console.log('\nCustomers and existing shop');
  await test('customers cannot reach supplier or import data; the storefront still works', async () => {
    const c = await call('POST', '/api/auth/register', { name: 'Buyer Two', email: 'buyer2@example.com', password: 'Zebra-Violin-Table-2026!' });
    for (const u of ['/suppliers', '/purchase-orders', '/imports', '/payments/payables']) assert.ok([401, 403].includes((await call('GET', '/api/admin/trade' + u, undefined, c.c)).s), u);
    assert.strictEqual((await call('GET', '/health')).s, 200);
  });

  srv.kill(); fxServer.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.split('\n').slice(-20).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { srv.kill(); fxServer.close(); } catch { /* */ } await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); process.exit(1); });
