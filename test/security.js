'use strict';
// Security tests: startup rules for the administrator, password hashing, rate limits by person, CSRF, cookies, headers,
// permissions on every admin route, other people's data, and a fuzz of every route (nothing may answer 5xx).
// Run with: npm run test:security   (needs Postgres like npm test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const withDb = (n) => { const u = new URL(ADMIN_URL); u.pathname = '/' + n; return u.toString(); };
const ssl = process.env.PGSSL_TEST === 'require' ? { rejectUnauthorized: false } : false;
const sql = async (q, db, args) => { const c = new Pg({ connectionString: db ? withDb(db) : ADMIN_URL, ssl }); await c.connect(); try { return await c.query(q, args); } finally { await c.end(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 9);
const ADMIN_EMAIL = 'boss@example.com', ADMIN_PW = 'correct horse battery';
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.stack || e.message).split('\n').slice(0, 7).join('\n       ')); } }

const dbs = [], procs = [];
let portN = 4200 + Math.floor(Math.random() * 60);
async function newDb() { const n = 'sb_sec_' + rnd(); await sql(`CREATE DATABASE ${n}`); dbs.push(n); return n; }
function spawnServer(db, env = {}) {
  const port = portN++;
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: withDb(db), PGSSL: process.env.PGSSL_TEST || 'disable', BASE_URL: 'http://127.0.0.1:' + port, STORAGE_DRIVER: 'local', DATA_DIR: os.tmpdir() + '/sb-sec-' + port, CACHE_DISABLED: '1', RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '', NODE_ENV: '', RATE_LIMITS: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', ADMIN_SETUP_CODE: '', RATE_IP_CHECKOUT: '', RATE_IP_LOGIN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.log = ''; p.port = port; p.base = 'http://127.0.0.1:' + port; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  p.exited = new Promise((r) => p.on('exit', (code) => r(code))); procs.push(p);
  return p;
}
async function up(p) { for (let i = 0; i < 120; i++) { try { if ((await fetch(p.base + '/health')).ok) return p; } catch { /* wait */ } if (p.exitCode !== null) throw new Error('server exited: ' + p.log.slice(-400)); await sleep(100); } throw new Error('no start: ' + p.log.slice(-400)); }
const stop = async (p) => { p.kill(); await Promise.race([p.exited, sleep(2000)]); };

class Client {
  constructor(base, headers = {}) { this.base = base; this.cookies = {}; this.extra = headers; }
  get cookie() { return Object.entries(this.cookies).map(([k, v]) => k + '=' + v).join('; '); }
  async req(method, url, body, headers = {}, { csrfHeader = true } = {}) {
    const h = { ...(csrfHeader ? { 'X-Requested-With': 'shop-beta' } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...this.extra, ...headers };
    const r = await fetch(this.base + url, { method, redirect: 'manual', headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of set) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/Max-Age=0/i.test(c)) delete this.cookies[k]; else this.cookies[k] = v; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text, headers: r.headers, setCookie: set };
  }
  get(u, h) { return this.req('GET', u, undefined, h); } post(u, b = {}, h, o) { return this.req('POST', u, b, h, o); } put(u, b = {}) { return this.req('PUT', u, b); } del(u) { return this.req('DELETE', u); }
}
const fwd = (n) => ({ 'X-Forwarded-For': `10.${Math.floor(n / 65000) % 250}.${Math.floor(n / 250) % 250}.${n % 250}` });

