'use strict';
// Employees and roles, the notification centre, and wholesale requests for quotation (RFQ).
// Run with: npm run test:roles   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_roles_' + tag;
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
const stockOf = async (id) => Number((await q('SELECT stock FROM products WHERE id=$1', [id]))[0].stock);
const appBody = (o = {}) => ({ business_name: 'Ada Provisions Ltd', contact_name: 'Ada Obi', phone: '08031234567', address: '5 Trade Fair Road', state: 'Lagos', city: 'Ojo', reg_no: 'RC445566', business_type: 'Retailer', buys: 'Rice, beans and cooking oil for my shops', est_monthly: '₦2m', ...o });

const X = require('../lib/xlsx');

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-roles-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, u, b, admin);
  const ST = (m, u, b) => A(m, '/api/admin/staff' + u, b);
  const emp = {}; // cookies by name
  const roleId = async (name) => (await ST('GET', '')).j.roles.find((r) => r.name === name).id;
  const mkEmp = async (key, roleName, extra = {}) => { const r = await ST('POST', '', { name: key + ' Employee', email: key + '@example.com', username: key + '.user', role_id: await roleId(roleName), ...extra }); assert.strictEqual(r.s, 200, r.t); assert.ok(r.j.temp_password, 'a temporary password is given once'); emp[key] = { id: r.j.id, pw: r.j.temp_password, c: await login(key + '@example.com', r.j.temp_password) }; return r.j; };

  console.log('\nEmployees and roles');
  await test('the standard roles exist, and only the owner can manage staff', async () => {
    const r = await ST('GET', ''); assert.strictEqual(r.s, 200); const names = r.j.roles.map((x) => x.name);
    for (const n of ['Commercial Manager', 'Commercial Officer', 'Sales Representative', 'Partner Relationship Officer', 'Wholesale Sales Officer', 'Catalogue Manager', 'Order Processing Officer', 'Finance Officer']) assert.ok(names.includes(n), n);
    assert.ok(r.j.roles.every((x) => x.builtin && x.perms.length > 0)); assert.strictEqual((await call('GET', '/api/admin/staff')).s, 401);
  });
  await test('create employees; sign in by email or by username; the answer lists what they may use', async () => {
    await mkEmp('sales', 'Sales Representative'); await mkEmp('wsale', 'Wholesale Sales Officer'); await mkEmp('cat', 'Catalogue Manager');
    const byName = await call('POST', '/api/auth/login', { email: 'sales.user', password: emp.sales.pw }); assert.strictEqual(byName.s, 200, byName.t); assert.ok(byName.j.user.perms.includes('orders:edit') && !byName.j.user.perms.includes('catalog:edit')); assert.strictEqual(byName.j.user.staff_role, 'Sales Representative');
    const me = await call('GET', '/api/me', undefined, emp.sales.c); assert.strictEqual(me.j.user.role, 'staff');
    assert.strictEqual((await ST('POST', '', { name: 'Dup', email: 'sales@example.com', role_id: await roleId('Finance Officer') })).s, 409);
    assert.strictEqual((await ST('POST', '', { name: 'Dup2', email: 'dup2@example.com', username: 'sales.user', role_id: await roleId('Finance Officer') })).s, 409);
    assert.strictEqual((await ST('POST', '', { name: 'Weak', email: 'weak@example.com', password: 'abc', role_id: await roleId('Finance Officer') })).s, 400);
    assert.strictEqual((await ST('POST', '', { name: 'NoRole', email: 'norole@example.com' })).s, 400);
  });
  await test('an employee reaches only what their role allows (view versus edit, and never the owner-only areas)', async () => {
    const E = (m, u, b) => call(m, '/api/admin' + u, b, emp.sales.c);
    assert.strictEqual((await E('GET', '/orders')).s, 200); assert.strictEqual((await E('GET', '/products')).s, 200, 'catalog view');
    assert.strictEqual((await E('POST', '/products', { name: 'Nope', store: 'supermarket', price: 5, stock: 1 })).s, 403, 'catalog is view only');
    for (const u of ['/settings', '/audit', '/staff', '/backups']) { const r = await E('GET', u); assert.ok([401, 403, 404].includes(r.s) && r.s !== 200, u + ' ' + r.s); }
    assert.strictEqual((await E('GET', '/rfq')).s, 200, 'rfq is view only for sales'); assert.strictEqual((await E('POST', '/rfq/RFQ-X/assign', {})).s, 403);
    assert.strictEqual((await E('GET', '/dashboard')).s, 200);
    assert.strictEqual((await call('GET', '/api/admin/pharmacy/queue', undefined, emp.sales.c)).s >= 400, true);
    const C = (m, u, b) => call(m, '/api/admin' + u, b, emp.cat.c); assert.strictEqual((await C('GET', '/orders')).s, 403, 'catalogue manager has no orders'); assert.strictEqual((await C('GET', '/products')).s, 200);
  });
  await test('custom permissions replace the role for one person; the change signs them out so nothing stale lingers', async () => {
    const r = await ST('PUT', '/' + emp.sales.id, { perms: ['catalog:edit'] }); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual((await call('GET', '/api/admin/orders', undefined, emp.sales.c)).s, 401, 'old session is gone');
    emp.sales.c = await login('sales@example.com', emp.sales.pw);
    assert.strictEqual((await call('GET', '/api/admin/orders', undefined, emp.sales.c)).s, 403); assert.strictEqual((await call('POST', '/api/admin/products', { name: 'Allowed By Custom', store: 'supermarket', price: 100, stock: 3 }, emp.sales.c)).s, 200);
    assert.strictEqual((await ST('PUT', '/' + emp.sales.id, { perms: ['bogus:edit'] })).s, 400);
    assert.strictEqual((await ST('PUT', '/' + emp.sales.id, { perms: null })).s, 200); emp.sales.c = await login('sales@example.com', emp.sales.pw);
    assert.strictEqual((await call('GET', '/api/admin/orders', undefined, emp.sales.c)).s, 200, 'back to the role');
  });
  await test('custom roles: create, edit, delete rules', async () => {
    const c = await ST('POST', '/roles', { name: 'Night Desk', description: 'x', perms: ['orders:edit', 'delivery:view'] }); assert.strictEqual(c.s, 200, c.t);
    assert.strictEqual((await ST('POST', '/roles', { name: 'Night Desk', perms: [] })).s, 409);
    let list = (await ST('GET', '')).j.roles; assert.ok(list.find((x) => x.id === c.j.id).perms.includes('orders:view'), 'edit includes view');
    const e = await mkEmp('night', 'Night Desk'); assert.strictEqual((await ST('DELETE', '/roles/' + c.j.id)).s, 409, 'in use');
    assert.strictEqual((await ST('DELETE', '/roles/' + (await roleId('Finance Officer')))).s, 400, 'standard roles stay');
    assert.strictEqual((await ST('PUT', '/roles/' + c.j.id, { name: 'Night Desk', perms: ['orders:view'] })).s, 200);
    assert.strictEqual((await ST('PUT', '/' + e.id, { role_id: await roleId('Finance Officer') })).s, 200); assert.strictEqual((await ST('DELETE', '/roles/' + c.j.id)).s, 200);
  });
  await test('switch an account off (signs out at once); reset a password; the last owner cannot be locked out', async () => {
    assert.strictEqual((await ST('PUT', '/' + emp.cat.id, { active: false })).s, 200);
    assert.strictEqual((await call('GET', '/api/admin/products', undefined, emp.cat.c)).s, 401); assert.strictEqual((await call('POST', '/api/auth/login', { email: 'cat@example.com', password: emp.cat.pw })).s, 403);
    assert.strictEqual((await ST('PUT', '/' + emp.cat.id, { active: true })).s, 200);
    const rp = await ST('POST', `/${emp.cat.id}/reset-password`); assert.strictEqual(rp.s, 200); assert.strictEqual((await call('POST', '/api/auth/login', { email: 'cat@example.com', password: emp.cat.pw })).s, 401, 'old password dead');
    emp.cat.pw = rp.j.temp_password; emp.cat.c = await login('cat@example.com', emp.cat.pw);
    const me = (await ST('GET', '')).j.staff.find((s) => s.super); assert.strictEqual((await ST('PUT', '/' + me.id, { active: false })).s, 400);
  });
  await test('sign-in history, activity and a performance summary', async () => {
    const h = (await ST('GET', `/${emp.sales.id}/logins`)).j.logins; assert.ok(h.length >= 2 && h[0].ok); await call('POST', '/api/auth/login', { email: 'sales@example.com', password: 'WrongPassword-123' });
    const h2 = (await ST('GET', `/${emp.sales.id}/logins`)).j.logins; assert.ok(h2.some((x) => !x.ok), 'failed attempts are recorded');
    const act = (await ST('GET', `/${emp.sales.id}/activity`)).j.activity; assert.ok(act.some((a) => /products/.test(a.path)), 'their changes are in the activity log');
    const perf = (await ST('GET', '/performance?days=30')).j.performance; assert.ok(perf.find((p) => p.id === emp.sales.id).actions >= 1);
    const staffRow = (await ST('GET', '')).j.staff.find((s) => s.id === emp.sales.id); assert.ok(staffRow.last_login > 0);
  });

  /* ---------------- RFQ ---------------- */
  console.log('\nRequests for quotation');
  const prods = await q("SELECT id, name, price, stock FROM products WHERE vendor_id IS NULL AND is_pharmacy=0 AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id=products.id) ORDER BY id LIMIT 3");
  assert.ok(prods.length >= 2); await q('UPDATE products SET stock=500 WHERE id = ANY($1)', [prods.map((x) => x.id)]); const [P1, P2] = prods; await q("UPDATE products SET barcode='BC-P1' WHERE id=$1", [P1.id]);
  const mkBuyer = async (key, approve = true) => {
    assert.strictEqual((await call('POST', '/api/auth/register', { name: key + ' Buyer', email: key + '@buyer.com', phone: '0803123' + String(Math.floor(1000 + Math.random() * 8999)), password: PW })).s, 200);
    const c = await login(key + '@buyer.com', PW); assert.strictEqual((await call('POST', '/api/wholesale/apply', { business_name: key + ' Traders', contact_name: key + ' Buyer', phone: '08031234567', address: '5 Trade Road', state: 'Lagos', city: 'Ojo', reg_no: 'RC' + key, business_type: 'Retailer', buys: 'Food items', est_monthly: '₦2m' }, c)).s, 200);
    if (approve) { const id = (await q('SELECT id FROM wholesale_accounts WHERE email=$1 OR business_name=$2', [key + '@buyer.com', key + ' Traders']))[0].id; assert.strictEqual((await A('POST', `/api/admin/wholesale/accounts/${id}/approve`, { early: true })).s, 200); }
    return c;
  };
  const buyer = await mkBuyer('ada'), other = await mkBuyer('bob'), pending = await mkBuyer('eve', false);
  const B = (m, u, b, raw) => call(m, '/api/wholesale/rfq' + u, b, buyer, raw), O = (m, u, b) => call(m, '/api/wholesale/rfq' + u, b, other);
  const AR = (m, u, b) => call(m, '/api/admin/rfq' + u, b, admin);
  const goodItems = () => [{ name: 'Matched rice', qty: 40, barcode: 'BC-P1', brand: 'Acme', packaging: '50kg bag', target_price: '₦30,000' }, { name: 'Smoked mackerel (not in our shop)', qty: 25, description: 'Frozen, 20kg carton' }];
  let ref, ref2, ref3;

  await test('only an approved buyer can ask for a quotation; the lines are checked', async () => {
    assert.strictEqual((await call('GET', '/api/wholesale/rfq')).s, 401); assert.strictEqual((await call('POST', '/api/wholesale/rfq', { items: goodItems() }, pending)).s, 403);
    for (const items of [[], [{ name: '', qty: 3 }], [{ name: 'x', qty: 0 }], [{ name: 'x', qty: 2.5 }], [{ name: 'x', qty: 2, target_price: 'abc' }], Array.from({ length: 201 }, (_, i) => ({ name: 'p' + i, qty: 1 }))]) assert.strictEqual((await B('POST', '', { items })).s, 400, JSON.stringify(items).slice(0, 60));
    assert.strictEqual((await B('POST', '', { items: goodItems(), required_date: 'next week' })).s, 400);
    const r = await B('POST', '', { items: goodItems(), delivery_location: '12 Port Road, Apapa', required_date: '2026-12-20', comments: 'Weekly supply' }); assert.strictEqual(r.s, 200, r.t); ref = r.j.ref; assert.ok(/^RFQ-\d{4}-[A-F0-9]{6}$/.test(ref));
    const d = (await B('GET', '/' + ref)).j.request; assert.strictEqual(d.status, 'draft'); assert.strictEqual(d.items.length, 2); assert.strictEqual(d.items[0].target_price, 30000);
    assert.strictEqual((await B('PUT', '/' + ref, { items: [...goodItems(), { name: 'Added later', qty: 5 }], delivery_location: '12 Port Road, Apapa' })).s, 200);
    assert.strictEqual((await B('GET', '/' + ref)).j.request.items.length, 3); assert.strictEqual((await O('GET', '/' + ref)).s, 404, 'another buyer cannot see it');
  });
  await test('a draft needs a delivery place to submit; submitting matches our barcodes and tells the team', async () => {
    const d = await B('POST', '', { items: [{ name: 'tmp', qty: 1 }] }); assert.strictEqual((await B('POST', `/${d.j.ref}/submit`)).s, 400); assert.strictEqual((await B('DELETE', '/' + d.j.ref)).s, 200);
    assert.strictEqual((await B('PUT', '/' + ref, { items: goodItems(), delivery_location: '12 Port Road, Apapa', required_date: '2026-12-20' })).s, 200);
    assert.strictEqual((await B('POST', `/${ref}/submit`)).s, 200); assert.strictEqual((await B('POST', `/${ref}/submit`)).s, 409);
    assert.strictEqual((await B('PUT', '/' + ref, { items: goodItems() })).s, 409, 'no editing after submitting'); assert.strictEqual((await B('DELETE', '/' + ref)).s, 409);
    const a = (await AR('GET', '/' + ref)).j.request; assert.strictEqual(a.items[0].product_id, Number(P1.id), 'barcode matched our product'); assert.strictEqual(a.items[1].product_id, null);
    const n = (await call('GET', '/api/notifications', undefined, admin)).j; assert.ok(n.notifications.some((x) => x.title.includes(ref)), 'the owner is told'); assert.ok(n.unread >= 1);
    const sb = (await call('GET', '/api/notifications', undefined, buyer)).j; assert.ok(sb.notifications.some((x) => x.title.includes(ref)), 'the buyer gets a receipt');
  });
  await test('the buyer never sees our matches; prices stay hidden until a quotation is sent', async () => {
    const v = (await B('GET', '/' + ref)).j.request; assert.ok(!('product_id' in v.items[0]) && !('match_name' in v.items[0]) && !('unit_price' in v.items[0])); assert.ok(!v.quote); assert.strictEqual(v.status, 'submitted');
    const l = (await B('GET', '')).j; assert.strictEqual(l.summary.total, 1); assert.strictEqual(l.summary.pending, 1);
  });
  await test('the right employee works on it: assignment, status moves, and who may do what', async () => {
    assert.strictEqual((await call('POST', `/api/admin/rfq/${ref}/assign`, { user_id: emp.sales.id }, admin)).s, 400, 'a view-only role cannot be assigned');
    const off = (await AR('GET', '/officers')).j.officers; assert.ok(off.some((o) => o.id === emp.wsale.id) && !off.some((o) => o.id === emp.cat.id));
    assert.strictEqual((await AR('POST', `/${ref}/assign`, { user_id: emp.wsale.id })).s, 200);
    const E = (m, u, b) => call(m, '/api/admin/rfq' + u, b, emp.wsale.c); assert.strictEqual((await E('GET', '/' + ref)).j.request.raw_status, 'received', 'assigning receives it');
    assert.strictEqual((await call('GET', '/api/admin/rfq', undefined, emp.cat.c)).s, 403, 'no RFQ rights');
    const nn = (await call('GET', '/api/notifications', undefined, emp.wsale.c)).j; assert.ok(nn.notifications.some((x) => x.title.includes('assigned to you')));
    assert.strictEqual((await E('POST', `/${ref}/status`, { status: 'quote_sent' })).s, 409, 'cannot jump to sent'); assert.strictEqual((await E('POST', `/${ref}/status`, { status: 'review' })).s, 200); assert.strictEqual((await E('POST', `/${ref}/status`, { status: 'sourcing', note: 'Asking two suppliers' })).s, 200);
    assert.strictEqual((await E('POST', `/${ref}/status`, { status: 'received' })).s, 409, 'cannot go back to received');
    const list = (await E('GET', '?status=sourcing&assigned=' + emp.wsale.id)).j; assert.strictEqual(list.requests.length, 1); assert.ok(list.counts.sourcing >= 1);
    assert.strictEqual((await E('GET', '?q=ada traders')).j.requests.length, 1);
    assert.ok((await B('GET', '/' + ref)).j.request.events.some((e) => e.status === 'sourcing'), 'the buyer sees the progress'); assert.ok((await B('GET', '/' + ref)).j.request.events.every((e) => e.by === ''), 'but not who');
  });
  let lines;
  await test('pricing: totals add up, an unpriced line holds the quotation back, expired quotations cannot be accepted', async () => {
    const E = (m, u, b) => call(m, '/api/admin/rfq' + u, b, emp.wsale.c);
    lines = (await E('GET', '/' + ref)).j.request.items;
    const m = await E('GET', '/match?q=' + encodeURIComponent(P2.name.slice(0, 5))); assert.ok(m.j.products.length >= 1);
    let r = await E('PUT', `/${ref}/quote`, { items: [{ id: lines[0].id, unit_price: 31000 }, { id: lines[1].id, unit_price: null }], logistics_fee: 20000, service_pct: 3 }); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual((await E('GET', '/' + ref)).j.request.raw_status, 'sourcing', 'still not priced'); assert.strictEqual((await E('POST', `/${ref}/send`)).s, 409);
    r = await E('PUT', `/${ref}/quote`, { items: [{ id: lines[0].id, unit_price: 31000 }, { id: lines[1].id, unit_price: 4000, product_id: Number(P2.id) }], logistics_fee: 20000, service_pct: 3, valid_days: 5, quote_note: 'Prices hold for 5 days', shipment_plan: 'Truck from our depot' }); assert.strictEqual(r.s, 200, r.t);
    const q1 = (await E('GET', '/' + ref)).j.request; const goods = 31000 * 40 + 4000 * 25, service = Math.round(goods * 0.03); assert.strictEqual(q1.raw_status, 'quote_prepared'); assert.strictEqual(q1.quote.goods, goods); assert.strictEqual(q1.quote.service, service); assert.strictEqual(q1.quote.total, goods + 20000 + service);
    assert.ok(!('quote' in (await B('GET', '/' + ref)).j.request), 'not visible before it is sent');
    assert.strictEqual((await E('PUT', `/${ref}/quote`, { items: [{ id: 999999999, unit_price: 1 }] })).s, 400, 'a line from elsewhere');
    assert.strictEqual((await E('POST', `/${ref}/send`)).s, 200);
    const bv = (await B('GET', '/' + ref)).j.request; assert.strictEqual(bv.status, 'quote_sent'); assert.strictEqual(bv.quote.total, goods + 20000 + service); assert.strictEqual(bv.items[0].line_total, 31000 * 40); assert.ok(!('product_id' in bv.items[0]));
    assert.ok((await call('GET', '/api/notifications', undefined, buyer)).j.notifications.some((x) => /quotation .* ready/i.test(x.title)));
    await q("UPDATE rfqs SET quote_valid_until=$1 WHERE ref=$2", [Math.floor(Date.now() / 1000) - 10, ref]);
    assert.strictEqual((await B('GET', '/' + ref)).j.request.status, 'expired'); assert.strictEqual((await B('POST', `/${ref}/accept`)).s, 410);
    await q("UPDATE rfqs SET quote_valid_until=$1 WHERE ref=$2", [Math.floor(Date.now() / 1000) + 86400, ref]);
  });
  await test('the buyer accepts; our team cannot convert until every line is a real product with stock; converting makes a normal wholesale order', async () => {
    assert.strictEqual((await O('POST', `/${ref}/accept`)).s, 404, 'not theirs'); assert.strictEqual((await B('POST', `/${ref}/accept`)).s, 200); assert.strictEqual((await B('POST', `/${ref}/accept`)).s, 409);
    const E = (m, u, b) => call(m, '/api/admin/rfq' + u, b, emp.wsale.c);
    await q('UPDATE rfq_items SET product_id=NULL WHERE id=$1', [lines[1].id]); let c = await E('POST', `/${ref}/convert`); assert.strictEqual(c.s, 409); assert.ok(/not matched/.test(c.j.error), c.t);
    await q('UPDATE rfq_items SET product_id=$1 WHERE id=$2', [P2.id, lines[1].id]);
    const before = Number((await q('SELECT stock FROM products WHERE id=$1', [P1.id]))[0].stock);
    c = await E('POST', `/${ref}/convert`); assert.strictEqual(c.s, 200, c.t); const sref = c.j.sales_ref; assert.ok(/^WQ-/.test(sref));
    const wq = (await q('SELECT status, total, goods_total FROM wholesale_quotes WHERE ref=$1', [sref]))[0]; assert.strictEqual(wq.status, 'accepted'); assert.strictEqual(Number(wq.total), (await E('GET', '/' + ref)).j.request.quote.total);
    assert.strictEqual(Number((await q('SELECT stock FROM products WHERE id=$1', [P1.id]))[0].stock), before - 40, 'goods are set aside'); assert.strictEqual((await E('POST', `/${ref}/convert`)).s, 409, 'only once');
    assert.strictEqual((await B('GET', '/' + ref)).j.request.sales_ref, sref); assert.strictEqual((await B('GET', '/' + ref)).j.request.status, 'converted');
    const W = (m, u, b) => A(m, '/api/admin/wholesale' + u, b);
    assert.strictEqual((await W('POST', `/quotes/${sref}/transfer`, { reference: 'GTB-RFQ-1' })).s, 200); assert.strictEqual((await W('POST', `/quotes/${sref}/ship`, { carrier: 'Our truck' })).s, 200); assert.strictEqual((await W('POST', `/quotes/${sref}/deliver`, {})).s, 200);
    assert.strictEqual((await B('GET', '/' + ref)).j.request.status, 'completed', 'delivery completes the request');
  });
  await test('declined and rejected requests: a reason is needed either way', async () => {
    const mk = async () => { const r = (await B('POST', '', { items: goodItems(), delivery_location: 'Apapa' })).j.ref; await B('POST', `/${r}/submit`); return r; };
    ref2 = await mk(); assert.strictEqual((await AR('POST', `/${ref2}/status`, { status: 'rejected' })).s, 400); assert.strictEqual((await AR('POST', `/${ref2}/status`, { status: 'rejected', note: 'We do not supply frozen fish' })).s, 200);
    assert.strictEqual((await B('GET', '/' + ref2)).j.request.reject_reason, 'We do not supply frozen fish'); assert.strictEqual((await B('GET', '')).j.summary.rejected, 1);
    ref3 = await mk(); await AR('POST', `/${ref3}/assign`, { user_id: emp.wsale.id }); const l3 = (await AR('GET', '/' + ref3)).j.request.items;
    assert.strictEqual((await AR('PUT', `/${ref3}/quote`, { items: l3.map((i) => ({ id: i.id, unit_price: 100 })) })).s, 200); assert.strictEqual((await AR('POST', `/${ref3}/send`)).s, 200);
    assert.strictEqual((await B('POST', `/${ref3}/decline`, {})).s, 400); assert.strictEqual((await B('POST', `/${ref3}/decline`, { reason: 'Too expensive' })).s, 200);
    assert.strictEqual((await B('GET', '/' + ref3)).j.request.status, 'rejected'); assert.ok((await call('GET', '/api/notifications', undefined, admin)).j.notifications.some((x) => /declined/.test(x.title)));
  });
  await test('attachments: real documents only, kept private to the buyer and our team', async () => {
    const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF').toString('base64');
    const d = (await B('POST', '', { items: goodItems(), delivery_location: 'Apapa' })).j.ref;
    const up = await B('POST', `/${d}/files`, { name: 'spec sheet.pdf', data: pdf }); assert.strictEqual(up.s, 200, up.t);
    assert.strictEqual((await B('POST', `/${d}/files`, { name: 'virus.exe', data: pdf })).s, 400); assert.strictEqual((await B('POST', `/${d}/files`, { name: 'fake.pdf', data: 'data:application/pdf;base64,' + Buffer.from('not a pdf at all').toString('base64') })).s, 400);
    assert.strictEqual((await B('POST', `/${d}/files`, { name: 'big.pdf', data: 'data:application/pdf;base64,' + Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5.5 * 1024 * 1024)]).toString('base64') })).s, 400, 'over 5 MB');
    const got = await B('GET', `/${d}/files/${up.j.id}`); assert.strictEqual(got.s, 200); assert.ok(got.buf.slice(0, 4).toString() === '%PDF'); assert.strictEqual(got.h.get('x-content-type-options'), 'nosniff');
    assert.strictEqual((await O('GET', `/${d}/files/${up.j.id}`)).s, 404);
    assert.strictEqual((await B('DELETE', `/${d}/files/${up.j.id}`)).s, 200); await B('DELETE', '/' + d);
  });
  await test('Excel in and out: template, upload parse with clear errors, and a download of the request', async () => {
    const t = await B('GET', '/template.xlsx'); assert.strictEqual(t.s, 200); const rows = X.readSheet(t.buf, 'x.xlsx'); assert.deepStrictEqual(rows[0].slice(0, 4), ['Product Name', 'Description', 'Barcode / Code', 'Quantity']);
    const sheet = Buffer.from(X.writeXlsx([{ name: 'r', rows: [['Product Name', 'Quantity', 'Target Price', 'Preferred Brand'], ['Tomato paste 400g', '300', '650', 'Gino'], ['Evaporated milk', '120', '', ''], ['', '', '', '']] }]));
    const p = await B('POST', '/parse?filename=r.xlsx', undefined, sheet); assert.strictEqual(p.s, 200, p.t); assert.strictEqual(p.j.items.length, 2); assert.strictEqual(p.j.items[0].qty, '300'); assert.strictEqual(p.j.items[0].brand, 'Gino');
    const bad = Buffer.from(X.writeXlsx([{ name: 'r', rows: [['Thing', 'How many'], ['a', '1']] }])); const pb = await B('POST', '/parse?filename=r.xlsx', undefined, bad); assert.strictEqual(pb.s, 400); assert.ok(/Product Name/.test(pb.j.error));
    assert.strictEqual((await call('POST', '/api/wholesale/rfq/parse', undefined, pending, sheet)).s, 403);
    const dl = await B('GET', `/${ref}/download.xlsx`); assert.strictEqual(dl.s, 200); const dr = X.readSheet(dl.buf, 'x.xlsx'); assert.ok(dr.some((r) => r.includes('Quoted Unit Price')), 'prices included once quoted'); assert.strictEqual((await O('GET', `/${ref}/download.xlsx`)).s, 404);
  });

  /* ---------------- notifications ---------------- */
  console.log('\nNotification centre');
  await test('everyone sees only their own notifications; read, read-all, and paging work', async () => {
    const n = (await call('GET', '/api/notifications', undefined, buyer)).j; assert.ok(n.notifications.length >= 3 && n.unread >= 3); const one = n.notifications[0];
    assert.strictEqual((await call('POST', '/api/notifications/read', { id: one.id }, other)).s, 200); assert.strictEqual((await call('GET', '/api/notifications/count', undefined, buyer)).j.unread, n.unread, 'someone else cannot mark mine');
    assert.strictEqual((await call('POST', '/api/notifications/read', { id: one.id }, buyer)).j.unread, n.unread - 1);
    assert.strictEqual((await call('POST', '/api/notifications/read', { all: true }, buyer)).j.unread, 0); const pg1 = (await call('GET', '/api/notifications?limit=2', undefined, buyer)).j; assert.strictEqual(pg1.notifications.length, 2); assert.ok(pg1.more);
    const pg2 = (await call('GET', `/api/notifications?limit=2&before=${pg1.notifications[1].id}`, undefined, buyer)).j; assert.ok(pg2.notifications.every((x) => x.id < pg1.notifications[1].id)); assert.strictEqual((await call('GET', '/api/notifications')).s, 401);
  });
  await test('announcements reach only the chosen group; order events notify the customer and partner stores', async () => {
    const a = await call('POST', '/api/admin/announce', { audience: 'wholesale', title: 'Price list updated', body: 'New wholesale prices from Monday.' }, admin); assert.strictEqual(a.s, 200, a.t); assert.ok(a.j.sent >= 2);
    assert.ok((await call('GET', '/api/notifications', undefined, buyer)).j.notifications.some((x) => x.title === 'Price list updated')); assert.ok(!(await call('GET', '/api/notifications', undefined, emp.cat.c)).j.notifications.some((x) => x.title === 'Price list updated'));
    assert.strictEqual((await call('POST', '/api/admin/announce', { audience: 'everyone', title: 'x' }, admin)).s, 400); assert.strictEqual((await call('POST', '/api/admin/announce', { audience: 'staff', title: 'x' }, emp.cat.c)).s, 403, 'marketing permission needed');
  });

  srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.split('\n').slice(-15).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { srv.kill(); } catch { /* */ } process.exit(1); });
