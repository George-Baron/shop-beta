'use strict';
// Wholesale: application and evaluation, wholesale prices, quote -> proforma -> accept -> PAY -> ship, stock held and released.
// Run with: npm run test:wholesale   (needs TEST_DATABASE_URL like the main test)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_whole_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500);
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
const call = async (method, url, body, cookie) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  if (process.env.DEBUG_V && r.status >= 400) console.log('   [' + r.status + '] ' + method + ' ' + url + ' ' + t.slice(0, 200));
  return { s: r.status, j, t, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + email + ' ' + r.t); return r.c; };
const PW = 'Wholesale-Test-Pass-2026!';
const stockOf = async (id) => Number((await q('SELECT stock FROM products WHERE id=$1', [id]))[0].stock);
const appBody = (o = {}) => ({ business_name: 'Ada Provisions Ltd', contact_name: 'Ada Obi', phone: '08031234567', address: '5 Trade Fair Road', state: 'Lagos', city: 'Ojo', reg_no: 'RC445566', business_type: 'Retailer', buys: 'Rice, beans and cooking oil for my shops', est_monthly: '₦2m', ...o });

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-whole-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, u, b, admin);
  const W = (m, u, b) => A(m, '/api/admin/wholesale' + u, b);
  const prods = (await q("SELECT id, name, price, stock FROM products WHERE vendor_id IS NULL AND is_pharmacy=0 AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id=products.id) AND stock >= 30 ORDER BY id LIMIT 3"));
  assert.ok(prods.length >= 2, 'need two plain products with stock');
  const [P1, P2] = prods; const P1stock = Number(P1.stock);
  const variantProd = (await q('SELECT product_id AS id FROM variants LIMIT 1'))[0];
  let buyer, buyerAcct, ref, ref2;

  console.log('\nApplying and evaluation');
  await test('wholesale needs a signed-in account; a buyer applies with business details and is put under evaluation', async () => {
    assert.strictEqual((await call('GET', '/api/wholesale/me')).s, 401);
    const reg = await call('POST', '/api/auth/register', { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: PW }); assert.strictEqual(reg.s, 200, reg.t);
    buyer = await login('ada@example.com', PW);
    const C = (m, u, b) => call(m, '/api/wholesale' + u, b, buyer);
    assert.strictEqual((await C('POST', '/apply', appBody({ reg_no: '' }))).s, 400);
    assert.strictEqual((await C('POST', '/apply', appBody({ buys: '' }))).s, 400);
    assert.strictEqual((await C('POST', '/apply', appBody())).s, 200);
    assert.strictEqual((await C('POST', '/apply', appBody())).s, 409);
    const me = (await C('GET', '/me')).j; assert.strictEqual(me.account.status, 'pending'); assert.ok(me.account.evaluate_until > Date.now() / 1000 + 15 * 86400, 'evaluation is a few weeks');
    assert.strictEqual((await C('GET', '/catalog')).s, 403, 'no prices while under evaluation');
    assert.strictEqual((await C('POST', '/quotes', { items: [{ productId: P1.id, qty: 5 }] })).s, 403);
  });
  await test('approving early needs an explicit confirmation; rejecting needs a reason', async () => {
    const acc = (await W('GET', '/accounts')).j.accounts[0]; buyerAcct = acc.id;
    assert.strictEqual((await W('POST', `/accounts/${acc.id}/approve`, {})).s, 409);
    assert.strictEqual((await W('POST', `/accounts/${acc.id}/reject`, {})).s, 400);
    assert.strictEqual((await W('POST', `/accounts/${acc.id}/approve`, { early: true })).s, 200);
    assert.strictEqual((await call('GET', '/api/wholesale/me', undefined, buyer)).j.account.status, 'approved');
  });

  console.log('\nWholesale prices');
  await test('wholesale prices: only our own products, below retail, never in public responses', async () => {
    assert.strictEqual((await W('PUT', `/products/${P1.id}`, { wholesale_price: P1.price + 1, wholesale_min_qty: 5 })).s, 400, 'not above retail');
    assert.strictEqual((await W('PUT', `/products/${variantProd.id}`, { wholesale_price: 100, wholesale_min_qty: 5 })).s, 400, 'sizes/colours not offered yet');
    assert.strictEqual((await W('PUT', `/products/${P1.id}`, { wholesale_price: Math.floor(P1.price * 0.7), wholesale_min_qty: 5 })).s, 200);
    assert.strictEqual((await W('PUT', `/products/${P2.id}`, { wholesale_price: Math.floor(P2.price * 0.8), wholesale_min_qty: 3 })).s, 200);
    const pub = await call('GET', '/api/products?limit=100'); assert.ok(!pub.t.includes('wholesale'), 'public listing has no wholesale data');
    const one = await call('GET', '/api/products/' + (await q('SELECT slug FROM products WHERE id=$1', [P1.id]))[0].slug); assert.ok(!one.t.includes('wholesale'));
  });
  await test('the approved buyer sees wholesale prices and minimums', async () => {
    const cat = (await call('GET', '/api/wholesale/catalog', undefined, buyer)).j.products;
    const p = cat.find((x) => x.id == P1.id); assert.ok(p && p.min_qty === 5 && p.price === Math.floor(P1.price * 0.7));
    assert.ok(!cat.some((x) => x.id == variantProd.id));
  });

  console.log('\nRequest and quotation');
  await test('a request respects minimum quantity and stock, and only our own products', async () => {
    const R = (items) => call('POST', '/api/wholesale/quotes', { items, ship_address: '5 Trade Fair Road', ship_state: 'Lagos' }, buyer);
    assert.strictEqual((await R([{ productId: P1.id, qty: 2 }])).s, 400, 'below minimum');
    assert.strictEqual((await R([{ productId: P1.id, qty: P1stock + 1 }])).s, 400, 'above stock');
    assert.strictEqual((await R([])).s, 400);
    const vend = (await q("INSERT INTO vendors (slug,name,status,created) VALUES ('zz','ZZ','approved',1) RETURNING id"))[0].id;
    const vp = (await q("INSERT INTO products (slug,store,name,price,stock,vendor_id,listing,wholesale_price,created) VALUES ('zz-p','supermarket','Partner thing',1000,50,$1,'approved',500,1) RETURNING id", [vend]))[0].id;
    assert.strictEqual((await R([{ productId: vp, qty: 5 }])).s, 400, 'partner stock is never sold wholesale');
    const ok = await R([{ productId: P1.id, qty: 10 }, { productId: P2.id, qty: 4 }]); assert.strictEqual(ok.s, 200, ok.t); ref = ok.j.ref; assert.match(ref, /^WQ-[A-Z2-9]{8}$/);
  });
  await test('we compile the proforma: goods + logistics fee + service fee, with a shipment plan', async () => {
    const d = (await W('GET', '/quotes/' + ref)).j.quote; assert.strictEqual(d.status, 'requested'); assert.strictEqual(d.goods_total, 10 * Math.floor(P1.price * 0.7) + 4 * Math.floor(P2.price * 0.8));
    assert.strictEqual((await W('POST', `/quotes/${ref}/send`, { logistics_fee: 15000, service_pct: 3 })).s, 400, 'a shipment plan is required');
    const items = d.items.map((i) => ({ id: i.id, qty: i.qty, unit_price: i.product_id == P1.id ? 1000 : i.unit_price }));
    assert.strictEqual((await W('POST', `/quotes/${ref}/send`, { items, logistics_fee: 15000, service_pct: 3, valid_days: 7, shipment_plan: 'Our truck from Lagos, within 3 days of payment' })).s, 200);
    const sent = (await call('GET', '/api/wholesale/quotes/' + ref, undefined, buyer)).j.quote;
    const goods = 10 * 1000 + 4 * Math.floor(P2.price * 0.8), service = Math.round(goods * 0.03);
    assert.strictEqual(sent.status, 'quoted'); assert.strictEqual(sent.goods_total, goods); assert.strictEqual(sent.logistics_fee, 15000); assert.strictEqual(sent.service_fee, service); assert.strictEqual(sent.total, goods + 15000 + service);
    assert.ok(sent.valid_until > Date.now() / 1000);
  });
  await test('another buyer cannot see this quote', async () => {
    await call('POST', '/api/auth/register', { name: 'Eve', email: 'eve@example.com', phone: '08000000009', password: PW });
    const eve = await login('eve@example.com', PW);
    assert.strictEqual((await call('GET', '/api/wholesale/quotes/' + ref, undefined, eve)).s, 404);
    assert.strictEqual((await call('POST', `/api/wholesale/quotes/${ref}/accept`, {}, eve)).s, 404);
  });

  console.log('\nAccept, pay, then ship');
  await test('accepting sets the goods aside; paying and shipping come strictly in that order', async () => {
    const C = (m, u, b) => call(m, '/api/wholesale' + u, b, buyer);
    assert.strictEqual((await C('POST', `/quotes/${ref}/pay`, {})).s, 409, 'accept first');
    assert.strictEqual((await W('POST', `/quotes/${ref}/ship`, { carrier: 'Our truck' })).s, 409, 'no shipping before payment');
    assert.strictEqual((await C('POST', `/quotes/${ref}/accept`, {})).s, 200);
    assert.strictEqual(await stockOf(P1.id), P1stock - 10, 'stock is held');
    assert.strictEqual((await C('POST', `/quotes/${ref}/accept`, {})).s, 409, 'only once');
    assert.strictEqual((await W('POST', `/quotes/${ref}/ship`, { carrier: 'Our truck' })).s, 409, 'still unpaid');
    assert.strictEqual((await W('POST', `/quotes/${ref}/send`, { logistics_fee: 1, shipment_plan: 'x' })).s, 409, 'cannot change an accepted quote');
    const acc = (await C('GET', '/quotes/' + ref)).j.quote; assert.strictEqual(acc.status, 'accepted'); assert.ok(acc.pay_by);
    assert.strictEqual((await C('POST', `/quotes/${ref}/pay`, {})).j.demo, true, 'demo mode without a Paystack key');
    assert.strictEqual((await C('POST', `/quotes/${ref}/pay/demo`, {})).s, 200);
    assert.strictEqual((await C('GET', '/quotes/' + ref)).j.quote.status, 'paid');
    assert.strictEqual((await W('POST', `/quotes/${ref}/ship`, {})).s, 400, 'carrier is required');
    assert.strictEqual((await W('POST', `/quotes/${ref}/ship`, { carrier: 'Our truck', tracking: 'TRK-1' })).s, 200);
    assert.strictEqual((await W('POST', `/quotes/${ref}/deliver`, {})).s, 200);
    const done = (await C('GET', '/quotes/' + ref)).j.quote; assert.strictEqual(done.status, 'delivered'); assert.ok(done.events.length >= 6);
    assert.strictEqual(await stockOf(P1.id), P1stock - 10, 'delivered goods stay out of stock');
  });
  await test('bank transfer: we confirm it by hand with a reference; paying twice is harmless', async () => {
    const C = (m, u, b) => call(m, '/api/wholesale' + u, b, buyer);
    const r = await C('POST', '/quotes', { items: [{ productId: P2.id, qty: 3 }], ship_address: '5 Trade Fair Road', ship_state: 'Lagos' }); ref2 = r.j.ref;
    await W('PUT', '/settings', { wholesale_bank_details: 'Shop-Beta Ltd, 0123456789, Example Bank', wholesale_service_pct: 5 });
    assert.strictEqual((await W('POST', `/quotes/${ref2}/send`, { logistics_fee: 5000, shipment_plan: 'Courier', service_pct: '' })).s, 200);
    const sent = (await C('GET', '/quotes/' + ref2)).j.quote; assert.strictEqual(sent.service_pct, 5, 'blank service % uses the default setting');
    await C('POST', `/quotes/${ref2}/accept`, {});
    const acc = (await C('GET', '/quotes/' + ref2)).j.quote; assert.match(acc.bank, /0123456789/);
    assert.strictEqual((await W('POST', `/quotes/${ref2}/transfer`, {})).s, 400, 'needs a reference');
    assert.strictEqual((await W('POST', `/quotes/${ref2}/transfer`, { reference: 'GTB-889' })).s, 200);
    assert.strictEqual((await W('POST', `/quotes/${ref2}/transfer`, { reference: 'GTB-889' })).s, 409);
    assert.strictEqual((await C('POST', `/quotes/${ref2}/pay/demo`, {})).s, 200, 'a second payment changes nothing');
    assert.strictEqual((await C('GET', '/quotes/' + ref2)).j.quote.status, 'paid');
  });

  console.log('\nLapses and cancellations');
  await test('an unpaid accepted quote lapses and the goods go back on the shelf; late money is flagged, not lost', async () => {
    const C = (m, u, b) => call(m, '/api/wholesale' + u, b, buyer);
    const before = await stockOf(P2.id);
    const r = (await C('POST', '/quotes', { items: [{ productId: P2.id, qty: 4 }], ship_address: '5 Trade Fair Road', ship_state: 'Lagos' })).j.ref;
    await W('POST', `/quotes/${r}/send`, { logistics_fee: 0, shipment_plan: 'Collect', service_pct: 0 }); await C('POST', `/quotes/${r}/accept`, {});
    assert.strictEqual(await stockOf(P2.id), before - 4);
    await q("UPDATE wholesale_quotes SET pay_by = 1 WHERE ref=$1", [r]);
    const out = execFileSync(process.execPath, ['-e', "require('./lib/wholesale').expireLapsed().then((n) => { console.log('N=' + n); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); })"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: urlOf(DB) } }).toString();
    assert.match(out, /N=1/);
    assert.strictEqual(await stockOf(P2.id), before, 'goods released');
    assert.strictEqual((await C('GET', '/quotes/' + r)).j.quote.status, 'expired');
    assert.strictEqual((await W('POST', `/quotes/${r}/transfer`, { reference: 'LATE-1' })).s, 409, 'late money is not silently accepted');
    assert.ok((await W('GET', '/quotes/' + r)).j.quote.events.some((e) => /arrived while the quote was "expired"/.test(e.note)), 'flagged for a person');
  });
  await test('cancelling before shipping gives the goods back, even after payment', async () => {
    const C = (m, u, b) => call(m, '/api/wholesale' + u, b, buyer);
    const before = await stockOf(P1.id);
    const r = (await C('POST', '/quotes', { items: [{ productId: P1.id, qty: 6 }], ship_address: '5 Trade Fair Road', ship_state: 'Lagos' })).j.ref;
    await W('POST', `/quotes/${r}/send`, { logistics_fee: 0, shipment_plan: 'Collect', service_pct: 0 }); await C('POST', `/quotes/${r}/accept`, {}); await C('POST', `/quotes/${r}/pay/demo`, {});
    assert.strictEqual(await stockOf(P1.id), before - 6);
    assert.strictEqual((await W('POST', `/quotes/${r}/cancel`, {})).s, 400, 'a reason is required');
    assert.strictEqual((await W('POST', `/quotes/${r}/cancel`, { reason: 'Buyer asked to cancel' })).s, 200);
    assert.strictEqual(await stockOf(P1.id), before); assert.strictEqual((await W('POST', `/quotes/${r}/cancel`, { reason: 'again' })).s, 409);
    assert.ok((await W('GET', '/quotes/' + r)).j.quote.events.some((e) => /refund them/.test(e.note)));
  });
  await test('stock cannot be oversold: two quotes for the same last units, only one can be accepted', async () => {
    await q('UPDATE products SET stock=12 WHERE id=$1', [P2.id]);
    const C = (m, u, b) => call(m, '/api/wholesale' + u, b, buyer);
    const a1 = (await C('POST', '/quotes', { items: [{ productId: P2.id, qty: 8 }], ship_address: '5 Trade Fair Road', ship_state: 'Lagos' })).j.ref;
    const a2 = (await C('POST', '/quotes', { items: [{ productId: P2.id, qty: 8 }], ship_address: '5 Trade Fair Road', ship_state: 'Lagos' })).j.ref;
    for (const r of [a1, a2]) await W('POST', `/quotes/${r}/send`, { logistics_fee: 0, shipment_plan: 'Collect', service_pct: 0 });
    const rs = await Promise.all([C('POST', `/quotes/${a1}/accept`, {}), C('POST', `/quotes/${a2}/accept`, {})]);
    assert.deepStrictEqual(rs.map((x) => x.s).sort(), [200, 409]); assert.strictEqual(await stockOf(P2.id), 4);
  });

  console.log('\nPartner stores as buyers');
  await test('a partner store can apply as a wholesale buyer too, but still buys only from our stock', async () => {
    assert.strictEqual((await call('POST', '/api/partners/apply', { name: 'Corner Shop', contactName: 'Tola', email: 'tola.shop@example.com', phone: '08031230000', address: '1 Road', state: 'Lagos', city: 'Yaba', regNo: 'RC1', password: PW, departments: ['supermarket'] })).s, 200);
    const vc = await login('tola.shop@example.com', PW);
    assert.strictEqual((await call('POST', '/api/wholesale/apply', appBody({ business_name: 'Corner Shop' }), vc)).s, 200);
    const acc = (await W('GET', '/accounts?status=pending')).j.accounts.find((a) => a.business_name === 'Corner Shop'); assert.ok(acc && acc.partner_store);
    assert.strictEqual((await W('POST', `/accounts/${acc.id}/approve`, { early: true })).s, 200);
    const cat = (await call('GET', '/api/wholesale/catalog', undefined, vc)).j.products; assert.ok(cat.length >= 1 && cat.every((p) => p.name !== 'Partner thing'));
    assert.strictEqual((await call('POST', '/api/wholesale/apply', appBody(), admin)).s, 403, 'staff accounts do not apply');
  });
  await test('a suspended buyer loses wholesale prices at once', async () => {
    assert.strictEqual((await W('POST', `/accounts/${buyerAcct}/suspend`, { note: 'Under review' })).s, 200);
    assert.strictEqual((await call('GET', '/api/wholesale/catalog', undefined, buyer)).s, 403);
    assert.strictEqual((await W('POST', `/accounts/${buyerAcct}/approve`, { early: true })).s, 200);
  });

  srv.kill(); await sleep(300);
  await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); srv && srv.kill(); console.error(log.slice(-2500)); process.exit(1); });
