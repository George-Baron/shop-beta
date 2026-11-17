'use strict';
// Countries, shipping zones, currencies, tax, restrictions, Stripe and Paystack in other currencies, the automatic rate feed.
// Run with: npm run test:trade   (needs TEST_DATABASE_URL like the main test). Paystack, Stripe and the rate feed are fake servers started here.
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { Client: Pg } = require('pg');
const CUR = require('../lib/currency');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_trade_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1000), FAKE = PORT + 2000, WH = 'whsec_trade_test';
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(200); } };
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '', SEQ = 0;
const call = async (method, url, body, cookie, headers = {}) => {
  const raw = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  if (process.env.DEBUG_V && r.status >= 400) console.log('   [' + r.status + '] ' + method + ' ' + url + ' ' + t.slice(0, 300));
  return { s: r.status, j, t, c: (sc[0] || '').split(';')[0] };
};

/* ---- fake Paystack, Stripe and exchange-rate feed ---- */
const fx = { pay: {}, payOverride: null, stripe: {}, n: 0, feed: {}, feedHits: 0 };
const fake = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const body = Buffer.concat(c).toString(); const send = (s, o) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/transaction/initialize') { const j = JSON.parse(body); fx.pay[j.reference] = { amount: j.amount, currency: j.currency }; return send(200, { status: true, data: { authorization_url: 'http://pay.test/' + j.reference } }); }
    let m = /^\/transaction\/verify\/(.+)$/.exec(req.url);
    if (m) { const ref = decodeURIComponent(m[1]), p = fx.pay[ref] || {}; return send(200, { status: true, data: { status: 'success', reference: ref, amount: p.amount, currency: p.currency, ...(fx.payOverride || {}) } }); }
    if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
      const f = new URLSearchParams(body), id = 'cs_test_' + (++fx.n);
      fx.stripe[id] = { id, client_reference_id: f.get('client_reference_id'), currency: f.get('line_items[0][price_data][currency]'), amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), payment_status: 'unpaid', payment_intent: 'pi_' + id };
      return send(200, { id, url: 'https://checkout.stripe.test/' + id });
    }
    m = /^\/v1\/checkout\/sessions\/(.+)$/.exec(req.url);
    if (m && req.method === 'GET') { const s = fx.stripe[decodeURIComponent(m[1])]; return s ? send(200, s) : send(404, { error: { message: 'No such session' } }); }
    if (req.url === '/feed') { fx.feedHits++; return send(200, { result: 'success', rates: fx.feed }); }
    send(404, {});
  });
});

