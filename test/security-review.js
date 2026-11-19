'use strict';
// Security review: row level security, access sweep across every admin route, upload hardening, secrets.
// Run with: npm run test:security-review   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_sec_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500);
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
const call = async (method, url, body, cookie, raw) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: raw ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const buf = Buffer.from(await r.arrayBuffer()); const t = buf.toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  if (process.env.DEBUG_V && r.status >= 400) console.log('   [' + r.status + '] ' + method + ' ' + url + ' ' + t.slice(0, 200));
  return { s: r.status, j, t, buf, h: r.headers, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + email + ' ' + r.t); return r.c; };
const PW = 'Wholesale-Test-Pass-2026!';
// Wholesale stock lives in the warehouse (separate from retail products.stock).
const stockOf = async (id) => { const r = (await q('SELECT on_hand - reserved AS a FROM wholesale_stock_balances WHERE product_id=$1', [id]))[0]; return r ? Number(r.a) : 0; };
const setAvail = async (ids, n) => { const wh = (await q("SELECT id FROM wholesale_warehouses WHERE code='MAIN'"))[0].id; for (const id of ids) await q('INSERT INTO wholesale_stock_balances (product_id,warehouse_id,on_hand,reserved,updated) VALUES ($1,$2,$3,0,1) ON CONFLICT (product_id,warehouse_id) DO UPDATE SET on_hand = wholesale_stock_balances.reserved + $3', [id, wh, n]); };
const appBody = (o = {}) => ({ business_name: 'Ada Provisions Ltd', contact_name: 'Ada Obi', phone: '08031234567', address: '5 Trade Fair Road', state: 'Lagos', city: 'Ojo', reg_no: 'RC445566', business_type: 'Retailer', buys: 'Rice, beans and cooking oil for my shops', est_monthly: '₦2m', ...o });

