'use strict';
// Tests the cache itself: part 1 the cache module alone, part 2 two real instances sharing one database.
// Needs Postgres like npm test. Run with: npm run test:cache
process.env.CACHE_MAX_ENTRIES = '10';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/unused'; // the module-only tests never touch the database
const { spawn } = require('child_process');
const assert = require('assert');
const http = require('http');
const path = require('path');
const { Client: Pg } = require('pg');
const cacheMod = require('../lib/cache');

const ADMIN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DB = 'sb_cache_' + Math.random().toString(36).slice(2, 10);
const withDb = (n) => { const u = new URL(ADMIN); u.pathname = '/' + n; return u.toString(); };
const sql = async (q) => { const c = new Pg({ connectionString: ADMIN, ssl: process.env.PGSSL_TEST === 'require' ? { rejectUnauthorized: false } : false }); await c.connect(); try { await c.query(q); } finally { await c.end(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); } }

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const r = await fetch(this.base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) this.cookie = c.split(';')[0];
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text, headers: r.headers };
  }
  get(u, h) { return this.req('GET', u, undefined, h); } post(u, b = {}) { return this.req('POST', u, b); } put(u, b = {}) { return this.req('PUT', u, b); }
}
// raw request that keeps the compressed answer visible
const rawGet = (base, p) => new Promise((res, rej) => http.get(base + p, { headers: { 'Accept-Encoding': 'gzip' } }, (r) => { const ch = []; r.on('data', (c) => ch.push(c)); r.on('end', () => res({ headers: r.headers, bytes: Buffer.concat(ch).length })); }).on('error', rej));

