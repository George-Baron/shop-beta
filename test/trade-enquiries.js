'use strict';
// Import & Export enquiries: the public form, spam protection, the admin inbox and who may see it.
// Run with: npm run test:trade-enquiries   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_tenq_' + tag;
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

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-tenq-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '10' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b, c) => call(m, '/api/admin/trade-enquiries' + u, b, c || admin);
  const good = { kind: 'import', name: 'Chidi Okafor', company: 'Okafor Farms', email: 'chidi@example.com', phone: '08031234567', country: 'China', item: 'Solar water pumps', quantity: '40 units', budget: '₦8m', timeline: 'By March', shipping: 'sea', details: 'Need 2-inch surface pumps with a 1 year warranty.' };
  const reg = await call('POST', '/api/auth/register', { name: 'Enq Customer', email: 'enq.customer@example.com', phone: '08031230001', password: 'mango-river-sky-55' }); assert.strictEqual(reg.s, 200, reg.t);
  const ask = (b) => call('POST', '/api/trade-enquiries', b, reg.c);   // the form is for registered customers

  console.log('\nThe public form');
  await test('an import enquiry is saved, the visitor is emailed a reference, and the team is told', async () => {
    const r = await ask(good); assert.strictEqual(r.s, 200, r.t); assert.ok(/^TE-[0-9A-F]{8}$/.test(r.j.ref));
    const row = (await q('SELECT * FROM trade_enquiries WHERE ref=$1', [r.j.ref]))[0]; assert.strictEqual(row.kind, 'import'); assert.strictEqual(row.status, 'new'); assert.strictEqual(row.country, 'China'); assert.strictEqual(row.shipping, 'sea'); assert.strictEqual(row.email, 'chidi@example.com');
    assert.ok((await q("SELECT 1 FROM outbox WHERE to_email='chidi@example.com' AND subject LIKE $1", ['%' + r.j.ref + '%'])).length >= 1, 'confirmation email');
    assert.ok((await q("SELECT 1 FROM notifications WHERE title LIKE $1", ['%' + r.j.ref + '%'])).length >= 1, 'team notified');
  });
  await test('an export enquiry works too; repeating the same one within a day is not saved twice', async () => {
    const b = { ...good, kind: 'export', name: 'Amina Yusuf', email: 'amina@example.com', country: 'Ghana', item: 'Shea butter, 500 kg', shipping: undefined };
    const r = await ask(b); assert.strictEqual(r.s, 200, r.t); const again = await ask(b); assert.strictEqual(again.j.ref, r.j.ref); assert.strictEqual(again.j.duplicate, true);
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM trade_enquiries WHERE email='amina@example.com'"))[0].n, 1); assert.strictEqual((await q("SELECT shipping FROM trade_enquiries WHERE email='amina@example.com'"))[0].shipping, 'any');
  });
  await test('a visitor who is not signed in cannot send an enquiry', async () => { const r = await call('POST', '/api/trade-enquiries', good); assert.strictEqual(r.s, 401); });
  await test('bad input is refused with a plain message, and a filled honeypot saves nothing', async () => {
    for (const [patch, re] of [[{ kind: 'sell' }, /Import or Export/], [{ name: '' }, /name/], [{ email: 'nope' }, /email/], [{ item: 'x' }, /import/], [{ country: '' }, /country/], [{ details: 'short' }, /details/]]) { const r = await ask({ ...good, email: 'x' + Math.random().toString(36).slice(2) + '@example.com', ...patch }); assert.strictEqual(r.s, 400, JSON.stringify(patch)); assert.ok(re.test(r.j.error), r.j.error); }
    const before = (await q('SELECT COUNT(*)::int n FROM trade_enquiries'))[0].n; const bot = await ask({ ...good, email: 'bot@example.com', item: 'Cheap pills', website: 'http://spam.example' }); assert.strictEqual(bot.s, 200);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM trade_enquiries'))[0].n, before, 'nothing saved');
  });
  await test('markup in the form is stored as text and escaped in the emails', async () => {
    const r = await ask({ ...good, email: 'xss@example.com', name: '<script>alert(1)</script>Eve', item: '<img src=x onerror=alert(1)> pumps' }); assert.strictEqual(r.s, 200, r.t);
    const m = (await q("SELECT body FROM outbox WHERE to_email='xss@example.com'"))[0]; assert.ok(m && !/<script>|<img src=x/.test(m.body), 'escaped in the email');
  });
  console.log('\nThe admin inbox');
  let ids = [];
  await test('the owner lists, filters and searches enquiries', async () => {
    const all = (await A('GET', '')).j; assert.ok(all.enquiries.length >= 3); assert.ok(all.counts.new >= 3); ids = all.enquiries.map((x) => x.id);
    assert.ok((await A('GET', '?kind=export')).j.enquiries.every((x) => x.kind === 'export')); assert.strictEqual((await A('GET', '?q=shea')).j.enquiries.length, 1); assert.strictEqual((await A('GET', '?q=%25')).s, 200);
  });
  await test('updating the status and note records who handled it and when it was first touched', async () => {
    const id = ids[ids.length - 1], r = await A('PUT', '/' + id, { status: 'quoted', note: 'Sent a quote on WhatsApp.' }); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.enquiry.status, 'quoted'); assert.strictEqual(r.j.enquiry.note, 'Sent a quote on WhatsApp.'); assert.ok(r.j.enquiry.contacted_at); assert.ok(r.j.enquiry.handled_by);
    assert.strictEqual((await A('PUT', '/' + id, { status: 'banana' })).j.enquiry.status, 'quoted', 'an unknown status changes nothing'); assert.strictEqual((await A('PUT', '/999999', { status: 'won' })).s, 404);
  });
  await test('only people with the Requests for quotation module can see it; nobody signed out can', async () => {
    const roleId = async (n) => (await call('GET', '/api/admin/staff', undefined, admin)).j.roles.find((r) => r.name === n).id;
    const mk = async (key, role) => { const r = await call('POST', '/api/admin/staff', { name: key, email: key + '@example.com', role_id: await roleId(role) }, admin); assert.strictEqual(r.s, 200, r.t); return login(key + '@example.com', r.j.temp_password); };
    const wsale = await mk('wsale', 'Wholesale Sales Officer'), fin = await mk('finn', 'Catalogue Manager'), sales = await mk('sally', 'Sales Representative');
    assert.strictEqual((await A('GET', '', undefined, wsale)).s, 200); assert.strictEqual((await A('PUT', '/' + ids[0], { status: 'in_progress' }, wsale)).s, 200);
    assert.strictEqual((await A('GET', '', undefined, sales)).s, 200, 'Sales Representatives can view RFQs'); assert.strictEqual((await A('PUT', '/' + ids[0], { status: 'won' }, sales)).s, 403, 'but not change them');
    assert.strictEqual((await A('GET', '', undefined, fin)).s, 403); assert.strictEqual((await call('GET', '/api/admin/trade-enquiries')).s, 401);
  });
  await test('the form is rate limited per visitor (5 an hour, multiplied by the test setting)', async () => {
    let hit = 0; for (let i = 0; i < 70 && !hit; i++) { const r = await ask({ ...good, email: `rl${i}@example.com`, item: 'Item number ' + i }); if (r.s === 429) hit = i; } assert.ok(hit > 0 && hit <= 60, 'limited after ' + hit);
  });
  srv.kill(); await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`); if (failed) { console.log(log.slice(-1500)); process.exit(1); } process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
