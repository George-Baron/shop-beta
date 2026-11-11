'use strict';
// Step 7 check: the weak points found in the security test are closed.
// Run with: npm run test:security   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36);
const DBS = { main: 'sb_sec_' + tag, prod: 'sb_secp_' + tag, code: 'sb_secc_' + tag };
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const BASE = 5400 + Math.floor(Math.random() * 40) * 5;
const PORTS = { a: BASE, b: BASE + 1, prod: BASE + 2, code: BASE + 3 };
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql)).rows; } finally { await c.end(); } };
const procs = [];
const start = (port, db, extra = {}) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), BASE_URL: 'http://127.0.0.1:' + port, DATABASE_URL: urlOf(db), DATABASE_SSL: 'off', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sec-')), RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '', GEOAPIFY_API_KEY: '', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; }); procs.push(p); return p;
};
const up = async (port) => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); return; } catch { await sleep(100); } } throw new Error("app did not start on " + port + "\n" + procs.map((p) => p.log.slice(-600)).join("\n---\n")); };
// A visitor "behind Cloudflare": the last X-Forwarded-For hop is a Cloudflare address and CF-Connecting-IP is the real visitor.
const behindCf = (ip) => ({ 'X-Forwarded-For': `${ip}, 172.70.0.9`, 'CF-Connecting-IP': ip });
const call = async (port, method, url, body, { cookie, headers = {}, raw } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t, c: (sc[0] || '').split(';')[0], setCookie: sc[0] || '', h: r.headers };
};

