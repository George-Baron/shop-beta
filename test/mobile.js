'use strict';
// Mobile app sign-in check: bearer tokens, refresh rotation and reuse detection, device sessions, account summary, API parity with the website.
// Run with: npm run test:mobile   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_mobile_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const FAKE = 4900 + Math.floor(Math.random() * 90), P1 = FAKE + 100;
const PAYKEY = 'sk_test_wallet';
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
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(P1), BASE_URL: 'http://127.0.0.1:' + P1, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', PAYSTACK_SECRET_KEY: PAYKEY, PAYSTACK_API_URL: 'http://127.0.0.1:' + FAKE, RESEND_API_KEY: '', RATE_LIMIT_MULTIPLIER: '4', WORKER_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.log = ''; app.stdout.on('data', (d) => { app.log += d; }); app.stderr.on('data', (d) => { app.log += d; });
  try {
    await up();
    const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' })).c;
    const ann = await register('Ann'), bob = await register('Bob');

    console.log('Mobile sign-in');
    const PW = 'Velt0-Wallet-Qx7';
    const login = (email, device = { name: 'Pixel 9', platform: 'android', appVersion: '1.0.0' }, pw = PW) => call('POST', '/api/mobile/v1/auth/login', { email, password: pw, device });
    const bearer = (t) => ({ Authorization: 'Bearer ' + t });
    const get2 = (url, t) => call('GET', url, undefined, null, bearer(t));
    const ann3 = await register('Ann Mobile');
    let s1;
    await test('a customer signs in from an app and gets an access token and a refresh token', async () => {
      const r = await login(ann3.email); assert.strictEqual(r.s, 200, r.t); s1 = r.j;
      assert.strictEqual(s1.token_type, 'Bearer'); assert.ok(/^[0-9a-f]{64}$/.test(s1.access_token) && /^[0-9a-f]{64}$/.test(s1.refresh_token)); assert.ok(s1.expires_in > 0); assert.strictEqual(s1.user.email, ann3.email); assert.ok(!('password' in s1.user));
    });
    await test('wrong password, unknown email and staff accounts cannot get app tokens (same message)', async () => {
      const a = await login(ann3.email, undefined, 'nope-nope-nope'), b = await login('nobody@example.com'), c = await login('owner@example.com', undefined, 'OwnerPass123');
      assert.deepStrictEqual([a.s, b.s, c.s], [401, 401, 401]); assert.strictEqual(a.j.error, b.j.error); assert.strictEqual(a.j.error, c.j.error);
    });
    await test('repeated wrong passwords lock the sign-in, just like the website', async () => {
      const x = await register('Lock Me'); let last; for (let i = 0; i < 36; i++) { last = await login(x.email, undefined, 'bad-bad-bad-bad'); if (last.s === 429) break; } assert.strictEqual(last.s, 429);
    });
    await test('the bearer token opens the wallet, rewards, cards and shop endpoints, and the website cookie still works', async () => {
      for (const u of ['/api/mobile/v1/wallet', '/api/mobile/v1/loyalty', '/api/mobile/v1/cards', '/api/wallet', '/api/me']) { const r = await get2(u, s1.access_token); assert.strictEqual(r.s, 200, u + ' ' + r.t); }
      assert.strictEqual((await call('GET', '/api/mobile/v1/wallet', null, ann3.cookie)).s, 200);
    });
    await test('no token, a wrong token and a malformed header are all signed out', async () => {
      assert.strictEqual((await call('GET', '/api/mobile/v1/wallet')).s, 401); assert.strictEqual((await get2('/api/mobile/v1/wallet', 'f'.repeat(64))).s, 401); assert.strictEqual((await call('GET', '/api/mobile/v1/wallet', undefined, null, { Authorization: 'Bearer nonsense' })).s, 401);
    });
    await test('tokens are stored only as hashes', async () => {
      const dump = JSON.stringify(await q('SELECT * FROM device_sessions')); assert.ok(!dump.includes(s1.access_token) && !dump.includes(s1.refresh_token));
    });
    await test('the account summary fills the dashboard in one call', async () => {
      const r = await get2('/api/mobile/v1/account', s1.access_token); assert.strictEqual(r.s, 200, r.t);
      for (const k of ['profile', 'wallet', 'rewards', 'card', 'recent_orders']) assert.ok(k in r.j, k);
      assert.strictEqual(r.j.wallet.available_balance, 0); assert.strictEqual(r.j.rewards.tier.name, 'Bronze'); assert.strictEqual(r.j.card.programme_available, false);
      assert.strictEqual((await call('GET', '/api/account/summary', null, ann3.cookie)).s, 200); assert.strictEqual((await call('GET', '/api/account/summary')).s, 401);
    });
    let s2;
    await test('refreshing gives a new pair; the old access and refresh tokens stop working', async () => {
      const r = await call('POST', '/api/mobile/v1/auth/refresh', { refresh_token: s1.refresh_token }); assert.strictEqual(r.s, 200, r.t); s2 = r.j;
      assert.notStrictEqual(s2.access_token, s1.access_token); assert.strictEqual((await get2('/api/mobile/v1/wallet', s1.access_token)).s, 401); assert.strictEqual((await get2('/api/mobile/v1/wallet', s2.access_token)).s, 200);
    });
    await test('two parallel refreshes with the same token: one wins', async () => {
      const rs = await Promise.all([call('POST', '/api/mobile/v1/auth/refresh', { refresh_token: s2.refresh_token }), call('POST', '/api/mobile/v1/auth/refresh', { refresh_token: s2.refresh_token })]);
      assert.deepStrictEqual(rs.map((r) => r.s).sort(), [200, 401]); s2 = rs.find((r) => r.s === 200).j;
      assert.strictEqual((await get2('/api/mobile/v1/wallet', s2.access_token)).s, 200); // the loser did not sign the device out
    });
    await test('re-using an old refresh token (a stolen copy) signs that device out completely', async () => {
      const fresh = await login(ann3.email), r1 = await call('POST', '/api/mobile/v1/auth/refresh', { refresh_token: fresh.j.refresh_token }); assert.strictEqual(r1.s, 200);
      assert.strictEqual((await call('POST', '/api/mobile/v1/auth/refresh', { refresh_token: fresh.j.refresh_token })).s, 401); // an immediate retry is refused but harmless
      assert.strictEqual((await get2('/api/mobile/v1/wallet', r1.j.access_token)).s, 200);
      await q("UPDATE device_sessions SET rotated_at=rotated_at-60 WHERE prev_refresh_hash=$1", [require('crypto').createHash('sha256').update(fresh.j.refresh_token).digest('hex')]);
      assert.strictEqual((await call('POST', '/api/mobile/v1/auth/refresh', { refresh_token: fresh.j.refresh_token })).s, 401); // the thief, later
      assert.strictEqual((await get2('/api/mobile/v1/wallet', r1.j.access_token)).s, 401); assert.strictEqual((await call('POST', '/api/mobile/v1/auth/refresh', { refresh_token: r1.j.refresh_token })).s, 401); // and the real app must sign in again
    });
    await test('an expired access token is refused but can be refreshed', async () => {
      await q("UPDATE device_sessions SET access_expires=1 WHERE access_hash=$1", [require('crypto').createHash('sha256').update(s2.access_token).digest('hex')]);
      assert.strictEqual((await get2('/api/mobile/v1/wallet', s2.access_token)).s, 401); const r = await call('POST', '/api/mobile/v1/auth/refresh', { refresh_token: s2.refresh_token }); assert.strictEqual(r.s, 200); s2 = r.j;
    });
    await test('device list, removing one device and signing out', async () => {
      const second = (await login(ann3.email, { name: 'iPhone 16', platform: 'ios', appVersion: '1.0.1' })).j;
      const d = (await get2('/api/mobile/v1/auth/devices', second.access_token)).j.devices; assert.ok(d.length >= 2); assert.strictEqual(d.filter((x) => x.current).length, 1); assert.strictEqual(d.find((x) => x.current).device, 'iPhone 16');
      const other = d.find((x) => !x.current); assert.strictEqual((await call('DELETE', '/api/mobile/v1/auth/devices/' + other.id, undefined, null, bearer(second.access_token))).s, 200);
      assert.strictEqual((await call('DELETE', '/api/mobile/v1/auth/devices/' + other.id, undefined, null, bearer(second.access_token))).s, 404);
      assert.strictEqual((await call('POST', '/api/mobile/v1/auth/logout', {}, null, bearer(second.access_token))).s, 200); assert.strictEqual((await get2('/api/mobile/v1/wallet', second.access_token)).s, 401);
    });
    await test('a customer cannot see or remove another customer\'s devices', async () => {
      const bob3 = await register('Bob Mobile'), b = (await login(bob3.email)).j, a = (await login(ann3.email)).j;
      const aId = (await get2('/api/mobile/v1/auth/devices', a.access_token)).j.devices.find((x) => x.current).id;
      assert.strictEqual((await call('DELETE', '/api/mobile/v1/auth/devices/' + aId, undefined, null, bearer(b.access_token))).s, 404); assert.strictEqual((await get2('/api/mobile/v1/wallet', a.access_token)).s, 200);
    });
    await test('changing the password signs out every app', async () => {
      const x = await register('Pw Change'), t = (await login(x.email)).j; assert.strictEqual((await get2('/api/mobile/v1/wallet', t.access_token)).s, 200);
      const r = await call('PUT', '/api/me', { name: 'Pw Change', phone: '08030000000', password: PW, newPassword: 'Another-Str0ng-Pw-92' }, x.cookie); assert.ok(r.s === 200, r.t);
      assert.strictEqual((await get2('/api/mobile/v1/wallet', t.access_token)).s, 401); assert.strictEqual((await call('POST', '/api/mobile/v1/auth/refresh', { refresh_token: t.refresh_token })).s, 401);
    });
    await test('a switched-off account is signed out of its apps', async () => {
      const x = await register('Off Soon'), t = (await login(x.email)).j; await q('UPDATE users SET active=0 WHERE id=$1', [x.id]);
      assert.strictEqual((await get2('/api/mobile/v1/wallet', t.access_token)).s, 401); assert.strictEqual((await call('POST', '/api/mobile/v1/auth/refresh', { refresh_token: t.refresh_token })).s, 401); assert.strictEqual((await login(x.email)).s, 403);
    });
    await test('an app can pay from the wallet at checkout with only a bearer token (no cookie, no website)', async () => {
      const x = await register('App Shopper'), t = (await login(x.email)).j; await call('GET', '/api/wallet/fund/' + await fund(x, 900000), null, x.cookie);
      const prod = (await q('SELECT id FROM products WHERE active=1 AND stock>=30 AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 1'))[0];
      const body = { items: [{ productId: prod.id, qty: 1 }], contact: { name: 'App Shopper', email: 'app@example.com', phone: '08031112222' }, address: { state: 'Lagos', city: 'Yaba', address: '1 Road' }, delivery: 'standard', payment: 'wallet' };
      const r = await call('POST', '/api/mobile/v1/checkout', body, null, bearer(t.access_token)); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.next, 'wallet');
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