const sig = (raw, secret = WH, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')}`;

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-trade-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50',
    PAYSTACK_SECRET_KEY: 'sk_test_trade', PAYSTACK_API_URL: 'http://127.0.0.1:' + FAKE, STRIPE_ENABLED: '1', STRIPE_SECRET_KEY: 'sk_test_stripe', STRIPE_API_URL: 'http://127.0.0.1:' + FAKE, STRIPE_WEBHOOK_SECRET: WH, FX_FEED_ENABLED: '1', FX_FEED_URL: 'http://127.0.0.1:' + FAKE + '/feed' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' })).c;
  const A = (m, u, b) => call(m, u, b, admin), RG = (m, u, b) => A(m, '/api/admin/dropship/regions' + u, b);
  const prod = (await q("SELECT id, slug, name, price, store, category_id FROM products WHERE active=1 AND stock>=30 AND fulfilment='own' AND vendor_id IS NULL AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 1"))[0];
  const ov = async () => (await RG('GET', '')).j;
  const zoneId = async (name) => (await ov()).zones.find((z) => z.name === name).id;
  const price = (b) => call('POST', '/api/cart/price', { items: [{ productId: prod.id, qty: 1 }], ...b });
  const order = (o = {}) => ({
    items: [{ productId: prod.id, qty: o.qty || 1 }], contact: { name: 'Olivia Hart', email: `olivia${++SEQ}@example.com`, phone: o.phone || '+44 7911 123456' },
    address: { country: 'GB', state: 'London', city: 'London', address: '10 Downing Street', postcode: 'SW1A 2AA', ...(o.address || {}) },
    currency: o.currency || 'USD', payment: o.payment || 'stripe', delivery: 'standard', idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
  });
  const orderRow = async (ref) => (await q('SELECT * FROM orders WHERE ref=$1', [ref]))[0];
  const GBP_RATE = 1900, USD_RATE = 1500, MARKUP = 2;
  let gbOrder;

  console.log('\nNothing ships abroad until a person switches it on');
  await test('a fresh shop delivers only to Nigeria, in Naira, and says so', async () => {
    const cfg = (await call('GET', '/api/config')).j;
    assert.deepStrictEqual(cfg.countries.map((c) => c.code), ['NG']); assert.deepStrictEqual(cfg.currencies.map((c) => c.code), ['NGN']);
    const r = (await price({ country: 'GB', currency: 'USD' })).j;
    assert.ok(r.blocked.length >= 1); assert.match(r.blocked[0], /do not deliver|not available/);
    assert.strictEqual((await call('POST', '/api/checkout', order())).s, 400);
  });
  await test('only an administrator can reach the countries and currencies screens', async () => {
    assert.strictEqual((await call('GET', '/api/admin/dropship/regions')).s, 401);
    assert.strictEqual((await call('PUT', '/api/admin/dropship/regions/countries/GB', { enabled: true })).s, 401);
  });

  console.log('\nAdmin: currencies, zones, countries');
  await test('a currency cannot be switched on without a rate, and the markup is limited', async () => {
    assert.strictEqual((await RG('PUT', '/currencies/USD', { enabled: true })).s, 400);
    assert.strictEqual((await A('PUT', '/api/admin/dropship/rates/USD', { ngn_per_unit: USD_RATE })).s, 200);
    assert.strictEqual((await RG('PUT', '/currencies/USD', { enabled: true, markup_pct: 50 })).s, 400);
    assert.strictEqual((await RG('PUT', '/currencies/USD', { enabled: true, markup_pct: MARKUP })).s, 200);
    assert.strictEqual((await RG('PUT', '/currencies/NGN', { enabled: false })).s, 400, 'Naira is always on');
  });
  await test('a zone with no bands cannot be switched on; bands must be sensible', async () => {
    const id = await zoneId('Europe');
    assert.strictEqual((await RG('PUT', '/zones/' + id, { name: 'Europe', active: true, rates: [] })).s, 400);
    assert.strictEqual((await RG('PUT', '/zones/' + id, { name: 'Europe', active: true, rates: [{ up_to_kg: 1, fee: 10 }, { up_to_kg: 1, fee: 20 }] })).s, 400, 'same weight twice');
    assert.strictEqual((await RG('PUT', '/zones/' + id, { name: 'Europe', active: true, rates: [{ up_to_kg: -1, fee: 10 }] })).s, 400);
    assert.strictEqual((await RG('PUT', '/zones/' + id, { name: 'Europe', active: true, extra_per_kg: 12000, eta_min: 7, eta_max: 14 })).s, 200, 'the starter bands are kept');
  });
  await test('a country needs a zone that is on and has fees before it can be enabled', async () => {
    const asia = await zoneId('Middle East & Asia');
    assert.strictEqual((await RG('PUT', '/countries/JP', { enabled: true, zone_id: asia })).s, 400, 'zone is still off');
    assert.strictEqual((await RG('PUT', '/countries/JP', { enabled: true })).s, 400, 'no zone');
    assert.strictEqual((await RG('PUT', '/countries/GB', { enabled: true, zone_id: await zoneId('Europe') })).s, 200);
    assert.strictEqual((await RG('PUT', '/countries/NG', { enabled: false })).s, 400, 'Nigeria stays on');
    assert.strictEqual((await RG('PUT', '/countries/GB', { phone_min: 12, phone_max: 8 })).s, 400);
    assert.strictEqual((await RG('PUT', '/countries/GB', { postcode_regex: '([' })).s, 400);
    assert.strictEqual((await RG('PUT', '/countries/GB', { tax_pct: 90 })).s, 400);
  });
  await test('any country in the world can be added, and an unknown code is refused', async () => {
    assert.strictEqual((await RG('POST', '/countries', { code: 'ZZ' })).s, 400);
    assert.strictEqual((await RG('POST', '/countries', { code: 'IS' })).s, 200);
    assert.strictEqual((await RG('POST', '/countries', { code: 'IS' })).s, 409);
    assert.ok((await ov()).countries.some((c) => c.code === 'IS' && !c.enabled));
  });

  console.log('\nPricing for another country');
  await test('delivery fee comes from the zone by weight, and the amount in dollars is the Naira total at the marked-up rate, rounded up', async () => {
    const r = (await price({ country: 'GB', currency: 'USD' })).j;
    assert.deepStrictEqual(r.blocked, []); assert.strictEqual(r.delivery.fee, 25000); assert.strictEqual(r.delivery.options.standard.eta, '7–14 days after dispatch');
    assert.strictEqual(r.total, prod.price + 25000);
    const want = CUR.chargeFor(r.total, CUR.chargeRate(USD_RATE, MARKUP), 'USD');
    assert.strictEqual(r.charge.amount, want); assert.strictEqual(r.charge.currency, 'USD');
    assert.ok(r.charge.amount >= Math.ceil((r.total / USD_RATE) * 100), 'never less than the plain conversion');
    assert.deepStrictEqual(r.payments, ['stripe'], 'a UK customer pays by international card');
  });
  await test('a heavier parcel costs more: more items, and a different usual item weight', async () => {
    assert.strictEqual((await price({ country: 'GB', currency: 'USD' })).j.delivery.fee, 25000);
    const three = (await call('POST', '/api/cart/price', { items: [{ productId: prod.id, qty: 3 }], country: 'GB', currency: 'USD' })).j;
    assert.strictEqual(three.weight_kg, 1.5); assert.strictEqual(three.delivery.fee, 42000);
    assert.strictEqual((await RG('PUT', '/settings', { default_item_kg: 12 })).s, 200);
    assert.strictEqual((await price({ country: 'GB', currency: 'USD' })).j.delivery.fee, 130000 + 24000, 'above the last band: 12 kg = 130,000 + 2 extra kg x 12,000');
    assert.strictEqual((await RG('PUT', '/settings', { default_item_kg: 0 })).s, 400);
    await RG('PUT', '/settings', { default_item_kg: 0.5 });
  });
  await test('tax added goes on top of goods and delivery; tax included is shown but does not change the total', async () => {
    const before = (await price({ country: 'GB', currency: 'USD' })).j.total;
    assert.strictEqual((await RG('PUT', '/countries/GB', { tax_mode: 'added', tax_pct: 20, tax_label: 'VAT' })).s, 200);
    const a = (await price({ country: 'GB', currency: 'USD' })).j;
    assert.strictEqual(a.tax, Math.round(before * 0.2)); assert.strictEqual(a.total, before + a.tax); assert.strictEqual(a.tax_label, 'VAT');
    assert.strictEqual(a.charge.amount, CUR.chargeFor(a.total, CUR.chargeRate(USD_RATE, MARKUP), 'USD'), 'the charge includes the tax');
    assert.strictEqual((await RG('PUT', '/countries/GB', { tax_mode: 'included' })).s, 200);
    const i = (await price({ country: 'GB', currency: 'USD' })).j;
    assert.strictEqual(i.total, before); assert.strictEqual(i.tax, Math.round(before - before / 1.2)); assert.match(i.tax_label, /included/);
    await RG('PUT', '/countries/GB', { tax_mode: 'none' });
  });
  await test('a currency that is off or has no rate cannot be used', async () => {
    const r = (await price({ country: 'GB', currency: 'EUR' })).j;
    assert.ok(r.blocked.some((m) => /currency/i.test(m)));
    assert.strictEqual((await call('POST', '/api/checkout', order({ currency: 'EUR' }))).s, 422);
  });

  console.log('\nCheckout details for another country');
  await test('phone and postcode must match the country; the region is needed', async () => {
    assert.strictEqual((await call('POST', '/api/checkout', order({ phone: '12345' }))).s, 400);
    assert.strictEqual((await call('POST', '/api/checkout', order({ phone: '+234 803 123 4567' }))).s, 400, 'a Nigerian number is not a UK number');
    assert.strictEqual((await call('POST', '/api/checkout', order({ address: { postcode: '90210' } }))).s, 400);
    assert.strictEqual((await call('POST', '/api/checkout', order({ address: { postcode: '' } }))).s, 400);
    assert.strictEqual((await call('POST', '/api/checkout', order({ address: { state: '' } }))).s, 400);
  });
  await test('pay on delivery, store pickup and express are Nigeria-only', async () => {
    assert.strictEqual((await call('POST', '/api/checkout', order({ payment: 'pod' }))).s, 400);
    const r = await call('POST', '/api/checkout', { ...order(), delivery: 'express' });
    assert.strictEqual(r.s, 200); assert.strictEqual((await orderRow(r.j.ref)).delivery, 'standard', 'forced to the international option');
  });

  console.log('\nStripe: card payment in dollars');
  await test('the order records country, currency, locked rate and the exact amount sent to Stripe', async () => {
    const r = await call('POST', '/api/checkout', order()); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual(r.j.next, 'stripe'); assert.match(r.j.url, /^https:\/\/checkout\.stripe\.test\/cs_test_/);
    gbOrder = await orderRow(r.j.ref);
    assert.strictEqual(gbOrder.country, 'GB'); assert.strictEqual(gbOrder.currency, 'USD'); assert.strictEqual(gbOrder.gateway, 'stripe'); assert.strictEqual(gbOrder.phone, '+447911123456'); assert.strictEqual(gbOrder.postcode, 'SW1A 2AA');
    assert.strictEqual(Number(gbOrder.total), prod.price + 25000);
    assert.strictEqual(Number(gbOrder.charge_amount), CUR.chargeFor(gbOrder.total, CUR.chargeRate(USD_RATE, MARKUP), 'USD'));
    assert.ok(Math.abs(Number(gbOrder.fx_rate) - USD_RATE / 1.02) < 1e-4);
    const s = fx.stripe[gbOrder.pay_session]; assert.ok(s, 'a Stripe session was created');
    assert.strictEqual(s.amount_total, Number(gbOrder.charge_amount)); assert.strictEqual(s.currency, 'usd'); assert.strictEqual(s.client_reference_id, gbOrder.ref);
  });
  await test('sending the same checkout again returns the same order and the same payment page', async () => {
    const o = order(); const a = await call('POST', '/api/checkout', o), b = await call('POST', '/api/checkout', o);
    assert.strictEqual(a.j.ref, b.j.ref); assert.strictEqual(a.j.url, b.j.url); assert.strictEqual(b.j.replayed, true);
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM orders WHERE ref=$1', [a.j.ref]))[0].n), 1);
  });
  await test('changing the exchange rate later never changes an order that was already placed', async () => {
    await A('PUT', '/api/admin/dropship/rates/USD', { ngn_per_unit: 2000 });
    const now = await orderRow(gbOrder.ref);
    assert.strictEqual(String(now.charge_amount), String(gbOrder.charge_amount)); assert.strictEqual(String(now.fx_rate), String(gbOrder.fx_rate));
    const fresh = (await price({ country: 'GB', currency: 'USD' })).j;
    assert.ok(fresh.charge.amount < Number(gbOrder.charge_amount), 'new orders use the new rate');
    await A('PUT', '/api/admin/dropship/rates/USD', { ngn_per_unit: USD_RATE });
  });
  await test('a webhook with a wrong signature, a wrong secret or no signature is refused', async () => {
    const raw = JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: { client_reference_id: gbOrder.ref } } });
    assert.strictEqual((await call('POST', '/api/stripe/webhook', raw, undefined, { 'Stripe-Signature': sig(raw, 'whsec_wrong') })).s, 401);
    assert.strictEqual((await call('POST', '/api/stripe/webhook', raw)).s, 401);
    assert.strictEqual((await call('POST', '/api/stripe/webhook', raw, undefined, { 'Stripe-Signature': sig(raw, WH, Math.floor(Date.now() / 1000) - 3600) })).s, 401, 'an hour-old message is a replay');
  });
  await test('a signed webhook alone does not mark the order paid: Stripe is asked, and the amount and currency must match', async () => {
    const hook = (id) => { const raw = JSON.stringify({ id, type: 'checkout.session.completed', data: { object: { client_reference_id: gbOrder.ref } } }); return call('POST', '/api/stripe/webhook', raw, undefined, { 'Stripe-Signature': sig(raw) }); };
    assert.strictEqual((await hook('evt_unpaid')).s, 200);                                      // Stripe says the session is not paid
    await sleep(1500); assert.strictEqual((await orderRow(gbOrder.ref)).payment_status, 'unpaid');
    Object.assign(fx.stripe[gbOrder.pay_session], { payment_status: 'paid', amount_total: Number(gbOrder.charge_amount) - 1 });
    assert.strictEqual((await hook('evt_short')).s, 200);
    await until(async () => (await q("SELECT 1 FROM order_events WHERE order_id=$1 AND note LIKE 'Payment check failed%'", [gbOrder.id])).length);
    assert.strictEqual((await orderRow(gbOrder.ref)).payment_status, 'unpaid', 'a short payment is never accepted');
    Object.assign(fx.stripe[gbOrder.pay_session], { amount_total: Number(gbOrder.charge_amount), currency: 'eur' });
    assert.strictEqual((await hook('evt_cur')).s, 200); await sleep(1200);
    assert.strictEqual((await orderRow(gbOrder.ref)).payment_status, 'unpaid', 'the wrong currency is never accepted');
    Object.assign(fx.stripe[gbOrder.pay_session], { currency: 'usd' });
    assert.strictEqual((await hook('evt_ok')).s, 200);
    await until(async () => (await orderRow(gbOrder.ref)).payment_status === 'paid');
    const o = await orderRow(gbOrder.ref); assert.strictEqual(o.status, 'paid'); assert.strictEqual(o.paystack_ref, 'pi_' + gbOrder.pay_session);
  });
  await test('the same webhook arriving again does nothing more', async () => {
    const raw = JSON.stringify({ id: 'evt_ok', type: 'checkout.session.completed', data: { object: { client_reference_id: gbOrder.ref } } });
    assert.strictEqual((await call('POST', '/api/stripe/webhook', raw, undefined, { 'Stripe-Signature': sig(raw) })).s, 200);
    await sleep(800);
    assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM order_events WHERE order_id=$1 AND status='paid'", [gbOrder.id]))[0].n), 1);
  });
  await test('coming back from Stripe also confirms the payment, by asking Stripe', async () => {
    const r = await call('POST', '/api/checkout', order()); const o = await orderRow(r.j.ref);
    Object.assign(fx.stripe[o.pay_session], { payment_status: 'paid' });
    const v = await call('GET', '/api/paystack/verify?reference=' + o.ref);
    assert.strictEqual(v.j.payment_status, 'paid'); assert.strictEqual((await orderRow(o.ref)).payment_status, 'paid');
  });

  console.log('\nPaystack in Ghana cedis');
  await test('Paystack is offered for Ghana in cedis, and for a UK customer only Stripe', async () => {
    assert.strictEqual((await A('PUT', '/api/admin/dropship/rates/GHS', { ngn_per_unit: 100 })).s, 200);
    assert.strictEqual((await RG('PUT', '/currencies/GHS', { enabled: true, markup_pct: 2 })).s, 200);
    assert.strictEqual((await RG('PUT', '/zones/' + await zoneId('West Africa'), { name: 'West Africa', active: true })).s, 200);
    assert.strictEqual((await RG('PUT', '/countries/GH', { enabled: true, zone_id: await zoneId('West Africa') })).s, 200);
    const gh = (await price({ country: 'GH', currency: 'GHS' })).j;
    assert.deepStrictEqual(gh.payments, ['paystack'], 'Stripe is not used for cedis'); assert.strictEqual(gh.delivery.fee, 12000);
    assert.deepStrictEqual((await price({ country: 'GB', currency: 'USD' })).j.payments, ['stripe']);
    assert.deepStrictEqual((await price({ country: 'GH', currency: 'NGN' })).j.payments, ['paystack'], 'Naira can be paid by Paystack from anywhere');
  });
  await test('the cedi amount is sent to Paystack, and only a matching currency and amount marks the order paid', async () => {
    const r = await call('POST', '/api/checkout', order({ currency: 'GHS', payment: 'paystack', phone: '024 123 4567', address: { country: 'GH', state: 'Greater Accra', city: 'Accra', postcode: '' } }));
    assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.next, 'paystack');
    const o = await orderRow(r.j.ref); assert.strictEqual(o.currency, 'GHS'); assert.strictEqual(o.phone, '+233241234567');
    assert.deepStrictEqual(fx.pay[o.ref], { amount: Number(o.charge_amount), currency: 'GHS' });
    fx.payOverride = { currency: 'NGN' };
    assert.strictEqual((await call('GET', '/api/paystack/verify?reference=' + o.ref)).j.payment_status, 'unpaid', 'wrong currency');
    fx.payOverride = { amount: Number(o.total) * 100 };
    assert.strictEqual((await call('GET', '/api/paystack/verify?reference=' + o.ref)).j.payment_status, 'unpaid', 'the Naira amount is not the cedi amount');
    fx.payOverride = null;
    assert.strictEqual((await call('GET', '/api/paystack/verify?reference=' + o.ref)).j.payment_status, 'paid');
  });
  await test('Stripe cannot be used to pay in a currency it does not take, and pay on delivery is refused abroad', async () => {
    assert.strictEqual((await call('POST', '/api/checkout', order({ currency: 'GHS', payment: 'stripe', phone: '024 123 4567', address: { country: 'GH', state: 'Accra', postcode: '' } }))).s, 400);
    assert.strictEqual((await call('POST', '/api/checkout', order({ currency: 'GHS', payment: 'pod', phone: '024 123 4567', address: { country: 'GH', state: 'Accra', postcode: '' } }))).s, 400);
  });

  console.log('\nProducts that cannot go to a country');
  await test('a banned product, category or department blocks the order with a clear message; a restricted one asks the customer to contact us', async () => {
    const add = (b) => RG('POST', '/restrictions', { country: 'GB', ...b });
    assert.strictEqual((await add({ product_id: prod.id, store: prod.store })).s, 400, 'one target only');
    assert.strictEqual((await add({ kind: 'banned' })).s, 400, 'a target is needed');
    assert.strictEqual((await add({ product_id: prod.id, kind: 'banned', note: 'Import ban' })).s, 200);
    let r = (await price({ country: 'GB', currency: 'USD' })).j; assert.match(r.blocked[0], /cannot be delivered/);
    const c = await call('POST', '/api/checkout', order()); assert.strictEqual(c.s, 422); assert.match(c.j.error, /cannot be delivered/);
    assert.deepStrictEqual((await price({ country: 'GH', currency: 'GHS' })).j.blocked, [], 'other countries are not affected');
    assert.deepStrictEqual((await price({})).j.blocked, [], 'neither is Nigeria');
    const rules = (await ov()).restrictions; for (const x of rules) await RG('DELETE', '/restrictions/' + x.id);
    assert.strictEqual((await add({ category_id: prod.category_id, kind: 'restricted' })).s, 200);
    r = (await price({ country: 'GB', currency: 'USD' })).j; assert.match(r.blocked[0], /special approval/);
    for (const x of (await ov()).restrictions) await RG('DELETE', '/restrictions/' + x.id);
    assert.strictEqual((await add({ store: prod.store, kind: 'banned' })).s, 200);
    assert.ok((await price({ country: 'GB', currency: 'USD' })).j.blocked.length);
    for (const x of (await ov()).restrictions) await RG('DELETE', '/restrictions/' + x.id);
    assert.deepStrictEqual((await price({ country: 'GB', currency: 'USD' })).j.blocked, []);
  });

  console.log('\nAutomatic exchange rates');
  await test('the feed never changes a rate set by hand, until it is unlocked', async () => {
    fx.feed = { USD: 1 / 1600, GBP: 1 / 1900 };
    let r = await RG('POST', '/fx/refresh', {}); assert.strictEqual(r.s, 200, r.t);
    assert.ok(r.j.kept_locked.includes('USD')); assert.ok(r.j.updated.includes('GBP'), 'a currency with no rate yet gets one from the feed');
    assert.strictEqual(Number((await q("SELECT ngn_per_unit FROM fx_rates WHERE currency='USD'"))[0].ngn_per_unit), USD_RATE);
    assert.strictEqual((await RG('PUT', '/currencies/USD', { locked: false })).s, 200);
    r = await RG('POST', '/fx/refresh', {}); assert.ok(r.j.updated.includes('USD'));
    assert.ok(Math.abs(Number((await q("SELECT ngn_per_unit FROM fx_rates WHERE currency='USD'"))[0].ngn_per_unit) - 1600) < 0.01);
    assert.strictEqual((await q("SELECT source FROM fx_rates WHERE currency='USD'"))[0].source, 'feed');
  });
  await test('a sudden jump of more than 25% is treated as a bad reading and ignored', async () => {
    fx.feed = { USD: 1 / 3000, GBP: 1 / 1900 };
    const r = await RG('POST', '/fx/refresh', {}); assert.ok(r.j.rejected.includes('USD'));
    assert.ok(Math.abs(Number((await q("SELECT ngn_per_unit FROM fx_rates WHERE currency='USD'"))[0].ngn_per_unit) - 1600) < 0.01);
  });
  await test('a feed rate that has gone stale stops being used, and a hand-set rate does not expire', async () => {
    assert.strictEqual((await RG('PUT', '/currencies/GBP', { enabled: true, markup_pct: 2 })).s, 200);
    assert.strictEqual((await RG('PUT', '/countries/GB', { currency: 'GBP' })).s, 200);
    assert.ok((await call('GET', '/api/config')).j.currencies.some((c) => c.code === 'GBP'));
    await q("UPDATE fx_rates SET updated = updated - 4*86400 WHERE currency='GBP'");
    await RG('PUT', '/currencies/GBP', { markup_pct: 2 });                        // any admin change clears the page cache, as it would in real use
    assert.ok(!(await call('GET', '/api/config')).j.currencies.some((c) => c.code === 'GBP'), 'older than 72 hours');
    assert.ok((await price({ country: 'GB', currency: 'GBP' })).j.blocked.some((m) => /currency/i.test(m)));
    await q("UPDATE fx_rates SET updated = updated - 40*86400, locked = TRUE, source = 'manual' WHERE currency='USD'");
    assert.ok((await call('GET', '/api/config')).j.currencies.some((c) => c.code === 'USD'));
  });

  console.log('\nNigeria is unchanged');
  await test('a Nigerian order is still in Naira with the amount in kobo, and Paystack is sent exactly that', async () => {
    const r = await call('POST', '/api/checkout', { items: [{ productId: prod.id, qty: 1 }], contact: { name: 'Ada Obi', email: 'ada.ng@example.com', phone: '08011112222' }, address: { state: 'Lagos', city: 'Ikeja', address: '5 Allen Avenue' }, delivery: 'standard', payment: 'paystack' });
    assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.next, 'paystack');
    const o = await orderRow(r.j.ref);
    assert.strictEqual(o.country, 'NG'); assert.strictEqual(o.currency, 'NGN'); assert.strictEqual(Number(o.charge_amount), Number(o.total) * 100); assert.strictEqual(Number(o.fx_rate), 1); assert.strictEqual(Number(o.tax), 0);
    assert.deepStrictEqual(fx.pay[o.ref], { amount: Number(o.total) * 100, currency: 'NGN' });
    assert.strictEqual((await call('GET', '/api/paystack/verify?reference=' + o.ref)).j.payment_status, 'paid');
  });

  console.log('\nWhat customers can and cannot see');
  await test('the public page shows countries and display rates, but no shipping fees, markups, tax settings notes or supplier costs', async () => {
    const t = (await call('GET', '/api/config')).t, cfg = JSON.parse(t);
    for (const word of ['markup', 'base_rate', 'extra_per_kg', 'shipping_rates', 'default_item_kg', 'notes', 'stripe_secret', 'sk_test']) assert.ok(!t.includes(word), word + ' must not be public');
    assert.ok(cfg.currencies.every((c) => Object.keys(c).sort().join() === 'code,decimals,rate'));
    assert.ok(cfg.countries.every((c) => !('zone_id' in c) && !('enabled' in c) && !('notes' in c)));
  });
  await test('the order a customer looks up shows what they were charged and nothing about our rate, markup or gateway keys', async () => {
    const r = await call('POST', '/api/orders/lookup', { ref: gbOrder.ref, email: gbOrder.email, token: gbOrder.access_token });
    assert.strictEqual(r.s, 200); const o = r.j.order;
    assert.strictEqual(o.currency, 'USD'); assert.strictEqual(o.charge_amount, Number(gbOrder.charge_amount)); assert.strictEqual(o.country, 'GB');
    for (const k of ['fx_rate', 'pay_session', 'paystack_ref', 'access_token', 'pay_url']) assert.ok(!(k in o), k + ' must not be in the customer view');
  });
  await test('a customer cannot reach the admin endpoints for rates or zones', async () => {
    const reg = await call('POST', '/api/auth/register', { name: 'Pat Buyer', email: 'pat.buyer@example.com', phone: '08031230000', password: 'mango-river-sky-55' });
    const cust = reg.c || (await call('POST', '/api/auth/login', { email: 'pat.buyer@example.com', password: 'mango-river-sky-55' })).c;
    for (const [m, u] of [['GET', '/api/admin/dropship/regions'], ['POST', '/api/admin/dropship/regions/fx/refresh'], ['PUT', '/api/admin/dropship/regions/currencies/USD']]) assert.strictEqual((await call(m, u, m === 'GET' ? undefined : {}, cust)).s, 401, u);
  });

  console.log('\nSafety of the data');
  await test('every admin change in this area is written to the activity log', async () => {
    const n = Number((await q("SELECT COUNT(*) n FROM audit_log WHERE path LIKE '/api/admin/dropship/regions%' AND method <> 'GET'"))[0].n);
    assert.ok(n >= 10, 'logged ' + n);
  });
  await test('running the migration again changes nothing and keeps the admin\'s edits', async () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '012_countries_currencies.sql'), 'utf8');
    const before = (await q('SELECT (SELECT COUNT(*) FROM countries) c, (SELECT COUNT(*) FROM shipping_rates) r, (SELECT COUNT(*) FROM currencies) u, (SELECT enabled FROM countries WHERE code=\'GB\') gb, (SELECT fee FROM shipping_rates r JOIN shipping_zones z ON z.id=r.zone_id WHERE z.name=\'Europe\' AND up_to_kg=0.5) fee'))[0];
    await RG('PUT', '/zones/' + await zoneId('Europe'), { name: 'Europe', active: true, rates: [{ up_to_kg: 0.5, fee: 99999 }] });
    await q(sql); await q(sql);
    const after = (await q('SELECT (SELECT COUNT(*) FROM countries) c, (SELECT COUNT(*) FROM currencies) u, (SELECT enabled FROM countries WHERE code=\'GB\') gb, (SELECT fee FROM shipping_rates r JOIN shipping_zones z ON z.id=r.zone_id WHERE z.name=\'Europe\' AND up_to_kg=0.5) fee'))[0];
    assert.strictEqual(after.c, before.c); assert.strictEqual(after.u, before.u); assert.strictEqual(after.gb, before.gb); assert.strictEqual(after.fee, 99999, 'edited fees survive');
    assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM shipping_rates r JOIN shipping_zones z ON z.id=r.zone_id WHERE z.name='Europe'"))[0].n), 1, 'the starter bands are not added back');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fake.close(); try { srv.kill(); } catch { /* */ }
  await sleep(300);
  try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ }
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e, '\n--- server log ---\n' + log.slice(-2500)); try { srv.kill(); } catch { /* */ } try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ } process.exit(1); });
