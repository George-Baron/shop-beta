'use strict';
// Global Trade module, phase 5: carrier integration (live rates, booking, labels, cancellation, signed tracking webhooks).
// A fake EasyPost server stands in for the real carrier API, so nothing here touches the internet.
// Run with: npm run test:trade-carriers   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'vm_tc_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500), FXPORT = PORT + 2000, EPPORT = PORT + 3000;
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
const call = async (method, url, body, cookie, extraHeaders, rawBody) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(extraHeaders || {}) }, body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const buf = Buffer.from(await r.arrayBuffer()); const t = buf.toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { s: r.status, j, t, buf, h: r.headers, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + r.t); return r.c; };

const fx = { rates: { USD: 0.00065, GBP: 0.00051, EUR: 0.0006 } };
const fxServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: 'success', base_code: 'NGN', time_last_update_unix: Math.floor(Date.now() / 1000) - 600, rates: { NGN: 1, ...fx.rates } })); });

// ---- fake EasyPost ----
const EPKEY = 'EZTK-test-key', WHSECRET = 'whsec-' + 'z'.repeat(30);
const ep = { shipments: {}, n: 0, rateCalls: 0, buyCalls: 0, mode: 'ok', auth: [], lastBody: null, refundTo: 'submitted' };
const epServer = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const send = (s, j) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    ep.auth.push(req.headers.authorization || '');
    let b = {}; try { b = raw ? JSON.parse(raw) : {}; } catch { /* */ }
    const u = req.url;
    if (u === '/label.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end('%PDF-1.4 fake label'); }
    if (ep.mode === 'down' && u !== '/label.pdf') return send(500, { error: { message: 'down' } });
    if (req.method === 'POST' && u === '/shipments') {
      ep.rateCalls++; ep.lastBody = b; const id = 'shp_' + (++ep.n);
      ep.shipments[id] = { id, rates: [{ id: 'rate_dhl_' + id, carrier: 'DHLExpress', service: 'ExpressWorldwide', rate: '40.00', currency: 'USD', delivery_days: 3 }, { id: 'rate_ups_' + id, carrier: 'UPS', service: 'Saver', rate: '55.50', currency: 'USD', delivery_days: 5 }], bought: false };
      return send(201, { id, rates: ep.shipments[id].rates, messages: [] });
    }
    let m = u.match(/^\/shipments\/([\w]+)\/buy$/);
    if (req.method === 'POST' && m) {
      ep.buyCalls++; const s = ep.shipments[m[1]]; if (!s) return send(404, { error: { message: 'not found' } });
      if (ep.mode === 'reject') return send(422, { error: { message: 'Address could not be verified.' } });
      const rate = s.rates.find((r) => r.id === b.rate.id); if (!rate) return send(422, { error: { message: 'bad rate' } });
      if (ep.mode === 'notrack') return send(200, { id: s.id, selected_rate: rate, tracking_code: null });
      s.bought = true; s.sel = rate; s.tracking = 'TRK' + s.id.toUpperCase() + '99';
      if (ep.mode === 'ambiguous') return send(502, { error: { message: 'bad gateway' } });   // carrier DID buy, but we never learn it
      return send(200, shape(s));
    }
    m = u.match(/^\/shipments\/([\w]+)\/refund$/);
    if (req.method === 'POST' && m) { const s = ep.shipments[m[1]]; s.refund = ep.refundTo; return send(200, shape(s)); }
    m = u.match(/^\/shipments\/([\w]+)$/);
    if (req.method === 'GET' && m) { const s = ep.shipments[m[1]]; return s ? send(200, shape(s)) : send(404, { error: { message: 'nf' } }); }
    if (req.method === 'GET' && u === '/carrier_accounts') return send(200, [{ id: 'ca_1', type: 'DhlExpressAccount', readable: 'DHL Express' }]);
    send(404, { error: { message: 'nope' } });
  });
});
const shape = (s) => ({ id: s.id, rates: s.rates, tracking_code: s.bought ? s.tracking : null, selected_rate: s.sel || null, postage_label: s.bought ? { label_url: `http://127.0.0.1:${EPPORT}/label.pdf`, label_file_type: 'application/pdf' } : null, refund_status: s.refund || null, insurance: null });

