'use strict';
// Global Trade module, phase 7: international payments, refunds, reconciliation and tracking.
// Run with: npm run test:trade-payments   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'vm_tp_' + tag, KEY = 'sk_test_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500), FXPORT = PORT + 2000, PSPORT = PORT + 4000;
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

// fake exchange-rate provider
const fxServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: 'success', base_code: 'NGN', time_last_update_unix: Math.floor(Date.now() / 1000) - 600, rates: { NGN: 1, USD: 0.00065, GBP: 0.00051 } })); });
// fake Paystack: initialise, verify (with fees), refund create / get / list
const ps = { amounts: {}, ids: {}, refunds: {}, nextId: 100, mode: 'processed', calls: { refund: 0 }, down: false };
const psServer = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const body = Buffer.concat(c).toString(); const send = (s, o) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    if (req.headers.authorization !== 'Bearer ' + KEY) return send(401, { status: false, message: 'bad key' });
    if (req.url === '/transaction/initialize') { const j = JSON.parse(body); ps.amounts[j.reference] = j.amount; ps.ids[j.reference] = ps.nextId++; return send(200, { status: true, data: { authorization_url: 'http://pay.test/' + j.reference } }); }
    let m = /^\/transaction\/verify\/(.+)$/.exec(req.url);
    if (m) { const ref = decodeURIComponent(m[1]); return send(200, { status: true, data: { id: ps.ids[ref], status: 'success', currency: 'NGN', amount: ps.amounts[ref], reference: ref, fees: 150000 } }); }
    if (req.method === 'POST' && req.url === '/refund') {
      ps.calls.refund++; if (ps.down) return send(500, { status: false });
      const j = JSON.parse(body); if (ps.mode === 'reject') return send(400, { status: false, message: 'Transaction has already been fully reversed' });
      const id = ps.nextId++; ps.refunds[id] = { id, status: ps.mode, amount: j.amount, transaction: j.transaction }; return send(200, { status: true, data: { id, status: ps.mode, amount: j.amount } });
    }
    m = /^\/refund\/(\d+)$/.exec(req.url); if (m) return ps.refunds[m[1]] ? send(200, { status: true, data: ps.refunds[m[1]] }) : send(404, { status: false, message: 'not found' });
    if (/^\/refund\?/.test(req.url)) return send(200, { status: true, data: Object.values(ps.refunds) });
    send(404, { status: false });
  });
});
const sign = (b) => crypto.createHmac('sha512', KEY).update(b).digest('hex');
const hook = (ev, data, bad) => { const b = JSON.stringify({ event: ev, data }); return call('POST', '/api/paystack/webhook', b, null, { 'x-paystack-signature': bad ? 'nope' : sign(b) }); };

