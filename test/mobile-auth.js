'use strict';
// Mobile sign-in: tokens, rotation, reuse detection, revocation, customers-only, account deletion, and the website still working.
// Run with: npm run test:mobile-auth
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client: PgClient } = require('pg');

const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`, ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const TEST_DB = 'sb_test_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
const TEST_URL = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + TEST_DB + '$1');
async function pgAdmin(sql) { const c = new PgClient({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } }
async function pgQ(sql, ...p) { const c = new PgClient({ connectionString: TEST_URL }); await c.connect(); try { return (await c.query(sql, p)).rows; } finally { await c.end(); } }
let passed = 0; const failures = [];

class Web {   // a browser: cookies
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const r = await fetch(BASE + url, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) { const kv = c.split(';')[0]; this.cookie = /=$/.test(kv) ? '' : kv; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text };
  }
  get(u) { return this.req('GET', u); } post(u, b = {}) { return this.req('POST', u, b); }
}
class App {   // a phone: bearer tokens, no cookies, no Origin header
  constructor(deviceId = 'device-' + Math.random().toString(36).slice(2, 12)) { this.device = { id: deviceId, name: 'Test phone', platform: 'android', appVersion: '1.0.0' }; this.access = ''; this.refreshToken = ''; }
  async req(method, url, body, token = this.access) {
    const r = await fetch(BASE + '/api/mobile/v1' + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  }
  get(u, t) { return this.req('GET', u, undefined, t); } post(u, b = {}, t) { return this.req('POST', u, b, t); } put(u, b) { return this.req('PUT', u, b); } del(u) { return this.req('DELETE', u); }
  keep(r) { if (r.json && r.json.accessToken) { this.access = r.json.accessToken; this.refreshToken = r.json.refreshToken; } return r; }
  login(email, password) { return this.post('/auth/login', { email, password, device: this.device }).then((r) => this.keep(r)); }
  register(b) { return this.post('/auth/register', { ...b, device: this.device }).then((r) => this.keep(r)); }
  refresh(rt = this.refreshToken) { return this.post('/auth/refresh', { refreshToken: rt }).then((r) => this.keep(r)); }
}
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

(async () => {
  await pgAdmin(`CREATE DATABASE ${TEST_DB}`);
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DATABASE_URL: TEST_URL, DATABASE_SSL: 'off', BASE_URL: BASE, PAYSTACK_SECRET_KEY: '', RESEND_API_KEY: '', ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Owner-pass-2026-xyz' };
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 150; i++) { try { await fetch(BASE + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const PW = 'Ada-secret-2026!';
  const ada = new App();
  console.log('\nRegistration and sign-in');
  await test('register returns tokens and the profile; the profile works with the access token', async () => {
    const r = await ada.register({ name: 'Ada Obi', email: 'ada.mobile@example.com', phone: '08030000001', password: PW });
    assert.strictEqual(r.status, 200); assert.match(r.json.accessToken, /^at_/); assert.match(r.json.refreshToken, /^rt_/); assert.strictEqual(r.json.accessExpiresIn, 900); assert.strictEqual(r.json.user.role, 'customer');
    assert.ok(!('password' in r.json.user));
    assert.strictEqual((await ada.get('/me')).json.user.email, 'ada.mobile@example.com');
  });
  await test('only hashes are stored: the tokens are not in the database', async () => {
    const rows = await pgQ('SELECT access_hash, refresh_hash FROM mobile_sessions');
    assert.ok(rows.length >= 1); for (const r of rows) { assert.match(r.access_hash, /^[0-9a-f]{64}$/); assert.notStrictEqual(r.access_hash, ada.access); assert.notStrictEqual(r.refresh_hash, ada.refreshToken); }
  });
  await test('registration validates input and does not reveal whether an email is taken', async () => {
    const x = new App();
    assert.strictEqual((await x.register({ name: '', email: 'a@b.co', password: PW })).json.code, 'invalid_name');
    assert.strictEqual((await x.register({ name: 'X', email: 'nope', password: PW })).json.code, 'invalid_email');
    assert.strictEqual((await x.register({ name: 'X', email: 'x@example.com', password: 'password1' })).json.code, 'weak_password');
    const taken = await x.register({ name: 'Other', email: 'ada.mobile@example.com', password: PW });
    assert.strictEqual(taken.status, 400); assert.strictEqual(taken.json.code, 'cannot_register');
    assert.strictEqual((await x.post('/auth/register', { name: 'X', email: 'y@example.com', password: PW })).json.code, 'invalid_device');
  });
  await test('login: wrong password is refused, right password signs in, same message for unknown emails', async () => {
    const x = new App();
    const bad = await x.login('ada.mobile@example.com', 'wrong-password-1'), ghost = await x.login('ghost@example.com', 'wrong-password-1');
    assert.strictEqual(bad.status, 401); assert.strictEqual(bad.json.error, ghost.json.error);
    assert.strictEqual((await x.login('ADA.mobile@example.com', PW)).status, 200);
  });
  await test('repeated wrong passwords are rate limited', async () => {
    const x = new App(); let last;   // an address nobody uses: the lock-out counters are per email, per device and per address, and all tests share one address
    for (let i = 0; i < 12; i++) last = await x.login('lockout.test@example.com', 'definitely-wrong-' + i);
    assert.strictEqual(last.status, 429); assert.strictEqual(last.json.code, 'rate_limited');
  });

  console.log('\nCustomers only, and the website is separate');
  await test('the owner (admin) cannot sign in to the app, even with the right password', async () => {
    const r = await new App().login('owner@example.com', 'Owner-pass-2026-xyz');
    assert.strictEqual(r.status, 403); assert.strictEqual(r.json.code, 'use_website'); assert.ok(!r.json.accessToken);
  });
  await test('a mobile access token opens nothing on the website or the back office', async () => {
    const H = { Authorization: 'Bearer ' + ada.access };
    for (const p of ['/api/me', '/api/orders', '/api/admin/orders', '/api/admin/staff', '/api/rider/orders', '/api/partner/me', '/api/supplier/me', '/api/wholesale/me', '/api/notifications']) {
      const r = await fetch(BASE + p, { headers: H }); const j = await r.json().catch(() => ({}));
      assert.ok(r.status === 401 || (p === '/api/me' && j.user === null), `${p} answered ${r.status}`);
    }
  });
  await test('a website cookie does not sign anyone in to the mobile API', async () => {
    const web = new Web(); await web.post('/api/auth/register', { name: 'Web Bola', email: 'bola.web@example.com', password: PW });
    assert.ok((await web.get('/api/me')).json.user);
    const r = await fetch(BASE + '/api/mobile/v1/me', { headers: { Cookie: web.cookie } });
    assert.strictEqual(r.status, 401);
  });
  await test('garbage and missing tokens get a clear code', async () => {
    assert.strictEqual((await ada.get('/me', 'at_' + 'A'.repeat(43))).json.code, 'invalid_token');
    assert.strictEqual((await ada.get('/me', '')).json.code, 'missing_token');
    assert.strictEqual((await ada.get('/me', 'not-a-token')).json.code, 'missing_token');
  });
  await test('the website login and registration still work exactly as before', async () => {
    const web = new Web(); const r = await web.post('/api/auth/login', { email: 'bola.web@example.com', password: PW });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.user.role, 'customer'); assert.ok(web.cookie.startsWith('sb_sid='));
    assert.strictEqual((await web.get('/api/me')).json.user.email, 'bola.web@example.com');
  });

  console.log('\nRefresh tokens');
  await test('refresh gives a new pair; the old access token and old refresh token stop being the current ones', async () => {
    const x = new App(); await x.login('ada.mobile@example.com', PW);
    const oldAccess = x.access, oldRefresh = x.refreshToken;
    const r = await x.refresh(); assert.strictEqual(r.status, 200); assert.notStrictEqual(r.json.refreshToken, oldRefresh);
    assert.strictEqual((await x.get('/me', oldAccess)).status, 401);
    assert.strictEqual((await x.get('/me')).status, 200);
  });
  await test('a reply that never arrived: the old refresh token works once more within 60 seconds, and the lost one is dead', async () => {
    const x = new App(); await x.login('ada.mobile@example.com', PW);
    const t1 = x.refreshToken; const second = await x.refresh(t1); const lost = second.json.refreshToken;   // the app never received "second"
    const again = await x.refresh(t1); assert.strictEqual(again.status, 200);                              // grace: retry with the token it still holds
    assert.strictEqual((await x.refresh(lost)).status, 401);                                               // the lost one no longer works
  });
  await test('replaying an old refresh token after the grace window revokes the whole device session', async () => {
    const x = new App(); await x.login('ada.mobile@example.com', PW);
    const stolen = x.refreshToken; await x.refresh(); const current = x.refreshToken, access = x.access;
    await pgQ('UPDATE mobile_sessions SET rotated_at = rotated_at - 600 WHERE device_id=$1 AND revoked_at IS NULL', x.device.id);
    const r = await x.refresh(stolen); assert.strictEqual(r.status, 401); assert.strictEqual(r.json.code, 'session_revoked');
    assert.strictEqual((await x.get('/me', access)).status, 401);                                          // the honest phone is signed out too
    assert.strictEqual((await x.refresh(current)).status, 401);
    assert.strictEqual((await pgQ("SELECT revoke_reason FROM mobile_sessions WHERE device_id=$1 ORDER BY id DESC LIMIT 1", x.device.id))[0].revoke_reason, 'refresh_reuse');
  });
  await test('an expired access token says so (so the app refreshes), and an expired refresh token needs a new sign-in', async () => {
    const x = new App(); await x.login('ada.mobile@example.com', PW);
    await pgQ('UPDATE mobile_sessions SET access_expires = access_expires - 3600 WHERE device_id=$1 AND revoked_at IS NULL', x.device.id);
    assert.strictEqual((await x.get('/me')).json.code, 'token_expired');
    assert.strictEqual((await x.refresh()).status, 200); assert.strictEqual((await x.get('/me')).status, 200);
    await pgQ('UPDATE mobile_sessions SET refresh_expires = 1 WHERE device_id=$1 AND revoked_at IS NULL', x.device.id);
    const r = await x.refresh(); assert.strictEqual(r.status, 401); assert.strictEqual(r.json.code, 'session_expired');
  });

  console.log('\nDevices and revocation');
  await test('logout revokes the session on the server', async () => {
    const x = new App(); await x.login('ada.mobile@example.com', PW); const a = x.access, rt = x.refreshToken;
    assert.strictEqual((await x.post('/auth/logout')).status, 200);
    assert.strictEqual((await x.get('/me', a)).status, 401); assert.strictEqual((await x.refresh(rt)).status, 401);
  });
  await test('signing in again on the same device replaces its old session; devices can be listed and removed', async () => {
    const phone = new App('phone-aaaaaaaa'), tablet = new App('tablet-bbbbbbb');
    await phone.login('ada.mobile@example.com', PW); const firstAccess = phone.access; await phone.login('ada.mobile@example.com', PW); await tablet.login('ada.mobile@example.com', PW);
    assert.strictEqual((await phone.get('/me', firstAccess)).status, 401);
    const list = (await phone.get('/me/devices')).json.devices; const mine = list.filter((d) => d.current);
    assert.strictEqual(mine.length, 1); assert.ok(list.length >= 2);
    const other = list.find((d) => !d.current && d.name === 'Test phone');
    assert.strictEqual((await phone.del('/me/devices/' + other.id)).status, 200);
    assert.strictEqual((await phone.del('/me/devices/999999')).status, 404);
  });
  await test('at most 10 devices stay signed in: the least recently used is signed out', async () => {
    const apps = []; for (let i = 0; i < 12; i++) { const a = new App('many-device-' + String(i).padStart(2, '0')); await a.login('ada.mobile@example.com', PW); apps.push(a); }
    const n = (await pgQ('SELECT COUNT(*)::int n FROM mobile_sessions WHERE user_id=(SELECT id FROM users WHERE email=$1) AND revoked_at IS NULL', 'ada.mobile@example.com'))[0].n;
    assert.ok(n <= 10, 'open sessions: ' + n); assert.strictEqual((await apps[11].get('/me')).status, 200);
  });
  await test('changing the password signs out every other phone and every browser, but not this phone', async () => {
    const a = new App(), b = new App(), web = new Web();
    await a.login('ada.mobile@example.com', PW); await b.login('ada.mobile@example.com', PW); await web.post('/api/auth/login', { email: 'ada.mobile@example.com', password: PW });
    assert.ok((await web.get('/api/me')).json.user);
    assert.strictEqual((await a.put('/me', { name: 'Ada Obi', phone: '08030000001', password: 'wrong-current', newPassword: 'Another-pass-2026!' })).json.code, 'wrong_password');
    assert.strictEqual((await a.put('/me', { name: 'Ada Obi', phone: '08030000001', password: PW, newPassword: 'Another-pass-2026!' })).status, 200);
    assert.strictEqual((await a.get('/me')).status, 200); assert.strictEqual((await b.get('/me')).status, 401); assert.strictEqual((await web.get('/api/me')).json.user, null);
    assert.strictEqual((await new App().login('ada.mobile@example.com', PW)).status, 401);
    assert.strictEqual((await a.put('/me', { name: 'Ada Obi', phone: '08030000001', password: 'Another-pass-2026!', newPassword: PW })).status, 200);   // back for the next tests
  });
  await test('a switched-off account is signed out at once', async () => {
    const x = new App(); await x.login('ada.mobile@example.com', PW);
    await pgQ("UPDATE users SET active=0 WHERE email='ada.mobile@example.com'");
    assert.strictEqual((await x.get('/me')).json.code, 'session_revoked'); assert.strictEqual((await new App().login('ada.mobile@example.com', PW)).json.code, 'account_off');
    await pgQ("UPDATE users SET active=1 WHERE email='ada.mobile@example.com'");
  });

  console.log('\nPassword reset');
  await test('forgot gives the same answer for known and unknown emails; reset needs a real link', async () => {
    const x = new App(); const a = await x.post('/auth/forgot', { email: 'ada.mobile@example.com' }), b = await x.post('/auth/forgot', { email: 'nobody@example.com' });
    assert.deepStrictEqual(a.json, b.json); assert.strictEqual((await x.post('/auth/reset', { token: 'x'.repeat(64), password: PW })).json.code, 'reset_expired');
    const mail = await pgQ("SELECT body FROM outbox WHERE to_email='ada.mobile@example.com' ORDER BY id DESC LIMIT 1"); const token = /forgot\?token=([0-9a-f]{64})/.exec(mail[0].body)[1];
    const sess = new App(); await sess.login('ada.mobile@example.com', PW);
    assert.strictEqual((await x.post('/auth/reset', { token, password: 'weak' })).json.code, 'weak_password');
    assert.strictEqual((await x.post('/auth/reset', { token, password: 'Reset-pass-2026!' })).status, 200);
    assert.strictEqual((await sess.get('/me')).status, 401);                                                // every device signed out
    assert.strictEqual((await new App().login('ada.mobile@example.com', 'Reset-pass-2026!')).status, 200);
    assert.strictEqual((await x.post('/auth/reset', { token, password: PW })).status, 400);                // the link works once
    const back = new App(); await back.login('ada.mobile@example.com', 'Reset-pass-2026!'); await back.put('/me', { name: 'Ada Obi', phone: '08030000001', password: 'Reset-pass-2026!', newPassword: PW });
  });

  console.log('\nAccount deletion');
  await test('deletion needs the password and is blocked while an order is in progress', async () => {
    const dele = new App(); await dele.register({ name: 'Dele Okon', email: 'dele@example.com', phone: '08030000002', password: PW });
    assert.strictEqual((await dele.post('/me/delete-account', { password: 'wrong' })).json.code, 'wrong_password');
    const web = new Web(); await web.post('/api/auth/login', { email: 'dele@example.com', password: PW });
    const prod = (await web.get('/api/products?instock=1')).json.products.find((p) => !p.vendor);
    const detail = (await web.get('/api/products/' + prod.slug)).json.product;
    const o = await web.post('/api/checkout', { items: [{ productId: detail.id, variantId: detail.variants[0] ? detail.variants[0].id : undefined, qty: 1 }], contact: { name: 'Dele Okon', email: 'dele@example.com', phone: '08030000002' }, address: { state: 'Lagos', city: 'Yaba', address: '5 Herbert Macaulay Way' }, delivery: 'standard', payment: 'pod' });
    assert.strictEqual(o.status, 200, o.text);
    const r = await dele.post('/me/delete-account', { password: PW }); assert.strictEqual(r.status, 409); assert.strictEqual(r.json.code, 'orders_in_progress');
    await pgQ("UPDATE orders SET status='cancelled' WHERE email='dele@example.com'");
  });
  await test('deletion switches the account off at once and the worker removes personal details later, keeping the order record', async () => {
    const x = new App(); await x.login('dele@example.com', PW);
    const web = new Web(); await web.post('/api/auth/login', { email: 'dele@example.com', password: PW });
    await web.post('/api/addresses', { state: 'Lagos', city: 'Yaba', address: '5 Herbert Macaulay Way' });
    const r = await x.post('/me/delete-account', { password: PW }); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.wait_days, 14);
    assert.strictEqual((await x.get('/me')).status, 401); assert.strictEqual((await web.get('/api/me')).json.user, null);
    assert.strictEqual((await new App().login('dele@example.com', PW)).json.code, 'account_off');
    assert.strictEqual((await pgQ("SELECT status FROM account_deletions")).length, 1);
    const run = () => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', "require('./lib/mobile-auth').processDeletions().then((n)=>{console.log('processed',n);process.exit(0)})"], { cwd: ROOT, env: { ...env, WORKER_ENABLED: '0' } }).toString();
    assert.match(run(), /processed 0/);                                                                    // not due yet
    await pgQ("UPDATE account_deletions SET scheduled_for = 1");
    assert.match(run(), /processed 1/); assert.match(run(), /processed 0/);                                // once only
    const u = (await pgQ("SELECT name, email, phone, password, active FROM users WHERE email LIKE 'deleted-%'"))[0];
    assert.strictEqual(u.name, 'Deleted customer'); assert.strictEqual(u.phone, ''); assert.strictEqual(u.password, '!'); assert.strictEqual(u.active, 0);
    assert.strictEqual((await pgQ("SELECT COUNT(*)::int n FROM addresses a JOIN users u ON u.id=a.user_id WHERE u.email LIKE 'deleted-%'"))[0].n, 0);
    assert.strictEqual((await pgQ("SELECT COUNT(*)::int n FROM orders o JOIN users u ON u.id=o.user_id WHERE u.email LIKE 'deleted-%'"))[0].n, 1);   // accounting record kept
    assert.strictEqual((await new Web().post('/api/auth/login', { email: u.email, password: '!' })).status, 401);
  });

  console.log('\nErrors');
  await test('every error has { error, code, requestId }; unknown mobile paths are JSON 404s', async () => {
    const r = await ada.get('/no-such-thing'); assert.strictEqual(r.status, 404); assert.strictEqual(r.json.code, 'not_found'); assert.ok(r.json.requestId);
    const bad = await fetch(BASE + '/api/mobile/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.strictEqual(bad.status, 400); assert.strictEqual((await bad.json()).code, 'bad_request');
  });

  srv.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(DATA, { recursive: true, force: true });
  await pgAdmin(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\nServer log:\n' + log.slice(-1500)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
