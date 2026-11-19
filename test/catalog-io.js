'use strict';
// Bulk product import and export: template, reading xlsx/csv, column mapping, validation (missing fields, bad numbers, bad categories, duplicates),
// create and update modes, thousands of rows, error report, export filters, and that products without photos work.
// Run with: npm run test:catalog   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const ExcelJS = require('exceljs');
const { Client: Pg } = require('pg');

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
const raw = async (method, url, body, cookie) => fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (method, url, body, cookie) => {
  const r = await raw(method, url, body, cookie);
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  if (process.env.DEBUG_V && r.status >= 400) console.log('   [' + r.status + '] ' + method + ' ' + url + ' ' + t.slice(0, 300));
  return { s: r.status, j, t, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + r.t); return r.c; };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const xlsxB64 = async (rows) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Products'); rows.forEach((r) => ws.addRow(r)); return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'); };
// what the browser does after the mapping step: turn each file row into the VELTO-MART fields
const canon = (parsed, mapping = parsed.mapping) => parsed.rows.map((r) => { const o = { line: r.__line }; for (const [k, h] of Object.entries(mapping)) o[k] = h ? r[h] : ''; return o; });

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-cat-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, '/api/admin/catalog' + u, b, admin);
  const fields = (await A('GET', '/fields')).j;
  const cat = fields.lookups.categories[0], dept = (await q('SELECT name FROM stores WHERE slug=$1', [cat.store]))[0].name;
  const cat2 = fields.lookups.categories.find((c) => c.store !== cat.store);
  const before = Number((await q('SELECT COUNT(*) n FROM products'))[0].n);
  const H = ['Product Name', 'Internal Reference', 'Barcode', 'Department', 'Category', 'Subcategory', 'Brand', 'Description', 'Cost Price', 'Selling Price', 'Wholesale Price', 'Quantity', 'Minimum Stock', 'Unit of Measure', 'Product Status', 'Tax', 'Weight', 'Partner'];
  const good = (n, extra = {}) => ({ line: n + 1, name: 'Imp Product ' + n, sku: 'IMP-' + n, barcode: '', department: '', category: cat.name, price: '1500', stock: '10', ...extra });

  console.log('\nAccess');
  await test('only a signed-in admin can use the import and export tools', async () => {
    for (const [m, u] of [['GET', '/template.xlsx'], ['GET', '/export'], ['GET', '/history'], ['POST', '/validate'], ['POST', '/parse'], ['POST', '/commit']]) assert.ok([401, 403].includes((await call(m, '/api/admin/catalog' + u, m === 'POST' ? {} : undefined)).s), m + ' ' + u);
    const reg = await call('POST', '/api/auth/register', { name: 'Shopper', email: 'shopper@example.com', phone: '08031234567', password: 'Quartz-Meadow-2026!' }); assert.strictEqual(reg.s, 200, reg.t);
    const cust = reg.c || await login('shopper@example.com', 'Quartz-Meadow-2026!');
    for (const u of ['/export', '/template.xlsx', '/history']) assert.ok([401, 403].includes((await call('GET', '/api/admin/catalog' + u, undefined, cust)).s), 'a customer is blocked from ' + u);
  });

  console.log('\nTemplate');
  await test('the Excel template has the Products sheet with every required column, plus instructions, example, departments and partners', async () => {
    const r = await raw('GET', '/api/admin/catalog/template.xlsx', undefined, admin); assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /\.xlsx/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['Products', 'Instructions', 'Example', 'Departments', 'Partners']);
    const heads = wb.getWorksheet('Products').getRow(1).values.slice(1).filter(Boolean);
    for (const h of H) assert.ok(heads.includes(h), 'missing column ' + h);
    for (let i = 2; i <= 6; i++) assert.ok(wb.getWorksheet('Products').getRow(i).values.every((v) => v == null || v === ''), 'the Products sheet has no sample rows to import by accident');
    assert.ok(wb.getWorksheet('Departments').rowCount > 5);
  });

  console.log('\nReading files and mapping columns');
  await test('an .xlsx made from the template is read and its columns map automatically', async () => {
    const r = await A('POST', '/parse', { filename: 'products.xlsx', data: await xlsxB64([H, ['Tea Pack', 'T-1', '600111', dept, cat.name, '', 'Lipton', 'Black tea', 800, 1200, 1000, 40, 5, 'pcs', 'Active', 7.5, 0.25, '']]) });
    assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.rows.length, 1);
    for (const f of fields.fields) assert.strictEqual(r.j.mapping[f.key], f.header, f.key);
  });
  await test('a CSV with different column names (and semicolons) still maps, and the admin can remap columns', async () => {
    const csv = 'Title;Code;Cost;Retail Price;Qty;Brand name\r\nCoke 50cl;CK-50;100;250;24;Coca-Cola\r\n';
    const r = await A('POST', '/parse', { filename: 'stock.csv', data: b64(csv) }); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual(r.j.mapping.name, 'Title'); assert.strictEqual(r.j.mapping.sku, 'Code'); assert.strictEqual(r.j.mapping.cost_price, 'Cost'); assert.strictEqual(r.j.mapping.price, 'Retail Price'); assert.strictEqual(r.j.mapping.stock, 'Qty');
    assert.strictEqual(r.j.mapping.brand, '', '"Brand name" is not guessed; the admin maps it');
    const rows = canon(r.j, { ...r.j.mapping, brand: 'Brand name', category: '' }).map((x) => ({ ...x, category: cat.name }));
    const v = (await A('POST', '/validate', { rows, mode: 'create' })).j; assert.strictEqual(v.summary.error, 0, JSON.stringify(v.results));
  });
  await test('files that are not xlsx/csv, empty, or corrupt are refused with a clear message', async () => {
    assert.strictEqual((await A('POST', '/parse', { filename: 'a.pdf', data: b64('x') })).s, 400);
    assert.strictEqual((await A('POST', '/parse', { filename: 'a.csv', data: b64('') })).s, 400);
    const bad = await A('POST', '/parse', { filename: 'a.xlsx', data: b64('this is not a spreadsheet') }); assert.strictEqual(bad.s, 400); assert.match(bad.j.error, /could not be read|could not read/i);
    const onlyHead = await A('POST', '/parse', { filename: 'a.csv', data: b64('Product Name,Selling Price\r\n') }); assert.strictEqual(onlyHead.s, 400);
  });

  console.log('\nChecking a file before anything is saved');
  await test('every kind of problem is found and explained, row by row', async () => {
    const rows = [
      good(1), // fine
      good(2, { name: '' }), // missing name
      good(3, { price: 'abc' }), // bad price
      good(4, { price: '-5' }), // negative price
      good(5, { stock: '-2' }), // negative quantity
      good(6, { stock: '2.5' }), // fractional quantity
      good(7, { category: 'No Such Category' }), // wrong category
      good(8, { price: '' }), // missing price
      good(9, { category: '' }), // missing category
      good(10, { wholesale_price: '9999' }), // wholesale above retail
      good(11, { status: 'maybe' }), // bad status
      good(12, { sku: 'DUP-A' }), good(13, { sku: 'DUP-A' }), // duplicate SKU in file
      good(14, { barcode: '5551' }), good(15, { barcode: '5551' }), // duplicate barcode in file
      good(16, { department: 'Nowhere' }), // bad department
      good(17, { price: '1,500.50' }), // formatted money, rounded with a warning
      good(18, { tax: '150' }), // tax out of range
      good(19, { barcode: 'bad code!' }), // bad barcode characters
      good(20, { partner: 'Ghost Partner' }), // unknown partner
    ];
    const v = (await A('POST', '/validate', { rows, mode: 'create' })).j; const by = (n) => v.results.find((r) => r.line === n + 1);
    assert.strictEqual(by(1).errors.length, 0);
    const says = (n, re) => assert.ok(by(n).errors.some((e) => re.test(e)), `row ${n}: ${JSON.stringify(by(n).errors)}`);
    says(2, /Product Name is required/); says(3, /Selling Price.*not a number/); says(4, /Selling Price.*negative/); says(5, /Quantity.*negative/); says(6, /Quantity.*whole number/);
    says(7, /Category.*does not exist/); says(8, /Selling Price is required/); says(9, /Category is required/); says(10, /Wholesale Price.*higher/); says(11, /Product Status/);
    says(12, /appears more than once/); says(13, /appears more than once/); says(14, /Barcode.*more than once/); says(15, /Barcode.*more than once/); says(16, /Department/); says(18, /Tax/); says(19, /Barcode/); says(20, /Partner/);
    assert.strictEqual(by(17).errors.length, 0); assert.ok(by(17).warnings.some((w) => /rounded/.test(w)));
    assert.strictEqual(v.summary.total, 20); assert.strictEqual(v.summary.error, 18);
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM products'))[0].n), before, 'checking saves nothing');
  });
  await test('a category that exists in two departments needs the Department column; the right department resolves it', async () => {
    if (!cat2) return;
    await q('INSERT INTO categories (store,slug,name,icon,sort) VALUES ($1,$2,$3,$4,99)', [cat2.store, 'twin-' + tag, cat.name, '🛍']);
    const v = (await A('POST', '/validate', { rows: [good(30), good(31, { department: dept })], mode: 'create' })).j;
    assert.ok(v.results[0].errors.some((e) => /several departments/.test(e)), JSON.stringify(v.results[0].errors)); assert.strictEqual(v.results[1].errors.length, 0);
    await q('DELETE FROM categories WHERE slug=$1', ['twin-' + tag]);
  });
  await test('pharmacy products cannot be bulk imported', async () => {
    const ph = (await q("SELECT c.name, s.name AS sname FROM categories c JOIN stores s ON s.slug=c.store WHERE c.store='pharmacy' LIMIT 1"))[0];
    if (!ph) return;
    const v = (await A('POST', '/validate', { rows: [good(40, { category: ph.name, department: ph.sname })], mode: 'create' })).j;
    assert.ok(v.results[0].errors.length > 0, 'refused');
  });

  console.log('\nCreating products');
  let importId;
  await test('valid rows are created WITHOUT photos; bad rows are reported and skipped; nothing is silently dropped', async () => {
    const rows = [good(100), good(101, { barcode: '7770001', brand: 'Acme', cost_price: '900', price: '1500', wholesale_price: '1200', min_stock: '5', unit: 'pcs', tax: '7.5', weight: '0.4kg', status: 'Inactive', description: 'Nice' }), good(102, { price: 'oops' }), good(103, { category: 'Nope' })];
    const c = await A('POST', '/commit', { rows, mode: 'create', filename: 'first.csv', total: rows.length }); assert.strictEqual(c.s, 200, c.t);
    importId = c.j.importId; assert.deepStrictEqual([c.j.created, c.j.updated, c.j.failed], [2, 0, 2]);
    const p = (await q("SELECT * FROM products WHERE sku='IMP-101'"))[0];
    assert.strictEqual(p.images, '[]', 'no photo needed'); assert.strictEqual(p.barcode, '7770001'); assert.strictEqual(p.brand, 'Acme'); assert.strictEqual(Number(p.cost_price), 900); assert.strictEqual(Number(p.wholesale_price), 1200);
    assert.strictEqual(Number(p.min_stock), 5); assert.strictEqual(p.unit, 'pcs'); assert.strictEqual(Number(p.tax_pct), 7.5); assert.strictEqual(Number(p.weight_kg), 0.4); assert.strictEqual(p.active, 0); assert.strictEqual(p.store, cat.store); assert.ok(p.emoji, 'placeholder emoji for the shop to show');
    const p0 = (await q("SELECT * FROM products WHERE sku='IMP-100'"))[0]; assert.strictEqual(p0.active, 1, 'blank status means Active'); assert.strictEqual(Number(p0.price), 1500); assert.strictEqual(Number(p0.stock), 10); assert.ok(p0.slug);
    assert.strictEqual((await q("SELECT COUNT(*) n FROM products WHERE sku IN ('IMP-102','IMP-103')"))[0].n, '0');
  });
  await test('importing the same file again does not create duplicates or overwrite anything', async () => {
    const rows = [good(100), good(101, { barcode: '7770001', price: '99999' })];
    const c = (await A('POST', '/commit', { rows, mode: 'create', filename: 'again.csv', total: 2 })).j;
    assert.deepStrictEqual([c.created, c.updated, c.failed], [0, 0, 2]);
    assert.ok(c.errors[0].problems.some((p) => /already exists/.test(p)));
    assert.strictEqual(Number((await q("SELECT price FROM products WHERE sku='IMP-101'"))[0].price), 1500, 'the existing price is untouched');
    assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM products WHERE sku='IMP-100'"))[0].n), 1);
  });
  await test('an existing barcode is refused even with a new reference', async () => {
    const v = (await A('POST', '/validate', { rows: [good(110, { barcode: '7770001' })], mode: 'create' })).j;
    assert.ok(v.results[0].errors.some((e) => /Barcode.*already belongs/.test(e)));
  });
  await test('a possible duplicate (same name and brand) is a warning the admin sees, not a silent merge', async () => {
    const v = (await A('POST', '/validate', { rows: [good(100, { sku: 'NEW-SKU', name: 'Imp Product 101', brand: 'Acme' })], mode: 'create' })).j;
    assert.strictEqual(v.results[0].errors.length, 0); assert.ok(v.results[0].warnings.some((w) => /possible duplicate/.test(w)));
  });
  await test('the import is recorded, and its error report downloads as a CSV listing each failed row and why', async () => {
    const h = (await A('GET', '/history')).j.history; const imp = h.find((x) => Number(x.id) === importId);
    assert.ok(imp && imp.kind === 'import' && imp.filename === 'first.csv'); assert.deepStrictEqual([imp.created_n, imp.updated_n, imp.failed_n, imp.total], [2, 0, 2, 4]);
    const r = await raw('GET', `/api/admin/catalog/history/${importId}/errors.csv`, undefined, admin); assert.strictEqual(r.status, 200); const t = await r.text();
    assert.match(t, /Line in your file,Product Name/); assert.match(t, /Imp Product 102/); assert.match(t, /not a number/); assert.match(t, /does not exist/);
  });
  await test('imported products appear in the shop with the placeholder and open normally', async () => {
    const p = (await q("SELECT slug FROM products WHERE sku='IMP-100'"))[0];
    const r = await call('GET', '/api/products/' + p.slug); assert.ok([200].includes(r.s), 'product page ' + r.s + ' ' + r.t.slice(0, 120));
    assert.ok(JSON.stringify(r.j).includes('Imp Product 100'));
  });

  console.log('\nUpdating existing products');
  await test('update mode shows exactly what will change, and changes nothing without the explicit confirmation', async () => {
    const rows = [{ line: 2, sku: 'IMP-100', price: '1750', stock: '25', brand: 'Newbrand' }];
    const v = (await A('POST', '/validate', { rows, mode: 'update' })).j; const ch = v.results[0].changes;
    assert.deepStrictEqual(ch.map((c) => c.label).sort(), ['Brand', 'Quantity', 'Selling Price']); assert.strictEqual(ch.find((c) => c.label === 'Selling Price').from, 1500); assert.strictEqual(ch.find((c) => c.label === 'Selling Price').to, 1750);
    const no = await A('POST', '/commit', { rows, mode: 'update', total: 1 }); assert.strictEqual(no.s, 400);
    assert.strictEqual(Number((await q("SELECT price FROM products WHERE sku='IMP-100'"))[0].price), 1500, 'not changed yet');
    const yes = await A('POST', '/commit', { rows, mode: 'update', total: 1, confirmUpdate: true, filename: 'upd.csv' }); assert.strictEqual(yes.s, 200, yes.t); assert.deepStrictEqual([yes.j.created, yes.j.updated, yes.j.failed], [0, 1, 0]);
    const p = (await q("SELECT price, stock, brand, name, wholesale_price FROM products WHERE sku='IMP-100'"))[0];
    assert.deepStrictEqual([Number(p.price), Number(p.stock), p.brand, p.name], [1750, 25, 'Newbrand', 'Imp Product 100'], 'only the filled-in columns changed; blank cells kept the old values');
  });
  await test('products are matched by Barcode when there is no reference, and blank cells never wipe existing data', async () => {
    const rows = [{ line: 2, barcode: '7770001', price: '1600', brand: '', description: '' }];
    const c = (await A('POST', '/commit', { rows, mode: 'update', total: 1, confirmUpdate: true })).j; assert.strictEqual(c.updated, 1, JSON.stringify(c));
    const p = (await q("SELECT price, brand, description, unit FROM products WHERE barcode='7770001'"))[0]; assert.deepStrictEqual([Number(p.price), p.brand, p.description, p.unit], [1600, 'Acme', 'Nice', 'pcs']);
  });
  await test('unknown references, rows with no reference, ambiguous references and unchanged rows are handled safely', async () => {
    await q("INSERT INTO products (slug,store,category_id,name,price,sku,created) VALUES ('twin-1',$1,$2,'Twin 1',100,'TWIN',1),('twin-2',$1,$2,'Twin 2',100,'TWIN',1)", [cat.store, cat.id]);
    const v = (await A('POST', '/validate', { rows: [{ line: 2, sku: 'NOPE-1', price: '5' }, { line: 3, price: '5' }, { line: 4, sku: 'TWIN', price: '5' }, { line: 5, sku: 'IMP-100', price: '1750' }], mode: 'update' })).j;
    assert.match(v.results[0].errors[0], /No existing product matches/); assert.match(v.results[1].errors[0], /Internal Reference or Barcode/); assert.match(v.results[2].errors[0], /2 products share/);
    assert.strictEqual(v.results[3].errors.length, 0); assert.ok(v.results[3].warnings.some((w) => /No changes/.test(w)));
    const c = (await A('POST', '/commit', { rows: [{ line: 2, sku: 'NOPE-1', price: '5' }], mode: 'update', total: 1, confirmUpdate: true })).j; assert.deepStrictEqual([c.updated, c.failed], [0, 1]);
    assert.strictEqual((await q("SELECT COUNT(*) n FROM products WHERE sku='NOPE-1'"))[0].n, '0', 'update mode never creates');
  });
  await test('a wholesale price cannot be pushed above the new selling price', async () => {
    const v = (await A('POST', '/validate', { rows: [{ line: 2, sku: 'IMP-101', price: '1000' }], mode: 'update' })).j;
    assert.ok(v.results[0].errors.some((e) => /below the existing Wholesale Price/.test(e)), JSON.stringify(v.results[0]));
  });

  console.log('\nThousands of products');
  await test('3,000 products: a CSV is read, checked (a large request is allowed on these routes) and imported in chunks with correct counts', async () => {
    const lines = ['Product Name,Internal Reference,Category,Selling Price,Quantity']; for (let i = 0; i < 3000; i++) lines.push(`Bulk Item ${i},BULK-${i},${cat.name},${1000 + i},${i % 50}`);
    lines.push('Bulk Broken,BULK-X,No Such Cat,100,1');
    const t0 = Date.now(); const p = (await A('POST', '/parse', { filename: 'bulk.csv', data: b64(lines.join('\r\n')) })); assert.strictEqual(p.s, 200, p.t); assert.strictEqual(p.j.rows.length, 3001);
    const rows = canon(p.j); const v = await A('POST', '/validate', { rows, mode: 'create' }); assert.strictEqual(v.s, 200, v.t.slice(0, 200)); assert.strictEqual(v.j.summary.error, 1); assert.strictEqual(v.j.summary.create, 3000);
    let id, tot = [0, 0, 0]; for (let i = 0; i < rows.length; i += 500) { const c = (await A('POST', '/commit', { rows: rows.slice(i, i + 500), mode: 'create', filename: 'bulk.csv', total: rows.length, importId: id })).j; id = c.importId; tot = tot.map((x, k) => x + [c.created, c.updated, c.failed][k]); }
    assert.deepStrictEqual(tot, [3000, 0, 1]); assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM products WHERE sku LIKE 'BULK-%'"))[0].n), 3000);
    const h = (await A('GET', '/history')).j.history.find((x) => Number(x.id) === id); assert.deepStrictEqual([h.created_n, h.failed_n, h.total], [3000, 1, 3001]);
    console.log('       (3,001 rows read, checked and saved in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  });
  await test('a file over the row limit is refused with a clear message', async () => {
    const lines = ['Product Name,Selling Price,Category']; for (let i = 0; i < 20001; i++) lines.push(`x${i},1,c`);
    const r = await A('POST', '/parse', { filename: 'huge.csv', data: b64(lines.join('\n')) }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /Split it/);
  });

  console.log('\nExport');
  const exportRows = async (qs, fmt = 'xlsx') => {
    const r = await raw('GET', '/api/admin/catalog/export?' + qs + '&format=' + fmt, undefined, admin); assert.strictEqual(r.status, 200, qs); const buf = Buffer.from(await r.arrayBuffer());
    if (fmt === 'csv') return { text: buf.toString('utf8'), count: Number(r.headers.get('x-row-count')) };
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); const ws = wb.worksheets[0]; const head = ws.getRow(1).values.slice(1); const rows = [];
    for (let i = 2; i <= ws.rowCount; i++) { const v = ws.getRow(i).values.slice(1), o = {}; head.forEach((h, k) => { o[h] = v[k] == null ? '' : v[k]; }); rows.push(o); }
    return { head, rows, count: Number(r.headers.get('x-row-count')) };
  };
  await test('export to Excel has the template columns and every product; export to CSV opens correctly in Excel (UTF-8 BOM)', async () => {
    const x = await exportRows('filter=all'); for (const h of H) assert.ok(x.head.includes(h), h); assert.ok(x.head.includes('Product ID')); assert.strictEqual(x.count, x.rows.length);
    assert.strictEqual(x.count, Number((await q('SELECT COUNT(*) n FROM products WHERE is_pharmacy=0'))[0].n));
    const c = await exportRows('filter=all', 'csv'); assert.ok(c.text.startsWith('﻿')); assert.match(c.text.split('\n')[0], /Product Name,Internal Reference/);
  });
  await test('every export filter returns the right products', async () => {
    const by = async (qs) => (await exportRows(qs)).rows;
    assert.ok((await by('filter=active')).every((r) => r['Product Status'] === 'Active')); const inact = await by('filter=inactive'); assert.ok(inact.length >= 1 && inact.every((r) => r['Product Status'] === 'Inactive'));
    assert.ok((await by('filter=brand&brand=Acme')).every((r) => r.Brand === 'Acme') && (await by('filter=brand&brand=Acme')).length >= 1);
    const byCat = await by('filter=category&category=' + cat.id); assert.ok(byCat.length > 3 && byCat.every((r) => r.Category === cat.name));
    const ids = (await q("SELECT id FROM products WHERE sku IN ('IMP-100','IMP-101') ORDER BY id")).map((r) => r.id); const sel = await by('filter=selected&ids=' + ids.join(',')); assert.deepStrictEqual(sel.map((r) => r['Internal Reference']).sort(), ['IMP-100', 'IMP-101']);
    assert.strictEqual((await call('GET', '/api/admin/catalog/export?filter=selected', undefined, admin)).s, 400, 'selected needs ids');
    const noimg = await by('filter=missing_images'); assert.ok(noimg.length > 3000 && noimg.every((r) => Number(r.Photos) === 0));
    await q("UPDATE products SET images='[\"https://example.com/a.jpg\"]' WHERE sku='IMP-100'"); assert.ok(!(await by('filter=missing_images')).some((r) => r['Internal Reference'] === 'IMP-100'), 'a product with a photo is not listed as missing one');
    await q("UPDATE products SET stock=2, min_stock=0 WHERE sku='IMP-101'"); await q("UPDATE products SET stock=8, min_stock=5 WHERE sku='IMP-100'");
    const low = await by('filter=low_stock'); assert.ok(low.some((r) => r['Internal Reference'] === 'IMP-101'), 'at or under the default level'); assert.ok(!low.some((r) => r['Internal Reference'] === 'IMP-100'), 'above its own minimum');
    const pid = (await q("INSERT INTO partners (name, active, lat, lng, created) VALUES ('Export Partner', 1, 6.5, 3.4, 1) RETURNING id"))[0].id; await q("UPDATE products SET partner_id=$1 WHERE sku='IMP-101'", [pid]);
    const pp = await by('filter=partner&partner=' + pid); assert.deepStrictEqual(pp.map((r) => r['Internal Reference']), ['IMP-101']); assert.strictEqual(pp[0].Partner, 'Export Partner');
    assert.ok((await by('filter=partner&partner=main')).every((r) => r.Partner === ''));
  });
  await test('exports are logged in the import/export history', async () => {
    const h = (await A('GET', '/history')).j.history; assert.ok(h.some((x) => x.kind === 'export' && x.total > 0 && x.user_name));
  });
  await test('text that Excel would treat as a formula is exported as plain text', async () => {
    await q("UPDATE products SET name='=HYPERLINK(\"http://evil.example\",\"x\")' WHERE sku='IMP-100'");
    const x = await exportRows('filter=selected&ids=' + (await q("SELECT id FROM products WHERE sku='IMP-100'"))[0].id); assert.ok(String(x.rows[0]['Product Name']).startsWith("'="));
    await q("UPDATE products SET name='Imp Product 100' WHERE sku='IMP-100'");
  });
  await test('export, edit and import back: the round trip shows no changes until a cell is edited', async () => {
    const ids = (await q("SELECT id FROM products WHERE sku IN ('IMP-100','IMP-101','BULK-5') ORDER BY id")).map((r) => r.id);
    const r = await raw('GET', '/api/admin/catalog/export?filter=selected&ids=' + ids.join(',') + '&format=xlsx', undefined, admin); const data = Buffer.from(await r.arrayBuffer()).toString('base64');
    const parsed = (await A('POST', '/parse', { filename: 'round.xlsx', data })).j; assert.strictEqual(parsed.mapping.name, 'Product Name'); assert.strictEqual(parsed.mapping.price, 'Selling Price');
    const rows = canon(parsed); let v = (await A('POST', '/validate', { rows, mode: 'update' })).j;
    assert.strictEqual(v.summary.error, 0, JSON.stringify(v.results.filter((x) => x.errors.length))); assert.strictEqual(v.summary.update, 0, 'nothing changed: ' + JSON.stringify(v.results.filter((x) => x.changes.length)));
    rows[0].price = String(Number(rows[0].price) + 50); v = (await A('POST', '/validate', { rows, mode: 'update' })).j; assert.strictEqual(v.summary.update, 1);
  });

  srv.kill(); await sleep(300);
  await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); srv && srv.kill(); console.error(log.slice(-2500)); process.exit(1); });
