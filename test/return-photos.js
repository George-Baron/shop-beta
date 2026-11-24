'use strict';
// Photos on return requests and partner payout adjustment. Run with: npm run test:return-photos
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_rph_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
const OWNER = 'Str0ng-Owner-Pass!';
// Starts a server; mail=true gives it an email key (the send goes nowhere, the message is still stored in the outbox).
const http = require('http');
// A pretend Paystack: records refund requests; set fake.fail to make it refuse.
const fake = { calls: [], fail: false };
const fakeSrv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { if (req.url === '/refund') { const j = JSON.parse(b || '{}'); fake.calls.push({ ...j, auth: req.headers.authorization }); res.setHeader('Content-Type', 'application/json'); if (fake.fail) { res.statusCode = 400; return res.end(JSON.stringify({ status: false, message: 'Transaction has already been fully reversed' })); } return res.end(JSON.stringify({ status: true, message: 'queued', data: { id: 9000 + fake.calls.length, status: 'pending', transaction: j.transaction } })); } res.statusCode = 404; res.end('{}'); }); });
const start = async (port, mail, fakePort) => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), BASE_URL: 'http://127.0.0.1:' + port, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-ret-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: OWNER, RATE_LIMIT_MULTIPLIER: '50', RESEND_API_KEY: 're_test', RESEND_API_URL: 'http://127.0.0.1:9', WORKER_ENABLED: '0', PAYSTACK_SECRET_KEY: 'sk_test_fake', PAYSTACK_API_URL: 'http://127.0.0.1:' + fakePort } });
  if (process.env.SHOW_LOG) { srv.stdout.on('data', (d) => process.stdout.write(d)); srv.stderr.on('data', (d) => process.stderr.write(d)); }
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); } }
  const call = async (method, url, body, cookie) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; return { s: r.status, j, t, c: (sc[0] || '').split(';')[0] }; };
  return { srv, call };
};
(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  const port = 7200 + Math.floor(Math.random() * 700), fport = 7900 + Math.floor(Math.random() * 90);
  await new Promise((r) => fakeSrv.listen(fport, '127.0.0.1', r));
  const PORT = port;
  const { srv, call } = await start(port, true, fport);
  const owner = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: OWNER })).c;
  const A = (m, u, b, c) => call(m, '/api/admin' + u, b, c === undefined ? owner : c);
  const PW = 'Blue-Harbour-Lamp-2026-x', T = () => Math.floor(Date.now() / 1000);
  const reg = async (name, email) => { assert.strictEqual((await call('POST', '/api/auth/register', { name, email, phone: '0803' + String(Math.random()).slice(2, 9), password: PW })).s, 200); return { id: Number((await q('SELECT id FROM users WHERE email=$1', [email]))[0].id), c: (await call('POST', '/api/auth/login', { email, password: PW })).c, email, name }; };
  const ada = await reg('Ada Buyer', 'ada@buyer.com'), bob = await reg('Bob Other', 'bob@buyer.com');
  const prod = async (slug, name, price, stock) => Number((await q("INSERT INTO products (slug,store,name,price,stock,sku,listing,active,created,images) VALUES ($1,'supermarket',$2,$3,$4,$1,'approved',1,1,'[]') RETURNING id", [slug, name, price, stock]))[0].id);
  const kettle = await prod('kettle', 'Kettle', 6000, 10), mug = await prod('mug', 'Mug', 1000, 10), fan = await prod('fan', 'Fan', 4000, 10);
  let n = 0;
  // an order that is already paid and delivered. lines: [[productId, name, price, qty]]
  const order = async (o = {}) => {
    const lines = o.lines || [[kettle, 'Kettle', 6000, 1], [mug, 'Mug', 1000, 2]], sub = lines.reduce((a, l) => a + l[2] * l[3], 0), fee = o.fee === undefined ? 1500 : o.fee, total = o.total || sub + fee - (o.discount || 0), ref = o.ref || 'RT' + (++n) + tag.toUpperCase().slice(-3);
    const id = Number((await q(`INSERT INTO orders (ref,user_id,status,payment_method,payment_status,paystack_ref,name,email,phone,state,delivery_fee,subtotal,discount,total,created,access_token,delivered_at,wallet_amount) VALUES ($1,$2,$3,$4,$5,$6,'Ada Buyer',$7,'08031234567','Lagos',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [ref, o.user === undefined ? ada.id : o.user, o.status || 'delivered', o.pm || 'paystack', o.ps || 'paid', o.pref === undefined ? 'PSREF-' + ref : o.pref, o.email || 'ada@buyer.com', fee, sub, o.discount || 0, total, T() - 86400 * 3, 'tok' + ref + 'x'.repeat(20), o.deliveredAt === undefined ? T() - 86400 : o.deliveredAt, o.wallet || 0]))[0].id);
    for (const l of lines) await q("INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES ($1,$2,$3,$4,$5)", [id, l[0], l[1], l[2], l[3]]);
    return { id, ref, token: 'tok' + ref + 'x'.repeat(20), total, sub, items: (await q('SELECT id, product_id, name, price, qty FROM order_items WHERE order_id=$1 ORDER BY id', [id])).map((r) => ({ ...r, id: Number(r.id) })) };
  };
  const view = async (o, c = ada.c) => (await call('POST', '/api/orders/lookup', { ref: o.ref }, c)).j.order;
  const ask = (o, b, c = ada.c) => call('POST', `/api/orders/${o.ref}/return`, { reason: 'faulty', condition: 'damaged', packaging: 'original', details: 'The element does not heat up at all.', items: [{ item_id: o.items[0].id, qty: 1 }], ...b }, c);
  const stock = async (id) => Number((await q('SELECT stock FROM products WHERE id=$1', [id]))[0].stock);
  const wallet = async (uid) => (await q("SELECT COALESCE(SUM(amount),0)::bigint n FROM wallet_txns WHERE user_id=$1 AND type='refund'", [uid]))[0].n;
  const ret = async (id) => (await q('SELECT * FROM order_returns WHERE id=$1', [id]))[0];
  const emp = async (name, email, role) => { const roles = (await A('GET', '/staff')).j.roles; const r = await A('POST', '/staff', { name, email, role_id: roles.find((x) => x.name === role).id, password: 'Orange-Table-Lamp-2026-' + name.length }); assert.strictEqual(r.s, 200, r.t); return (await call('POST', '/api/auth/login', { email, password: 'Orange-Table-Lamp-2026-' + name.length })).c; };


  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const dataUrl = (b, m = 'image/png') => `data:${m};base64,${b.toString('base64')}`;
  const shot = (o, rid, data, c = ada.c) => call('POST', `/api/orders/${o.ref}/return/${rid}/photos`, { data }, c);
  const vendorId = Number((await q("INSERT INTO vendors (slug,name,status,commission_pct,created) VALUES ('shop-a','Shop A','approved',10,1) RETURNING id"))[0].id);
  const vend = await reg('Vera Vendor', 'vera@shop.com'); await q("UPDATE users SET role='vendor', vendor_id=$1 WHERE id=$2", [vendorId, vend.id]);
  // a delivered order whose kettle (₦6000, commission ₦600) belongs to the partner and whose mugs (₦1000 x2) are ours
  const vorder = async () => { const d = await order(); await q('UPDATE order_items SET vendor_id=$1, commission=600 WHERE id=$2', [vendorId, d.items[0].id]); return d; };
  const earn = async () => (await call('GET', '/api/partner/earnings', undefined, vend.c)).j;

  console.log('\nPhotos on a return');
  let d1, r1;
  await test('the customer can attach photos to a request; only real images, at most 5, and only the owner', async () => {
    d1 = await order(); r1 = (await ask(d1, {})).j;
    const ok = await shot(d1, r1.id, dataUrl(PNG)); assert.strictEqual(ok.s, 200, ok.t);
    assert.strictEqual((await shot(d1, r1.id, dataUrl(Buffer.from('not an image at all, just text'), 'image/png'))).s, 400);
    assert.strictEqual((await shot(d1, r1.id, '')).s, 400);
    assert.strictEqual((await shot(d1, r1.id, dataUrl(PNG), bob.c)).s, 404, 'another customer');
    assert.strictEqual((await call('POST', `/api/orders/${d1.ref}/return/${r1.id}/photos`, { data: dataUrl(PNG), email: 'ada@buyer.com' })).s, 403, 'email alone is not enough');
    for (let i = 0; i < 4; i++) assert.strictEqual((await shot(d1, r1.id, dataUrl(PNG))).s, 200);
    const six = await shot(d1, r1.id, dataUrl(PNG)); assert.strictEqual(six.s, 400); assert.ok(/at most|Up to 5/i.test(six.t) || /Up to 5/.test(six.t), six.t);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM order_return_photos WHERE return_id=$1', [r1.id]))[0].n, 5);
  });
  await test('an oversized photo is refused', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(4_100_000)]); const d = await order(); const r = (await ask(d, {})).j;
    const x = await shot(d, r.id, dataUrl(big)); assert.ok([400, 413].includes(x.s), x.s + ' ' + x.t);
  });
  await test('the customer sees thumbnails ids and can open them (owner only); the photo bytes are served as an image', async () => {
    const v = await view(d1); assert.strictEqual(v.returns[0].photos.length, 5);
    const pid = v.returns[0].photos[0];
    const own = await fetch(`http://127.0.0.1:${PORT}/api/orders/${d1.ref}/return/${r1.id}/photos/${pid}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ada.c }, body: '{}' });
    assert.strictEqual(own.status, 200); assert.strictEqual(own.headers.get('content-type'), 'image/png'); assert.strictEqual(own.headers.get('x-content-type-options'), 'nosniff'); assert.ok(Buffer.from(await own.arrayBuffer()).equals(PNG));
    const other = await fetch(`http://127.0.0.1:${PORT}/api/orders/${d1.ref}/return/${r1.id}/photos/${pid}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob.c }, body: '{}' }); assert.strictEqual(other.status, 404);
  });
  await test('staff see the photos in the return; shoppers and unrelated staff cannot open them', async () => {
    const det = (await A('GET', '/returns/' + r1.id)).j; assert.strictEqual(det.photos.length, 5);
    const f = await fetch(`http://127.0.0.1:${PORT}/api/admin/returns/${r1.id}/photos/${det.photos[0]}`, { headers: { Cookie: owner } }); assert.strictEqual(f.status, 200); assert.strictEqual(f.headers.get('content-type'), 'image/png');
    const sh = await fetch(`http://127.0.0.1:${PORT}/api/admin/returns/${r1.id}/photos/${det.photos[0]}`, { headers: { Cookie: ada.c } }); assert.ok([401, 403].includes(sh.status));
    const nobody = await emp('Ivy Inventory', 'ivy@example.com', 'Inventory Officer'); const g = await fetch(`http://127.0.0.1:${PORT}/api/admin/returns/${r1.id}/photos/${det.photos[0]}`, { headers: { Cookie: nobody } }); assert.strictEqual(g.status, 403);
  });
  await test('a photo can be removed by its owner while the request is waiting, but not after a decision', async () => {
    const v = await view(d1), pid = v.returns[0].photos[4];
    assert.strictEqual((await call('POST', `/api/orders/${d1.ref}/return/${r1.id}/photos/${pid}/delete`, {}, bob.c)).s, 404);
    assert.strictEqual((await call('POST', `/api/orders/${d1.ref}/return/${r1.id}/photos/${pid}/delete`, {}, ada.c)).s, 200);
    assert.strictEqual((await view(d1)).returns[0].photos.length, 4);
    assert.strictEqual((await A('POST', `/returns/${r1.id}/approve`, {})).s, 200);
    assert.strictEqual((await shot(d1, r1.id, dataUrl(PNG))).s, 409, 'no new photos after review');
  });

  console.log('\nPartner payout adjustment');
  let v1, rv;
  await test('before any return the partner balance is the usual delivered net', async () => {
    v1 = await vorder(); const e = await earn(); assert.strictEqual(e.gross, 6000); assert.strictEqual(e.commission, 600); assert.strictEqual(e.adjustments, 0); assert.strictEqual(e.balance, 5400);
  });
  await test('staff see which partner is affected and how much before settling', async () => {
    rv = (await ask(v1, { items: [{ item_id: v1.items[0].id, qty: 1 }] })).j; assert.strictEqual((await A('POST', `/returns/${rv.id}/approve`, {})).s, 200);
    const det = (await A('GET', '/returns/' + rv.id)).j; assert.deepStrictEqual(det.vendor_shares.map((x) => [x.name, x.amount]), [['Shop A', 5400]]);
  });
  await test('settling takes the returned goods (after commission) off the partner\'s balance, once, and tells the partner', async () => {
    const s = await A('POST', `/returns/${rv.id}/settle`, { method: 'wallet', restock: true }); assert.strictEqual(s.s, 200, s.t);
    const e = await earn(); assert.strictEqual(e.adjustments, -5400); assert.strictEqual(e.balance, 0); assert.strictEqual(e.adjustment_rows.length, 1); assert.strictEqual(Number(e.adjustment_rows[0].amount), -5400);
    assert.strictEqual((await A('POST', `/returns/${rv.id}/settle`, { method: 'wallet' })).s, 409);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM vendor_adjustments WHERE return_id=$1', [rv.id]))[0].n, 1, 'never twice');
    assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND type='return'", [vend.id])).length >= 1, 'partner told');
  });
  await test('the partner cannot be paid out more than what is left after the return', async () => {
    const v2 = await vorder(); let e = await earn(); assert.strictEqual(e.balance, 5400);
    const pay = (amount) => A('POST', `/vendors/${vendorId}/payouts`, { amount, method: 'bank', reference: 'REF' + amount });
    assert.strictEqual((await pay(5401)).s, 409); assert.strictEqual((await pay(5400)).s, 200); e = await earn(); assert.strictEqual(e.balance, 0);
  });
  await test('staff can cover a return themselves: unticking "take it off the partner" leaves the balance alone', async () => {
    const v3 = await vorder(); const r = (await ask(v3, { items: [{ item_id: v3.items[0].id, qty: 1 }] })).j; await A('POST', `/returns/${r.id}/approve`, {});
    const before = (await earn()).balance; const s = await A('POST', `/returns/${r.id}/settle`, { method: 'wallet', charge_vendor: false }); assert.strictEqual(s.s, 200, s.t);
    assert.strictEqual((await earn()).balance, before); assert.strictEqual((await ret(r.id)).charge_vendor, 0);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM vendor_adjustments WHERE return_id=$1', [r.id]))[0].n, 0);
  });
  await test('orders with no partner items, and a partly approved refund, are handled: no adjustment / a proportional one', async () => {
    const own = await order(); const r = (await ask(own, {})).j; await A('POST', `/returns/${r.id}/approve`, {}); await A('POST', `/returns/${r.id}/settle`, { method: 'wallet' });
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM vendor_adjustments WHERE order_id=$1', [own.id]))[0].n, 0);
    const v4 = await vorder(); const p = (await ask(v4, { items: [{ item_id: v4.items[0].id, qty: 1 }] })).j; assert.strictEqual((await A('POST', `/returns/${p.id}/approve`, { amount: 3000, note: 'Half refunded, item was used.' })).s, 200);
    const before = (await earn()).balance; await A('POST', `/returns/${p.id}/settle`, { method: 'wallet' });
    assert.strictEqual(before - (await earn()).balance, 2700, 'half of the 5400 net');
  });
  await test('when the whole order is refunded it drops out of the partner\'s earnings by itself, with no second deduction', async () => {
    const w = await vorder(); const before = (await earn()).balance;
    const r = (await ask(w, { items: w.items.map((i) => ({ item_id: i.id, qty: i.qty })) })).j; await A('POST', `/returns/${r.id}/approve`, {}); const s = await A('POST', `/returns/${r.id}/settle`, { method: 'wallet' }); assert.strictEqual(s.s, 200, s.t);
    assert.strictEqual((await q('SELECT status FROM orders WHERE id=$1', [w.id]))[0].status, 'refunded');
    assert.strictEqual((await earn()).balance, before - 5400, 'exactly the partner net of that order, once');
  });
  await test('the partner report and the staff partner page show the adjustment', async () => {
    const rep = await call('GET', '/api/partner/reports/payouts', undefined, vend.c); assert.strictEqual(rep.s, 200, rep.t); assert.ok(rep.j.report.summary.some((x) => x.label === 'Returns taken off' && x.value < 0), JSON.stringify(rep.j.report.summary));
    const vd = (await A('GET', '/vendors/' + vendorId)).j; assert.ok(vd.adjustment_rows.length >= 2 && vd.vendor.adjustments < 0);
  });
  console.log('\nSafety');
  await test('photos and adjustment tables are locked down and the customer page leaks nothing about partners', async () => {
    for (const t of ['order_return_photos', 'vendor_adjustments']) assert.strictEqual((await q('SELECT relrowsecurity FROM pg_class WHERE relname=$1', [t]))[0].relrowsecurity, true, t);
    const t = JSON.stringify(await view(v1)); assert.ok(!/vendor_adjustments|charge_vendor|vendor_shares|"stored"/.test(t), 'leak: ' + (t.match(/vendor_adjustments|charge_vendor|vendor_shares|"stored"/) || [''])[0]);
  });
  srv.kill(); fakeSrv.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