(async () => {
  await new Promise((r) => fxServer.listen(FXPORT, '127.0.0.1', r)); await new Promise((r) => psServer.listen(PSPORT, '127.0.0.1', r));
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATABASE_SSL: 'off', DATA_DIR: require('os').tmpdir() + '/vm-tp-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50', FX_API_URL: `http://127.0.0.1:${FXPORT}/latest/{base}`, FX_REFRESH: '0', PAYSTACK_SECRET_KEY: KEY, PAYSTACK_API_URL: 'http://127.0.0.1:' + PSPORT, WORKER_POLL_MS: '200' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, '/api/admin/trade' + u, b, admin);
  const P = (m, u, b) => call(m, '/api/trade' + u, b);

  // set-up (as in the export tests)
  await A('POST', '/countries/bulk', { codes: ['US'], flag: 'export_to', on: true });
  await A('PUT', '/countries/US', { postal_regex: '^\\d{5}(-\\d{4})?$', postal_required: true });
  await A('POST', '/rates/refresh');
  const prods = await q("SELECT id FROM products WHERE is_pharmacy=0 AND active=1 AND vendor_id IS NULL AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id=products.id) ORDER BY id LIMIT 2");
  await q('UPDATE products SET stock=500 WHERE id=$1', [prods[0].id]);
  assert.strictEqual((await A('PUT', '/products/' + prods[0].id, { export_enabled: true, intl_eligible: true, origin_country: 'NG', hs_code: '6109.10', customs_description: 'Cotton T-shirt', weight_kg: 0.5, length_cm: 30, width_cm: 25, height_cm: 3, shipping_category: 'clothing' })).s, 200);
  const zone = (await A('POST', '/shipping/zones', { name: 'US', countries: ['US'], origin_country: 'NG' })).j.item;
  const svc = (await A('POST', '/shipping/services', { name: 'Express', method: 'express', est_days_min: 3, est_days_max: 6 })).j.item;
  await A('POST', '/shipping/rates', { zone_id: zone.id, service_id: svc.id, min_kg: 0, max_kg: 20, base_amount: 15000, per_kg: 4000, currency: 'NGN' });
  let n = 0;
  const placePaid = async (email = 'jane@example.com', pay = true) => {
    const body = { items: [{ productId: prods[0].id, qty: 2 }], country: 'US', currency: 'USD', contact: { name: 'Jane Doe', email, dial_code: '1', phone: '2025550123' }, address: { line1: '1 Main Street', city: 'Austin', region: 'TX', postal_code: '73301' } };
    const qt = (await P('POST', '/quote', body)).j;
    const r = await fetch(`http://127.0.0.1:${PORT}/api/trade/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'tp-' + tag + '-' + (++n) + '-xxxxxxxx' }, body: JSON.stringify({ ...body, service_id: svc.id, quote_id: qt.options[0].quote_id }) });
    const o = await r.json(); assert.strictEqual(r.status, 200, JSON.stringify(o));
    if (pay) { ps.amounts[o.ref] = Math.round(o.total_ngn * 100); ps.ids[o.ref] = ps.nextId++; const v = await call('GET', '/api/paystack/verify?reference=' + o.ref); assert.strictEqual(v.s, 200, v.t); }
    return o;
  };
  const charge = async (ref) => (await q("SELECT p.* FROM international_payments p JOIN orders o ON o.id=p.order_id WHERE o.ref=$1 AND p.kind='charge'", [ref]))[0];
  const pay = async (id) => (await A('GET', '/payments')).j.payments.find((x) => x.id === Number(id));
  const rkey = (s) => ('rk-' + tag + '-' + s + '-' + 'x'.repeat(10)).slice(0, 40);

  console.log('\nProviders and charges');
  const o1 = await placePaid();
  await test('provider list: Paystack ready; Flutterwave and Stripe honestly "not integrated"', async () => {
    const r = await A('GET', '/payments/providers'); assert.strictEqual(r.s, 200); const by = Object.fromEntries(r.j.providers.map((p) => [p.code, p]));
    assert.strictEqual(by.paystack.status, 'ready'); assert.strictEqual(by.flutterwave.status, 'not_integrated'); assert.strictEqual(by.stripe.status, 'not_integrated');
    assert.ok(!JSON.stringify(r.j).includes(KEY), 'secret key never returned');
  });
  await test('a confirmed Paystack payment is recorded as a verified charge with the provider fee', async () => {
    const c = await charge(o1.ref); assert.ok(c); assert.strictEqual(c.status, 'succeeded'); assert.strictEqual(Number(c.verified), 1); assert.strictEqual(Number(c.fee), 1500); assert.strictEqual(Number(c.amount), Number(o1.total_ngn));
  });
  await test('payments are Finance-only: signed-out 401, analyst 403', async () => {
    assert.strictEqual((await call('GET', '/api/admin/trade/payments')).s, 401);
    const roles = (await call('GET', '/api/admin/staff', undefined, admin)).j.roles, role = roles.find((r) => r.name === 'Trade Analyst');
    const r = await call('POST', '/api/admin/staff', { name: 'An Emp', email: 'analyst@example.com', username: 'an.user', role_id: role.id }, admin); assert.strictEqual(r.s, 200, r.t);
    const an = await login('analyst@example.com', r.j.temp_password);
    assert.strictEqual((await call('GET', '/api/admin/trade/payments', undefined, an)).s, 403); assert.strictEqual((await call('POST', '/api/admin/trade/payments/1/refund', {}, an)).s, 403); assert.strictEqual((await call('GET', '/api/admin/trade/tracking', undefined, an)).s, 200, 'tracking is readable with Trade');
  });

  console.log('\nRefunds');
  const c1 = await charge(o1.ref); const total = Number(c1.amount);
  await test('a refund needs a key, a reason and a sensible amount', async () => {
    const R = (b) => A('POST', `/payments/${c1.id}/refund`, b);
    assert.strictEqual((await R({ amount_ngn: 100, reason: 'Damaged' })).s, 400); assert.strictEqual((await R({ amount_ngn: 100, idempotency_key: rkey('a') })).s, 400);
    assert.strictEqual((await R({ amount_ngn: 0, reason: 'x y z', idempotency_key: rkey('b') })).s, 400); assert.strictEqual((await R({ amount_ngn: -5, reason: 'x y z', idempotency_key: rkey('c') })).s, 400);
    assert.strictEqual((await R({ amount_ngn: 10.005, reason: 'x y z', idempotency_key: rkey('d') })).s, 400);
    assert.strictEqual((await R({ amount_ngn: total + 1, reason: 'Too much', idempotency_key: rkey('e') })).s, 409, 'more than was paid');
    assert.strictEqual(ps.calls.refund, 0, 'Paystack was never asked');
  });
  await test('partial refund: sent to Paystack, recorded only when Paystack says processed; the order stays paid', async () => {
    ps.mode = 'processed'; const r = await A('POST', `/payments/${c1.id}/refund`, { amount_ngn: 1000, reason: 'One item damaged', idempotency_key: rkey('p1') }); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual(r.j.payment.status, 'succeeded'); assert.strictEqual(r.j.payment.verified, true);
    assert.strictEqual((await charge(o1.ref)).status, 'partially_refunded'); const o = (await q('SELECT payment_status, status FROM orders WHERE ref=$1', [o1.ref]))[0]; assert.strictEqual(o.payment_status, 'paid'); assert.notStrictEqual(o.status, 'refunded');
    assert.ok((await q("SELECT 1 FROM order_events e JOIN orders o ON o.id=e.order_id WHERE o.ref=$1 AND e.note LIKE 'Partial refund%'", [o1.ref])).length);
  });
  await test('the same refund key again: no second refund, Paystack not called again', async () => {
    const before = ps.calls.refund; const r = await A('POST', `/payments/${c1.id}/refund`, { amount_ngn: 1000, reason: 'One item damaged', idempotency_key: rkey('p1') }); assert.strictEqual(r.s, 200); assert.ok(r.j.replayed);
    assert.strictEqual(ps.calls.refund, before); assert.strictEqual((await q("SELECT COUNT(*)::int n FROM international_payments WHERE parent_id=$1 AND kind='refund'", [c1.id]))[0].n, 1);
    const [a, b] = await Promise.all([1, 2].map(() => A('POST', `/payments/${c1.id}/refund`, { amount_ngn: 500, reason: 'Race', idempotency_key: rkey('race') }))); assert.ok(a.s === 200 && b.s === 200);
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM international_payments WHERE idempotency_key=$1", [rkey('race')]))[0].n, 1, 'two clicks, one refund');
  });
  let pendingId;
  await test('Paystack accepts but has not finished: refund stays pending and still counts against the limit', async () => {
    ps.mode = 'pending'; const left = total - 1500; const r = await A('POST', `/payments/${c1.id}/refund`, { amount_ngn: 700, reason: 'Late delivery', idempotency_key: rkey('pend') }); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual(r.j.payment.status, 'pending'); assert.strictEqual(r.j.payment.verified, false); pendingId = r.j.payment.id;
    assert.strictEqual((await charge(o1.ref)).status, 'partially_refunded');
    assert.strictEqual((await A('POST', `/payments/${c1.id}/refund`, { amount_ngn: left - 700 + 1, reason: 'Too much', idempotency_key: rkey('pend2') })).s, 409, 'pending refund is not refundable twice');
  });
  await test('"Check with Paystack" moves a pending refund to succeeded only when Paystack says processed', async () => {
    let r = await A('POST', `/payments/${pendingId}/refresh`, {}); assert.strictEqual(r.j.payment.status, 'pending');
    const rid = Object.keys(ps.refunds).pop(); ps.refunds[rid].status = 'processed';
    r = await A('POST', `/payments/${pendingId}/refresh`, {}); assert.strictEqual(r.j.payment.status, 'succeeded'); assert.strictEqual(r.j.payment.verified, true);
    r = await A('POST', `/payments/${pendingId}/refresh`, {}); assert.strictEqual(r.j.payment.status, 'succeeded', 'safe to repeat');
    assert.strictEqual(Number((await q("SELECT COUNT(*)::int n FROM international_payments WHERE parent_id=$1 AND status='succeeded'", [c1.id]))[0].n), 3, 'partial, race and the one just confirmed');
  });
  await test('Paystack refuses a refund: it is recorded as failed, nothing is refunded, and a new attempt is allowed', async () => {
    ps.mode = 'reject'; const r = await A('POST', `/payments/${c1.id}/refund`, { amount_ngn: 300, reason: 'Try', idempotency_key: rkey('rej') }); assert.strictEqual(r.s, 422, r.t); assert.match(r.j.error || r.t, /fully reversed/);
    assert.strictEqual((await q("SELECT status FROM international_payments WHERE idempotency_key=$1", [rkey('rej')]))[0].status, 'failed');
    ps.mode = 'processed'; assert.strictEqual((await A('POST', `/payments/${c1.id}/refund`, { amount_ngn: 300, reason: 'Try again', idempotency_key: rkey('rej2') })).s, 200);
  });
  await test('refund created in the Paystack dashboard arrives by signed webhook, is recorded once, and a bad signature is refused', async () => {
    const data = { transaction_reference: o1.ref, refund_reference: 'dash-' + tag, amount: 50000, status: 'processed' };
    assert.strictEqual((await hook('refund.processed', data, true)).s, 401);
    assert.strictEqual((await hook('refund.processed', data)).s, 200); assert.strictEqual((await hook('refund.processed', data)).s, 200);
    const rows = await q("SELECT * FROM international_payments WHERE provider_ref=$1", ['PSX-dash-' + tag]); assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].status, 'succeeded'); assert.strictEqual(Number(rows[0].amount), 500);
  });
  await test('webhook also finishes a pending refund, and an unrelated transaction is ignored', async () => {
    ps.mode = 'pending'; const r = await A('POST', `/payments/${c1.id}/refund`, { amount_ngn: 200, reason: 'Webhook path', idempotency_key: rkey('wh') }); assert.strictEqual(r.j.payment.status, 'pending');
    await hook('refund.processed', { transaction_reference: o1.ref, amount: 20000 }); assert.strictEqual((await q('SELECT status FROM international_payments WHERE id=$1', [r.j.payment.id]))[0].status, 'succeeded');
    const cnt = (await q('SELECT COUNT(*)::int n FROM international_payments'))[0].n; assert.strictEqual((await hook('refund.processed', { transaction_reference: 'NOPE-1', amount: 100 })).s, 200); assert.strictEqual((await q('SELECT COUNT(*)::int n FROM international_payments'))[0].n, cnt);
  });
  await test('refunding the full remaining amount marks the payment refunded and the order refunded; nothing more can be refunded', async () => {
    ps.mode = 'processed'; const used = Number((await q("SELECT COALESCE(SUM(amount),0) s FROM international_payments WHERE parent_id=$1 AND kind='refund' AND status IN ('succeeded','pending')", [c1.id]))[0].s), left = Math.round((total - used) * 100) / 100;
    const r = await A('POST', `/payments/${c1.id}/refund`, { amount_ngn: left, reason: 'Order cancelled', idempotency_key: rkey('full') }); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual((await charge(o1.ref)).status, 'refunded'); const o = (await q('SELECT payment_status, status FROM orders WHERE ref=$1', [o1.ref]))[0]; assert.ok(o.payment_status === 'refunded' || o.status === 'refunded', JSON.stringify(o));
    assert.strictEqual((await A('POST', `/payments/${c1.id}/refund`, { amount_ngn: 1, reason: 'More', idempotency_key: rkey('more') })).s, 409);
  });
  const o2 = await placePaid('second@example.com'); const c2 = await charge(o2.ref);
  await test('Paystack does not answer: the refund is kept pending (never "done"), and cannot be doubled', async () => {
    ps.down = true; const r = await A('POST', `/payments/${c2.id}/refund`, { amount_ngn: 400, reason: 'Outage', idempotency_key: rkey('down') }); ps.down = false; assert.strictEqual(r.s, 502, r.t);
    const row = (await q("SELECT status, verified FROM international_payments WHERE idempotency_key=$1", [rkey('down')]))[0]; assert.strictEqual(row.status, 'pending'); assert.strictEqual(Number(row.verified), 0);
    assert.strictEqual((await A('POST', `/payments/${c2.id}/refund`, { amount_ngn: Number(c2.amount), reason: 'Again', idempotency_key: rkey('down2') })).s, 409);
    const r2 = await A('POST', `/payments/${(await q("SELECT id FROM international_payments WHERE idempotency_key=$1", [rkey('down')]))[0].id}/refresh`, {}); assert.strictEqual(r2.s, 200); assert.strictEqual(r2.j.payment.status, 'pending'); assert.match(r2.j.note || '', /no record/i);
  });
  await test('demo and unverified payments cannot be refunded through Paystack', async () => {
    const eo = (await q('SELECT id, order_id FROM export_orders WHERE order_id=(SELECT id FROM orders WHERE ref=$1)', [o2.ref]))[0];
    await q("INSERT INTO international_payments (export_order_id,order_id,provider,provider_ref,currency,amount,amount_ngn,kind,status,verified,created,updated) VALUES ($1,$2,'paystack','DEMO-xyz','NGN',1000,1000,'charge','succeeded',1,1,1)", [eo.id, eo.order_id]);
    const d = (await q("SELECT id FROM international_payments WHERE provider_ref='DEMO-xyz'"))[0]; assert.strictEqual((await A('POST', `/payments/${d.id}/refund`, { amount_ngn: 10, reason: 'Demo', idempotency_key: rkey('demo') })).s, 409);
    assert.strictEqual((await A('POST', `/payments/999999/refund`, { amount_ngn: 10, reason: 'None', idempotency_key: rkey('none') })).s, 404); await q("DELETE FROM international_payments WHERE provider_ref='DEMO-xyz'");
  });

  console.log('\nReconciliation');
  await test('reconciliation shows charged, fees, refunded and flags orders that need a look', async () => {
    const r = await A('GET', '/payments/reconciliation'); assert.strictEqual(r.s, 200, r.t); const a = r.j.rows.find((x) => x.order_ref === o1.ref), b = r.j.rows.find((x) => x.order_ref === o2.ref);
    assert.strictEqual(a.charged_ngn, total); assert.strictEqual(a.fees_ngn, 1500); assert.strictEqual(a.refunded_ngn, total); assert.strictEqual(a.net_ngn, -1500); assert.strictEqual(a.flag, 'ok');
    assert.strictEqual(b.refund_pending_ngn, 400); assert.strictEqual(b.flag, 'refund_pending'); assert.ok(r.j.totals.flagged >= 1);
    const o3 = await placePaid('third@example.com', false); await q("UPDATE orders SET payment_status='paid' WHERE ref=$1", [o3.ref]);   // marked paid by hand, no Paystack record
    const r2 = await A('GET', '/payments/reconciliation'); assert.strictEqual(r2.j.rows.find((x) => x.order_ref === o3.ref).flag, 'no_provider_record');
  });
  await test('payment list can be filtered and searched', async () => {
    assert.ok((await A('GET', '/payments?kind=refund')).j.payments.every((x) => x.kind === 'refund')); assert.strictEqual((await A('GET', '/payments?q=' + o2.ref)).j.payments.every((x) => x.order_ref === o2.ref), true);
  });

  console.log('\nTracking');
  const ev = async (order, stage, descr, loc) => { const eo = (await q('SELECT id FROM export_orders WHERE order_id=(SELECT id FROM orders WHERE ref=$1)', [order]))[0]; await q("INSERT INTO shipment_tracking_events (export_order_id,stage,description,location,occurred_at,source,event_hash,created) VALUES ($1,$2,$3,$4,$5,'manual',$6,$5)", [eo.id, stage, descr, loc || '', Math.floor(Date.now() / 1000), crypto.randomUUID()]); };
  await q("UPDATE export_orders SET status='in_transit', carrier='DHL', tracking_number='TRK-9001' WHERE order_id=(SELECT id FROM orders WHERE ref=$1)", [o2.ref]);
  await ev(o2.ref, 'dispatched', 'Handed to DHL', 'Lagos'); await ev(o2.ref, 'departed_origin', 'Left Nigeria', 'LOS');
  const T = (b) => P('POST', '/track', b);
  await test('customer can track with order number or tracking number plus the checkout email', async () => {
    for (const k of [o2.ref, o2.ref.toLowerCase(), 'TRK-9001']) { const r = await T({ query: k, email: 'Second@Example.com' }); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.status, 'in_transit'); assert.strictEqual(r.j.carrier, 'DHL'); assert.strictEqual(r.j.timeline.length, 3, 'confirmed + two carrier events'); assert.ok(r.j.stages.find((s) => s.stage === 'departed_origin').reached); assert.ok(!r.j.stages.find((s) => s.stage === 'delivered').reached); }
  });
  await test('a wrong email, unknown number and unpaid order all get the same generic answer, with no personal data or amounts', async () => {
    const a = await T({ query: o2.ref, email: 'wrong@example.com' }), b = await T({ query: 'NOPE-1', email: 'second@example.com' }), unpaid = await placePaid('unpaid@example.com', false), c = await T({ query: unpaid.ref, email: 'unpaid@example.com' });
    assert.strictEqual(a.s, 404); assert.strictEqual(b.s, 404); assert.strictEqual(c.s, 404); assert.strictEqual(a.t, b.t); assert.strictEqual(a.t, c.t);
    const ok = (await T({ query: o2.ref, email: 'second@example.com' })).t; for (const bad of ['second@example.com', '1 Main Street', '2025550123', 'total', 'Jane']) assert.ok(!ok.includes(bad), 'must not leak ' + bad);
    assert.strictEqual((await T({ query: '', email: 'x' })).s, 400); assert.strictEqual((await T({ query: o2.ref })).s, 400);
  });
  await test('staff overview flags a problem and a parcel with no recent update', async () => {
    const eref2 = (await q('SELECT ref FROM export_orders WHERE order_id=(SELECT id FROM orders WHERE ref=$1)', [o2.ref]))[0].ref; let r = (await A('GET', '/tracking')).j; assert.strictEqual(r.shipments.find((x) => x.ref === eref2).flag, 'ok');
    await ev(o2.ref, 'customs_hold', 'Held pending paperwork', 'JFK'); r = (await A('GET', '/tracking')).j; assert.strictEqual(r.counts.problems, 1);
    await q('UPDATE shipment_tracking_events SET occurred_at = occurred_at - 900000'); await q("DELETE FROM shipment_tracking_events WHERE stage='customs_hold'"); r = (await A('GET', '/tracking')).j; assert.strictEqual(r.counts.stale, 1); assert.strictEqual(r.shipments[0].flag, 'no_recent_update');
  });

  console.log('\nIntegrity');
  await test('database refuses a "succeeded" payment that is not verified and a duplicate provider reference', async () => {
    const eo = (await q('SELECT id, order_id FROM export_orders LIMIT 1'))[0];
    await assert.rejects(q("INSERT INTO international_payments (export_order_id,order_id,provider,provider_ref,currency,amount,kind,status,verified,created,updated) VALUES ($1,$2,'paystack','X1','NGN',1,'charge','succeeded',0,1,1)", [eo.id, eo.order_id]));
    await assert.rejects(q("INSERT INTO international_payments (export_order_id,order_id,provider,provider_ref,currency,amount,kind,status,verified,created,updated) VALUES ($1,$2,'paystack',$3,'NGN',1,'charge','succeeded',1,1,1)", [eo.id, eo.order_id, o1.ref]));
  });
  await test('no secret key or card data appears in the server log', async () => { assert.ok(!log.includes(KEY)); assert.ok(!/\b\d{13,19}\b/.test(log.replace(/\d{10,}\.\d+/g, ''))); });

  console.log(`\n${passed} passed, ${failed} failed`);
  srv.kill(); fxServer.close(); psServer.close(); await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  if (failed) { console.log(log.slice(-2500)); process.exit(1); } process.exit(0);
})().catch(async (e) => { console.error(e); console.log(log.slice(-2500)); try { srv && srv.kill(); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* ignore */ } process.exit(1); });
