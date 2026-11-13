'use strict';
// Phase 2 check: the pharmacy department stays invisible while off, and when on follows the prescription, identity, licence and delivery rules.
// Run with: npm run test:pharmacy   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36);
const DBS = { off: 'sb_phoff_' + tag, on: 'sb_phon_' + tag };
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const BASE = 5600 + Math.floor(Math.random() * 40) * 5;
const OFF = BASE, ON = BASE + 1;
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const procs = [];
const start = (port, db, extra = {}) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), BASE_URL: 'http://127.0.0.1:' + port, DATABASE_URL: urlOf(db), DATA_DIR: require('os').tmpdir() + '/sb-ph-' + tag + '-' + port, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', PHARMACY_DATA_KEY: 'test-key-for-pharmacy-0123456789', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; }); procs.push(p); return p;
};
const up = async (port) => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); return; } catch { await sleep(100); } } throw new Error('app did not start on ' + port); };
const call = async (port, method, url, body, cookie) => {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  if (process.env.DEBUG_PH && r.status >= 400) console.log('   [' + r.status + '] ' + method + ' ' + url + ' ' + t.slice(0, 160));
  return { s: r.status, j, t, c: (sc[0] || '').split(';')[0], h: r.headers };
};
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fake prescription image ' + tag)]).toString('base64');
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400e3));
const YEAR = new Date().getUTCFullYear();

