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
const call = async (method, url, body, cookie, raw) => {
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

  /*STEP2*/

  console.log(`\n${passed} passed, ${failed} failed`);
  try { srv.kill(); } catch { /* */ }
  await sleep(300);
  try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ }
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e, '\n--- server log ---\n' + log.slice(-2000)); try { srv.kill(); } catch { /* */ } try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ } process.exit(1); });
