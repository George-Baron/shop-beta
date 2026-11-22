'use strict';
// Mobile push notifications: tokens, preferences, one push per event, nothing for signed-out phones, dead tokens switched off.
// Run with: npm run test:mobile-push
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client: PgClient } = require('pg');
const mock = require('./mock-apis');

const PORT = 3400 + Math.floor(Math.random() * 400), BASE = `http://127.0.0.1:${PORT}`, ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const TEST_DB = 'sb_test_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
const TEST_URL = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + TEST_DB + '$1');
async function pgAdmin(sql) { const c = new PgClient({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } }
async function pgQ(sql, ...p) { const c = new PgClient({ connectionString: TEST_URL }); await c.connect(); try { return (await c.query(sql, p)).rows; } finally { await c.end(); } }
let passed = 0; const failures = [];
const PW = 'Wholesale-Test-Pass-2026!';

class App {
  constructor() { this.device = { id: 'dev-' + crypto.randomBytes(6).toString('hex'), name: 'Test phone', platform: 'android', appVersion: '1.0.0' }; this.access = ''; }
  async req(method, url, body, extra) {
    const r = await fetch(BASE + '/api/mobile/v1' + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.access ? { Authorization: 'Bearer ' + this.access } : {}), ...(extra || {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  }
  get(u) { return this.req('GET', u); } post(u, b = {}, h) { return this.req('POST', u, b, h); } put(u, b) { return this.req('PUT', u, b); } del(u) { return this.req('DELETE', u); }
  async register(name, email) { const r = await this.req('POST', '/auth/register', { name, email, phone: '08030000009', password: PW, device: this.device }); this.access = r.json.accessToken; return r; }
}
let adminCookie = '';
const adminCall = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(adminCookie ? { Cookie: adminCookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const c = r.headers.getSetCookie ? r.headers.getSetCookie() : []; if (c[0]) adminCookie = c[0].split(';')[0];
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { status: r.status, json: j, text: t };
};
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); }
}

const idem = () => crypto.randomBytes(16).toString('hex');
const tok = () => 'ExponentPushToken[' + crypto.randomBytes(10).toString('hex') + ']';
const wait = async (cond, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await cond(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); } return false; };