const X = require('../lib/xlsx');

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-sec-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const fs = require('fs'), A = (m, u, b, c) => call(m, u, b, c || admin), PWD = 'Quartz-Meadow-2026!';
  const ST = (m, u, b) => A(m, '/api/admin/staff' + u, b);

  console.log('\nDatabase');
  await test('every table in the public schema has row level security (the public key can read nothing)', async () => {
    const t = await q("SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity AND tablename <> 'schema_migrations'");
    assert.deepStrictEqual(t.map((x) => x.tablename), [], 'tables without RLS: ' + t.map((x) => x.tablename).join(', '));
    assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM pg_policies WHERE schemaname='public'"))[0].n), 0, 'no policies means anon and authenticated roles are denied');
  });

  // ---- discover every admin route from the source, so a route added tomorrow is swept too
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'routes', f), 'utf8');
  const mounts = [['admin.js', '']]; for (const m of src('admin.js').matchAll(/router\.use\('(\/[a-z-]+)',(?:[^)]*?)require\('\.\/([a-z-]+)'\)/g)) mounts.push([m[2] + '.js', m[1]]);
  const routes = [];
  for (const [file, prefix] of mounts) for (const m of src(file).matchAll(/router\.(get|post|put|delete|patch)\(\s*'([^']*)'/g)) routes.push([m[1].toUpperCase(), '/api/admin' + prefix + (m[2] === '/' && prefix ? '' : m[2]).replace(/:[A-Za-z_]+/g, '1')]);
  const uniq = [...new Map(routes.map((r) => [r.join(' '), r])).values()];
  console.log(`  (${uniq.length} admin routes discovered from ${mounts.length} files)`);
  const sweep = async (cookie) => { const out = []; for (const [m, u] of uniq) { if (/\/upload$|\/restore$/.test(u) && m !== 'GET') continue; if (u === '/api/admin/setup') continue;   // first-run setup: public by design, closed once an owner exists (POST refuses; GET only says whether setup is needed)
 const r = await call(m, u, m === 'GET' || m === 'DELETE' ? undefined : {}, cookie); out.push([m, u, r.s]); } return out; };

  console.log('\nAccess control');
  await test('signed out: every admin route refuses', async () => { const bad = (await sweep(undefined)).filter((x) => x[2] !== 401); assert.deepStrictEqual(bad, []); });
  await test('a customer, a partner store and a wholesale buyer are refused on every admin route', async () => {
    assert.strictEqual((await call('POST', '/api/auth/register', { name: 'Cus Tomer', email: 'cus@example.com', phone: '08030000001', password: PWD })).s, 200); const cus = await login('cus@example.com', PWD);
    const ap = await call('POST', '/api/partners/apply', { name: 'Sec Store', contactName: 'Sec Owner', email: 'sec@example.com', phone: '08031234567', address: '12 Market Road, Yaba', state: 'Lagos', city: 'Yaba', regNo: 'RC1234567', about: 'x', password: PWD, departments: ['supermarket'] }); assert.ok(ap.s < 300, ap.t); const ven = await login('sec@example.com', PWD);
    for (const [who, c] of [['customer', cus], ['partner', ven]]) { const bad = (await sweep(c)).filter((x) => ![401, 403].includes(x[2])); assert.deepStrictEqual(bad, [], who); }
  });
  const role = async (name, perms) => { const r = await ST('POST', '/roles', { name, description: 'x', perms }); assert.strictEqual(r.s, 200, r.t); return r.j.id; };
  const emp = async (key, roleId) => { const r = await ST('POST', '', { name: key + ' Emp', email: key + '@example.com', role_id: roleId }); assert.strictEqual(r.s, 200, r.t); return login(key + '@example.com', r.j.temp_password); };
  await test('an employee whose role has no permissions can reach nothing except what is open to every employee', async () => {
    const c = await emp('nothing', await role('Nothing', [])); const res = await sweep(c); const open = res.filter((x) => x[2] !== 403 && x[2] !== 401);
    console.log('    open to every employee:', [...new Set(open.map((x) => x[1].replace('/api/admin', '')))].join(', ') || '(none)');
    assert.ok(open.every((x) => /\/(dashboard|notifications)/.test(x[1])), 'unexpected: ' + JSON.stringify(open.filter((x) => !/\/(dashboard|notifications)/.test(x[1]))));
  });
  await test('the dashboard shows an employee only the parts their role allows (no money, orders, customers or stock without permission)', async () => {
    const T = Math.floor(Date.now() / 1000);
    await q("INSERT INTO orders (ref,payment_method,payment_status,status,name,email,phone,state,subtotal,total,created) VALUES ('DASH1','card','paid','paid','Secret Shopper','s@example.com','08011111111','Lagos',4000,4000,$1)", [T - 60]);
    const dash = async (key, perms) => (await A('GET', '/api/admin/dashboard', undefined, await emp(key, await role('R ' + key, perms)))).j;
    const none = await dash('dnone', []); const t = JSON.stringify(none);
    assert.ok(!/Secret Shopper|DASH1/.test(t), 'no order data'); assert.strictEqual(none.today.rev, null); assert.strictEqual(none.all.rev, null); assert.strictEqual(none.customers, null); assert.deepStrictEqual([none.recent, none.top, none.low, none.days, none.byStatus], [[], [], [], [], []]); assert.strictEqual(none.unread, 0);
    const ord = await dash('dord', ['orders:view']); assert.ok(ord.recent.some((o) => o.ref === 'DASH1')); assert.strictEqual(ord.recent[0].total, null, 'orders view does not show money'); assert.strictEqual(ord.all.rev, null); assert.strictEqual(ord.all.n, 1);
    const fin = await dash('dfin', ['finance:view']); assert.strictEqual(fin.all.rev, 4000); assert.deepStrictEqual(fin.recent, [], 'finance view alone shows no customer orders');
    const cus = await dash('dcus', ['customers:view']); assert.ok(cus.customers >= 0 && cus.customers !== null); assert.strictEqual(cus.all.rev, null);
    const owner = (await A('GET', '/api/admin/dashboard')).j; assert.strictEqual(owner.all.rev, 4000); assert.ok(owner.recent.some((o) => o.ref === 'DASH1'));
  });
  await test('even a role with every permission cannot reach owner-only areas (team, settings, backups, errors, jobs, audit)', async () => {
    const ALL = ['orders', 'catalog', 'partners', 'wholesale', 'warehouse', 'rfq', 'customers', 'delivery', 'marketing', 'finance', 'reports'].flatMap((k) => [k + ':view', k + ':edit']);
    const c = await emp('everything', await role('Everything', ALL)); const res = await sweep(c);
    const denied = res.filter((x) => x[2] === 403).map((x) => x[1].replace('/api/admin', ''));
    for (const p of [/^\/staff/, /^\/settings/, /^\/backups/, /^\/errors/, /^\/jobs/, /^\/audit/, /^\/wholesale\/settings/]) assert.ok(denied.some((d) => p.test(d)), 'must be denied: ' + p);
    const leaked = res.filter((x) => x[2] !== 403 && /^\/api\/admin\/(staff|settings|backups|errors|jobs|audit|status)/.test(x[1])); assert.deepStrictEqual(leaked, []);
  });
  await test('a deactivated employee is locked out at once, on the very next request', async () => {
    const r = await ST('POST', '', { name: 'Gone Emp', email: 'gone@example.com', role_id: await role('Seer', ['orders:view']) }); const c = await login('gone@example.com', r.j.temp_password);
    assert.strictEqual((await A('GET', '/api/admin/orders', undefined, c)).s, 200); assert.strictEqual((await ST('PUT', '/' + r.j.id, { active: false })).s, 200); assert.strictEqual((await A('GET', '/api/admin/orders', undefined, c)).s, 401);
  });
  await test('a cross-site request is refused (foreign Origin) on the new import endpoints', async () => {
    for (const u of ['/api/admin/catalog/validate', '/api/partner/catalog/validate', '/api/admin/commercial/partners/1/officer']) { const r = await fetch(`http://127.0.0.1:${PORT}${u}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: admin }, body: '{}' }); assert.strictEqual(r.status, 403, u); }
  });

  console.log('\nUploads');
  const bomb = fs.readFileSync(process.env.BOMB || path.join(__dirname, '..', 'test', 'fixtures', 'zipbomb.xlsx'));
  await test('a booby-trapped Excel file (tiny, but expands to hundreds of MB) is refused quickly on every upload path, and the server stays up', async () => {
    const data = bomb.toString('base64'); const t0 = Date.now();
    const a = await A('POST', '/api/admin/catalog/parse', { filename: 'b.xlsx', data }); assert.strictEqual(a.s, 400, a.t);
    const ap = await call('POST', '/api/partners/apply', { name: 'Bomb Store', contactName: 'Sec Owner', email: 'bomb@example.com', phone: '08031234567', address: '12 Market Road, Yaba', state: 'Lagos', city: 'Yaba', regNo: 'RC7654321', about: 'x', password: PWD, departments: ['supermarket'] }); const bc = await login('bomb@example.com', PWD);
    const p = await call('POST', '/api/partner/catalog/parse', { filename: 'b.xlsx', data }, bc); assert.strictEqual(p.s, 400, p.t);
    assert.ok(Date.now() - t0 < 5000, 'refused fast'); assert.strictEqual((await call('GET', '/health')).s, 200, 'server alive');
  });
  await test('product photos: only real PNG/JPG/WEBP/GIF content is accepted (no SVG, no disguised files), up to 2 MB', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    assert.strictEqual((await A('POST', '/api/admin/upload', { data: 'data:image/png;base64,' + png })).s, 200);
    assert.strictEqual((await A('POST', '/api/admin/upload', { data: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64') })).s, 400);
    assert.strictEqual((await A('POST', '/api/admin/upload', { data: 'data:image/png;base64,' + Buffer.from('<html><script>alert(1)</script></html>').toString('base64') })).s, 400, 'html disguised as png');
    assert.strictEqual((await A('POST', '/api/admin/upload', { data: 'data:image/png;base64,' + Buffer.alloc(2_100_000, 1).toString('base64') })).s, 400, 'over 2 MB');
  });

  console.log('\nSecrets');
  await test('no password hashes, tokens or API keys appear in what the browser receives', async () => {
    const checks = [await A('GET', '/api/me'), await A('GET', '/api/admin/staff'), await A('GET', '/api/admin/customers'), await A('GET', '/api/admin/vendors'), await call('GET', '/api/config'), await call('GET', '/api/products')];
    for (const r of checks) assert.ok(!/\$2[aby]\$|scrypt\$|"password"|sk_(live|test)_|service_role|SUPABASE|RESEND|"token"/i.test(r.t), 'leak in response: ' + r.t.slice(0, 120));
    const s = (await A('GET', '/api/admin/settings')).t; assert.ok(!/sk_(live|test)_|service_role|re_[A-Za-z0-9]{20}/.test(s), 'settings must not echo secret keys');
  });

  srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.split('\n').slice(-15).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { srv.kill(); } catch { /* */ } process.exit(1); });
