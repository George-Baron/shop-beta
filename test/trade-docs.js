'use strict';
// Import and export: shipment records, numbered PDF documents, landed cost, attached files, the compliance checklist per country pair (editable rules),
// and restricted items (blocked or sent for a compliance check before listing). Run with: npm run test:trade-docs
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_trd_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1000);
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


(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-trd-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' })).c;
  const A = (m, u, b) => call(m, u, b, admin), D = (m, u, b) => A(m, '/api/admin/dropship' + u, b), TR = (m, u, b) => D(m, '/trade' + u, b);
  const pdfText = (r) => r.buf.toString('latin1');

  /* ---- fixtures ---- */
  await D('PUT', '/rates/USD', { ngn_per_unit: 1500 });
  const SUP = { name: 'Shenzhen Gadgets Ltd', country: 'CN', currency: 'USD', contact_name: 'Li Wei', email: 'li@szgadgets.example', whatsapp: '+86 138 0000 0000', address: 'Bao\'an District, Shenzhen', payment_terms: 'Prepaid', payment_days: 0, processing_days: 3, shipping_methods: ['air'] };
  const sup = (await D('POST', '/suppliers', SUP)).j.id;
  const mkProduct = async (name, extra = {}) => D('POST', '/products', { supplier_id: sup, supplier_sku: 'SKU-' + (++SEQ), name, store: 'electronics', brand: 'Zed', description: name + ' for tests', cost: 10, ship_cost: 2, processing_days: 3, ship_times: { NG: { min: 7, max: 14 } }, weight_kg: 0.25, origin_country: 'CN', hs_code: '8517.12', ...extra });
  const SHIP = { direction: 'import', incoterm: 'FOB', currency: 'USD', party_name: 'Shenzhen Gadgets Ltd', party_address: 'Bao\'an District, Shenzhen', party_country: 'CN', origin_country: 'CN', dest_country: 'NG', transport: 'air', freight: 800, insurance: 100, duty_pct: 20, vat_pct: 7.5, agent_fee: 150 };
  const line = (o = {}) => ({ description: 'Wireless earbuds', qty: 100, unit_value: 12.5, hs_code: '8518.30', origin_country: 'CN', weight_kg: 0.12, ...o });
  let imp, exp;

  console.log('\nShipments');
  await test('only an administrator can reach the trade screens', async () => {
    const reg = await call('POST', '/api/auth/register', { name: 'Pat Buyer', email: 'pat@example.com', phone: '08031230000', password: 'mango-river-sky-55' });
    const cust = reg.c || (await call('POST', '/api/auth/login', { email: 'pat@example.com', password: 'mango-river-sky-55' })).c;
    for (const [m, u] of [['GET', '/shipments'], ['POST', '/shipments'], ['GET', '/rules'], ['POST', '/landed'], ['GET', '/meta'], ['GET', '/shipments/1/documents/commercial_invoice/pdf']]) assert.strictEqual((await call(m, '/api/admin/dropship/trade' + u, m === 'GET' ? undefined : {}, cust)).s, 401, u);
    for (const [m, u] of [['GET', '/shipments'], ['GET', '/rules']]) assert.strictEqual((await call(m, '/api/admin/dropship/trade' + u)).s, 401, u);
  });
  await test('creating a shipment checks the basics and numbers it SH-00001, SH-00002', async () => {
    assert.strictEqual((await TR('POST', '/shipments', { ...SHIP, dest_country: 'CN' })).s, 400, 'same country both ends');
    assert.strictEqual((await TR('POST', '/shipments', { ...SHIP, party_name: '' })).s, 400);
    assert.strictEqual((await TR('POST', '/shipments', { ...SHIP, incoterm: 'XYZ' })).s, 400);
    assert.strictEqual((await TR('POST', '/shipments', { ...SHIP, currency: 'ZZZ' })).s, 400);
    assert.strictEqual((await TR('POST', '/shipments', { ...SHIP, origin_country: 'NARNIA' })).s, 400);
    assert.strictEqual((await TR('POST', '/shipments', { ...SHIP, eta: 'next tuesday' })).s, 400);
    assert.strictEqual((await TR('POST', '/shipments', { ...SHIP, freight: -5 })).s, 400);
    const a = await TR('POST', '/shipments', { ...SHIP, supplier_id: sup, eta: '2026-12-20' }); assert.strictEqual(a.s, 200, a.t); imp = a.j.id;
    const b = await TR('POST', '/shipments', { direction: 'export', incoterm: 'CIF', currency: 'EUR', party_name: 'Berlin Buyers GmbH', party_address: 'Hauptstr 1, Berlin', party_country: 'DE', origin_country: 'NG', dest_country: 'DE', transport: 'sea', freight: 600, insurance: 50 }); assert.strictEqual(b.s, 200, b.t); exp = b.j.id;
    assert.strictEqual((await TR('GET', '/shipments/' + imp)).j.shipment.ref, 'SH-00001'); assert.strictEqual((await TR('GET', '/shipments/' + exp)).j.shipment.ref, 'SH-00002');
    assert.strictEqual((await q('SELECT eta FROM trade_shipments WHERE id=$1', [imp]))[0].eta > 0, true);
  });
  await test('goods are added by hand or taken from a dropship product, with the price converted to the shipment currency', async () => {
    assert.strictEqual((await TR('POST', `/shipments/${imp}/items`, line({ description: '' }))).s, 400);
    assert.strictEqual((await TR('POST', `/shipments/${imp}/items`, line({ qty: 0 }))).s, 400);
    assert.strictEqual((await TR('POST', `/shipments/${imp}/items`, line({ hs_code: 'abc' }))).s, 400);
    assert.strictEqual((await TR('POST', `/shipments/${imp}/items`, line({ unit_value: -1 }))).s, 400);
    assert.strictEqual((await TR('POST', `/shipments/${imp}/items`, line())).s, 200);
    const p = await mkProduct('Quartz Phone Stand'); assert.strictEqual(p.s, 200, p.t);
    const r = await TR('POST', `/shipments/${imp}/items/from-product`, { product_id: p.j.id, qty: 40 }); assert.strictEqual(r.s, 200, r.t);
    const d = (await TR('GET', '/shipments/' + imp)).j; const it = d.items.find((x) => x.description === 'Quartz Phone Stand');
    assert.ok(it); assert.strictEqual(it.qty, 40); assert.strictEqual(it.unit_value, 10); assert.strictEqual(it.hs_code, '8517.12'); assert.strictEqual(it.origin_country, 'CN'); assert.strictEqual(it.weight_kg, 0.25); assert.strictEqual(it.product_id, Number(p.j.id));
    const eur = await TR('POST', `/shipments/${exp}/items/from-product`, { product_id: p.j.id, qty: 1 }); assert.strictEqual(eur.s, 400, 'USD to EUR has no rate yet'); assert.match(eur.j.error, /exchange rate for EUR/);
    await D('PUT', '/rates/EUR', { ngn_per_unit: 1650 });
    assert.strictEqual((await TR('POST', `/shipments/${exp}/items/from-product`, { product_id: p.j.id, qty: 5 })).s, 200);
    assert.strictEqual(Math.round((await TR('GET', '/shipments/' + exp)).j.items[0].unit_value * 100), 909, '10 USD at 1500 = 9.0909 EUR at 1650');
  });
  await test('restricted goods cannot be put on a shipment', async () => {
    const r = await TR('POST', `/shipments/${imp}/items`, line({ description: 'Paracetamol tablets 500mg', hs_code: '' })); assert.strictEqual(r.s, 400); assert.match(r.j.error, /Medicines/);
    assert.strictEqual((await TR('POST', `/shipments/${imp}/items`, line({ description: 'Gadget', hs_code: '3004.90' }))).s, 400, 'caught by HS code');
  });
  await test('a line can be changed or removed while the shipment is still a draft', async () => {
    const id = (await TR('POST', `/shipments/${imp}/items`, line({ description: 'Spare cable', qty: 5, unit_value: 1 }))).j.id;
    assert.strictEqual((await TR('PUT', `/shipments/${imp}/items/${id}`, { qty: 7 })).s, 200);
    assert.strictEqual((await TR('GET', '/shipments/' + imp)).j.items.find((x) => x.id === id).qty, 7);
    assert.strictEqual((await TR('DELETE', `/shipments/${imp}/items/${id}`)).s, 200); assert.ok(!(await TR('GET', '/shipments/' + imp)).j.items.some((x) => x.id === id));
  });

  console.log('\nLanded cost');
  await test('the shipment works out landed cost with its Incoterm, and shows the Naira figure at the rate on file', async () => {
    const d = (await TR('GET', '/shipments/' + imp)).j, goods = 100 * 12.5 + 40 * 10;           // 1,650.00 USD
    const duty = Math.round((goods + 800 + 100) * 0.2 * 100) / 100, vat = Math.round((goods + 900 + duty) * 0.075 * 100) / 100;
    assert.strictEqual(d.landed.totals_major.customs_value, goods + 900); assert.ok(Math.abs(d.landed.totals_major.landed_total - (goods + 900 + duty + vat + 150)) < 0.011);
    assert.strictEqual(d.landed.converted.currency, 'NGN'); assert.strictEqual(d.landed.converted.rate, 1500);
    assert.ok(Math.abs(d.landed.converted.totals.landed_total - d.landed.totals_major.landed_total * 1500) < 1);
    assert.strictEqual(d.net_weight_kg, 100 * 0.12 + 40 * 0.25);
  });
  await test('the stand-alone calculator works for any currency, import or export, and refuses bad input', async () => {
    const r = await TR('POST', '/landed', { direction: 'import', incoterm: 'CIF', currency: 'USD', goods: 10000, freight: 800, insurance: 100, duty_pct: 20, vat_pct: 7.5, agent_fee: 150, show_in: 'NGN' });
    assert.strictEqual(r.s, 200); assert.strictEqual(r.j.totals_major.landed_total, 13050); assert.strictEqual(r.j.converted.totals.landed_total, 13050 * 1500);
    assert.strictEqual((await TR('POST', '/landed', { direction: 'export', incoterm: 'DDP', currency: 'EUR', goods: 5000, show_in: 'USD', duty_pct: 10 })).s, 200);
    const nr = await TR('POST', '/landed', { direction: 'import', incoterm: 'FOB', currency: 'USD', goods: 100, show_in: 'CNY' });
    assert.strictEqual(nr.s, 200); assert.ok(/no exchange rate/.test(nr.j.convert_error) && !nr.j.converted, 'no CNY rate: cost shown, conversion refused');
    assert.strictEqual((await TR('POST', '/landed', { direction: 'import', incoterm: 'FOB', currency: 'USD', goods: 'lots' })).s, 400);
  });

  console.log('\nDocuments');
  await test('each document is a PDF with a stable number and date: printing it again changes nothing', async () => {
    await TR('PUT', '/company', { co_name: 'Velto Trading Ltd', co_address: '1 Marina, Lagos', co_tax_id: 'TIN-123', co_rc: 'RC-456' });
    const a = await A('GET', `/api/admin/dropship/trade/shipments/${imp}/documents/commercial_invoice/pdf`); assert.strictEqual(a.s, 200); assert.match(a.type, /application\/pdf/); assert.strictEqual(a.buf.toString('latin1', 0, 5), '%PDF-');
    const b = await A('GET', `/api/admin/dropship/trade/shipments/${imp}/documents/commercial_invoice/pdf`);
    assert.strictEqual(pdfText(a), pdfText(b), 'identical on the second print'); assert.match(a.t.slice(0, 20000) + pdfText(a), /CI-00001/);
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM trade_issued WHERE shipment_id=$1 AND kind='commercial_invoice'", [imp]))[0].n, 1);
  });
  await test('the commercial invoice names both sides, the goods, HS codes, origin, terms and total', async () => {
    const t = pdfText(await A('GET', `/api/admin/dropship/trade/shipments/${imp}/documents/commercial_invoice/pdf`));
    for (const w of ['COMMERCIAL INVOICE', 'Shenzhen Gadgets Ltd', 'Velto Trading Ltd', 'TIN-123', 'Wireless earbuds', '8518.30', 'China', 'Nigeria', 'FOB Free On Board', 'USD', '1,650.00']) assert.ok(t.includes(w), 'missing ' + w);
    assert.ok(!/margin|unit_cost|supplier code/i.test(t), 'no internal data');
  });
  await test('the packing list has weights and no prices; the proforma says it is not a demand for payment', async () => {
    const pl = pdfText(await A('GET', `/api/admin/dropship/trade/shipments/${imp}/documents/packing_list/pdf`));
    assert.ok(pl.includes('PACKING LIST') && pl.includes('PL-00001') && pl.includes('22.000') && pl.includes('Packages: not entered')); assert.ok(!pl.includes('12.50') && !pl.includes('1,650.00'), 'no prices on a packing list');
    const pf = pdfText(await A('GET', `/api/admin/dropship/trade/shipments/${imp}/documents/proforma/pdf`)); assert.ok(pf.includes('PROFORMA INVOICE') && pf.includes('PF-00001') && /not a demand for payment/.test(pf));
  });
  await test('the purchase order goes to the supplier (imports only), and the customs sheet carries HS codes, values, weights, origin and destination', async () => {
    const po = pdfText(await A('GET', `/api/admin/dropship/trade/shipments/${imp}/documents/purchase_order/pdf`)); assert.ok(po.includes('PURCHASE ORDER') && po.includes('TPO-00001') && po.includes('Shenzhen Gadgets Ltd') && po.includes('Order total USD: 1,650.00'));
    const cs = pdfText(await A('GET', `/api/admin/dropship/trade/shipments/${imp}/documents/customs_sheet/pdf`));
    for (const w of ['CUSTOMS DATA SHEET', 'CD-00001', '8518.30', '8517.12', 'Customs value', 'Net weight', 'China', 'Nigeria', 'not legal advice']) assert.ok(cs.includes(w), 'missing ' + w);
    assert.strictEqual((await A('GET', `/api/admin/dropship/trade/shipments/${exp}/documents/purchase_order/pdf`)).s, 400, 'export has no purchase order from us');
  });
  await test('numbers go up per document type across shipments, and an empty shipment cannot be documented', async () => {
    const e = await A('GET', `/api/admin/dropship/trade/shipments/${exp}/documents/commercial_invoice/pdf`); assert.match(pdfText(e), /CI-00002/); assert.match(pdfText(e), /Berlin Buyers GmbH/); assert.match(pdfText(e), /CIF Cost, Insurance and Freight/);
    const blank = (await TR('POST', '/shipments', { ...SHIP, party_name: 'Empty Co' })).j.id;
    assert.strictEqual((await A('GET', `/api/admin/dropship/trade/shipments/${blank}/documents/commercial_invoice/pdf`)).s, 400); assert.strictEqual((await A('GET', `/api/admin/dropship/trade/shipments/${imp}/documents/passport/pdf`)).s, 400);
    assert.strictEqual((await TR('DELETE', '/shipments/' + blank)).s, 200, 'an unused draft can be deleted');
  });
  await test('opening a document is recorded in the activity log with who did it', async () => {
    assert.ok(Number((await q("SELECT COUNT(*) n FROM audit_log WHERE detail LIKE 'trade document CI-00001 opened'"))[0].n) >= 2);
    assert.ok(Number((await q("SELECT COUNT(*) n FROM trade_events WHERE shipment_id=$1 AND kind='document'", [imp]))[0].n) >= 5);
  });

  console.log('\nStatus, tracking and customs');
  await test('a shipment moves forward only, and each step asks for what it needs', async () => {
    const S = (id, to, note) => TR('POST', `/shipments/${id}/status`, { to, note });
    assert.strictEqual((await S(imp, 'in_transit')).s, 409, 'cannot skip booking'); assert.strictEqual((await S(imp, 'cleared')).s, 409); assert.strictEqual((await S(imp, 'banana')).s, 400);
    assert.strictEqual((await S(imp, 'booked')).s, 200); assert.strictEqual((await S(imp, 'booked')).j.unchanged, true);
    assert.strictEqual((await S(imp, 'in_transit')).s, 400, 'needs a bill number or container'); assert.match((await S(imp, 'in_transit')).j.error, /airway bill/);
    assert.strictEqual((await TR('PUT', '/shipments/' + imp, { ...SHIP, supplier_id: sup, forwarder: 'DHL Global Forwarding', bill_no: '176-12345675', container_no: '', customs_status: 'docs_ready', eta: '2026-12-22', packages: 12, gross_weight_kg: 30 })).s, 200);
    assert.strictEqual((await S(imp, 'in_transit', 'Left Shenzhen')).s, 200);
    assert.strictEqual((await S(imp, 'draft')).s, 409, 'no way back once moving');
  });
  await test('once the goods are moving the goods and values are fixed, but tracking and customs can still change', async () => {
    assert.strictEqual((await TR('POST', `/shipments/${imp}/items`, line())).s, 409);
    assert.strictEqual((await TR('PUT', '/shipments/' + imp, { ...SHIP, supplier_id: sup, freight: 5 })).s, 409);
    assert.strictEqual((await TR('PUT', '/shipments/' + imp, { ...SHIP, supplier_id: sup, forwarder: 'DHL Global Forwarding', bill_no: '176-12345675', customs_status: 'submitted', eta: '2026-12-24' })).s, 200);
    const d = (await TR('GET', '/shipments/' + imp)).j; assert.strictEqual(d.shipment.customs_status, 'submitted'); assert.strictEqual(d.shipment.forwarder, 'DHL Global Forwarding'); assert.strictEqual(d.shipment.locked, true);
    assert.ok(d.events.some((e) => /Customs status: docs ready to submitted/.test(e.note))); assert.ok(d.events.some((e) => /booked to in transit: Left Shenzhen/.test(e.note)));
  });
  await test('clearing the shipment sets customs to cleared; a delivered or cancelled one is closed', async () => {
    const S = (id, to) => TR('POST', `/shipments/${id}/status`, { to });
    assert.strictEqual((await S(imp, 'arrived')).s, 200); assert.strictEqual((await S(imp, 'cleared')).s, 200);
    assert.strictEqual((await TR('GET', '/shipments/' + imp)).j.shipment.customs_status, 'cleared');
    assert.strictEqual((await S(imp, 'delivered')).s, 200); assert.strictEqual((await S(imp, 'cancelled')).s, 409);
    assert.strictEqual((await TR('PUT', '/shipments/' + imp, { ...SHIP, notes: 'late edit' })).s, 409); assert.strictEqual((await TR('DELETE', '/shipments/' + imp)).s, 409, 'kept for the records');
    assert.strictEqual((await S(exp, 'cancelled')).s, 200); assert.strictEqual((await A('GET', `/api/admin/dropship/trade/shipments/${exp}/documents/packing_list/pdf`)).s, 409, 'no new documents for a cancelled shipment');
    assert.strictEqual((await TR('GET', '/shipments?status=delivered&direction=import')).j.shipments.length, 1); assert.strictEqual((await TR('GET', '/shipments?q=176-1234')).j.shipments.length, 1);
  });

  console.log('\nAttached files');
  const PDFB = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% bill of lading\n').toString('base64');
  let fid;
  await test('files are kept in private storage, listed, opened and removed, and only real documents are accepted', async () => {
    const r = await TR('POST', `/shipments/${imp}/files`, { kind: 'bill_of_lading', name: 'BL 176.pdf', data: PDFB }); assert.strictEqual(r.s, 200, r.t); fid = r.j.id;
    assert.strictEqual((await TR('POST', `/shipments/${imp}/files`, { kind: 'bill_of_lading', name: 'x.pdf', data: 'data:application/pdf;base64,' + Buffer.from('MZ not a pdf').toString('base64') })).s, 400);
    assert.strictEqual((await TR('POST', `/shipments/${imp}/files`, { kind: 'selfie', name: 'x.pdf', data: PDFB })).s, 400);
    assert.strictEqual((await TR('POST', `/shipments/${imp}/files`, { kind: 'permit' })).s, 400);
    const d = (await TR('GET', '/shipments/' + imp)).j; assert.strictEqual(d.files.length, 1); assert.strictEqual(d.files[0].file_name, 'BL 176.pdf'); assert.ok(!JSON.stringify(d).includes('file_key'), 'storage keys never leave the server');
    const f = await A('GET', `/api/admin/dropship/trade/shipments/${imp}/files/${fid}`); assert.strictEqual(f.s, 200); assert.match(f.t, /bill of lading/); assert.strictEqual(f.buf.toString('latin1', 0, 5), '%PDF-');
    assert.strictEqual((await A('GET', `/api/admin/dropship/trade/shipments/${exp}/files/${fid}`)).s, 404, 'a file only opens through its own shipment');
    assert.ok(Number((await q("SELECT COUNT(*) n FROM audit_log WHERE detail LIKE 'trade file opened%'"))[0].n) >= 1);
    assert.strictEqual((await TR('DELETE', `/shipments/${imp}/files/${fid}`)).s, 200); assert.strictEqual((await TR('GET', '/shipments/' + imp)).j.files.length, 0);
  });

  console.log('\nCompliance reminders');
  let ngImp, ngExp, other;
  const titles = (c) => c.items.map((i) => i.title);
  await test('an import into Nigeria lists the Nigerian reminders, with the banned-import list, SON and NAFDAC', async () => {
    ngImp = (await TR('POST', '/shipments', { ...SHIP, party_name: 'Acme China' })).j.id;
    const c = (await TR('GET', '/shipments/' + ngImp)).j.checklist; const t = titles(c).join(' | ');
    for (const w of ['Form M', 'prohibition list', 'SONCAP', 'NAFDAC', 'HS code checked']) assert.ok(t.includes(w), 'missing ' + w);
    assert.ok(!/NEPC|Form NXP/.test(t), 'export reminders do not apply to an import'); assert.ok(/not legal advice/.test(c.note)); assert.ok(c.open >= 5);
  });
  await test('an export from Nigeria lists NEPC registration, Form NXP and the export prohibition list', async () => {
    ngExp = (await TR('POST', '/shipments', { direction: 'export', incoterm: 'FOB', currency: 'USD', party_name: 'Texas Buyers', party_country: 'US', origin_country: 'NG', dest_country: 'US', transport: 'air' })).j.id;
    const t = titles((await TR('GET', '/shipments/' + ngExp)).j.checklist).join(' | ');
    for (const w of ['NEPC export registration', 'Form NXP', 'export prohibition list', 'NAFDAC export']) assert.ok(t.includes(w), 'missing ' + w); assert.ok(!/Form M|SONCAP/.test(t));
  });
  await test('another country pair only gets the general reminders', async () => {
    other = (await TR('POST', '/shipments', { ...SHIP, party_name: 'Berlin Co', party_country: 'DE', origin_country: 'DE', dest_country: 'GH' })).j.id;
    const t = titles((await TR('GET', '/shipments/' + other)).j.checklist).join(' | '); assert.ok(t.includes('HS code checked')); assert.ok(!/Form M|NEPC|SONCAP|NAFDAC/.test(t));
  });
  await test('ticking a reminder records who and when; "does not apply" needs a reason; the open count follows', async () => {
    const c0 = (await TR('GET', '/shipments/' + ngImp)).j.checklist, formM = c0.items.find((i) => /Form M/.test(i.title));
    assert.strictEqual((await TR('PUT', `/shipments/${ngImp}/checklist/${formM.id}`, { status: 'done', note: 'Form M 2026/123 approved' })).s, 200);
    assert.strictEqual((await TR('PUT', `/shipments/${ngImp}/checklist/${c0.items[1].id}`, { status: 'na' })).s, 400);
    assert.strictEqual((await TR('PUT', `/shipments/${ngImp}/checklist/${c0.items[1].id}`, { status: 'na', note: 'Not relevant for this cargo' })).s, 200);
    assert.strictEqual((await TR('PUT', `/shipments/${ngImp}/checklist/999999`, { status: 'done' })).s, 404); assert.strictEqual((await TR('PUT', `/shipments/${ngImp}/checklist/${formM.id}`, { status: 'maybe' })).s, 400);
    const c1 = (await TR('GET', '/shipments/' + ngImp)).j.checklist, f = c1.items.find((i) => i.id === formM.id);
    assert.strictEqual(f.status, 'done'); assert.strictEqual(f.note, 'Form M 2026/123 approved'); assert.ok(f.checked_by); assert.ok(f.checked_at > 0); assert.strictEqual(c1.open, c0.open - 2);
  });
  await test('the rules are data the admin edits: add, change, turn off and delete, with checks on country codes and duplicates', async () => {
    const mk = (o = {}) => ({ from_country: 'DE', to_country: 'GH', direction: 'import', category: 'permit', title: 'Ghana FDA import permit checked', detail: 'Check with the Ghana FDA', authority: 'Ghana FDA', required: true, ...o });
    assert.strictEqual((await TR('POST', '/rules', mk({ from_country: 'ZZZ9' }))).s, 400); assert.strictEqual((await TR('POST', '/rules', mk({ title: '' }))).s, 400); assert.strictEqual((await TR('POST', '/rules', mk({ url: 'javascript:alert(1)' }))).s, 400);
    assert.strictEqual((await TR('POST', '/rules', mk({ product_class: 'nonsense' }))).s, 400);
    const r = await TR('POST', '/rules', mk()); assert.strictEqual(r.s, 200, r.t); assert.strictEqual((await TR('POST', '/rules', mk())).s, 409);
    assert.ok(titles((await TR('GET', '/shipments/' + other)).j.checklist).includes('Ghana FDA import permit checked'));
    assert.strictEqual((await TR('PUT', '/rules/' + r.j.id, mk({ title: 'Ghana FDA import permit (updated)', url: 'https://fdaghana.gov.gh' }))).s, 200);
    assert.ok(titles((await TR('GET', '/shipments/' + other)).j.checklist).includes('Ghana FDA import permit (updated)'));
    assert.strictEqual((await TR('PUT', '/rules/' + r.j.id, mk({ active: false }))).s, 200); assert.ok(!titles((await TR('GET', '/shipments/' + other)).j.checklist).some((t) => /Ghana FDA/.test(t)));
    assert.strictEqual((await TR('DELETE', '/rules/' + r.j.id)).s, 200);
    const all = (await TR('GET', '/rules')).j; assert.ok(all.rules.some((x) => /Form NXP/.test(x.title)) && all.classes.length >= 5);
  });
  await test('a rule that needs a product class appears only when the goods are of that class', async () => {
    assert.ok(!titles((await TR('GET', '/shipments/' + ngImp)).j.checklist).some((t) => /Battery shipping rules/.test(t)));
    await D('PUT', '/trade/classes/batteries', { label: 'Batteries and power banks', action: 'review', keywords: 'battery,batteries,lithium,power bank', hs_prefixes: '8506,8507' });
    await TR('POST', `/shipments/${ngImp}/items`, line({ description: 'Power bank 20000mAh', hs_code: '8507.60' }));
    const d = (await TR('GET', '/shipments/' + ngImp)).j; assert.ok(titles(d.checklist).some((t) => /Battery shipping rules/.test(t))); assert.deepStrictEqual(d.item_classes, ['batteries']);
  });

  console.log('\nRestricted items before listing');
  await test('medicines and weapons are blocked outright, by name or by HS code, and nothing is created', async () => {
    const before = Number((await q('SELECT COUNT(*) n FROM products'))[0].n);
    for (const [name, extra] of [['Paracetamol 500mg Tablets', {}], ['Hunting rifle scope kit with ammunition', {}], ['Wellness item', { hs_code: '3004.90' }]]) {
      const r = await mkProduct(name, extra); assert.strictEqual(r.s, 400, name); assert.match(r.j.error, /cannot be listed/);
    }
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM products'))[0].n), before);
  });
  await test('medicines cannot be un-blocked here while the pharmacy flag is off', async () => {
    const r = await D('PUT', '/trade/classes/medicines', { label: 'Medicines', action: 'review', keywords: 'medicine' }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /PHARMACY_ENABLED/);
    assert.strictEqual((await D('DELETE', '/trade/classes/medicines')).s, 400);
  });
  let bank;
  await test('a battery product is created hidden and needs a person to check the permits before it can be approved', async () => {
    const r = await mkProduct('Zed Fast Charge Power Bank 20000mAh'); assert.strictEqual(r.s, 200, r.t); bank = r.j.id;
    await q("UPDATE products SET images='[\"https://cdn.example.com/a.jpg\"]' WHERE id=$1", [bank]);
    const d = (await D('GET', '/products/' + bank)).j; assert.strictEqual(d.product.listing, 'pending'); assert.strictEqual(d.restriction.action, 'review'); assert.strictEqual(d.restriction.checked, false); assert.match(d.restriction.hits[0].why, /power bank/);
    const no = await D('POST', `/products/${bank}/review`, { decision: 'approved' }); assert.strictEqual(no.s, 400); assert.match(no.j.error, /Check the permits/);
    assert.strictEqual((await D('POST', `/products/${bank}/review`, { decision: 'approved', note: 'ok' })).s, 400, 'a note of a couple of letters is not a check');
    const yes = await D('POST', `/products/${bank}/review`, { decision: 'approved', note: 'Carrier accepts under 100Wh, UN38.3 on file' }); assert.strictEqual(yes.s, 200, yes.t);
    const row = (await q('SELECT listing, restriction_class, compliance_note, compliance_by FROM products p JOIN dropship_products dp ON dp.product_id=p.id WHERE p.id=$1', [bank]))[0];
    assert.strictEqual(row.listing, 'approved'); assert.strictEqual(row.restriction_class, 'batteries'); assert.match(row.compliance_note, /UN38.3/); assert.ok(row.compliance_by);
  });
  await test('the compliance record never reaches the storefront', async () => {
    const t = JSON.stringify((await call('GET', '/api/products?q=Power%20Bank')).j) + JSON.stringify((await call('GET', '/api/products/' + (await q('SELECT slug FROM products WHERE id=$1', [bank]))[0].slug)).j);
    for (const w of ['compliance', 'restriction', 'UN38.3', 'supplier', 'cost']) assert.ok(!t.includes(w), 'storefront data contains ' + w);
  });
  await test('editing the product so it falls in a different class takes it off sale until it is checked again', async () => {
    const cur = (await D('GET', '/products/' + bank)).j.product;
    const r = await D('PUT', '/products/' + bank, { ...cur, name: 'Zed Portable Charger', description: 'Compact charger', brand: 'Zed' });
    assert.strictEqual(r.s, 200, r.t);
    const row = (await q('SELECT p.listing, dp.restriction_class FROM products p JOIN dropship_products dp ON dp.product_id=p.id WHERE p.id=$1', [bank]))[0];
    assert.strictEqual(row.restriction_class, '', 'no longer looks like a battery'); assert.strictEqual(row.listing, 'approved');
    const r2 = await D('PUT', '/products/' + bank, { ...cur, name: 'Zed Charger with lithium cell', description: 'Compact charger', brand: 'Zed' }); assert.strictEqual(r2.s, 200, r2.t);
    const again = (await q('SELECT p.listing, dp.restriction_class, dp.compliance_at FROM products p JOIN dropship_products dp ON dp.product_id=p.id WHERE p.id=$1', [bank]))[0];
    assert.strictEqual(again.restriction_class, 'batteries'); assert.strictEqual(again.listing, 'pending', 'hidden until a person checks again'); assert.strictEqual(again.compliance_at, null);
  });
  await test('rules changed later apply at approval: a class switched to "block" stops an approval, a new class catches new products', async () => {
    await D('PUT', '/trade/classes/batteries', { label: 'Batteries', action: 'block', keywords: 'battery,batteries,lithium,power bank', hs_prefixes: '8506,8507' });
    const blocked = await D('POST', `/products/${bank}/review`, { decision: 'approved', note: 'I checked everything again' }); assert.strictEqual(blocked.s, 400); assert.match(blocked.j.error, /cannot be listed/);
    assert.strictEqual((await mkProduct('Lithium cell pack')).s, 400);
    await D('PUT', '/trade/classes/batteries', { label: 'Batteries', action: 'block', keywords: 'battery,batteries,lithium,power bank', hs_prefixes: '8506,8507', active: false });
    assert.strictEqual((await mkProduct('Lithium cell pack')).s, 200, 'switched off: allowed');
    const k = await D('PUT', '/trade/classes/knives', { label: 'Knives', action: 'block', keywords: 'knife,knives,machete' }); assert.strictEqual(k.s, 200, k.t);
    assert.strictEqual((await mkProduct('Kitchen knife set')).s, 400); assert.strictEqual((await D('PUT', '/trade/classes/Bad Slug!', { label: 'x', action: 'block' })).s, 400);
    assert.strictEqual((await D('POST', '/trade/classify', { name: 'Machete 18 inch' })).j.action, 'block'); assert.strictEqual((await D('DELETE', '/trade/classes/knives')).s, 200);
  });
  await test('the importer rejects blocked items as row errors and flags review items, without stopping the rest', async () => {
    const csv = ['Item No,Product Name,Unit Price,Freight,Qty,Weight (g),HS Code,Country of Origin', 'IM-1,Desk Lamp LED,10,2,5,300,9405.40,CN', 'IM-2,Vitamin C Supplement Gummies,8,2,5,100,2106.90,CN', 'IM-3,Cough Syrup Medicine,6,2,5,200,3004.90,CN'].join('\n');
    await D('PUT', '/trade/classes/food', { label: 'Food, drink and supplements', action: 'review', keywords: 'food,snack,supplement,supplements,vitamin,vitamins', hs_prefixes: '16,17,18,19,20,21,22' });
    const pv = (await D('POST', '/import/preview', { supplier_id: sup, text: csv })).j, by = Object.fromEntries(pv.rows.map((r) => [r.row, r]));
    assert.strictEqual(by[2].status, 'new'); assert.strictEqual(by[2].restricted, ''); assert.strictEqual(by[3].restricted, 'food'); assert.strictEqual(by[4].status, 'error'); assert.match(by[4].errors[0], /Restricted item/);
    const r = await D('POST', '/import/commit', { supplier_id: sup, text: csv, store: 'electronics' }); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.created, 2); assert.strictEqual(r.j.errors, 1);
    const v = (await q("SELECT dp.restriction_class, p.listing FROM dropship_products dp JOIN products p ON p.id=dp.product_id WHERE dp.supplier_sku='IM-2'"))[0]; assert.strictEqual(v.restriction_class, 'food'); assert.strictEqual(v.listing, 'pending');
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM dropship_products WHERE supplier_sku='IM-3'"))[0].n, 0);
  });

  console.log('\nSafety of the data');
  await test('the migration can run again and changes nothing, including the starting rules', async () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '027_trade_documents.sql'), 'utf8');
    const c = async () => (await q('SELECT (SELECT COUNT(*) FROM trade_shipments) s, (SELECT COUNT(*) FROM trade_items) i, (SELECT COUNT(*) FROM trade_rules) r, (SELECT COUNT(*) FROM restricted_classes) c, (SELECT COUNT(*) FROM trade_issued) d'))[0];
    const before = await c(); await q(sql); await q(sql); assert.deepStrictEqual(await c(), before, 'edited and deleted rules are not brought back');
  });
  await test('every change to shipments, rules and classes is in the activity log', async () => {
    const n = Number((await q("SELECT COUNT(*) n FROM audit_log WHERE path LIKE '/api/admin/dropship/trade/%' AND method <> 'GET'"))[0].n); assert.ok(n >= 40, 'only ' + n);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { srv.kill(); } catch { /* */ }
  await sleep(300);
  try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ }
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e, '\n--- server log ---\n' + log.slice(-2500)); try { srv.kill(); } catch { /* */ } try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ } process.exit(1); });
