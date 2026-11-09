'use strict';
// Step 3 check: two identical app instances, photos in (fake) object storage, nothing written to the app's own disk.
// Run with: npm run test:stateless   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_state_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const KEY = 'svc-test-key', SPORT = 4600 + Math.floor(Math.random() * 100), P1 = SPORT + 100, P2 = SPORT + 200;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-state-'));
const objects = new Map();
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };

// Stand-in for Supabase Storage: authenticated upload, public read.
const fake = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const m = /^\/storage\/v1\/object\/(public\/)?([^/]+)\/(.+)$/.exec(req.url.split('?')[0]);
    if (!m) return res.writeHead(404).end();
    const key = m[2] + '/' + decodeURIComponent(m[3]);
    if (req.method === 'POST' && !m[1]) { if (req.headers.authorization !== 'Bearer ' + KEY) return res.writeHead(401).end('{}'); objects.set(key, { body: Buffer.concat(c), type: req.headers['content-type'] }); return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); }
    if (req.method === 'GET' && m[1]) { const o = objects.get(key); return o ? res.writeHead(200, { 'Content-Type': o.type }).end(o.body) : res.writeHead(404).end(); }
    res.writeHead(405).end();
  });
});
const pg = async (sql) => { const c = new Pg({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const spawnApp = (port, extra = {}) => { const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), BASE_URL: 'http://127.0.0.1:' + port, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, SUPABASE_URL: 'http://127.0.0.1:' + SPORT, SUPABASE_SERVICE_ROLE_KEY: KEY, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', PAYSTACK_SECRET_KEY: '', RESEND_API_KEY: '', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; }); return p; };
const up = async (port) => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('app did not start'); };
const call = async (port, method, url, body, cookie) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.getSetCookie ? r.headers.getSetCookie()[0] || '' : ''; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, t, c: sc.split(';')[0], h: r.headers }; };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  await new Promise((r) => fake.listen(SPORT, r));
  await pg(`CREATE DATABASE ${DB}`);
  const a = spawnApp(P1); await up(P1);
  const b = spawnApp(P2); await up(P2);
  let cookie, photoUrl;

  await test('sign in on instance 1, same session works on instance 2 (sessions live in the database)', async () => {
    const l = await call(P1, 'POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' }); assert.strictEqual(l.s, 200); cookie = l.c;
    assert.strictEqual((await call(P2, 'GET', '/api/admin/dashboard', null, cookie)).s, 200);
    assert.strictEqual((await call(P2, 'GET', '/api/me', null, cookie)).j.user.role, 'admin');
  });
  await test('photo uploaded through instance 1 goes to object storage, not to disk', async () => {
    const r = await call(P1, 'POST', '/api/admin/upload', { data: PNG }, cookie); assert.strictEqual(r.s, 200);
    photoUrl = r.j.url; assert.match(photoUrl, new RegExp('^http://127.0.0.1:' + SPORT + '/storage/v1/object/public/product-images/[a-f0-9]{24}\\.png$'));
    assert.strictEqual(objects.size, 1);
    assert.ok(!fs.existsSync(path.join(DATA, 'uploads')) || fs.readdirSync(path.join(DATA, 'uploads')).length === 0, 'no file may be written under DATA_DIR/uploads');
  });
  await test('product saved on instance 1 with that photo shows on instance 2', async () => {
    const p = await call(P1, 'POST', '/api/admin/products', { name: 'Photo Item', store: 'food', price: 1500, stock: 5, active: 1, images: [photoUrl] }, cookie); assert.strictEqual(p.s, 200);
    const list = (await call(P2, 'GET', '/api/products?q=photo+item')).j.products; assert.strictEqual(list[0].image, photoUrl);
    assert.strictEqual((await fetch(photoUrl)).status, 200);
  });
  await test('old /uploads/<name> links redirect to the storage URL', async () => {
    const name = photoUrl.split('/').pop(); const r = await call(P2, 'GET', '/uploads/' + name);
    assert.strictEqual(r.s, 301); assert.strictEqual(r.h.get('location'), photoUrl);
    assert.strictEqual((await call(P2, 'GET', '/uploads/..%2fserver.js')).s, 404);
  });
  await test('storage outage gives a clear error and saves nothing', async () => {
    const bad = spawnApp(P2 + 1, { SUPABASE_SERVICE_ROLE_KEY: 'wrong' }); await up(P2 + 1);
    const r = await call(P2 + 1, 'POST', '/api/admin/upload', { data: PNG }, cookie);
    assert.strictEqual(r.s, 502); assert.match(r.j.error, /not available/); bad.kill();
  });
  await test('a bad file is refused before it reaches storage', async () => {
    const before = objects.size; const r = await call(P1, 'POST', '/api/admin/upload', { data: 'data:image/png;base64,' + Buffer.from('not an image at all').toString('base64') }, cookie);
    assert.strictEqual(r.s, 400); assert.strictEqual(objects.size, before);
  });
  await test('production refuses to start with photos on local disk', async () => {
    const c = spawnApp(P2 + 2, { NODE_ENV: 'production', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' });
    const code = await new Promise((r) => { c.on('exit', r); setTimeout(() => { c.kill(); r('still running'); }, 6000); });
    assert.notStrictEqual(code, 'still running'); assert.notStrictEqual(code, 0); assert.match(c.log, /wiped on restart/);
  });
  await test('checkout on instance 1 and order lookup on instance 2', async () => {
    const prods = (await call(P1, 'GET', '/api/products?instock=1')).j.products; const p = prods[3]; const d = (await call(P1, 'GET', '/api/products/' + p.slug)).j.product;
    const o = await call(P1, 'POST', '/api/checkout', { contact: { name: 'Ada', email: 'ada@example.com', phone: '08011112222' }, address: { state: 'Lagos', city: 'x', address: '1 Road Street' }, delivery: 'standard', payment: 'pod', items: [{ productId: p.id, variantId: d.variants[0] ? d.variants[0].id : null, qty: 1 }] });
    assert.strictEqual(o.s, 200);
    assert.strictEqual((await call(P2, 'POST', '/api/orders/lookup', { ref: o.j.ref, email: 'ada@example.com' })).s, 200);
  });

  a.kill(); b.kill(); fake.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(DATA, { recursive: true, force: true });
  await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
