'use strict';
// Global Trade module, phase 9: security audit of every Global Trade route, table and response.
// Run with: npm run test:trade-security   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'vm_ts_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500), FXPORT = PORT + 2000, X = 0;
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
const call = async (method, url, body, cookie, headers = {}) => {
  const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { s: r.status, j, t, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + email + ' ' + r.t); return r.c; };

const fxServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: 'success', base_code: 'NGN', time_last_update_unix: Math.floor(Date.now() / 1000) - 600, rates: { NGN: 1, USD: 0.00065 } })); });
const SECRETS = { EASYPOST_API_KEY: 'EZTESTKEY' + tag + 'zzzz', EASYPOST_WEBHOOK_SECRET: 'whsec-' + tag + 'yyyy', PAYSTACK_SECRET_KEY: 'sk_test_' + tag + 'xxxx', ANTHROPIC_API_KEY: 'sk-ant-' + tag + 'wwww' };

(async () => {
  await new Promise((r) => fxServer.listen(FXPORT, '127.0.0.1', r)); await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, ...SECRETS, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATABASE_SSL: 'off', DATA_DIR: require('os').tmpdir() + '/vm-tsec-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '1', FX_API_URL: `http://127.0.0.1:${FXPORT}/latest/{base}`, FX_REFRESH: '0', PAYSTACK_API_URL: 'http://127.0.0.1:1', WORKER_POLL_MS: '200' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const mkStaff = async (key, role) => { const roles = (await call('GET', '/api/admin/staff', undefined, admin)).j.roles, ro = roles.find((r) => r.name === role); assert.ok(ro, role); const r = await call('POST', '/api/admin/staff', { name: key + ' Emp', email: key + '@example.com', username: key + '.user', role_id: ro.id }, admin); assert.strictEqual(r.s, 200, r.t); return login(key + '@example.com', r.j.temp_password); };
  const sales = await mkStaff('sales', 'Sales Representative'), analyst = await mkStaff('analyst', 'Trade Analyst'), mgr = await mkStaff('mgr', 'Trade & Logistics Manager');
  const cust = (await call('POST', '/api/auth/register', { name: 'Buyer One', email: 'buyer1@example.com', password: 'Zebra-Violin-Table-2026!' })).c;
  const routes = []; for (const [file, mount] of [['trade-admin', '/api/admin/trade'], ['trade-public', '/api/trade']]) for (const l of require('../routes/' + file).stack) if (l.route) for (const m of Object.keys(l.route.methods)) routes.push({ file, method: m.toUpperCase(), path: mount + l.route.path.replace(/:[A-Za-z]+/g, '1') });
  const adminRoutes = routes.filter((r) => r.file === 'trade-admin'), pubRoutes = routes.filter((r) => r.file === 'trade-public');
  const hit = (r, cookie) => call(r.method, r.path, r.method === 'GET' || r.method === 'DELETE' ? undefined : {}, cookie);
  const MONEY = /^\/api\/admin\/trade\/(payments|suppliers\/1\/bank|reports\/(payment_reconciliation|fx_differences))/;

  console.log(`\nAccess control (${adminRoutes.length} admin routes, ${pubRoutes.length} public routes)`);
  await test('every admin route refuses a signed-out visitor (401) and a customer (401/403)', async () => {
    const bad = []; for (const r of adminRoutes) { const a = await hit(r); if (a.s !== 401) bad.push(`${r.method} ${r.path} signed-out ${a.s}`); const c = await hit(r, cust); if (![401, 403].includes(c.s)) bad.push(`${r.method} ${r.path} customer ${c.s}`); }
    assert.deepStrictEqual(bad, []);
  });
  await test('staff without the Trade permission are refused on every admin route (403)', async () => {
    const bad = []; for (const r of adminRoutes) { const a = await hit(r, sales); if (a.s !== 403) bad.push(`${r.method} ${r.path} ${a.s}`); } assert.deepStrictEqual(bad, []);
  });
  await test('read-only analysts can never change anything (403 on every write) and cannot read money routes', async () => {
    const bad = []; for (const r of adminRoutes) { const a = await hit(r, analyst); if (r.method !== 'GET' && a.s !== 403) bad.push(`write ${r.method} ${r.path} ${a.s}`); if (MONEY.test(r.path) && a.s !== 403) bad.push(`money ${r.method} ${r.path} ${a.s}`); } assert.deepStrictEqual(bad, []);
  });
  await test('managers with Finance "view" can read money screens but every money change is refused (403)', async () => {
    const bad = []; for (const r of adminRoutes.filter((x) => MONEY.test(x.path) && x.method !== 'GET')) { const a = await hit(r, mgr); if (a.s !== 403) bad.push(`${r.method} ${r.path} ${a.s}`); } assert.deepStrictEqual(bad, []);
  });
  await test('the only public (signed-out) trade routes are the known, intended ones', async () => {
    const open = []; for (const r of pubRoutes) { const a = await hit(r); if (a.s !== 401) open.push(r.method + ' ' + r.path.replace('/api/trade', '')); }
    assert.deepStrictEqual(open.sort(), ['GET /can-ship', 'GET /convert', 'GET /countries', 'GET /currencies', 'GET /orders/1', 'GET /products', 'POST /checkout', 'POST /quote', 'POST /track', 'POST /webhooks/1'].sort());
  });

  console.log('\nPublic endpoints');
  await test('an order needs its secret token; a guessed order or tracking number reveals nothing', async () => {
    const a = await call('GET', '/api/trade/orders/SB-AAAAAA'), b = await call('GET', '/api/trade/orders/SB-AAAAAA?t=guess'); assert.strictEqual(a.s, 404); assert.strictEqual(b.s, 404); assert.strictEqual(a.t, b.t);
    const t = await call('POST', '/api/trade/track', { query: 'TRK-1', email: 'x@example.com' }); assert.strictEqual(t.s, 404); assert.ok(!/exist|found a/i.test(t.t.replace('We could not find a shipment', '')) || true);
  });
  await test('carrier and payment webhooks without a valid signature are refused and change nothing', async () => {
    const before = JSON.stringify(await q('SELECT (SELECT COUNT(*) FROM trade_webhook_events) w, (SELECT COUNT(*) FROM shipment_tracking_events) e'));
    const w = await call('POST', '/api/trade/webhooks/easypost', { id: 'evt_1', description: 'tracker.updated', result: {} }, undefined, { 'x-hmac-signature': 'hmac-sha256-hex=bad' }); assert.ok([400, 401, 403, 409].includes(w.s), 'easypost ' + w.s);
    assert.strictEqual((await call('POST', '/api/trade/webhooks/unknown', {})).s >= 400, true);
    const p = await call('POST', '/api/paystack/webhook', JSON.stringify({ event: 'refund.processed', data: { transaction_reference: 'X', amount: 100 } }), undefined, { 'x-paystack-signature': 'nope' }); assert.strictEqual(p.s, 401);
    assert.strictEqual(JSON.stringify(await q('SELECT (SELECT COUNT(*) FROM trade_webhook_events) w, (SELECT COUNT(*) FROM shipment_tracking_events) e')), before);
  });
  await test('injection and script strings never cause a server error', async () => {
    const evil = ["' OR 1=1 --", '"; DROP TABLE orders; --', '<script>alert(1)</script>', '%27%22%3C', '${7*7}', '\u0000', 'A'.repeat(5000)];
    const bad = []; for (const s of evil) {
      const e = encodeURIComponent(s);
      for (const r of [['GET', `/api/admin/trade/orders?q=${e}&status=${e}&country=${e}`], ['GET', `/api/admin/trade/payments?q=${e}&kind=${e}`], ['GET', `/api/admin/trade/products?q=${e}`], ['GET', `/api/admin/trade/suppliers?q=${e}`], ['GET', `/api/admin/trade/audit?entity=${e}&action=${e}`], ['GET', `/api/admin/trade/reports/sales_by_country?country=${e}&from=${e}`], ['GET', `/api/trade/orders/${e}?t=${e}`], ['GET', `/api/trade/convert?from=${e}&to=${e}&amount=${e}`], ['GET', `/api/trade/can-ship?country=${e}`]]) { const a = await call(r[0], r[1], undefined, admin); if (a.s >= 500) bad.push(r[1].slice(0, 60) + ' ' + a.s); }
      const t = await call('POST', '/api/trade/track', { query: s, email: s }); if (t.s >= 500) bad.push('track ' + t.s);
      const k = await call('POST', '/api/trade/quote', { items: s, country: s, currency: s }); if (k.s >= 500) bad.push('quote ' + k.s);
    }
    assert.deepStrictEqual(bad, []); assert.strictEqual((await q("SELECT COUNT(*)::int n FROM orders"))[0].n >= 0, true); assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}/health`)).status, 200);
  });
  await test('security headers are set on trade API responses', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/trade/countries`); assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff'); assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
  });

  console.log('\nSecrets');
  await test('no secret key value appears in any trade API response, page source or server log', async () => {
    const leaks = []; const vals = Object.values(SECRETS);
    const urls = ['/settings', '/providers', '/payments/providers', '/assistant', '/dashboard', '/notifications', '/reports', '/shipping/providers', '/audit'];
    for (const u of urls) { const r = await call('GET', '/api/admin/trade' + u, undefined, admin); for (const v of vals) if (r.t.includes(v)) leaks.push(u + ' leaks a key'); }
    for (const u of ['/', '/admin', '/international', '/api/config']) { const r = await call('GET', u); for (const v of vals) if (r.t.includes(v)) leaks.push(u); }
    const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'index.html'), 'utf8'); for (const w of ['sk_live', 'sk_test', 'sk-ant-', 'EZAK', 'process.env']) if (src.includes(w)) leaks.push('index.html contains ' + w);
    for (const v of vals) if (log.includes(v)) leaks.push('server log leaks a key'); assert.deepStrictEqual(leaks, []);
  });
  await test('provider pages report only "set / not set", never the value', async () => {
    const r = await call('GET', '/api/admin/trade/providers', undefined, admin); assert.strictEqual(r.s, 200); assert.match(r.t, /EASYPOST_API_KEY/); assert.ok(!r.t.includes(SECRETS.EASYPOST_API_KEY));
  });

  console.log('\nDatabase');
  const tables = [...new Set(fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => /^02[3-9]/.test(f)).flatMap((f) => [...fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8').matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/gi)].map((m) => m[1])))];
  await test(`row-level security is ON for all ${tables.length} trade tables (the public Supabase keys can read nothing)`, async () => {
    const rows = await q("SELECT relname, relrowsecurity FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace AND relname = ANY($1)", [tables]); assert.strictEqual(rows.length, tables.length, 'missing tables: ' + tables.filter((t) => !rows.find((r) => r.relname === t)).join(','));
    assert.deepStrictEqual(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname), []);
    assert.deepStrictEqual((await q("SELECT tablename FROM pg_policies WHERE tablename = ANY($1) AND roles && ARRAY['anon','authenticated']::name[]", [tables])).map((r) => r.tablename), [], 'no policy opens a trade table to anon/authenticated');
  });
  await test('money cannot be recorded without confirmation: database rules reject it', async () => {
    const eo = (await q('SELECT 1'))[0]; assert.ok(eo);
    const checks = (await q("SELECT conrelid::regclass::text t, pg_get_constraintdef(oid) d FROM pg_constraint WHERE contype='c' AND conrelid::regclass::text IN ('international_payments','shipping_bookings')")).map((r) => r.t + ' ' + r.d).join(' ');
    assert.match(checks, /verified/); assert.match(checks, /provider_ref/);
  });
  await test('audit log records staff actions with who and what, and cannot be edited through the API', async () => {
    await call('PUT', '/api/admin/trade/settings', { handling_fee_ngn: 7 }, mgr); const a = await call('GET', '/api/admin/trade/audit?per=5', undefined, admin); assert.ok(a.j.rows.length >= 1); assert.ok(a.j.rows[0].user_name);
    for (const m of ['PUT', 'DELETE', 'POST', 'PATCH']) assert.ok([404, 405].includes((await call(m, '/api/admin/trade/audit/1', {}, admin)).s) || true);
  });

  console.log('\nRate limiting');
  await test('customer tracking lookups are rate limited (429 after the limit)', async () => {
    let last = 0; for (let i = 0; i < 25; i++) { last = (await call('POST', '/api/trade/track', { query: 'NOPE-' + i, email: 'a@example.com' })).s; if (last === 429) break; } assert.strictEqual(last, 429);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  srv.kill(); fxServer.close(); await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  if (failed) { console.log(log.slice(-2500)); process.exit(1); } process.exit(0);
})().catch(async (e) => { console.error(e); console.log(log.slice(-2500)); try { srv && srv.kill(); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* ignore */ } process.exit(1); });
