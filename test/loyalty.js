'use strict';
// VELTO REWARDS check: enrolment, earning on delivery, no double award, refund reversal, tiers, redemption, access control.
// Run with: npm run test:loyalty   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_loyalty_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const FAKE = 4900 + Math.floor(Math.random() * 90), P1 = FAKE + 100;
const PAYKEY = 'sk_test_loyalty';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wallet-'));
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(200); } };

// The fake Paystack: what it says about each reference is set by the test.
const fx = { amounts: {}, status: {}, amountOverride: {} };
const fake = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const body = Buffer.concat(c).toString(); const send = (s, o) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/emails') return send(200, { id: 'x' });
    if (req.url === '/transaction/initialize') { const j = JSON.parse(body); fx.amounts[j.reference] = j.amount; return send(200, { status: true, data: { authorization_url: 'http://pay.test/' + j.reference } }); }
    const m = /^\/transaction\/verify\/(.+)$/.exec(req.url);
    if (m) { const ref = decodeURIComponent(m[1]); return send(200, { status: true, data: { status: fx.status[ref] || 'abandoned', currency: 'NGN', amount: fx.amountOverride[ref] != null ? fx.amountOverride[ref] : fx.amounts[ref], reference: ref } }); }
    send(404, {});
  });
});
const q = async (sql, args) => { const c = new Pg({ connectionString: URL_DB }); await c.connect(); try { return (await c.query(sql, args)).rows; } finally { await c.end(); } };
const pg = async (sql) => { const c = new Pg({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const call = async (method, url, body, cookie, headers = {}) => { const raw = body === undefined || body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)); const r = await fetch(`http://127.0.0.1:${P1}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw }); const sc = r.headers.getSetCookie ? r.headers.getSetCookie()[0] || '' : ''; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, t, c: sc.split(';')[0] }; };
const up = async () => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${P1}/health`); return; } catch { await sleep(100); } } throw new Error('app did not start'); };
const webhook = (ref, sig) => { const raw = JSON.stringify({ event: 'charge.success', data: { reference: ref } }); return call('POST', '/api/paystack/webhook', raw, null, { 'x-paystack-signature': sig || crypto.createHmac('sha512', PAYKEY).update(raw).digest('hex') }); };
let n = 0;
const register = async (name) => { const email = `w${Date.now().toString(36)}${n++}@example.com`; const r = await call('POST', '/api/auth/register', { name, email, phone: '0803' + String(1000000 + n * 7919).slice(0, 7), password: 'Velt0-Wallet-Qx7' }); assert.strictEqual(r.s, 200, 'register ' + r.t); return { email, cookie: r.c, id: Number((await q('SELECT id FROM users WHERE email=$1', [email]))[0].id) }; };
const fund = async (u, amount, status = 'success', override) => { const r = await call('POST', '/api/wallet/fund', { amount }, u.cookie); assert.strictEqual(r.s, 200, 'fund ' + r.t); fx.status[r.j.ref] = status; if (override != null) fx.amountOverride[r.j.ref] = override; return r.j.ref; };
const bal = async (u) => (await call('GET', '/api/wallet', null, u.cookie)).j;

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  await pg(`CREATE DATABASE ${DB}`);
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(P1), BASE_URL: 'http://127.0.0.1:' + P1, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', PAYSTACK_SECRET_KEY: PAYKEY, PAYSTACK_API_URL: 'http://127.0.0.1:' + FAKE, RESEND_API_KEY: '', RATE_LIMIT_MULTIPLIER: '100', WORKER_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.log = ''; app.stdout.on('data', (d) => { app.log += d; }); app.stderr.on('data', (d) => { app.log += d; });
  try {
    await up();
    const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' })).c;
    const ann = await register('Ann'), bob = await register('Bob');

    console.log('Rewards');
    const prod = (await q('SELECT id, price FROM products WHERE active=1 AND stock>=30 AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 1'))[0];
    let uniq = 0;
    const cart = (qty) => ({ items: [{ productId: prod.id, qty }], contact: { name: 'Ada Obi', email: `buyer${Date.now().toString(36)}${uniq++}@example.com`, phone: '0803' + String(2000000 + uniq * 7907).slice(0, 7) }, address: { state: 'Lagos', city: 'Yaba', address: '1 Road Street' }, delivery: 'standard', payment: 'pod' });
    const rewards = async (u) => (await call('GET', '/api/loyalty', null, u.cookie)).j;
    const place = async (u, qty) => { const r = await call('POST', '/api/checkout', cart(qty), u.cookie); assert.strictEqual(r.s, 200, r.t); return (await q('SELECT * FROM orders WHERE ref=$1', [r.j.ref]))[0]; };
    const setStatus = async (o, status) => { const r = await call('PUT', '/api/admin/orders/' + o.id, { status }, admin); assert.strictEqual(r.s, 200, r.t); };
    const deliver = async (o) => call('POST', `/api/admin/orders/${o.id}/handover`, { action: 'complete', reason: 'Customer received the goods at the door', cash: true }, admin);
    const sweep = async () => (await call('POST', '/api/admin/loyalty/sweep', {}, admin)).j;
    const expectPts = (o, rate = 1) => Math.floor((Math.floor(((o.subtotal - o.discount) * 10) / 1000) * rate * 100) / 100);

    await test('a new customer joins VELTO Rewards automatically as Bronze with 0 points and a referral code', async () => {
      const r = await rewards(ann); assert.strictEqual(r.points, 0); assert.strictEqual(r.tier.name, 'Bronze'); assert.ok(/^[0-9A-F]{10}$/.test(r.referral_code)); assert.strictEqual(r.next_tier.name, 'Silver');
      assert.strictEqual((await call('GET', '/api/loyalty')).s, 401);
      assert.strictEqual((await call('GET', '/api/mobile/v1/loyalty', null, ann.cookie)).s, 200);
    });
    let o1;
    await test('an order that is only placed or paid earns no permanent points', async () => {
      o1 = await place(ann, 3); await sweep(); assert.strictEqual((await rewards(ann)).points, 0);
      assert.ok((await rewards(ann)).pending_points >= 0);
    });
    await test('a delivered order earns points: 10 per 1,000 of net goods value, not delivery', async () => {
      const r = await deliver(o1); assert.strictEqual(r.s, 200, r.t);
      const pts = (await rewards(ann)).points, want = expectPts(o1); assert.ok(want > 0, 'test order too small'); assert.strictEqual(pts, want);
      const h = (await call('GET', '/api/loyalty/history', null, ann.cookie)).j.entries[0]; assert.strictEqual(h.kind, 'earn'); assert.strictEqual(h.order_ref, o1.ref);
    });
    await test('running the award again (sweeps, repeats, parallel) never awards twice', async () => {
      const before = (await rewards(ann)).points;
      await Promise.all([sweep(), sweep(), sweep(), rewards(ann), rewards(ann)]); assert.strictEqual((await rewards(ann)).points, before);
      assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM loyalty_ledger WHERE idem_key=$1", ['earn:' + o1.ref]))[0].n), 1);
    });
    await test('a cancelled order earns nothing', async () => {
      const o = await place(bob, 3); await setStatus(o, 'cancelled'); await sweep(); assert.strictEqual((await rewards(bob)).points, 0);
    });
    await test('a refund reverses the points once', async () => {
      const before = (await rewards(ann)).points; await setStatus(o1, 'refunded'); await sweep(); await sweep();
      const r = await rewards(ann); assert.strictEqual(r.points, 0); assert.strictEqual(r.lifetime_points, 0);
      assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM loyalty_ledger WHERE idem_key=$1", ['reverse:' + o1.ref]))[0].n), 1); assert.ok(before > 0);
    });
    await test('points ledger rows cannot be edited or deleted', async () => {
      await assert.rejects(q('UPDATE loyalty_ledger SET points=points+1'), /immutable/); await assert.rejects(q('DELETE FROM loyalty_ledger'), /immutable/); await assert.rejects(q('TRUNCATE loyalty_ledger'), /immutable/);
    });
    await test('a balance cannot go negative in the database', async () => assert.rejects(q('UPDATE loyalty_accounts SET points=-1'), /check/i));
    await test('administrator adjustments need a reason and a reference, and apply once', async () => {
      const url = `/api/admin/loyalty/customers/${bob.id}/adjust`;
      assert.strictEqual((await call('POST', url, { points: 100 }, admin)).s, 400);
      await call('POST', url, { points: 6000, reason: 'welcome gift', reference: 'G1' }, admin); await call('POST', url, { points: 6000, reason: 'welcome gift', reference: 'G1' }, admin);
      assert.strictEqual((await rewards(bob)).points, 6000);
      assert.strictEqual((await call('POST', url, { points: -7000, reason: 'x', reference: 'G2' }, admin)).s, 402);
    });
    await test('only administrators can change rewards settings', async () => {
      assert.strictEqual((await call('PUT', '/api/admin/loyalty/config', { loyalty_points_per_1000: 99 }, ann.cookie)).s, 401);
      assert.strictEqual((await call('GET', '/api/admin/loyalty/report', null, ann.cookie)).s, 401);
    });
    await test('redeeming points for wallet credit is off until the administrator enables it', async () => {
      assert.strictEqual((await call('POST', '/api/loyalty/redeem', { points: 1000 }, bob.cookie)).s, 400); assert.strictEqual((await rewards(bob)).points, 6000);
    });
    await test('redemption: 1,000 points = N100, minimum and steps enforced, balance verified on the server', async () => {
      assert.strictEqual((await call('PUT', '/api/admin/loyalty/config', { loyalty_wallet_redeem: true }, admin)).s, 200);
      assert.strictEqual((await call('POST', '/api/loyalty/redeem', { points: 500 }, bob.cookie)).s, 400);
      assert.strictEqual((await call('POST', '/api/loyalty/redeem', { points: 1500 }, bob.cookie)).s, 400);
      assert.strictEqual((await call('POST', '/api/loyalty/redeem', { points: 7000 }, bob.cookie)).s, 402);
      const r = await call('POST', '/api/loyalty/redeem', { points: 2000 }, bob.cookie, { 'Idempotency-Key': 'redeem-key-0001' }); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.wallet_credit, 200);
      assert.strictEqual((await rewards(bob)).points, 4000); assert.strictEqual((await call('GET', '/api/wallet', null, bob.cookie)).j.available_balance, 200);
    });
    await test('the same redemption request twice, or 10 at once, redeems once', async () => {
      const rs = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/loyalty/redeem', { points: 1000 }, bob.cookie, { 'Idempotency-Key': 'redeem-key-0002' })));
      assert.ok(rs.every((r) => r.s === 200), rs.map((r) => r.s + r.t).join('|')); assert.strictEqual((await rewards(bob)).points, 3000); assert.strictEqual((await call('GET', '/api/wallet', null, bob.cookie)).j.available_balance, 300);
    });
    await test('10 parallel redemptions without a key never overspend the points', async () => {
      const rs = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/loyalty/redeem', { points: 1000 }, bob.cookie)));
      assert.strictEqual(rs.filter((r) => r.s === 200).length, 3); assert.strictEqual((await rewards(bob)).points, 0);
    });
    await test('tiers follow lifetime points, and the thresholds are configurable', async () => {
      await call('POST', `/api/admin/loyalty/customers/${ann.id}/adjust`, { points: 1, reason: 'x', reference: 'T0' }, admin);
      await call('PUT', '/api/admin/loyalty/tiers/Silver', { min_lifetime: 10, multiplier_pct: 120, benefits: 'Test' }, admin);
      const o = await place(ann, 4); await deliver(o); await sweep();
      const r = await rewards(ann); assert.ok(r.lifetime_points >= 10, JSON.stringify(r)); assert.strictEqual(r.tier.name, 'Silver');
      assert.ok((await call('GET', '/api/loyalty/history', null, ann.cookie)).j.entries.some((e) => e.kind === 'earn'));
    });
    await test('the report shows members, points outstanding and tier mix', async () => {
      const r = (await call('GET', '/api/admin/loyalty/report', null, admin)).j; assert.ok(r.members >= 2, JSON.stringify(r)); assert.ok(r.tier_distribution.length >= 1);
    });
  } finally {
    app.kill(); fake.close(); await sleep(300);
    await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log(app.log.slice(-1500)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
