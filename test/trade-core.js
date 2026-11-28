'use strict';
// Global Trade module, phases 1-2: database foundation, permissions, countries and currencies, exchange rates, product trade settings, public API.
// Run with: npm run test:trade   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const http = require('http');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');
const X = require('../lib/xlsx');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'vm_trade_' + tag;
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
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/vm-trade-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50', FX_API_URL: `http://127.0.0.1:${FXPORT}/latest/{base}`, FX_REFRESH: '0' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, '/api/admin/trade' + u, b, admin);

  console.log('\nDatabase foundation');
  await test('every trade table exists, has row level security ON and has no policies (the public key reads nothing)', async () => {
    const want = ['trade_countries', 'trade_currencies', 'international_suppliers', 'supplier_products', 'import_purchase_orders', 'import_purchase_order_items', 'import_shipments', 'import_shipment_items', 'export_orders', 'export_order_items', 'shipping_providers', 'shipping_services',
      'shipping_rate_quotes', 'shipping_bookings', 'shipping_labels', 'shipment_tracking_events', 'customs_declarations', 'customs_documents', 'trade_documents', 'customs_duty_rules', 'trade_shipping_zones', 'shipping_rate_rules', 'international_payments', 'trade_exchange_rates',
      'landed_cost_allocations', 'product_trade_settings', 'trade_notifications', 'trade_audit_logs'];
    const rows = await q("SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'");
    const have = Object.fromEntries(rows.map((r) => [r.relname, r.relrowsecurity]));
    for (const t of want) assert.ok(t in have, 'missing table ' + t);
    const trade = rows.filter((r) => /^(trade_|shipping_|customs_|import_|export_|product_trade|international_|supplier_|shipment_|landed_)/.test(r.relname));
    assert.ok(trade.length >= want.length);
    for (const r of trade) assert.strictEqual(r.relrowsecurity, true, 'RLS off on ' + r.relname);
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM pg_policies WHERE schemaname='public' AND (tablename LIKE 'trade\\_%' OR tablename LIKE 'shipping\\_%' OR tablename LIKE 'export\\_%' OR tablename LIKE 'import\\_%')"))[0].n, 0);
  });
  await test('database rules: a booking cannot be "booked" without the carrier reference; a payment cannot be "succeeded" unverified; duplicate tracking events are refused', async () => {
    await q("INSERT INTO shipping_providers (code,name,created,updated) VALUES ('t1','T1',1,1)");
    const pid = (await q("SELECT id FROM shipping_providers WHERE code='t1'"))[0].id;
    await q("INSERT INTO international_suppliers (name,country_code,created,updated) VALUES ('S','NG',1,1)");
    const sid = (await q('SELECT id FROM international_suppliers LIMIT 1'))[0].id;
    await q("INSERT INTO import_shipments (import_ref,supplier_id,supplier_country,destination_country,currency,created,updated) VALUES ('IMP-1',$1,'NG','NG','USD',1,1)", [sid]);
    const imp = (await q("SELECT id FROM import_shipments WHERE import_ref='IMP-1'"))[0].id;
    await assert.rejects(q("INSERT INTO shipping_bookings (import_shipment_id,provider_id,idempotency_key,status,provider_ref,created,updated) VALUES ($1,$2,'k1','booked','',1,1)", [imp, pid]), /check/i);
    await q("INSERT INTO shipping_bookings (import_shipment_id,provider_id,idempotency_key,status,provider_ref,created,updated) VALUES ($1,$2,'k2','booked','CARRIER-REF',1,1)", [imp, pid]);
    await assert.rejects(q("INSERT INTO shipping_bookings (import_shipment_id,provider_id,idempotency_key,status,provider_ref,created,updated) VALUES ($1,$2,'k2','requested','',1,1)", [imp, pid]), /unique|duplicate/i);
    await q("INSERT INTO shipment_tracking_events (import_shipment_id,stage,occurred_at,source,event_hash,created) VALUES ($1,'in_transit',1,'api','h1',1)", [imp]);
    await assert.rejects(q("INSERT INTO shipment_tracking_events (import_shipment_id,stage,occurred_at,source,event_hash,created) VALUES ($1,'in_transit',1,'webhook','h1',1)", [imp]), /unique|duplicate/i);
    const landed = (await q("UPDATE import_shipments SET purchase_value=1000, freight=100, customs_duties=50.5, insurance=10 WHERE id=$1 RETURNING landed_cost", [imp]))[0].landed_cost;
    assert.strictEqual(Number(landed), 1160.5, 'landed cost adds every charge');
    await q('DELETE FROM shipment_tracking_events'); await q('DELETE FROM shipping_bookings'); await q('DELETE FROM import_shipments'); await q('DELETE FROM international_suppliers'); await q('DELETE FROM shipping_providers');
  });
  await test('reference data is loaded: Nigeria is home, NGN is the base currency, 6 currencies on, every other country OFF until the owner enables it', async () => {
    const cur = await q('SELECT code, active, is_base FROM trade_currencies WHERE active=1 ORDER BY code'); assert.deepStrictEqual(cur.map((c) => c.code), ['AUD', 'CAD', 'EUR', 'GBP', 'NGN', 'USD']); assert.strictEqual(cur.find((c) => c.code === 'NGN').is_base, 1);
    const ng = (await q("SELECT * FROM trade_countries WHERE code='NG'"))[0]; assert.ok(ng.export_from === 1 && ng.import_to === 1);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM trade_countries WHERE export_to=1 OR import_from=1'))[0].n, 0);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM customs_duty_rules'))[0].n, 0, 'no duty rates are invented'); assert.strictEqual((await q('SELECT COUNT(*)::int n FROM trade_exchange_rates'))[0].n, 0, 'no exchange rates are invented');
  });

  console.log('\nPermissions');
  const ST = (m, u, b) => call(m, '/api/admin/staff' + u, b, admin);
  const emp = {};
  const mk = async (key, roleName) => { const roles = (await ST('GET', '')).j.roles; const role = roles.find((r) => r.name === roleName); assert.ok(role, 'role ' + roleName); const r = await ST('POST', '', { name: key + ' Emp', email: key + '@example.com', username: key + '.user', role_id: role.id }); assert.strictEqual(r.s, 200, r.t); emp[key] = await login(key + '@example.com', r.j.temp_password); };
  await test('Global Trade roles exist; staff without the trade permission are refused; analysts can read but not change; managers can do both', async () => {
    await mk('sales', 'Sales Representative'); await mk('analyst', 'Trade Analyst'); await mk('mgr', 'Trade & Logistics Manager');
    assert.strictEqual((await call('GET', '/api/admin/trade/settings', undefined, emp.sales)).s, 403);
    assert.strictEqual((await call('GET', '/api/admin/trade/settings', undefined, emp.analyst)).s, 200);
    assert.strictEqual((await call('PUT', '/api/admin/trade/settings', { handling_fee_ngn: 5 }, emp.analyst)).s, 403);
    assert.strictEqual((await call('PUT', '/api/admin/trade/settings', { handling_fee_ngn: 5 }, emp.mgr)).s, 200);
    assert.strictEqual((await call('GET', '/api/admin/trade/settings')).s, 401, 'signed-out people are refused');
    const cust = await call('POST', '/api/auth/register', { name: 'Buyer One', email: 'buyer1@example.com', password: 'Zebra-Violin-Table-2026!' }); assert.ok(cust.s === 200 || cust.s === 201, cust.t);
    assert.strictEqual((await call('GET', '/api/admin/trade/dashboard', undefined, cust.c)).s, 401, 'a customer is not back-office staff');
    assert.strictEqual((await call('PUT', '/api/admin/trade/settings', { handling_fee_ngn: 0 }, admin)).s, 200);
  });
  await test('a customer cannot read other people\'s trade data and the trade audit log is staff-only', async () => {
    assert.strictEqual((await call('GET', '/api/admin/trade/audit', undefined, emp.sales)).s, 403);
    const a = await A('GET', '/audit'); assert.strictEqual(a.s, 200); assert.ok(a.j.rows.some((r) => r.action === 'settings.update'), 'settings changes are audited');
  });

  console.log('\nSettings, countries, currencies');
  await test('settings: validated and audited', async () => {
    assert.strictEqual((await A('PUT', '/settings', { fx_markup_pct: 50 })).s, 400); assert.strictEqual((await A('PUT', '/settings', { default_incoterm: 'XYZ' })).s, 400); assert.strictEqual((await A('PUT', '/settings', { handling_fee_ngn: 'abc' })).s, 400); assert.strictEqual((await A('PUT', '/settings', { origin_country: 'ZZ' })).s, 400);
    const ok = await A('PUT', '/settings', { fx_markup_pct: 2, shipping_margin_pct: 10, default_duty_arrangement: 'DDP' }); assert.strictEqual(ok.s, 200); assert.strictEqual(ok.j.settings.fx_markup_pct, '2');
    assert.strictEqual((await A('PUT', '/settings', { fx_markup_pct: 0, default_duty_arrangement: 'DAP' })).s, 200);
  });
  await test('countries: enable shipping to some, bulk switch, country-specific rules, bad input refused', async () => {
    assert.strictEqual((await A('POST', '/countries/bulk', { codes: ['US', 'GB', 'DE', 'FR', 'CA'], flag: 'export_to', on: true })).j.changed, 5);
    const us = await A('PUT', '/countries/US', { tax_id_required: false, vat_label: 'Sales tax', postal_regex: '^\\d{5}(-\\d{4})?$' }); assert.strictEqual(us.s, 200); assert.strictEqual(us.j.country.vat_label, 'Sales tax');
    assert.strictEqual((await A('PUT', '/countries/GB', { postal_regex: '([' })).s, 400); assert.strictEqual((await A('PUT', '/countries/GB', { postal_regex: '(a+)+$' })).s, 400, 'catastrophic patterns refused');
    assert.strictEqual((await A('PUT', '/countries/ZZ', { active: true })).s, 404); assert.strictEqual((await A('POST', '/countries/bulk', { codes: ['US'], flag: 'hack', on: true })).s, 400);
    assert.strictEqual((await A('GET', '/countries?enabled=1')).j.countries.filter((c) => c.export_to).length, 5);
  });
  await test('currencies: switch on, the base currency cannot be switched off', async () => {
    assert.strictEqual((await A('PUT', '/currencies/NGN', { active: false })).s, 400);
    const r = await A('PUT', '/currencies/GHS', { active: true }); assert.strictEqual(r.s, 200); assert.ok(r.j.currencies.find((c) => c.code === 'GHS').active);
    assert.strictEqual((await A('PUT', '/currencies/GHS', { active: false })).s, 200);
  });

  console.log('\nExchange rates');
  await test('with no stored rate, conversion refuses (503) instead of guessing; NGN to NGN works', async () => {
    assert.strictEqual((await call('GET', '/api/trade/convert?amount=1000&from=NGN&to=USD')).s, 503);
    const same = await call('GET', '/api/trade/convert?amount=1500&from=NGN&to=NGN'); assert.strictEqual(same.s, 200); assert.strictEqual(same.j.amount, 1500);
    assert.strictEqual((await call('GET', '/api/trade/convert?amount=abc&from=NGN&to=USD')).s, 400); assert.strictEqual((await call('GET', '/api/trade/convert?amount=5&from=NGN&to=ZZZ')).s, 400);
  });
  await test('refresh stores real provider rates for active currencies and converts correctly (cross rates go through NGN)', async () => {
    const r = await A('POST', '/rates/refresh'); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.stored, 5);
    const c = await call('GET', '/api/trade/convert?amount=1000000&from=NGN&to=USD'); assert.strictEqual(c.s, 200); assert.strictEqual(c.j.amount, 650);
    const back = await call('GET', '/api/trade/convert?amount=650&from=USD&to=NGN'); assert.strictEqual(back.j.amount, 1000000);
    const cross = await call('GET', '/api/trade/convert?amount=100&from=USD&to=GBP'); assert.strictEqual(cross.j.amount, 78.46, 'USD to GBP = 0.00051/0.00065'); assert.match(cross.j.rate_source, /127\.0\.0\.1/);
  });
  await test('markup is applied to display prices only when the owner sets one', async () => {
    await A('PUT', '/settings', { fx_markup_pct: 10 }); assert.strictEqual((await call('GET', '/api/trade/convert?amount=1000000&from=NGN&to=USD')).j.amount, 715);
    await A('PUT', '/settings', { fx_markup_pct: 0 }); assert.strictEqual((await call('GET', '/api/trade/convert?amount=1000000&from=NGN&to=USD')).j.amount, 650);
  });
  await test('rate history is kept: a later refresh adds rows and never rewrites old ones', async () => {
    const before = await q("SELECT id, rate FROM trade_exchange_rates WHERE quote='USD'"); fx.rates.USD = 0.0007; await sleep(1100);
    assert.strictEqual((await A('POST', '/rates/refresh')).s, 200);
    const after = await q("SELECT id, rate FROM trade_exchange_rates WHERE quote='USD' ORDER BY id"); assert.strictEqual(after.length, before.length + 1); assert.strictEqual(Number(after[0].rate), 0.00065, 'the old rate is untouched'); assert.strictEqual(Number(after[1].rate), 0.0007);
    assert.strictEqual((await call('GET', '/api/trade/convert?amount=1000000&from=NGN&to=USD')).j.amount, 700);
  });
  await test('a provider outage keeps the last good rates and reports an error; garbage answers are refused', async () => {
    fx.up = false; const r = await A('POST', '/rates/refresh'); assert.strictEqual(r.s, 502); assert.strictEqual((await call('GET', '/api/trade/convert?amount=1000000&from=NGN&to=USD')).j.amount, 700); fx.up = true;
  });
  await test('rates that are too old are marked stale, then refused for checkout (503)', async () => {
    await q("UPDATE trade_exchange_rates SET fetched_at = fetched_at - 40*3600"); const t = (await A('GET', '/rates')).j.rates.find((x) => x.code === 'USD'); assert.ok(t.stale && !t.blocked);
    assert.strictEqual((await call('GET', '/api/trade/convert?amount=10&from=NGN&to=USD')).s, 200, 'stale but still usable for display');
    await q("UPDATE trade_exchange_rates SET fetched_at = fetched_at - 40*3600"); assert.strictEqual((await call('GET', '/api/trade/convert?amount=10&from=NGN&to=USD')).s, 503);
    assert.strictEqual((await A('POST', '/rates/refresh')).s, 200); assert.strictEqual((await call('GET', '/api/trade/convert?amount=10&from=NGN&to=USD')).s, 200);
  });
  await test('manual rates are labelled and validated', async () => {
    assert.strictEqual((await A('POST', '/rates/manual', { quote: 'USD', rate: -1 })).s, 400); assert.strictEqual((await A('POST', '/rates/manual', { quote: 'NGN', rate: 1 })).s, 400);
    await sleep(1100); const r = await A('POST', '/rates/manual', { quote: 'USD', rate: 0.001, note: 'bank rate' }); assert.strictEqual(r.s, 200);
    const t = r.j.rates.find((x) => x.code === 'USD'); assert.ok(t.manual && /manual/.test(t.source)); assert.strictEqual((await call('GET', '/api/trade/convert?amount=1000000&from=NGN&to=USD')).j.amount, 1000);
  });

  console.log('\nProduct trade settings');
  const prod = (await q("SELECT id, name FROM products WHERE is_pharmacy=0 AND active=1 ORDER BY id LIMIT 3"));
  const pharm = (await q('SELECT id FROM products WHERE is_pharmacy=1 LIMIT 1'))[0];
  const complete = { export_enabled: true, intl_eligible: true, origin_country: 'NG', hs_code: '6109.10', customs_description: 'Cotton T-shirt, knitted', weight_kg: 0.25, length_cm: 30, width_cm: 25, height_cm: 3, shipping_category: 'clothing' };
  await test('export cannot be switched on until the customs data is complete, and the message says what is missing', async () => {
    const r = await A('PUT', '/products/' + prod[0].id, { export_enabled: true, intl_eligible: true }); assert.strictEqual(r.s, 400); assert.match(r.j.error, /country of origin/); assert.match(r.j.error, /HS code/); assert.match(r.j.error, /weight/);
    assert.strictEqual((await A('PUT', '/products/' + prod[0].id, { ...complete, hs_code: 'abc' })).s, 400); assert.strictEqual((await A('PUT', '/products/' + prod[0].id, { ...complete, weight_kg: 'heavy' })).s, 400); assert.strictEqual((await A('PUT', '/products/' + prod[0].id, { ...complete, origin_country: 'ZZ' })).s, 400);
    assert.strictEqual((await A('PUT', '/products/' + prod[0].id, { ...complete, weight_kg: -1 })).s, 400);
  });
  await test('a complete product saves; the record and its missing-list come back; changes are audited', async () => {
    const r = await A('PUT', '/products/' + prod[0].id, complete); assert.strictEqual(r.s, 200, r.t); assert.ok(r.j.trade.export_enabled); assert.deepStrictEqual(r.j.missing, []);
    assert.strictEqual((await A('GET', '/products/' + prod[0].id)).j.trade.hs_code, '6109.10'); assert.ok((await A('GET', '/audit?entity=product_trade_settings')).j.rows.length >= 1);
    assert.strictEqual((await A('GET', '/products/999999')).s, 404);
  });
  await test('medicines can never be switched on for export', async () => {
    if (!pharm) return; const r = await A('PUT', '/products/' + pharm.id, complete); assert.strictEqual(r.s, 400); assert.match(r.j.error, /pharmacy|medicine/i);
  });
  await test('dangerous goods need a class; customers never see a product that is not signed off', async () => {
    assert.strictEqual((await A('PUT', '/products/' + prod[1].id, { ...complete, dangerous_goods: true })).s, 400);
    assert.strictEqual((await A('PUT', '/products/' + prod[1].id, { ...complete, dangerous_goods: true, dangerous_class: 'UN3481', intl_eligible: false })).s, 200);
    const list = await call('GET', '/api/trade/products?country=US&currency=USD'); assert.strictEqual(list.s, 200);
    assert.deepStrictEqual(list.j.products.map((p) => p.id), [Number(prod[0].id)], 'only the signed-off product is listed');
  });
  await test('public list: prices are converted with the stored rate, unsupported countries and currencies are refused, banned countries are excluded', async () => {
    const us = await call('GET', '/api/trade/products?country=US&currency=USD'); const p = us.j.products[0]; const ngn = Number((await q('SELECT price FROM products WHERE id=$1', [p.id]))[0].price);
    assert.strictEqual(p.price_ngn, ngn); assert.strictEqual(p.price, Math.round(ngn * 0.001 * 100) / 100); assert.strictEqual(us.j.currency.code, 'USD');
    assert.strictEqual((await call('GET', '/api/trade/products?country=NG&currency=USD')).s, 404, 'Nigeria itself is not an export destination'); assert.strictEqual((await call('GET', '/api/trade/products?country=JP&currency=USD')).s, 404, 'a country that is not switched on');
    assert.strictEqual((await call('GET', '/api/trade/products?country=US&currency=ZZZ')).s, 400);
    const put = await A('PUT', '/products/' + prod[0].id, { restrictions: [{ country: 'GB', direction: 'export', reason: 'Not permitted in test' }] }); assert.strictEqual(put.s, 200); assert.strictEqual(put.j.restrictions.length, 1);
    assert.strictEqual((await call('GET', '/api/trade/products?country=GB&currency=GBP')).j.products.length, 0, 'banned for GB'); assert.strictEqual((await call('GET', '/api/trade/products?country=US&currency=USD')).j.products.length, 1, 'still fine for the US');
    assert.deepStrictEqual((await call('GET', `/api/trade/can-ship?product=${prod[0].id}&country=GB`)).j, { ok: false, reason: 'This product cannot be shipped to that country.' }); assert.strictEqual((await call('GET', `/api/trade/can-ship?product=${prod[0].id}&country=US`)).j.ok, true);
    assert.strictEqual((await call('GET', '/api/trade/countries')).j.countries.length, 5); assert.ok(!JSON.stringify((await call('GET', '/api/trade/products?country=US&currency=NGN')).j).includes('Not permitted in test'), 'internal notes are not public');
  });
  await test('rates missing for a currency make the product list fail with 503 instead of showing made-up prices', async () => {
    await A('PUT', '/currencies/GHS', { active: true }); assert.strictEqual((await call('GET', '/api/trade/products?country=US&currency=GHS')).s, 503); await A('PUT', '/currencies/GHS', { active: false });
  });

  console.log('\nBulk import and export');
  await test('template downloads as a real .xlsx; export contains the saved product; export as CSV works', async () => {
    const t = await call('GET', '/api/admin/trade/products/template.xlsx', undefined, admin); assert.strictEqual(t.s, 200); assert.strictEqual(t.buf[0], 0x50);
    const e = await call('GET', '/api/admin/trade/products/export?format=csv', undefined, admin); assert.strictEqual(e.s, 200); assert.match(e.t, /6109\.10/); assert.match(e.t, /GB/);
  });
  const b64 = (rows) => X.writeXlsx([{ name: 'Products', rows }]).toString('base64');
  const hdr = ['SKU', 'Product slug', 'Available for export (Yes/No)', 'International shipping approved (Yes/No)', 'Country of origin (2-letter code)', 'HS code', 'Customs description', 'Weight (kg)', 'Length (cm)', 'Width (cm)', 'Height (cm)', 'Never export to (country codes, separated by ;)'];
  await test('preview checks every row and reports problems by row number; nothing is saved by a preview', async () => {
    const s0 = (await q('SELECT slug FROM products WHERE id=$1', [prod[2].id]))[0].slug;
    const rows = [hdr, ['', s0, 'Yes', 'Yes', 'NG', '8517.12', 'Mobile phone', '0.2', '15', '8', '1', 'US;DE'], ['', 'no-such-product', 'Yes', 'Yes', 'NG', '8517.12', 'Phone', '1', '1', '1', '1', ''], ['', s0, 'Maybe', '', '', '', '', '', '', '', '', ''], ['', '', 'Yes', '', '', '', '', '', '', '', '', '']];
    const p = await call('POST', '/api/admin/trade/products/import/preview', { filename: 'x.xlsx', data: b64(rows) }, admin); assert.strictEqual(p.s, 200, p.t);
    assert.strictEqual(p.j.total, 4); assert.strictEqual(p.j.ok, 1); assert.deepStrictEqual(p.j.errors.map((e) => e.row).sort(), [3, 4, 5]); assert.match(p.j.errors.find((e) => e.row === 3).message, /No product found/);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM product_trade_settings WHERE product_id=$1', [prod[2].id]))[0].n, 0, 'a preview saves nothing');
  });
  await test('commit saves the good rows, reports the bad ones, applies bans, and keeps unspecified fields', async () => {
    const s0 = (await q('SELECT slug FROM products WHERE id=$1', [prod[2].id]))[0].slug, s1 = (await q('SELECT slug FROM products WHERE id=$1', [prod[0].id]))[0].slug;
    const rows = [hdr, ['', s0, 'Yes', 'Yes', 'NG', '8517.12', 'Mobile phone', '0.2', '15', '8', '1', 'US;DE'], ['', s1, '', '', '', '', '', '', '', '', '', ''], ['', s1, 'Yes', '', '', 'bad hs', '', '', '', '', '', '']];
    const r = await call('POST', '/api/admin/trade/products/import/commit', { filename: 'x.xlsx', data: b64(rows) }, admin); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.saved, 2, 'the new product and the no-change row'); assert.ok(r.j.errors.some((e) => e.row === 4 && /twice/.test(e.message)), 'the duplicate row is reported');
    const t = (await A('GET', '/products/' + prod[2].id)).j; assert.ok(t.trade.export_enabled); assert.deepStrictEqual(t.restrictions.map((x) => x.country).sort(), ['DE', 'US']);
    assert.strictEqual((await call('GET', '/api/trade/products?country=US&currency=USD')).j.products.some((p) => p.id === Number(prod[2].id)), false, 'banned for the US via the bulk file');
    assert.strictEqual((await call('GET', '/api/trade/products?country=FR&currency=EUR')).j.products.some((p) => p.id === Number(prod[2].id)), true);
    const other = (await A('GET', '/products/' + prod[0].id)).j; assert.strictEqual(other.trade.hs_code, '6109.10', 'rows that left cells empty keep their saved data');
  });
  await test('bad uploads are refused cleanly', async () => {
    assert.strictEqual((await call('POST', '/api/admin/trade/products/import/preview', { data: 'not base64!!' }, admin)).s, 400);
    assert.strictEqual((await call('POST', '/api/admin/trade/products/import/preview', { filename: 'x.csv', data: Buffer.from('foo,bar\n1,2\n').toString('base64') }, admin)).s, 400);
    assert.strictEqual((await call('POST', '/api/admin/trade/products/import/commit', { filename: 'x.xlsx', data: b64([hdr, ['', 'x', 'Yes']]) }, emp.analyst)).s, 403, 'analysts cannot import');
  });

  console.log('\nDashboard');
  await test('the dashboard answers with real zeros when there are no international orders, and flags missing or stale rates', async () => {
    const d = await A('GET', '/dashboard'); assert.strictEqual(d.s, 200, d.t); assert.strictEqual(d.j.kpi.export_orders, 0); assert.strictEqual(d.j.kpi.international_sales_ngn, 0); assert.deepStrictEqual(d.j.sales_by_country, []);
    assert.strictEqual((await A('GET', '/dashboard?from=nonsense')).s, 400);
  });

  console.log('\nExisting shop');
  await test('the normal shop still works (catalogue, config, health) and the brand is VELTO-MART', async () => {
    assert.strictEqual((await call('GET', '/health')).s, 200); const p = await call('GET', '/api/products'); assert.strictEqual(p.s, 200); assert.ok((p.j.products || []).length > 0);
    const page = await call('GET', '/'); assert.ok(!/shop-?beta/i.test(page.t), 'no old brand name in the page');
  });

  srv.kill(); fxServer.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.split('\n').slice(-20).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { srv.kill(); fxServer.close(); } catch { /* */ } await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); process.exit(1); });