(async () => {
  const fake = await mock.start();
  await pgAdmin(`CREATE DATABASE ${TEST_DB}`);
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DATABASE_URL: TEST_URL, DATABASE_SSL: 'off', BASE_URL: BASE, PAYSTACK_SECRET_KEY: 'sk_test_mobile', PAYSTACK_API_URL: fake.url, EXPO_PUSH_URL: fake.url, RESEND_API_KEY: '', ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Owner-pass-2026-xyz', RATE_LIMIT_MULTIPLIER: '100', WORKER_POLL_MS: '200', JOB_BACKOFF_SECONDS: '1,1,1' };
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 150; i++) { try { await fetch(BASE + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  assert.strictEqual((await adminCall('POST', '/api/auth/login', { email: 'owner@example.com', password: 'Owner-pass-2026-xyz' })).status, 200);

  const ada = new App(), bola = new App(), ada2 = new App();
  await ada.register('Ada Obi', 'ada.push@example.com'); await bola.register('Bola Eze', 'bola.push@example.com');
  ada2.device = { ...ada2.device }; { const r = await ada2.req('POST', '/auth/login', { email: 'ada.push@example.com', password: PW, device: ada2.device }); ada2.access = r.json.accessToken; }
  const p = (await pgQ('SELECT id FROM products WHERE active=1 AND vendor_id IS NULL AND stock>=20 AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 1'))[0];
  const contact = { name: 'Ada Obi', email: 'ada.push@example.com', phone: '08031234567' }, address = { state: 'Lagos', city: 'Yaba', address: '5 Herbert Macaulay Way' };
  const place = async (who) => (await who.post('/checkout', { items: [{ productId: p.id, qty: 1 }], contact, address, delivery: 'standard', payment: 'pod' }, { 'Idempotency-Key': idem() })).json;
  const setStatus = (id, status) => adminCall('PUT', '/api/admin/orders/' + id, { status });
  const T1 = tok(), T2 = tok();

  console.log('\nRegistering a phone');
  await test('registering a token needs sign-in and a real Expo token', async () => {
    assert.strictEqual((await new App().post('/push-token', { token: T1 })).status, 401);
    const bad = await ada.post('/push-token', { token: 'not-a-token' }); assert.strictEqual(bad.status, 400); assert.strictEqual(bad.json.code, 'invalid_push_token');
    assert.strictEqual((await ada.post('/push-token', { token: T1, platform: 'android' })).status, 200);
    assert.strictEqual((await ada2.post('/push-token', { token: T2, platform: 'ios' })).status, 200);
    assert.strictEqual((await ada.post('/push-token', { token: T1, platform: 'android' })).status, 200);   // again: still one row
    assert.strictEqual((await pgQ('SELECT COUNT(*)::int n FROM push_tokens WHERE token=$1', T1))[0].n, 1);
  });
  await test('settings start with orders and wholesale on, offers off, and change only what is sent', async () => {
    assert.deepStrictEqual((await ada.get('/notifications/settings')).json.settings, { orders: true, wholesale: true, offers: false });
    assert.deepStrictEqual((await ada.put('/notifications/settings', { offers: true, orders: 'no', junk: 1 })).json.settings, { orders: true, wholesale: true, offers: true });
    assert.deepStrictEqual((await ada.put('/notifications/settings', { offers: false })).json.settings, { orders: true, wholesale: true, offers: false });
    assert.strictEqual((await bola.get('/notifications/settings')).json.settings.offers, false, 'another customer is unaffected');
  });

  console.log('\nSending');
  let order1;
  await test('an order update is pushed once to every phone that is signed in, with no private details', async () => {
    order1 = await place(ada); assert.ok(order1.order || order1.ref, JSON.stringify(order1));
    const id = (await pgQ("SELECT id FROM orders WHERE user_id=(SELECT id FROM users WHERE email='ada.push@example.com') ORDER BY id DESC LIMIT 1"))[0].id;
    order1.id = id; assert.strictEqual((await setStatus(id, 'confirmed')).status, 200);
    assert.ok(await wait(() => fake.state.expo.sent.filter((m) => /confirmed/.test(m.title)).length >= 2), 'both phones got it: ' + JSON.stringify(fake.state.expo.sent));
    const m = fake.state.expo.sent.filter((m) => /confirmed/.test(m.title));
    assert.deepStrictEqual(m.map((x) => x.to).sort(), [T1, T2].sort()); assert.strictEqual(m[0].data.type, 'order'); assert.ok(m[0].data.notificationId);
    assert.ok(!JSON.stringify(m).includes('Herbert') && !JSON.stringify(m).includes('08031234567'));
    await new Promise((r) => setTimeout(r, 800)); assert.strictEqual(fake.state.expo.sent.filter((x) => /confirmed/.test(x.title)).length, 2, 'not repeated');
  });
  await test('the same notification can never be pushed twice, even if the job runs again', async () => {
    const nid = (await pgQ("SELECT id FROM notifications WHERE title LIKE '%confirmed%' AND user_id=(SELECT id FROM users WHERE email='ada.push@example.com') ORDER BY id DESC LIMIT 1"))[0].id;
    const before = fake.state.expo.sent.length;
    await pgQ("INSERT INTO jobs (kind,payload,run_at,key,max_attempts,created) VALUES ('push.send',$1::jsonb,0,'again-1',3,1)", JSON.stringify({ id: Number(nid) }));
    await new Promise((r) => setTimeout(r, 1000)); assert.strictEqual(fake.state.expo.sent.length, before);
  });
  await test('another customer gets nothing for this order, and staff notifications are not pushed', async () => {
    assert.ok(!fake.state.expo.sent.some((m) => m.to !== T1 && m.to !== T2));
  });
  await test('switching a category off stops those pushes but the in-app notification still arrives', async () => {
    await ada.put('/notifications/settings', { orders: false });
    const n0 = fake.state.expo.sent.length;
    assert.strictEqual((await setStatus(order1.id, 'processing')).status, 200);
    assert.ok(await wait(async () => (await pgQ("SELECT 1 FROM notifications WHERE title LIKE '%being prepared%'")).length));
    await new Promise((r) => setTimeout(r, 800)); assert.strictEqual(fake.state.expo.sent.length, n0);
    assert.ok((await ada.get('/notifications')).json.notifications.some((n) => /being prepared/.test(n.title)));
    await ada.put('/notifications/settings', { orders: true });
  });
  await test('a phone that is signed out (or removed) stops getting pushes at once', async () => {
    assert.strictEqual((await ada2.post('/auth/logout')).status, 200);
    const n0 = fake.state.expo.sent.length;
    assert.strictEqual((await setStatus(order1.id, 'shipped')).status, 200);
    assert.ok(await wait(() => fake.state.expo.sent.length > n0));
    const fresh = fake.state.expo.sent.slice(n0); assert.deepStrictEqual(fresh.map((x) => x.to), [T1]);
  });
  const lastPending = async () => (await pgQ("SELECT id FROM orders WHERE user_id=(SELECT id FROM users WHERE email='ada.push@example.com') AND status='pending' ORDER BY id DESC LIMIT 1"))[0].id;
  await test('when Expo says a token is dead it is switched off and not tried again', async () => {
    fake.state.expo.dead[T1] = true;
    await place(ada); const n0 = fake.state.expo.sent.length;
    assert.strictEqual((await setStatus(await lastPending(), 'confirmed')).status, 200);
    assert.ok(await wait(() => fake.state.expo.sent.length > n0));
    assert.ok(await wait(async () => (await pgQ('SELECT disabled_reason FROM push_tokens WHERE token=$1', T1))[0].disabled_reason === 'not_registered'));
    await place(ada); const n1 = fake.state.expo.sent.length;
    assert.strictEqual((await setStatus(await lastPending(), 'confirmed')).status, 200);
    await new Promise((r) => setTimeout(r, 800)); assert.strictEqual(fake.state.expo.sent.length, n1, 'nothing more goes to the dead token');
  });
  await test('when Expo is down the push is retried, and it is sent once when it comes back', async () => {
    const T3 = tok(); fake.state.expo.dead = {}; await ada.post('/push-token', { token: T3 });
    fake.state.expo.down = true; const n0 = fake.state.expo.sent.length;
    await place(ada); assert.strictEqual((await setStatus(await lastPending(), 'confirmed')).status, 200);
    await new Promise((r) => setTimeout(r, 700)); assert.strictEqual(fake.state.expo.sent.length, n0);
    fake.state.expo.down = false;
    // two different notifications were waiting (order placed, order confirmed): each arrives exactly once after Expo is back
    assert.ok(await wait(() => fake.state.expo.sent.length >= n0 + 2, 12000), 'retried and sent');
    await new Promise((r) => setTimeout(r, 1500));
    const got = fake.state.expo.sent.slice(n0); assert.strictEqual(got.length, 2); assert.strictEqual(new Set(got.map((m) => m.data.notificationId)).size, 2);
  });
  await test('removing a token and deleting it from another account', async () => {
    const T4 = tok(); await bola.post('/push-token', { token: T4 });
    assert.strictEqual((await ada.req('DELETE', '/push-token', { token: T4 })).status, 200);
    assert.strictEqual((await pgQ('SELECT COUNT(*)::int n FROM push_tokens WHERE token=$1', T4))[0].n, 1, 'cannot remove somebody else’s token');
    assert.strictEqual((await bola.req('DELETE', '/push-token', { token: T4 })).status, 200);
    assert.strictEqual((await pgQ('SELECT COUNT(*)::int n FROM push_tokens WHERE token=$1', T4))[0].n, 0);
  });
  await test('a token that moves to a different account follows the new owner only', async () => {
    const T5 = tok(); await ada.post('/push-token', { token: T5 }); await bola.post('/push-token', { token: T5 });
    const rows = await pgQ('SELECT u.email FROM push_tokens t JOIN users u ON u.id=t.user_id WHERE t.token=$1', T5); assert.deepStrictEqual(rows.map((r) => r.email), ['bola.push@example.com']);
  });

  srv.kill(); fake.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(DATA, { recursive: true, force: true });
  await pgAdmin(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\nServer log:\n' + log.slice(-1800)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