(async () => {
  for (const d of Object.values(DBS)) await pg(`CREATE DATABASE ${d}`);
  const ENV = { ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!' };
  start(PORTS.a, DBS.main, ENV); start(PORTS.b, DBS.main, ENV);
  start(PORTS.prod, DBS.prod, { NODE_ENV: 'production', ALLOW_LOCAL_UPLOADS: '1' });
  start(PORTS.code, DBS.code, { NODE_ENV: 'production', ALLOW_LOCAL_UPLOADS: '1', SETUP_CODE: 'correct-horse-setup-code' });
  for (const p of Object.values(PORTS)) await up(p);
  const A = PORTS.a, B = PORTS.b;
  const admin = (await call(A, 'POST', '/api/auth/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' }, { headers: behindCf('10.200.0.1') }));
  const acookie = admin.c;
  const products = (await call(A, 'GET', '/api/products?instock=1')).j.products; const prod = products[0];
  const order = (email, phone, extra = {}) => ({ items: [{ productId: prod.id, qty: 1 }], contact: { name: 'Ada Obi', email, phone }, address: { state: 'Lagos', city: 'Yaba', address: '12 Secret Street' }, delivery: 'standard', payment: extra.payment || 'pod' });

  await test('production without a Paystack key: online payment is off and demo payments cannot be used', async () => {
    const cfg = (await call(PORTS.prod, 'GET', '/api/config')).j; assert.strictEqual(cfg.payments.paystack, false); assert.strictEqual(cfg.payments.demo, false);
    const r = await call(PORTS.prod, 'POST', '/api/checkout', order('a@example.com', '08011110001', { payment: 'paystack' })); assert.strictEqual(r.s, 400);
    assert.strictEqual((await call(PORTS.prod, 'POST', '/api/pay/demo/SB-ABC123', { outcome: 'ok' })).s, 404);
  });
  await test('production: the open first-run admin setup is closed unless a setup code is configured', async () => {
    const s = (await call(PORTS.prod, 'GET', '/api/admin/setup')).j; assert.strictEqual(s.needed, false);
    assert.strictEqual((await call(PORTS.prod, 'POST', '/api/admin/setup', { email: 'evil@example.com', password: 'Attacker-Passw0rd!' })).s, 403);
    assert.strictEqual(Number((await pg("SELECT COUNT(*) n FROM users WHERE role='admin'", DBS.prod))[0].n), 0);
  });
  await test('with a setup code: wrong code refused, weak password refused, right code and strong password creates the owner', async () => {
    const C = PORTS.code, st = (await call(C, 'GET', '/api/admin/setup')).j; assert.strictEqual(st.needed, true); assert.strictEqual(st.needsCode, true);
    assert.strictEqual((await call(C, 'POST', '/api/admin/setup', { email: 'me@example.com', name: 'Me', password: 'Another-Str0ng-One', setupCode: 'nope' })).s, 403);
    assert.strictEqual((await call(C, 'POST', '/api/admin/setup', { email: 'me@example.com', name: 'Me', password: 'password1234', setupCode: 'correct-horse-setup-code' })).s, 400);
    const ok = await call(C, 'POST', '/api/admin/setup', { email: 'me@example.com', name: 'Me', password: 'Another-Str0ng-One', setupCode: 'correct-horse-setup-code' }); assert.strictEqual(ok.s, 200);
    assert.ok(/Max-Age=259200/.test(ok.setCookie), 'admin sessions last 3 days, not 30');
    assert.strictEqual((await call(C, 'POST', '/api/admin/setup', { email: 'x@example.com', password: 'Yet-Another-Str0ng', setupCode: 'correct-horse-setup-code' })).s, 403, 'only once');
  });
  await test('passwords: common, short, name-in-password and repeated ones are refused; a sensible one is accepted', async () => {
    const reg = (pw, email = 'p' + Math.random().toString(36).slice(2, 7) + '@example.com', name = 'Ngozi Okafor') => call(A, 'POST', '/api/auth/register', { name, email, phone: '08011119999', password: pw }, { headers: behindCf('10.1.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250)) });
    for (const pw of ['password123', 'abc', '11111111', '12345678', 'qwertyuiop']) assert.strictEqual((await reg(pw)).s, 400, pw);
    assert.strictEqual((await reg('ngozi-is-great', 'ngozi@example.com')).s, 400);
    assert.strictEqual((await reg('mango-river-sky-92')).s, 200);
  });
  await test('registering with an email that already exists gives the same generic refusal and reveals nothing', async () => {
    const ip = behindCf('10.2.0.1'); const first = await call(A, 'POST', '/api/auth/register', { name: 'Dup', email: 'dup@example.com', phone: '08011118888', password: 'mango-river-sky-93' }, { headers: ip });
    const again = await call(A, 'POST', '/api/auth/register', { name: 'Dup', email: 'dup@example.com', phone: '08011118888', password: 'mango-river-sky-93' }, { headers: ip });
    assert.strictEqual(first.s, 200); assert.strictEqual(again.s, 400); assert.ok(!/already exists|taken|registered/i.test(again.j.error), again.j.error);
  });
  await test('rate limits are shared by all instances: six requests split across two servers use up one limit', async () => {
    const ip = behindCf('10.3.0.1');
    for (let i = 0; i < 6; i++) assert.strictEqual((await call(i % 2 ? A : B, 'POST', '/api/auth/forgot', { email: 'nobody@example.com' }, { headers: ip })).s, 200, 'request ' + i);
    assert.strictEqual((await call(A, 'POST', '/api/auth/forgot', { email: 'nobody@example.com' }, { headers: ip })).s, 429);
    assert.strictEqual((await call(B, 'POST', '/api/auth/forgot', { email: 'nobody@example.com' }, { headers: ip })).s, 429);
  });
  await test('limits are per visitor behind Cloudflare, not shared by everyone using the same Cloudflare address', async () => {
    assert.strictEqual((await call(A, 'POST', '/api/auth/forgot', { email: 'nobody@example.com' }, { headers: behindCf('10.3.0.2') })).s, 200); // a different visitor is not affected by 10.3.0.1 being blocked
  });
  await test('the visitor address header is ignored unless the request really came through Cloudflare', async () => {
    let last = 0; for (let i = 0; i < 8; i++) last = (await call(A, 'POST', '/api/auth/forgot', { email: 'nobody@example.com' }, { headers: { 'CF-Connecting-IP': '20.0.0.' + i } })).s;
    assert.strictEqual(last, 429, 'faking the header from outside must not give a fresh limit each time');
  });
  await test('a stranger cannot lock the real owner out of their account', async () => {
    await call(A, 'POST', '/api/auth/register', { name: 'Victim', email: 'victim@example.com', phone: '08011117777', password: 'mango-river-sky-94' }, { headers: behindCf('10.4.0.1') });
    let s = 0; for (let i = 0; i < 10; i++) s = (await call(A, 'POST', '/api/auth/login', { email: 'victim@example.com', password: 'wrong-guess-' + i }, { headers: behindCf('10.4.9.9') })).s;
    assert.strictEqual(s, 429, 'the attacker is blocked');
    const real = await call(B, 'POST', '/api/auth/login', { email: 'victim@example.com', password: 'mango-river-sky-94' }, { headers: behindCf('10.4.0.1') }); assert.strictEqual(real.s, 200, 'the real owner still signs in');
    assert.strictEqual((await call(B, 'POST', '/api/auth/login', { email: 'victim@example.com', password: 'mango-river-sky-94' }, { headers: behindCf('10.4.9.9') })).s, 429, 'the attacker stays blocked even with the right password');
  });
  await test('request bodies: big ones are refused, and the 4 MB upload body is not read before the admin check', async () => {
    const big = JSON.stringify({ items: [], note: 'x'.repeat(300000) });
    assert.strictEqual((await call(A, 'POST', '/api/checkout', undefined, { raw: big })).s, 413);
    const t0 = Date.now(); const up = await call(A, 'POST', '/api/admin/upload', undefined, { raw: JSON.stringify({ data: 'data:image/png;base64,' + 'A'.repeat(3000000) }) });
    assert.strictEqual(up.s, 401); assert.ok(Date.now() - t0 < 2000);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    assert.strictEqual((await call(A, 'POST', '/api/admin/upload', { data: png }, { cookie: acookie })).s, 200);
  });
  await test('reviews from people who have not received the product wait for approval; confirmed buyers are published at once', async () => {
    const g = await call(A, 'POST', `/api/products/${prod.id}/reviews`, { name: 'Anon', rating: 1, body: 'Spam review here' }, { headers: behindCf('10.5.0.1') });
    assert.strictEqual(g.s, 200); assert.strictEqual(g.j.pending, true);
    assert.strictEqual((await call(A, 'GET', '/api/products/' + prod.slug)).j.product.reviews.length, 0);
    const reg = await call(A, 'POST', '/api/auth/register', { name: 'Buyer One', email: 'buyer1@example.com', phone: '08011116666', password: 'mango-river-sky-95' }, { headers: behindCf('10.5.0.2') });
    const bc = reg.c; const o = await call(A, 'POST', '/api/checkout', order('buyer1@example.com', '08011116666'), { cookie: bc });
    const oid = Number((await pg(`SELECT id FROM orders WHERE ref='${o.j.ref}'`, DBS.main))[0].id);
    for (const st of ['confirmed', 'processing', 'shipped']) await call(A, 'PUT', '/api/admin/orders/' + oid, { status: st }, { cookie: acookie });
    assert.strictEqual((await call(A, 'POST', `/api/admin/orders/${oid}/handover`, { action: 'complete', reason: 'Delivered, customer confirmed by phone', cash: true }, { cookie: acookie })).s, 200);
    const r = await call(A, 'POST', `/api/products/${prod.id}/reviews`, { rating: 5, body: 'Arrived well, as described' }, { cookie: bc, headers: behindCf('10.5.0.2') });
    assert.strictEqual(r.s, 200); assert.strictEqual(r.j.pending, false);
    assert.strictEqual((await call(A, 'GET', '/api/products/' + prod.slug)).j.product.reviews.length, 1);
  });
  await test('looking up an order by number and email hides phone, address and delivery code; the private link or the owner sees everything', async () => {
    const o = await call(A, 'POST', '/api/checkout', order('lookup1@example.com', '08055554321'), { headers: behindCf('10.6.0.1') }); assert.strictEqual(o.s, 200); assert.ok(o.j.token && o.j.token.length >= 32);
    await call(A, 'PUT', '/api/admin/orders/' + (await pg(`SELECT id FROM orders WHERE ref='${o.j.ref}'`, DBS.main))[0].id, { status: 'confirmed' }, { cookie: acookie });
    const basic = (await call(A, 'POST', '/api/orders/lookup', { ref: o.j.ref, email: 'lookup1@example.com' })).j.order;
    assert.strictEqual(basic.masked, true); assert.ok(!JSON.stringify(basic).includes('08055554321') && !JSON.stringify(basic).includes('Secret Street')); assert.ok(!basic.handover_code); assert.strictEqual(basic.status, 'confirmed');
    const full = (await call(A, 'POST', '/api/orders/lookup', { ref: o.j.ref, email: 'lookup1@example.com', token: o.j.token })).j.order;
    assert.ok(!full.masked); assert.strictEqual(full.phone, '08055554321'); assert.match(full.handover_code, /^\d{6}$/);
    assert.strictEqual((await call(A, 'POST', '/api/orders/lookup', { ref: o.j.ref, email: 'wrong@example.com', token: 'f'.repeat(48) })).s, 404);
    assert.strictEqual((await call(A, 'POST', '/api/orders/lookup', { ref: o.j.ref, token: o.j.token })).s, 200, 'the private link alone works');
  });
  await test('one phone number or email cannot hold more than 2 pay-on-delivery orders waiting for confirmation', async () => {
    const h = behindCf('10.7.0.1'); const phone = '08077776666';
    assert.strictEqual((await call(A, 'POST', '/api/checkout', order('h1@example.com', phone), { headers: h })).s, 200);
    assert.strictEqual((await call(A, 'POST', '/api/checkout', order('h2@example.com', phone), { headers: h })).s, 200);
    assert.strictEqual((await call(A, 'POST', '/api/checkout', order('h3@example.com', phone), { headers: h })).s, 429);
    assert.strictEqual((await call(A, 'POST', '/api/checkout', order('h1@example.com', '08077776667'), { headers: h })).s, 200, 'second order on same email is still the second');
    assert.strictEqual((await call(A, 'POST', '/api/checkout', order('h1@example.com', '08077776668'), { headers: h })).s, 429, 'same email, new phone: also blocked');
  });
  await test('staff passwords need 12 characters', async () => {
    assert.strictEqual((await call(A, 'POST', '/api/admin/riders', { name: 'R', email: 'r9@example.com', phone: '08033334444', password: 'Short-Pass1' }, { cookie: acookie })).s, 400);
    assert.strictEqual((await call(A, 'POST', '/api/admin/riders', { name: 'R', email: 'r9@example.com', phone: '08033334444', password: 'Long-Enough-Pass-9' }, { cookie: acookie })).s, 200);
  });
  await test('every admin change is written to the activity log (without passwords), and only admins can read it', async () => {
    const log = (await call(A, 'GET', '/api/admin/audit', undefined, { cookie: acookie })).j.log;
    const rider = log.find((x) => x.method === 'POST' && x.path === '/api/admin/riders' && x.status === 200); assert.ok(rider); assert.ok(rider.user_name);
    assert.ok(!JSON.stringify(log).includes('Long-Enough-Pass-9'), 'passwords are never logged'); assert.ok(log.some((x) => /handover/.test(x.path)));
    assert.ok(!log.some((x) => x.method === 'GET'), 'reads are not logged');
    assert.strictEqual((await call(A, 'GET', '/api/admin/audit')).s, 401);
  });
  await test('security headers include cross-origin isolation, and customers keep 30-day sessions while staff get 3', async () => {
    const r = await call(A, 'GET', '/'); assert.strictEqual(r.h.get('cross-origin-opener-policy'), 'same-origin'); assert.match(r.h.get('permissions-policy'), /camera=\(\)/);
    const cust = await call(A, 'POST', '/api/auth/login', { email: 'victim@example.com', password: 'mango-river-sky-94' }, { headers: behindCf('10.4.0.1') }); assert.match(cust.setCookie, /Max-Age=2592000/);
  });

  for (const p of procs) p.kill();
  await sleep(400);
  for (const d of Object.values(DBS)) await pg(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(procs[0].log.slice(-1200));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
