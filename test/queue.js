'use strict';
// Job queue tests: part 1 the queue on a real database, part 2 whole-shop behaviour with fake Resend/Paystack that fail on purpose.
// Run with: npm run test:queue   (needs Postgres like npm test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Client: Pg } = require('pg');
const mocks = require('./mock-apis');

const ADMIN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DB = 'sb_queue_' + Math.random().toString(36).slice(2, 10);
const withDb = (n) => { const u = new URL(ADMIN); u.pathname = '/' + n; return u.toString(); };
const ssl = process.env.PGSSL_TEST === 'require' ? { rejectUnauthorized: false } : false;
const sql = async (q, db, args) => { const c = new Pg({ connectionString: db ? withDb(db) : ADMIN, ssl }); await c.connect(); try { return await c.query(q, args); } finally { await c.end(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } }
const waitFor = async (fn, ms = 8000, what = 'condition') => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { if (global.__dbg) console.log(JSON.stringify((await global.__dbg()).rows)); throw new Error('timed out waiting for ' + what); } await sleep(60); } };

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const r = await fetch(this.base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: typeof body === 'string' ? body : body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) this.cookie = c.split(';')[0];
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text, headers: r.headers };
  }
  get(u) { return this.req('GET', u); } post(u, b = {}, h) { return this.req('POST', u, b, h); } put(u, b = {}) { return this.req('PUT', u, b); } del(u) { return this.req('DELETE', u); }
}