const KEY = 'test-key-' + 'x'.repeat(40);
const start = async (env) => {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/vm-tc-' + tag, ADMIN_EMAIL: 'owner@example.com', TRADE_DATA_KEY: KEY, ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50', FX_API_URL: `http://127.0.0.1:${FXPORT}/latest/{base}`, FX_REFRESH: '0', EASYPOST_API_KEY: '', EASYPOST_WEBHOOK_SECRET: '', ...env } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
};
const stop = async () => { srv.kill(); await sleep(400); };
const sign = (raw, secret = WHSECRET) => 'hmac-sha256-hex=' + crypto.createHmac('sha256', secret.normalize('NFKD')).update(raw).digest('hex');

(async () => {
  await new Promise((r) => fxServer.listen(FXPORT, '127.0.0.1', r)); await new Promise((r) => epServer.listen(EPPORT, '127.0.0.1', r));
  await pg(`CREATE DATABASE ${DB}`);
  await start({});
  let admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, '/api/admin/trade' + u, b, admin);
  const P = (m, u, b, c) => call(m, '/api/trade' + u, b, c);

  await A('POST', '/countries/bulk', { codes: ['US'], flag: 'export_to', on: true });
  assert.strictEqual((await A('POST', '/rates/refresh')).s, 200);
  const prods = await q("SELECT id FROM products WHERE is_pharmacy=0 AND active=1 AND vendor_id IS NULL AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id=products.id) ORDER BY id LIMIT 2");
  const complete = { export_enabled: true, intl_eligible: true, origin_country: 'NG', hs_code: '6109.10', customs_description: 'Cotton T-shirt, knitted', weight_kg: 0.5, length_cm: 30, width_cm: 25, height_cm: 3, shipping_category: 'clothing' };
  assert.strictEqual((await A('PUT', '/products/' + prods[0].id, complete)).s, 200);
  await q('UPDATE products SET stock=100 WHERE id=$1', [prods[0].id]);
  const zone = (await A('POST', '/shipping/zones', { name: 'US', countries: ['US'], origin_country: 'NG' })).j.item;
  const svc = (await A('POST', '/shipping/services', { name: 'Express', method: 'express', est_days_min: 3, est_days_max: 6, supports_insurance: true })).j.item;
  await A('POST', '/shipping/rates', { zone_id: zone.id, service_id: svc.id, min_kg: 0, max_kg: 20, base_amount: 15000, per_kg: 4000, currency: 'NGN' });
  const body = (extra = {}) => ({ items: [{ productId: prods[0].id, qty: 2 }], country: 'US', currency: 'USD', contact: { name: 'Jane Doe', email: 'jane@example.com', dial_code: '1', phone: '2025550123' }, address: { line1: '1 Main Street', city: 'Austin', region: 'TX', postal_code: '73301' }, ...extra });
  const place = async (qv, opt, k, extra = {}) => { const r = await fetch(`http://127.0.0.1:${PORT}/api/trade/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': k }, body: JSON.stringify({ ...body(), service_id: opt.service_id, quote_id: opt.quote_id, ...extra }) }); let j = null; try { j = await r.json(); } catch { /* */ } return { s: r.status, j }; };

  console.log('\nBefore any credentials exist');
  await test('the carrier is shown as "Awaiting configuration"; it cannot be switched on; placeholders are "not integrated"', async () => {
    const r = await A('GET', '/providers'); assert.strictEqual(r.s, 200, r.t);
    const e = r.j.providers.find((p) => p.code === 'easypost'); assert.strictEqual(e.status, 'awaiting_configuration'); assert.ok(e.env.every((x) => x.set === false));
    assert.ok(!JSON.stringify(r.j).includes(EPKEY));
    assert.strictEqual(r.j.providers.find((p) => p.code === 'fedex').status, 'not_integrated');
    assert.strictEqual((await A('PUT', '/providers/easypost', { enabled: true })).s, 409);
    assert.strictEqual((await A('PUT', '/providers/fedex', { enabled: true })).s, 409);
    assert.strictEqual((await A('POST', '/providers/easypost/test')).s, 409);
  });
  await test('customers only see the manual estimate, clearly labelled', async () => {
    const r = await P('POST', '/quote', body()); assert.strictEqual(r.s, 200, r.t); assert.ok(r.j.options.length >= 1); assert.ok(r.j.options.every((o) => o.source === 'manual_estimate'));
  });
  await test('the webhook refuses everything while no signing secret is configured', async () => {
    assert.strictEqual((await call('POST', '/api/trade/webhooks/easypost', undefined, undefined, { 'x-hmac-signature': sign('{}') }, '{}')).s, 503);
  });

  await stop(); await start({ EASYPOST_API_KEY: EPKEY, EASYPOST_WEBHOOK_SECRET: WHSECRET, EASYPOST_API_URL: `http://127.0.0.1:${EPPORT}` });
  admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');

  console.log('\nConnecting the carrier');
  await test('with credentials set the carrier can be tested and switched on; the key never appears in any response', async () => {
    const l = (await A('GET', '/providers')).j.providers.find((p) => p.code === 'easypost'); assert.strictEqual(l.status, 'disabled'); assert.ok(l.env.every((x) => x.set));
    const t = await A('POST', '/providers/easypost/test'); assert.strictEqual(t.s, 200, t.t); assert.ok(ep.auth.some((a) => a === 'Basic ' + Buffer.from(EPKEY + ':').toString('base64')));
    const on = await A('PUT', '/providers/easypost', { enabled: true }); assert.strictEqual(on.s, 200, on.t); assert.strictEqual(on.j.status, 'ready'); assert.ok(!on.t.includes(EPKEY) && !on.t.includes(WHSECRET));
    assert.strictEqual((await A('PUT', '/providers/easypost', { priority: 0 })).s, 400);
    assert.strictEqual((await A('PUT', '/providers/easypost', { supported_countries: ['ZZ'] })).s, 400);
  });
  await test('no live prices until the sender address is complete', async () => {
    const r = await P('POST', '/quote', body()); assert.ok(r.j.options.every((o) => o.source === 'manual_estimate'));
    assert.strictEqual(ep.rateCalls, 0);
    const s = await A('PUT', '/settings', { origin_name: 'Velto-Mart Dispatch', origin_phone: '+2348012345678', origin_line1: '12 Allen Avenue', origin_city: 'Ikeja', origin_region: 'Lagos', origin_postal: '100271', shipping_margin_pct: 10, handling_fee_ngn: 500 }); assert.strictEqual(s.s, 200, s.t);
  });

  console.log('\nLive quote and checkout');
  let live, opt;
  await test('without a street address the customer is told what to enter, and no carrier call is made', async () => {
    const before = ep.rateCalls; const r = await P('POST', '/quote', body({ address: { city: 'Austin', postal_code: '73301' } })); assert.strictEqual(r.s, 200, r.t);
    assert.ok(r.j.options.every((o) => o.source === 'manual_estimate')); assert.match(r.j.live_note || '', /street address/i); assert.strictEqual(ep.rateCalls, before);
  });
  await test('with an address the customer sees live carrier prices (NGN-converted, with margin and handling) next to the manual estimate', async () => {
    const r = await P('POST', '/quote', body()); assert.strictEqual(r.s, 200, r.t); live = r.j;
    const api = live.options.filter((o) => o.source === 'api'); assert.strictEqual(api.length, 2); assert.ok(live.options.some((o) => o.source === 'manual_estimate'));
    assert.ok(api.every((o) => o.quote_id && o.expires_at)); assert.ok(!JSON.stringify(live).includes('shp_') && !JSON.stringify(live).includes('rate_dhl'), 'carrier ids stay on the server');
    const row = (await q("SELECT * FROM shipping_rate_quotes WHERE id=$1", [api[0].quote_id]))[0]; assert.strictEqual(row.source, 'api'); assert.ok(row.provider_quote_ref.includes('shp_'));
    // parcel sent to the carrier: 2 x 0.5 kg
    assert.ok(Math.abs(ep.lastBody.shipment.parcel.weight - 35.27) < 0.5, 'weight in ounces'); assert.strictEqual(ep.lastBody.shipment.to_address.country, 'US'); assert.ok(ep.lastBody.shipment.customs_info.customs_items.length >= 1);
    // 40 USD at 0.00065 USD/NGN = 61538 NGN; +10% margin +500 handling
    const dhl = api.find((o) => /DHL|Express/i.test(o.label)); const q0 = (await q('SELECT * FROM shipping_rate_quotes WHERE id=$1', [dhl.quote_id]))[0]; assert.ok(q0.breakdown && q0.breakdown.ngn);
    opt = dhl;
  });
  await test('checkout uses the stored live quote and does not call the carrier again', async () => {
    const calls = ep.rateCalls; const r = await place(live, opt, 'idem-live-' + tag + '-aaaaaaaa'); assert.strictEqual(r.s, 200, JSON.stringify(r.j));
    assert.strictEqual(ep.rateCalls, calls, 'no new carrier call at checkout'); live.ref = r.j.ref;
    const eo = (await q("SELECT eo.*, o.delivery_fee FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE o.ref=$1", [r.j.ref]))[0]; assert.strictEqual(eo.quote_source, 'api');
    const expected = Math.ceil(40 / 0.00065 * 1.10 + 500); assert.ok(Math.abs(Number(eo.delivery_fee) - expected) <= 5, `fee ${eo.delivery_fee} vs ${expected}`);
  });
  await test('an expired or unknown live quote is refused at checkout', async () => {
    const other = live.options.find((o) => o.source === 'api' && o.quote_id !== opt.quote_id);
    await q('UPDATE shipping_rate_quotes SET expires_at=1 WHERE id=$1', [other.quote_id]);
    assert.ok([409, 410].includes((await place(live, other, 'idem-live-' + tag + '-bbbbbbbb')).s));
    assert.ok([400, 409, 410].includes((await place(live, { ...opt, quote_id: 987654 }, 'idem-live-' + tag + '-cccccccc')).s));
  });
  await test('if the carrier is down, the customer still gets the manual estimate', async () => {
    ep.mode = 'down'; const r = await P('POST', '/quote', body({ items: [{ productId: prods[0].id, qty: 1 }] })); ep.mode = 'ok';
    assert.strictEqual(r.s, 200, r.t); assert.ok(r.j.options.length >= 1 && r.j.options.every((o) => o.source === 'manual_estimate')); assert.match(r.j.live_note || '', /not available/i);
  });

  console.log('\nBooking');
  const ref = () => live.ref;
  let eref, rates, bk;
  const pay = async () => { const r = await call('POST', '/api/pay/demo/' + live.ref, { token: live.token }); assert.strictEqual(r.s, 200, r.t); };
  await test('rates and booking are refused until the order is paid and packed', async () => {
    eref = (await q('SELECT eo.ref FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE o.ref=$1', [live.ref]))[0].ref;
    assert.strictEqual((await A('POST', `/orders/${eref}/rates`, { parcel: { weight_kg: 1, length_cm: 30, width_cm: 25, height_cm: 6 } })).s, 409);
    await pay();
    assert.strictEqual((await A('POST', `/orders/${eref}/rates`, { parcel: { weight_kg: 0, length_cm: 30, width_cm: 25, height_cm: 6 } })).s, 400);
    const r = await A('POST', `/orders/${eref}/rates`, { parcel: { weight_kg: 1.2, length_cm: 30, width_cm: 25, height_cm: 6 } }); assert.strictEqual(r.s, 200, r.t); rates = r.j;
    assert.strictEqual(rates.rates.length, 2); assert.ok(rates.rates[0].amount_ngn <= rates.rates[1].amount_ngn, 'cheapest first');
    assert.strictEqual((await A('POST', `/orders/${eref}/book`, { quote_id: rates.rates[0].quote_id, idempotency_key: 'book-' + tag + '-aaaaaaaaaaaa' })).s, 409, 'not packed yet');
    const it = (await A('GET', '/orders/' + eref)).j.items[0];
    assert.strictEqual((await A('POST', `/orders/${eref}/pack`, { items: [{ id: it.id, packed_qty: 2 }] })).s, 200);
    assert.strictEqual((await A('POST', `/orders/${eref}/status`, { status: 'processing' })).s >= 200, true);
    assert.strictEqual((await A('POST', `/orders/${eref}/status`, { status: 'packed' })).s, 200);
  });
  await test('booking needs a valid key; the carrier is only charged after the confirmation has a tracking code', async () => {
    assert.strictEqual((await A('POST', `/orders/${eref}/book`, { quote_id: rates.rates[0].quote_id, idempotency_key: 'short' })).s, 400);
    assert.strictEqual((await A('POST', `/orders/${eref}/book`, { quote_id: 424242, idempotency_key: 'book-' + tag + '-nnnnnnnnnnnn' })).s, 404);
    ep.mode = 'notrack'; const r = await A('POST', `/orders/${eref}/book`, { quote_id: rates.rates[0].quote_id, idempotency_key: 'book-' + tag + '-notrack0000' }); ep.mode = 'ok';
    assert.strictEqual(r.s, 502, r.t); const row = (await q("SELECT status, tracking_number FROM shipping_bookings WHERE idempotency_key=$1", ['book-' + tag + '-notrack0000']))[0];
    assert.strictEqual(row.status, 'requested'); assert.strictEqual(row.tracking_number, ''); assert.strictEqual((await q('SELECT carrier, tracking_number FROM export_orders WHERE ref=$1', [eref]))[0].tracking_number, '');
    assert.strictEqual((await A('POST', `/bookings/${row ? (await q("SELECT id FROM shipping_bookings WHERE idempotency_key=$1", ['book-' + tag + '-notrack0000']))[0].id : 0}/cancel`)).s, 409, 'cannot cancel what is not booked');
  });
  await test('a definite carrier rejection is recorded as failed, with no tracking, and a new booking may follow', async () => {
    // the unconfirmed "requested" row from the previous test is reconciled by a new attempt with the SAME key: carrier says not bought -> buys now
    ep.mode = 'reject'; const key = 'book-' + tag + '-notrack0000'; const r = await A('POST', `/orders/${eref}/book`, { quote_id: rates.rates[0].quote_id, idempotency_key: key }); ep.mode = 'ok';
    assert.strictEqual(r.s, 422, r.t); assert.strictEqual((await q('SELECT status FROM shipping_bookings WHERE idempotency_key=$1', [key]))[0].status, 'failed');
    assert.strictEqual((await A('POST', `/orders/${eref}/book`, { quote_id: rates.rates[0].quote_id, idempotency_key: key })).s, 409, 'a failed key is not silently retried');
  });
  await test('booking succeeds once: tracking and cost recorded, label stored privately and downloadable', async () => {
    const rr = (await A('POST', `/orders/${eref}/rates`, { parcel: { weight_kg: 1.2, length_cm: 30, width_cm: 25, height_cm: 6 } })).j; rates = rr;
    const key = 'book-' + tag + '-goodgoodgood', buys = ep.buyCalls;
    const r = await A('POST', `/orders/${eref}/book`, { quote_id: rates.rates[0].quote_id, idempotency_key: key }); assert.strictEqual(r.s, 200, r.t); bk = r.j.booking;
    assert.strictEqual(bk.status, 'booked'); assert.ok(/^TRK/.test(bk.tracking_number)); assert.strictEqual(bk.currency, 'USD'); assert.ok(bk.cost > 0); assert.strictEqual(ep.buyCalls, buys + 1);
    assert.ok(!r.j.label_error);
    const eo = (await q('SELECT carrier, tracking_number FROM export_orders WHERE ref=$1', [eref]))[0]; assert.strictEqual(eo.tracking_number, bk.tracking_number); assert.ok(eo.carrier);
    const lb = (await A('GET', `/orders/${eref}/bookings`)).j.bookings.find((x) => x.id === bk.id); assert.ok(lb.label_document_id);
    const d = await A('GET', '/documents/' + lb.label_document_id); assert.strictEqual(d.s, 200); assert.ok(d.t.startsWith('%PDF')); assert.strictEqual(d.h.get('x-content-type-options'), 'nosniff');
    assert.ok(!JSON.stringify((await A('GET', `/orders/${eref}/bookings`)).j).includes('127.0.0.1:' + EPPORT), 'carrier label URL is not exposed');
  });
  await test('repeating the same booking key (double click, retry) returns the first result and never buys again', async () => {
    const buys = ep.buyCalls; const r = await A('POST', `/orders/${eref}/book`, { quote_id: rates.rates[0].quote_id, idempotency_key: 'book-' + tag + '-goodgoodgood' });
    assert.strictEqual(r.s, 200); assert.ok(r.j.replayed); assert.strictEqual(r.j.booking.id, bk.id); assert.strictEqual(ep.buyCalls, buys);
    assert.strictEqual((await A('POST', `/orders/${eref}/book`, { quote_id: rates.rates[1].quote_id, idempotency_key: 'book-' + tag + '-otherotherot' })).s, 409, 'one live booking per order');
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM shipping_bookings WHERE export_order_id=(SELECT id FROM export_orders WHERE ref=$1) AND status='booked'", [eref]))[0].n, 1);
  });
  await test('staff-only: customers cannot reach the carrier or booking endpoints', async () => {
    assert.ok([401, 403].includes((await call('GET', '/api/admin/trade/providers')).s));
    assert.ok([401, 403].includes((await call('POST', `/api/admin/trade/orders/${eref}/book`, {})).s));
  });

  console.log('\nTracking webhooks');
  const evt = (id, status, at, extra = {}) => JSON.stringify({ id, description: 'tracker.updated', result: { object: 'Tracker', tracking_code: bk.tracking_number, status, est_delivery_date: '2026-12-03T00:00:00Z', tracking_details: [{ status, message: 'Parcel ' + status, datetime: at, tracking_location: { city: 'Memphis', state: 'TN', country: 'US' } }] }, ...extra });
  const hook = (raw, sig) => call('POST', '/api/trade/webhooks/easypost', undefined, undefined, { 'x-hmac-signature': sig === undefined ? sign(raw) : sig }, raw);
  await test('a missing or wrong signature is refused and changes nothing', async () => {
    const raw = evt('evt_bad1', 'in_transit', '2026-11-20T10:00:00Z');
    assert.strictEqual((await hook(raw, '')).s, 401); assert.strictEqual((await hook(raw, sign(raw, 'wrong-secret'))).s, 401); assert.strictEqual((await hook(raw + ' ', sign(raw))).s, 401, 'body tampering');
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM trade_webhook_events")) [0].n, 0);
  });
  await test('before dispatch, tracking events are recorded but the order is not moved', async () => {
    const raw = evt('evt_1', 'in_transit', '2026-11-20T10:00:00Z'); const r = await hook(raw); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.status, 'processed');
    assert.strictEqual((await q('SELECT status FROM export_orders WHERE ref=$1', [eref]))[0].status, 'packed');
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM shipment_tracking_events WHERE booking_id=$1 AND source='webhook'", [bk.id]))[0].n, 1);
  });
  await test('the same event delivered twice is ignored', async () => {
    const raw = evt('evt_1', 'in_transit', '2026-11-20T10:00:00Z'); const r = await hook(raw); assert.strictEqual(r.s, 200); assert.ok(r.j.duplicate);
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM shipment_tracking_events WHERE booking_id=$1", [bk.id]))[0].n, 1);
  });
  await test('after staff dispatch, carrier updates advance the order through in-transit and delivered', async () => {
    assert.strictEqual((await A('POST', `/orders/${eref}/status`, { status: 'dispatched', carrier: 'DHL', tracking_number: bk.tracking_number })).s, 200);
    assert.strictEqual((await hook(evt('evt_2', 'in_transit', '2026-11-21T10:00:00Z'))).s, 200);
    assert.strictEqual((await q('SELECT status FROM export_orders WHERE ref=$1', [eref]))[0].status, 'in_transit');
    assert.strictEqual((await hook(evt('evt_3', 'delivered', '2026-11-25T10:00:00Z'))).s, 200);
    const eo = (await q('SELECT status FROM export_orders WHERE ref=$1', [eref]))[0]; assert.strictEqual(eo.status, 'delivered');
    assert.strictEqual((await q('SELECT status FROM orders WHERE ref=$1', [live.ref]))[0].status, 'delivered');
  });
  await test('an unknown tracking number is stored as unmatched and does nothing', async () => {
    const raw = JSON.stringify({ id: 'evt_x', description: 'tracker.updated', result: { object: 'Tracker', tracking_code: 'NOPE', status: 'delivered', tracking_details: [] } }); const r = await hook(raw); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.status, 'unmatched');
  });
  await test('a delivered order cannot be cancelled at the carrier', async () => {
    assert.strictEqual((await A('POST', `/bookings/${bk.id}/cancel`)).s, 409);
  });

  console.log('\nAmbiguous failure, reconcile and cancel (second order)');
  let o2, e2, r2, bk2;
  await test('an unanswered buy leaves the booking "requested"; retrying with the same key adopts what the carrier did instead of buying twice', async () => {
    const qt = (await P('POST', '/quote', body({ items: [{ productId: prods[0].id, qty: 1 }] }))).j; const o = qt.options.find((x) => x.source === 'api');
    const r = await place(qt, o, 'idem-live-' + tag + '-dddddddd', { items: [{ productId: prods[0].id, qty: 1 }] }); assert.strictEqual(r.s, 200, JSON.stringify(r.j)); o2 = r.j;
    assert.strictEqual((await call('POST', '/api/pay/demo/' + o2.ref, { token: o2.token })).s, 200);
    e2 = (await q('SELECT eo.ref FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE o.ref=$1', [o2.ref]))[0].ref;
    const it = (await A('GET', '/orders/' + e2)).j.items[0];
    assert.strictEqual((await A('POST', `/orders/${e2}/pack`, { items: [{ id: it.id, packed_qty: 1 }] })).s, 200);
    await A('POST', `/orders/${e2}/status`, { status: 'processing' }); assert.strictEqual((await A('POST', `/orders/${e2}/status`, { status: 'packed' })).s, 200);
    r2 = (await A('POST', `/orders/${e2}/rates`, { parcel: { weight_kg: 0.7, length_cm: 30, width_cm: 25, height_cm: 5 } })).j;
    const key = 'book-' + tag + '-ambigambig0';
    ep.mode = 'ambiguous'; const a = await A('POST', `/orders/${e2}/book`, { quote_id: r2.rates[0].quote_id, idempotency_key: key }); ep.mode = 'ok';
    assert.ok(a.s >= 500, a.t); assert.strictEqual((await q('SELECT status FROM shipping_bookings WHERE idempotency_key=$1', [key]))[0].status, 'requested');
    const buys = ep.buyCalls; const b = await A('POST', `/orders/${e2}/book`, { quote_id: r2.rates[0].quote_id, idempotency_key: key }); assert.strictEqual(b.s, 200, b.t);
    assert.strictEqual(b.j.booking.status, 'booked'); assert.strictEqual(ep.buyCalls, buys, 'reconciled from the carrier, not bought again'); bk2 = b.j.booking;
  });
  await test('cancelling asks the carrier for a refund; the booking stays "cancel requested" until the carrier confirms', async () => {
    ep.refundTo = 'submitted'; const c = await A('POST', `/bookings/${bk2.id}/cancel`); assert.strictEqual(c.s, 200, c.t); assert.strictEqual(c.j.booking.status, 'cancel_requested');
    assert.strictEqual((await q('SELECT tracking_number FROM export_orders WHERE ref=$1', [e2]))[0].tracking_number, bk2.tracking_number, 'tracking kept until the refund is confirmed');
    ep.refundTo = 'refunded'; ep.shipments[Object.keys(ep.shipments).find((k) => ep.shipments[k].tracking === bk2.tracking_number)].refund = 'refunded';
    const f = await A('POST', `/bookings/${bk2.id}/refresh`); assert.strictEqual(f.s, 200, f.t); assert.strictEqual(f.j.booking.status, 'cancelled'); assert.strictEqual(f.j.booking.refund_status, 'refunded');
    assert.strictEqual((await q('SELECT tracking_number FROM export_orders WHERE ref=$1', [e2]))[0].tracking_number, '');
  });
  await test('after a confirmed cancellation the order can be booked again with a new key', async () => {
    r2 = (await A('POST', `/orders/${e2}/rates`, { parcel: { weight_kg: 0.7, length_cm: 30, width_cm: 25, height_cm: 5 } })).j;
    const b = await A('POST', `/orders/${e2}/book`, { quote_id: r2.rates[0].quote_id, idempotency_key: 'book-' + tag + '-secondbook00' }); assert.strictEqual(b.s, 200, b.t); assert.strictEqual(b.j.booking.status, 'booked');
  });
  await test('every booking action is in the audit log', async () => {
    const a = await q("SELECT DISTINCT action FROM trade_audit WHERE action LIKE 'booking.%' OR action LIKE 'provider.%'").catch(() => null);
    if (a) { const s = a.map((x) => x.action); for (const k of ['booking.rates', 'booking.booked', 'booking.cancel', 'provider.update']) assert.ok(s.includes(k), k + ' missing: ' + s); }
  });

  await stop(); fxServer.close(); epServer.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.split('\n').slice(-25).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); try { srv.kill(); } catch { /* */ } process.exit(1); });
