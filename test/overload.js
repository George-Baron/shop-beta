'use strict';
// Overload protection: when far too many requests arrive at once, new browsing requests get a polite 503 + Retry-After, while health checks,
// payment webhooks and checkout keep working, and the server returns to normal afterwards.
// Run with: npm run test:overload   (needs TEST_DATABASE_URL like the other tests)
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_overload_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const PORT = 4700 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-overload-'));
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql) => { const c = new Pg({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const U = (p) => `http://127.0.0.1:${PORT}${p}`;

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', RESEND_API_KEY: '', RATE_LIMIT_MULTIPLIER: '100', WORKER_POLL_MS: '200', MAX_INFLIGHT_BROWSE: '3', MAX_INFLIGHT_PAY: '1000', KEEP_ALIVE_MS: '90000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; app.stdout.on('data', (d) => { log += d; }); app.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(U('/health')); break; } catch { await sleep(100); } }
  const burst = (p, n, init) => Promise.all(Array.from({ length: n }, () => fetch(U(p), init).then(async (r) => { const t = await r.text(); return { s: r.status, ra: r.headers.get('retry-after'), ct: r.headers.get('content-type') || '', t }; }, () => ({ s: 'ERR' }))));

  await test('a burst far above the limit gets polite 503 + Retry-After for some, and 200 for the rest', async () => {
    const r = await burst('/api/products', 120);
    const ok = r.filter((x) => x.s === 200), busy = r.filter((x) => x.s === 503);
    assert.ok(ok.length > 0, 'some requests are still served'); assert.ok(busy.length > 0, 'some are refused when over the limit');
    assert.strictEqual(ok.length + busy.length, 120, 'nothing else (no resets, no 500s): ' + JSON.stringify(r.map((x) => x.s).filter((s) => s !== 200 && s !== 503)));
    assert.ok(busy.every((x) => /^\d+$/.test(x.ra) && JSON.parse(x.t).code === 'busy'));
  });
  await test('a refused page visit gets a small friendly HTML page that retries by itself', async () => {
    let got; for (let i = 0; i < 10 && !got; i++) { got = (await burst('/shop', 80, { headers: { Accept: 'text/html' } })).find((x) => x.s === 503); }
    assert.ok(got, 'a page request was refused at least once'); assert.match(got.ct, /text\/html/); assert.match(got.t, /refresh/); assert.ok(got.t.length < 2000);
  });
  await test('health checks and payment webhooks are never refused, even during a burst', async () => {
    const [h, w] = await Promise.all([burst('/health', 60), burst('/api/paystack/webhook', 60, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), burst('/api/products', 100)]);
    assert.ok(h.every((x) => x.s === 200), 'health: ' + [...new Set(h.map((x) => x.s))]); assert.ok(w.every((x) => x.s !== 503), 'webhook: ' + [...new Set(w.map((x) => x.s))]);
  });
  await test('checkout has its own limit: a browsing burst does not stop checkout', async () => {
    const [, c] = await Promise.all([burst('/api/products', 150), burst('/api/checkout', 10, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"items":[]}' })]);
    assert.ok(c.every((x) => x.s !== 503), 'checkout answered (400 for an empty cart is fine): ' + [...new Set(c.map((x) => x.s))]);
  });
  await test('the server returns to normal straight after (no request counter left stuck)', async () => {
    await sleep(500); for (let i = 0; i < 5; i++) assert.strictEqual((await fetch(U('/api/products'))).status, 200);
  });
  await test('keep-alive is raised from Node\'s 5 s default so the proxy never reuses a closed connection', async () => {
    const r = await fetch(U('/health')); assert.match(r.headers.get('keep-alive') || '', /timeout=90/);
  });
  await test('no unexpected errors were logged', async () => { assert.ok(!/"level":"error"/.test(log.split('\n').filter((l) => !/health check failed/.test(l)).join('\n')), log.split('\n').filter((l) => /"level":"error"/.test(l))[0]); });

  app.kill(); await sleep(500); await pg(`DROP DATABASE ${DB} WITH (FORCE)`).catch(() => {}); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})();