(async () => {
  await sql(`CREATE DATABASE ${DB}`);
  process.env.DATABASE_URL = withDb(DB); process.env.PGSSL = process.env.PGSSL_TEST || 'disable'; process.env.JOB_BACKOFF_BASE_SECONDS = '1'; process.env.WORKER = '0';
  const { migrate } = require('../lib/migrate'); const db = require('../lib/db'); const Q = require('../lib/queue');
  await migrate();
  const job = async (id) => (await sql('SELECT * FROM jobs WHERE id=$1', DB, [id])).rows[0];
  const mkProcessor = () => { const seen = []; return { seen, fn: async (p) => { seen.push(p.n); } }; };

  console.log('\nQueue on a real database');
  await test('a job runs once with its data and is marked done', async () => {
    const p = mkProcessor(); Q.register('t-basic', p.fn);
    const id = await Q.enqueue('t-basic', { n: 7 }); await Q.runDue(['t-basic']); await Q.runDue(['t-basic']);
    assert.deepStrictEqual(p.seen, [7]); const j = await job(id); assert.strictEqual(j.state, 'done'); assert.strictEqual(j.attempts, 1);
  });
  await test('a failing job is retried later with growing delays, and keeps the error', async () => {
    let calls = 0; Q.register('t-retry', async () => { calls++; if (calls < 3) throw new Error('boom ' + calls); });
    const id = await Q.enqueue('t-retry', {}); await Q.runDue(['t-retry']);
    let j = await job(id); assert.strictEqual(j.state, 'queued'); assert.strictEqual(j.attempts, 1); assert.match(j.last_error, /boom 1/); assert.ok(j.run_at > Math.floor(Date.now() / 1000), 'waits before retry');
    await Q.runDue(['t-retry']); assert.strictEqual(calls, 1, 'not run again before it is due');
    await sql('UPDATE jobs SET run_at=0 WHERE id=$1', DB, [id]); await Q.runDue(['t-retry']); j = await job(id);
    assert.strictEqual(j.attempts, 2); assert.strictEqual(j.run_at - Math.floor(Date.now() / 1000) > 2, true, 'second delay is longer than the first');
    await sql('UPDATE jobs SET run_at=0 WHERE id=$1', DB, [id]); await Q.runDue(['t-retry']); j = await job(id); assert.strictEqual(j.state, 'done'); assert.strictEqual(calls, 3);
    assert.deepStrictEqual([1, 2, 3].map(Q.backoff), [1, 4, 16]);
  });
  await test('after the last attempt the job is failed, listed, and can be retried or discarded', async () => {
    let ok = false; Q.register('t-fail', async () => { if (!ok) throw new Error('still broken'); });
    const id = await Q.enqueue('t-fail', { x: 1 }, { maxAttempts: 2 });
    await Q.runDue(['t-fail']); await sql('UPDATE jobs SET run_at=0 WHERE id=$1', DB, [id]); await Q.runDue(['t-fail']);
    assert.strictEqual((await job(id)).state, 'failed');
    const list = await Q.failedList(); assert.ok(list.some((f) => f.id === id && /still broken/.test(f.last_error)));
    assert.strictEqual((await Q.overview()).failed >= 1, true);
    ok = true; assert.strictEqual(await Q.retry(id), true); await Q.runDue(['t-fail']); assert.strictEqual((await job(id)).state, 'done');
    assert.strictEqual(await Q.retry(id), false, 'a finished job cannot be retried');
    const id2 = await Q.enqueue('t-fail', {}, { maxAttempts: 1 }); ok = false; await Q.runDue(['t-fail']); assert.strictEqual(await Q.discard(id2), true); assert.strictEqual(await job(id2), undefined);
  });
  await test('an error marked permanent fails at once without retries', async () => {
    Q.register('t-perm', async () => { throw Object.assign(new Error('bad address'), { permanent: true }); });
    const id = await Q.enqueue('t-perm', {}); await Q.runDue(['t-perm']); const j = await job(id); assert.strictEqual(j.state, 'failed'); assert.strictEqual(j.attempts, 1);
  });
  await test('8 workers racing over 100 jobs: every job runs exactly once', async () => {
    const seen = []; Q.register('t-race', async (p) => { seen.push(p.n); await sleep(2); });
    for (let i = 0; i < 100; i++) await Q.enqueue('t-race', { n: i });
    await Promise.all(Array.from({ length: 8 }, () => Q.runDue(['t-race'])));
    assert.strictEqual(seen.length, 100); assert.strictEqual(new Set(seen).size, 100);
    assert.strictEqual(Number((await sql("SELECT COUNT(*) FROM jobs WHERE queue='t-race' AND state='done'", DB)).rows[0].count), 100);
  });
  await test('singleton jobs: a second request while one is waiting does nothing; allowed again once it is done', async () => {
    Q.register('t-single', async () => {});
    const a = await Q.enqueue('t-single', {}, { singletonKey: 'k:1' }), b = await Q.enqueue('t-single', {}, { singletonKey: 'k:1' });
    assert.ok(a); assert.strictEqual(b, null);
    const many = await Promise.all(Array.from({ length: 6 }, () => Q.enqueue('t-single', {}, { singletonKey: 'k:2' }))); assert.strictEqual(many.filter(Boolean).length, 1);
    await Q.runDue(['t-single']); assert.ok(await Q.enqueue('t-single', {}, { singletonKey: 'k:1' }));
  });
  await test('a job saved inside a transaction exists only if the transaction commits', async () => {
    await assert.rejects(db.tx(async () => { await Q.enqueue('t-tx', { n: 1 }); throw new Error('order failed'); }), /order failed/);
    assert.strictEqual(Number((await sql("SELECT COUNT(*) FROM jobs WHERE queue='t-tx'", DB)).rows[0].count), 0);
    await db.tx(async () => { await Q.enqueue('t-tx', { n: 2 }); });
    assert.strictEqual(Number((await sql("SELECT COUNT(*) FROM jobs WHERE queue='t-tx'", DB)).rows[0].count), 1);
  });
  await test('a job whose worker died is picked up again; one that keeps killing workers is failed', async () => {
    const seen = []; Q.register('t-crash', async (p) => { seen.push(p.n); });
    const id = await Q.enqueue('t-crash', { n: 1 }); await sql("UPDATE jobs SET state='active', attempts=1, locked_until=1 WHERE id=$1", DB, [id]);
    await Q.runDue(['t-crash']); assert.deepStrictEqual(seen, [1]); assert.strictEqual((await job(id)).state, 'done'); assert.strictEqual((await job(id)).attempts, 2);
    const id2 = await Q.enqueue('t-crash', { n: 2 }, { maxAttempts: 2 }); await sql("UPDATE jobs SET state='active', attempts=2, locked_until=1 WHERE id=$1", DB, [id2]);
    await Q.runDue(['t-crash']); const j2 = await job(id2); assert.strictEqual(j2.state, 'failed'); assert.ok(!seen.includes(2));
  });
  await test('scheduled jobs: five instances asking at once add one job per interval', async () => {
    Q.register('t-every', async () => {});
    const ids = await Promise.all(Array.from({ length: 5 }, () => Q.enqueueEvery('t-every', 600))); assert.strictEqual(ids.filter(Boolean).length, 1);
    await Q.runDue(['t-every']); assert.strictEqual(await Q.enqueueEvery('t-every', 600), null, 'not again within the interval');
    await sql("UPDATE jobs SET created=created-1000 WHERE queue='t-every'", DB); assert.ok(await Q.enqueueEvery('t-every', 600));
  });
  await sql('DELETE FROM jobs', DB); // leave nothing from the module tests behind
  await db.end();

  console.log('\nWhole shop with fake Resend and Paystack');
  const m = await mocks.start();
  const base = 4000 + Math.floor(Math.random() * 90), P = [base, base + 1], procs = [];
  const KEY = 'sk_test_queuetest';
  const start = (port, name) => { const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), INSTANCE_ID: name, DATABASE_URL: withDb(DB), PGSSL: process.env.PGSSL_TEST || 'disable', BASE_URL: 'http://127.0.0.1:' + port, STORAGE_DRIVER: 'local', DATA_DIR: require('os').tmpdir() + '/sb-queue-' + name, WORKER: '', WORKER_POLL_MS: '100', JOB_BACKOFF_BASE_SECONDS: '0', CACHE_DISABLED: '1', RESEND_API_KEY: 're_test', RESEND_API_URL: m.url, PAYSTACK_SECRET_KEY: KEY, PAYSTACK_API_URL: m.url }, stdio: ['ignore', 'pipe', 'pipe'] }); p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; }); procs.push(p); return p; };
  const up = async (port) => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* wait */ } await sleep(100); } throw new Error('no start on ' + port); };
  try {
    start(P[0], 'A'); await up(P[0]); start(P[1], 'B'); await up(P[1]);
    const A = new Client('http://127.0.0.1:' + P[0]), B = new Client('http://127.0.0.1:' + P[1]), admin = new Client(A.base);
    assert.strictEqual((await admin.post('/api/admin/setup', { name: 'Boss', email: 'boss@example.com', password: 'correct horse' })).status, 200);
    // Three plain products with plenty of stock (raised through the admin so the test does not depend on the demo data).
    const prods = [];
    for (const cand of (await A.get('/api/products?store=electronics')).json.products.filter((x) => !x.hasVariants).slice(0, 3)) {
      const p = (await admin.get('/api/admin/products/' + cand.id)).json.product; p.stock = 500; p.variants = [];
      assert.strictEqual((await admin.put('/api/admin/products/' + cand.id, p)).status, 200); prods.push(cand);
    }
    assert.strictEqual(prods.length, 3);
    let ipn = 0;
    const order = (c, item, payment, email, n = 1) => c.post('/api/checkout', { items: [{ productId: item.id, qty: n }], contact: { name: 'Q Tester', email, phone: '08031234567' }, address: { state: 'Lagos', address: '1 Test Road' }, delivery: 'standard', payment }, { 'X-Forwarded-For': '10.1.' + Math.floor(++ipn / 250) + '.' + (ipn % 250) }); // one address per shopper, so the per-address checkout limit does not interfere
    global.__dbg = () => sql("SELECT id,queue,state,attempts,run_at,locked_until,last_error FROM jobs WHERE state IN ('queued','active') ORDER BY id", DB);
    const jobsOf = async () => (await admin.get('/api/admin/jobs')).json;
    const idle = () => waitFor(async () => { const o = (await jobsOf()).overview; return !o.queued && !o.active; }, 10000, 'worker to finish');
    const outbox = async (re) => (await admin.get('/api/admin/outbox')).json.emails.filter((e) => re.test(e.subject));

    await test('order confirmation emails go through the worker; a Resend outage is retried and the email arrives exactly once', async () => {
      m.state.resend.byTo['retry@example.com'] = [500, 503]; m.state.resend.calls.length = 0;
      const r = await order(A, prods[0], 'pod', 'retry@example.com'); assert.strictEqual(r.status, 200);
      await idle(); const mine = m.state.resend.calls.filter((c) => c.to === 'retry@example.com');
      assert.deepStrictEqual(mine.map((c) => c.status), [500, 503, 200], 'two failures then success'); assert.strictEqual(new Set(mine.map((c) => c.key)).size, 1, 'same idempotency key on every try');
      assert.ok(/^outbox-\d+$/.test(mine[0].key)); assert.strictEqual(mine[0].auth, 'Bearer re_test');
      const row = (await outbox(new RegExp(r.json.ref)))[0]; assert.strictEqual(row.sent, 1); assert.strictEqual((await jobsOf()).overview.failed, 0);
    });
    await test('checkout does not wait for email: it answers while Resend is down', async () => {
      m.state.resend.byTo['slow@example.com'] = [500, 500, 500, 500, 500, 500, 500, 500]; const t0 = Date.now();
      const r = await order(B, prods[1], 'pod', 'slow@example.com'); assert.strictEqual(r.status, 200); assert.ok(Date.now() - t0 < 1500, 'answered in ' + (Date.now() - t0) + ' ms');
      await idle(); m.state.resend.byTo = {};
    });
    await test('a permanently rejected email goes to the failed list at once; fixing the cause and pressing retry sends it', async () => {
      await admin.post('/api/admin/jobs/retry-all'); await idle(); m.state.resend.calls.length = 0;
      m.state.resend.byTo['bad@example.com'] = [422]; const r = await order(A, prods[2], 'pod', 'bad@example.com'); assert.strictEqual(r.status, 200);
      const failedJob = await waitFor(async () => (await jobsOf()).failed.find((f) => f.queue === 'email'), 8000, 'failed email job');
      assert.match(failedJob.last_error, /422/); assert.strictEqual(failedJob.attempts, 1);
      assert.strictEqual((await admin.post('/api/admin/jobs/' + failedJob.id + '/retry')).status, 200); await idle();
      assert.ok(m.state.resend.calls.some((c) => c.to === 'bad@example.com' && c.status === 200)); assert.strictEqual((await jobsOf()).failed.length, 0);
      assert.strictEqual((await admin.post('/api/admin/jobs/999999/retry')).status, 404);
    });
    await test('20 orders over two instances: each customer is emailed exactly once, nothing lost or doubled', async () => {
      m.state.resend.calls.length = 0;
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => order(i % 2 ? A : B, prods[i % prods.length], 'pod', `bulk${i}@example.com`)));
      if (!rs.every((r) => r.status === 200)) console.log(JSON.stringify((await sql('SELECT key,n FROM rate_limits ORDER BY n DESC LIMIT 6', DB)).rows));
      assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => [r.status, r.json && r.json.error])));
      await idle();
      for (let i = 0; i < 20; i++) assert.strictEqual(m.state.resend.calls.filter((c) => c.to === `bulk${i}@example.com` && c.status === 200).length, 1, 'bulk' + i);
      assert.strictEqual(new Set(m.state.resend.calls.map((c) => c.key)).size, m.state.resend.calls.length, 'no email id used twice');
    });

    const hook = (c, body, sig) => { const raw = JSON.stringify(body); return c.post('/api/paystack/webhook', raw, { 'x-paystack-signature': sig === undefined ? crypto.createHmac('sha512', KEY).update(raw).digest('hex') : sig }); };
    await test('Paystack webhook: unsigned or wrongly signed calls are refused and queue nothing', async () => {
      const before = (await sql("SELECT COUNT(*) FROM jobs WHERE queue='paystack-webhook'", DB)).rows[0].count;
      assert.strictEqual((await hook(A, { event: 'charge.success', data: { reference: 'SB-XXXXXX' } }, 'deadbeef')).status, 401); assert.strictEqual((await hook(A, { event: 'charge.success', data: { reference: 'SB-XXXXXX' } }, '')).status, 401);
      assert.strictEqual((await sql("SELECT COUNT(*) FROM jobs WHERE queue='paystack-webhook'", DB)).rows[0].count, before);
    });
    let payOrder;
    await test('Paystack webhook is answered at once and confirmed by the worker, retrying while Paystack is down', async () => {
      const r = await order(A, prods[0], 'paystack', 'payer@example.com'); assert.strictEqual(r.json.next, 'paystack'); payOrder = r.json.ref;
      const total = (await admin.get('/api/admin/orders')).json.orders.find((o) => o.ref === payOrder).total;
      m.state.paystack.verifyDown = true; m.state.paystack.verify[payOrder] = { status: 'success', amount: total * 100 };
      const t0 = Date.now(); assert.strictEqual((await hook(B, { event: 'charge.success', data: { reference: payOrder } })).status, 200); assert.ok(Date.now() - t0 < 1000, 'webhook answered quickly');
      await sleep(600); let o = (await admin.get('/api/admin/orders')).json.orders.find((x) => x.ref === payOrder); assert.strictEqual(o.payment_status, 'unpaid', 'not paid while Paystack cannot confirm');
      m.state.paystack.verifyDown = false;
      await waitFor(async () => (await admin.get('/api/admin/orders')).json.orders.find((x) => x.ref === payOrder).payment_status === 'paid', 8000, 'order marked paid');
      await idle(); assert.strictEqual((await outbox(new RegExp('Payment received for ' + payOrder))).length, 1);
      await hook(A, { event: 'charge.success', data: { reference: payOrder } }); await hook(B, { event: 'charge.success', data: { reference: payOrder } }); await idle();
      assert.strictEqual((await outbox(new RegExp('Payment received for ' + payOrder))).length, 1, 'repeat webhooks do not repeat the email');
    });
    await test('Paystack webhook with the wrong amount never marks the order paid; it lands in the failed list', async () => {
      const r = await order(A, prods[1], 'paystack', 'cheat@example.com'); const ref = r.json.ref;
      m.state.paystack.verify[ref] = { status: 'success', amount: 100 }; // paid 1 naira for a bigger order
      assert.strictEqual((await hook(A, { event: 'charge.success', data: { reference: ref } })).status, 200);
      const f = await waitFor(async () => (await jobsOf()).failed.find((x) => x.payload.includes(ref)), 10000, 'failed webhook job');
      assert.strictEqual((await admin.get('/api/admin/orders')).json.orders.find((x) => x.ref === ref).payment_status, 'unpaid'); assert.match(f.last_error, /not confirmed/);
      await admin.del('/api/admin/jobs/' + f.id);
    });
    await test('a payment for an order that does not exist is ignored safely', async () => {
      assert.strictEqual((await hook(A, { event: 'charge.success', data: { reference: 'SB-NOSUCH' } })).status, 200); await idle();
      assert.strictEqual((await jobsOf()).overview.failed, 0);
    });
    await test('scheduled housekeeping jobs are queued once across both instances', async () => {
      await sleep(1500); const rows = (await sql("SELECT queue, COUNT(*) n FROM jobs WHERE queue IN ('cleanup','expire-unpaid','remind-abandoned') GROUP BY queue", DB)).rows;
      assert.strictEqual(rows.length, 3); assert.ok(rows.every((r) => Number(r.n) === 1), JSON.stringify(rows));
    });
    await test('both instances really share the work', async () => {
      const log = procs.map((p) => p.log).join('\n'); assert.ok(!/Unhandled error/.test(log), 'no unhandled errors in the logs');
    });
  } catch (e) { failed++; console.log('  FAIL setup: ' + e.message); console.log(procs.map((p, i) => '--- instance ' + 'AB'[i] + ' ---\n' + p.log.split('\n').slice(-14).join('\n')).join('\n')); }
  finally { procs.forEach((p) => p.kill()); m.close(); await sleep(300); await sql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); }
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})();
