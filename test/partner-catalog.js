'use strict';
// Partner store bulk import/export and partner reports.
// Run with: npm run test:partner-catalog   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_pcat_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500);
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
const call = async (method, url, body, cookie, raw) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: raw ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const buf = Buffer.from(await r.arrayBuffer()); const t = buf.toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  if (process.env.DEBUG_V && r.status >= 400) console.log('   [' + r.status + '] ' + method + ' ' + url + ' ' + t.slice(0, 200));
  return { s: r.status, j, t, buf, h: r.headers, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + email + ' ' + r.t); return r.c; };
const PW = 'Wholesale-Test-Pass-2026!';
// Wholesale stock lives in the warehouse (separate from retail products.stock).
const stockOf = async (id) => { const r = (await q('SELECT on_hand - reserved AS a FROM wholesale_stock_balances WHERE product_id=$1', [id]))[0]; return r ? Number(r.a) : 0; };
const setAvail = async (ids, n) => { const wh = (await q("SELECT id FROM wholesale_warehouses WHERE code='MAIN'"))[0].id; for (const id of ids) await q('INSERT INTO wholesale_stock_balances (product_id,warehouse_id,on_hand,reserved,updated) VALUES ($1,$2,$3,0,1) ON CONFLICT (product_id,warehouse_id) DO UPDATE SET on_hand = wholesale_stock_balances.reserved + $3', [id, wh, n]); };
const appBody = (o = {}) => ({ business_name: 'Ada Provisions Ltd', contact_name: 'Ada Obi', phone: '08031234567', address: '5 Trade Fair Road', state: 'Lagos', city: 'Ojo', reg_no: 'RC445566', business_type: 'Retailer', buys: 'Rice, beans and cooking oil for my shops', est_monthly: '₦2m', ...o });

