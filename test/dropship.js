'use strict';
// Dropshipping: suppliers, supplier documents, performance, dropship products, pricing, review, importer.
// Run with: npm run test:dropship   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_drop_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500);
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
let MEMBER = '';   // dropshipped items are for signed-in customers: once a customer exists, shop calls made without a cookie go out as that customer
const call = async (method, url, body, cookie, raw) => {
  if (!cookie && MEMBER && /^\/api\/(products|cart|checkout|dropshipping)/.test(url)) cookie = MEMBER;
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const buf = Buffer.from(await r.arrayBuffer()), t = buf.toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  if (process.env.DEBUG_V && r.status >= 400) console.log('   [' + r.status + '] ' + method + ' ' + url + ' ' + t.slice(0, 300));
  return { s: r.status, j, t, buf, h: r.headers, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + email + ' ' + r.t); return r.c; };
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% test agreement\n').toString('base64');
const supplier = (o = {}) => ({ name: 'Shenzhen Gadgets Ltd', country: 'CN', currency: 'CNY', contact_name: 'Li Wei', email: 'li@szgadgets.example', whatsapp: '+86 138 0000 0000', address: 'Bao\'an District, Shenzhen', payment_terms: 'Prepaid', payment_days: 0, processing_days: 4, shipping_methods: ['air', 'sea', 'courier'], notes: 'Found via Alibaba', ...o });

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-drop-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50', ALLOW_PRIVATE_IMAGE_HOSTS: '1' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, u, b, admin);
  let sup;

  console.log('\nSuppliers');
  await test('only an administrator can reach the supplier screens', async () => {
    assert.strictEqual((await call('GET', '/api/admin/dropship/suppliers')).s, 401);
    assert.strictEqual((await call('POST', '/api/admin/dropship/suppliers', supplier())).s, 401);
    await call('POST', '/api/auth/register', { name: 'Cus Tomer', email: 'cust@example.com', phone: '08030000000', password: 'mango-river-sky-55' });
    const cust = await login('cust@example.com', 'mango-river-sky-55');
    MEMBER = cust;
    assert.strictEqual((await call('GET', '/api/admin/dropship/suppliers', undefined, cust)).s, 401, 'a customer is not an admin');
  });
  await test('a supplier needs a real country and currency, a valid email, and known shipping methods', async () => {
    assert.strictEqual((await A('POST', '/api/admin/dropship/suppliers', supplier({ name: '' }))).s, 400);
    assert.strictEqual((await A('POST', '/api/admin/dropship/suppliers', supplier({ country: 'ZZ' }))).s, 400);
    assert.strictEqual((await A('POST', '/api/admin/dropship/suppliers', supplier({ country: '' }))).s, 400);
    assert.strictEqual((await A('POST', '/api/admin/dropship/suppliers', supplier({ currency: 'XQX' }))).s, 400);
    assert.strictEqual((await A('POST', '/api/admin/dropship/suppliers', supplier({ email: 'not-an-email' }))).s, 400);
    assert.strictEqual((await A('POST', '/api/admin/dropship/suppliers', supplier({ shipping_methods: ['teleport'] }))).s, 400);
    assert.strictEqual((await A('POST', '/api/admin/dropship/suppliers', supplier({ whatsapp: 'call me' }))).s, 400);
    assert.strictEqual((await A('POST', '/api/admin/dropship/suppliers', supplier({ processing_days: 500 }))).s, 400);
  });
  await test('any country and currency works: China/CNY, Nigeria/NGN, Turkey/TRY, United Kingdom/GBP', async () => {
    const r = await A('POST', '/api/admin/dropship/suppliers', supplier()); assert.strictEqual(r.s, 200, r.t); sup = r.j.id;
    for (const [country, currency] of [['NG', 'NGN'], ['TR', 'TRY'], ['GB', 'GBP']]) assert.strictEqual((await A('POST', '/api/admin/dropship/suppliers', supplier({ name: 'S ' + country, country, currency }))).s, 200);
    const d = (await A('GET', '/api/admin/dropship/suppliers/' + sup)).j.supplier;
    assert.strictEqual(d.country_name, 'China'); assert.deepStrictEqual(d.shipping_methods, ['air', 'sea', 'courier']); assert.strictEqual(d.status, 'active');
  });
  await test('editing keeps what was not sent, and a supplier can be paused', async () => {
    assert.strictEqual((await A('PUT', '/api/admin/dropship/suppliers/' + sup, { processing_days: 6, status: 'paused' })).s, 200);
    const d = (await A('GET', '/api/admin/dropship/suppliers/' + sup)).j.supplier;
    assert.strictEqual(d.processing_days, 6); assert.strictEqual(d.status, 'paused'); assert.strictEqual(d.currency, 'CNY'); assert.strictEqual(d.name, 'Shenzhen Gadgets Ltd');
    assert.strictEqual((await A('PUT', '/api/admin/dropship/suppliers/' + sup, { status: 'active' })).s, 200);
    assert.strictEqual((await A('GET', '/api/admin/dropship/suppliers?status=paused')).j.suppliers.length, 0);
  });
  await test('the supplier list can be searched', async () => {
    assert.strictEqual((await A('GET', '/api/admin/dropship/suppliers?q=shenzhen')).j.suppliers.length, 1);
    assert.strictEqual((await A('GET', '/api/admin/dropship/suppliers?q=' + encodeURIComponent('100%_'))).j.suppliers.length, 0, 'wildcards are escaped');
  });

  console.log('\nDocuments');
  await test('business registration and agreement are stored privately and can be opened by an admin only', async () => {
    const up = await A('POST', `/api/admin/dropship/suppliers/${sup}/documents`, { kind: 'agreement', name: 'agreement.pdf', data: PDF }); assert.strictEqual(up.s, 200, up.t);
    assert.strictEqual((await A('POST', `/api/admin/dropship/suppliers/${sup}/documents`, { kind: 'registration', name: 'reg.pdf', data: PDF })).s, 200);
    const docs = (await A('GET', '/api/admin/dropship/suppliers/' + sup)).j.documents; assert.strictEqual(docs.length, 2);
    assert.ok(!JSON.stringify(docs).includes('file_key'), 'the storage key is never sent to the browser');
    const f = await A('GET', `/api/admin/dropship/suppliers/${sup}/documents/${up.j.id}`);
    assert.strictEqual(f.s, 200); assert.ok(f.t.startsWith('%PDF-')); assert.strictEqual(f.h.get('cache-control'), 'no-store'); assert.match(f.h.get('content-disposition'), /^attachment/);
    assert.strictEqual((await call('GET', `/api/admin/dropship/suppliers/${sup}/documents/${up.j.id}`)).s, 401);
  });
  await test('only real PDF, image or Word files are accepted, whatever the file is called', async () => {
    const fake = 'data:application/pdf;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
    assert.strictEqual((await A('POST', `/api/admin/dropship/suppliers/${sup}/documents`, { kind: 'other', name: 'x.pdf', data: fake })).s, 400);
    assert.strictEqual((await A('POST', `/api/admin/dropship/suppliers/${sup}/documents`, { kind: 'bogus', name: 'x.pdf', data: PDF })).s, 400);
    assert.strictEqual((await A('POST', `/api/admin/dropship/suppliers/${sup}/documents`, { kind: 'other', name: 'x.pdf', data: 'nope' })).s, 400);
  });
  await test('opening a document is written to the activity log, and a document can be removed', async () => {
    const id = (await A('GET', '/api/admin/dropship/suppliers/' + sup)).j.documents[0].id;
    await A('GET', `/api/admin/dropship/suppliers/${sup}/documents/${id}`);
    assert.ok((await q("SELECT 1 FROM audit_log WHERE detail LIKE 'supplier document opened%'")).length >= 1);
    assert.strictEqual((await A('DELETE', `/api/admin/dropship/suppliers/${sup}/documents/${id}`)).s, 200);
    assert.strictEqual((await A('GET', `/api/admin/dropship/suppliers/${sup}/documents/${id}`)).s, 404);
  });

  console.log('\nPerformance');
  await test('orders, late deliveries, cancellations, defects and ratings add up', async () => {
    await A('POST', `/api/admin/dropship/suppliers/${sup}/events`, { kind: 'order', count: 20 });
    await A('POST', `/api/admin/dropship/suppliers/${sup}/events`, { kind: 'late', count: 3, ref: 'SB-AAA111' });
    await A('POST', `/api/admin/dropship/suppliers/${sup}/events`, { kind: 'cancellation', count: 1 });
    await A('POST', `/api/admin/dropship/suppliers/${sup}/events`, { kind: 'defect', count: 2 });
    await A('POST', `/api/admin/dropship/suppliers/${sup}/events`, { kind: 'rating', rating: 5 });
    const r = await A('POST', `/api/admin/dropship/suppliers/${sup}/events`, { kind: 'rating', rating: 4 });
    assert.deepStrictEqual(r.j.performance, { orders: 20, late: 3, cancellations: 1, defects: 2, ratings: 2, rating: 4.5, on_time_pct: 85, cancel_pct: 5, defect_pct: 10 });
    assert.strictEqual((await A('GET', '/api/admin/dropship/suppliers?q=shenzhen')).j.suppliers[0].rating, 4.5);
  });
  await test('a bad rating or event kind is refused', async () => {
    assert.strictEqual((await A('POST', `/api/admin/dropship/suppliers/${sup}/events`, { kind: 'rating', rating: 9 })).s, 400);
    assert.strictEqual((await A('POST', `/api/admin/dropship/suppliers/${sup}/events`, { kind: 'wat' })).s, 400);
  });
  await test('every supplier change is in the activity log, with no file contents', async () => {
    const rows = await q("SELECT path, detail FROM audit_log WHERE path LIKE '/api/admin/dropship/%' AND method<>'GET'");
    assert.ok(rows.length >= 10, 'got ' + rows.length);
    assert.ok(!rows.some((r) => r.detail.includes('JVBER') || r.detail.includes('%PDF')), 'file data must not be logged');
  });


  console.log('\nExchange rates and settings');
  const D = (m, u, b) => A(m, '/api/admin/dropship' + u, b);
  let prodA, cat;
  await test('a product cannot be priced until its currency has a rate (never a guess)', async () => {
    const r = await D('POST', '/products', { supplier_id: sup, supplier_sku: 'NORATE-1', name: 'No rate item', store: 'electronics', cost: 50 });
    assert.strictEqual(r.s, 400); assert.match(r.j.error, /exchange rate for CNY/);
    assert.ok((await D('GET', '/settings')).j.rates.missing.includes('CNY'));
  });
  await test('the admin sets a rate by hand; bad rates and Naira are refused', async () => {
    assert.strictEqual((await D('PUT', '/rates/CNY', { ngn_per_unit: 210 })).s, 200);
    assert.strictEqual((await D('PUT', '/rates/CNY', { ngn_per_unit: 0 })).s, 400);
    assert.strictEqual((await D('PUT', '/rates/CNY', { ngn_per_unit: 'abc' })).s, 400);
    assert.strictEqual((await D('PUT', '/rates/NGN', { ngn_per_unit: 1 })).s, 400);
    assert.strictEqual((await D('PUT', '/rates/QQQ', { ngn_per_unit: 5 })).s, 400);
    const l = (await D('GET', '/settings')).j.rates; assert.strictEqual(l.rates.find((r) => r.currency === 'CNY').ngn_per_unit, 210); assert.ok(!l.missing.includes('CNY'));
  });
  await test('default pricing rules can be changed, and nonsense is refused', async () => {
    assert.strictEqual((await D('PUT', '/settings', { margin_type: 'percent', margin_value: 30, duty_pct: 20, tax_pct: 7.5 })).s, 200);
    assert.strictEqual((await D('PUT', '/settings', { margin_value: -5 })).s, 400);
    assert.strictEqual((await D('PUT', '/settings', { fee_pct: 99 })).s, 400);
    assert.strictEqual((await D('PUT', '/settings', { margin_type: 'lots' })).s, 400);
  });

  console.log('\nDropship products and pricing');
  const prod = (o = {}) => ({ supplier_id: sup, supplier_sku: 'SZ-100', name: 'Zorbix Earbuds Pro', store: 'electronics', brand: 'Soundly', description: 'Bluetooth 5.3 earbuds', cost: 100, ship_cost: 20, processing_days: 3,
    ship_times: { NG: { min: 7, max: 14 } }, weight_kg: 0.12, length_cm: 10, width_cm: 8, height_cm: 4, hs_code: '8518.30', origin_country: 'CN', supplier_stock: 40, ...o });
  await test('a dropship product is created from cost, shipping, duty, tax and margin, and starts as "pending review"', async () => {
    const r = await D('POST', '/products', prod()); assert.strictEqual(r.s, 200, r.t); prodA = r.j.id;
    const d = (await D('GET', '/products/' + prodA)).j;
    assert.strictEqual(d.product.listing, 'pending'); assert.strictEqual(d.product.price, 43050);
    assert.strictEqual(d.pricing.landed, 32508); assert.strictEqual(d.pricing.break_even, d.pricing.break_even); assert.ok(d.pricing.break_even < 43050);
    assert.strictEqual(d.pricing.profit, 9796.25); assert.strictEqual(d.pricing.margin_source, 'shop');
    const row = (await q('SELECT sku, fulfilment, stock, listing FROM products WHERE id=$1', [prodA]))[0];
    assert.strictEqual(row.fulfilment, 'dropship'); assert.strictEqual(row.stock, 40); assert.strictEqual(row.sku, 'DS-' + prodA, 'our own code, not the supplier\'s');
  });
  await test('required facts are checked: SKU, name, cost, department, HS code, country codes, shipping times', async () => {
    for (const bad of [{ supplier_sku: '' }, { name: '' }, { cost: 0 }, { cost: 'x' }, { store: 'nowhere' }, { hs_code: 'ABC' }, { origin_country: 'ZZ' }, { ships_from: 'XYZ' }, { ship_times: { NG: { min: 9, max: 3 } } }, { ship_times: { MARS: { min: 1, max: 2 } } },
      { supplier_id: 99999 }, { margin_type: 'percent', margin_value: -1 }, { duty_pct: 900 }, { images: ['javascript:alert(1)'] }, { supplier_url: 'ftp://x' }, { processing_days: 500 }]) {
      const r = await D('POST', '/products', prod({ supplier_sku: 'BAD-' + Math.random(), ...bad })); assert.strictEqual(r.s, 400, JSON.stringify(bad) + ' -> ' + r.t);
    }
  });
  await test('medicines can never be dropshipped, and the same supplier code cannot be added twice', async () => {
    assert.strictEqual((await D('POST', '/products', prod({ supplier_sku: 'MED-1', store: 'pharmacy' }))).s, 400);
    const dup = await D('POST', '/products', prod({ name: 'Another name' })); assert.strictEqual(dup.s, 409);
    assert.strictEqual((await D('POST', '/products', prod({ supplier_sku: ' sz-100 ' }))).s, 409, 'case and spaces do not make it new');
  });
  await test('the margin rule can be set per product, category and supplier, and the most specific wins', async () => {
    cat = (await q("SELECT id FROM categories WHERE store='electronics' LIMIT 1"))[0].id;
    const p2 = (await D('POST', '/products', prod({ supplier_sku: 'SZ-200', name: 'Margin test', category_id: Number(cat) }))).j.id;
    const src = async () => (await D('GET', '/products/' + p2)).j.pricing.margin_source;
    assert.strictEqual(await src(), 'shop');
    assert.strictEqual((await D('PUT', '/suppliers/' + sup, { margin_type: 'percent', margin_value: 20 })).s, 200); // supplier rule
    assert.strictEqual((await A('PUT', '/api/admin/dropship/suppliers/' + sup, { margin_type: 'percent', margin_value: 20 })).s, 200);
    assert.strictEqual(await src(), 'supplier');
    assert.strictEqual((await D('PUT', '/category-margins/' + cat, { margin_type: 'fixed', margin_value: 5000 })).s, 200);
    assert.strictEqual(await src(), 'category');
    assert.strictEqual((await D('PUT', '/products/' + p2, { margin_type: 'percent', margin_value: 50 })).s, 200);
    const d = (await D('GET', '/products/' + p2)).j; assert.strictEqual(d.pricing.margin_source, 'product'); assert.ok(d.pricing.profit >= d.pricing.landed * 0.5 - 0.01);
    await D('PUT', '/category-margins/' + cat, { margin_type: '' }); await A('PUT', '/api/admin/dropship/suppliers/' + sup, { margin_type: '' });
    await D('PUT', '/products/' + p2, { margin_type: '' });
    assert.strictEqual(await src(), 'shop');
    await D('PUT', '/products/' + p2, { active: false });
  });
  await test('the price preview shows landed cost, fee, break-even and profit without saving', async () => {
    const before = (await q('SELECT COUNT(*)::int n FROM products'))[0].n;
    const r = await D('POST', '/price-preview', { supplier_id: sup, cost: 100, ship_cost: 20, duty_pct: 0, tax_pct: 0 });
    assert.strictEqual(r.s, 200); const p = r.j.pricing;
    assert.strictEqual(p.landed, 25200); assert.ok(p.break_even > 25200 && p.break_even < p.calculated_price); assert.ok(p.profit > 0 && p.fee > 0);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM products'))[0].n, before);
  });
  await test('a manual price is kept, and shows a loss if it is below break-even', async () => {
    assert.strictEqual((await D('PUT', '/products/' + prodA, { price_mode: 'manual', price: 20000 })).s, 200);
    let d = (await D('GET', '/products/' + prodA)).j; assert.strictEqual(d.product.price, 20000); assert.ok(d.pricing.below_break_even); assert.ok(d.pricing.profit < 0);
    assert.ok(d.checks.some((c) => /below break-even/.test(c)));
    assert.strictEqual((await D('PUT', '/products/' + prodA, { price_mode: 'auto' })).s, 200);
    d = (await D('GET', '/products/' + prodA)).j; assert.strictEqual(d.product.price, 43050); assert.ok(!d.pricing.below_break_even);
  });
  await test('a changed exchange rate never moves a live price by itself; "reprice" does it on purpose', async () => {
    await D('PUT', '/rates/CNY', { ngn_per_unit: 230 });
    let d = (await D('GET', '/products/' + prodA)).j; assert.strictEqual(d.product.price, 43050, 'price unchanged'); assert.ok(d.pricing.price_differs); assert.ok(d.pricing.rate_drift_pct > 9);
    await D('POST', `/products/${prodA}/reprice`, {});
    d = (await D('GET', '/products/' + prodA)).j; assert.ok(d.product.price > 43050); assert.strictEqual(d.pricing.rate_drift_pct, 0);
    await D('PUT', '/rates/CNY', { ngn_per_unit: 210 }); await D('POST', `/products/${prodA}/reprice`, {});
  });
  await test('dropship products are not editable through the normal product form', async () => {
    const r = await A('PUT', '/api/admin/products/' + prodA, { name: 'x', store: 'electronics', price: 1 }); assert.strictEqual(r.s, 400); assert.match(r.t, /Dropshipping/);
  });

  console.log('\nReview before going live');
  const visible = async () => (await call('GET', '/api/products/' + (await q('SELECT slug FROM products WHERE id=$1', [prodA]))[0].slug)).s === 200;
  const inSearch = async () => (await call('GET', '/api/products?q=' + encodeURIComponent('Zorbix'))).j.products.length > 0;
  await test('a pending dropship product is invisible to customers: product page, search, listings, sitemap', async () => {
    assert.strictEqual(await visible(), false); assert.strictEqual(await inSearch(), false);
    const slug = (await q('SELECT slug FROM products WHERE id=$1', [prodA]))[0].slug;
    assert.ok(!(await call('GET', '/sitemap.xml')).t.includes(slug));
  });
  await test('approval is refused while there are no photos, no shipping times, or the price loses money', async () => {
    let r = await D('POST', `/products/${prodA}/review`, { decision: 'approved' }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /photo/i);
    await D('PUT', '/products/' + prodA, { images: ['https://cdn.example.com/earbuds.jpg'] });
    const noTimes = (await D('POST', '/products', prod({ supplier_sku: 'NT-1', name: 'No times', ship_times: {}, images: ['https://cdn.example.com/a.jpg'] }))).j.id;
    r = await D('POST', `/products/${noTimes}/review`, { decision: 'approved' }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /shipping times/i);
    await D('PUT', '/products/' + prodA, { price_mode: 'manual', price: 1000 });
    r = await D('POST', `/products/${prodA}/review`, { decision: 'approved' }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /break-even/);
    await D('PUT', '/products/' + prodA, { price_mode: 'auto' });
  });
  await test('rejecting needs a reason; approving makes the product visible', async () => {
    assert.strictEqual((await D('POST', `/products/${prodA}/review`, { decision: 'rejected' })).s, 400);
    assert.strictEqual((await D('POST', `/products/${prodA}/review`, { decision: 'rejected', note: 'Photo is blurry' })).s, 200);
    assert.strictEqual(await visible(), false);
    assert.strictEqual((await D('POST', `/products/${prodA}/review`, { decision: 'approved' })).s, 200);
    assert.strictEqual(await visible(), true); assert.strictEqual(await inSearch(), true);
  });
  await test('a paused supplier hides its products at once; reactivating brings them back', async () => {
    await A('PUT', '/api/admin/dropship/suppliers/' + sup, { status: 'paused' });
    assert.strictEqual(await visible(), false); assert.strictEqual(await inSearch(), false);
    await A('PUT', '/api/admin/dropship/suppliers/' + sup, { status: 'active' });
    assert.strictEqual(await visible(), true);
  });

  console.log('\nWhat customers can and cannot see');
  await test('the product page shows where it ships from and an honest delivery window, and nothing about supplier, cost or margin', async () => {
    const slug = (await q('SELECT slug FROM products WHERE id=$1', [prodA]))[0].slug, r = await call('GET', '/api/products/' + slug);
    assert.strictEqual(r.j.product.dropship.ships_from, 'CN'); assert.strictEqual(r.j.product.dropship.ships_from_name, 'China');
    assert.deepStrictEqual(r.j.product.dropship.eta.NG, { min: 10, max: 19 });      // 3 processing + 7..14 shipping, +2 safety days on the long end
    const raw = r.t.toLowerCase();
    for (const secret of ['shenzhen', 'sz-100', 'supplier', 'landed', 'margin', 'cost', 'cny', '"duty', 'hs_code', '8518', 'li@szgadgets', 'profit']) assert.ok(!raw.includes(secret), 'leaked: ' + secret);
    assert.strictEqual(r.j.product.sku, 'DS-' + prodA);
    const list = JSON.stringify((await call('GET', '/api/products?q=zorbix')).j).toLowerCase();
    for (const secret of ['shenzhen', 'sz-100', 'cost', 'margin']) assert.ok(!list.includes(secret), 'list leaked: ' + secret);
  });
  await test('until the order flow exists, a dropship item cannot be bought', async () => {
    const r = await call('POST', '/api/cart/price', { items: [{ productId: prodA, qty: 1 }], state: 'Lagos' });
    assert.strictEqual(r.j.lines.length, 0); assert.match(r.j.issues[0].message, /cannot be ordered yet/);
    assert.strictEqual((await call('GET', '/api/products/' + (await q('SELECT slug FROM products WHERE id=$1', [prodA]))[0].slug)).j.product.dropship.orderable, false);
  });
  await test('dropship products are never offered wholesale', async () => {
    const r = await A('PUT', '/api/admin/wholesale/products/' + prodA, { wholesale_price: 30000, wholesale_min_qty: 5 }); assert.strictEqual(r.s, 404);
    assert.ok(!(await A('GET', '/api/admin/wholesale/products?q=zorbix')).j.products.some((p) => p.id === prodA));
  });
  await test('our own products still behave exactly as before', async () => {
    const r = await A('POST', '/api/admin/products', { name: 'Plain Own Product', store: 'electronics', price: 5000, stock: 5, active: true }); assert.strictEqual(r.s, 200, r.t);
    const slug = (await q('SELECT slug FROM products WHERE id=$1', [r.j.id]))[0].slug, pg1 = await call('GET', '/api/products/' + slug);
    assert.strictEqual(pg1.s, 200); assert.ok(!pg1.j.product.dropship);
    assert.strictEqual((await call('POST', '/api/cart/price', { items: [{ productId: r.j.id, qty: 2 }], state: 'Lagos' })).j.lines.length, 1);
  });

  console.log('\nImporting a supplier catalogue');
  const imgSrv = http.createServer((req, res) => { if (req.url.startsWith('/img/')) { const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(req.url)]); return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png); } res.writeHead(404).end(); });
  await new Promise((r) => imgSrv.listen(0, '127.0.0.1', r)); const IMG = 'http://127.0.0.1:' + imgSrv.address().port;
  const CSVTXT = [
    'Item No,Product Name,Unit Price,Freight,Qty,Weight (g),HS Code,Country of Origin,Category,Image URLs',
    `SZ-100,Zorbix Earbuds Pro,95,18,40,120,8518.30,China,,`,                              // same supplier SKU as an existing product -> duplicate
    `SZ-300,"Phone Stand, Foldable",12.5,3,200,350,3926.90,China,,${IMG}/img/stand1.png|${IMG}/img/stand2.png`,
    `SZ-301,Smart LED Strip 5m,30,6,,500,9405.40,CN,,${IMG}/img/led.png`,
    `SZ-302,zorbix earbuds pro,99,18,10,120,8518.30,China,,`,                              // same NAME as an existing product, new SKU -> possible duplicate
    `SZ-303,Broken Row,abc,3,5,100,,,,`,                                                   // bad cost -> error
    `,No SKU Row,10,1,1,100,,,,`,                                                          // no SKU -> error
    `SZ-300,Phone Stand Repeat,12.5,3,200,350,,,,`,                                        // repeated in the file
    `SZ-304,Mini Tripod,22,4,60,0.4 kg,9006.91,Narnia,,`,                                  // unknown country + odd weight -> error
  ].join('\n');
  const imp = (o) => D('POST', '/import/preview', { supplier_id: sup, text: CSVTXT, ...o });
  await test('the preview matches columns by their headings and writes nothing', async () => {
    const before = (await q('SELECT COUNT(*)::int n FROM products'))[0].n;
    const r = await imp(); assert.strictEqual(r.s, 200, r.t);
    assert.deepStrictEqual(r.j.missing_fields, []); assert.strictEqual(r.j.headers.length, 10);
    assert.strictEqual(r.j.mapping.sku, 0); assert.strictEqual(r.j.mapping.name, 1); assert.strictEqual(r.j.mapping.cost, 2); assert.strictEqual(r.j.mapping.ship_cost, 3); assert.strictEqual(r.j.mapping.weight, 5); assert.strictEqual(r.j.weight_unit, 'g');
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM products'))[0].n, before, 'preview must not write');
  });
  await test('every row gets a verdict: new, duplicate (SKU), possible duplicate (name), repeated in the file, or error', async () => {
    const r = (await imp()).j, by = Object.fromEntries(r.rows.map((x) => [x.row, x.status]));
    assert.strictEqual(by[2], 'duplicate'); assert.strictEqual(by[3], 'new'); assert.strictEqual(by[4], 'new'); assert.strictEqual(by[5], 'possible_duplicate');
    assert.strictEqual(by[6], 'error'); assert.strictEqual(by[7], 'error'); assert.strictEqual(by[8], 'in_file_duplicate'); assert.strictEqual(by[9], 'error');
    assert.deepStrictEqual(r.summary, { total: 8, duplicate: 1, new: 2, possible_duplicate: 1, error: 3, in_file_duplicate: 1 });
    assert.match(r.rows.find((x) => x.row === 9).errors.join(), /Narnia/); assert.strictEqual(r.rows.find((x) => x.row === 3).weight_kg, 0.35, 'grams converted to kg');
  });
  await test('pasted spreadsheet text (tab separated) works the same as a CSV file', async () => {
    const tsv = 'SKU\tName\tCost\nT-1\tTab Product\t10\nT-2\tTab Two\t20';
    const r = await D('POST', '/import/preview', { supplier_id: sup, text: tsv }); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.summary.new, 2);
  });
  await test('when a column cannot be recognised the admin is asked to map it, and a manual mapping is honoured', async () => {
    const odd = 'Code X,Thing,How much\nQ-1,Odd Product,15';
    let r = await D('POST', '/import/preview', { supplier_id: sup, text: odd }); assert.ok(r.j.missing_fields.length >= 2); assert.strictEqual(r.j.rows.length, 0);
    r = await D('POST', '/import/preview', { supplier_id: sup, text: odd, mapping: { sku: 0, name: 1, cost: 2 } }); assert.deepStrictEqual(r.j.missing_fields, []); assert.strictEqual(r.j.summary.new, 1);
  });
  await test('a file that is empty, too big, an old .xls, or from an unknown supplier is refused with a clear message', async () => {
    assert.strictEqual((await D('POST', '/import/preview', { supplier_id: sup, text: 'only,a,header' })).s, 400);
    assert.strictEqual((await D('POST', '/import/preview', { supplier_id: 99999, text: CSVTXT })).s, 400);
    const xls = 'data:application/vnd.ms-excel;base64,' + Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]).toString('base64');
    const r = await D('POST', '/import/preview', { supplier_id: sup, data: xls, filename: 'old.xls' }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /\.xlsx/);
    const many = 'sku,name,cost\n' + Array.from({ length: 2001 }, (_, i) => `S${i},P${i},1`).join('\n');
    assert.strictEqual((await D('POST', '/import/preview', { supplier_id: sup, text: many })).s, 400);
  });
  await test('only an administrator can import', async () => {
    assert.strictEqual((await call('POST', '/api/admin/dropship/import/preview', { supplier_id: sup, text: CSVTXT })).s, 401);
    assert.strictEqual((await call('POST', '/api/admin/dropship/import/commit', { supplier_id: sup, text: CSVTXT, store: 'electronics' })).s, 401);
  });
  await test('commit creates only the new rows as "pending review", copies their photos into our storage, and skips duplicates', async () => {
    const before = (await q("SELECT COUNT(*)::int n FROM products WHERE fulfilment='dropship'"))[0].n;
    const r = await D('POST', '/import/commit', { supplier_id: sup, text: CSVTXT, store: 'electronics', ship_min: 8, ship_max: 16 }); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual(r.j.created, 2); assert.strictEqual(r.j.skipped, 3); assert.strictEqual(r.j.errors, 3); assert.strictEqual(r.j.images_queued, 2);
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM products WHERE fulfilment='dropship'"))[0].n, before + 2);
    const made = await q("SELECT p.listing, p.images, p.price, dp.supplier_sku, dp.ship_times, dp.weight_kg, dp.origin_country, dp.source_images FROM products p JOIN dropship_products dp ON dp.product_id=p.id WHERE dp.supplier_sku IN ('SZ-300','SZ-301') ORDER BY dp.supplier_sku");
    assert.deepStrictEqual(made.map((m) => m.listing), ['pending', 'pending']); assert.ok(made.every((m) => m.price > 0 && m.origin_country === 'CN'));
    assert.deepStrictEqual(made[0].ship_times, { NG: { min: 8, max: 16 } }); assert.strictEqual(Number(made[0].weight_kg), 0.35);
    const ids = r.j.created_ids; assert.strictEqual(ids.length, 2);
    for (let i = 0; i < 60; i++) { if ((await q("SELECT COUNT(*)::int n FROM dropship_products WHERE source_images<>'[]' AND product_id = ANY($1)", [ids]))[0].n === 0) break; await sleep(250); }
    const after = await q("SELECT dp.supplier_sku, p.images FROM products p JOIN dropship_products dp ON dp.product_id=p.id WHERE p.id = ANY($1) ORDER BY dp.supplier_sku", [ids]);
    assert.strictEqual(JSON.parse(after[0].images).length, 2, 'two photos for the stand'); assert.strictEqual(JSON.parse(after[1].images).length, 1);
    for (const u of JSON.parse(after[0].images)) { assert.ok(u.startsWith('/uploads/'), 'copied into our own storage, not hot-linked: ' + u); assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}${u}`)).status, 200); }
  });
  await test('importing the same file again creates nothing new (safe to press the button twice)', async () => {
    const before = (await q('SELECT COUNT(*)::int n FROM products'))[0].n;
    const r = await D('POST', '/import/commit', { supplier_id: sup, text: CSVTXT, store: 'electronics' }); assert.strictEqual(r.j.created, 0);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM products'))[0].n, before);
  });
  await test('"possible duplicates" are imported only when the admin says so; "update" changes supplier facts but never the live price', async () => {
    const live = (await q("SELECT p.price FROM products p JOIN dropship_products dp ON dp.product_id=p.id WHERE dp.supplier_sku='SZ-100'"))[0].price;
    let r = await D('POST', '/import/commit', { supplier_id: sup, text: CSVTXT, store: 'electronics', import_possible: [5], on_duplicate: 'update' });
    assert.strictEqual(r.j.created, 1, 'row 5 imported on request'); assert.strictEqual(r.j.updated, 3, 'rows 2, 3 and 4 already exist'); assert.strictEqual(r.j.needs_reprice, 1, 'only row 2 changed cost');
    const row = (await q("SELECT p.price, p.listing, dp.cost, dp.ship_cost FROM products p JOIN dropship_products dp ON dp.product_id=p.id WHERE dp.supplier_sku='SZ-100'"))[0];
    assert.strictEqual(Number(row.cost), 95); assert.strictEqual(Number(row.ship_cost), 18); assert.strictEqual(row.price, live, 'live price untouched'); assert.strictEqual(row.listing, 'approved', 'still live');
    const d = (await D('GET', '/products/' + prodA)).j; assert.ok(d.pricing.price_differs, 'the screen tells the admin the price needs a look');
  });
  await test('an import is refused when the supplier currency has no rate', async () => {
    const tr = (await A('POST', '/api/admin/dropship/suppliers', supplier({ name: 'Istanbul Textiles', country: 'TR', currency: 'TRY' }))).j.id;
    const r = await D('POST', '/import/commit', { supplier_id: tr, text: 'sku,name,cost\nA,Scarf,10', store: 'electronics' }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /exchange rate for TRY/);
    assert.strictEqual((await D('POST', '/import/preview', { supplier_id: tr, text: 'sku,name,cost\nA,Scarf,10' })).j.no_rate, 'TRY');
  });
  await test('photo links with unsafe schemes (file:, javascript:) are dropped at import', async () => {
    // blocking private/internal ADDRESSES is covered by the unit tests: this test server allows them only so it can fetch from 127.0.0.1
    const r = await D('POST', '/import/commit', { supplier_id: sup, text: 'sku,name,cost,images\nBAD-IMG,Product with bad photo link,10,file:///etc/passwd javascript:alert(1)', store: 'electronics' });
    assert.strictEqual(r.j.created, 1); assert.strictEqual(r.j.images_queued, 0, 'no valid photo links were kept');
  });
  imgSrv.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  try { srv.kill(); } catch { /* */ }
  await sleep(300);
  try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ }
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e, '\n--- server log ---\n' + log.slice(-2000)); try { srv.kill(); } catch { /* */ } try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ } process.exit(1); });
