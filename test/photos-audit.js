'use strict';
// Partner store bulk import/export and partner reports.
// Run with: npm run test:partner-catalog   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_phau_' + tag;
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
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-phau-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
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

  const png = (n = 0) => { // a tiny valid PNG, different each time
    const b = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'); b[8 + 8 + 4 + 0] = b[16]; return 'data:image/png;base64,' + Buffer.concat([b, Buffer.from('x'.repeat(n))]).toString('base64'); };
  const PH = (c, filename, data) => call('POST', '/api/partner/photos', { filename, data: data === undefined ? png() : data }, c);
  const mk = async (c, rows) => { const r = await imp(c, 'create', rows); assert.ok(r.m.s === 200, r.m.t); };
  const imgs = async (sku) => JSON.parse((await q('SELECT images FROM products WHERE sku=$1', [sku]))[0].images);

  console.log('\nBulk photos');
  await mk(va.c, [['Rice 50kg', 'RICE-001', '6000000000011', 'Supermarket', supCat, 45000, 10, '', ''], ['Beans 25kg', 'BEANS-7', '', 'Supermarket', supCat, 30000, 10, '', '']]);
  await mk(vb.c, [['Bravo Soap', 'SOAP-1', '', 'Supermarket', supCat, 900, 10, '', '']]);
  await test('a photo named after the reference is added to that product; _2 adds another; the barcode works too', async () => {
    const a = await PH(va.c, 'RICE-001.png'); assert.strictEqual(a.s, 200, a.t); assert.strictEqual(a.j.product, 'Rice 50kg'); assert.strictEqual(a.j.count, 1);
    const b = await PH(va.c, 'rice-001_2.PNG'); assert.strictEqual(b.s, 200, b.t); assert.strictEqual(b.j.count, 2);
    const c = await PH(va.c, 'RICE-001 (3).png'); assert.strictEqual(c.j.count, 3);
    const d = await PH(va.c, '6000000000011.png'); assert.strictEqual(d.j.count, 4);
    assert.strictEqual((await imgs('RICE-001')).length, 4);
  });
  await test('a reference that ends in a number is matched as a whole first', async () => {
    const r = await PH(va.c, 'BEANS-7.png'); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.sku, 'BEANS-7');
  });
  await test('a store cannot add photos to another store\'s product, and the answer does not reveal it exists', async () => {
    const r = await PH(va.c, 'SOAP-1.png'); assert.strictEqual(r.s, 404); assert.ok(!/Bravo/i.test(r.t), 'no store or product name leaked'); assert.strictEqual((await imgs('SOAP-1')).length, 0);
  });
  await test('no match, not an image, bad name, and 9th photo are each refused with a clear message', async () => {
    assert.strictEqual((await PH(va.c, 'NOPE-1.png')).s, 404);
    assert.strictEqual((await PH(va.c, 'RICE-001.png', 'data:text/html;base64,PGI+')).s, 400);
    assert.strictEqual((await PH(va.c, 'RICE-001.png', 'data:image/png;base64,' + Buffer.from('not really a png at all').toString('base64'))).s, 400);
    assert.strictEqual((await PH(va.c, '.png')).s, 400);
    for (let i = 0; i < 4; i++) assert.strictEqual((await PH(va.c, 'RICE-001.png', png(i + 1))).s, 200);
    const r = await PH(va.c, 'RICE-001.png', png(9)); assert.strictEqual(r.s, 400); assert.ok(/8 photos/.test(r.t)); assert.strictEqual((await imgs('RICE-001')).length, 8);
  });
  await test('signed-out visitors, customers and the owner cannot use it; the old product listing is not re-opened', async () => {
    assert.strictEqual((await call('POST', '/api/partner/photos', { filename: 'RICE-001.png', data: png() })).s, 401);
    assert.ok([401, 403].includes((await PH(admin, 'RICE-001.png')).s));
    assert.strictEqual((await q("SELECT listing FROM products WHERE sku='RICE-001'"))[0].listing, 'pending');
  });

  console.log('\nActivity log: partner and buyer actions');
  await test('partner changes are recorded as "partner" with who and what; passwords and photo data are never recorded', async () => {
    await PH(va.c, 'BEANS-7_2.png');
    await call('PUT', '/api/partner/me', { phone: '08099999999', bank_account_number: '0123456789', password: 'hunter2hunter2' }, va.c);
    const rows = await q("SELECT * FROM audit_log WHERE actor='partner' ORDER BY id");
    assert.ok(rows.length >= 3 && rows.every((r) => r.user_name && r.created)); assert.ok(rows.some((r) => r.path === '/api/partner/photos'));
    const all = JSON.stringify(rows); assert.ok(!/hunter2|0123456789|iVBOR/.test(all), 'no secrets or photo bytes'); assert.ok(/\[hidden\]/.test(all));
    assert.ok(rows.some((r) => r.status >= 400), 'refused attempts are recorded too'); assert.ok(!rows.some((r) => r.method === 'GET'));
  });
  await test('wholesale buyer changes are recorded as "buyer"', async () => {
    assert.strictEqual((await call('POST', '/api/auth/register', { name: 'Bola Buyer', email: 'bola@buyer.com', phone: '08031230099', password: PW })).s, 200);
    const bc = await login('bola@buyer.com', PW);
    assert.strictEqual((await call('POST', '/api/wholesale/apply', { business_name: 'Bola Traders', contact_name: 'Bola Buyer', phone: '08031234567', address: '5 Trade Road', state: 'Lagos', city: 'Ojo', reg_no: 'RCbola', business_type: 'Retailer', buys: 'Food items', est_monthly: '₦2m', password: 'hunter2hunter2' }, bc)).s, 200);
    const r = (await q("SELECT COUNT(*)::int n FROM audit_log WHERE actor='buyer'"))[0].n; assert.ok(r >= 1, 'a buyer action was recorded, got ' + r); assert.ok(!/hunter2/.test(JSON.stringify(await q("SELECT detail FROM audit_log WHERE actor='buyer'"))));
  });
  await test('the owner sees the log and can filter by who; employees cannot open it', async () => {
    const all = (await A('GET', '/api/admin/audit')).j.log; assert.ok(all.some((l) => l.actor === 'partner'));
    const onlyP = (await A('GET', '/api/admin/audit?actor=partner')).j.log; assert.ok(onlyP.length && onlyP.every((l) => l.actor === 'partner'));
    const byName = (await A('GET', '/api/admin/audit?q=alpha')).j.log; assert.ok(byName.every((l) => /alpha/i.test(l.user_name + l.path)));
    assert.strictEqual((await call('GET', '/api/admin/audit')).s, 401); assert.ok([401, 403].includes((await call('GET', '/api/admin/audit', undefined, va.c)).s));
    await A('PUT', '/api/admin/settings', { store_name: 'VELTO-MART' });
    assert.ok((await q("SELECT 1 FROM audit_log WHERE actor='staff' AND path LIKE '/api/admin/settings%'")).length >= 1, 'staff changes still recorded');
  });

  srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.split('\n').slice(-15).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { srv.kill(); } catch { /* */ } process.exit(1); });
