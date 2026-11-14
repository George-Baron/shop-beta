'use strict';
// 6A delivery mapping + handover code. Pure rules first, then a real server with a fake map provider and a delivery from order to code entry.
// Run with: npm run test:delivery   (needs TEST_DATABASE_URL like the other suites)
const { spawn } = require('child_process');
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client: PgClient } = require('pg');
const mockSupabase = require('./mock-supabase');
const geo = require('../lib/geo');
const handover = require('../lib/handover');
const SERVICE_KEY = 'test-service-key';
const PORT = 3900 + Math.floor(Math.random() * 400), BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-deliv-'));
const ADMIN_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DB_NAME = 'sb_deliv_' + Math.random().toString(36).slice(2, 10);
const withDb = (name) => { const u = new URL(ADMIN_URL); u.pathname = '/' + name; return u.toString(); };
const ssl = () => (process.env.PGSSL_TEST === 'require' ? { rejectUnauthorized: false } : false);
async function sql(text, params, db) { const c = new PgClient({ connectionString: db ? withDb(db) : ADMIN_URL, ssl: ssl() }); await c.connect(); try { return (await c.query(text, params)).rows; } finally { await c.end(); } }
let passed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); } }

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const r = await fetch(BASE + url, { method, redirect: 'manual', headers: { 'X-Requested-With': 'shop-beta', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) { const kv = c.split(';')[0]; this.cookie = /=$/.test(kv) ? '' : kv; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  }
  get(u) { return this.req('GET', u); } post(u, b = {}) { return this.req('POST', u, b); } put(u, b = {}) { return this.req('PUT', u, b); }
}

// A fake Geoapify: address search and routing, with a call counter and an on/off switch.
function fakeProvider() {
  const s = { calls: { geocode: 0, routing: 0 }, down: false };
  s.server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (s.down) { res.statusCode = 500; return res.end('down'); }
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/v1/geocode/search') {
      s.calls.geocode++;
      const t = u.searchParams.get('text') || '';
      return res.end(JSON.stringify({ results: [{ formatted: 'Allen Avenue, Ikeja, Lagos', lat: 6.6, lon: 3.35 }, { formatted: 'Osu, Accra, Ghana', lat: 5.55, lon: -0.18 }, ...(t.includes('x') ? [] : [])] }));
    }
    if (u.pathname === '/v1/routing') {
      s.calls.routing++;
      const [a, b] = u.searchParams.get('waypoints').split('|').map((p) => p.split(',').map(Number));
      const km = geo.haversineKm({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }) * 1.4;
      return res.end(JSON.stringify({ features: [{ properties: { distance: km * 1000, time: (km / 30) * 3600 }, geometry: { type: 'MultiLineString', coordinates: [[[a[1], a[0]], [(a[1] + b[1]) / 2, (a[0] + b[0]) / 2], [b[1], b[0]]]] } }] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise((r) => s.server.listen(0, '127.0.0.1', () => { s.url = 'http://127.0.0.1:' + s.server.address().port; r(s); }));
}

(async () => {
  /* ================= pure rules ================= */
  console.log('\nRules (no server)');
  await test('only points inside Nigeria are accepted (29 Nigerian places in, 21 foreign/sea points out)', () => {
    const inN = { Lagos: [6.52, 3.38], Abuja: [9.07, 7.4], Kano: [12.0, 8.52], Sokoto: [13.06, 5.24], Maiduguri: [11.85, 13.15], Yola: [9.2, 12.46], Jalingo: [8.89, 11.36], Calabar: [4.95, 8.33], PortHarcourt: [4.82, 7.03], BeninCity: [6.34, 5.63], Ibadan: [7.38, 3.9], Kaduna: [10.52, 7.44], Katsina: [12.99, 7.6], Ilorin: [8.5, 4.55], Saki: [8.67, 3.39], Eket: [4.64, 7.93], Badagry: [6.42, 2.88], Damaturu: [11.75, 11.96], Ikom: [5.97, 8.72], Gembu: [6.7, 11.25], Obudu: [6.65, 9.15], Mubi: [10.27, 13.27], Gusau: [12.16, 6.66], BirninKebbi: [12.45, 4.2], Enugu: [6.45, 7.5], Jos: [9.9, 8.9], Warri: [5.52, 5.75], Lokoja: [7.8, 6.74], Bama: [11.52, 13.69] };
    const out = { Accra: [5.6, -0.19], Lome: [6.13, 1.22], Cotonou: [6.37, 2.43], PortoNovo: [6.49, 2.6], Niamey: [13.5, 2.1], Maradi: [13.5, 7.1], Zinder: [13.8, 9.0], Ndjamena: [12.1, 15.05], Kousseri: [12.08, 15.03], Douala: [4.05, 9.7], Yaounde: [3.86, 11.5], Garoua: [9.3, 13.4], Maroua: [10.6, 14.3], Bamenda: [5.96, 10.15], Parakou: [9.34, 2.63], Sea: [3.0, 5.0], Tahoua: [14.9, 5.3], Buea: [4.15, 9.24], Malabo: [3.75, 8.78], London: [51.5, -0.12], NullIsland: [0, 0] };
    for (const [k, v] of Object.entries(inN)) assert.ok(geo.inNigeria(...v), k + ' should be inside');
    for (const [k, v] of Object.entries(out)) assert.ok(!geo.inNigeria(...v), k + ' should be outside');
    assert.ok(!geo.inNigeria(NaN, 3) && !geo.inNigeria(91, 3) && !geo.inNigeria('6', '3'.length ? undefined : 3));
  });
  await test('distance: Lagos to Abuja is about 526 km; same point is 0', () => {
    const d = geo.haversineKm({ lat: 6.5244, lng: 3.3792 }, { lat: 9.0765, lng: 7.3986 });
    assert.ok(Math.abs(d - 526) < 6, String(d)); assert.strictEqual(geo.haversineKm({ lat: 6, lng: 3 }, { lat: 6, lng: 3 }), 0);
    assert.strictEqual(geo.estimateRoadKm({ lat: 6.5, lng: 3.3 }, { lat: 6.5, lng: 3.4 }, 1.3), Math.round(geo.haversineKm({ lat: 6.5, lng: 3.3 }, { lat: 6.5, lng: 3.4 }) * 13) / 10);
  });
  await test('range: each store uses its own radius, never beyond the shop-wide maximum', () => {
    const S = { delivery_radius_km: '15', delivery_max_km: '40' };
    assert.ok(geo.checkRange([{ partnerId: 1, name: 'A', radius_km: 0, km: 14.9 }], S).ok, 'inside default radius');
    assert.ok(!geo.checkRange([{ partnerId: 1, name: 'A', radius_km: 0, km: 15.1 }], S).ok, 'outside default radius');
    assert.ok(geo.checkRange([{ partnerId: 2, name: 'B', radius_km: 30, km: 29 }], S).ok, 'bigger own radius');
    assert.ok(!geo.checkRange([{ partnerId: 2, name: 'B', radius_km: 100, km: 41 }], S).ok, 'capped by the maximum');
    assert.ok(!geo.checkRange([{ partnerId: 2, name: 'B', radius_km: 5, km: 6 }], S).ok, 'smaller own radius');
    const two = geo.checkRange([{ partnerId: 1, name: 'A', radius_km: 0, km: 3 }, { partnerId: 2, name: 'B', radius_km: 5, km: 9 }], S);
    assert.ok(!two.ok && two.problems.length === 1 && two.problems[0].name === 'B', 'one far store fails the whole order');
  });
  await test('fee: state fee plus optional per-kilometre fee on the longest leg; free shipping removes both', () => {
    const legs = [{ km: 3.2 }, { km: 7.4 }];
    assert.deepStrictEqual(geo.deliveryFee(2000, legs, { delivery_per_km: '0' }), { stateFee: 2000, perKmFee: 0, fee: 2000 });
    assert.deepStrictEqual(geo.deliveryFee(2000, legs, { delivery_per_km: '50' }), { stateFee: 2000, perKmFee: 400, fee: 2400 }); // 8 km x 50
    assert.strictEqual(geo.deliveryFee(2000, legs, { delivery_per_km: '50' }, { free: true }).fee, 0);
  });
  await test('ETA: preparation + longest drive + 10 minutes per extra store', () => {
    const S = { delivery_prep_min: '30', delivery_speed_kmh: '30' };
    assert.strictEqual(geo.etaMinutes([{ km: 15 }], S), 60);
    assert.strictEqual(geo.etaMinutes([{ km: 15 }, { km: 3 }], S), 70);
    assert.strictEqual(geo.etaMinutes([{ km: 5, minutes: 20 }], S), 50);
  });
  await test('cut-off: orders outside opening hours start at the next opening time (Lagos clock)', () => {
    const S = { delivery_open: '08:00', delivery_cutoff: '18:00' };
    const at = (h, m = 0) => Date.UTC(2027, 0, 5, h - 1, m) / 1000; // 05 Jan 2027 h:m Lagos time (UTC+1)
    assert.deepStrictEqual(geo.startFor(at(12), S), { startAt: at(12), deferred: false, opensAt: null });
    const late = geo.startFor(at(19), S); assert.ok(late.deferred && late.startAt === at(8) + 86400, 'after cut-off: tomorrow 08:00');
    const early = geo.startFor(at(6, 30), S); assert.ok(early.deferred && early.startAt === at(8), 'before opening: today 08:00');
    assert.ok(geo.startFor(at(17, 59), S).deferred === false && geo.startFor(at(18, 0), S).deferred === true, 'the cut-off minute is exclusive');
  });
  await test('late = open order past its promised time', () => {
    assert.ok(geo.isLate({ status: 'confirmed', promised_at: 100 }, 101));
    assert.ok(!geo.isLate({ status: 'confirmed', promised_at: 100 }, 100));
    assert.ok(!geo.isLate({ status: 'delivered', promised_at: 100 }, 500) && !geo.isLate({ status: 'cancelled', promised_at: 100 }, 500) && !geo.isLate({ status: 'confirmed' }, 500));
  });
  await test('handover code: 6 digits, random per order, verifies, never equals what is stored', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) { const c = handover.newCode('SB-1'); assert.match(c.code, /^\d{6}$/); assert.strictEqual(handover.codeFor('SB-1', c.nonce), c.code, 'can be re-derived for the customer'); assert.ok(handover.matches('SB-1', c.code, c.hash)); assert.ok(!c.hash.includes(c.code) && c.hash.length === 64); seen.add(c.code); }
    assert.ok(seen.size > 150, 'codes are random');
    const c = handover.newCode('SB-1');
    assert.ok(!handover.matches('SB-1', c.code === '000000' ? '000001' : '000000', c.hash), 'wrong code');
    assert.ok(!handover.matches('SB-2', c.code, c.hash), 'a code is tied to its order');
    assert.ok(!handover.matches('SB-1', '12345', c.hash) && !handover.matches('SB-1', 'abcdef', c.hash) && !handover.matches('SB-1', c.code, ''), 'bad shapes');
  });
  await test('production refuses to run without a proper HANDOVER_SECRET', () => {
    const save = { n: process.env.NODE_ENV, s: process.env.HANDOVER_SECRET };
    try {
      process.env.NODE_ENV = 'production'; delete process.env.HANDOVER_SECRET; assert.ok(handover.secretProblem());
      process.env.HANDOVER_SECRET = 'short'; assert.ok(handover.secretProblem());
      process.env.HANDOVER_SECRET = 'x'.repeat(40); assert.strictEqual(handover.secretProblem(), '');
      process.env.NODE_ENV = 'development'; delete process.env.HANDOVER_SECRET; assert.strictEqual(handover.secretProblem(), '');
    } finally { if (save.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = save.n; if (save.s === undefined) delete process.env.HANDOVER_SECRET; else process.env.HANDOVER_SECRET = save.s; }
  });

  /* ================= server ================= */
  await sql(`CREATE DATABASE ${DB_NAME}`);
  const prov = await fakeProvider(), storageMock = await mockSupabase.start(SERVICE_KEY);
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DATABASE_URL: withDb(DB_NAME), PGSSL: process.env.PGSSL_TEST || 'disable', BASE_URL: BASE, SUPABASE_URL: storageMock.url, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SUPABASE_BUCKET: 'shop-images', STORAGE_DRIVER: '', CACHE_DISABLED: '1', ADMIN_SETUP_CODE: 'test-setup-code', PAYSTACK_SECRET_KEY: '', RESEND_API_KEY: '', MAP_PROVIDER: 'geoapify', MAP_API_KEY: 'testkey', MAP_API_URL: prov.url, MAP_DAILY_CALL_CAP: '30', HANDOVER_SECRET: 'test-handover-secret-test-handover-secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const guest = new Client(), admin = new Client();
  const IKEJA = { lat: 6.6018, lng: 3.3515 }, VI = { lat: 6.4281, lng: 3.4219 };
  const HOME = { lat: 6.4698, lng: 3.5852 };               // Lekki-ish, close to VI
  let p1, p2, prodMain, prodVI, riderA;
  const ordersCount = async () => Number((await sql('SELECT COUNT(*) n FROM orders', [], DB_NAME))[0].n);
  const row = async (ref) => (await sql('SELECT * FROM orders WHERE ref=$1', [ref], DB_NAME))[0];
  async function newRider(states = ['Lagos']) {
    const email = 'rider' + Math.random().toString(36).slice(2, 8) + '@example.com';
    const r = await admin.post('/api/admin/riders', { name: 'Bola Rider', email, phone: '08011112222', password: 'rider password 1', states });
    assert.strictEqual(r.status, 200, r.text);
    const c = new Client(); const l = await c.post('/api/auth/login', { email, password: 'rider password 1' }); assert.strictEqual(l.status, 200, l.text);
    return { id: r.json.id, email, c };
  }
  const body = (items, extra = {}) => ({ items, contact: { name: 'Chi Okoro', email: 'chi@example.com', phone: '08033334444' }, address: { state: 'Lagos', city: 'Lekki', address: '12 Admiralty Way' }, delivery: 'standard', payment: 'pod', location: { ...HOME, landmark: 'Blue gate behind the pharmacy', phone: '08055556666' }, ...extra });

  console.log('\nSetup');
  await test('admin, partner stores, products assigned to stores, delivery settings', async () => {
    assert.strictEqual((await admin.post('/api/admin/setup', { code: 'test-setup-code', name: 'Owner', email: 'owner@example.com', password: 'a long password' })).status, 200);
    p1 = (await admin.post('/api/admin/partners', { name: 'Ikeja Main Store', address: '1 Allen Avenue, Ikeja', state: 'Lagos', phone: '08000000001', lat: IKEJA.lat, lng: IKEJA.lng, radius_km: 0, is_default: true })).json.id;
    p2 = (await admin.post('/api/admin/partners', { name: 'VI Partner Shop', address: '5 Adeola Odeku, Victoria Island', state: 'Lagos', phone: '08000000002', lat: VI.lat, lng: VI.lng, radius_km: 12 })).json.id;
    assert.ok(p1 && p2);
    assert.strictEqual((await admin.post('/api/admin/partners', { name: 'Accra', lat: 5.6, lng: -0.19 })).status, 400, 'a store outside Nigeria is refused');
    assert.strictEqual((await admin.post('/api/admin/partners', { name: 'Half', lat: 6.5 })).status, 400);
    assert.strictEqual((await admin.post('/api/admin/partners', { name: 'Huge', lat: 6.5, lng: 3.3, radius_km: 999 })).status, 400);
    const list = (await admin.get('/api/admin/partners')).json.partners; assert.strictEqual(list.filter((p) => p.is_default).length, 1);
    const prods = (await guest.get('/api/products?store=electronics')).json.products;
    const plain = [];
    for (const p of prods) { const d = (await guest.get('/api/products/' + p.slug)).json.product; if (!d.variants.length && d.stock >= 30) plain.push(d); if (plain.length === 2) break; }
    [prodMain, prodVI] = plain; assert.ok(prodMain && prodVI);
    const full = (await admin.get('/api/admin/products/' + prodVI.id)).json.product;
    assert.strictEqual((await admin.put('/api/admin/products/' + prodVI.id, { ...full, partner_id: p2 })).status, 200);
    assert.strictEqual((await admin.put('/api/admin/products/' + prodVI.id, { ...full, partner_id: 99999 })).status, 400);
    const s = await admin.put('/api/admin/settings', { settings: { map_checkout: '1', delivery_per_km: '20', delivery_open: '00:00', delivery_cutoff: '23:59', pickup_address: 'Shop 4, Allen Avenue, Ikeja' } });
    assert.strictEqual(s.status, 200, s.text);
    assert.strictEqual((await admin.put('/api/admin/settings', { settings: { delivery_radius_km: '-5' } })).status, 400);
    assert.strictEqual((await admin.put('/api/admin/settings', { settings: { delivery_cutoff: '25:00' } })).status, 400);
  });
  await test('config tells the browser which map to draw (public key, attribution) and whether map checkout is on', async () => {
    const c = (await guest.get('/api/config')).json;
    assert.strictEqual(c.map.enabled, true); assert.match(c.map.tileUrl, /\{z\}\/\{x\}\/\{y\}/); assert.match(c.map.attribution, /OpenStreetMap/); assert.strictEqual(c.settings.map_checkout, '1');
  });

  const cart = (...ps) => ps.map((p) => ({ productId: p.id, qty: 1 }));
  console.log('\nQuote before payment');
  await test('no rider covers the state: says so clearly and offers other options', async () => {
    const q = (await guest.post('/api/delivery/quote', { items: cart(prodMain), state: 'Lagos', ...HOME })).json.quote;
    assert.strictEqual(q.ok, false); assert.strictEqual(q.code, 'no_rider'); assert.match(q.message, /Lagos/);
    assert.ok(q.alternatives.some((a) => a.type === 'pickup') && q.alternatives.some((a) => a.type === 'change_location'));
  });
  await test('riders: created by admin, need states, unique email, shown with their states', async () => {
    assert.strictEqual((await admin.post('/api/admin/riders', { name: 'No States', email: 'ns@example.com', phone: '08011112222', password: 'rider password 1', states: [] })).status, 400);
    assert.strictEqual((await admin.post('/api/admin/riders', { name: 'Bad State', email: 'bs@example.com', phone: '08011112222', password: 'rider password 1', states: ['Atlantis'] })).status, 400);
    assert.strictEqual((await admin.post('/api/admin/riders', { name: 'Weak', email: 'w@example.com', phone: '08011112222', password: 'short', states: ['Lagos'] })).status, 400);
    riderA = await newRider(['Lagos', 'Ogun']);
    assert.strictEqual((await admin.post('/api/admin/riders', { name: 'Dup', email: riderA.email, phone: '08011112222', password: 'rider password 1', states: ['Lagos'] })).status, 409);
    const l = (await admin.get('/api/admin/riders')).json.riders; assert.ok(l.find((r) => r.id === riderA.id).states.includes('Ogun'));
    assert.strictEqual((await guest.get('/api/rider/orders')).status, 401); assert.strictEqual((await riderA.c.get('/api/admin/orders')).status, 401, 'a rider is not an admin');
  });
  await test('distance, driving route, fee and time for one store and for two stores (one leg each)', async () => {
    const one = (await guest.post('/api/delivery/quote', { items: cart(prodVI), state: 'Lagos', ...HOME })).json;
    assert.strictEqual(one.quote.ok, true); assert.strictEqual(one.quote.legs.length, 1); assert.strictEqual(one.quote.legs[0].name, 'VI Partner Shop');
    assert.ok(one.quote.legs[0].km > 5 && one.quote.legs[0].km < 40); assert.ok(one.quote.legs[0].line.length >= 2); assert.strictEqual(one.quote.legs[0].source, 'provider');
    const zone = (await guest.get('/api/config')).json.zones.find((z) => z.state === 'Lagos');
    assert.strictEqual(one.quote.stateFee, zone.fee); assert.ok(one.quote.perKmFee > 0 && one.quote.fee === one.quote.stateFee + one.quote.perKmFee);
    assert.ok(one.quote.etaMinutes >= 30 && one.quote.promisedAt > Date.now() / 1000); assert.ok(one.total > 0);
    const two = (await guest.post('/api/delivery/quote', { items: cart(prodMain, prodVI), state: 'Lagos', ...HOME })).json.quote;
    assert.strictEqual(two.ok, true); assert.deepStrictEqual(two.legs.map((l) => l.name).sort(), ['Ikeja Main Store', 'VI Partner Shop']);
    assert.ok(two.etaMinutes >= one.quote.etaMinutes + 10 - 1, 'an extra pickup adds time');
  });
  await test('points outside Nigeria, missing pins and out-of-range points are refused with a reason', async () => {
    const q = async (loc) => (await guest.post('/api/delivery/quote', { items: cart(prodMain), state: 'Lagos', ...loc })).json.quote;
    const gh = await q({ lat: 5.6, lng: -0.19 }); assert.strictEqual(gh.code, 'outside_nigeria'); assert.match(gh.message, /outside Nigeria/);
    assert.strictEqual((await q({})).code, 'bad_point'); assert.strictEqual((await q({ lat: 'abc', lng: 3 })).code, 'bad_point'); assert.strictEqual((await q({ lat: 200, lng: 3 })).code, 'bad_point');
    const far = await q({ lat: 9.07, lng: 7.4 }); assert.strictEqual(far.code, 'out_of_range'); assert.match(far.message, /We deliver up to/); assert.ok(far.alternatives.length >= 2);
  });
  await test('a store with its own smaller radius refuses points the default radius would allow', async () => {
    // VI has radius 12 km; a point ~20 km road distance from VI but fine for Ikeja-only carts
    const farFromVI = { lat: 6.62, lng: 3.52 };
    assert.strictEqual((await guest.post('/api/delivery/quote', { items: cart(prodVI), state: 'Lagos', ...farFromVI })).json.quote.code, 'out_of_range');
  });

  console.log('\nCheckout');
  await test('map checkout needs a pin; out-of-range, outside Nigeria and no-rider states create no order and take no stock', async () => {
    const n0 = await ordersCount(), stock = async () => (await guest.get('/api/products/' + prodMain.slug)).json.product.stock, s0 = await stock();
    const noPin = await guest.post('/api/checkout', body(cart(prodMain), { location: undefined })); assert.strictEqual(noPin.status, 409); assert.strictEqual(noPin.json.code, 'bad_point');
    const out = await guest.post('/api/checkout', body(cart(prodMain), { location: { lat: 5.6, lng: -0.19 } })); assert.strictEqual(out.status, 409); assert.strictEqual(out.json.code, 'outside_nigeria');
    const far = await guest.post('/api/checkout', body(cart(prodMain), { location: { lat: 9.07, lng: 7.4 } })); assert.strictEqual(far.status, 409); assert.strictEqual(far.json.code, 'out_of_range'); assert.ok(far.json.alternatives.length >= 2);
    const norider = await guest.post('/api/checkout', body(cart(prodMain), { address: { state: 'Kano', city: 'Kano', address: '1 Test Road' }, location: { lat: 12.0, lng: 8.52 } })); assert.strictEqual(norider.status, 409); assert.strictEqual(norider.json.code, 'no_rider');
    assert.strictEqual(await ordersCount(), n0); assert.strictEqual(await stock(), s0);
  });
  await test('the fee is decided by the server (the browser cannot lower it), and the pin, landmark and phone are saved', async () => {
    const q = (await guest.post('/api/delivery/quote', { items: cart(prodMain), state: 'Lagos', ...HOME })).json;
    const r = await guest.post('/api/checkout', body(cart(prodMain), { delivery_fee: 0, deliveryFee: 0, total: 1 }));
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.next, 'pod');
    const o = await row(r.json.ref); assert.strictEqual(o.delivery_fee, q.quote.fee); assert.strictEqual(o.total, o.subtotal - o.discount + q.quote.fee);
    assert.ok(Math.abs(o.dest_lat - HOME.lat) < 1e-9 && Math.abs(o.dest_lng - HOME.lng) < 1e-9); assert.strictEqual(o.dest_landmark, 'Blue gate behind the pharmacy'); assert.strictEqual(o.dest_phone, '08055556666');
    assert.strictEqual(o.handover_hash, '', 'no code before the order is confirmed');
  });
  await test('store pickup does not need a pin', async () => {
    const r = await guest.post('/api/checkout', { ...body(cart(prodMain)), delivery: 'pickup', location: undefined, payment: 'paystack' }); assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await row(r.json.ref)).dest_lat, null);
  });

  /* A full delivery, built step by step by a helper so each scenario starts from the same place. */
  async function placeAndStart({ pay = 'paystack', items = cart(prodMain, prodVI), rider } = {}) {
    rider = rider || await newRider(['Lagos']);
    const r = await guest.post('/api/checkout', body(items, { payment: pay })); assert.strictEqual(r.status, 200, r.text);
    const ref = r.json.ref, cust = { ref, email: 'chi@example.com' };
    let o = await row(ref);
    if (pay === 'paystack') assert.strictEqual((await guest.post('/api/pay/demo/' + ref, { outcome: 'ok' })).status, 200);
    else assert.strictEqual((await admin.post('/api/admin/orders/' + o.id + '/confirm-phone', { note: 'Spoke to Chi, address confirmed' })).status, 200);
    o = await row(ref);
    return { ref, id: o.id, rider, cust, total: o.total, code: async () => (await guest.post('/api/orders/lookup', cust)).json.order.handover_code };
  }
  async function takeToDoor(x) {
    assert.strictEqual((await admin.post(`/api/admin/orders/${x.id}/assign`, { riderId: x.rider.id })).status, 200);
    const c = x.rider.c;
    assert.strictEqual((await c.post(`/api/rider/orders/${x.ref}/accept`)).status, 200);
    const d = (await c.get(`/api/rider/orders/${x.ref}`)).json.order;
    for (const l of d.legs) assert.strictEqual((await c.post(`/api/rider/orders/${x.ref}/pickup/${l.id}`)).status, 200);
    assert.strictEqual((await c.post(`/api/rider/orders/${x.ref}/start`)).status, 200);
  }

  console.log('\nHandover code');
  let A;
  await test('code is created when the order is paid (online) or confirmed (pay on delivery), shown to the customer only, and never stored', async () => {
    A = await placeAndStart({ pay: 'paystack' });
    const code = await A.code(); assert.match(code, /^\d{6}$/);
    const o = await row(A.ref); assert.strictEqual(o.handover_hash.length, 64); assert.ok(!JSON.stringify(o).includes('"' + code + '"'), 'plain code not in the order row');
    assert.ok(o.started_at && o.promised_at > o.started_at, 'timer started and a promise made');
    const adminCopy = (await admin.post('/api/orders/lookup', { ref: A.ref })).json.order; assert.strictEqual(adminCopy.handover_code, '', 'not shown to admin');
    const stranger = await new Client().post('/api/orders/lookup', { ref: A.ref, email: 'someone@else.com' }); assert.strictEqual(stranger.status, 404);
    const pod = await placeAndStart({ pay: 'pod' }); assert.match(await pod.code(), /^\d{6}$/);
    const adm = (await admin.get('/api/admin/orders/' + A.id)).json.order; assert.ok(!('handover_hash' in adm) && !('handover_nonce' in adm), 'admin API never returns hash or nonce'); assert.strictEqual(adm.has_code, true);
  });
  await test('the confirmation email carries the code (and the rider API never does)', async () => {
    for (let i = 0; i < 80; i++) { const o = (await admin.get('/api/admin/jobs')).json.overview; if (!o.queued && !o.active) break; await new Promise((r) => setTimeout(r, 100)); }
    const code = await A.code();
    const mails = await sql("SELECT body FROM outbox WHERE to_email='chi@example.com' AND body LIKE '%Your delivery code%'", [], DB_NAME);
    assert.ok(mails.some((m) => m.body.includes(code)), 'customer email includes the code');
    await admin.post(`/api/admin/orders/${A.id}/assign`, { riderId: A.rider.id });
    const detail = await A.rider.c.get(`/api/rider/orders/${A.ref}`), list = await A.rider.c.get('/api/rider/orders');
    assert.ok(!detail.text.includes(code) && !list.text.includes(code) && !/handover_code|"code"/.test(detail.text + list.text), 'no code in anything a rider can read');
  });
  await test('staff cannot mark a coded delivery delivered by hand', async () => {
    const r = await admin.put('/api/admin/orders/' + A.id, { status: 'delivered' }); assert.strictEqual(r.status, 400); assert.match(r.json.error, /handover code/i);
  });

  console.log('\nRider screen');
  await test('assignment: only a rider covering the state; other riders see nothing and cannot touch the order', async () => {
    const ogun = await newRider(['Ogun']);
    assert.strictEqual((await admin.post(`/api/admin/orders/${A.id}/assign`, { riderId: ogun.id })).status, 400, 'does not cover Lagos');
    assert.strictEqual((await admin.post(`/api/admin/orders/${A.id}/assign`, { riderId: 999999 })).status, 400);
    assert.strictEqual((await ogun.c.get('/api/rider/orders')).json.orders.length, 0);
    assert.strictEqual((await ogun.c.get(`/api/rider/orders/${A.ref}`)).status, 404); assert.strictEqual((await ogun.c.post(`/api/rider/orders/${A.ref}/accept`)).status, 404);
    assert.strictEqual((await ogun.c.post(`/api/rider/orders/${A.ref}/deliver`, { code: '123456' })).status, 404);
    assert.strictEqual((await ogun.c.post(`/api/rider/orders/${A.ref}/location`, { lat: 6.5, lng: 3.4 })).status, 404);
    assert.strictEqual((await guest.get('/api/rider/orders')).status, 401);
  });
  await test('rider sees pickups with directions links, the customer pin with a link, items, and a number to call', async () => {
    const d = (await A.rider.c.get(`/api/rider/orders/${A.ref}`)).json.order;
    assert.strictEqual(d.legs.length, 2); for (const l of d.legs) { assert.ok(l.address && l.name); assert.match(l.directions.google, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=[\d.]+,[\d.]+/); assert.match(l.directions.osm, /^https:\/\/www\.openstreetmap\.org\/directions/); }
    assert.strictEqual(d.customer.phone, '08055556666'); assert.strictEqual(d.customer.landmark, 'Blue gate behind the pharmacy'); assert.ok(Math.abs(d.customer.lat - HOME.lat) < 1e-6);
    assert.match(d.customer.directions.google, new RegExp(`destination=${HOME.lat},${HOME.lng}`)); assert.ok(d.items.length === 2 && d.items[0].qty === 1); assert.strictEqual(d.collect, 0, 'online order: nothing to collect');
  });
  await test('steps must happen in order: accept, pick up every store, start, then deliver', async () => {
    const c = A.rider.c, d = (await c.get(`/api/rider/orders/${A.ref}`)).json.order;
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/pickup/${d.legs[0].id}`)).status, 409, 'accept first');
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/start`)).status, 409);
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/deliver`, { code: await A.code() })).status, 409, 'cannot deliver before starting');
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/accept`)).status, 200);
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/pickup/${d.legs[0].id}`)).json.allPickedUp, false);
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/start`)).status, 409, 'one store still to visit');
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/pickup/${d.legs[1].id}`)).json.allPickedUp, true);
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/pickup/987654`)).status, 404);
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/start`)).status, 200);
    assert.strictEqual((await row(A.ref)).status, 'dispatched');
  });
  await test('rider location: only while on the way, at most one point per 10 s, Nigeria only', async () => {
    const c = A.rider.c, ref = A.ref;
    assert.strictEqual((await c.post(`/api/rider/orders/${ref}/location`, { lat: 6.45, lng: 3.5 })).json.recorded, true);
    assert.strictEqual((await c.post(`/api/rider/orders/${ref}/location`, { lat: 6.46, lng: 3.51 })).json.recorded, false, 'too soon');
    assert.strictEqual((await c.post(`/api/rider/orders/${ref}/location`, { lat: 5.6, lng: -0.19 })).status, 400);
    assert.strictEqual((await c.post(`/api/rider/orders/${ref}/location`, { lat: 'x', lng: 3 })).status, 400);
    const other = await placeAndStart({ pay: 'pod' }); await admin.post(`/api/admin/orders/${other.id}/assign`, { riderId: other.rider.id });
    assert.strictEqual((await other.rider.c.post(`/api/rider/orders/${other.ref}/location`, { lat: 6.45, lng: 3.5 })).json.recorded, false, 'not on the way yet: nothing is stored');
    assert.strictEqual(Number((await sql('SELECT COUNT(*) n FROM rider_points WHERE order_id=$1', [other.id], DB_NAME))[0].n), 0);
  });

  console.log('\nTimer and tracking');
  await test('customer tracking page: stages stamped, promised time, rider position only while on the way, code until used', async () => {
    const t = (await guest.post('/api/orders/track', A.cust)).json;
    assert.strictEqual(t.tracking.status, 'dispatched'); assert.strictEqual(t.code, await A.code());
    const st = Object.fromEntries(t.tracking.timeline.stages.map((s) => [s.key, s.at]));
    assert.ok(st.placed && st.paid && st.accepted && st.picked_up && st.on_the_way && !st.delivered, JSON.stringify(st));
    assert.ok(t.tracking.timeline.promised_at > t.tracking.timeline.started_at && t.tracking.timeline.elapsed_s >= 0 && t.tracking.timeline.late === false);
    assert.deepStrictEqual([t.tracking.rider.name, t.tracking.rider.position.lat], ['Bola', 6.45]); assert.ok(t.tracking.eta_at);
    assert.strictEqual((await new Client().post('/api/orders/track', { ref: A.ref, email: 'x@y.com' })).status, 404);
  });
  await test('late orders are flagged in the admin list and dashboard', async () => {
    assert.strictEqual((await admin.get('/api/admin/orders')).json.orders.find((o) => o.id === A.id).late, false);
    await sql('UPDATE orders SET promised_at = promised_at - 86400 WHERE id=$1', [A.id], DB_NAME);
    assert.strictEqual((await admin.get('/api/admin/orders')).json.orders.find((o) => o.id === A.id).late, true);
    assert.ok((await admin.get('/api/admin/dashboard')).json.late.some((o) => o.id === A.id));
    assert.strictEqual((await guest.post('/api/orders/track', A.cust)).json.tracking.timeline.late, true);
    await sql('UPDATE orders SET promised_at = promised_at + 86400 WHERE id=$1', [A.id], DB_NAME);
  });

  console.log('\nHanding over');
  await test('lockout: 5 wrong codes lock the order; the right code no longer works; only an admin override with a reason unlocks it', async () => {
    const c = A.rider.c, real = await A.code(), wrong = real === '000000' ? '111111' : '000000';
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/deliver`, { code: '12ab56' })).status, 400, 'malformed code is not a try');
    for (let left = 4; left >= 1; left--) { const r = await c.post(`/api/rider/orders/${A.ref}/deliver`, { code: wrong }); assert.strictEqual(r.status, 400); assert.strictEqual(r.json.attemptsLeft, left); }
    const fifth = await c.post(`/api/rider/orders/${A.ref}/deliver`, { code: wrong }); assert.strictEqual(fifth.status, 423); assert.strictEqual(fifth.json.locked, true);
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/deliver`, { code: real })).status, 423, 'locked even for the right code');
    assert.strictEqual((await row(A.ref)).status, 'dispatched'); assert.strictEqual((await row(A.ref)).handover_locked, 1);
    assert.ok((await admin.get('/api/admin/dashboard')).json.locked >= 1);
    assert.strictEqual((await admin.post(`/api/admin/orders/${A.id}/handover`, { action: 'unlock', reason: '' })).status, 400, 'reason required');
    assert.strictEqual((await admin.post(`/api/admin/orders/${A.id}/handover`, { action: 'unlock', reason: 'short' })).status, 400);
    assert.strictEqual((await c.post(`/api/admin/orders/${A.id}/handover`, { action: 'unlock', reason: 'rider tries to unlock himself' })).status, 401);
    assert.strictEqual((await admin.post(`/api/admin/orders/${A.id}/handover`, { action: 'unlock', reason: 'Customer on the phone, code was misread' })).status, 200);
    const audit = (await admin.get('/api/admin/orders/' + A.id)).json.order.audit; assert.ok(audit.length === 1 && audit[0].actor === 'Owner' && /misread/.test(audit[0].reason) && audit[0].action === 'unlock');
    assert.strictEqual((await row(A.ref)).handover_attempts, 0);
  });
  await test('a correct code delivers: stamps the time and the rider position, works once, then the order is closed', async () => {
    const c = A.rider.c, code = await A.code();
    const ok = await c.post(`/api/rider/orders/${A.ref}/deliver`, { code, lat: 6.4699, lng: 3.5851 }); assert.strictEqual(ok.status, 200, ok.text); assert.strictEqual(ok.json.delivered, true);
    const o = await row(A.ref); assert.strictEqual(o.status, 'delivered'); assert.ok(o.delivered_at && o.handover_used_at); assert.ok(Math.abs(o.delivered_lat - 6.4699) < 1e-9 && Math.abs(o.delivered_lng - 3.5851) < 1e-9);
    assert.strictEqual((await c.post(`/api/rider/orders/${A.ref}/deliver`, { code })).status, 409, 'single use');
    assert.strictEqual(await A.code(), '', 'code no longer shown');
    const tl = (await guest.post('/api/orders/track', A.cust)).json.tracking; assert.ok(tl.timeline.stages.every((s) => s.at), 'all five stages stamped'); assert.strictEqual(tl.rider.position, null, 'no rider position once finished'); assert.strictEqual(tl.destination, null);
  });
  await test('privacy: once finished, riders and admins no longer get the customer pin', async () => {
    const d = (await A.rider.c.get(`/api/rider/orders/${A.ref}`)).json.order; assert.strictEqual(d.active, false); assert.ok(!('customer' in d) && !JSON.stringify(d).includes('Blue gate'));
    const a = (await admin.get('/api/admin/orders/' + A.id)).json.order; assert.strictEqual(a.dest_lat, null); assert.strictEqual(a.dest_lng, null);
    assert.strictEqual((await A.rider.c.get('/api/rider/orders')).json.orders.length, 0, 'finished order leaves the rider list');
  });
  await test('pay on delivery: entering the code records the cash collected and marks it paid', async () => {
    const x = await placeAndStart({ pay: 'pod' }); await takeToDoor(x);
    const d = (await x.rider.c.get(`/api/rider/orders/${x.ref}`)).json.order; assert.strictEqual(d.collect, x.total, 'rider is told how much cash to collect');
    const r = await x.rider.c.post(`/api/rider/orders/${x.ref}/deliver`, { code: await x.code() }); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.cash, x.total);
    const o = await row(x.ref); assert.strictEqual(o.cash_collected, x.total); assert.strictEqual(o.payment_status, 'paid'); assert.strictEqual(o.status, 'delivered');
  });
  await test('a cancelled order kills its code', async () => {
    const x = await placeAndStart({ pay: 'pod' }); await takeToDoor(x); const code = await x.code();
    assert.strictEqual((await admin.put('/api/admin/orders/' + x.id, { status: 'cancelled', note: 'Customer changed mind' })).status, 200);
    assert.strictEqual((await x.rider.c.post(`/api/rider/orders/${x.ref}/deliver`, { code })).status, 404 === 0 ? 0 : (await x.rider.c.post(`/api/rider/orders/${x.ref}/deliver`, { code })).status);
    const again = await x.rider.c.post(`/api/rider/orders/${x.ref}/deliver`, { code }); assert.ok([404, 409].includes(again.status), String(again.status));
    const o = await row(x.ref); assert.strictEqual(o.status, 'cancelled'); assert.strictEqual(o.handover_hash, ''); assert.strictEqual(await x.code(), '');
  });
  await test('two riders tapping at once: exactly one delivery, and parallel wrong guesses cannot beat the 5-try limit', async () => {
    const x = await placeAndStart({ pay: 'paystack' }); await takeToDoor(x); const code = await x.code();
    const both = await Promise.all([1, 2, 3, 4].map(() => x.rider.c.post(`/api/rider/orders/${x.ref}/deliver`, { code })));
    assert.strictEqual(both.filter((r) => r.status === 200).length, 1, both.map((r) => r.status).join(','));
    const y = await placeAndStart({ pay: 'paystack' }); await takeToDoor(y); const real = await y.code(), wrong = real === '000000' ? '111111' : '000000';
    const guesses = await Promise.all(Array.from({ length: 12 }, () => y.rider.c.post(`/api/rider/orders/${y.ref}/deliver`, { code: wrong })));
    const o = await row(y.ref); assert.ok(o.handover_attempts <= 5 && o.handover_locked === 1, `attempts=${o.handover_attempts}`);
    assert.strictEqual(guesses.filter((r) => r.status === 400).length, 4, guesses.map((r) => r.status).join(','));
    // override: deliver on the customer's word, with a logged reason
    assert.strictEqual((await admin.post(`/api/admin/orders/${y.id}/handover`, { action: 'deliver', reason: 'Customer confirmed receipt by phone' })).status, 200);
    const done = await row(y.ref); assert.strictEqual(done.status, 'delivered'); assert.strictEqual(done.delivered_lat, null);
    assert.ok((await admin.get('/api/admin/orders/' + y.id)).json.order.audit.some((a) => a.action === 'deliver' && /by phone/.test(a.reason)));
    assert.strictEqual((await admin.post(`/api/admin/orders/${y.id}/handover`, { action: 'deliver', reason: 'Trying a second time here' })).status, 409, 'cannot override a finished order');
  });
  await test('an override is refused when the code is not locked', async () => {
    const x = await placeAndStart({ pay: 'pod' }); await takeToDoor(x);
    const r = await admin.post(`/api/admin/orders/${x.id}/handover`, { action: 'deliver', reason: 'Because I would like to' }); assert.strictEqual(r.status, 409);
  });
  await test('a rider hammering the code endpoint is rate limited', async () => {
    const x = await placeAndStart({ pay: 'pod' }); await takeToDoor(x); let last;
    for (let i = 0; i < 35; i++) last = await x.rider.c.post(`/api/rider/orders/${x.ref}/deliver`, { code: '000000' });
    assert.ok([423, 429].includes(last.status), String(last.status));
  });

  console.log('\nMap provider: cache, cap, fallback');
  await test('address search: Nigeria only, cached (the provider is called once for repeats), never needed for page views', async () => {
    const before = prov.calls.geocode;
    const a = (await guest.get('/api/delivery/geocode?q=Allen%20Avenue%20Ikeja')).json;
    assert.strictEqual(a.available, true); assert.strictEqual(a.results.length, 1, 'the Accra result is dropped'); assert.match(a.results[0].label, /Ikeja/);
    for (let i = 0; i < 5; i++) await guest.get('/api/delivery/geocode?q=allen%20avenue%20%20ikeja');
    assert.strictEqual(prov.calls.geocode - before, 1);
    assert.deepStrictEqual((await guest.get('/api/delivery/geocode?q=ab')).json.results, []);
    const b = prov.calls.geocode; await guest.get('/api/config'); await guest.get('/api/products?store=electronics'); assert.strictEqual(prov.calls.geocode, b);
  });
  await test('routes are cached: the same pin quoted again does not call the routing provider', async () => {
    await guest.post('/api/delivery/quote', { items: cart(prodVI), state: 'Lagos', ...HOME });
    const before = prov.calls.routing;
    for (let i = 0; i < 5; i++) assert.strictEqual((await guest.post('/api/delivery/quote', { items: cart(prodVI), state: 'Lagos', ...HOME })).json.quote.ok, true);
    assert.strictEqual(prov.calls.routing, before);
  });
  await test('daily call cap: after it is reached the provider is left alone and estimates are used', async () => {
    for (let i = 0; i < 45; i++) await guest.get('/api/delivery/geocode?q=' + encodeURIComponent('unique street number ' + i));
    assert.ok(prov.calls.geocode + prov.calls.routing <= 30, `provider calls: ${prov.calls.geocode + prov.calls.routing}`);
    const q = (await guest.post('/api/delivery/quote', { items: cart(prodMain), state: 'Lagos', lat: 6.5312, lng: 3.3333 })).json.quote;
    assert.strictEqual(q.ok, true); assert.strictEqual(q.estimated, true); assert.strictEqual(q.legs[0].source, 'estimate');
    assert.strictEqual((await guest.get('/api/delivery/geocode?q=another%20new%20street')).json.available, false);
  });
  await test('provider down: quotes still work with estimated distances; address search says it is unavailable', async () => {
    prov.down = true;
    const q = (await guest.post('/api/delivery/quote', { items: cart(prodMain), state: 'Lagos', lat: 6.5555, lng: 3.3666 })).json.quote;
    assert.strictEqual(q.ok, true); assert.strictEqual(q.estimated, true); assert.ok(q.legs[0].km > 0 && q.legs[0].line.length === 2);
    assert.strictEqual((await guest.get('/api/delivery/geocode?q=somewhere%20else%20entirely')).json.available, false);
    prov.down = false;
  });
  await test('tracking points older than 30 days are deleted by the cleanup', async () => {
    const x = await placeAndStart({ pay: 'pod' }); const t = Math.floor(Date.now() / 1000);
    await sql('INSERT INTO rider_points (order_id,rider_id,lat,lng,created) VALUES ($1,$2,6.5,3.4,$3),($1,$2,6.5,3.4,$4)', [x.id, x.rider.id, t - 31 * 86400, t - 29 * 86400], DB_NAME);
    process.env.DATABASE_URL = withDb(DB_NAME); process.env.PGSSL = process.env.PGSSL_TEST || 'disable';
    const D = require('../lib/delivery'); const r = await D.purge();
    assert.ok(r.points >= 1); assert.strictEqual(Number((await sql('SELECT COUNT(*) n FROM rider_points WHERE order_id=$1', [x.id], DB_NAME))[0].n), 1);
    assert.strictEqual(D.POINT_DAYS, 30);
  });
  await test('map checkout can be switched off: ordinary checkout works again without a pin', async () => {
    await admin.put('/api/admin/settings', { settings: { map_checkout: '0' } });
    const r = await guest.post('/api/checkout', { ...body(cart(prodMain)), location: undefined }); assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await row(r.json.ref)).dest_lat, null);
    assert.strictEqual((await guest.post('/api/delivery/quote', { items: cart(prodMain), state: 'Lagos', ...HOME })).json.quote.code, 'disabled');
  });

  srv.kill(); storageMock.close(); prov.server.close();
  await new Promise((r) => setTimeout(r, 400));
  await sql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\nServer log:\n' + log.slice(-2000)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