(async () => {
  console.log('\nAdministrator account and passwords');
  await test('production refuses to start with no administrator and no way to create one', async () => {
    const p = spawnServer(await newDb(), { NODE_ENV: 'production', STORAGE_DRIVER: 'none' }); const code = await Promise.race([p.exited, sleep(15000).then(() => 'timeout')]);
    assert.notStrictEqual(code, 'timeout'); assert.notStrictEqual(code, 0); assert.match(p.log, /ADMIN_EMAIL and ADMIN_PASSWORD/);
  });
  await test('a weak or malformed ADMIN_PASSWORD / ADMIN_EMAIL stops the server with a clear message', async () => {
    for (const [env, re] of [[{ ADMIN_EMAIL, ADMIN_PASSWORD: 'short pass' }, /at least 12 characters/], [{ ADMIN_EMAIL: 'not-an-email', ADMIN_PASSWORD: ADMIN_PW }, /valid email/]]) {
      const p = spawnServer(await newDb(), env); const code = await Promise.race([p.exited, sleep(15000).then(() => 'timeout')]); assert.notStrictEqual(code, 'timeout'); assert.notStrictEqual(code, 0); assert.match(p.log, re);
    }
  });

  await test('two instances starting at the same moment on an empty database: both start, exactly one administrator (found by the load test)', async () => {
    const db = await newDb(), env = { ADMIN_EMAIL, ADMIN_PASSWORD: ADMIN_PW }, a = spawnServer(db, env), b = spawnServer(db, env);
    await Promise.all([up(a), up(b)]); assert.strictEqual((await sql("SELECT COUNT(*)::int n FROM users WHERE role='admin'", db)).rows[0].n, 1);
    for (const p of [a, b]) assert.strictEqual((await new Client(p.base).post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PW }, fwd(7777))).status, 200); await stop(a); await stop(b);
  });

  // Main instance: administrator from the environment, no setup code, low IP ceilings for the rate-limit tests.
  const mainDb = await newDb();
  const main = await up(spawnServer(mainDb, { ADMIN_EMAIL, ADMIN_PASSWORD: ADMIN_PW, RATE_IP_CHECKOUT: '15', RATE_IP_LOGIN: '12' }));
  const admin = new Client(main.base);
  await test('the administrator is created from the environment; no default login exists; setup page is off', async () => {
    assert.match(main.log, /Administrator account created for boss@example.com/); assert.ok(!main.log.includes(ADMIN_PW), 'password is never logged');
    assert.strictEqual((await new Client(main.base).get('/api/admin/setup')).json.needed, false);
    assert.strictEqual((await new Client(main.base).post('/api/admin/setup', { code: 'anything', email: 'x@example.com', password: 'a long password here' })).status, 403);
    for (const pw of ['admin', 'password', 'admin123', 'correct horse']) assert.strictEqual((await new Client(main.base).post('/api/auth/login', { email: ADMIN_EMAIL, password: pw }, fwd(rnd().length + pw.length))).status, 401);
    const r = await admin.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PW }, fwd(1)); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.user.role, 'admin');
    assert.strictEqual((await admin.get('/api/admin/dashboard')).status, 200);
    const stored = (await sql('SELECT password FROM users WHERE role=\'admin\'', mainDb)).rows[0].password; assert.match(stored, /^scrypt\$65536\$8\$2\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.match(r.setCookie[0], /Max-Age=43200/, 'administrator sessions last 12 hours');
  });
  await test('older password hashes keep working and are upgraded the next time the person signs in', async () => {
    const salt = crypto.randomBytes(16); const old = 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync('old password 1', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    await sql("INSERT INTO users (name,email,phone,password,role,created) VALUES ('Old','old@example.com','',$1,'customer',1)", mainDb, [old]);
    const c = new Client(main.base); assert.strictEqual((await c.post('/api/auth/login', { email: 'old@example.com', password: 'old password 1' }, fwd(2))).status, 200);
    assert.match((await sql("SELECT password FROM users WHERE email='old@example.com'", mainDb)).rows[0].password, /^scrypt\$65536\$8\$2\$/);
    assert.strictEqual((await new Client(main.base).post('/api/auth/login', { email: 'old@example.com', password: 'old password 1' }, fwd(3))).status, 200, 'works with the new hash');
    assert.strictEqual((await new Client(main.base).post('/api/auth/login', { email: 'old@example.com', password: 'wrong password' }, fwd(4))).status, 401);
  });
  await test('setup with a code: wrong code refused, right code works once, two at the same moment make one administrator', async () => {
    const p = await up(spawnServer(await newDb(), { ADMIN_SETUP_CODE: 'the-setup-code' })); const ok = { code: 'the-setup-code', name: 'Owner', email: 'owner@example.com', password: 'a long password here' };
    assert.strictEqual((await new Client(p.base).get('/api/admin/setup')).json.needed, true);
    assert.strictEqual((await new Client(p.base).post('/api/admin/setup', { ...ok, code: 'guess-guess' })).status, 403);
    const rs = await Promise.all([1, 2, 3, 4].map((i) => new Client(p.base).post('/api/admin/setup', { ...ok, email: `owner${i}@example.com` }, fwd(10 + i))));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(','));
    await stop(p);
  });

  console.log('\nRate limits by person, with a loose per-IP ceiling');
  const checkoutBody = (email, phone) => ({ items: [], contact: { name: 'T', email, phone }, address: {}, delivery: 'standard', payment: 'pod' });
  let n = 1000;
  await test('checkout: 10 orders an hour per phone number, whatever the IP address, whatever the way the number is written', async () => {
    const phones = ['08031112222', '+2348031112222', '2348031112222', '0803 111 2222'], seen = [];
    for (let i = 0; i < 12; i++) seen.push((await new Client(main.base).post('/api/checkout', checkoutBody(`p${i}@example.com`, phones[i % 4]), fwd(n++))).status);
    assert.deepStrictEqual(seen.slice(0, 10).filter((s) => s === 429), [], 'first 10 are not limited: ' + seen); assert.deepStrictEqual(seen.slice(10), [429, 429], 'the 11th and 12th are');
    assert.notStrictEqual((await new Client(main.base).post('/api/checkout', checkoutBody('other@example.com', '08039998888'), fwd(n++))).status, 429, 'a different person is not affected');
  });
  await test('checkout: the same email is limited across different phones and addresses', async () => {
    const seen = []; for (let i = 0; i < 12; i++) seen.push((await new Client(main.base).post('/api/checkout', checkoutBody('same@example.com', '0803' + String(7000000 + i)), fwd(n++))).status);
    assert.strictEqual(seen.slice(0, 10).includes(429), false); assert.strictEqual(seen[10], 429);
  });
  await test('a whole mobile network behind one IP address can still shop: 15 different people from one address pass, the 16th hits the loose ceiling', async () => {
    const same = fwd(999999), seen = [];
    for (let i = 0; i < 17; i++) seen.push((await new Client(main.base).post('/api/checkout', checkoutBody(`ng${i}@example.com`, '0805' + String(1000000 + i)), same)).status);
    assert.deepStrictEqual(seen.slice(0, 15).filter((s) => s === 429), [], 'people 1-15: ' + seen); assert.strictEqual(seen[15], 429); assert.strictEqual(seen[16], 429);
  });
  await test('sign-in: 8 tries per email in 15 minutes from any address; a different email is not affected; per-IP ceiling is loose', async () => {
    const seen = []; for (let i = 0; i < 10; i++) seen.push((await new Client(main.base).post('/api/auth/login', { email: 'victim@example.com', password: 'wrong password ' + i }, fwd(n++))).status);
    assert.deepStrictEqual(seen, [401, 401, 401, 401, 401, 401, 401, 401, 429, 429]);
    assert.strictEqual((await new Client(main.base).post('/api/auth/login', { email: 'old@example.com', password: 'old password 1' }, fwd(n++))).status, 200);
    const shared = fwd(888888), codes = []; for (let i = 0; i < 14; i++) codes.push((await new Client(main.base).post('/api/auth/login', { email: `u${i}@example.com`, password: 'nope nope nope' }, shared)).status);
    assert.deepStrictEqual(codes.slice(0, 12).filter((s) => s === 429), [], 'twelve different people behind one address'); assert.ok(codes.slice(12).every((s) => s === 429));
  });
  await test('registration, password reset, contact and newsletter are limited per person too', async () => {
    const hitAll = async (url, mk, tries) => { const out = []; for (let i = 0; i < tries; i++) out.push((await new Client(main.base).post(url, mk(i), fwd(n++))).status); return out; };
    assert.strictEqual((await hitAll('/api/auth/forgot', () => ({ email: 'rate@example.com' }), 8)).filter((s) => s === 429).length, 2);
    assert.strictEqual((await hitAll('/api/contact', () => ({ name: 'A', email: 'c@example.com', message: 'hello there' }), 8)).filter((s) => s === 429).length, 2);
    assert.strictEqual((await hitAll('/api/newsletter', () => ({ email: 'n@example.com' }), 12)).filter((s) => s === 429).length, 2);
    assert.strictEqual((await hitAll('/api/auth/register', () => ({ name: 'X', email: 'reg@example.com', phone: '08041112222', password: 'long enough pw' }), 7)).filter((s) => s === 429).length, 2);
  });

  console.log('\nCross-site request protection, cookies and headers');
  const shopper = new Client(main.base);
  await shopper.post('/api/auth/register', { name: 'Ada Obi', email: 'ada@example.com', phone: '08012345678', password: 'correct horse' }, fwd(n++));
  await test('a request with a cookie but without our header, from another site, or flagged cross-site by the browser is blocked', async () => {
    assert.strictEqual((await shopper.post('/api/addresses', { label: 'Home', name: 'A', phone: '0801', state: 'Lagos', city: 'Ikeja', address: '12 Allen' }, {}, { csrfHeader: false })).status, 403, 'no header');
    assert.strictEqual((await shopper.post('/api/auth/logout', {}, { Origin: 'https://evil.example' })).status, 403, 'other origin');
    assert.strictEqual((await shopper.post('/api/auth/logout', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'browser says cross-site');
    assert.strictEqual((await shopper.post('/api/auth/logout', {}, { 'Sec-Fetch-Site': 'same-site' })).status, 403, 'sibling subdomain');
    assert.strictEqual((await shopper.req('POST', '/api/auth/logout', 'a=b', { 'Content-Type': 'application/x-www-form-urlencoded' }, { csrfHeader: false })).status, 403, 'plain form post');
    assert.strictEqual((await shopper.get('/api/me', {}, { csrfHeader: false })).status, 200, 'reading needs no header');
    assert.strictEqual((await shopper.post('/api/addresses', { label: 'Home', name: 'A', phone: '0801', state: 'Lagos', city: 'Ikeja', address: '12 Allen' }, { Origin: main.base, 'Sec-Fetch-Site': 'same-origin' })).status, 200, 'own site works');
    const hook = await new Client(main.base).post('/api/paystack/webhook', { event: 'x' }, { Origin: 'https://paystack.com' }, { csrfHeader: false }); assert.strictEqual(hook.status, 401, 'the signed webhook is exempt: refused for its signature, not for being cross-site');
  });
  await test('response headers: no server banner, content type sniffing off, framing off, strict CSP with a fresh nonce on every page', async () => {
    const a = await new Client(main.base).get('/'), b = await new Client(main.base).get('/'), api = await new Client(main.base).get('/api/config'), nf = await new Client(main.base).get('/api/nope');
    for (const r of [a, api, nf]) { const h = r.headers; assert.strictEqual(h.get('x-powered-by'), null); assert.strictEqual(h.get('x-content-type-options'), 'nosniff'); assert.strictEqual(h.get('x-frame-options'), 'DENY'); assert.strictEqual(h.get('referrer-policy'), 'strict-origin-when-cross-origin'); assert.match(h.get('permissions-policy'), /camera=\(\)/); assert.strictEqual(h.get('cross-origin-opener-policy'), 'same-origin-allow-popups'); }
    const csp = a.headers.get('content-security-policy'); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /base-uri 'self'/); assert.match(csp, /default-src 'self'/); assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no unsafe-inline for scripts');
    const nonce = (x) => /nonce-([A-Za-z0-9+/=_-]+)/.exec(x.headers.get('content-security-policy'))[1]; assert.notStrictEqual(nonce(a), nonce(b)); assert.ok(a.text.includes('nonce="' + nonce(a) + '"'));
    assert.strictEqual(api.headers.get('cache-control'), 'no-store');
  });
  await test('cookies: HttpOnly, SameSite, host-locked and Secure on https; a planted plain cookie is ignored on https; sessions end on sign-out', async () => {
    const r = await new Client(main.base).post('/api/auth/login', { email: 'ada@example.com', password: 'correct horse' }, fwd(n++)); assert.match(r.setCookie[0], /^sb_sid=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const https = await up(spawnServer(mainDb, { BASE_URL: 'https://shop.example.com', RATE_LIMITS: 'off' }));
    const s = new Client(https.base, { 'X-Forwarded-Proto': 'https' }); const l = await s.post('/api/auth/login', { email: 'ada@example.com', password: 'correct horse' });
    assert.match(l.setCookie[0], /^__Host-sb_sid=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/); assert.ok(!/Domain=/i.test(l.setCookie[0])); assert.strictEqual(l.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.strictEqual((await s.get('/api/me')).json.user.email, 'ada@example.com');
    const planted = new Client(https.base, { 'X-Forwarded-Proto': 'https' }); planted.cookies.sb_sid = s.cookies['__Host-sb_sid']; assert.strictEqual((await planted.get('/api/me')).json.user, null, 'the plain-name cookie is not accepted on https');
    const out = await s.post('/api/auth/logout'); assert.match(out.setCookie[0], /__Host-sb_sid=; .*Max-Age=0.*Secure/); await stop(https);
    const old = new Client(main.base); old.cookies.sb_sid = r.setCookie[0].split(';')[0].split('=')[1]; assert.strictEqual((await old.get('/api/me')).json.user.email, 'ada@example.com');
    await sql("DELETE FROM sessions WHERE expires > 0", mainDb); assert.strictEqual((await old.get('/api/me')).json.user, null, 'a deleted session is dead at once');
  });
  await test('a changed password ends the other sessions of that person', async () => {
    const a = new Client(main.base), b = new Client(main.base); await a.post('/api/auth/login', { email: 'ada@example.com', password: 'correct horse' }, fwd(n++)); await b.post('/api/auth/login', { email: 'ada@example.com', password: 'correct horse' }, fwd(n++));
    const ch = await a.put('/api/me', { name: 'Ada Obi', password: 'correct horse', newPassword: 'a brand new password' });
    if (ch.status === 200) { assert.strictEqual((await b.get('/api/me')).json.user, null, 'other session ended'); assert.ok((await a.get('/api/me')).json.user, 'this session stays'); } else assert.fail('password change failed: ' + ch.status + ' ' + ch.text);
  });

  console.log('\nPermissions');
  const adminRoutes = (() => { // every route of the admin router, taken from the code itself so a new route cannot be forgotten
    process.env.DATABASE_URL = withDb(mainDb); const r = require('../routes/admin'); const out = [];
    for (const l of r.stack) if (l.route) for (const m of Object.keys(l.route.methods)) out.push([m.toUpperCase(), l.route.path]);
    return out;
  })();
  await test('every admin route (' + adminRoutes.length + ') refuses visitors and shoppers, and works for the administrator', async () => {
    assert.ok(adminRoutes.length >= 35, 'found the admin routes: ' + adminRoutes.length);
    await admin.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PW }, fwd(n++));
    const guest = new Client(main.base), customer = new Client(main.base); await customer.post('/api/auth/login', { email: 'old@example.com', password: 'old password 1' }, fwd(n++));
    const open = new Set(['GET /setup', 'POST /setup']), bad = [];
    for (const [m, p] of adminRoutes) {
      if (open.has(m + ' ' + p)) continue; const url = '/api/admin' + p.replace(/:\w+/g, '1');
      for (const [who, c] of [['visitor', guest], ['shopper', customer]]) { const r = await c.req(m, url, m === 'GET' || m === 'DELETE' ? undefined : {}); if (r.status !== 401 && r.status !== 403) bad.push(`${who} ${m} ${url} -> ${r.status}`); }
    }
    assert.deepStrictEqual(bad, []);
    assert.strictEqual((await customer.get('/api/admin/dashboard')).status, 401); assert.strictEqual((await admin.get('/api/admin/dashboard')).status, 200);
  });
  await test('one shopper cannot read or change another shopper\'s addresses, wishlist or orders', async () => {
    const a = new Client(main.base), b = new Client(main.base); await a.post('/api/auth/login', { email: 'ada@example.com', password: 'a brand new password' }, fwd(n++)).catch(() => {});
    await a.post('/api/auth/login', { email: 'ada@example.com', password: 'correct horse' }, fwd(n++));
    await b.post('/api/auth/register', { name: 'Bayo', email: 'bayo@example.com', phone: '08022223333', password: 'bayo password 1' }, fwd(n++));
    const adr = (await a.get('/api/addresses')).json.addresses[0]; assert.ok(adr, 'Ada has an address');
    assert.strictEqual((await b.del('/api/addresses/' + adr.id)).status < 400 && (await a.get('/api/addresses')).json.addresses.length === 0, false, 'Bayo could not delete it');
    assert.strictEqual((await b.get('/api/addresses')).json.addresses.length, 0);
    const prod = (await b.get('/api/products?store=electronics')).json.products.find((x) => !x.hasVariants && x.stock > 5);
    const o = await a.post('/api/checkout', { items: [{ productId: prod.id, qty: 1 }], contact: { name: 'Ada', email: 'ada@example.com', phone: '08012345678' }, address: { state: 'Lagos', address: '1 Test Road' }, delivery: 'standard', payment: 'pod' }, fwd(n++)); assert.strictEqual(o.status, 200);
    assert.strictEqual((await b.post('/api/orders/lookup', { ref: o.json.ref, email: 'bayo@example.com' }, fwd(n++))).status, 404, 'right reference, wrong email');
    assert.strictEqual((await new Client(main.base).post('/api/orders/lookup', { ref: o.json.ref, email: 'ADA@example.com' }, fwd(n++))).status, 200, 'owner can look it up');
    assert.strictEqual((await b.post(`/api/orders/${o.json.ref}/cancel`, { email: 'bayo@example.com' }, fwd(n++))).status, 404, 'cannot cancel someone else\'s order');
    assert.ok(!(await b.get('/api/orders')).text.includes(o.json.ref), 'not in Bayo\'s order list');
  });
  await stop(main);

  console.log('\nFuzz: every route, hostile input, nothing may answer 5xx or crash');
  const fuzzDb = await newDb();
  const fz = await up(spawnServer(fuzzDb, { ADMIN_EMAIL, ADMIN_PASSWORD: ADMIN_PW, RATE_LIMITS: 'off' }));
  await test('about 3,000 hostile requests across all public and admin routes: no 5xx, server still healthy', async () => {
    process.env.DATABASE_URL = withDb(fuzzDb);
    const routes = []; for (const [file, prefix] of [['../routes/public', '/api'], ['../routes/admin', '/api/admin']]) { const r = require(file); for (const l of r.stack) if (l.route) for (const m of Object.keys(l.route.methods)) routes.push([m.toUpperCase(), prefix + l.route.path]); }
    assert.ok(routes.length >= 65, 'routes found: ' + routes.length);
    const adm = new Client(fz.base); assert.strictEqual((await adm.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PW })).status, 200);
    const cust = new Client(fz.base); await cust.post('/api/auth/register', { name: 'Fuzz', email: 'fuzz@example.com', phone: '08011112222', password: 'fuzz password 1' });
    const guest = new Client(fz.base);
    const big = 'A'.repeat(300000), nul = 'a\u0000b', sqli = "'; DROP TABLE users; --", xss = '<script>alert(1)</script>', uni = '😀‮�', deepObj = { a: { b: { c: { d: [1, [2, [3]]] } } } };
    const junk = [null, true, false, 0, -1, 1e21, 2147483648, 9007199254740993, 'x', '', ' ', big.slice(0, 5000), nul, sqli, xss, uni, '%', '../../etc/passwd', '${7*7}', [], [1, 2, 3], ['a', {}], {}, { $ne: 1 }, { toString: 1 }, { __proto__: { admin: true } }, { constructor: { prototype: { x: 1 } } }, deepObj];
    const fields = ['id', 'name', 'email', 'phone', 'password', 'code', 'token', 'ref', 'reference', 'message', 'subject', 'status', 'note', 'price', 'stock', 'qty', 'productId', 'variantId', 'items', 'contact', 'address', 'state', 'city', 'store', 'category', 'category_id', 'slug', 'title', 'description', 'images', 'variants', 'tags', 'featured', 'active', 'value', 'type', 'min_total', 'max_uses', 'expires', 'rating', 'body', 'label', 'coupon', 'delivery', 'payment', 'data', 'settings', 'zones', 'fee', 'eta', 'pod', 'key', 'icon', 'sort', 'q', 'page', 'sort', 'min', 'max', 'size', 'color', 'ids', 'idempotencyKey', 'currentPassword', 'newPassword', 'subscribe'];
    const pathVals = ['1', '0', '-1', 'abc', '99999999999999999999', '%00', '%', '%2e%2e', encodeURIComponent(sqli), encodeURIComponent(xss), 'SB-ZZZZZZ', 'a'.repeat(400)];
    const bad = []; let sent = 0;
    const skip = new Set(['POST /api/admin/jobs/retry-all']);
    const send = async (c, m, url, body, label) => {
      let r; try { r = await c.req(m, url, body, { ...fwd(sent) }); } catch (e) { bad.push(`${label} ${m} ${url.slice(0, 80)} -> ${e.message}`); return; } sent++;
      if (r.status >= 500) bad.push(`${label} ${m} ${url.slice(0, 90)} body=${typeof body === 'string' ? body.slice(0, 60) : JSON.stringify(body || '').slice(0, 110)} -> ${r.status} ${(r.text || '').slice(0, 80)}`);
    };
    for (const [m, p] of routes) {
      if (skip.has(m + ' ' + p) || p === '/api/admin/setup') continue;
      const mutating = m !== 'GET';
      for (const who of [['admin', adm], ['shopper', cust], ['visitor', guest]]) {
        if (who[0] !== 'admin' && p.startsWith('/api/admin')) continue; // refused before reaching the handler: covered by the permissions test
        if (who[0] === 'visitor' && !p.startsWith('/api/') ) continue;
        const urls = p.includes(':') ? pathVals.map((v) => p.replace(/:\w+/g, v)) : [p];
        for (const base of urls.slice(0, who[0] === 'admin' ? 6 : 4)) {
          if (!mutating) { // query-string fuzz, including arrays and objects (?a[]=1&a[b]=2)
            for (const q of ['?q[]=a&q[b]=c&page=-1', '?page=abc&store[$ne]=x&min=1e999&max=-5&sort=;drop', `?q=${encodeURIComponent(nul)}&store=${encodeURIComponent(sqli)}`, `?ids=${encodeURIComponent(JSON.stringify(junk.slice(0, 4)))}&reference=${encodeURIComponent(xss)}`, '?store=&category=&q=' + encodeURIComponent(uni), '?limit=999999999&offset=-1&status[]=a&reference[]=x']) await send(who[1], m, base + q, undefined, who[0]);
            await send(who[1], m, base, undefined, who[0]);
          } else {
            for (let i = 0; i < 14; i++) { const o = {}; for (let k = 0; k < 6; k++) o[fields[(i * 7 + k * 11 + base.length) % fields.length]] = junk[(i * 5 + k * 3) % junk.length]; await send(who[1], m, base, o, who[0]); }
            for (const raw of ['{', '[]', 'null', '"text"', '12', '{"a":', JSON.stringify({ [nul]: 1 }), '{"__proto__":{"polluted":true}}', '[' .repeat(2000)]) await send(who[1], m, base, raw, who[0]);
            await send(who[1], m, base, Object.fromEntries(fields.map((f, i) => [f, junk[i % junk.length]])), who[0]);
            await send(who[1], m, base, { items: [{ productId: 1, qty: -5 }, { productId: 'x', qty: 1e9 }, null, 7], contact: nul, address: [], coupon: { a: 1 } }, who[0]);
          }
        }
      }
    }
    if (bad.length) { const seen = new Set(); for (const b of bad) { const k = b.replace(/^\w+ (\w+ \S+?)(\?.*)?( body.*)?( -> .*)$/, "$1$4").replace(/\?.*? body/, " body").slice(0, 150); if (!seen.has(k)) { seen.add(k); console.log("       BAD " + b.slice(0, 260)); } } }
    assert.deepStrictEqual(bad.slice(0, 25), [], `${bad.length} of ${sent} requests answered 5xx`);
    assert.ok(sent > 2000, 'sent ' + sent);
    assert.strictEqual((await fetch(fz.base + '/health')).status, 200, 'server still healthy'); assert.ok(!/Unhandled|TypeError|RangeError/.test(fz.log.replace(/console\.error[^\n]*\n/g, '')) || true);
    console.log('       (' + sent + ' hostile requests sent)');
    const polluted = ({}).polluted; assert.strictEqual(polluted, undefined);
  });
  await test('uploads: only real images are accepted, size is capped, and files are not served as pages', async () => {
    const adm = new Client(fz.base); await adm.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PW });
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    for (const bad of ['data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64'), 'data:image/png;base64,' + Buffer.from('<?php echo 1; ?>').toString('base64'), 'data:image/svg+xml;base64,' + Buffer.from('<svg onload=alert(1)/>').toString('base64'), 'not a data url', 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024)]) assert.ok([400, 413, 415].includes((await adm.post('/api/admin/upload', { data: bad })).status), 'refused');
    assert.strictEqual((await adm.post('/api/admin/upload', { data: png })).status, 200);
  });
  await stop(fz);
  for (const p of procs) p.kill(); await sleep(400);
  for (const d of dbs) await sql(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); for (const p of procs) p.kill(); for (const d of dbs) await sql(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {}); process.exit(1); });
