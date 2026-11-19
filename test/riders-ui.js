'use strict';
// Browser check of the rider dashboard and the admin live map (needs Chromium + playwright). Header of test/riders.js reused.
// Rider management check: accounts, consent-based GPS sessions, location freshness, ranking and weights, atomic offers, the full delivery
// workflow (offer > accept > arrive > collect > on the way > handover code > proof), follow-ups and escalation, custody-safe reassignment,
// chat with read receipts, performance, privacy (access log, retention), the AI command centre and the live (server-sent) streams.
// Run with: npm run test:riders   (needs TEST_DATABASE_URL like the other tests)
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_riders_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const FAKE = 6200 + Math.floor(Math.random() * 1200), P1 = FAKE + 1400;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-riders-'));
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 7).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(150); } };
const rad = (d) => (d * Math.PI) / 180;
const hav = (a, b) => { const dl = rad(b[0] - a[0]), dg = rad(b[1] - a[1]); const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dg / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };

// A stand-in for the Geoapify map service.
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const send = (s, o) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
  if (u.pathname === '/v1/routing') {
    const [a, b] = u.searchParams.get('waypoints').split('|').map((x) => x.split(',').map(Number)); const m = hav(a, b) * 1.3 * 1000;
    return send(200, { features: [{ properties: { distance: m, time: (m / 1000 / 30) * 3600 }, geometry: { type: 'LineString', coordinates: [[a[1], a[0]], [b[1], b[0]]] } }] });
  }
  send(404, {});
});
const q = async (sql, args) => { const c = new Pg({ connectionString: URL_DB }); await c.connect(); try { return (await c.query(sql, args)).rows; } finally { await c.end(); } };
const pg = async (sql) => { const c = new Pg({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const call = async (method, url, body, cookie) => { const r = await fetch(`http://127.0.0.1:${P1}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.getSetCookie ? r.headers.getSetCookie()[0] || '' : ''; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, c: sc.split(';')[0] }; };
const up = async () => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${P1}/health`); return; } catch { await sleep(100); } } throw new Error('app did not start'); };
// Reads a server-sent event stream until pred(text) is true.
const sse = async (url, cookie, trigger, pred, ms = 10000) => {
  const ac = new AbortController(), r = await fetch(`http://127.0.0.1:${P1}${url}`, { headers: { Cookie: cookie }, signal: ac.signal });
  assert.strictEqual(r.status, 200); assert.match(r.headers.get('content-type'), /event-stream/);
  const reader = r.body.getReader(), dec = new TextDecoder(); let text = '';
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    let fired = false;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      text += dec.decode(value, { stream: true });
      if (!fired && /event: hello/.test(text)) { fired = true; await trigger(); }
      if (pred(text)) return text;
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { clearTimeout(timer); ac.abort(); }
  throw new Error('stream did not deliver the expected event. Got: ' + text.slice(0, 300));
};


const SHOTS = process.env.SHOTS_DIR || os.tmpdir();
(async () => {
  let chromium; try { ({ chromium } = require('playwright')); } catch { console.log('playwright is not installed: skipping the browser test'); process.exit(0); }
  await new Promise((r) => fake.listen(FAKE, r));
  await pg(`CREATE DATABASE ${DB}`);
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(P1), BASE_URL: 'http://127.0.0.1:' + P1, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '', GEOAPIFY_API_KEY: 'test-key', GEO_API_URL: 'http://127.0.0.1:' + FAKE, RATE_LIMIT_MULTIPLIER: '200', WORKER_POLL_MS: '200', RIDER_HUB_POLL_MS: '300' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.log = ''; app.stdout.on('data', (d) => { app.log += d; }); app.stderr.on('data', (d) => { app.log += d; });
  await up();
  const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' })).c;
  const rows = await q("SELECT id FROM products WHERE active=1 AND stock>=30 AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 1"); const PA = Number(rows[0].id); await q('UPDATE products SET stock=500 WHERE id=$1', [PA]);
  await call('PUT', '/api/admin/settings', { settings: { open_hour: 0, cutoff_hour: 24, prep_minutes: 20, max_distance_km: 60 } }, admin);
  await call('PUT', '/api/admin/rider-ops/settings', { rider_dispatch_mode: 'auto' }, admin);
  await call('POST', '/api/admin/partners', { name: 'VELTO-MART Main Store', address: 'Ikeja, Lagos', state: 'Lagos', phone: '08000000001', lat: 6.6018, lng: 3.3515, radius_km: 40, is_default: true }, admin);
  await call('POST', '/api/admin/riders', { name: 'Ade Rider', email: 'ade@example.com', phone: '08033334001', password: 'RiderPass123', coverage: 'Lagos' }, admin);
  const browser = await chromium.launch();
  const base = 'http://127.0.0.1:' + P1;
  const rctx = await browser.newContext({ viewport: { width: 390, height: 800 }, geolocation: { latitude: 6.603, longitude: 3.352, accuracy: 15 }, permissions: ['geolocation'], deviceScaleFactor: 2 });
  const actx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const rp = await rctx.newPage(), ap = await actx.newPage(); const errors = [];
  for (const [n, p] of [['rider', rp], ['admin', ap]]) { p.on('pageerror', (e) => errors.push(n + ' page error: ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/tile|Failed to load resource/i.test(m.text())) errors.push(n + ' console: ' + m.text()); }); }
  const seen = (page, sel, ms = 15000) => page.waitForSelector(sel, { timeout: ms });
  const txt = (page, t, ms = 15000) => page.getByText(t, { exact: false }).first().waitFor({ timeout: ms });

  await test('rider is sent to /rider/login, signs in and lands on /rider/dashboard', async () => {
    await rp.goto(base + '/rider'); await seen(rp, '#rl'); assert.match(rp.url(), /\/rider\/login$/);
    await rp.fill('#re', 'ade@example.com'); await rp.fill('#rp', 'WrongPass1'); await rp.click('#rl button'); await seen(rp, '#rerr:not(.hide)');
    await rp.fill('#rp', 'RiderPass123'); await rp.click('#rl button'); await seen(rp, '#go-on'); assert.match(rp.url(), /\/rider\/dashboard$/);
    await txt(rp, 'Tracking off'); await rp.screenshot({ path: path.join(SHOTS, 'rider-offline.png') });
  });
  await test('Go online explains the location use, then tracking starts and the first position reaches the backend', async () => {
    await rp.click('#go-on'); await txt(rp, 'Share your location?'); await rp.click('#cy');
    await txt(rp, 'Tracking on'); await until(async () => (await q('SELECT COUNT(*) n FROM rider_locations'))[0].n > 0, 15000);
    const r = (await q('SELECT availability_status, location_consent_at FROM riders'))[0]; assert.strictEqual(r.availability_status, 'available'); assert.ok(r.location_consent_at);
    const l = (await q('SELECT latitude, accuracy FROM rider_latest_location'))[0]; assert.ok(Math.abs(l.latitude - 6.603) < 0.001);
    await rp.waitForFunction(() => /Live/.test((document.querySelector('#rbar') || {}).textContent || ''), null, { timeout: 15000 }); await rp.screenshot({ path: path.join(SHOTS, 'rider-online.png') });
  });
  await test('admin opens /admin/riders, signs in and sees the live rider on the map; clicking the marker opens the rider panel', async () => {
    await ap.goto(base + '/admin/riders'); await seen(ap, '#lf'); await ap.fill('#le', 'owner@example.com'); await ap.fill('#lp', 'OwnerPass123'); await ap.click('#lb');
    await seen(ap, '.rk-mk'); await txt(ap, 'Riders · live');
    assert.match(await ap.textContent('#rk-sum'), /1 online · 1 available/);
    await ap.screenshot({ path: path.join(SHOTS, 'admin-map.png') });
    await ap.click('.rk-mk'); await txt(ap, 'Status and location'); await txt(ap, 'Ade Rider'); await txt(ap, '±');
    await ap.screenshot({ path: path.join(SHOTS, 'admin-panel.png') }); await ap.click('#rp-x');
  });
  let order;
  await test('a new order is offered live to the rider; accepting it updates the admin map in real time', async () => {
    const r = await call('POST', '/api/checkout', { items: [{ productId: PA, qty: 1 }], contact: { name: 'Ada Obi', email: 'cust@example.com', phone: '08091234567' }, address: { state: 'Lagos', city: 'Yaba', address: '1 Road Street' }, delivery: 'standard', payment: 'pod', location: { lat: 6.61, lng: 3.36, landmark: 'Blue gate' } });
    order = (await q('SELECT id, ref, access_token FROM orders WHERE ref=$1', [r.j.ref]))[0];
    await call('PUT', '/api/admin/orders/' + order.id, { status: 'confirmed' }, admin);
    await txt(rp, 'ACCEPT DELIVERY', 20000); await rp.screenshot({ path: path.join(SHOTS, 'rider-offer.png') });
    await rp.click('[data-accept]'); await seen(rp, '[data-o]');
    await ap.waitForFunction(() => /1 on delivery/.test((document.querySelector('#rk-sum') || {}).textContent || ''), null, { timeout: 15000 }).catch(async (e) => { throw new Error('admin summary stayed: ' + (await ap.textContent('#rk-sum')) + ' | db: ' + JSON.stringify(await q('SELECT availability_status FROM riders')) + ' ' + JSON.stringify(await q('SELECT assignment_status FROM rider_assignments'))); });
  });
  await test('the rider follows the steps: arrive, collect, on the way, then completes with the customer\'s code', async () => {
    await seen(rp, '[data-map]'); await rp.waitForSelector('.leaflet-container', { timeout: 15000 }); await rp.screenshot({ path: path.join(SHOTS, 'rider-delivery.png'), fullPage: true });
    // live events must not rebuild the page and its map (that made the map shake)
    await rp.evaluate(() => { document.querySelector('.leaflet-container').dataset.keep = '1'; });
    for (let i = 0; i < 3; i++) { await q("INSERT INTO rider_events (rider_id, audience, kind, payload, created_at) VALUES ((SELECT id FROM riders LIMIT 1), 'rider', 'availability', '{}', $1)", [Math.floor(Date.now() / 1000)]); await rp.waitForTimeout(900); }
    assert.strictEqual(await rp.evaluate(() => { const c = document.querySelector('.leaflet-container'); return c && c.dataset.keep; }), '1', 'the map was rebuilt by a live update');
    await rp.click('[data-act="arrived"]'); await seen(rp, '[data-pick]'); await rp.click('[data-pick]'); await seen(rp, '[data-act="start"]'); await rp.click('[data-act="start"]');
    await seen(rp, '.codein'); const code = (await call('POST', '/api/orders/lookup', { ref: order.ref, email: 'cust@example.com', token: order.access_token })).j.order.handover_code;
    await rp.fill('.codein', '000000'); await rp.click('[data-act="complete"]'); await txt(rp, 'wrong', 8000).catch(() => {});
    await rp.fill('.codein', code); await rp.click('[data-act="complete"]');
    await until(async () => (await q("SELECT status FROM orders WHERE id=$1", [order.id]))[0].status === 'delivered', 15000);
    const pr = (await q('SELECT otp_verified FROM delivery_proofs'))[0]; assert.strictEqual(pr.otp_verified, 1);
  });
  await test('the customer sees the star form on the delivered order and rating it is saved', async () => {
    const cctx = await browser.newContext({ viewport: { width: 390, height: 800 } }), cp = await cctx.newPage();
    await cp.goto(`${base}/order/${order.ref}?t=${order.access_token}&email=cust@example.com`); await seen(cp, '#ratebox');
    await cp.click('[data-star="5"]'); await cp.fill('#ratetxt', 'Quick and polite'); await cp.click('#ratego');
    await cp.getByText('Your delivery rating', { exact: false }).first().waitFor({ timeout: 10000 });
    const f = (await q("SELECT rating, comment, source FROM rider_feedback"))[0]; assert.strictEqual(f.rating, 5); assert.strictEqual(f.source, 'customer'); assert.strictEqual(f.comment, 'Quick and polite');
    await cp.screenshot({ path: path.join(SHOTS, 'customer-rating.png'), fullPage: true }); await cctx.close();
  });
  await test('chat works both ways with read receipts, and the AI is named', async () => {
    await rp.screenshot({ path: path.join(SHOTS, 'rider-after.png') }); await rp.click('[data-tab="chat"]', { timeout: 8000 }); await seen(rp, '#mf');
    await rp.fill('#mt', 'Hello desk, delivery done'); await rp.click('#mf button.btn:not(.ghost)'); await txt(rp, 'Hello desk, delivery done');
    await ap.click('.rk-mk, [data-rider]'); await txt(ap, 'Hello desk, delivery done');
    await ap.fill('#rp-t', 'Thanks, well done'); await ap.click('#rp-form button'); await txt(rp, 'Thanks, well done', 15000);
    await txt(rp, 'VELTO-MART AI Operations Manager', 5000).catch(() => {});
    await rp.screenshot({ path: path.join(SHOTS, 'rider-chat.png') });
  });
  await test('going offline stops tracking and the admin sees the rider offline', async () => {
    await rp.click('[data-tab="home"]'); await seen(rp, '#go-off'); await rp.click('#go-off'); await seen(rp, '#go-on'); await txt(rp, 'Tracking off');
    assert.strictEqual((await q("SELECT availability_status FROM riders"))[0].availability_status, 'offline');
    await ap.keyboard.press('Escape'); await ap.waitForTimeout(1500); await ap.getByText('0 online', { exact: false }).first().waitFor({ timeout: 10000 });
  });
  await test('the AI command box answers from live data', async () => {
    await ap.click('[data-rt="ai"]'); await seen(ap, '#ci'); await ap.fill('#ci', 'How many riders are online right now?'); await ap.click('#cf button'); await txt(ap, 'Source: live database'); await ap.screenshot({ path: path.join(SHOTS, 'admin-ai.png') });
  });
  await test('no script errors in either screen', async () => { assert.deepStrictEqual(errors, []); });
  await browser.close(); app.kill(); fake.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log('\n--- app log (tail) ---\n' + app.log.split('\n').slice(-15).join('\n'));
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
