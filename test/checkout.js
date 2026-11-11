'use strict';
// Step 6 check: safe checkout (one order per attempt), order states, pay-on-delivery confirmation, payment checks.
// Run with: npm run test:checkout   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_checkout_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const FAKE = 4900 + Math.floor(Math.random() * 90), P1 = FAKE + 100;
const PAYKEY = 'sk_test_checkout';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-checkout-'));
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(200); } };

const fx = { inits: 0, amountOverride: null, amounts: {} };
const fake = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const body = Buffer.concat(c).toString(); const send = (s, o) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/emails') return send(200, { id: 'x' });
    if (req.url === '/transaction/initialize') { fx.inits++; const j = JSON.parse(body); fx.amounts[j.reference] = j.amount; return send(200, { status: true, data: { authorization_url: 'http://pay.test/' + j.reference + '/' + fx.inits } }); }
    const m = /^\/transaction\/verify\/(.+)$/.exec(req.url);
    if (m) { const ref = decodeURIComponent(m[1]); return send(200, { status: true, data: { status: 'success', currency: 'NGN', amount: fx.amountOverride != null ? fx.amountOverride : fx.amounts[ref], reference: ref } }); }
    send(404, {});
  });
});
const q = async (sql, args) => { const c = new Pg({ connectionString: URL_DB }); await c.connect(); try { return (await c.query(sql, args)).rows; } finally { await c.end(); } };
const pg = async (sql) => { const c = new Pg({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const call = async (method, url, body, cookie, headers = {}) => { const raw = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)); const r = await fetch(`http://127.0.0.1:${P1}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw }); const sc = r.headers.getSetCookie ? r.headers.getSetCookie()[0] || '' : ''; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, c: sc.split(';')[0] }; };
const up = async () => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${P1}/health`); return; } catch { await sleep(100); } } throw new Error('app did not start'); };
const key = () => crypto.randomUUID();

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  await pg(`CREATE DATABASE ${DB}`);
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(P1), BASE_URL: 'http://127.0.0.1:' + P1, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', PAYSTACK_SECRET_KEY: PAYKEY, PAYSTACK_API_URL: 'http://127.0.0.1:' + FAKE, RESEND_API_KEY: '', RATE_LIMIT_MULTIPLIER: '100', WORKER_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.log = ''; app.stdout.on('data', (d) => { app.log += d; }); app.stderr.on('data', (d) => { app.log += d; });
  await up();
  const cookie = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' })).c;
  const rows = await q("SELECT id, slug, stock FROM products WHERE active=1 AND stock>=30 AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 4");
  const [P_A, P_B, P_C, P_D] = rows;
  const stock = async (p) => Number((await q('SELECT stock FROM products WHERE id=$1', [p.id]))[0].stock);
  const count = async (email) => Number((await q('SELECT COUNT(*) n FROM orders WHERE email=$1', [email]))[0].n);
  const body = (p, email, payment = 'pod', qty = 1) => ({ items: [{ productId: p.id, qty }], contact: { name: 'Ada Obi', email, phone: ('080' + String(parseInt(require('crypto').createHash('md5').update(email).digest('hex').slice(0, 7), 16)).padStart(8, '0').slice(-8)) }, address: { state: 'Lagos', city: 'Yaba', address: '1 Road Street' }, delivery: 'standard', payment });
  const withKey = (b, k) => ({ ...b, idempotencyKey: k });

  await test('the same checkout key twice gives one order and takes stock once', async () => {
    const k = key(), b = body(P_A, 'idem1@example.com'), s0 = await stock(P_A);
    const r1 = await call('POST', '/api/checkout', withKey(b, k)); const r2 = await call('POST', '/api/checkout', withKey(b, k));
    assert.strictEqual(r1.s, 200); assert.strictEqual(r2.s, 200); assert.strictEqual(r1.j.ref, r2.j.ref); assert.strictEqual(r2.j.replayed, true);
    assert.strictEqual(await count('idem1@example.com'), 1); assert.strictEqual(await stock(P_A), s0 - 1);
  });
  await test('the key may also come in the Idempotency-Key header', async () => {
    const k = key(), b = body(P_A, 'idem2@example.com');
    const r1 = await call('POST', '/api/checkout', b, null, { 'Idempotency-Key': k }); const r2 = await call('POST', '/api/checkout', b, null, { 'Idempotency-Key': k });
    assert.strictEqual(r1.j.ref, r2.j.ref); assert.strictEqual(await count('idem2@example.com'), 1);
  });
  await test('12 identical checkouts fired at once make exactly one order', async () => {
    const k = key(), b = withKey(body(P_B, 'race@example.com'), k), s0 = await stock(P_B);
    const rs = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/api/checkout', b)));
    assert.ok(rs.every((r) => r.s === 200), 'statuses ' + rs.map((r) => r.s)); assert.strictEqual(new Set(rs.map((r) => r.j.ref)).size, 1);
    assert.strictEqual(await count('race@example.com'), 1); assert.strictEqual(await stock(P_B), s0 - 1);
  });
  await test('the same key with a different cart is refused, not silently merged', async () => {
    const k = key(); await call('POST', '/api/checkout', withKey(body(P_A, 'diff@example.com'), k));
    const r = await call('POST', '/api/checkout', withKey(body(P_A, 'diff@example.com', 'pod', 2), k));
    assert.strictEqual(r.s, 409); assert.strictEqual(await count('diff@example.com'), 1);
  });
  await test('a malformed key is ignored: no dedupe, no crash', async () => {
    const b = withKey(body(P_C, 'nokey@example.com'), 'short');
    assert.strictEqual((await call('POST', '/api/checkout', b)).s, 200); assert.strictEqual((await call('POST', '/api/checkout', b)).s, 200);
    assert.strictEqual(await count('nokey@example.com'), 2);
  });
  await test('an online payment sent twice starts one Paystack payment and returns the same link', async () => {
    const k = key(), b = withKey(body(P_C, 'paytwice@example.com', 'paystack'), k); fx.inits = 0;
    const r1 = await call('POST', '/api/checkout', b); const r2 = await call('POST', '/api/checkout', b);
    assert.strictEqual(r1.j.next, 'paystack'); assert.strictEqual(r2.j.url, r1.j.url); assert.strictEqual(fx.inits, 1); assert.strictEqual(await count('paytwice@example.com'), 1);
  });
  await test('the stored payment link and checkout key never appear in the customer order view', async () => {
    const r = await call('POST', '/api/checkout', body(P_C, 'priv@example.com', 'paystack'));
    const o = (await call('POST', '/api/orders/lookup', { ref: r.j.ref, email: 'priv@example.com' })).j.order;
    const dump = JSON.stringify(o); assert.ok(!/pay_url|idem_key|idem_hash|pay\.test/.test(dump));
  });

  let podId, podRef;
  await test('pay on delivery: cannot be prepared before the confirmation call', async () => {
    const r = await call('POST', '/api/checkout', body(P_D, 'pod@example.com')); podRef = r.j.ref;
    podId = Number((await q('SELECT id FROM orders WHERE ref=$1', [podRef]))[0].id);
    for (const st of ['processing', 'shipped', 'delivered']) assert.strictEqual((await call('PUT', '/api/admin/orders/' + podId, { status: st }, cookie)).s, 400, st);
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + podId, { status: 'paid' }, cookie)).s, 400);
  });
  await test('confirming records who and when, the customer can see it, and the order can then move on', async () => {
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + podId, { status: 'confirmed' }, cookie)).s, 200);
    const o = (await q('SELECT status, confirmed_at, confirmed_by FROM orders WHERE id=$1', [podId]))[0];
    assert.strictEqual(o.status, 'confirmed'); assert.ok(o.confirmed_at); assert.ok(o.confirmed_by);
    const pub = (await call('POST', '/api/orders/lookup', { ref: podRef, email: 'pod@example.com' })).j.order; assert.strictEqual(pub.status, 'confirmed'); assert.ok(pub.events.some((e) => /Confirmed by phone/.test(e.note)));
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + podId, { status: 'processing' }, cookie)).s, 200);
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + podId, { status: 'shipped' }, cookie)).s, 200);
  });
  await test('orders never move backwards, and a delivered order is final', async () => {
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + podId, { status: 'processing' }, cookie)).s, 400);
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + podId, { status: 'pending' }, cookie)).s, 400);
    // With a handover code in play, "delivered" is set by the code or by a logged admin override, not by a dropdown.
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + podId, { status: 'delivered' }, cookie)).s, 400);
    assert.strictEqual((await call('POST', '/api/admin/orders/' + podId + '/handover', { action: 'complete', reason: 'short' }, cookie)).s, 400);
    assert.strictEqual((await call('POST', '/api/admin/orders/' + podId + '/handover', { action: 'complete', reason: 'Rider phone died; customer confirmed by call', cash: true }, cookie)).s, 200);
    assert.strictEqual((await q('SELECT payment_status FROM orders WHERE id=$1', [podId]))[0].payment_status, 'paid'); // cash collected on delivery
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + podId, { status: 'cancelled' }, cookie)).s, 400);
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + podId, { status: 'shipped' }, cookie)).s, 400);
  });
  await test('"Confirmed" is only for pay on delivery; two staff confirming at once confirm once', async () => {
    const online = (await q("SELECT id FROM orders WHERE email='priv@example.com'"))[0];
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + online.id, { status: 'confirmed' }, cookie)).s, 400);
    const r = await call('POST', '/api/checkout', body(P_D, 'dbl@example.com')); const id = Number((await q('SELECT id FROM orders WHERE ref=$1', [r.j.ref]))[0].id);
    const rs = await Promise.all([call('PUT', '/api/admin/orders/' + id, { status: 'confirmed' }, cookie), call('PUT', '/api/admin/orders/' + id, { status: 'confirmed' }, cookie)]);
    assert.ok(rs.every((x) => [200, 409].includes(x.s)), rs.map((x) => x.s).join());
    assert.strictEqual((await q('SELECT status FROM orders WHERE id=$1', [id]))[0].status, 'confirmed');
  });
  await test('an unconfirmed pay-on-delivery order is cancelled after the time limit and its stock returns', async () => {
    const r = await call('POST', '/api/checkout', body(P_A, 'stale@example.com')); const s1 = await stock(P_A);
    await q("UPDATE orders SET created = created - 90000 WHERE ref=$1", [r.j.ref]); // 25 hours ago
    process.env.DATABASE_URL = URL_DB; process.env.DATABASE_SSL = 'off';
    const queue = require('../lib/queue'); await queue.enqueue('cron.expireUnconfirmedPod', {}, { key: 'test-expire-' + Date.now() });
    await until(async () => (await q('SELECT status FROM orders WHERE ref=$1', [r.j.ref]))[0].status === 'cancelled');
    assert.strictEqual(await stock(P_A), s1 + 1);
    const ev = await q("SELECT note FROM order_events WHERE order_id=(SELECT id FROM orders WHERE ref=$1) ORDER BY id DESC LIMIT 1", [r.j.ref]); assert.match(ev[0].note, /Not confirmed by phone/);
    // a confirmed one of the same age is left alone
    const ok = (await q("SELECT id, status FROM orders WHERE email='dbl@example.com'"))[0]; await q('UPDATE orders SET created = created - 90000 WHERE id=$1', [ok.id]);
    await queue.enqueue('cron.expireUnconfirmedPod', {}, { key: 'test-expire2-' + Date.now() }); await sleep(1500);
    assert.strictEqual((await q('SELECT status FROM orders WHERE id=$1', [ok.id]))[0].status, 'confirmed');
    await require('../lib/db').close();
  });
  await test('Paystack says success but the amount is wrong: not marked paid, and the order records why', async () => {
    const r = await call('POST', '/api/checkout', body(P_B, 'short@example.com', 'paystack')); fx.amountOverride = 100; // N1 instead of the real total
    const hook = JSON.stringify({ event: 'charge.success', data: { reference: r.j.ref } }), sig = crypto.createHmac('sha512', PAYKEY).update(hook).digest('hex');
    assert.strictEqual((await call('POST', '/api/paystack/webhook', hook, null, { 'x-paystack-signature': sig })).s, 200);
    await until(async () => (await q("SELECT 1 x FROM order_events WHERE order_id=(SELECT id FROM orders WHERE ref=$1) AND note LIKE 'Payment check failed%'", [r.j.ref])).length);
    const o = (await q('SELECT status, payment_status FROM orders WHERE ref=$1', [r.j.ref]))[0]; assert.strictEqual(o.payment_status, 'unpaid'); assert.strictEqual(o.status, 'pending');
    fx.amountOverride = null; // Paystack later reports the right amount: now it is paid
    const hook2 = JSON.stringify({ event: 'charge.success', data: { reference: r.j.ref, again: 1 } }), sig2 = crypto.createHmac('sha512', PAYKEY).update(hook2).digest('hex');
    await q("DELETE FROM jobs WHERE key=$1", ['paystack:' + r.j.ref]);
    await call('POST', '/api/paystack/webhook', hook2, null, { 'x-paystack-signature': sig2 });
    await until(async () => (await q('SELECT payment_status FROM orders WHERE ref=$1', [r.j.ref]))[0].payment_status === 'paid');
  });

  app.kill(); fake.close();
  await sleep(300);
  fs.rmSync(DATA, { recursive: true, force: true });
  await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(app.log.slice(-1500));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
