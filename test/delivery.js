'use strict';
// Step 6A check: delivery rules (distance, range, fee, promised time), map-provider cache and fallback, riders, handover code.
// Run with: npm run test:delivery   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_delivery_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const FAKE = 6100 + Math.floor(Math.random() * 1500), P1 = FAKE + 1500;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delivery-'));
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 7).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(200); } };
const rad = (d) => (d * Math.PI) / 180;
const hav = (a, b) => { const dl = rad(b[0] - a[0]), dg = rad(b[1] - a[1]); const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dg / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };

// A stand-in for the Geoapify map service.
const fx = { routeCalls: 0, searchCalls: 0, down: false };
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const send = (s, o) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
  if (u.pathname === '/v1/routing') {
    fx.routeCalls++; if (fx.down) return send(500, {});
    const [a, b] = u.searchParams.get('waypoints').split('|').map((x) => x.split(',').map(Number)); const m = hav(a, b) * 1.3 * 1000;
    return send(200, { features: [{ properties: { distance: m, time: (m / 1000 / 30) * 3600 }, geometry: { type: 'LineString', coordinates: [[a[1], a[0]], [(a[1] + b[1]) / 2, (a[0] + b[0]) / 2], [b[1], b[0]]] } }] });
  }
  if (u.pathname === '/v1/geocode/search') { fx.searchCalls++; return send(200, { results: [{ formatted: 'Yaba, Lagos, Nigeria', lat: 6.5095, lon: 3.3711 }, { formatted: 'Somewhere in London', lat: 51.5, lon: -0.12 }] }); }
  send(404, {});
});
const q = async (sql, args) => { const c = new Pg({ connectionString: URL_DB }); await c.connect(); try { return (await c.query(sql, args)).rows; } finally { await c.end(); } };
const pg = async (sql) => { const c = new Pg({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const call = async (method, url, body, cookie) => { const r = await fetch(`http://127.0.0.1:${P1}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.getSetCookie ? r.headers.getSetCookie()[0] || '' : ''; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, c: sc.split(';')[0] }; };
const up = async () => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${P1}/health`); return; } catch { await sleep(100); } } throw new Error('app did not start'); };

const MAIN = [6.6018, 3.3515], LEKKI = [6.4698, 3.5852], YABA = [6.5095, 3.3711], VI = [6.4281, 3.4219], ABUJA = [9.0765, 7.3986], NEAR = [6.55, 3.38];

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  await pg(`CREATE DATABASE ${DB}`);
  process.env.DATABASE_URL = URL_DB; process.env.DATABASE_SSL = 'off';
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(P1), BASE_URL: 'http://127.0.0.1:' + P1, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '', GEOAPIFY_API_KEY: 'test-key', GEO_API_URL: 'http://127.0.0.1:' + FAKE, RATE_LIMIT_MULTIPLIER: '200', GEO_DOWN_PAUSE_MS: '300', WORKER_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.log = ''; app.stdout.on('data', (d) => { app.log += d; }); app.stderr.on('data', (d) => { app.log += d; });
  await up();
  const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' })).c;
  const rows = await q("SELECT id FROM products WHERE active=1 AND stock>=30 AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 3");
  const [PA, PB] = rows.map((r) => Number(r.id));
  const order = (extra = {}) => ({ items: [{ productId: PA, qty: 1 }], contact: { name: 'Ada Obi', email: extra.email || 'ada@example.com', phone: ('080' + String(parseInt(require('crypto').createHash('md5').update(extra.email || 'ada').digest('hex').slice(0, 7), 16)).padStart(8, '0').slice(-8)) }, address: { state: extra.state || 'Lagos', city: 'Yaba', address: '1 Road Street' }, delivery: 'standard', payment: extra.payment || 'pod', ...(extra.loc ? { location: { lat: extra.loc[0], lng: extra.loc[1], landmark: 'Blue gate' } } : {}), ...(extra.items ? { items: extra.items } : {}) });
  const quote = (loc, extra = {}) => call('POST', '/api/delivery/quote', { location: { lat: loc[0], lng: loc[1] }, state: extra.state || 'Lagos', items: extra.items || [{ productId: PA, qty: 1 }] });

  await test('before any pickup point exists, delivery works as before (state fee only)', async () => {
    const r = await quote(YABA); assert.strictEqual(r.j.mapped, false);
    assert.strictEqual((await call('POST', '/api/checkout', order({ email: 'legacy@example.com' }))).s, 200);
  });

  await call('PUT', '/api/admin/settings', { settings: { open_hour: 0, cutoff_hour: 24, prep_minutes: 20, max_distance_km: 60 } }, admin);
  const mainId = (await call('POST', '/api/admin/partners', { name: 'Shop-Beta Main Store', address: 'Ikeja, Lagos', state: 'Lagos', phone: '08000000001', lat: MAIN[0], lng: MAIN[1], radius_km: 20, is_default: true }, admin)).j.id;
  const lekkiId = (await call('POST', '/api/admin/partners', { name: 'Lekki Partner', address: 'Lekki, Lagos', state: 'Lagos', phone: '08000000002', lat: LEKKI[0], lng: LEKKI[1], radius_km: 45 }, admin)).j.id;
  await call('PUT', `/api/admin/products/${PB}/partner`, { partnerId: lekkiId }, admin);
  const rider = async (email) => { await call('POST', '/api/admin/riders', { name: 'Rider ' + email.split('@')[0], email, phone: '08033334444', password: 'RiderPass123', coverage: 'Lagos' }, admin); return (await call('POST', '/api/auth/login', { email, password: 'RiderPass123' })).c; };
  const r1 = await rider('rider1@example.com'), r2 = await rider('rider2@example.com');
  const rider1Id = Number((await q("SELECT id FROM users WHERE email='rider1@example.com'"))[0].id);

  await test('pickup points only accept real coordinates inside Nigeria', async () => {
    assert.strictEqual((await call('POST', '/api/admin/partners', { name: 'Nowhere', lat: 51.5, lng: -0.1 }, admin)).s, 400);
    assert.strictEqual((await call('POST', '/api/admin/partners', { name: '', lat: 6.5, lng: 3.3 }, admin)).s, 400);
  });
  await test('a delivery in range gets distance, driving time, fee and a promised time', async () => {
    const r = await quote(YABA); assert.strictEqual(r.j.ok, true); assert.strictEqual(r.j.legs.length, 1);
    const expect = Math.round(hav(MAIN, YABA) * 1.3 * 10) / 10; assert.ok(Math.abs(r.j.km - expect) < 0.2, `km ${r.j.km} vs ${expect}`);
    assert.ok(r.j.etaMin >= 20 && r.j.promisedAt > Date.now() / 1000); assert.strictEqual(r.j.legs[0].phone, undefined, 'partner phone must not be shown to customers');
  });
  await test('outside Nigeria, out of range, and no rider in that state are all refused with a clear reason and an alternative', async () => {
    const a = await quote([51.5, -0.12]); assert.strictEqual(a.j.ok, false); assert.strictEqual(a.j.reason, 'outside_nigeria'); assert.deepStrictEqual(a.j.alternatives, ['pickup']);
    const b = await quote(ABUJA, { state: 'Lagos' }); assert.strictEqual(b.j.reason, 'out_of_range'); assert.match(b.j.message, /km/);
    const c = await quote(ABUJA, { state: 'FCT' }); assert.strictEqual(c.j.reason, 'no_rider');
    const d = await call('POST', '/api/delivery/quote', { location: { lat: 'abc', lng: null }, state: 'Lagos' }); assert.strictEqual(d.j.ok, false);
  });
  await test('route answers are cached: the same trip does not call the map provider again', async () => {
    await quote(VI); const n = fx.routeCalls; await quote(VI); await quote([VI[0] + 0.0002, VI[1] + 0.0002]); assert.strictEqual(fx.routeCalls, n);
  });
  await test('when the map provider is down, quotes still work using a straight-line estimate', async () => {
    fx.down = true; const r = await quote([6.55, 3.38]); fx.down = false;
    assert.strictEqual(r.j.ok, true); assert.strictEqual(r.j.approx, true); assert.ok(r.j.km > 0);
    await sleep(500); await q("DELETE FROM geo_cache"); // let the provider's "down" pause expire for the tests below
  });
  await test('address search is limited to Nigeria and cached', async () => {
    const a = await call('GET', '/api/delivery/search?q=yaba+lagos'); assert.strictEqual(a.j.results.length, 1); assert.match(a.j.results[0].label, /Yaba/);
    const n = fx.searchCalls; await call('GET', '/api/delivery/search?q=Yaba%20%20Lagos'); assert.strictEqual(fx.searchCalls, n);
  });
  await test('the promised time respects opening hours and the order cut-off', async () => {
    const D = require('../lib/delivery');
    const lagos = (y, m, d, h) => Date.UTC(y, m, d, h - 1) / 1000;
    assert.strictEqual(D.promiseFrom(lagos(2026, 10, 10, 21), 30, { open_hour: 8, cutoff_hour: 20 }), lagos(2026, 10, 11, 8) + 1800);
    assert.strictEqual(D.promiseFrom(lagos(2026, 10, 10, 5), 30, { open_hour: 8, cutoff_hour: 20 }), lagos(2026, 10, 10, 8) + 1800);
    assert.strictEqual(D.promiseFrom(lagos(2026, 10, 10, 12), 45, { open_hour: 8, cutoff_hour: 20 }), lagos(2026, 10, 10, 12) + 2700);
  });
  await test('checkout needs a pin, refuses far addresses (no order, no stock taken), and stores distance and promised time', async () => {
    const stock0 = Number((await q('SELECT stock FROM products WHERE id=$1', [PA]))[0].stock);
    assert.strictEqual((await call('POST', '/api/checkout', order({ email: 'nopin@example.com' }))).s, 400);
    const far = await call('POST', '/api/checkout', order({ email: 'far@example.com', loc: ABUJA })); assert.strictEqual(far.s, 422);
    assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM orders WHERE email IN ('nopin@example.com','far@example.com')"))[0].n), 0);
    assert.strictEqual(Number((await q('SELECT stock FROM products WHERE id=$1', [PA]))[0].stock), stock0);
    const ok = await call('POST', '/api/checkout', order({ email: 'near@example.com', loc: YABA })); assert.strictEqual(ok.s, 200);
    const o = (await q("SELECT lat, lng, landmark, dist_km, eta_min, promised_at FROM orders WHERE email='near@example.com'"))[0];
    assert.strictEqual(o.landmark, 'Blue gate'); assert.ok(Number(o.dist_km) > 0 && o.eta_min > 0 && Number(o.promised_at) > 0);
  });
  await test('a per-kilometre fee is added by the server, not trusted from the browser', async () => {
    await call('PUT', '/api/admin/settings', { settings: { per_km_fee: 100, free_km: 2 } }, admin);
    const qq = (await quote(NEAR)).j; const extra = Math.round((100 * Math.max(0, qq.km - 2)) / 10) * 10; assert.strictEqual(qq.extraFee, extra); assert.ok(extra > 0);
    const base = (await call('GET', '/api/cart/price?state=Lagos').catch(() => ({ j: null }))).j; // not needed; fee check is on the stored order
    const r = await call('POST', '/api/checkout', { ...order({ email: 'fee@example.com', loc: NEAR }), deliveryFee: 0, extraFee: 0 }); assert.strictEqual(r.s, 200);
    const o = (await q("SELECT delivery_fee, subtotal, total FROM orders WHERE email='fee@example.com'"))[0];
    assert.strictEqual(Number(o.total), Number(o.subtotal) + Number(o.delivery_fee)); assert.ok(Number(o.delivery_fee) >= extra); void base;
    await call('PUT', '/api/admin/settings', { settings: { per_km_fee: 0, free_km: 0 } }, admin);
  });
  await test('items from two partners make two pickups, each with its own leg', async () => {
    const r = await call('POST', '/api/checkout', order({ email: 'two@example.com', loc: YABA, items: [{ productId: PA, qty: 1 }, { productId: PB, qty: 1 }] })); assert.strictEqual(r.s, 200);
    const pk = await q("SELECT p.name FROM order_pickups op JOIN partners p ON p.id=op.partner_id WHERE op.order_id=(SELECT id FROM orders WHERE email='two@example.com') ORDER BY p.name");
    assert.deepStrictEqual(pk.map((x) => x.name), ['Lekki Partner', 'Shop-Beta Main Store']);
  });

  // ---------- one full delivery ----------
  const place = async (email, payment = 'pod') => { const r = await call('POST', '/api/checkout', order({ email, loc: YABA, payment })); assert.strictEqual(r.s, 200); const row = (await q('SELECT id, ref, total, access_token FROM orders WHERE ref=$1', [r.j.ref]))[0]; return { id: Number(row.id), ref: row.ref, total: Number(row.total), email, token: row.access_token }; };
  const lookup = async (o) => (await call('POST', '/api/orders/lookup', { ref: o.ref, email: o.email, token: o.token })).j.order;
  const confirm = async (o) => assert.strictEqual((await call('PUT', '/api/admin/orders/' + o.id, { status: 'confirmed' }, admin)).s, 200);
  const assign = async (o, id = rider1Id) => assert.strictEqual((await call('PUT', `/api/admin/orders/${o.id}/rider`, { riderId: id }, admin)).s, 200);
  const toRoad = async (o) => { await confirm(o); await assign(o); assert.strictEqual((await call('POST', `/api/rider/orders/${o.id}/accept`, {}, r1)).s, 200); const pk = await q('SELECT partner_id FROM order_pickups WHERE order_id=$1', [o.id]); for (const p of pk) assert.strictEqual((await call('POST', `/api/rider/orders/${o.id}/pickup`, { partnerId: Number(p.partner_id) }, r1)).s, 200); assert.strictEqual((await call('POST', `/api/rider/orders/${o.id}/start`, {}, r1)).s, 200); };

  let d1;
  await test('the handover code is issued when pay on delivery is confirmed, shown to the customer, and is not stored anywhere', async () => {
    d1 = await place('d1@example.com'); assert.strictEqual((await lookup(d1)).handover_code, '', 'no code before confirmation');
    await confirm(d1); const code = (await lookup(d1)).handover_code; assert.match(code, /^\d{6}$/);
    const row = (await q('SELECT * FROM orders WHERE id=$1', [d1.id]))[0]; assert.ok(!Object.values(row).some((v) => String(v) === code && v !== null), 'the code itself must not be in the database row');
    assert.strictEqual((await lookup(d1)).handover_code, code, 'stays the same');
  });
  await test('only the assigned rider can see or act on the order, and only riders can use the rider screen', async () => {
    await assign(d1);
    assert.strictEqual((await call('GET', '/api/rider/orders')).s, 401);
    assert.strictEqual((await call('GET', '/api/rider/orders', undefined, admin)).s, 401);
    assert.strictEqual((await call('POST', `/api/rider/orders/${d1.id}/accept`, {}, r2)).s, 404);
    const mine = (await call('GET', '/api/rider/orders', undefined, r1)).j.orders; assert.strictEqual(mine.length, 1);
    const o = mine[0]; assert.match(o.customer.phone, /^080\d{8}$/); assert.ok(o.customer.nav.includes('google.com/maps')); assert.ok(o.pickups[0].nav); assert.strictEqual(o.collect, d1.total);
    assert.ok(!JSON.stringify(mine).includes(await (async () => (await lookup(d1)).handover_code)()), 'the rider never sees the code');
    assert.strictEqual((await call('GET', '/api/rider/orders', undefined, r2)).j.orders.length, 0);
  });
  await test('the steps must happen in order: accept, collect, on the way, then the code', async () => {
    assert.strictEqual((await call('POST', `/api/rider/orders/${d1.id}/start`, {}, r1)).s, 409);
    assert.strictEqual((await call('POST', `/api/rider/orders/${d1.id}/accept`, {}, r1)).s, 200);
    assert.strictEqual((await call('POST', `/api/rider/orders/${d1.id}/start`, {}, r1)).s, 409, 'cannot leave before collecting');
    assert.strictEqual((await call('POST', `/api/rider/orders/${d1.id}/complete`, { code: '000000' }, r1)).s, 409, 'cannot complete before on the way');
    const pk = await q('SELECT partner_id FROM order_pickups WHERE order_id=$1', [d1.id]);
    for (const p of pk) assert.strictEqual((await call('POST', `/api/rider/orders/${d1.id}/pickup`, { partnerId: Number(p.partner_id) }, r1)).s, 200);
    assert.strictEqual((await call('POST', `/api/rider/orders/${d1.id}/start`, {}, r1)).s, 200);
    const o = await lookup(d1); assert.strictEqual(o.status, 'shipped'); assert.ok(o.delivery_info.accepted_at && o.delivery_info.picked_up_at && o.delivery_info.on_way_at, 'every stage is stamped');
  });
  await test('the rider position is saved only while on the way, rate-limited per order, and shown to the customer', async () => {
    assert.strictEqual((await call('POST', `/api/rider/orders/${d1.id}/location`, { lat: 6.55, lng: 3.36 }, r1)).j.tracking, true);
    await call('POST', `/api/rider/orders/${d1.id}/location`, { lat: 6.56, lng: 3.37 }, r1); // inside 10 s: ignored
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM rider_points WHERE order_id=$1', [d1.id]))[0].n), 1);
    const o = await lookup(d1); assert.strictEqual(o.rider.lat, 6.55);
    assert.strictEqual((await call('POST', `/api/rider/orders/${d1.id}/location`, { lat: 999, lng: 3 }, r1)).s, 400);
  });
  await test('wrong codes are counted; the right code delivers once, stamps the place, and records the cash for pay on delivery', async () => {
    const code = (await lookup(d1)).handover_code, wrong = code === '123456' ? '654321' : '123456';
    const w = await call('POST', `/api/rider/orders/${d1.id}/complete`, { code: wrong }, r1); assert.strictEqual(w.s, 400); assert.match(w.j.error, /4 tries left/);
    const ok = await call('POST', `/api/rider/orders/${d1.id}/complete`, { code, lat: 6.51, lng: 3.37 }, r1); assert.strictEqual(ok.s, 200);
    const o = (await q('SELECT status, delivered_at, delivered_lat, payment_status, cash_collected, handover_nonce FROM orders WHERE id=$1', [d1.id]))[0];
    assert.strictEqual(o.status, 'delivered'); assert.ok(o.delivered_at); assert.strictEqual(o.delivered_lat, 6.51); assert.strictEqual(o.payment_status, 'paid'); assert.strictEqual(Number(o.cash_collected), d1.total); assert.strictEqual(o.handover_nonce, '');
    assert.strictEqual((await call('POST', `/api/rider/orders/${d1.id}/complete`, { code }, r1)).s, 409, 'the code works once');
    assert.strictEqual((await lookup(d1)).handover_code, '', 'a used code is no longer shown');
    assert.strictEqual((await call('GET', '/api/rider/orders', undefined, r1)).j.orders.length, 0, 'the customer location leaves the rider screen when the job is done');
  });
  await test('after 5 wrong codes the delivery locks; only an admin override with a written reason unlocks it', async () => {
    const d2 = await place('d2@example.com'); await toRoad(d2); const code = (await lookup(d2)).handover_code;
    for (let i = 0; i < 4; i++) assert.strictEqual((await call('POST', `/api/rider/orders/${d2.id}/complete`, { code: '000001' }, r1)).s, 400);
    const l = await call('POST', `/api/rider/orders/${d2.id}/complete`, { code: '000001' }, r1); assert.strictEqual(l.s, 423); assert.strictEqual(l.j.locked, true);
    assert.strictEqual((await call('POST', `/api/rider/orders/${d2.id}/complete`, { code }, r1)).s, 423, 'even the right code is refused once locked');
    assert.strictEqual((await call('POST', `/api/admin/orders/${d2.id}/handover`, { action: 'reset', reason: 'ok' }, admin)).s, 400, 'a reason is required');
    assert.strictEqual((await call('POST', `/api/admin/orders/${d2.id}/handover`, { action: 'reset', reason: 'Customer says rider mistyped, verified by phone' }, admin)).s, 200);
    const fresh = (await lookup(d2)).handover_code; assert.notStrictEqual(fresh, code, 'a new code is issued');
    assert.strictEqual((await call('POST', `/api/rider/orders/${d2.id}/complete`, { code: fresh }, r1)).s, 200);
    const ev = await q("SELECT note FROM order_events WHERE order_id=$1 AND (note LIKE 'Handover unlocked%' OR note LIKE 'Wrong handover%')", [d2.id]); assert.ok(ev.length >= 2, 'the lock and the override are in the order history');
  });
  await test('a cancelled order can no longer be completed, and its code disappears', async () => {
    const d3 = await place('d3@example.com'); await toRoad(d3); const code = (await lookup(d3)).handover_code;
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + d3.id, { status: 'cancelled', note: 'Customer unreachable' }, admin)).s, 200);
    const r = await call('POST', `/api/rider/orders/${d3.id}/complete`, { code }, r1); assert.ok([404, 409].includes(r.s)); assert.notStrictEqual(r.s, 200);
    assert.strictEqual((await lookup(d3)).handover_code, '');
    assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM orders WHERE id=$1 AND status='delivered'", [d3.id]))[0].n), 0);
  });
  await test('an online (Paystack-style) order gets its code when paid, and can be delivered with no cash recorded', async () => {
    const d4 = await place('d4@example.com', 'paystack'); assert.strictEqual((await lookup(d4)).handover_code, '');
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + d4.id, { status: 'paid' }, admin)).s, 200);
    await assign(d4); await call('POST', `/api/rider/orders/${d4.id}/accept`, {}, r1);
    for (const p of await q('SELECT partner_id FROM order_pickups WHERE order_id=$1', [d4.id])) await call('POST', `/api/rider/orders/${d4.id}/pickup`, { partnerId: Number(p.partner_id) }, r1);
    await call('POST', `/api/rider/orders/${d4.id}/start`, {}, r1);
    const code = (await lookup(d4)).handover_code; assert.match(code, /^\d{6}$/);
    assert.strictEqual((await call('POST', `/api/rider/orders/${d4.id}/complete`, { code }, r1)).s, 200);
    assert.strictEqual((await q('SELECT cash_collected FROM orders WHERE id=$1', [d4.id]))[0].cash_collected, null);
  });
  await test('a switched-off rider is signed out and cannot act', async () => {
    const d5 = await place('d5@example.com'); await confirm(d5); await assign(d5, Number((await q("SELECT id FROM users WHERE email='rider2@example.com'"))[0].id));
    assert.strictEqual((await call('PUT', `/api/admin/riders/${(await q("SELECT id FROM users WHERE email='rider2@example.com'"))[0].id}`, { active: false, coverage: 'Lagos' }, admin)).s, 200);
    assert.strictEqual((await call('GET', '/api/rider/orders', undefined, r2)).s, 401);
    assert.strictEqual((await call('POST', '/api/auth/login', { email: 'rider2@example.com', password: 'RiderPass123' })).s, 403);
  });
  await test('late deliveries are flagged for the admin, and unassigned ones stand out', async () => {
    const d6 = await place('d6@example.com'); await confirm(d6);
    await q('UPDATE orders SET promised_at=$1 WHERE id=$2', [Math.floor(Date.now() / 1000) - 600, d6.id]);
    const l = (await call('GET', '/api/admin/deliveries', undefined, admin)).j.deliveries.find((x) => x.id === d6.id); assert.strictEqual(l.late, true); assert.strictEqual(l.unassigned, true);
  });
  await test('rider tracking points older than 30 days are deleted by the clean-up job', async () => {
    const o = await place('d7@example.com'); const old = Math.floor(Date.now() / 1000) - 31 * 86400;
    await q('INSERT INTO rider_points (order_id, rider_id, lat, lng, created) VALUES ($1,$2,6.5,3.3,$3), ($1,$2,6.5,3.3,$4)', [o.id, rider1Id, old, Math.floor(Date.now() / 1000)]);
    const queue = require('../lib/queue'); await queue.enqueue('cron.cleanup', {}, { key: 'test-cleanup-' + Date.now() });
    await until(async () => Number((await q('SELECT COUNT(*) n FROM rider_points WHERE order_id=$1', [o.id]))[0].n) === 1);
    await require('../lib/db').close();
  });

  app.kill(); fake.close();
  await sleep(300);
  fs.rmSync(DATA, { recursive: true, force: true });
  await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(app.log.slice(-1500));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
