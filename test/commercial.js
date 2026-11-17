'use strict';
// Commercial operations workspace and reports.
// Run with: npm run test:commercial   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_comm_' + tag;
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
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-comm-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, u, b, admin);
  const ST = (m, u, b) => A(m, '/api/admin/staff' + u, b);
  const CM = (m, u, b, c) => call(m, '/api/admin/commercial' + u, b, c || admin);
  const roleId = async (name) => (await ST('GET', '')).j.roles.find((r) => r.name === name).id;
  const mk = async (key, role) => { const r = await ST('POST', '', { name: key + ' Person', email: key + '@example.com', role_id: await roleId(role) }); assert.strictEqual(r.s, 200, r.t); return { id: r.j.id, c: await login(key + '@example.com', r.j.temp_password) }; };
  const T = Math.floor(Date.now() / 1000);

  // seed: 2 approved partner stores + 1 under evaluation; sales for Alpha; one pending product
  const v = {};
  for (const [k, name, st] of [['a', 'Alpha Mart', 'approved'], ['b', 'Beta Goods', 'approved'], ['c', 'Gamma Pending', 'pending']]) v[k] = (await q("INSERT INTO vendors (slug,name,status,city,state,created,commission_pct) VALUES ($1,$2,$3,'Ikeja','Lagos',$4,10) RETURNING id", [k + '-store', name, st, T - 5 * 86400]))[0].id;
  const prod = async (vid, name, listing, stock) => (await q("INSERT INTO products (slug,store,name,price,stock,vendor_id,listing,active,created) VALUES ($1,'supermarket',$2,1000,$3,$4,$5,1,$6) RETURNING id", [name.toLowerCase().replace(/ /g, '-') + '-' + tag, name, stock, vid, listing, T]))[0].id;
  const pa = await prod(v.a, 'Alpha Rice', 'approved', 10); await prod(v.a, 'Alpha Beans', 'pending', 5); await prod(v.b, 'Beta Oil', 'approved', 0);
  const order = async (status, pay, payst, items) => { const o = (await q("INSERT INTO orders (ref,payment_method,payment_status,status,name,email,phone,state,subtotal,total,created) VALUES ($1,$2,$3,$4,'Cust','c@example.com','0803','Lagos',$5,$5,$6) RETURNING id", ['T' + Math.random().toString(36).slice(2, 8), pay, payst, status, items.reduce((s, i) => s + i[1] * i[2], 0), T - 3600]))[0].id; for (const [pid, price, qty, vid, comm] of items) await q("INSERT INTO order_items (order_id,product_id,name,price,qty,vendor_id,commission) VALUES ($1,$2,'x',$3,$4,$5,$6)", [o, pid, price, qty, vid, comm]); };
  await order('delivered', 'card', 'paid', [[pa, 1000, 3, v.a, 300]]);        // counts: 3000 sales, 300 commission
  await order('confirmed', 'pod', 'unpaid', [[pa, 1000, 2, v.a, 200]]);       // pay on delivery counts: 2000
  await order('cancelled', 'card', 'paid', [[pa, 1000, 5, v.a, 500]]);        // cancelled: must NOT count
  await order('pending', 'card', 'unpaid', [[pa, 1000, 4, v.a, 400]]);        // unpaid card: must NOT count

  console.log('\nCommercial operations');
  await test('owner sees the workspace: partner counts, products awaiting review, unassigned partners', async () => {
    const r = await CM('GET', '/overview'); assert.strictEqual(r.s, 200, r.t);
    const P = r.j.sections.find((s) => s.key === 'partners'); assert.strictEqual(P.counts.pending, 1); assert.strictEqual(P.counts.approved, 2); assert.strictEqual(P.counts.productsAwaiting, 1); assert.strictEqual(P.counts.unassigned, 3);
    const a = P.rows.find((x) => x.name === 'Alpha Mart'); assert.strictEqual(a.sales, 5000, 'only paid or pay-on-delivery, not cancelled'); assert.strictEqual(a.awaiting, 1); assert.strictEqual(a.live, 1);
  });
  await test('assign a relationship officer; the officer is told; filters by officer work; bad officer refused', async () => {
    const off = await mk('officer1', 'Partner Relationship Officer'), sales = await mk('salesrep', 'Sales Representative');
    assert.strictEqual((await CM('POST', `/partners/${v.a}/officer`, { user_id: off.id })).s, 200);
    assert.strictEqual((await CM('POST', `/partners/${v.a}/officer`, { user_id: sales.id })).s, 400, 'a sales rep cannot look after partners');
    assert.strictEqual((await CM('POST', '/partners/999999/officer', { user_id: off.id })).s, 404);
    const mine = (await CM('GET', '/overview?officer=' + off.id)).j.sections.find((s) => s.key === 'partners').rows; assert.deepStrictEqual(mine.map((x) => x.name), ['Alpha Mart']);
    assert.strictEqual((await CM('GET', '/overview?officer=none')).j.sections.find((s) => s.key === 'partners').rows.length, 2);
    assert.ok((await call('GET', '/api/notifications', undefined, off.c)).j.notifications.some((n) => /Alpha Mart/.test(n.title)));
    assert.strictEqual((await CM('POST', `/partners/${v.a}/officer`, { user_id: null })).s, 200); assert.strictEqual((await CM('GET', '/overview?officer=' + off.id)).j.sections[0].rows.length, 0);
  });
  await test('employees see only what their role allows; read-only roles cannot assign', async () => {
    const pro = await mk('pro', 'Partner Relationship Officer'), fin = await mk('fin', 'Finance Officer'), cat = await mk('catm', 'Catalogue Manager');
    const o = await CM('GET', '/overview', undefined, pro.c); assert.strictEqual(o.s, 200); assert.ok(o.j.sections.some((s) => s.key === 'partners'));
    assert.strictEqual((await CM('POST', `/partners/${v.b}/officer`, { user_id: pro.id }, pro.c)).s, 200, 'partner officer has edit on partners');
    assert.strictEqual((await CM('POST', `/partners/${v.b}/officer`, { user_id: pro.id }, fin.c)).s, 403, 'finance has no partners edit');
    const co = await CM('GET', '/overview', undefined, cat.c); assert.ok(co.s === 403 || !co.j.sections.some((s) => s.key === 'rfq'), 'catalogue manager must not see quotation requests');
    assert.strictEqual((await call('GET', '/api/admin/commercial/overview')).s, 401, 'signed out');
    const f = await CM('GET', '/overview', undefined, fin.c); assert.ok(f.s === 200 || f.s === 403);
  });
  await test('partner sales are hidden from someone with no reports or finance permission', async () => {
    const pro2 = await mk('pro2', 'Partner Relationship Officer'); const P = (await CM('GET', '/overview', undefined, pro2.c)).j.sections.find((s) => s.key === 'partners');
    assert.ok(P.rows.every((x) => x.sales === null), 'sales not shown');
  });

  console.log('\nReports');
  await test('partner performance: sales rule, commission, net; money report closed to those without reports/finance', async () => {
    const r = await CM('GET', '/reports/partner-performance'); assert.strictEqual(r.s, 200, r.t); const row = r.j.report.rows.find((x) => x.name === 'Alpha Mart');
    assert.strictEqual(row.sales, 5000); assert.strictEqual(row.commission, 500); assert.strictEqual(row.net, 4500); assert.strictEqual(row.orders, 2); assert.strictEqual(row.units, 5);
    assert.strictEqual(r.j.report.rows.find((x) => x.name === 'Beta Goods').orders, 0); assert.ok(!r.j.report.rows.some((x) => x.name === 'Gamma Pending'));
    const pro = await mk('pro3', 'Partner Relationship Officer'); assert.strictEqual((await CM('GET', '/reports/partner-performance', undefined, pro.c)).s, 403);
    assert.strictEqual((await CM('GET', '/reports/partner-catalogue', undefined, pro.c)).s, 200, 'partners view may read the catalogue report'); assert.strictEqual((await CM('GET', '/reports/employee-performance', undefined, pro.c)).s, 403);
  });
  await test('partner catalogue report counts products by review state', async () => {
    const r = (await CM('GET', '/reports/partner-catalogue')).j.report; const a = r.rows.find((x) => x.name === 'Alpha Mart'), b = r.rows.find((x) => x.name === 'Beta Goods');
    assert.strictEqual(a.total, 2); assert.strictEqual(a.pending, 1); assert.strictEqual(a.approved, 1); assert.strictEqual(b.out_of_stock, 1); assert.strictEqual(r.summary.find((s) => /awaiting/i.test(s.label)).value, 1);
  });
  await test('retail sales by day matches the dashboard rule', async () => {
    const r = (await CM('GET', '/reports/retail-sales')).j.report; assert.strictEqual(r.summary.find((s) => s.label === 'Orders').value, 2); assert.strictEqual(r.summary.find((s) => s.label === 'Revenue').value, 5000);
  });
  await test('employee performance counts recorded changes per person', async () => {
    const e1 = await mk('worker', 'Catalogue Manager'); for (let i = 0; i < 3; i++) assert.strictEqual((await call('POST', '/api/admin/products', { name: 'W' + i, store: 'supermarket', price: 100, stock: 1 }, e1.c)).s, 200);
    await sleep(400); const r = (await CM('GET', '/reports/employee-performance')).j.report; const w = r.rows.find((x) => x.name === 'worker Person'); assert.ok(w && w.actions >= 3 && w.products >= 3, JSON.stringify(w));
    const fin = await mk('fin2', 'Finance Officer'); const f = await CM('GET', '/reports/employee-performance', undefined, fin.c); assert.strictEqual(f.s, 403, 'a reader of reports (finance) cannot see employee activity'); const mg = await mk('mgr', 'Commercial Manager'); const mr = await CM('GET', '/reports/employee-performance', undefined, mg.c); assert.strictEqual(mr.s, 200, 'a commercial manager (Reports: Edit) can see employee performance'); 
  });
  await test('RFQ pipeline report and the quotation section of the workspace', async () => {
    const u = (await q("INSERT INTO users (name,email,phone,password,role,created) VALUES ('Buyer','buyer@example.com','','x','customer',$1) RETURNING id", [T]))[0].id;
    const acc = (await q("INSERT INTO wholesale_accounts (user_id,business_name,evaluate_until,created) VALUES ($1,'Buyer Ltd',$2,$2) RETURNING id", [u, T]))[0].id;
    const off = await mk('rfqoff', 'Wholesale Sales Officer');
    for (const [ref, st, tot] of [['RFQ-T-1', 'submitted', 0], ['RFQ-T-2', 'quote_sent', 50000], ['RFQ-T-3', 'converted', 80000], ['RFQ-T-4', 'draft', 0]]) await q("INSERT INTO rfqs (ref,account_id,company,status,quote_total,created,updated,submitted_at,quoted_at) VALUES ($1,$2,'Buyer Ltd',$3,$4,$5,$5,$5,$6)", [ref, acc, st, tot, T - 100, st === 'submitted' || st === 'draft' ? null : T - 100 + 7200]);
    const w = (await CM('GET', '/overview')).j.sections.find((s) => s.key === 'rfq'); assert.strictEqual(w.counts.unassigned, 1); assert.ok(!w.rows.some((x) => x.ref === 'RFQ-T-4'), 'drafts are not ours to see');
    const as = await A('POST', '/api/admin/rfq/RFQ-T-1/assign', { user_id: off.id }); assert.strictEqual(as.s, 200, as.t);
    assert.strictEqual((await CM('GET', '/overview?officer=' + off.id)).j.sections.find((s) => s.key === 'rfq').rows.length, 1);
    assert.strictEqual((await CM('GET', '/overview?rstatus=converted')).j.sections.find((s) => s.key === 'rfq').rows.length, 1);
    const r = (await CM('GET', '/reports/rfq-pipeline')).j.report; assert.strictEqual(r.summary.find((s) => s.label === 'Requests').value, 3); assert.strictEqual(r.summary.find((s) => s.label === 'Value won').value, 80000); assert.strictEqual(r.summary.find((s) => s.label === 'Average hours to quote').value, 2);
  });
  await test('downloads: Excel and CSV are real files, formulas are neutralised, and the date range is honoured', async () => {
    await q("UPDATE vendors SET name='=HYPERLINK(\"x\")' WHERE id=$1", [v.c]); await q("UPDATE vendors SET status='approved' WHERE id=$1", [v.c]);
    const get_ = async (u) => { const r = await fetch(`http://127.0.0.1:${PORT}${u}`, { headers: { Cookie: admin } }); const buf = Buffer.from(await r.arrayBuffer()); return { s: r.status, h: r.headers, buf, t: buf.toString('utf8') }; };
    const c = await get_('/api/admin/commercial/reports/partner-performance/download?format=csv'); assert.strictEqual(c.s, 200); assert.match(c.h.get('content-type'), /text\/csv/); assert.ok(c.t.charCodeAt(0) === 0xfeff, 'BOM'); assert.ok(c.t.includes("'=HYPERLINK"), 'formula neutralised'); assert.ok(c.t.includes('Alpha Mart'));
    const x = await get_('/api/admin/commercial/reports/partner-catalogue/download?format=xlsx'); assert.strictEqual(x.s, 200); assert.strictEqual(x.buf[0], 0x50); assert.strictEqual(x.buf[1], 0x4b);
    const sh = require('../lib/xlsx').readXlsx(x.buf); assert.ok(JSON.stringify(sh).includes('Alpha Mart'));
    const old = (await CM('GET', '/reports/retail-sales?from=2020-01-01&to=2020-01-31')).j.report; assert.strictEqual(old.rows.length, 0); assert.strictEqual((await CM('GET', '/reports/retail-sales?from=2026-12-31&to=2026-01-01')).s, 400); assert.strictEqual((await CM('GET', '/reports/nope')).s, 404);
  });

  srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.split('\n').slice(-15).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { srv.kill(); } catch { /* */ } process.exit(1); });
