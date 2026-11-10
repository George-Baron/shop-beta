'use strict';
// Step 4 check: gzip, cache headers, and that an admin edit shows up on both instances (at once on the same one, within seconds on the other).
// Run with: npm run test:cache   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_cache_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const P1 = 4800 + Math.floor(Math.random() * 100), P2 = P1 + 100;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cache-'));
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const pg = async (sql) => { const c = new Pg({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const spawnApp = (port) => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), BASE_URL: 'http://127.0.0.1:' + port, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, CACHE_POLL_MS: '500', ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', PAYSTACK_SECRET_KEY: '', RESEND_API_KEY: '' }, stdio: 'ignore' });
const up = async (port) => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('app did not start'); };
// raw http so we can see the real bytes and headers (fetch hides gzip)
const raw = (port, method, url, body, cookie, headers = {}) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
    const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { let buf = Buffer.concat(c); const gz = res.headers['content-encoding'] === 'gzip'; if (gz) buf = zlib.gunzipSync(buf); const t = buf.toString(); let j = null; try { j = JSON.parse(t); } catch { /* */ } resolve({ s: res.statusCode, h: res.headers, gz, wire: Buffer.concat(c).length, t, j, c: (res.headers['set-cookie'] || [''])[0].split(';')[0] }); });
  }); req.on('error', reject); if (data) req.write(data); req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  const a = spawnApp(P1); await up(P1); const b = spawnApp(P2); await up(P2);
  const login = await raw(P1, 'POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' }); const cookie = login.c;

  await test('JSON and HTML are gzip-compressed, small answers are not', async () => {
    const r = await raw(P1, 'GET', '/api/products?store=food', null, null, { 'Accept-Encoding': 'gzip' });
    assert.ok(r.gz && r.wire < r.t.length / 2, `gzip ${r.gz}, wire ${r.wire} vs ${r.t.length}`);
    const h = await raw(P1, 'GET', '/', null, null, { 'Accept-Encoding': 'gzip' }); assert.ok(h.gz, 'HTML gzip');
    assert.ok(!(await raw(P1, 'GET', '/health', null, null, { 'Accept-Encoding': 'gzip' })).gz);
  });
  await test('cache headers: catalogue is shareable, account data and HTML are not', async () => {
    assert.match((await raw(P1, 'GET', '/api/home/food')).h['cache-control'], /public.*s-maxage=30/);
    assert.match((await raw(P1, 'GET', '/api/products?store=food')).h['cache-control'], /public.*s-maxage=30/);
    assert.match((await raw(P1, 'GET', '/api/config')).h['cache-control'], /private/);
    assert.ok(!/public/.test((await raw(P1, 'GET', '/api/me', null, cookie)).h['cache-control'] || ''));
    assert.ok(!/public/.test((await raw(P1, 'GET', '/api/orders', null, cookie)).h['cache-control'] || ''));
    assert.ok(!/public/.test((await raw(P1, 'GET', '/api/admin/dashboard', null, cookie)).h['cache-control'] || ''));
    assert.match((await raw(P1, 'GET', '/')).h['cache-control'], /no-cache/);
  });
  await test('the cached config never leaks the signed-in user to other visitors', async () => {
    const anon1 = await raw(P1, 'GET', '/api/config'); const mine = await raw(P1, 'GET', '/api/config', null, cookie); const anon2 = await raw(P1, 'GET', '/api/config');
    assert.strictEqual(anon1.j.user, null); assert.strictEqual(mine.j.user.role, 'admin'); assert.strictEqual(anon2.j.user, null);
    assert.ok(!('cache_version' in mine.j.settings), 'internal cache_version must not be exposed');
  });
  await test('page HTML keeps a fresh security nonce on every response even though the page head is cached', async () => {
    const n = (r) => /nonce="([^"]+)"/.exec(r.t)[1];
    const x = await raw(P1, 'GET', '/d/food'), y = await raw(P1, 'GET', '/d/food'); assert.notStrictEqual(n(x), n(y));
    assert.ok(x.h['content-security-policy'].includes(n(x)));
  });
  let pid, slug;
  await test('admin price edit shows at once on the same instance and within seconds on the other', async () => {
    const created = await raw(P1, 'POST', '/api/admin/products', { name: 'Cache Probe', store: 'food', price: 1000, stock: 9, active: 1, featured: 1 }, cookie); assert.strictEqual(created.s, 200); pid = created.j.id;
    slug = (await raw(P1, 'GET', '/api/admin/products/' + pid, null, cookie)).j.product.slug;
    assert.strictEqual((await raw(P1, 'GET', '/api/products/' + slug)).j.product.price, 1000);
    assert.strictEqual((await raw(P2, 'GET', '/api/products/' + slug)).j.product.price, 1000);   // both instances now hold it in memory
    assert.ok((await raw(P2, 'GET', '/api/products?store=food&q=cache+probe')).j.products.some((p) => p.price === 1000));
    await raw(P1, 'PUT', '/api/admin/products/' + pid, { name: 'Cache Probe', store: 'food', price: 1234, stock: 9, active: 1, featured: 1 }, cookie);
    await sleep(50);
    assert.strictEqual((await raw(P1, 'GET', '/api/products/' + slug)).j.product.price, 1234, 'same instance must be fresh at once');
    assert.ok((await raw(P1, 'GET', '/api/products?store=food&q=cache+probe')).j.products.some((p) => p.price === 1234));
    let ok = false; for (let i = 0; i < 20 && !ok; i++) { ok = (await raw(P2, 'GET', '/api/products/' + slug)).j.product.price === 1234 && (await raw(P2, 'GET', '/api/products?store=food&q=cache+probe')).j.products.some((p) => p.price === 1234); if (!ok) await sleep(250); }
    assert.ok(ok, 'the other instance must catch up within 5 seconds');
  });
  await test('hiding a product removes it from lists and pages on both instances', async () => {
    await raw(P1, 'PUT', '/api/admin/products/' + pid, { name: 'Cache Probe', store: 'food', price: 1234, stock: 9, active: 0 }, cookie);
    assert.strictEqual((await raw(P1, 'GET', '/api/products/' + slug)).s, 404);
    let gone = false; for (let i = 0; i < 20 && !gone; i++) { gone = (await raw(P2, 'GET', '/api/products/' + slug)).s === 404; if (!gone) await sleep(250); } assert.ok(gone);
  });
  await test('a failed admin edit does not leave stale or empty cache behind', async () => {
    const bad = await raw(P1, 'PUT', '/api/admin/products/' + pid, { name: '', store: 'food', price: 5 }, cookie); assert.strictEqual(bad.s, 400);
    assert.strictEqual((await raw(P1, 'GET', '/api/home/food')).s, 200);
  });
  await test('stock on the product page is live, not cached', async () => {
    await raw(P1, 'PUT', '/api/admin/products/' + pid, { name: 'Cache Probe', store: 'food', price: 1234, stock: 3, active: 1 }, cookie);
    const s1 = (await raw(P1, 'GET', '/api/products/' + slug)).j.product.stock; assert.strictEqual(s1, 3);
  });
  a.kill(); b.kill();
  await sleep(300);
  fs.rmSync(DATA, { recursive: true, force: true });
  await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
