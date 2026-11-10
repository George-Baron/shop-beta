'use strict';
// Step 5 check: the job queue and the background worker.
// Run with: npm run test:queue   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_queue_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const FAKE = 4800 + Math.floor(Math.random() * 100), P1 = FAKE + 100;
const PAYKEY = 'sk_test_queue';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-queue-'));
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(200); } };

// Stand-in for Resend and Paystack, with switches to make them fail.
const fx = { resendFail: 0, resendCalls: [], verifyFail: 0, verifyCalls: 0, paid: new Set(), amounts: {} };
const fake = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const body = Buffer.concat(c).toString(); const send = (s, o) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/emails') {
      const j = JSON.parse(body); fx.resendCalls.push({ to: j.to[0], key: req.headers['idempotency-key'] });
      if (j.to[0].startsWith('bounce')) return send(422, { message: 'invalid recipient' });
      if (fx.resendFail > 0) { fx.resendFail--; return send(503, { message: 'down' }); }
      return send(200, { id: 'x' });
    }
    if (req.url === '/transaction/initialize') { const j = JSON.parse(body); fx.amounts[j.reference] = j.amount; return send(200, { status: true, data: { authorization_url: 'http://pay.test/' + j.reference } }); }
    const m = /^\/transaction\/verify\/(.+)$/.exec(req.url);
    if (m) { fx.verifyCalls++; if (fx.verifyFail > 0) { fx.verifyFail--; return send(500, {}); } const ref = decodeURIComponent(m[1]); return send(200, { status: true, data: { status: 'success', currency: 'NGN', amount: fx.amounts[ref], reference: ref } }); }
    send(404, {});
  });
});
const pg = async (sql) => { const c = new Pg({ connectionString: ADMIN_URL }); await c.connect(); try { return await c.query(sql); } finally { await c.end(); } };
const call = async (port, method, url, body, cookie, headers = {}) => { const raw = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)); const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw }); const sc = r.headers.getSetCookie ? r.headers.getSetCookie()[0] || '' : ''; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, t, c: sc.split(';')[0] }; };
const up = async (port) => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); return; } catch { await sleep(100); } } throw new Error('app did not start'); };

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  await pg(`CREATE DATABASE ${DB}`);
  Object.assign(process.env, { DATABASE_URL: URL_DB, DATABASE_SSL: 'off', JOB_BACKOFF_SECONDS: '1,1,1', WORKER_POLL_MS: '200' });
  const db = require('../lib/db'); const queue = require('../lib/queue');
  await db.migrate();

  /* ---- the queue on its own ---- */
  await test('the same key can only be queued once', async () => {
    const a = await queue.enqueue('t.one', {}, { key: 'dup-1' }); const b = await queue.enqueue('t.one', {}, { key: 'dup-1' });
    assert.ok(a); assert.strictEqual(b, null);
  });
  await test('two workers share 60 jobs and no job runs twice', async () => {
    const seen = new Map();
    for (let i = 0; i < 60; i++) await queue.enqueue('t.many', { i });
    const h = { 't.many': async (p) => { seen.set(p.i, (seen.get(p.i) || 0) + 1); await sleep(10); }, 't.one': async () => {} };
    const w1 = queue.work(h, { concurrency: 4, pollMs: 100 }), w2 = queue.work(h, { concurrency: 4, pollMs: 100 });
    await until(async () => (await queue.counts()).queued === 0 && (await queue.counts()).running === 0);
    await w1.stop(); await w2.stop();
    assert.strictEqual(seen.size, 60); assert.ok([...seen.values()].every((n) => n === 1), 'a job ran more than once');
  });
  await test('a failing job is retried, then lands in the failed list; retry from there works', async () => {
    let calls = 0; await queue.enqueue('t.fail', {}, { maxAttempts: 3 });
    const w = queue.work({ 't.fail': async () => { calls++; throw new Error('boom'); } }, { pollMs: 100 });
    const failed1 = await until(async () => (await db.get("SELECT * FROM jobs WHERE kind='t.fail' AND state='failed'")));
    assert.strictEqual(calls, 3); assert.strictEqual(failed1.attempts, 3); assert.strictEqual(failed1.last_error, 'boom');
    assert.ok(await queue.retry(Number(failed1.id)));
    await until(async () => (await db.get("SELECT 1 x FROM jobs WHERE kind='t.fail' AND state='failed' AND attempts=3")) && calls === 6);
    await w.stop();
  });
  await test('a permanent error skips the retries', async () => {
    let calls = 0; await queue.enqueue('t.perm', {});
    const w = queue.work({ 't.perm': async () => { calls++; throw Object.assign(new Error('never'), { permanent: true }); } }, { pollMs: 100 });
    await until(async () => await db.get("SELECT 1 x FROM jobs WHERE kind='t.perm' AND state='failed'")); await w.stop();
    assert.strictEqual(calls, 1);
  });
  await test('a job left "running" by a crashed worker is picked up again after its lock expires', async () => {
    const id = await queue.enqueue('t.crash', {});
    await db.run("UPDATE jobs SET state='running', attempts=1, locked_until=? WHERE id=?", db.now() - 5, id);
    let ran = 0; const w = queue.work({ 't.crash': async () => { ran++; } }, { pollMs: 100 });
    await until(async () => await db.get("SELECT 1 x FROM jobs WHERE id=? AND state='done'", id)); await w.stop();
    assert.strictEqual(ran, 1);
  });
  await db.close();
  const c0 = new Pg({ connectionString: URL_DB }); await c0.connect(); await c0.query("DELETE FROM jobs WHERE kind LIKE 't.%'"); await c0.end();

  /* ---- the app: emails and webhooks go through the worker ---- */
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(P1), BASE_URL: 'http://127.0.0.1:' + P1, DATA_DIR: DATA, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', PAYSTACK_SECRET_KEY: PAYKEY, PAYSTACK_API_URL: 'http://127.0.0.1:' + FAKE, RESEND_API_KEY: 're_test', RESEND_API_URL: 'http://127.0.0.1:' + FAKE, MAIL_FROM: 'Shop <shop@example.com>' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.log = ''; app.stdout.on('data', (d) => { app.log += d; }); app.stderr.on('data', (d) => { app.log += d; });
  await up(P1);
  const login = await call(P1, 'POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' }); const cookie = login.c;
  const prods = (await call(P1, 'GET', '/api/products?instock=1')).j.products;
  const order = async (email, payment = 'pod') => {
    const p = prods[2]; const d = (await call(P1, 'GET', '/api/products/' + p.slug)).j.product;
    return call(P1, 'POST', '/api/checkout', { contact: { name: 'Ada Obi', email, phone: '08011112222' }, address: { state: 'Lagos', city: 'Yaba', address: '1 Road Street' }, delivery: 'standard', payment, items: [{ productId: p.id, variantId: d.variants[0] ? d.variants[0].id : null, qty: 1 }] });
  };
  const outbox = async (email) => (await call(P1, 'GET', '/api/admin/outbox', undefined, cookie)).j.emails.filter((m) => m.to_email === email);

  await test('checkout does not wait for the email provider, and the email is retried until it is sent', async () => {
    fx.resendFail = 2; fx.resendCalls = [];
    const t0 = Date.now(); const r = await order('ada@example.com'); assert.strictEqual(r.s, 200); assert.ok(Date.now() - t0 < 4000);
    await until(async () => { const m = await outbox('ada@example.com'); return m.length && m.every((x) => x.sent === 1); });
    assert.ok(fx.resendCalls.length >= 4, 'two sends failed, then both went through on retry (customer + shop owner copy)');
    assert.ok(fx.resendCalls.every((x) => /^shopbeta-outbox-\d+$/.test(x.key)), 'every send carries an idempotency key');
  });
  await test('an email Resend refuses for good shows in the failed-jobs list, and Retry sends it', async () => {
    await order('bounce@example.com');
    const f = await until(async () => { const j = (await call(P1, 'GET', '/api/admin/jobs', undefined, cookie)).j; return j.failed.find((x) => x.kind === 'email' && /422/.test(x.last_error)); });
    assert.strictEqual(f.attempts, 1);
    assert.strictEqual((await call(P1, 'POST', `/api/admin/jobs/${f.id}/retry`, {}, cookie)).s, 200);
    await until(async () => { const j = (await call(P1, 'GET', '/api/admin/jobs', undefined, cookie)).j; return j.failed.find((x) => x.id === f.id && x.attempts >= 1) && fx.resendCalls.filter((x) => x.to === 'bounce@example.com').length >= 2; });
    const j = (await call(P1, 'GET', '/api/admin/jobs', undefined, cookie)).j;
    assert.strictEqual((await call(P1, 'DELETE', `/api/admin/jobs/${f.id}`, undefined, cookie)).s, 200);
    assert.strictEqual((await call(P1, 'GET', '/api/admin/jobs', undefined, cookie)).j.failed.some((x) => x.id === f.id), false);
    assert.ok(j.counts.failed >= 1);
  });
  await test('the failed-jobs list is for admins only', async () => {
    assert.strictEqual((await call(P1, 'GET', '/api/admin/jobs')).s, 401);
    assert.ok([401, 403].includes((await call(P1, 'POST', '/api/admin/jobs/1/retry', {})).s));
  });
  await test('Paystack webhook is acknowledged at once, retried while Paystack is unreachable, and pays the order once', async () => {
    const o = await order('pay@example.com', 'paystack'); assert.strictEqual(o.s, 200);
    const ref = o.j.ref; const hook = JSON.stringify({ event: 'charge.success', data: { reference: ref } });
    assert.strictEqual((await call(P1, 'POST', '/api/paystack/webhook', hook, null, { 'x-paystack-signature': 'bad' })).s, 401);
    const sig = crypto.createHmac('sha512', PAYKEY).update(hook).digest('hex');
    fx.verifyFail = 2; fx.verifyCalls = 0;
    const t0 = Date.now(); const w1 = await call(P1, 'POST', '/api/paystack/webhook', hook, null, { 'x-paystack-signature': sig }); assert.strictEqual(w1.s, 200); assert.ok(Date.now() - t0 < 1500);
    const w2 = await call(P1, 'POST', '/api/paystack/webhook', hook, null, { 'x-paystack-signature': sig }); assert.strictEqual(w2.s, 200); // Paystack sends duplicates
    await until(async () => (await call(P1, 'POST', '/api/orders/lookup', { ref, email: 'pay@example.com' })).j.order.payment_status === 'paid');
    assert.strictEqual(fx.verifyCalls, 3, 'two failed checks, one good check, and the duplicate webhook did not add work');
    const ev = (await call(P1, 'POST', '/api/orders/lookup', { ref, email: 'pay@example.com' })).j.order;
    assert.strictEqual(ev.status, 'paid');
  });
  await test('a webhook for an order we do not have is dropped quietly, not retried forever', async () => {
    const hook = JSON.stringify({ event: 'charge.success', data: { reference: 'NOSUCHORDER1' } });
    const sig = crypto.createHmac('sha512', PAYKEY).update(hook).digest('hex');
    assert.strictEqual((await call(P1, 'POST', '/api/paystack/webhook', hook, null, { 'x-paystack-signature': sig })).s, 200);
    await sleep(1500);
    const j = (await call(P1, 'GET', '/api/admin/jobs', undefined, cookie)).j; assert.ok(!j.failed.some((x) => x.kind === 'paystack.settle')); assert.strictEqual(j.waiting.filter((x) => x.kind === 'paystack.settle').length, 0);
  });
  await test('timed chores are queued once per slot', async () => {
    const c = new Pg({ connectionString: URL_DB }); await c.connect();
    const r = await c.query("SELECT key, state FROM jobs WHERE kind LIKE 'cron.%'"); await c.end();
    assert.ok(r.rows.length >= 3); assert.strictEqual(new Set(r.rows.map((x) => x.key)).size, r.rows.length); assert.ok(r.rows.every((x) => x.state === 'done'));
  });

  app.kill(); fake.close();
  await sleep(300);
  fs.rmSync(DATA, { recursive: true, force: true });
  await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(app.log.slice(-1500));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
