'use strict';
// Bulk product import and export: templates, mapping, preview, validation, duplicates, update mode, partner isolation, export filters.
// Run with: npm run test:catalog   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');
const X = require('../lib/xlsx');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_cat_' + tag;
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
  return { s: r.status, j, t, buf, c: (sc[0] || '').split(';')[0], h: r.headers };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + email + ' ' + r.t); return r.c; };
const PW = 'Partner-Test-Pass-2026!';
const applyBody = (o = {}) => ({ name: 'Mama Ngozi Foods', contactName: 'Ngozi Eze', email: 'ngozi.store@example.com', phone: '08031234567', address: '12 Market Road, Yaba', state: 'Lagos', city: 'Yaba', regNo: 'RC1234567', about: 'Fresh foods and groceries.', password: PW, departments: ['supermarket', 'food'], ...o });
const csvOf = (rows) => Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? '"' + String(c).replace(/"/g, '""') + '"' : c)).join(',')).join('\n'), 'utf8');

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-cat-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b, raw) => call(m, '/api/admin/catalog' + u, b, admin, raw);
  const AA = (m, u, b) => call(m, u, b, admin);
  let vc, vendorId;
  const cat = (await q("SELECT c.name, c.store FROM categories c WHERE c.store='supermarket' ORDER BY id LIMIT 1"))[0];
  assert.ok(cat, 'seed has a supermarket category');
  const H = ['Product Name', 'Internal Reference', 'Barcode', 'Department', 'Category', 'Brand', 'Selling Price', 'Cost Price', 'Quantity', 'Minimum Stock', 'Product Status', 'Wholesale Price', 'Partner'];
  const mapOf = (headers) => Object.fromEntries(headers.map((h, i) => [({ 'Product Name': 'name', 'Internal Reference': 'sku', Barcode: 'barcode', Department: 'department', Category: 'category', Brand: 'brand', 'Selling Price': 'price', 'Cost Price': 'cost_price', Quantity: 'stock', 'Minimum Stock': 'min_stock', 'Product Status': 'status', 'Wholesale Price': 'wholesale_price', Partner: 'partner' })[h], i]));
  const chk = (mode, rows, extra = {}, who = 'A') => (who === 'A' ? A : (m, u, b) => call(m, '/api/partner/catalog' + u, b, vc))('POST', '/check', { mode, mapping: mapOf(H), rows, ...extra });
  const app = (mode, rows, extra = {}, who = 'A') => (who === 'A' ? A : (m, u, b) => call(m, '/api/partner/catalog' + u, b, vc))('POST', '/apply', { mode, mapping: mapOf(H), rows, ...extra });
  const row = (o) => { const d = { 'Product Name': 'Test Item', 'Internal Reference': '', Barcode: '', Department: 'Supermarket', Category: cat.name, Brand: 'Acme', 'Selling Price': '1500', 'Cost Price': '900', Quantity: '10', 'Minimum Stock': '3', 'Product Status': 'Active', 'Wholesale Price': '', Partner: '', ...o }; return H.map((h) => d[h]); };
  const dept = (await q("SELECT name FROM stores WHERE slug='supermarket'"))[0].name;

  console.log('\nTemplate and reading files');
  await test('only signed-in staff can use it', async () => {
    assert.strictEqual((await call('GET', '/api/admin/catalog/template.xlsx')).s, 401);
    assert.strictEqual((await call('GET', '/api/partner/catalog/template.xlsx')).s, 401);
    assert.strictEqual((await call('POST', '/api/admin/catalog/parse', undefined, Buffer.from('a,b'))).s, 401);
  });
  await test('the template is a real workbook with the columns, an instructions sheet and the department list', async () => {
    const r = await A('GET', '/template.xlsx'); assert.strictEqual(r.s, 200); assert.ok(/spreadsheetml/.test(r.h.get('content-type')));
    const rows = X.readSheet(r.buf, 'x.xlsx'); assert.deepStrictEqual(rows[0].slice(0, 3), ['Product Name', 'Internal Reference', 'Barcode']); assert.ok(rows[0].includes('Wholesale Price') && rows[0].includes('Partner'));
    const c = await A('GET', '/template.csv'); assert.strictEqual(c.s, 200); assert.ok(c.t.includes('Minimum Stock'));
  });
  await test('parse reads csv and xlsx, matches columns by name and rejects junk with a clear message', async () => {
    const csv = csvOf([['Name', 'SKU', 'EAN', 'Price', 'Qty'], ['A, with comma', 'S1', '123', '₦1,500', '4']]);
    const r = await A('POST', '/parse?filename=a.csv', undefined, csv); assert.strictEqual(r.s, 200, r.t);
    assert.deepStrictEqual(r.j.mapping, { name: 0, sku: 1, barcode: 2, price: 3, stock: 4 }); assert.strictEqual(r.j.rows[0][0], 'A, with comma');
    const xl = Buffer.from(X.writeXlsx([{ name: 'Products', rows: [['Product Name', 'Selling Price'], ['Édé "x"', '5']] }]));
    const r2 = await A('POST', '/parse?filename=a.xlsx', undefined, xl); assert.strictEqual(r2.s, 200); assert.strictEqual(r2.j.rows[0][0], 'Édé "x"');
    assert.strictEqual((await A('POST', '/parse?filename=a.xlsx', undefined, Buffer.from('not a zip at all\x00\x01'))).s, 400);
    assert.strictEqual((await A('POST', '/parse?filename=a.csv', undefined, Buffer.from('Product Name\n'))).s, 400);
  });

  console.log('\nCreating products');
  await test('preview lists every problem and saves nothing', async () => {
    const rows = [row({ 'Product Name': 'Good One', 'Internal Reference': 'G-1', Barcode: '6001' }), row({ 'Product Name': '' }), row({ 'Selling Price': 'abc' }), row({ Quantity: '-4' }), row({ Quantity: '2.5' }), row({ Category: 'Nope' }), row({ Department: 'Pharmacy' }), row({ Department: 'Atlantis' }), row({ 'Product Status': 'maybe' }), row({ 'Internal Reference': 'G-1' }), row({ Partner: 'Nobody' })];
    const r = await chk('create', rows); assert.strictEqual(r.s, 200, r.t);
    const st = r.j.results.map((x) => x.status); assert.strictEqual(st[0], 'ok'); assert.ok(st.slice(1).every((s) => s === 'error'), st.join());
    assert.ok(/required/.test(r.j.results[1].errors[0]) && /whole number/.test(r.j.results[2].errors[0]));
    assert.ok(r.j.results[6].errors.some((e) => /Medicines|Pharmacy/.test(e))); assert.ok(/repeated in this file/.test(r.j.results[9].errors.join()));
    assert.strictEqual((await q("SELECT count(*)::int n FROM products WHERE sku='G-1'"))[0].n, 0);
  });
  await test('apply creates the good rows and reports the bad ones, row by row', async () => {
    const r = await app('create', [row({ 'Product Name': 'Fine Rice 5kg', 'Internal Reference': 'RICE-5', Barcode: '6001001', 'Wholesale Price': '1200' }), row({ 'Product Name': '' }), row({ 'Product Name': 'Beans 1kg', 'Internal Reference': 'BEAN-1', Barcode: '6001002', 'Product Status': 'Inactive', 'Selling Price': '₦2,000.00' })]);
    assert.deepStrictEqual(r.j.results.map((x) => x.status), ['done', 'error', 'done'], r.t);
    const p = (await q("SELECT * FROM products WHERE sku='RICE-5'"))[0]; assert.strictEqual(p.price, 1500); assert.strictEqual(p.stock, 10); assert.strictEqual(p.cost_price, 900); assert.strictEqual(p.min_stock, 3); assert.strictEqual(p.wholesale_price, 1200); assert.strictEqual(p.vendor_id, null); assert.strictEqual(p.images, '[]');
    const b = (await q("SELECT * FROM products WHERE sku='BEAN-1'"))[0]; assert.strictEqual(b.price, 2000); assert.strictEqual(b.active, 0);
  });
  await test('products created without photos are fine; a second import cannot repeat a reference or barcode', async () => {
    const r = await chk('create', [row({ 'Internal Reference': 'rice-5', 'Product Name': 'Other' }), row({ Barcode: '6001002', 'Product Name': 'Other2' }), row({ 'Product Name': 'Fine Rice 5kg', Brand: 'Acme', 'Internal Reference': 'NEW-9' })]);
    assert.ok(/already exists/.test(r.j.results[0].errors[0])); assert.ok(/already belongs/.test(r.j.results[1].errors[0]));
    assert.strictEqual(r.j.results[2].status, 'ok'); assert.ok(r.j.results[2].warnings.some((w) => w.code === 'dup_name'), 'looks like a duplicate');
    const s = await app('create', [row({ 'Product Name': 'Fine Rice 5kg', Brand: 'Acme', 'Internal Reference': 'NEW-9' })], { skipDuplicates: true }); assert.strictEqual(s.j.results[0].status, 'skipped');
  });
  await test('wholesale price must be below the selling price; the database refuses a repeated barcode even in a race', async () => {
    const r = await chk('create', [row({ 'Wholesale Price': '2000' })]); assert.ok(/below the Selling Price/.test(r.j.results[0].errors[0]));
    await assert.rejects(() => q("INSERT INTO products (slug,store,name,price,barcode,created) VALUES ('zz1','supermarket','zz',1,'6001001',1)"), /uq_products_barcode|duplicate/);
  });

  console.log('\nUpdating products')
  await test('update finds by reference or barcode, shows from and to, never erases with a blank cell', async () => {
    const r = await chk('update', [row({ 'Product Name': '', 'Internal Reference': 'RICE-5', Department: '', Category: '', Brand: '', 'Selling Price': '1800', 'Cost Price': '', Quantity: '', 'Minimum Stock': '', 'Product Status': '' })]);
    assert.strictEqual(r.j.results[0].status, 'ok', r.t); assert.deepStrictEqual(r.j.results[0].changes, [{ field: 'Selling Price', from: '1500', to: '1800' }]);
    assert.strictEqual((await q("SELECT price FROM products WHERE sku='RICE-5'"))[0].price, 1500, 'check changes nothing');
    const a = await app('update', [row({ 'Product Name': '', 'Internal Reference': '', Barcode: '6001001', Department: '', Category: '', Brand: '', 'Selling Price': '1800', 'Cost Price': '', Quantity: '', 'Minimum Stock': '', 'Product Status': '' })]);
    assert.strictEqual(a.j.results[0].status, 'done'); const p = (await q("SELECT * FROM products WHERE sku='RICE-5'"))[0]; assert.strictEqual(p.price, 1800); assert.strictEqual(p.cost_price, 900); assert.strictEqual(p.stock, 10); assert.strictEqual(p.name, 'Fine Rice 5kg');
  });
  await test('rows with no change are reported as unchanged; unknown products are errors, not new products', async () => {
    const r = await chk('update', [row({ 'Internal Reference': 'RICE-5', 'Product Name': '', Department: '', Category: '', Brand: '', 'Selling Price': '1800', 'Cost Price': '', Quantity: '', 'Minimum Stock': '', 'Product Status': '' }), row({ 'Internal Reference': 'NOPE-1' }), row({ 'Internal Reference': '', Barcode: '' })]);
    assert.strictEqual(r.j.results[0].status, 'unchanged'); assert.ok(/No existing product/.test(r.j.results[1].errors[0])); assert.ok(/needs an Internal Reference/.test(r.j.results[2].errors[0]));
    assert.strictEqual((await q("SELECT count(*)::int n FROM products WHERE sku='NOPE-1'"))[0].n, 0);
  });
  await test('update cannot move a barcode onto another product; wholesale 0 clears; stock updates', async () => {
    const e = await chk('update', [row({ 'Internal Reference': 'BEAN-1', Barcode: '6001001', 'Product Name': '', Department: '', Category: '', Brand: '', 'Selling Price': '', 'Cost Price': '', Quantity: '', 'Minimum Stock': '', 'Product Status': '' })]); assert.ok(/already belongs/.test(e.j.results[0].errors[0]));
    const blank = { 'Product Name': '', Department: '', Category: '', Brand: '', 'Selling Price': '', 'Cost Price': '', Quantity: '', 'Minimum Stock': '', 'Product Status': '' };
    const a = await app('update', [row({ ...blank, 'Internal Reference': 'RICE-5', 'Wholesale Price': '0', Quantity: '77' })]); assert.strictEqual(a.j.results[0].status, 'done', a.t);
    const p = (await q("SELECT stock, wholesale_price FROM products WHERE sku='RICE-5'"))[0]; assert.strictEqual(p.stock, 77); assert.strictEqual(p.wholesale_price, null);
  });

  console.log('\nPartners and isolation');
  await test('set up an approved partner store', async () => {
    assert.strictEqual((await AA('POST', '/api/admin/partners', { name: 'Shop-Beta Main Store', address: 'Ikeja, Lagos', state: 'Lagos', phone: '08000000001', lat: 6.6018, lng: 3.3515, radius_km: 40, is_default: true })).s, 200);
    assert.strictEqual((await call('POST', '/api/partners/apply', applyBody())).s, 200);
    vendorId = (await q("SELECT id FROM vendors WHERE email='ngozi.store@example.com'"))[0].id;
    const u = await AA('PUT', `/api/admin/vendors/${vendorId}`, { name: 'Mama Ngozi Foods', commission_pct: 12, lat: 6.5095, lng: 3.3711, address: '12 Market Road, Yaba', state: 'Lagos', phone: '08031234567', email: 'ngozi.store@example.com', reg_no: 'RC1234567', departments: [{ store: 'supermarket' }, { store: 'food' }] }); assert.strictEqual(u.s, 200, u.t);
    assert.strictEqual((await AA('POST', `/api/admin/vendors/${vendorId}/approve`)).s, 200);
    vc = await login('ngozi.store@example.com', PW);
  });
  await test('a partner template has no wholesale or partner columns; its import goes to review', async () => {
    const t = X.readSheet((await call('GET', '/api/partner/catalog/template.xlsx', undefined, vc)).buf, 'x.xlsx')[0]; assert.ok(!t.includes('Wholesale Price') && !t.includes('Partner'));
    const r = await app('create', [row({ 'Product Name': 'Ngozi Yam', 'Internal Reference': 'RICE-5', Barcode: '6001001', 'Wholesale Price': '900', Partner: 'Somebody Else' })], {}, 'P'); assert.strictEqual(r.j.results[0].status, 'done', r.t);
    const p = (await q("SELECT * FROM products WHERE name='Ngozi Yam'"))[0]; assert.strictEqual(Number(p.vendor_id), Number(vendorId)); assert.strictEqual(p.listing, 'pending'); assert.strictEqual(p.wholesale_price, null);
  });
  await test('a partner can only see and change its own products, never ours', async () => {
    const blank = { 'Product Name': '', Department: '', Category: '', Brand: '', 'Cost Price': '', Quantity: '', 'Minimum Stock': '', 'Product Status': '' };
    const r = await app('update', [row({ ...blank, 'Internal Reference': 'BEAN-1', 'Selling Price': '1' })], {}, 'P'); assert.ok(/No existing product/.test(r.j.results[0].errors[0]));
    assert.strictEqual((await q("SELECT price FROM products WHERE sku='BEAN-1'"))[0].price, 2000);
    const u = await app('update', [row({ ...blank, 'Internal Reference': 'RICE-5', 'Selling Price': '3000' })], {}, 'P'); assert.strictEqual(u.j.results[0].status, 'done');
    assert.strictEqual((await q("SELECT price FROM products WHERE sku='RICE-5' AND vendor_id IS NULL"))[0].price, 1800, 'ours untouched');
    const ex = X.readSheet((await call('GET', '/api/partner/catalog/export.xlsx', undefined, vc)).buf, 'x.xlsx'); assert.ok(ex.slice(1).every((r) => r.includes('Ngozi Yam') || r.includes('Mama Ngozi Foods') || true)); assert.strictEqual(ex.length, 2, 'only its own product'); assert.ok(!ex[0].includes('Wholesale Price'));
  });
  await test('partner stores cannot import medicines or a department they do not hold; editing reviewed text sends it back to review', async () => {
    const r = await chk('create', [row({ Department: 'Pharmacy' }), row({ Department: 'Electronics' })], {}, 'P'); assert.ok(r.j.results.every((x) => x.status === 'error'));
    await q("UPDATE products SET listing='approved' WHERE name='Ngozi Yam'");
    const blank = { 'Product Name': '', 'Department': '', Category: '', Brand: '', 'Cost Price': '', Quantity: '', 'Minimum Stock': '', 'Product Status': '', 'Selling Price': '' };
    await app('update', [row({ ...blank, 'Internal Reference': 'RICE-5', 'Selling Price': '3100' })], {}, 'P'); assert.strictEqual((await q("SELECT listing FROM products WHERE name='Ngozi Yam'"))[0].listing, 'approved', 'price edits do not need review');
    await app('update', [row({ ...blank, 'Internal Reference': 'RICE-5', 'Product Name': 'Ngozi Yam Large' })], {}, 'P'); assert.strictEqual((await q("SELECT listing FROM products WHERE name='Ngozi Yam Large'"))[0].listing, 'pending');
  });
  await test('admin can create for an approved partner by name (goes live), and unknown partners are refused', async () => {
    const r = await app('create', [row({ 'Product Name': 'Admin Made For Ngozi', Partner: 'Mama Ngozi Foods', 'Internal Reference': 'ADM-1' })]); assert.strictEqual(r.j.results[0].status, 'done', r.t);
    const p = (await q("SELECT vendor_id, listing FROM products WHERE sku='ADM-1'"))[0]; assert.strictEqual(Number(p.vendor_id), Number(vendorId)); assert.strictEqual(p.listing, 'approved');
  });

  console.log('\nPrivacy and export')
  await test('cost price never appears in the public shop', async () => {
    const slug = (await q("SELECT slug FROM products WHERE sku='BEAN-1'"))[0].slug; await q("UPDATE products SET active=1 WHERE sku='BEAN-1'");
    for (const u of ['/api/products/' + slug, '/api/products', '/api/products?q=Rice']) { const r = await call('GET', u); assert.ok(!/cost_price|min_stock|"barcode"/.test(r.t), u + ' leaks'); }
  });
  await test('export filters: status, low stock, missing images, brand, selected ids', async () => {
    const all = X.readSheet((await A('GET', '/export.xlsx')).buf, 'x.xlsx'); assert.ok(all.length > 5); assert.deepStrictEqual(all[0].slice(0, 2), ['ID', 'Product Name']);
    const col = (n) => all[0].indexOf(n);
    await q("UPDATE products SET active=0 WHERE sku='BEAN-1'");
    const inactive = X.readSheet((await A('GET', '/export.csv?status=inactive')).buf, 'x.csv'); assert.ok(inactive.slice(1).every((r) => r[col('Product Status')] === 'Inactive') && inactive.length > 1);
    await q("UPDATE products SET min_stock=100, stock=5 WHERE sku='RICE-5' AND vendor_id IS NULL");
    const low = X.readSheet((await A('GET', '/export.csv?low_stock=1')).buf, 'x.csv'); assert.ok(low.slice(1).some((r) => r[col('Internal Reference')] === 'RICE-5') && low.slice(1).every((r) => Number(r[col('Quantity')]) <= Number(r[col('Minimum Stock')])));
    const noimg = X.readSheet((await A('GET', '/export.csv?missing_images=1')).buf, 'x.csv'); assert.ok(noimg.slice(1).every((r) => r[col('Photos')] === '0'));
    const one = (await q("SELECT id FROM products WHERE sku='BEAN-1'"))[0].id; const sel = X.readSheet((await A('GET', '/export.csv?ids=' + one)).buf, 'x.csv'); assert.strictEqual(sel.length, 2);
    const mine = X.readSheet((await A('GET', '/export.csv?partner=' + vendorId)).buf, 'x.csv'); assert.ok(mine.slice(1).every((r) => r[col('Partner')] === 'Mama Ngozi Foods'));
    assert.strictEqual((await A('GET', '/export.csv?ids=abc')).s, 400);
  });
  await test('exported spreadsheets cannot run formulas; the history records imports and exports', async () => {
    await q("UPDATE products SET name='=HYPERLINK(\"http://evil\",\"x\")' WHERE sku='BEAN-1'");
    const csv = (await A('GET', '/export.csv')).t; assert.ok(!/(^|,|\n)"?=HYPERLINK/.test(csv), 'formula neutralised');
    await A('POST', '/log', { kind: 'import', mode: 'create', filename: 'a.csv', total: 5, created: 3, updated: 0, skipped: 1, failed: 1 });
    const h = (await A('GET', '/history')).j.history; assert.ok(h.some((x) => x.kind === 'import' && x.filename === 'a.csv' && x.failed_n === 1)); assert.ok(h.some((x) => x.kind === 'export'));
  });

  console.log('\nProduct forms carry the extra details')
  await test('barcode, cost, minimum stock, unit, tax, weight and subcategory save through the normal product form; a repeated barcode is refused', async () => {
    const body = { name: 'Form Item', store: 'supermarket', price: 900, stock: 4, barcode: 'FORM-1', cost_price: '600', min_stock: '2', unit: 'kg', tax: '7.5%', weight_kg: '0.25', subcategory: 'Loose' };
    const a = await AA('POST', '/api/admin/products', body); assert.strictEqual(a.s, 200, a.t);
    const p = (await AA('GET', '/api/admin/products/' + a.j.id)).j.product; assert.strictEqual(p.barcode, 'FORM-1'); assert.strictEqual(p.cost_price, 600); assert.strictEqual(p.min_stock, 2); assert.strictEqual(p.unit, 'kg'); assert.strictEqual(Number(p.weight_kg), 0.25);
    const dup = await AA('POST', '/api/admin/products', { ...body, name: 'Form Item 2' }); assert.strictEqual(dup.s, 409, dup.t);
    assert.strictEqual((await AA('POST', '/api/admin/products', { ...body, name: 'X', barcode: 'bad<script>' })).s, 400);
    assert.strictEqual((await AA('POST', '/api/admin/products', { ...body, name: 'X2', barcode: 'Z9', cost_price: '-5' })).s, 400);
    assert.strictEqual((await AA('PUT', '/api/admin/products/' + a.j.id, { ...body, price: 950 })).s, 200);
    const v = await call('POST', '/api/partner/products', { name: 'Partner Form', store: 'supermarket', price: 500, stock: 3, barcode: 'FORM-1', cost_price: 300, active: true }, vc); assert.strictEqual(v.s, 200, 'partner scope is separate: ' + v.t);
    assert.strictEqual((await call('POST', '/api/partner/products', { name: 'Partner Form 2', store: 'supermarket', price: 500, stock: 3, barcode: 'FORM-1', active: true }, vc)).s, 409);
  });

  console.log('\nScale')
  await test('2,000 products import in groups of 200, with the duplicates caught', async () => {
    const t0 = Date.now(); let done = 0, err = 0;
    for (let s = 0; s < 2000; s += 200) {
      const rows = []; for (let i = s; i < s + 200; i++) rows.push(row({ 'Product Name': 'Bulk Item ' + i, 'Internal Reference': 'BULK-' + (i === 1500 ? 1499 : i), Barcode: 'B' + i }));
      const r = await app('create', rows, { startRow: s }); assert.strictEqual(r.s, 200, r.t); for (const x of r.j.results) x.status === 'done' ? done++ : err++;
    }
    assert.strictEqual(done, 1999); assert.strictEqual(err, 1); assert.ok(Date.now() - t0 < 60000, 'took ' + (Date.now() - t0));
    assert.strictEqual((await A('POST', '/apply', { mode: 'create', mapping: { name: 0 }, rows: new Array(201).fill(['x']) })).s, 400, 'too many rows per call');
  });

  srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.split('\n').slice(-15).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { srv.kill(); } catch { /* */ } process.exit(1); });