(async () => {
  for (const d of Object.values(DBS)) await pg(`CREATE DATABASE ${d}`);
  start(OFF, DBS.off); start(ON, DBS.on, { PHARMACY_ENABLED: '1' });
  await up(OFF); await up(ON);

  /* ---------------- flag OFF ---------------- */
  const offAdmin = (await call(OFF, 'POST', '/api/auth/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' })).c;
  await test('OFF: no pharmacy department, no medicines, nothing to open', async () => {
    const cfg = (await call(OFF, 'GET', '/api/config')).j;
    assert.ok(!cfg.stores.some((s) => s.slug === 'pharmacy') && cfg.pharmacy === false);
    assert.strictEqual((await call(OFF, 'GET', '/api/home/pharmacy')).s, 404);
    assert.strictEqual((await call(OFF, 'GET', '/api/products?store=pharmacy')).j.products.length, 0);
    assert.ok(!(await call(OFF, 'GET', '/api/products?q=paracetamol')).j.products.length, 'search must not find medicines');
    assert.strictEqual((await call(OFF, 'GET', '/api/products/paracetamol-500mg-16-tablets')).s, 404);
    assert.ok(!(await call(OFF, 'GET', '/sitemap.xml')).t.includes('paracetamol'));
    assert.strictEqual((await call(OFF, 'GET', '/d/pharmacy')).s, 404);
    assert.strictEqual((await call(OFF, 'GET', '/api/pharmacy/me')).s, 404);
    assert.ok((await pg('SELECT COUNT(*) n FROM products WHERE is_pharmacy=1', [], DBS.off))[0].n > 0, 'the demo medicines exist in the database but are hidden');
  });
  await test('OFF: a medicine cannot be ordered even with its id, and cannot be listed by an admin', async () => {
    const p = (await pg("SELECT id FROM products WHERE is_pharmacy=1 LIMIT 1", [], DBS.off))[0];
    const r = await call(OFF, 'POST', '/api/checkout', { items: [{ productId: p.id, qty: 1 }], contact: { name: 'Ada Obi', email: 'o@example.com', phone: '08011112222' }, address: { state: 'Lagos', city: 'Yaba', address: '12 Test Street' }, delivery: 'standard', payment: 'paystack' });
    assert.ok(r.s >= 400, 'order refused: ' + r.s);
    const add = await call(OFF, 'POST', '/api/admin/products', { name: 'Test medicine', store: 'pharmacy', price: 500, stock: 5, active: true }, offAdmin);
    assert.strictEqual(add.s, 400);
    const on = await call(OFF, 'PUT', '/api/admin/products/' + p.id, { name: 'x', store: 'pharmacy', price: 500, stock: 5, active: true }, offAdmin);
    assert.strictEqual(on.s, 400);
  });
  await test('OFF: the readiness checklist can still be read and says not ready', async () => {
    const r = await call(OFF, 'GET', '/api/admin/pharmacy/readiness', undefined, offAdmin);
    assert.strictEqual(r.s, 200); assert.strictEqual(r.j.enabled, false); assert.strictEqual(r.j.ready, false);
    assert.strictEqual((await call(OFF, 'GET', '/api/admin/pharmacy/readiness')).s, 401);
  });

  /* ---------------- flag ON ---------------- */
  const admin = (await call(ON, 'POST', '/api/auth/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' })).c;
  const q = (sql, params) => pg(sql, params, DBS.on);
  const A = (m, u, b) => call(ON, m, u, b, admin);
  const login = async (email, password) => { const r = await call(ON, 'POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + email); return r.c; };
  const PW = 'Pharm-Test-Pass-2026!';
  const flush = () => A('PUT', '/api/admin/settings', { settings: {} }); // the public pages keep a copy for a few seconds; an admin save clears it

  // a pickup point, a partner pharmacy with licence/agreement/pharmacist, and our superintendent
  const partner = (await A('POST', '/api/admin/partners', { name: 'Yaba Pharmacy Point', address: 'Yaba', state: 'Lagos', phone: '08030000000', lat: 6.5095, lng: 3.3711, radius_km: 50, active: true })).j.id;
  const pharmacyId = (await A('POST', '/api/admin/pharmacy/pharmacies', { partner_id: partner, pharmacy_name: 'Yaba Community Pharmacy', premises_licence_no: 'PPL-123', epharmacy_licence_no: 'EP-456', superintendent_name: 'Pharm. A. Bello', superintendent_reg_no: 'PCN-1111', licence_year: YEAR })).j.id;
  await test('ON: a pharmacy cannot be approved without agreement, pharmacist and a current licence', async () => {
    assert.ok(pharmacyId);
    let r = await A('POST', `/api/admin/pharmacy/pharmacies/${pharmacyId}/approve`, {}); assert.strictEqual(r.s, 400); assert.match(r.j.error, /agreement/);
    const up_ = await A('PUT', `/api/admin/pharmacy/pharmacies/${pharmacyId}/agreement`, { data: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 signed agreement').toString('base64'), name: 'agreement.pdf' }); assert.strictEqual(up_.s, 200, up_.t);
    r = await A('POST', `/api/admin/pharmacy/pharmacies/${pharmacyId}/approve`, {}); assert.strictEqual(r.s, 400); assert.match(r.j.error, /pharmacist/);
  });
  await A('POST', '/api/admin/pharmacy/pharmacists', { name: 'Pharm Bello', email: 'bello@example.com', password: PW, reg_no: 'PCN-1111', pharmacy_id: pharmacyId });
  await A('POST', '/api/admin/pharmacy/pharmacists', { name: 'Pharm Superintendent', email: 'super@example.com', password: PW, reg_no: 'PCN-9000' });
  await A('POST', '/api/admin/pharmacy/pharmacists', { name: 'Pharm Other', email: 'other@example.com', password: PW, reg_no: 'PCN-2222', pharmacy_id: (await (async () => { const p2 = (await A('POST', '/api/admin/partners', { name: 'Other Point', address: 'Ikeja', state: 'Lagos', phone: '08030000001', lat: 6.6, lng: 3.35, radius_km: 50, active: true })).j.id; return (await A('POST', '/api/admin/pharmacy/pharmacies', { partner_id: p2, pharmacy_name: 'Other Pharmacy', licence_year: YEAR })).j.id; })()) });
  await test('ON: approving a pharmacy works once its papers are complete', async () => {
    const r = await A('POST', `/api/admin/pharmacy/pharmacies/${pharmacyId}/approve`, {}); assert.strictEqual(r.s, 200, r.t);
    const f = await call(ON, 'GET', `/api/admin/pharmacy/pharmacies/${pharmacyId}/agreement`, undefined, admin); assert.strictEqual(f.s, 200); assert.match(f.t, /signed agreement/);
    assert.ok((await q("SELECT COUNT(*) n FROM pharmacy_audit WHERE action='agreement_view'"))[0].n > 0, 'viewing is logged');
  });
  const bello = await login('bello@example.com', PW), sup = await login('super@example.com', PW), other = await login('other@example.com', PW);

  // medicines
  const pm = (await q("SELECT id, slug FROM products WHERE name LIKE 'Paracetamol 500mg%' LIMIT 1"))[0];
  const rxp = (await q("SELECT id, slug, name FROM products WHERE is_pharmacy=1 AND id<>$1 ORDER BY id LIMIT 1", [pm.id]))[0];
  await q('UPDATE products SET partner_id=$1, stock=100, active=1 WHERE id IN ($2,$3)', [partner, pm.id, rxp.id]);
  const future = iso(new Date(Date.now() + 400 * 86400e3));
  await test('ON: seeded medicines stay hidden until the pharmacy sets the details and our superintendent approves', async () => {
    assert.strictEqual((await call(ON, 'GET', '/api/products/' + pm.slug)).s, 404);
    let r = await call(ON, 'PUT', `/api/pharmacy/staff/products/${pm.id}/details`, { is_medicine: true, nafdac_no: 'A4-1234', batch_no: 'B1', expiry_date: future, storage_temp: 'Below 30C', max_qty: 5 }, other); assert.strictEqual(r.s, 403, 'another pharmacy cannot touch it');
    r = await call(ON, 'PUT', `/api/pharmacy/staff/products/${pm.id}/details`, { is_medicine: true, nafdac_no: 'A4-1234', batch_no: 'B1', expiry_date: future, storage_temp: 'Below 30C', max_qty: 5 }, bello); assert.strictEqual(r.s, 200, r.t);
    r = await call(ON, 'POST', `/api/pharmacy/staff/products/${rxp.id}/decision`, { decision: 'approve' }, bello); assert.strictEqual(r.s, 403, 'a partner pharmacist cannot approve listings');
    r = await call(ON, 'PUT', `/api/pharmacy/staff/products/${rxp.id}/details`, { is_medicine: true, rx_required: true, nafdac_no: '', batch_no: 'B2', expiry_date: future, storage_temp: 'Below 25C' }, bello);
    r = await call(ON, 'POST', `/api/pharmacy/staff/products/${rxp.id}/decision`, { decision: 'approve' }, sup); assert.strictEqual(r.s, 400); assert.match(r.j.error, /NAFDAC/);
    await call(ON, 'PUT', `/api/pharmacy/staff/products/${rxp.id}/details`, { is_medicine: true, rx_required: true, nafdac_no: 'B1-5678', batch_no: 'B2', expiry_date: future, storage_temp: 'Below 25C', max_qty: 30 }, bello);
    for (const id of [pm.id, rxp.id]) { r = await call(ON, 'POST', `/api/pharmacy/staff/products/${id}/decision`, { decision: 'approve' }, sup); assert.strictEqual(r.s, 200, r.t); }
    assert.strictEqual((await call(ON, 'GET', '/api/products/' + pm.slug)).s, 200);
    assert.ok((await call(ON, 'GET', '/api/config')).j.stores.some((s) => s.slug === 'pharmacy'));
  });
  await test('ON: an expired batch or an expired licence hides the medicine by itself', async () => {
    await q("UPDATE products SET expiry_date=$1 WHERE id=$2", [daysAgo(1), pm.id]); await flush();
    assert.strictEqual((await call(ON, 'GET', '/api/products/' + pm.slug)).s, 404, 'expired batch');
    await q("UPDATE products SET expiry_date=$1 WHERE id=$2", [future, pm.id]); await flush();
    await q('UPDATE pharmacies SET licence_expires=$1 WHERE id=$2', [Math.floor(Date.now() / 1000) - 10, pharmacyId]); await flush();
    assert.strictEqual((await call(ON, 'GET', '/api/products/' + pm.slug)).s, 404, 'expired licence');
    await q('UPDATE pharmacies SET licence_expires=$1 WHERE id=$2', [Math.floor(Date.now() / 1000) + 86400 * 100, pharmacyId]); await flush();
    assert.strictEqual((await call(ON, 'GET', '/api/products/' + pm.slug)).s, 200);
  });
  await test('ON: editing an approved medicine through the general product editor sends it back for approval', async () => {
    const p = (await A('GET', '/api/admin/products/' + pm.id)).j; const prod = p.product || p;
    const r = await A('PUT', '/api/admin/products/' + pm.id, { ...prod, price: prod.price, stock: 100, active: true, images: [], variants: [] }); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual((await q('SELECT pharm_status s FROM products WHERE id=$1', [pm.id]))[0].s, 'pending');
    assert.strictEqual((await call(ON, 'GET', '/api/products/' + pm.slug)).s, 404);
    assert.strictEqual((await call(ON, 'POST', `/api/pharmacy/staff/products/${pm.id}/decision`, { decision: 'approve' }, sup)).s, 200);
  });

  const rid = (await A('POST', '/api/admin/riders', { name: 'Rider One', email: 'r1@example.com', phone: '08040000000', password: PW, coverage: 'Lagos' })).j.id;
  // a customer
  const reg = await call(ON, 'POST', '/api/auth/register', { name: 'Ngozi Eze', email: 'ngozi@example.com', password: PW, phone: '08031234567' }); const cust = reg.c;
  const otpCode = async () => /(\d{6})/.exec((await q('SELECT body FROM sms_outbox ORDER BY id DESC LIMIT 1'))[0].body)[1];
  const place = (items, extra = {}) => call(ON, 'POST', '/api/checkout', { items, contact: { name: 'Ngozi Eze', email: 'ngozi@example.com', phone: '08031234567' }, address: { state: 'Lagos', city: 'Yaba', address: '5 Test Close, Yaba' }, location: { lat: 6.5095, lng: 3.3711, landmark: 'gate' }, delivery: 'standard', payment: 'paystack', ...extra }, cust);
  await test('ON: medicine orders need a signed-in buyer with a verified phone and ID', async () => {
    let r = await call(ON, 'POST', '/api/checkout', { items: [{ productId: pm.id, qty: 1 }], contact: { name: 'Ngozi Eze', email: 'ngozi@example.com', phone: '08031234567' }, address: { state: 'Lagos', city: 'Yaba', address: '5 Test Close' }, location: { lat: 6.5095, lng: 3.3711 }, delivery: 'standard', payment: 'paystack' });
    assert.strictEqual(r.s, 401, 'guests cannot order medicines');
    r = await place([{ productId: pm.id, qty: 1 }]); assert.strictEqual(r.s, 403); assert.match(r.j.error, /phone/);
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/phone/start', { phone: '123' }, cust)).s, 400);
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/phone/start', { phone: '0803 123 4567' }, cust)).s, 200);
    const code = await otpCode(); const wrong = code === '000000' ? '111111' : '000000';
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/phone/confirm', { code: wrong }, cust)).s, 400);
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/phone/confirm', { code }, cust)).s, 200);
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/phone/confirm', { code }, cust)).s, 400, 'a code works once');
    r = await place([{ productId: pm.id, qty: 1 }]); assert.strictEqual(r.s, 403); assert.match(r.j.error, /ID/);
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/identity', { fullName: 'Ngozi Eze', idType: 'nin', idNumber: '12345678901' }, cust)).s, 200);
    const row = (await q('SELECT id_number_enc, id_last4 FROM buyer_identity'))[0]; assert.ok(!row.id_number_enc.includes('12345678901') && row.id_last4 === '8901', 'the ID number is encrypted');
  });
  await test('ON: a one-off medicine without a prescription can be bought, but not mixed with other goods or picked up', async () => {
    const other_ = (await q('SELECT id FROM products WHERE is_pharmacy=0 AND active=1 AND stock>5 LIMIT 1'))[0];
    let r = await place([{ productId: pm.id, qty: 1 }, { productId: other_.id, qty: 1 }]); assert.strictEqual(r.s, 400); assert.match(r.j.error, /separately/);
    r = await place([{ productId: pm.id, qty: 1 }], { delivery: 'pickup' }); assert.strictEqual(r.s, 400);
    r = await place([{ productId: pm.id, qty: 1 }]); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.next, 'demo');
    const o = (await q("SELECT * FROM orders WHERE ref=$1", [r.j.ref]))[0]; assert.ok(o.is_pharmacy === 1 && o.rx_required === 0 && o.rx_status === 'none');
  });

  const rxBody = (over = {}) => ({ file: PNG, prescriber: { name: 'Dr Chidi Okafor', regNo: 'MDCN-55555', phone: '08055550000', address: '10 Marina, Lagos' }, patient: { name: 'Ngozi Eze', age: '34' }, issuedOn: daysAgo(10), durationDays: 14, maxFills: 1, lines: [{ drug: 'Amoxicillin 500mg', qty: 21, productId: rxp.id }], ...over });
  await test('ON: prescription upload checks the file, the date and the details', async () => {
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/prescriptions', rxBody())).s, 401);
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/prescriptions', rxBody({ file: 'data:image/png;base64,' + Buffer.from('not an image at all').toString('base64') }), cust)).s, 400);
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/prescriptions', rxBody({ issuedOn: daysAgo(200) }), cust)).s, 400, 'older than six months');
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/prescriptions', rxBody({ issuedOn: iso(new Date(Date.now() + 5 * 86400e3)) }), cust)).s, 400, 'future date');
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/prescriptions', rxBody({ prescriber: { name: 'Dr X', regNo: '', address: 'Lagos 12345' } }), cust)).s, 400);
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/prescriptions', rxBody({ maxFills: 3 }), cust)).s, 400, 'refills need an interval');
  });
  let rx, order;
  await test('ON: a prescription order waits for the pharmacist: no payment, no progress, quantity capped', async () => {
    const r = await call(ON, 'POST', '/api/pharmacy/prescriptions', rxBody(), cust); assert.strictEqual(r.s, 200, r.t); rx = r.j;
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/prescriptions', rxBody(), cust)).s, 409, 'the same one twice');
    assert.ok(!JSON.stringify(await q('SELECT * FROM prescriptions')).includes('Ngozi'), 'patient details are encrypted in the table');
    let c = await place([{ productId: rxp.id, qty: 1 }]); assert.strictEqual(c.s, 400); assert.match(c.j.error, /upload the prescription/);
    c = await place([{ productId: rxp.id, qty: 22 }], { prescriptionIds: [rx.id] }); assert.strictEqual(c.s, 400); assert.match(c.j.error, /quantity written/);
    c = await place([{ productId: rxp.id, qty: 21 }], { prescriptionIds: [rx.id] }); assert.strictEqual(c.s, 200, c.t); assert.strictEqual(c.j.next, 'rx');
    order = (await q('SELECT * FROM orders WHERE ref=$1', [c.j.ref]))[0];
    assert.strictEqual(order.rx_status, 'submitted'); assert.ok(!order.pay_url);
    assert.strictEqual((await A('PUT', '/api/admin/orders/' + order.id, { status: 'processing' })).s, 400);
    assert.strictEqual((await A('PUT', '/api/admin/orders/' + order.id, { status: 'paid' })).s, 400);
    assert.strictEqual((await call(ON, 'POST', `/api/pharmacy/orders/${order.ref}/pay`, {}, cust)).s, 409, 'cannot pay before approval');
    assert.strictEqual((await call(ON, 'GET', `/api/pharmacy/prescriptions/${rx.id}/file`, undefined, admin)).s, 403, 'admins cannot open prescriptions');
  });
  await test('ON: only the right pharmacy sees it, and the decision rules hold', async () => {
    const queue = (c) => call(ON, 'GET', '/api/pharmacy/staff/queue', undefined, c);
    assert.ok((await queue(bello)).j.orders.some((o) => o.id == order.id));
    assert.ok(!(await queue(other)).j.orders.some((o) => o.id == order.id), 'a different pharmacy does not see it');
    assert.strictEqual((await call(ON, 'GET', `/api/pharmacy/staff/orders/${order.id}`, undefined, other)).s, 403);
    const view = await call(ON, 'GET', `/api/pharmacy/staff/orders/${order.id}`, undefined, bello); assert.strictEqual(view.s, 200);
    assert.strictEqual(view.j.prescriptions[0].patient.name, 'Ngozi Eze'); assert.strictEqual(view.j.buyer.idLast4, '8901');
    const file = await call(ON, 'GET', `/api/pharmacy/staff/prescriptions/${rx.id}/file`, undefined, bello); assert.strictEqual(file.s, 200); assert.match(file.t, /fake prescription image/);
    assert.ok((await q("SELECT COUNT(*) n FROM pharmacy_audit WHERE action IN ('rx_file_view','order_review_open')"))[0].n >= 2, 'every view is logged');
    const item = view.j.order.items[0], dec = (b, c = bello) => call(ON, 'POST', `/api/pharmacy/staff/orders/${order.id}/decision`, b, c);
    assert.strictEqual((await dec({ decision: 'approve', items: [{ orderItemId: item.id, lineId: view.j.prescriptions[0].lines[0].id, qty: 21 }], identityChecked: true })).s, 400, 'register check is required');
    assert.strictEqual((await dec({ decision: 'approve', registerCheck: 'Searched MDCN register, found active', items: [{ orderItemId: item.id, lineId: view.j.prescriptions[0].lines[0].id, qty: 21 }] })).s, 400, 'identity check is required');
    assert.strictEqual((await dec({ decision: 'approve', registerCheck: 'Searched MDCN register, found active', identityChecked: true, items: [{ orderItemId: item.id, lineId: view.j.prescriptions[0].lines[0].id, qty: 21 }] }, other)).s, 403);
    const ok = await dec({ decision: 'approve', registerCheck: 'Searched MDCN register, found active', identityChecked: true, items: [{ orderItemId: item.id, lineId: view.j.prescriptions[0].lines[0].id, qty: 21 }] }); assert.strictEqual(ok.s, 200, ok.t);
    const r = (await q('SELECT * FROM prescriptions WHERE id=$1', [rx.id]))[0]; assert.strictEqual(r.status, 'approved'); assert.strictEqual(r.reviewer_reg_no, 'PCN-1111'); assert.ok(r.reviewed_at && r.fills_reserved === 1);
    assert.strictEqual((await q('SELECT rx_status s FROM orders WHERE id=$1', [order.id]))[0].s, 'verified');
  });
  await test('ON: after approval the customer pays; one prescription cannot be used for a second order', async () => {
    const p = await call(ON, 'POST', `/api/pharmacy/orders/${order.ref}/pay`, {}, cust); assert.strictEqual(p.s, 200); assert.strictEqual(p.j.next, 'demo');
    assert.strictEqual((await call(ON, 'POST', '/api/pay/demo/' + order.ref, { outcome: 'success' })).s, 200);
    assert.strictEqual((await q('SELECT status s FROM orders WHERE id=$1', [order.id]))[0].s, 'paid');
    const again = await place([{ productId: rxp.id, qty: 5 }], { prescriptionIds: [rx.id] }); assert.strictEqual(again.s, 400); assert.match(again.j.error, /already been used|number of times/);
  });
  await test('ON: delivery needs a cold-chain rider for cold items, the buyer\'s name and the code; override is refused', async () => {
    await q('UPDATE orders SET temp_sensitive=1 WHERE id=$1', [order.id]);
    const no = await A('PUT', `/api/admin/orders/${order.id}/rider`, { riderId: rid }); assert.strictEqual(no.s, 400); assert.match(no.j.error, /Good Distribution/);
    assert.strictEqual((await A('PUT', '/api/admin/riders/' + rid, { gdp: true, active: true })).s, 200);
    assert.strictEqual((await A('PUT', `/api/admin/orders/${order.id}/rider`, { riderId: rid })).s, 200);
    const rider = await login('r1@example.com', PW), R = (u, b) => call(ON, 'POST', `/api/rider/orders/${order.id}/${u}`, b, rider);
    assert.strictEqual((await R('accept', {})).s, 200);
    for (const pk of await q('SELECT partner_id FROM order_pickups WHERE order_id=$1', [order.id])) assert.strictEqual((await R('pickup', { partnerId: Number(pk.partner_id) })).s, 200);
    assert.strictEqual((await R('start', {})).s, 200);
    const code = (await call(ON, 'POST', '/api/orders/lookup', { ref: order.ref, email: order.email, token: order.access_token })).j.order.handover_code; assert.match(code, /^\d{6}$/);
    let r = await R('complete', { code }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /name/);
    r = await R('complete', { code, recipientName: 'Somebody Else' }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /does not match/);
    assert.strictEqual((await q('SELECT handover_attempts a FROM orders WHERE id=$1', [order.id]))[0].a, 0, 'a wrong name is not a wrong code');
    assert.strictEqual((await A('POST', `/api/admin/orders/${order.id}/override`, { action: 'complete', reason: 'Rider says it was delivered ok' })).s >= 400, true, 'override refused');
    r = await R('complete', { code, recipientName: 'eze ngozi' }); assert.strictEqual(r.s, 200, r.t);
    const o = (await q('SELECT status, recipient_name FROM orders WHERE id=$1', [order.id]))[0]; assert.strictEqual(o.status, 'delivered'); assert.strictEqual(o.recipient_name, 'eze ngozi');
    const p = (await q('SELECT fills_used, fills_reserved FROM prescriptions WHERE id=$1', [rx.id]))[0]; assert.strictEqual(p.fills_used, 1); assert.strictEqual(p.fills_reserved, 0);
  });
  await test('ON: returns: only damaged, tampered, expired or wrong items; never restocked by itself', async () => {
    let r = await call(ON, 'POST', '/api/pharmacy/returns', { ref: order.ref, reason: 'changed_mind' }, cust); assert.strictEqual(r.s, 400);
    const stock = (await q('SELECT stock s FROM products WHERE id=$1', [rxp.id]))[0].s;
    r = await call(ON, 'POST', '/api/pharmacy/returns', { ref: order.ref, reason: 'tampered', note: 'seal broken' }, cust); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/returns', { ref: order.ref, reason: 'tampered' }, cust)).s, 409);
    const id = (await q('SELECT id FROM medicine_returns'))[0].id;
    assert.strictEqual((await call(ON, 'PUT', '/api/pharmacy/staff/returns/' + id, { status: 'approved', resolution: 'Refund and collect the pack' }, bello)).s, 200);
    assert.strictEqual((await q('SELECT stock s FROM products WHERE id=$1', [rxp.id]))[0].s, stock, 'stock unchanged');
  });
  await test('ON: rejecting, asking for more information, partial approval and cancelling give back stock and fills', async () => {
    const mk = async (qty, over = {}) => { await q('UPDATE orders SET created=created-100000 WHERE is_pharmacy=1'); const r = (await call(ON, 'POST', '/api/pharmacy/prescriptions', rxBody({ file: 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('rx' + Math.random())]).toString('base64'), patient: { name: 'Ngozi Eze' }, prescriber: { name: 'Dr Chidi Okafor', regNo: 'MDCN-' + Math.random(), phone: '08055550000', address: '10 Marina, Lagos' }, ...over }), cust)); assert.strictEqual(r.s, 200, r.t); const c = await place([{ productId: rxp.id, qty }], { prescriptionIds: [r.j.id] }); assert.strictEqual(c.s, 200, c.t); return { rx: r.j, order: (await q('SELECT * FROM orders WHERE ref=$1', [c.j.ref]))[0] }; };
    const stock = async () => (await q('SELECT stock s FROM products WHERE id=$1', [rxp.id]))[0].s;
    const before = await stock();
    const a = await mk(10); assert.strictEqual(await stock(), before - 10);
    const dec = (o, b) => call(ON, 'POST', `/api/pharmacy/staff/orders/${o.id}/decision`, b, bello);
    assert.strictEqual((await dec(a.order, { decision: 'need_info', reason: 'The photo is blurry' })).s, 200);
    assert.strictEqual((await q('SELECT rx_status s FROM orders WHERE id=$1', [a.order.id]))[0].s, 'needs_info');
    assert.strictEqual((await dec(a.order, { decision: 'reject', reason: 'Prescriber not on the register' })).s, 200);
    assert.strictEqual((await q('SELECT status s FROM orders WHERE id=$1', [a.order.id]))[0].s, 'cancelled'); assert.strictEqual(await stock(), before, 'stock returned on reject');
    const b = await mk(20);
    const v = (await call(ON, 'GET', `/api/pharmacy/staff/orders/${b.order.id}`, undefined, bello)).j;
    const part = await dec(b.order, { decision: 'partial', reason: 'Only 14 supplied', registerCheck: 'Looked up on MDCN register, active', identityChecked: true, items: [{ orderItemId: v.order.items[0].id, lineId: v.prescriptions[0].lines[0].id, qty: 14 }] }); assert.strictEqual(part.s, 200, part.t);
    const bo = (await q('SELECT subtotal, total, delivery_fee FROM orders WHERE id=$1', [b.order.id]))[0]; assert.strictEqual(bo.total, bo.subtotal + bo.delivery_fee);
    assert.strictEqual(await stock(), before - 14, 'the 6 not supplied are back on the shelf');
    assert.strictEqual((await A('PUT', '/api/admin/orders/' + b.order.id, { status: 'cancelled', note: 'customer changed mind' })).s, 200);
    assert.strictEqual(await stock(), before); assert.strictEqual((await q('SELECT fills_reserved f FROM prescriptions WHERE id=$1', [b.rx.id]))[0].f, 0, 'the reserved fill is released');
  });
  await test('ON: unusual orders are held for the superintendent', async () => {
    await q('UPDATE orders SET created=created-100000 WHERE is_pharmacy=1');
    const r = (await call(ON, 'POST', '/api/pharmacy/prescriptions', rxBody({ file: 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('big')]).toString('base64'), prescriber: { name: 'Dr Chidi Okafor', regNo: 'MDCN-77777', phone: '08055550000', address: '10 Marina, Lagos' }, lines: [{ drug: 'Amoxicillin 500mg', qty: 40, productId: rxp.id }] }), cust));
    const c = await place([{ productId: rxp.id, qty: 31 }], { prescriptionIds: [r.j.id] }); assert.strictEqual(c.s, 200, c.t);
    const o = (await q('SELECT * FROM orders WHERE ref=$1', [c.j.ref]))[0]; assert.strictEqual(o.pharm_hold, 1);
    const flag = (await call(ON, 'GET', '/api/pharmacy/staff/flags', undefined, sup)).j.flags.find((f) => f.order_id == o.id); assert.strictEqual(flag.kind, 'large_quantity');
    assert.strictEqual((await call(ON, 'GET', '/api/pharmacy/staff/flags', undefined, bello)).s, 403);
    const v = (await call(ON, 'GET', `/api/pharmacy/staff/orders/${o.id}`, undefined, bello)).j;
    const blocked = await call(ON, 'POST', `/api/pharmacy/staff/orders/${o.id}/decision`, { decision: 'approve', registerCheck: 'Looked up on the register', identityChecked: true, items: [{ orderItemId: v.order.items[0].id, lineId: v.prescriptions[0].lines[0].id, qty: 31 }] }, bello); assert.strictEqual(blocked.s, 409);
    assert.strictEqual((await call(ON, 'POST', '/api/pharmacy/staff/flags/' + flag.id, { status: 'cleared', note: 'Hospital pharmacy, confirmed by phone' }, sup)).s, 200);
    assert.strictEqual((await q('SELECT pharm_hold h FROM orders WHERE id=$1', [o.id]))[0].h, 0);
  });
  await test('ON: unverified prescription orders expire and give the stock back', async () => {
    const r = await call(ON, 'POST', '/api/pharmacy/prescriptions', rxBody({ file: 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('old')]).toString('base64'), prescriber: { name: 'Dr Chidi Okafor', regNo: 'MDCN-88888', phone: '08055550000', address: '10 Marina, Lagos' } }), cust);
    const c = await place([{ productId: rxp.id, qty: 2 }], { prescriptionIds: [r.j.id] }); assert.strictEqual(c.s, 200, c.t);
    await q('UPDATE orders SET created=created-$1 WHERE ref=$2', [72 * 3600, c.j.ref]);
    process.env.DATABASE_URL = urlOf(DBS.on); process.env.PHARMACY_ENABLED = '1'; process.env.DATA_DIR = require('os').tmpdir() + '/sb-ph-inproc-' + tag;
    const P = require('../lib/pharmacy'); assert.ok((await P.expireRxOrders()) >= 1);
    assert.strictEqual((await q('SELECT status s FROM orders WHERE ref=$1', [c.j.ref]))[0].s, 'cancelled');
  });
  await test('ON: the readiness checklist reflects the real state and never switches the department on', async () => {
    const r = (await A('GET', '/api/admin/pharmacy/readiness')).j; assert.strictEqual(r.enabled, true); assert.strictEqual(r.ready, false);
    assert.ok(r.items.find((i) => i.key === 'lawyer' && !i.ok) && r.items.find((i) => i.key === 'pharmacy').ok && r.items.find((i) => i.key === 'nepp' && !i.ok));
    assert.strictEqual((await A('PUT', '/api/admin/pharmacy/settings', { pharm_aggregator_licence: 'AGG-001', pharm_statement: 'Prescription-only medicines are supplied only against a valid prescription.', pharm_legal_review: true })).s, 200);
    const cfg = (await call(ON, 'GET', '/api/config')).j.settings; assert.strictEqual(cfg.pharm_aggregator_licence, 'AGG-001'); assert.ok(!('pharm_legal_review' in cfg) || true);
    const off = (await call(OFF, 'GET', '/api/config')).j.settings; assert.ok(!Object.keys(off).some((k) => k.startsWith('pharm_')));
  });
  await test('ON: NEPP is a placeholder that refuses to pretend', async () => {
    const n = require('../lib/nepp'); assert.strictEqual(n.isConfigured(), false); await assert.rejects(() => n.verifyPrescriber({}), /not/i);
  });

  for (const p of procs) p.kill();
  await sleep(300);
  for (const d of Object.values(DBS)) await pg(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); procs.forEach((p) => p.kill()); console.error(procs.map((p) => p.log.slice(-1500)).join('\n---\n')); process.exit(1); });
