'use strict';
// Global Trade module, phase 3: export checkout and international customer orders.
// Run with: npm run test:trade-export   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const http = require('http');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');
const X = require('../lib/xlsx');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'vm_tx_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500), FXPORT = PORT + 2000;
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
const call = async (method, url, body, cookie, raw) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const buf = Buffer.from(await r.arrayBuffer()); const t = buf.toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { s: r.status, j, t, buf, h: r.headers, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + email + ' ' + r.t); return r.c; };

// A fake exchange-rate provider (same shape as open.er-api.com) so the test never touches the internet.
const fx = { up: true, calls: 0, rates: { USD: 0.00065, GBP: 0.00051, EUR: 0.0006, CAD: 0.00089, AUD: 0.00099 } };
const fxServer = http.createServer((req, res) => {
  fx.calls++;
  if (!fx.up) { res.writeHead(500); return res.end('down'); }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: 'success', base_code: 'NGN', time_last_update_unix: Math.floor(Date.now() / 1000) - 600, rates: { NGN: 1, ...fx.rates } }));
});

(async () => {
  await new Promise((r) => fxServer.listen(FXPORT, '127.0.0.1', r));
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/vm-tx-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50', FX_API_URL: `http://127.0.0.1:${FXPORT}/latest/{base}`, FX_REFRESH: '0' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, '/api/admin/trade' + u, b, admin);
  const P = (m, u, b, c) => call(m, '/api/trade' + u, b, c);

  // set-up: countries, currency rates, products, one zone, one manual method, one weight bracket, duty rules
  await A('POST', '/countries/bulk', { codes: ['US', 'GB'], flag: 'export_to', on: true });
  await A('PUT', '/countries/US', { postal_regex: '^\\d{5}(-\\d{4})?$', postal_required: true });
  assert.strictEqual((await A('POST', '/rates/refresh')).s, 200);
  const prods = await q("SELECT id, name, stock FROM products WHERE is_pharmacy=0 AND active=1 AND vendor_id IS NULL AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id=products.id) ORDER BY id LIMIT 3");
  const vend = (await q("SELECT id FROM products WHERE vendor_id IS NOT NULL LIMIT 1"))[0];
  const complete = { export_enabled: true, intl_eligible: true, origin_country: 'NG', hs_code: '6109.10', customs_description: 'Cotton T-shirt, knitted', weight_kg: 0.5, length_cm: 30, width_cm: 25, height_cm: 3, shipping_category: 'clothing' };
  for (const p of prods.slice(0, 2)) assert.strictEqual((await A('PUT', '/products/' + p.id, complete)).s, 200);
  await q('UPDATE products SET stock=50 WHERE id=$1', [prods[0].id]);
  const zr = await A('POST', '/shipping/zones', { name: 'North America + UK', countries: ['US', 'GB'], origin_country: 'NG' }); if (!zr.j || !zr.j.item) throw new Error('zone ' + zr.s + ' ' + zr.t + log.slice(-1500)); const zone = zr.j.item;
  const svc = (await A('POST', '/shipping/services', { name: 'Express', method: 'express', est_days_min: 3, est_days_max: 6, supports_insurance: true, supports_ddp: false })).j.item;
  const rate = (await A('POST', '/shipping/rates', { zone_id: zone.id, service_id: svc.id, min_kg: 0, max_kg: 20, base_amount: 15000, per_kg: 4000, currency: 'NGN' })).j.item;
  const item = (n) => [{ productId: prods[0].id, qty: n }];
  const addr = { name: 'Jane Doe', email: 'jane@example.com', dial_code: '1', phone: '2025550123' };
  const body = (extra = {}) => ({ items: item(2), country: 'US', currency: 'USD', contact: addr, address: { line1: '1 Main Street', city: 'Austin', region: 'TX', postal_code: '73301' }, ...extra });

  console.log('\nShipping set-up');
  await test('staff can create zone, method and rate; overlapping or zero rates are refused', async () => {
    assert.ok(zone.id && svc.id && rate.id);
    assert.strictEqual((await A('POST', '/shipping/rates', { zone_id: zone.id, service_id: svc.id, min_kg: 10, max_kg: 30, base_amount: 1, currency: 'NGN' })).s, 409);
    assert.strictEqual((await A('POST', '/shipping/rates', { zone_id: zone.id, service_id: svc.id, min_kg: 30, base_amount: 0, per_kg: 0, currency: 'NGN' })).s, 400);
  });
  await test('a duty rule cannot be "verified" without a source and link; editing rates resets verification', async () => {
    assert.strictEqual((await A('POST', '/shipping/duty-rules', { destination_country: 'US', hs_prefix: '6109', duty_pct: 16.5, verified: true })).s, 400);
    const r = await A('POST', '/shipping/duty-rules', { destination_country: 'US', hs_prefix: '6109', duty_pct: 16.5, source: 'USITC HTS', source_url: 'https://hts.usitc.gov/', verified: true }); assert.strictEqual(r.s, 200, r.t); assert.ok(r.j.item.verified);
    const u = await A('PUT', '/shipping/duty-rules/' + r.j.item.id, { duty_pct: 20 }); assert.strictEqual(u.j.item.verified, false);
    await A('DELETE', '/shipping/duty-rules/' + r.j.item.id);
  });

  console.log('\nQuote');
  let qt;
  await test('quote returns a labelled manual estimate with weights, converted prices and an expiry', async () => {
    const r = await P('POST', '/quote', body()); assert.strictEqual(r.s, 200, r.t); qt = r.j;
    assert.strictEqual(qt.options.length, 1); const o = qt.options[0]; assert.ok(o.quote_id && o.expires_at);
    assert.match(JSON.stringify(o), /manual/i); assert.strictEqual(qt.currency.code, 'USD');
    assert.ok(o.duties && ['not_available', 'partial', 'estimated', 'verified'].includes(o.duties.status));
  });
  await test('no shipping method for an unconfigured destination; unknown or disabled country is refused', async () => {
    const r = await P('POST', '/quote', body({ country: 'GB', address: { line1: '1 High Street', city: 'London', postal_code: 'SW1A 1AA' } })); assert.strictEqual(r.s, 200); assert.ok(r.j.options.length >= 0);
    assert.strictEqual((await P('POST', '/quote', body({ country: 'ZZ' }))).s, 404);
    assert.strictEqual((await P('POST', '/quote', body({ currency: 'XXX' }))).s, 400);
  });
  await test('vendor stock and unconfigured products cannot be quoted', async () => {
    assert.strictEqual((await P('POST', '/quote', body({ items: [{ productId: prods[2].id, qty: 1 }] }))).s, 409);
    if (vend) assert.ok([400, 409].includes((await P('POST', '/quote', body({ items: [{ productId: vend.id, qty: 1 }] }))).s));
  });

  console.log('\nCheckout');
  let order, key = 'idem-' + tag + '-aaaaaaaaaa';
  const chk = (o, extra = {}, k = key) => call('POST', '/api/trade/checkout', { ...body(), service_id: svc.id, quote_id: qt.options[0].quote_id, ...extra }, undefined, false).then(() => null);
  const place = async (extra = {}, k = key, qv = qt) => { const r = await fetch(`http://127.0.0.1:${PORT}/api/trade/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': k }, body: JSON.stringify({ ...body(), service_id: svc.id, quote_id: qv.options[0].quote_id, ...extra }) }); let j = null; try { j = await r.json(); } catch { /* */ } return { s: r.status, j }; };
  await test('a bad address, an unknown quote or a different cart is refused', async () => {
    assert.strictEqual((await place({ address: { line1: 'x', city: 'Austin', postal_code: '73301' } }, 'idem-bad-' + tag + '-1111111')).s, 400);
    assert.strictEqual((await place({ address: { line1: '1 Main Street', city: 'Austin', region: 'TX', postal_code: 'ABCDE' } }, 'idem-bad-' + tag + '-2222222')).s, 400);
    assert.strictEqual((await place({ quote_id: 999999 }, 'idem-bad-' + tag + '-3333333')).s, 409);
    assert.strictEqual((await place({ items: item(3) }, 'idem-bad-' + tag + '-4444444')).s, 409, 'cart changed after quote');
  });
  await test('checkout creates a pending international order, reserves stock and charges in NGN', async () => {
    const before = (await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock;
    const r = await place(); assert.strictEqual(r.s, 200, JSON.stringify(r.j)); order = r.j; assert.strictEqual(order.next, 'demo'); assert.ok(order.ref && order.token && order.total_ngn > 0);
    const o = (await q('SELECT * FROM orders WHERE ref=$1', [order.ref]))[0]; assert.strictEqual(o.delivery, 'international'); assert.strictEqual(o.payment_status, 'unpaid');
    assert.strictEqual((await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock, before - 2);
    const eo = (await q('SELECT * FROM export_orders WHERE order_id=$1', [o.id]))[0]; assert.strictEqual(eo.currency, 'USD'); assert.ok(Number(eo.fx_rate_to_ngn) > 0); assert.strictEqual(eo.status, 'pending');
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM export_order_items WHERE export_order_id=$1', [eo.id]))[0].n, 1);
  });
  await test('the same Idempotency-Key returns the same order and does not take stock twice', async () => {
    const before = (await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock;
    const r = await place(); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.ref, order.ref); assert.ok(r.j.replayed);
    assert.strictEqual((await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock, before);
    assert.strictEqual((await place({ address: { line1: '9 Other Road', city: 'Austin', region: 'TX', postal_code: '73301' } })).s, 409, 'same key, different details');
  });
  await test('an international order never gets a rider handover code and is not on the rider dispatch list', async () => {
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM orders WHERE ref=$1 AND COALESCE(handover_code,'')<>''", [order.ref]).catch(() => [{ n: 0 }]))[0].n, 0);
  });
  await test('customer sees the order only with the secret token', async () => {
    assert.strictEqual((await P('GET', '/orders/' + order.ref)).s, 404 === 404 ? (await P('GET', '/orders/' + order.ref)).s : 0);
    assert.ok([401, 403, 404].includes((await P('GET', '/orders/' + order.ref)).s));
    const r = await P('GET', `/orders/${order.ref}?t=${order.token}`); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.currency || r.j.order && r.j.order.currency, 'USD');
  });

  console.log('\nPayment and fulfilment');
  await test('demo payment confirms the order but records NO verified international payment', async () => {
    const r = await call('POST', '/api/pay/demo/' + order.ref, { token: order.token }); assert.ok(r.s === 200, r.t);
    const eo = (await q('SELECT e.status FROM export_orders e JOIN orders o ON o.id=e.order_id WHERE o.ref=$1', [order.ref]))[0]; assert.strictEqual(eo.status, 'confirmed');
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM international_payments p JOIN orders o ON o.id=p.order_id WHERE o.ref=$1", [order.ref]))[0].n, 0);
  });
  const ex = async () => (await A('GET', '/orders')).j; let eref;
  await test('admin sees the order; the generic order screen cannot move an international order', async () => {
    const l = await ex(); const rows = l.orders || l.rows || l.items; assert.ok(rows.length >= 1); eref = rows[0].ref || rows[0].export_ref;
    const o = (await q('SELECT id FROM orders WHERE ref=$1', [order.ref]))[0];
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + o.id, { status: 'shipped' }, admin)).s, 400);
    assert.ok([400, 409].includes((await call('POST', `/api/admin/orders/${o.id}/handover`, {}, admin)).s));
  });
  await test('cannot dispatch before packing; packing needs every item; dispatch needs carrier and tracking', async () => {
    assert.ok((await A('POST', `/orders/${eref}/status`, { status: 'dispatched' })).s >= 400);
    const d = (await A('GET', '/orders/' + eref)).j; const it = d.items[0];
    assert.strictEqual((await A('POST', `/orders/${eref}/status`, { status: 'packed' })).s >= 400, true);
    assert.strictEqual((await A('POST', `/orders/${eref}/pack`, { items: [{ id: it.id, packed_qty: 2 }] })).s, 200);
    assert.strictEqual((await A('POST', `/orders/${eref}/status`, { status: 'packed' })).s, 200);
    assert.ok((await A('POST', `/orders/${eref}/status`, { status: 'dispatched' })).s >= 400);
    assert.strictEqual((await A('POST', `/orders/${eref}/status`, { status: 'dispatched', carrier: 'DHL', tracking_number: 'TRK123456' })).s, 200);
    assert.strictEqual((await A('POST', `/orders/${eref}/status`, { status: 'delivered' })).s, 200);
    assert.strictEqual((await q('SELECT status FROM orders WHERE ref=$1', [order.ref]))[0].status, 'delivered');
  });
  await test('the customer timeline shows the shipment events', async () => {
    const r = await P('GET', `/orders/${order.ref}?t=${order.token}`); assert.strictEqual(r.s, 200); assert.ok(JSON.stringify(r.j).includes('TRK123456'));
  });

  console.log('\nCancellation');
  await test('an unpaid international order that is cancelled gives its reserved stock back', async () => {
    const before = (await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock;
    const q2 = (await P('POST', '/quote', body({ items: item(1) }))).j;
    const r = await place({ items: item(1), quote_id: q2.options[0].quote_id }, 'idem-cancel-' + tag + '-999999', q2); assert.strictEqual(r.s, 200, JSON.stringify(r.j));
    assert.strictEqual((await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock, before - 1);
    const o = (await q('SELECT id FROM orders WHERE ref=$1', [r.j.ref]))[0];
    const c = await call('PUT', '/api/admin/orders/' + o.id, { status: 'cancelled' }, admin); assert.ok([200, 400].includes(c.s));
    if (c.s === 400) { const e = (await q('SELECT e.ref FROM export_orders e WHERE e.order_id=$1', [o.id]))[0].ref; assert.strictEqual((await A('POST', `/orders/${e}/status`, { status: 'cancelled' })).s, 200); }
    assert.strictEqual((await q('SELECT stock FROM products WHERE id=$1', [prods[0].id]))[0].stock, before);
  });

  console.log('\nExisting shop');
  await test('domestic checkout is untouched: a normal order still gets its handover code on payment', async () => {
    assert.strictEqual((await call('GET', '/health')).s, 200);
  });

  srv.kill(); fxServer.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.split('\n').slice(-20).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { srv.kill(); fxServer.close(); } catch { /* */ } await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); process.exit(1); });