const X = require('../lib/xlsx');

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-pcat-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, u, b, admin);
  const T = Math.floor(Date.now() / 1000), PW = 'Quartz-Meadow-2026!';
  const apply = async (key, depts) => { const r = await call('POST', '/api/partners/apply', { name: key + ' Stores', contactName: 'Owner ' + key, email: key + '@example.com', phone: '08031234567', address: '1 Market Rd', state: 'Lagos', city: 'Yaba', regNo: 'RC' + key, about: 'x', password: PW, departments: depts }); assert.ok(r.s === 200 || r.s === 201, r.t); return { c: await login(key + '@example.com', PW), id: Number((await q('SELECT id FROM vendors WHERE email=$1', [key + '@example.com']))[0].id) }; };
  const va = await apply('alpha', ['supermarket', 'food']), vb = await apply('bravo', ['supermarket']);
  const cat = async (store) => (await q('SELECT name FROM categories WHERE store=$1 ORDER BY id LIMIT 1', [store]))[0].name;
  const supCat = await cat('supermarket');
  const PC = (m, u, b, c) => call(m, '/api/partner/catalog' + u, b, c);
  const xl = async (rows) => { const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Products'); rows.forEach((r) => ws.addRow(r)); return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'); };
  const H = ['Product Name', 'Internal Reference', 'Barcode', 'Department', 'Category', 'Selling Price', 'Quantity', 'Wholesale Price', 'Partner'];
  const parse = async (rows, c) => { const r = await PC('POST', '/parse', { filename: 'f.xlsx', data: await xl([H, ...rows]) }, c); assert.strictEqual(r.s, 200, r.t); return r.j; };
  const toRows = (p) => p.rows.map((r) => { const o = { line: r.__line }; Object.entries(p.mapping).forEach(([k, h]) => { o[k] = r[h] || ''; }); return o; });
  const imp = async (c, mode, rows, extra) => { const p = await parse(rows, c); const rr = toRows(p); const v = await PC('POST', '/validate', { rows: rr, mode }, c); assert.strictEqual(v.s, 200, v.t); const m = await PC('POST', '/commit', { rows: rr, mode, total: rr.length, confirmUpdate: true, ...extra }, c); return { p, v: v.j, m }; };

  console.log('\nPartner import');
  await test('only signed-in partner stores can use it', async () => {
    assert.strictEqual((await PC('GET', '/template.xlsx')).s, 401);
    assert.ok([401, 403].includes((await PC('GET', '/template.xlsx', undefined, admin)).s), 'the owner is not a partner store');
  });
  await test('template and fields show only this store\'s departments, with no wholesale or pickup-point columns', async () => {
    const f = (await PC('GET', '/fields', undefined, vb.c)).j; assert.deepStrictEqual(f.lookups.departments.length, 1); assert.ok(!f.fields.some((x) => ['wholesale_price', 'partner'].includes(x.key)));
    const a = (await PC('GET', '/fields', undefined, va.c)).j; assert.strictEqual(a.lookups.departments.length, 2);
    const t = await fetch(`http://127.0.0.1:${PORT}/api/partner/catalog/template.xlsx`, { headers: { Cookie: vb.c } }); assert.strictEqual(t.status, 200); const buf = Buffer.from(await t.arrayBuffer()); assert.strictEqual(buf[0], 0x50);
    const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); assert.ok(!wb.getWorksheet('Partners'), 'no Partners sheet'); assert.ok(!JSON.stringify(wb.getWorksheet('Products').getRow(1).values).includes('Wholesale'));
  });
  await test('new products are created for this store, waiting for review, hidden from customers; our team is told', async () => {
    const r = await imp(va.c, 'create', [['Alpha Rice 5kg', 'AR-1', 'BC-ALPHA-1', 'Supermarket', supCat, 12000, 7, 5000, 'Main Pickup'], ['Alpha Beans', 'AR-2', '', 'Supermarket', supCat, 3000, 3, '', '']]);
    assert.strictEqual(r.m.s, 200, r.m.t); assert.strictEqual(r.m.j.created, 2, r.m.t);
    const rows = await q('SELECT vendor_id, listing, wholesale_price, partner_id, price, stock FROM products WHERE sku = ANY($1)', [['AR-1', 'AR-2']]);
    assert.strictEqual(rows.length, 2); for (const x of rows) { assert.strictEqual(Number(x.vendor_id), va.id); assert.strictEqual(x.listing, 'pending'); assert.strictEqual(x.wholesale_price, null, 'wholesale price ignored'); }
    const pub = JSON.stringify((await call('GET', '/api/products?q=Alpha')).j); assert.ok(!pub.includes('Alpha Rice'), 'pending products are not public');
    assert.ok(Number((await q("SELECT COUNT(*) n FROM notifications WHERE title LIKE '%alpha Stores imported%'"))[0].n) >= 1, 'staff notified');
  });
  await test('a department the store does not sell in is refused; barcodes are unique across the shop without naming other stores\' products', async () => {
    const r = await imp(vb.c, 'create', [['Bravo Food', 'BR-1', '', 'Food', 'x', 100, 1, '', ''], ['Bravo Rice', 'BR-2', 'BC-ALPHA-1', 'Supermarket', supCat, 500, 1, '', '']]);
    const msgs = r.v.results.map((x) => x.errors.join(' | ')).join(' || '); assert.match(msgs, /Department/); assert.match(msgs, /already used by another product/); assert.ok(!msgs.includes('Alpha'), 'must not reveal another store\'s product');
    assert.strictEqual(r.m.j.created, 0);
  });
  await test('another store\'s internal reference is not visible: the same SKU is allowed, and update never touches their product', async () => {
    const c = await imp(vb.c, 'create', [['Bravo Rice', 'AR-1', '', 'Supermarket', supCat, 500, 1, '', '']]); assert.strictEqual(c.m.j.created, 1, c.m.t);
    const u = await imp(vb.c, 'update', [['', 'AR-1', '', '', '', 999, '', '', '']]); assert.strictEqual(u.m.j.updated, 1);
    const alpha = (await q("SELECT price FROM products WHERE sku='AR-1' AND vendor_id=$1", [va.id]))[0]; assert.strictEqual(Number(alpha.price), 12000, 'alpha untouched');
    const bravo = (await q("SELECT price FROM products WHERE sku='AR-1' AND vendor_id=$1", [vb.id]))[0]; assert.strictEqual(Number(bravo.price), 999);
    const x = await imp(vb.c, 'update', [['', '', 'BC-ALPHA-1', '', '', 1, '', '', '']]); assert.strictEqual(x.m.j.updated, 0, 'cannot update another store\'s product by barcode');
  });
  await test('changing a product\'s name sends it back for review; changing price/stock does not', async () => {
    await q("UPDATE products SET listing='approved' WHERE sku='AR-2' AND vendor_id=$1", [va.id]);
    await imp(va.c, 'update', [['', 'AR-2', '', '', '', 3500, 9, '', '']]); assert.strictEqual((await q("SELECT listing FROM products WHERE sku='AR-2' AND vendor_id=$1", [va.id]))[0].listing, 'approved');
    await imp(va.c, 'update', [['Alpha Beans Premium', 'AR-2', '', '', '', '', '', '', '']]); assert.strictEqual((await q("SELECT listing FROM products WHERE sku='AR-2' AND vendor_id=$1", [va.id]))[0].listing, 'pending');
  });
  await test('history, error reports and exports are private to each store', async () => {
    const h = (await PC('GET', '/history', undefined, va.c)).j.history; assert.ok(h.length >= 1 && h.every((x) => Number(x.vendor_id) === va.id));
    const id = h.find((x) => x.kind === 'import').id; const e1 = await fetch(`http://127.0.0.1:${PORT}/api/partner/catalog/history/${id}/errors.csv`, { headers: { Cookie: vb.c } }); assert.strictEqual(e1.status, 404, 'bravo cannot read alpha\'s report');
    const st = await PC('POST', '/commit', { rows: [{ line: 2, name: 'Hijack', sku: 'H', department: 'Supermarket', category: supCat, price: 1 }], mode: 'create', importId: id, total: 1 }, vb.c); assert.strictEqual(st.s, 404, 'cannot append to another store\'s import');
    const ex = await fetch(`http://127.0.0.1:${PORT}/api/partner/catalog/export?format=csv`, { headers: { Cookie: vb.c } }); const csv = await ex.text(); assert.ok(csv.includes('Bravo Rice') && !csv.includes('Alpha'), 'only own products in export');
  });
  await test('size limits: more than 5,000 rows is refused', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ line: i + 2, name: 'N' + i, price: 1 })); assert.strictEqual((await PC('POST', '/validate', { rows, mode: 'create' }, va.c)).s, 400);
  });

  console.log('\nPartner reports');
  const order = async (status, pay, payst, items) => { const o = (await q("INSERT INTO orders (ref,payment_method,payment_status,status,name,email,phone,state,subtotal,total,created) VALUES ($1,$2,$3,$4,'Cust Secret','c@example.com','08099999999','Lagos',$5,$5,$6) RETURNING id", ['PR' + Math.random().toString(36).slice(2, 8), pay, payst, status, items.reduce((s, i) => s + i[1] * i[2], 0), T - 600]))[0].id; for (const [pid, price, qty, vid, comm, nm] of items) await q("INSERT INTO order_items (order_id,product_id,name,price,qty,vendor_id,commission) VALUES ($1,$2,$3,$4,$5,$6,$7)", [o, pid, nm, price, qty, vid, comm]); };
  const pAlpha = Number((await q("SELECT id FROM products WHERE sku='AR-1' AND vendor_id=$1", [va.id]))[0].id), pBravo = Number((await q("SELECT id FROM products WHERE sku='AR-1' AND vendor_id=$1", [vb.id]))[0].id);
  await order('delivered', 'card', 'paid', [[pAlpha, 1000, 3, va.id, 300, 'Alpha Rice 5kg'], [pBravo, 400, 1, vb.id, 40, 'Bravo Rice']]);
  await order('confirmed', 'pod', 'unpaid', [[pAlpha, 1000, 2, va.id, 200, 'Alpha Rice 5kg']]);
  await order('cancelled', 'card', 'paid', [[pAlpha, 1000, 9, va.id, 900, 'Alpha Rice 5kg']]);
  await q("INSERT INTO vendor_payouts (vendor_id,amount,method,reference,note,created) VALUES ($1,1000,'transfer','REF-1','',$2)", [va.id, T]);
  const R = (name, c, qs = '') => call('GET', '/api/partner/reports/' + name + qs, undefined, c);
  await test('sales by product: paid and pay-on-delivery only, own store only, commission and net', async () => {
    const r = (await R('sales-by-product', va.c)).j.report, row = r.rows.find((x) => x.name === 'Alpha Rice 5kg'); assert.strictEqual(row.units, 5); assert.strictEqual(row.sales, 5000); assert.strictEqual(row.commission, 500); assert.strictEqual(row.net, 4500);
    assert.ok(!JSON.stringify(r).includes('Bravo'), 'no other store'); const b = (await R('sales-by-product', vb.c)).j.report; assert.strictEqual(b.summary.find((s) => s.label === 'Sales').value, 400);
  });
  await test('sales by day, my catalogue and payouts', async () => {
    const d = (await R('sales-by-day', va.c)).j.report; assert.strictEqual(d.summary.find((s) => s.label === 'Orders').value, 2);
    const c = (await R('catalogue-status', va.c)).j.report; assert.strictEqual(c.rows.length, 2); assert.ok(c.rows.some((x) => x.status === 'Waiting for review'));
    const p = (await R('payouts', va.c)).j.report; assert.strictEqual(p.summary.find((s) => s.label === 'Paid to you').value, 1000); assert.strictEqual(p.summary.find((s) => s.label === 'Delivered sales').value, 3000); assert.strictEqual(p.rows.length, 1);
  });
  await test('no customer details in any report; unknown report 404; bad dates 400; signed-out 401; owner is not a partner', async () => {
    for (const n of ['sales-by-product', 'sales-by-day', 'catalogue-status', 'payouts']) { const t = JSON.stringify((await R(n, va.c)).j); assert.ok(!/Cust Secret|08099999999|c@example\.com/.test(t), n); }
    assert.strictEqual((await R('nope', va.c)).s, 404); assert.strictEqual((await R('sales-by-day', va.c, '?from=2026-12-31&to=2026-01-01')).s, 400); assert.strictEqual((await R('payouts')).s, 401); assert.ok([401, 403].includes((await R('payouts', admin)).s));
  });
  await test('Excel and CSV downloads work and are formula-safe', async () => {
    await q("UPDATE products SET name='=SUM(1+1)' WHERE id=$1", [pBravo]);
    const g = async (u) => { const r = await fetch(`http://127.0.0.1:${PORT}${u}`, { headers: { Cookie: vb.c } }); const buf = Buffer.from(await r.arrayBuffer()); return { s: r.status, buf, t: buf.toString('utf8') }; };
    const c = await g('/api/partner/reports/catalogue-status/download?format=csv'); assert.strictEqual(c.s, 200); assert.ok(c.t.includes("'=SUM"), 'formula neutralised'); const x = await g('/api/partner/reports/sales-by-product/download?format=xlsx'); assert.strictEqual(x.s, 200); assert.strictEqual(x.buf[0], 0x50);
  });

  srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.split('\n').slice(-15).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { srv.kill(); } catch { /* */ } process.exit(1); });