(async () => {
  console.log('\nCache module');
  await test('a busy miss runs the loader once (50 requests at the same moment)', async () => {
    let calls = 0; const load = async () => { calls++; await sleep(30); return 'v'; };
    const r = await Promise.all(Array.from({ length: 50 }, () => cacheMod.memo('k1', 1000, load)));
    assert.strictEqual(calls, 1); assert.ok(r.every((x) => x === 'v'));
    await cacheMod.memo('k1', 1000, load); assert.strictEqual(calls, 1, 'then served from memory');
  });
  await test('entries expire after their time', async () => {
    let calls = 0; const load = async () => ++calls;
    await cacheMod.memo('k2', 40, load); await cacheMod.memo('k2', 40, load); assert.strictEqual(calls, 1);
    await sleep(70); await cacheMod.memo('k2', 40, load); assert.strictEqual(calls, 2);
  });
  await test('errors are not cached', async () => {
    let calls = 0; const load = async () => { calls++; if (calls === 1) throw new Error('db down'); return 'ok'; };
    await assert.rejects(cacheMod.memo('k3', 1000, load), /db down/); assert.strictEqual(await cacheMod.memo('k3', 1000, load), 'ok');
  });
  await test('skip() answers are handed back but not kept', async () => {
    let calls = 0; const load = async () => { calls++; return cacheMod.skip('nope'); };
    assert.strictEqual(await cacheMod.memo('k4', 1000, load), 'nope'); await cacheMod.memo('k4', 1000, load); assert.strictEqual(calls, 2);
  });
  await test('memory is capped: oldest-unused entries go first', async () => {
    cacheMod.clearLocal();
    for (let i = 0; i < 25; i++) await cacheMod.memo('e' + i, 60000, async () => i);
    const s = cacheMod.snapshot(); assert.ok(s.entries <= 10, 'entries ' + s.entries);
    let calls = 0; await cacheMod.memo('e24', 60000, async () => { calls++; return 24; }); assert.strictEqual(calls, 0, 'newest is still there');
    await cacheMod.memo('e0', 60000, async () => { calls++; return 0; }); assert.strictEqual(calls, 1, 'oldest was dropped');
  });
  await test('a load that was running during a clear does not store its old answer', async () => {
    let n = 0; const slow = async () => { const mine = ++n; await sleep(50); return 'old' + mine; };
    const p = cacheMod.memo('k5', 60000, slow); await sleep(10); cacheMod.clearLocal();
    assert.strictEqual(await p, 'old1');
    assert.strictEqual(await cacheMod.memo('k5', 60000, async () => 'fresh'), 'fresh');
  });

  console.log('\nTwo instances, one database');
  await sql(`CREATE DATABASE ${DB}`);
  const base = 3900 + Math.floor(Math.random() * 90), P = [base, base + 1], procs = [];
  const start = (port, name) => { const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), INSTANCE_ID: name, DATABASE_URL: withDb(DB), PGSSL: process.env.PGSSL_TEST || 'disable', BASE_URL: 'http://127.0.0.1:' + port, STORAGE_DRIVER: 'local', DATA_DIR: require('os').tmpdir() + '/sb-cache-' + name, CACHE_DISABLED: '', CACHE_POLL_MS: '500', PAYSTACK_SECRET_KEY: '', RESEND_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] }); p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; }); procs.push(p); return p; };
  const up = async (port) => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* wait */ } await sleep(100); } throw new Error('no start on ' + port); };
  try {
    start(P[0], 'A'); await up(P[0]); start(P[1], 'B'); await up(P[1]);
    const A = new Client('http://127.0.0.1:' + P[0]), B = new Client('http://127.0.0.1:' + P[1]), admin = new Client(A.base);
    const stats = async (c) => (await c.get('/health')).json.cache;
    assert.strictEqual((await admin.post('/api/admin/setup', { name: 'Boss', email: 'boss@example.com', password: 'correct horse' })).status, 200);
    const list = (await A.get('/api/products?store=fashion')).json.products; const prod = list.find((p) => p.stock > 5) || list[0];

    await test('pages and API answers are gzip-compressed', async () => {
      for (const p of ['/api/config', '/api/products?store=fashion', '/']) { const r = await rawGet(A.base, p); assert.strictEqual(r.headers['content-encoding'], 'gzip', p); }
      const plain = await fetch(A.base + '/api/config', { headers: { 'Accept-Encoding': 'identity' } }); assert.strictEqual(plain.headers.get('content-encoding'), null);
    });
    await test('cache headers: catalogue can be shared, anything personal or missing cannot', async () => {
      const cc = async (c, p) => (await c.get(p)).headers.get('cache-control');
      assert.match(await cc(A, '/api/products/' + prod.slug), /^public, max-age=0, s-maxage=30/); assert.match(await cc(A, '/api/products?store=fashion'), /s-maxage=30/); assert.match(await cc(A, '/api/home/fashion'), /s-maxage=30/);
      assert.strictEqual(await cc(A, '/api/config'), 'no-store'); assert.strictEqual(await cc(A, '/api/me'), 'no-store');
      assert.strictEqual(await cc(A, '/api/products/does-not-exist'), 'no-store'); assert.strictEqual(await cc(A, '/api/home/nowhere'), 'no-store');
      assert.strictEqual((await rawGet(A.base, '/api/products/' + prod.slug)).headers['set-cookie'], undefined, 'shared answers never set cookies');
    });
    await test('repeat requests come from memory; 40 at once cost one database read', async () => {
      const before = await stats(A);
      await Promise.all(Array.from({ length: 40 }, () => A.get('/api/home/electronics')));
      const mid = await stats(A); assert.strictEqual(mid.misses - before.misses, 1, 'one miss'); assert.ok(mid.hits + mid.coalesced - before.hits - before.coalesced >= 39);
      for (let i = 0; i < 20; i++) await A.get('/api/home/electronics'); assert.strictEqual((await stats(A)).misses, mid.misses);
    });
    await test('the signed-in user is never mixed into the shared config', async () => {
      const u = new Client(A.base); assert.strictEqual((await u.post('/api/auth/register', { name: 'Ada Obi', email: 'ada@example.com', phone: '08012345678', password: 'correct horse' })).status, 200);
      const mine = (await u.get('/api/config')).json; assert.strictEqual(mine.user.email, 'ada@example.com');
      assert.strictEqual((await new Client(A.base).get('/api/config')).json.user, null); assert.strictEqual((await B.get('/api/config')).json.user, null);
      assert.ok(mine.stores.length === 6 && mine.zones.length === 37);
    });
    await test('admin changes a price: shoppers see it at once on that instance, and on the other within 2 seconds', async () => {
      assert.ok((await A.get('/api/products/' + prod.slug)).json.product.price === prod.price); await B.get('/api/products/' + prod.slug); await B.get('/api/products?store=fashion');
      const p = (await admin.get('/api/admin/products/' + prod.id)).json.product; p.price = prod.price + 1234;
      assert.strictEqual((await admin.put('/api/admin/products/' + prod.id, p)).status, 200);
      assert.strictEqual((await A.get('/api/products/' + prod.slug)).json.product.price, prod.price + 1234, 'detail on A');
      assert.strictEqual((await A.get('/api/products?store=fashion')).json.products.find((x) => x.id === prod.id).price, prod.price + 1234, 'list on A');
      let seen = 0; for (let i = 0; i < 30 && !seen; i++) { if ((await B.get('/api/products/' + prod.slug)).json.product.price === prod.price + 1234) seen = i; else await sleep(100); }
      assert.ok(seen || (await B.get('/api/products/' + prod.slug)).json.product.price === prod.price + 1234, 'detail on B within 3 s');
      assert.strictEqual((await B.get('/api/products?store=fashion')).json.products.find((x) => x.id === prod.id).price, prod.price + 1234, 'list on B');
      assert.ok((await stats(B)).remoteInvalidations >= 1);
    });
    await test('hiding a product removes it everywhere (page, list, search data, sitemap) on both instances', async () => {
      await A.get('/sitemap.xml'); await B.get('/sitemap.xml'); await B.get('/product/' + prod.slug);
      assert.match((await A.get('/sitemap.xml')).text, new RegExp('/product/' + prod.slug));
      const p = (await admin.get('/api/admin/products/' + prod.id)).json.product; p.active = 0; assert.strictEqual((await admin.put('/api/admin/products/' + prod.id, p)).status, 200);
      for (const c of [A]) { assert.strictEqual((await c.get('/api/products/' + prod.slug)).status, 404); assert.strictEqual((await c.get('/product/' + prod.slug)).status, 404); assert.ok(!(await c.get('/sitemap.xml')).text.includes('/product/' + prod.slug)); assert.ok(!(await c.get('/api/products?store=fashion')).json.products.some((x) => x.id === prod.id)); }
      await sleep(1200); assert.strictEqual((await B.get('/api/products/' + prod.slug)).status, 404); assert.strictEqual((await B.get('/product/' + prod.slug)).status, 404);
    });
    await test('store name and delivery fee changes show up straight away (config and page title)', async () => {
      const before = (await A.get('/api/config')).json; await A.get('/');
      const s = (await admin.get('/api/admin/settings')).json; const lagos = s.zones.find((z) => z.state === 'Lagos');
      assert.strictEqual((await admin.put('/api/admin/settings', { settings: { store_name: 'Cache Mart' }, zones: [{ ...lagos, fee: lagos.fee + 500 }] })).status, 200);
      const after = (await A.get('/api/config')).json; assert.strictEqual(after.settings.store_name, 'Cache Mart'); assert.strictEqual(after.zones.find((z) => z.state === 'Lagos').fee, before.zones.find((z) => z.state === 'Lagos').fee + 500);
      assert.match((await A.get('/')).text, /Cache Mart/);
    });
    await test('stock shown may lag a few seconds, but the last unit still cannot be sold twice', async () => {
      const tiny = (await admin.get('/api/admin/products?q=Aviator')).json.products[0]; const p = (await admin.get('/api/admin/products/' + tiny.id)).json.product; p.stock = 1; p.variants = []; assert.strictEqual((await admin.put('/api/admin/products/' + tiny.id, p)).status, 200);
      assert.strictEqual((await B.get('/api/products/' + tiny.slug)).json.product.stock, 1); // B now has it in memory
      const order = () => ({ items: [{ productId: tiny.id, qty: 1 }], contact: { name: 'T', email: 't@example.com', phone: '08031234567' }, address: { state: 'Lagos', address: '1 Test Road' }, delivery: 'standard', payment: 'pod' });
      assert.strictEqual((await A.post('/api/checkout', order())).status, 200);
      const second = await B.post('/api/checkout', order()); // B's page may still say "1 left"; the order check uses the database, not the cache
      assert.strictEqual(second.status, 400); assert.match(second.json.error, /sold out|no longer available/);
      await sleep(10500); assert.strictEqual((await B.get('/api/products/' + tiny.slug)).json.product.stock, 0, 'shown stock catches up within the 10 s limit');
    });
    await test('invalid and random addresses cannot fill the cache', async () => {
      const before = (await stats(A)).entries;
      for (let i = 0; i < 60; i++) { await A.get('/product/nothing-' + i); await A.get('/api/products/nothing-' + i); await A.get('/d/none-' + i); await A.get('/api/products?store=fashion&junk' + i + '=' + i + '&zz=' + i); }
      assert.ok((await stats(A)).entries - before <= 3, 'entries grew by ' + ((await stats(A)).entries - before));
    });
  } catch (e) { failed++; console.log('  FAIL setup: ' + e.message); console.log(procs.map((p, i) => '--- instance ' + 'AB'[i] + ' ---\n' + p.log.split('\n').slice(-12).join('\n')).join('\n')); }
  finally { procs.forEach((p) => p.kill()); await sleep(300); await sql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); }
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})();
