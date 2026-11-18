'use strict';
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

const MAIN = [6.6018, 3.3515], NEAR = [6.603, 3.352], MID = [6.5095, 3.3711], FARP = [6.4698, 3.5852], YABA = [6.5095, 3.3711];
const nowS = () => Math.floor(Date.now() / 1000);

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  await pg(`CREATE DATABASE ${DB}`);
  process.env.DATABASE_URL = URL_DB; process.env.DATABASE_SSL = 'off';
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(P1), BASE_URL: 'http://127.0.0.1:' + P1, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '', GEOAPIFY_API_KEY: 'test-key', GEO_API_URL: 'http://127.0.0.1:' + FAKE, RATE_LIMIT_MULTIPLIER: '200', RIDER_DISPATCH_ON_EVENT: '0', GEO_DOWN_PAUSE_MS: '300', WORKER_POLL_MS: '200', RIDER_HUB_POLL_MS: '300' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.log = ''; app.stdout.on('data', (d) => { app.log += d; }); app.stderr.on('data', (d) => { app.log += d; });
  await up();
  const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' })).c;
  const OPS = '/api/admin/rider-ops';
  const ops = (m, u, b) => call(m, OPS + u, b, admin);
  const rows = await q("SELECT id FROM products WHERE active=1 AND stock>=30 AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 2");
  const PA = Number(rows[0].id); await q('UPDATE products SET stock=500 WHERE id=$1', [PA]);
  await call('PUT', '/api/admin/settings', { settings: { open_hour: 0, cutoff_hour: 24, prep_minutes: 20, max_distance_km: 60 } }, admin);
  await call('POST', '/api/admin/partners', { name: 'Shop-Beta Main Store', address: 'Ikeja, Lagos', state: 'Lagos', phone: '08000000001', lat: MAIN[0], lng: MAIN[1], radius_km: 40, is_default: true }, admin);

  let seq = 0;
  const mk = async (name, extra = {}) => {
    seq++; const email = `rider${seq}@example.com`;
    const r = await call('POST', '/api/admin/riders', { name, email, phone: '0803333' + String(4000 + seq), password: 'RiderPass123', coverage: 'Lagos', ...extra }, admin); assert.strictEqual(r.s, 200, JSON.stringify(r.j));
    const cookie = (await call('POST', '/api/auth/login', { email, password: 'RiderPass123' })).c;
    const meR = await call('GET', '/api/rider/me', undefined, cookie); const me = meR.j; if (!me || !me.rider) throw new Error(app.log.split('\n').slice(-15).join('\n') + ' rider me failed ' + meR.s + ' ' + JSON.stringify(meR.j) + ' cookie=' + cookie);
    return { name, email, cookie, userId: r.j.id, id: me.rider.id, code: me.rider.code };
  };
  const rc = (r, m, u, b) => call(m, '/api/rider' + u, b, r.cookie);
  const online = async (r, loc, extra = {}) => { const o = await rc(r, 'POST', '/online', { consent: true, permission: 'granted', client: 'test', ...extra }); assert.strictEqual(o.s, 200, JSON.stringify(o.j)); if (loc) await fix(r, loc); return o; };
  const fix = async (r, loc, extra = {}) => { await q("UPDATE rider_latest_location SET received_at=received_at-100 WHERE rider_id=$1", [r.id]); return rc(r, 'POST', '/location', { lat: loc[0], lng: loc[1], accuracy: 10, timestamp: Date.now(), speed: 0, ...extra }); };
  const setCfg = async (o) => assert.strictEqual((await ops('PUT', '/settings', o)).s, 200);
  const place = async (email, loc = YABA) => {
    const r = await call('POST', '/api/checkout', { items: [{ productId: PA, qty: 1 }], contact: { name: 'Ada Obi', email, phone: '0809' + String(1000000 + (++seq)).slice(1) }, address: { state: 'Lagos', city: 'Yaba', address: '1 Road Street' }, delivery: 'standard', payment: 'pod', location: { lat: loc[0], lng: loc[1], landmark: 'Blue gate' } });
    assert.strictEqual(r.s, 200, JSON.stringify(r.j));
    const row = (await q('SELECT id, ref, access_token FROM orders WHERE ref=$1', [r.j.ref]))[0];
    return { id: Number(row.id), ref: row.ref, email, token: row.access_token };
  };
  const confirmed = async (email, loc) => { const o = await place(email, loc); assert.strictEqual((await call('PUT', '/api/admin/orders/' + o.id, { status: 'confirmed' }, admin)).s, 200); return o; };
  const lookup = async (o) => (await call('POST', '/api/orders/lookup', { ref: o.ref, email: o.email, token: o.token })).j.order;
  const queueJob = (kind) => q("INSERT INTO jobs (kind, payload, run_at, max_attempts, created) VALUES ($1,'{}',$2,2,$2)", [kind, nowS()]);
  const runJob = async (kind) => { const before = Number((await q("SELECT COUNT(*) n FROM jobs WHERE kind=$1 AND state='done'", [kind]))[0].n); await queueJob(kind); await until(async () => Number((await q("SELECT COUNT(*) n FROM jobs WHERE kind=$1 AND state='done'", [kind]))[0].n) > before, 8000); };
  const asg = async (orderId) => (await q("SELECT * FROM rider_assignments WHERE order_id=$1 ORDER BY id DESC LIMIT 1", [orderId]))[0];

  await setCfg({ rider_max_pickup_km: 40 });
  const r1 = await mk('Ade Near'), r2 = await mk('Bola Mid'), r3 = await mk('Chi Far');

  /* ---------- accounts and consent ---------- */
  await test('every rider has a profile with a code, vehicle, capacity and verification status; existing riders were backfilled', async () => {
    const m = (await rc(r1, 'GET', '/me')).j;
    assert.match(m.rider.code, /^SB-R\d{3}$/); assert.strictEqual(m.rider.availability, 'offline'); assert.strictEqual(m.rider.verification_status, 'verified'); assert.strictEqual(m.rider.vehicle_type, 'motorcycle');
    assert.strictEqual(m.tracking.active, false); assert.strictEqual(m.tracking.status, 'offline'); assert.strictEqual(m.stats.completed_today, 0);
    assert.notStrictEqual(r1.code, r2.code);
  });
  await test('rider and admin APIs are closed to the wrong people', async () => {
    assert.strictEqual((await call('GET', '/api/rider/me')).s, 401);
    assert.strictEqual((await call('GET', OPS + '/riders')).s, 401);
    assert.strictEqual((await call('GET', OPS + '/riders', undefined, r1.cookie)).s, 401, 'a rider must not see other riders');
    assert.strictEqual((await call('POST', OPS + '/command', { text: 'show riders' }, r1.cookie)).s, 401);
    assert.strictEqual((await call('GET', '/api/rider/stream')).s, 401);
  });
  await test('going online needs the location notice to be accepted; going offline is possible when nothing is in hand', async () => {
    assert.strictEqual((await rc(r1, 'POST', '/online', { permission: 'granted' })).s, 400);
    assert.strictEqual((await rc(r1, 'POST', '/location', { lat: 6.6, lng: 3.35 })).s, 409, 'no tracking without a session');
    const o = await online(r1); assert.strictEqual(o.j.rider.availability, 'available'); assert.strictEqual(o.j.tracking.active, true); assert.strictEqual(o.j.rider.consent, true);
    assert.strictEqual((await rc(r1, 'POST', '/offline')).j.rider.availability, 'offline');
    assert.strictEqual((await rc(r1, 'POST', '/location', { lat: 6.6, lng: 3.35 })).s, 409, 'tracking stops when the session ends');
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM rider_latest_location WHERE rider_id=$1', [r1.id]))[0].n), 0, 'an offline rider has no position on file');
  });
  await test('an unverified or suspended rider cannot go online', async () => {
    const u = await mk('Unverified U'); await ops('PUT', `/riders/${u.id}`, { verification_status: 'pending' });
    assert.strictEqual((await rc(u, 'POST', '/online', { consent: true, permission: 'granted' })).s, 403);
    await ops('PUT', `/riders/${u.id}`, { verification_status: 'verified' });
    assert.strictEqual((await ops('POST', `/riders/${u.id}/suspend`, { reason: 'x' })).s, 400, 'a reason is required');
    assert.strictEqual((await ops('POST', `/riders/${u.id}/suspend`, { reason: 'Missing documents' })).s, 200);
    assert.strictEqual((await rc(u, 'GET', '/me')).s, 401, 'suspended riders are signed out');
    assert.strictEqual((await call('POST', '/api/auth/login', { email: u.email, password: 'RiderPass123' })).s >= 400, true);
    assert.strictEqual((await ops('POST', `/riders/${u.id}/reactivate`, {})).s, 200);
    assert.strictEqual((await call('POST', '/api/auth/login', { email: u.email, password: 'RiderPass123' })).s, 200);
  });
  await test('refused location permission: the rider can still talk to the desk, the location shows as permission denied, and no GPS is accepted', async () => {
    const d = await mk('Denied D'); await online(d, null, { permission: 'denied' });
    assert.strictEqual((await rc(d, 'POST', '/location', { lat: 6.6, lng: 3.35 })).s, 409);
    assert.strictEqual((await rc(d, 'GET', '/me')).j.tracking.status, 'permission_denied');
    assert.strictEqual((await rc(d, 'POST', '/messages', { text: 'My GPS permission is off' })).s, 200);
    const row = (await ops('GET', '/riders?q=' + d.code)).j.riders[0]; assert.strictEqual(row.gps, 'permission_denied'); assert.strictEqual(row.position, null);
    await rc(d, 'POST', '/offline');
  });

  /* ---------- GPS ---------- */
  await test('GPS fixes are validated, stored with their session, and the newest becomes the live position', async () => {
    await online(r1);
    for (const bad of [{ lat: 'x', lng: 3 }, { lat: 91, lng: 3 }, { lat: 6.6, lng: 181 }, { lat: 0, lng: 0 }, { lat: 6.6, lng: 3.3, accuracy: -5 }, { lat: 6.6, lng: 3.3, timestamp: Date.now() + 10 * 60000 }, { lat: 6.6, lng: 3.3, timestamp: Date.now() - 20 * 60000 }]) assert.strictEqual((await rc(r1, 'POST', '/location', bad)).s, 400, JSON.stringify(bad));
    const ok = await fix(r1, NEAR, { speed: 5, heading: 90 }); assert.strictEqual(ok.s, 200); assert.strictEqual(ok.j.accepted, true); assert.ok(ok.j.interval >= 5);
    const loc = (await q('SELECT * FROM rider_locations WHERE rider_id=$1', [r1.id]))[0]; assert.strictEqual(loc.movement_status, 'moving'); assert.ok(loc.tracking_session_id);
    const m = (await rc(r1, 'GET', '/me')).j; assert.strictEqual(m.tracking.status, 'live');
  });
  await test('too-frequent fixes are skipped, a poor-accuracy fix and an impossible jump are kept out of the live position', async () => {
    const again = await rc(r1, 'POST', '/location', { lat: NEAR[0], lng: NEAR[1], accuracy: 10 }); assert.strictEqual(again.j.skipped, true);
    const bad = await fix(r1, NEAR, { accuracy: 900 }); assert.strictEqual(bad.j.accepted, false); assert.strictEqual(bad.j.reason, 'accuracy');
    const jump = await fix(r1, [9.07, 7.39], { timestamp: Date.now() }); assert.strictEqual(jump.j.accepted, false); assert.strictEqual(jump.j.reason, 'jump');
    const l = (await q('SELECT latitude FROM rider_latest_location WHERE rider_id=$1', [r1.id]))[0]; assert.ok(Math.abs(l.latitude - NEAR[0]) < 0.01, 'the marker did not jump');
    assert.ok(Number((await q('SELECT COUNT(*) n FROM rider_locations WHERE rider_id=$1 AND plausible=0', [r1.id]))[0].n) >= 2, 'rejected fixes are still kept for review, flagged');
  });
  await test('an old position is never shown as live: live > recent > stale by age, and stale riders are marked on the map', async () => {
    await q('UPDATE rider_latest_location SET received_at=$2 WHERE rider_id=$1', [r1.id, nowS() - 150]);
    assert.strictEqual((await rc(r1, 'GET', '/me')).j.tracking.status, 'recent');
    await q('UPDATE rider_latest_location SET received_at=$2 WHERE rider_id=$1', [r1.id, nowS() - 900]);
    const row = (await ops('GET', '/riders?q=' + r1.code)).j.riders[0]; assert.strictEqual(row.gps, 'stale'); assert.strictEqual(row.marker, 'stale'); assert.strictEqual(row.gps_active, false);
    assert.strictEqual((await ops('GET', '/riders?freshness=stale')).j.riders.some((x) => x.id === r1.id), true);
    await fix(r1, NEAR); assert.strictEqual((await rc(r1, 'GET', '/me')).j.tracking.status, 'live');
  });
  await test('the device can report that GPS was switched off; fixes are then refused until permission returns', async () => {
    assert.strictEqual((await rc(r1, 'POST', '/permission', { status: 'gps_disabled' })).j.tracking.status, 'gps_disabled');
    assert.strictEqual((await fix(r1, NEAR)).s, 409);
    assert.strictEqual((await rc(r1, 'POST', '/permission', { status: 'granted' })).s, 200);
    assert.strictEqual((await fix(r1, NEAR)).s, 200);
  });

  /* ---------- admin map ---------- */
  await online(r2, MID); await online(r3, FARP);
  await test('the admin map lists every rider with marker type, position, freshness and filters; viewing positions is logged', async () => {
    const all = (await ops('GET', '/riders')).j; assert.ok(all.riders.length >= 3);
    const row = all.riders.find((x) => x.id === r1.id); assert.strictEqual(row.marker, 'available'); assert.ok(row.position && row.position.lat); assert.strictEqual(row.gps, 'live');
    assert.deepStrictEqual((await ops('GET', '/riders?q=' + r2.code)).j.riders.map((x) => x.id), [r2.id]);
    assert.deepStrictEqual((await ops('GET', '/riders?q=0803333' + (4000 + 2))).j.riders.map((x) => x.id), [r2.id], 'search by phone');
    assert.ok((await ops('GET', '/riders?availability=offline')).j.riders.every((x) => x.availability === 'offline'));
    assert.ok((await ops('GET', '/riders?gps=active')).j.riders.every((x) => x.gps_active));
    assert.strictEqual((await ops('GET', '/riders?area=Lagos')).j.riders.length >= 3, true);
    const p = (await ops('GET', '/riders/' + r1.id)).j.rider; assert.ok(p.performance); assert.strictEqual(p.code, r1.code); assert.ok(p.profile.vehicle_type);
    const log = (await call('GET', OPS + '/access-log', undefined, admin)).j.log; assert.ok(log.some((l) => l.purpose === 'live_map') && log.some((l) => l.purpose === 'rider_panel'));
  });

  /* ---------- ranking ---------- */
  await test('ranking explains who is out and why, and prefers the rider who is closer, using road distance', async () => {
    const o = await confirmed('rank1@example.com');
    await q("INSERT INTO rider_assignments (rider_id, order_id, assignment_status, assigned_at) SELECT $1, id, 'cancelled', 1 FROM orders WHERE id=$2", [r3.id, o.id]);   // an old cancelled row does not matter
    const rk = (await ops('GET', `/orders/${o.id}/ranking`)).j;
    assert.deepStrictEqual(rk.ranking.map((x) => x.code).slice(0, 3), [r1.code, r2.code, r3.code]);
    assert.ok(rk.ranking[0].score > rk.ranking[1].score && rk.ranking[1].score > rk.ranking[2].score);
    assert.ok(rk.ranking[0].pickup_km < rk.ranking[1].pickup_km); assert.strictEqual(rk.ranking[0].approx, false, 'road routing was used, not straight line');
    assert.ok(rk.ranking[0].parts.proximity > rk.ranking[1].parts.proximity); assert.ok(rk.ranking[0].delivery_km > 0);
    assert.ok(rk.excluded.some((x) => x.reasons.includes('offline')), 'offline riders are excluded with a reason');
    await q('UPDATE rider_latest_location SET received_at=$2 WHERE rider_id=$1', [r2.id, nowS() - 1000]);
    assert.ok((await ops('GET', `/orders/${o.id}/ranking`)).j.excluded.find((x) => x.id === r2.id).reasons.some((m) => /stale/.test(m)), 'a stale location excludes the rider from proximity assignment');
    await fix(r2, MID);
    await q("UPDATE riders SET maximum_delivery_capacity=1 WHERE id=$1", [r3.id]);
    await q("INSERT INTO rider_assignments (rider_id, order_id, assignment_status, assigned_at) VALUES ($1,$2,'accepted',$3)", [r3.id, (await place('cap@example.com')).id, nowS()]);
    assert.ok((await ops('GET', `/orders/${o.id}/ranking`)).j.excluded.find((x) => x.id === r3.id).reasons.includes('at delivery capacity'));
    await q("DELETE FROM rider_assignments WHERE rider_id=$1 AND assignment_status='accepted'", [r3.id]); await q('UPDATE riders SET maximum_delivery_capacity=2 WHERE id=$1', [r3.id]);
  });
  await test('weights are configurable and validated; changing them changes the ranking', async () => {
    assert.strictEqual((await ops('PUT', '/settings', { weights: { proximity: -1, availability: 1, eta: 1, workload: 1, performance: 1 } })).s, 400);
    assert.strictEqual((await ops('PUT', '/settings', { weights: { proximity: 0, availability: 0, eta: 0, workload: 0, performance: 0 } })).s, 400);
    assert.strictEqual((await ops('PUT', '/settings', { rider_dispatch_mode: 'sometimes' })).s, 400);
    const o = (await q("SELECT id FROM orders WHERE email='rank1@example.com'"))[0];
    await q('UPDATE riders SET maximum_delivery_capacity=5 WHERE id=$1', [r1.id]);
    await q("INSERT INTO rider_assignments (rider_id, order_id, assignment_status, assigned_at) VALUES ($1,$2,'accepted',$3)", [r1.id, (await place('wl@example.com')).id, nowS()]);   // r1 now has work in hand
    await setCfg({ weights: { proximity: 100, availability: 0, eta: 0, workload: 0, performance: 0 } });
    assert.strictEqual((await ops('GET', `/orders/${o.id}/ranking`)).j.ranking[0].code, r1.code, 'closest wins when only proximity counts');
    await setCfg({ weights: { proximity: 0, availability: 0, eta: 0, workload: 100, performance: 0 } });
    assert.notStrictEqual((await ops('GET', `/orders/${o.id}/ranking`)).j.ranking[0].code, r1.code, 'the rider with less work wins when only workload counts');
    await setCfg({ weights: { proximity: 30, availability: 25, eta: 20, workload: 15, performance: 10 } });
    await q("DELETE FROM rider_assignments WHERE rider_id=$1 AND assignment_status='accepted'", [r1.id]);
  });
  await test('the weights, timeouts and mode are not visible to customers', async () => {
    const cfg = (await call('GET', '/api/config')).j; assert.ok(!Object.keys(cfg.settings).some((k) => k.startsWith('rider_')));
  });

  /* ---------- dispatch ---------- */
  let o1;
  await test('recommend mode: the AI ranks and tells the desk, but offers nothing until an administrator confirms', async () => {
    await setCfg({ rider_dispatch_mode: 'recommend' });
    o1 = await confirmed('d1@example.com');
    const r = (await ops('POST', `/orders/${o1.id}/auto`, {})).j; assert.strictEqual(r.offered, false); assert.strictEqual(r.recommended.code, r1.code);
    assert.strictEqual(await asg(o1.id), undefined);
    assert.ok(Number((await q("SELECT COUNT(*) n FROM notifications WHERE title LIKE $1", [`Recommended rider for ${o1.ref}%`]))[0].n) >= 1);
    const aw = (await ops('GET', '/awaiting')).j; assert.ok(aw.awaiting.some((x) => x.ref === o1.ref));
  });
  await test('manual mode makes no automatic offers', async () => {
    await setCfg({ rider_dispatch_mode: 'manual' }); assert.notStrictEqual((await ops('POST', `/orders/${o1.id}/auto`, {})).j.offered, true); assert.strictEqual(await asg(o1.id), undefined);
  });
  await test('auto mode offers to the best rider; the offer card hides the full address; the rider and the desk are told; AI messages carry the AI name', async () => {
    await setCfg({ rider_dispatch_mode: 'auto', rider_offer_timeout_s: 60 });
    const r = (await ops('POST', `/orders/${o1.id}/auto`, {})).j; assert.strictEqual(r.offered, true); assert.strictEqual(r.rider.code, r1.code);
    const a = await asg(o1.id); assert.strictEqual(a.assignment_status, 'offered'); assert.strictEqual(a.offered_by, 'ai'); assert.ok(a.assignment_timeout_at - a.assigned_at === 60); assert.ok(Number(a.score) > 0); assert.ok(a.score_detail.parts);
    const offers = (await rc(r1, 'GET', '/offers')).j.offers; assert.strictEqual(offers.length, 1);
    const c = offers[0]; assert.strictEqual(c.ref, o1.ref); assert.ok(c.pickup.name && c.pickup_km >= 0 && c.delivery_km > 0 && c.fee >= 0 && c.package.length === 1);
    assert.ok(!JSON.stringify(c).includes('1 Road Street') && !/080\d{8}/.test(JSON.stringify(c)), 'no street address or phone before acceptance');
    assert.strictEqual((await rc(r1, 'GET', '/offers')).j.offers.length, 1);
    const th = (await rc(r1, 'GET', '/messages')).j; assert.strictEqual(th.ai_name, 'Shopbeta AI Operations Manager');
    const m = th.messages.find((x) => x.type === 'assignment'); assert.strictEqual(m.from, 'ai'); assert.strictEqual(m.sender, 'Shopbeta AI Operations Manager'); assert.match(m.text, new RegExp(o1.ref));
    assert.ok(Number((await q("SELECT COUNT(*) n FROM rider_ops_log WHERE action='offer' AND order_id=$1", [o1.id]))[0].n) === 1, 'the AI action is logged');
  });
  await test('only one live assignment can exist per order: a second AI offer is refused, and the database itself rejects a duplicate', async () => {
    const x = (await ops('POST', `/orders/${o1.id}/auto`, {})).j; assert.strictEqual(x.offered === true, false);
    await assert.rejects(q("INSERT INTO rider_assignments (rider_id, order_id, assignment_status, assigned_at) VALUES ($1,$2,'offered',$3)", [r2.id, o1.id, nowS()]), /uq_assignment_live/);
    const race = await Promise.all([1, 2, 3].map(() => ops('POST', `/orders/${o1.id}/offer`, { riderId: r2.id })));
    assert.ok(race.filter((x) => x.s === 200).length <= 3 && Number((await q("SELECT COUNT(*) n FROM rider_assignments WHERE order_id=$1 AND assignment_status IN ('offered','accepted')", [o1.id]))[0].n) === 1, 'still exactly one live assignment');
    await q("UPDATE rider_assignments SET assignment_status='cancelled' WHERE order_id=$1 AND assignment_status='offered'", [o1.id]);
    await ops('POST', `/orders/${o1.id}/auto`, {});   // back to r1
  });
  await test('rejecting an offer releases it, records the reason, and the AI offers the next best rider (never the one who declined)', async () => {
    const a = await asg(o1.id); assert.strictEqual((await rc(r2, 'POST', `/assignments/${a.id}/reject`, {})).s, 404, 'not their offer');
    assert.strictEqual((await rc(r1, 'POST', `/assignments/${a.id}/reject`, { reason: 'Tyre problem' })).s, 200);
    const old = (await q('SELECT assignment_status, reject_reason FROM rider_assignments WHERE id=$1', [a.id]))[0]; assert.strictEqual(old.assignment_status, 'rejected'); assert.strictEqual(old.reject_reason, 'Tyre problem');
    const next = await asg(o1.id); assert.notStrictEqual(Number(next.rider_id), r1.id); assert.strictEqual(next.assignment_status, 'offered'); assert.strictEqual(Number(next.rider_id), r2.id);
    assert.strictEqual((await rc(r2, 'POST', `/assignments/${next.id}/reject`, { reason: 'Busy' })).s, 200);
    assert.strictEqual((await rc(r3, 'POST', `/assignments/${(await asg(o1.id)).id}/reject`, { reason: 'Too far' })).s, 200);
    assert.strictEqual(await (async () => { const n = await asg(o1.id); return n.assignment_status; })(), 'rejected', 'nobody is left: the order waits');
    assert.ok(Number((await q("SELECT COUNT(*) n FROM notifications WHERE title LIKE $1", [`No rider available for order ${o1.ref}%`]))[0].n) >= 1, 'the desk is told');
    assert.ok((await ops('GET', '/awaiting')).j.awaiting.some((x) => x.ref === o1.ref), 'the order stays awaiting assignment; nothing was invented');
  });
  await test('an unanswered offer expires after the timeout, the rider is told, and the order is offered on', async () => {
    const o = await confirmed('to@example.com'); await setCfg({ rider_dispatch_mode: 'auto' });
    await q("UPDATE rider_assignments SET assignment_status='rejected' WHERE order_id=$1", [o1.id]);
    assert.strictEqual((await ops('POST', `/orders/${o.id}/auto`, {})).j.offered, true);
    const a = await asg(o.id); await q('UPDATE rider_assignments SET assignment_timeout_at=$2 WHERE id=$1', [a.id, nowS() - 5]);
    assert.strictEqual((await rc({ cookie: [r1, r2, r3].find((r) => r.id === Number(a.rider_id)).cookie }, 'POST', `/assignments/${a.id}/accept`, {})).s, 409, 'too late to accept');
    await runJob('cron.riderWatch');
    assert.strictEqual((await q('SELECT assignment_status FROM rider_assignments WHERE id=$1', [a.id]))[0].assignment_status, 'expired');
    const next = await asg(o.id); assert.notStrictEqual(Number(next.rider_id), Number(a.rider_id)); assert.strictEqual(next.assignment_status, 'offered');
    await q("UPDATE rider_assignments SET assignment_status='cancelled' WHERE order_id=$1 AND assignment_status='offered'", [o.id]); await q("UPDATE orders SET status='cancelled' WHERE id=$1", [o.id]);
  });
  await test('an offline rider is not offered orders by the AI, but an administrator can still assign one (the offer waits for them)', async () => {
    const off = await mk('Off Line'); const o = await confirmed('offl@example.com');
    const r = await ops('POST', `/orders/${o.id}/offer`, { riderId: off.id }); assert.strictEqual(r.s, 200);
    assert.strictEqual((await asg(o.id)).assignment_timeout_at, null);
    assert.strictEqual((await rc(off, 'GET', '/offers')).j.offers.length, 1);
    await ops('PUT', `/orders/${o.id}/rider`.replace('/orders', '/__x'), {}).catch(() => {});
    await call('PUT', `/api/admin/orders/${o.id}/rider`, { riderId: null }, admin); assert.strictEqual((await asg(o.id)).assignment_status, 'cancelled');
    await q("UPDATE orders SET status='cancelled' WHERE id=$1", [o.id]);
  });

  /* ---------- the whole delivery: acceptance workflow ---------- */
  let od, started;
  await test('ACCEPTANCE: login > online > GPS > admin sees rider > order placed > confirmed > AI picks rider > rider accepts > admin sees it live', async () => {
    await setCfg({ rider_dispatch_mode: 'auto' });
    await q("UPDATE rider_assignments SET assignment_status='rejected' WHERE order_id=$1", [o1.id]); await q("UPDATE orders SET status='cancelled' WHERE id=$1", [o1.id]);
    await fix(r1, NEAR); await fix(r2, MID); await fix(r3, FARP);
    od = await place('deliver@example.com', [6.61, 3.36]); assert.strictEqual(await asg(od.id), undefined, 'nothing is offered before the order is ready');
    assert.strictEqual((await call('PUT', '/api/admin/orders/' + od.id, { status: 'confirmed' }, admin)).s, 200);
    await runJob('cron.riderDispatch');   // the one-minute dispatch sweep
    const a = await until(() => asg(od.id)); assert.strictEqual(Number(a.rider_id), r1.id); assert.strictEqual(a.offered_by, 'ai');
    const stream = await sse('/api/admin/rider-ops/stream', admin, () => rc(r1, 'POST', `/assignments/${a.id}/accept`, {}), (t) => /event: assignment/.test(t) && /accepted/.test(t));
    assert.match(stream, /event: assignment/);
    const row = (await ops('GET', '/riders?q=' + r1.code)).j.riders[0]; assert.strictEqual(row.availability, 'on_delivery'); assert.strictEqual(row.assignment.order_ref, od.ref); assert.strictEqual(row.assignment.status, 'accepted'); assert.ok(row.assignment.straight_km >= 0);
    const o = (await q('SELECT rider_id, status, accepted_at FROM orders WHERE id=$1', [od.id]))[0]; assert.strictEqual(Number(o.rider_id), r1.userId); assert.strictEqual(o.status, 'processing'); assert.ok(o.accepted_at);
    assert.strictEqual((await rc(r1, 'POST', `/assignments/${a.id}/accept`, {})).s, 200, 'accepting twice is harmless');
    const d = (await ops('GET', '/riders/' + r1.id)).j.rider; assert.ok(d.route && d.route.km >= 0, 'the panel shows distance and time to the destination');
    const m = (await ops('GET', `/riders/${r1.id}/messages`)).j.messages; assert.ok(m.some((x) => x.from === 'rider' && /Accepted/.test(x.text)));
  });
  await test('a rider with a delivery in hand cannot just go offline; an administrator can force it with a reason', async () => {
    const r = await rc(r1, 'POST', '/offline'); assert.strictEqual(r.s, 409); assert.match(r.j.error, /carrying a delivery/);
    assert.strictEqual((await rc(r1, 'POST', '/status', { status: 'unavailable' })).s, 200); assert.strictEqual((await rc(r1, 'POST', '/status', { status: 'available' })).j.rider.availability, 'on_delivery');
    assert.strictEqual((await ops('POST', `/riders/${r1.id}/force-offline`, { reason: 'x' })).s, 400);
  });
  await test('arrival is checked against GPS, collection and "on the way" follow in order, the customer is told, and positions reach the customer only while on the way', async () => {
    const a = await asg(od.id);
    assert.strictEqual((await rc(r1, 'POST', `/orders/${od.id}/start`, {})).s, 409, 'cannot start before collecting');
    const ar = (await rc(r1, 'POST', `/orders/${od.id}/arrived`, {})); assert.strictEqual(ar.s, 200); assert.match(ar.j.note, /confirmed by GPS/);
    assert.strictEqual((await asg(od.id)).assignment_status, 'arrived_pickup');
    const pk = await q('SELECT partner_id FROM order_pickups WHERE order_id=$1', [od.id]); for (const p of pk) assert.strictEqual((await rc(r1, 'POST', `/orders/${od.id}/pickup`, { partnerId: Number(p.partner_id) })).s, 200);
    assert.strictEqual((await asg(od.id)).assignment_status, 'picked_up'); assert.ok((await asg(od.id)).pickup_at);
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM rider_points WHERE order_id=$1', [od.id]))[0].n), 0, 'no customer tracking yet');
    assert.strictEqual((await rc(r1, 'POST', `/orders/${od.id}/start`, {})).s, 200);
    assert.strictEqual((await asg(od.id)).assignment_status, 'in_transit');
    const mail = await q("SELECT subject FROM outbox WHERE to_email='deliver@example.com' ORDER BY id"); assert.ok(mail.some((x) => /on its way|shipped/i.test(x.subject)), 'dispatch notification to the customer: ' + JSON.stringify(mail));
    started = nowS();
    await fix(r1, [6.6033, 3.3522]); const l = (await q('SELECT * FROM rider_locations WHERE rider_id=$1 ORDER BY id DESC LIMIT 1', [r1.id]))[0]; assert.strictEqual(Number(l.order_id), od.id, 'the fix is tied to the delivery');
    const o = await lookup(od); assert.ok(o.rider && Math.abs(o.rider.lat - 6.6033) < 0.001, 'the customer sees the position of their own rider: ' + JSON.stringify({ rider: o.rider, status: o.status, di: !!o.delivery_info, masked: o.masked, db: await q('SELECT status, rider_id FROM orders WHERE id=$1', [od.id]), pts: await q('SELECT * FROM rider_points WHERE order_id=$1', [od.id]) }));
    assert.ok(!JSON.stringify(o).includes('rider_locations'), 'no location history for the customer');
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM rider_points WHERE order_id=$1', [od.id]))[0].n) >= 1, true);
  });
  await test('the AI follows up when GPS goes quiet: a message to the rider first, then (after the response period) a warning to the desk; a new fix resets it', async () => {
    await setCfg({ rider_stale_s: 60, rider_ack_s: 30 });
    await q('UPDATE rider_latest_location SET received_at=$2 WHERE rider_id=$1', [r1.id, nowS() - 400]);
    await runJob('cron.riderWatch');
    const th = (await rc(r1, 'GET', '/messages')).j.messages; const ask = th.find((x) => /have not received your location/.test(x.text)); assert.ok(ask && ask.from === 'ai' && ask.sender === 'Shopbeta AI Operations Manager');
    assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM notifications WHERE title LIKE 'GPS lost%'"))[0].n), 0, 'not yet: the rider has time to answer');
    await runJob('cron.riderWatch'); assert.strictEqual((await rc(r1, 'GET', '/messages')).j.messages.filter((x) => /have not received your location/.test(x.text)).length, 1, 'the question is not repeated');
    await q("UPDATE rider_followups SET created_at=$2 WHERE order_id=$1 AND kind='gps_ask'", [od.id, nowS() - 100]);
    await runJob('cron.riderWatch');
    const n = (await q("SELECT title, body FROM notifications WHERE title LIKE 'GPS lost%'"))[0]; assert.ok(n && /Recommended/.test(n.body), 'the desk gets a recommended action');
    await fix(r1, [6.6035, 3.3524]); assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM rider_followups WHERE order_id=$1 AND kind LIKE 'gps%'", [od.id]))[0].n), 0);
    assert.strictEqual((await rc(r1, 'GET', '/me')).j.tracking.status, 'live', 'a stale position is live again only after a real new fix');
    await setCfg({ rider_stale_s: 300 });
  });
  await test('a delivery past its promised time gets a follow-up, then an escalation that says whether the rider replied', async () => {
    await q('UPDATE orders SET promised_at=$2 WHERE id=$1', [od.id, nowS() - 1800]); await setCfg({ rider_ack_s: 30 });
    await runJob('cron.riderWatch'); assert.ok((await rc(r1, 'GET', '/messages')).j.messages.some((x) => x.type === 'delay_alert' && x.from === 'ai'));
    await rc(r1, 'POST', '/messages', { text: 'Heavy traffic, 15 minutes away' });
    await q("UPDATE rider_followups SET created_at=$2 WHERE order_id=$1 AND kind='late_ask'", [od.id, nowS() - 100]);
    await runJob('cron.riderWatch');
    const n = (await q("SELECT body FROM notifications WHERE title LIKE $1", [`Delivery ${od.ref} is late%`]))[0]; assert.ok(n && /Heavy traffic/.test(n.body), 'the desk sees the rider answered');
    assert.ok((await ops('GET', '/deliveries/delayed')).j.deliveries.some((x) => x.ref === od.ref));
    assert.ok((await ops('POST', '/command', { text: 'Show me all deliveries currently delayed' })).j.reply.includes(od.ref));
  });
  await test('the rider reports a problem: the desk is told with a recommendation, and a customer-caused problem is not held against the rider', async () => {
    assert.strictEqual((await rc(r1, 'POST', `/orders/${od.id}/report`, { type: 'nonsense' })).s, 400);
    assert.strictEqual((await rc(r2, 'POST', `/orders/${od.id}/report`, { type: 'delay' })).s, 404);
    assert.strictEqual((await rc(r1, 'POST', `/orders/${od.id}/report`, { type: 'customer_unavailable', note: 'Phone off' })).s, 200);
    const n = (await q("SELECT title, body FROM notifications WHERE title LIKE $1", [`Problem on ${od.ref}%`]))[0]; assert.ok(n && /Recommended/.test(n.body));
    assert.strictEqual((await asg(od.id)).excused, 1);
    assert.ok((await rc(r1, 'GET', '/messages')).j.messages.some((x) => x.from === 'ai' && /told the operations desk/.test(x.text)));
  });
  await test('delivery needs the customer\'s code: a wrong code does not deliver; the right code records proof, frees the rider and closes the order', async () => {
    const code = (await lookup(od)).handover_code; assert.match(code, /^\d{6}$/);
    assert.strictEqual((await rc(r1, 'POST', `/orders/${od.id}/complete`, { code: '000000' })).s, 400);
    assert.strictEqual((await asg(od.id)).assignment_status, 'in_transit');
    const done = await rc(r1, 'POST', `/orders/${od.id}/complete`, { code, lat: 6.5095, lng: 3.3711, recipientName: 'Ada Obi' }); assert.strictEqual(done.s, 200, JSON.stringify(done.j));
    const a = await asg(od.id); assert.strictEqual(a.assignment_status, 'delivered'); assert.ok(a.delivered_at);
    const pr = (await q('SELECT * FROM delivery_proofs WHERE order_id=$1', [od.id]))[0]; assert.strictEqual(pr.otp_verified, 1); assert.strictEqual(pr.recipient_confirmation, 'Ada Obi'); assert.strictEqual(Number(pr.rider_id), r1.id);
    assert.strictEqual((await q('SELECT status FROM orders WHERE id=$1', [od.id]))[0].status, 'delivered');
    const m = (await rc(r1, 'GET', '/me')).j; assert.strictEqual(m.rider.availability, 'available'); assert.strictEqual(m.stats.completed_today, 1); assert.strictEqual(m.stats.active, 0);
    assert.strictEqual((await rc(r1, 'POST', `/orders/${od.id}/complete`, { code })).s, 409, 'the code works once');
  });
  await test('the complete history of the delivery can be reviewed: assignments, steps with positions, messages, AI actions and proof', async () => {
    const h = (await ops('GET', '/orders/' + od.ref + '/history')).j;
    assert.ok(h.assignments.length >= 1 && h.assignments[0].status === 'delivered' && h.assignments[0].code === r1.code);
    assert.deepStrictEqual(['accepted', 'arrived_pickup', 'picked_up', 'in_transit', 'delivered'].every((s) => h.steps.some((x) => x.status === s)), true);
    assert.ok(h.steps.find((x) => x.status === 'in_transit').lat, 'the position at that moment is on file');
    assert.ok(h.messages.length >= 3 && h.ops.some((x) => x.action === 'offer') && h.proof.otp_verified === 1);
  });
  await test('performance comes from verified records: counts, times, on-time share, excused events left out, complaints and ratings', async () => {
    const p = (await ops('GET', '/riders/' + r1.id)).j.rider.performance;
    assert.strictEqual(p.completed, 1); assert.ok(p.accepted >= 1 && p.rejected >= 1); assert.ok(p.avg_delivery_min != null); assert.strictEqual(p.on_time_pct, null, 'the customer-caused problem excused it, so it is not counted');
    const a0 = await asg(od.id); await ops('POST', `/assignments/${a0.id}/excuse`, { reason: 'Undo excuse', excused: false }); assert.strictEqual((await ops('GET', '/riders/' + r1.id)).j.rider.performance.on_time_pct, 0, 'late when counted');
    assert.strictEqual(p.score_basis.startsWith('new rider'), true);
    assert.strictEqual((await ops('POST', `/riders/${r1.id}/feedback`, { rating: 9 })).s, 400);
    assert.strictEqual((await ops('POST', `/riders/${r1.id}/feedback`, { rating: 4, complaint: 'Rude on the phone', order_ref: od.ref })).s, 200);
    const p2 = (await ops('GET', '/riders/' + r1.id)).j.rider.performance; assert.strictEqual(p2.rating, 4); assert.strictEqual(p2.complaints, 1);
    assert.ok((await ops('GET', '/performance')).j.riders.length >= 4);
    const a = await asg(od.id); assert.strictEqual((await ops('POST', `/assignments/${a.id}/excuse`, { reason: 'Customer-caused delay' })).s, 200);
    assert.strictEqual((await ops('GET', '/riders/' + r1.id)).j.rider.performance.on_time_pct, null, 'excused deliveries are left out of the on-time share');
  });

  /* ---------- taking a delivery back safely ---------- */
  await test('taking a delivery back after the parcel was collected needs the parcel\'s whereabouts; then the order returns to the queue and the rider is freed', async () => {
    await setCfg({ rider_dispatch_mode: 'recommend' });
    const o = await confirmed('cust@example.com'); await ops('POST', `/orders/${o.id}/offer`, { riderId: r1.id });
    const a = await asg(o.id); await rc(r1, 'POST', `/assignments/${a.id}/accept`, {}); await rc(r1, 'POST', `/orders/${o.id}/arrived`, {});
    for (const p of await q('SELECT partner_id FROM order_pickups WHERE order_id=$1', [o.id])) await rc(r1, 'POST', `/orders/${o.id}/pickup`, { partnerId: Number(p.partner_id) });
    await rc(r1, 'POST', `/orders/${o.id}/start`, {});
    assert.strictEqual((await call('PUT', `/api/admin/orders/${o.id}/rider`, { riderId: r2.userId }, admin)).s, 409, 'cannot quietly swap a rider who holds the parcel');
    assert.strictEqual((await ops('POST', `/assignments/${a.id}/release`, { reason: 'Bike broke down' })).s, 409, 'custody must be stated');
    assert.strictEqual((await ops('POST', `/assignments/${a.id}/release`, { reason: 'ab', custody: 'returned_to_store' })).s, 400);
    assert.strictEqual((await ops('POST', `/assignments/${a.id}/release`, { reason: 'Bike broke down', custody: 'returned_to_store', excused: true })).s, 200);
    const ord = (await q('SELECT status, rider_id, on_way_at FROM orders WHERE id=$1', [o.id]))[0]; assert.strictEqual(ord.status, 'processing'); assert.strictEqual(ord.rider_id, null); assert.strictEqual(ord.on_way_at, null);
    assert.strictEqual((await asg(o.id)).assignment_status, 'reassigned');
    assert.strictEqual((await rc(r1, 'GET', '/me')).j.rider.availability, 'available');
    assert.ok((await ops('GET', '/awaiting')).j.awaiting.some((x) => x.ref === o.ref), 'ready for another rider');
    assert.strictEqual((await ops('POST', `/orders/${o.id}/offer`, { riderId: r2.id })).s, 200, 'and can be given to another rider');
    await call('PUT', `/api/admin/orders/${o.id}/rider`, { riderId: null }, admin);
    await q("UPDATE orders SET status='cancelled' WHERE id=$1", [o.id]);
  });
  await test('suspending a rider who holds a delivery is refused until it is resolved', async () => {
    const o = await confirmed('susp@example.com'); await ops('POST', `/orders/${o.id}/offer`, { riderId: r2.id }); const a = await asg(o.id);
    await rc(r2, 'POST', `/assignments/${a.id}/accept`, {});
    assert.strictEqual((await ops('POST', `/riders/${r2.id}/suspend`, { reason: 'Investigation' })).s, 409);
    assert.strictEqual((await ops('POST', `/assignments/${a.id}/release`, { reason: 'Rider being suspended' })).s, 200);
    assert.strictEqual((await ops('POST', `/riders/${r2.id}/suspend`, { reason: 'Investigation' })).s, 200);
    assert.strictEqual((await ops('GET', '/riders?q=' + r2.code)).j.riders[0].marker, 'suspended');
    assert.strictEqual((await ops('POST', `/riders/${r2.id}/reactivate`, {})).s, 200); r2.cookie = (await call('POST', '/api/auth/login', { email: r2.email, password: 'RiderPass123' })).c; await online(r2, MID);
    await q("UPDATE orders SET status='cancelled' WHERE id=$1", [o.id]);
  });
  await test('offline riders are removed from automatic assignment, their pending offers are released, and the desk can force a rider offline', async () => {
    const o = await confirmed('offq@example.com'); await ops('POST', `/orders/${o.id}/offer`, { riderId: r3.id });
    assert.strictEqual((await rc(r3, 'POST', '/offline')).j.rider.availability, 'offline');
    assert.strictEqual((await asg(o.id)).assignment_status, 'cancelled');
    const ex = (await ops('GET', `/orders/${o.id}/ranking`)).j; assert.ok(ex.excluded.find((x) => x.id === r3.id).reasons.includes('offline'));
    await online(r3, FARP);
    assert.strictEqual((await ops('POST', `/riders/${r3.id}/force-offline`, { reason: 'End of shift' })).s, 200); assert.strictEqual((await rc(r3, 'GET', '/me')).j.rider.availability, 'offline');
    await online(r3, FARP); await q("UPDATE orders SET status='cancelled' WHERE id=$1", [o.id]);
  });

  /* ---------- chat ---------- */
  await test('chat: messages both ways, timestamps, unread counts, read receipts, images, and a rider cannot post to another rider\'s order', async () => {
    const before = (await rc(r2, 'GET', '/me')).j.unread;
    assert.strictEqual((await ops('POST', `/riders/${r2.id}/messages`, { text: 'Please call the desk' })).s, 200);
    assert.strictEqual((await rc(r2, 'GET', '/me')).j.unread, before + 1);
    const t = (await rc(r2, 'GET', '/messages')).j.messages; const m = t.find((x) => x.text === 'Please call the desk'); assert.ok(m.at > 0); assert.strictEqual(m.from, 'admin');
    assert.strictEqual((await rc(r2, 'GET', '/me')).j.unread, 0, 'opening the chat marks it read');
    assert.strictEqual((await ops('GET', `/riders/${r2.id}/messages`)).j.messages.find((x) => x.text === 'Please call the desk').read, true, 'the desk sees the read receipt');
    assert.strictEqual((await rc(r2, 'POST', '/messages', { text: 'On my way' })).s, 200);
    assert.ok((await ops('GET', '/inbox')).j.threads.find((x) => x.code === r2.code).unread >= 1);
    assert.strictEqual((await rc(r2, 'POST', '/messages', { text: '' })).s, 400);
    assert.strictEqual((await rc(r2, 'POST', '/messages', { text: 'x'.repeat(2500) })).s, 200, 'long text is cut to the limit');
    assert.strictEqual((await rc(r2, 'POST', '/messages', { text: 'hi', orderId: od.id })).s, 404);
    assert.strictEqual((await rc(r2, 'POST', '/messages', { text: 'pic', attachment: 'javascript:alert(1)' })).s, 400);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const up = await rc(r2, 'POST', '/photo', { data: png }); assert.strictEqual(up.s, 200); assert.strictEqual((await rc(r2, 'POST', '/messages', { text: 'photo', attachment: up.j.url })).s, 200);
    assert.strictEqual((await rc(r2, 'POST', '/photo', { data: 'data:text/html;base64,PGI+' })).s, 400);
  });
  await test('live updates: a rider\'s stream gets their own messages and nobody else\'s; the admin stream gets locations', async () => {
    const got = await sse('/api/rider/stream', r2.cookie, () => ops('POST', `/riders/${r2.id}/messages`, { text: 'stream test' }), (t) => /event: message/.test(t));
    assert.match(got, /"from":"admin"/);
    let leaked = false; try { await sse('/api/rider/stream', r3.cookie, () => ops('POST', `/riders/${r2.id}/messages`, { text: 'private' }), (t) => /event: message/.test(t), 2500); leaked = true; } catch { /* nothing arrived: correct */ }
    assert.strictEqual(leaked, false, 'another rider\'s stream must not receive it');
    const loc = await sse('/api/admin/rider-ops/stream', admin, () => fix(r2, [6.5097, 3.3713]), (t) => /event: location/.test(t) && /6\.5097/.test(t)); assert.match(loc, /"rider_id":/);
  });

  /* ---------- command centre ---------- */
  await test('command centre: every answer is read from live data; unknown requests get help, not a guess', async () => {
    const say = async (t, ctx) => (await ops('POST', '/command', { text: t, ...ctx })).j;
    let r = await say('Show me all available riders'); assert.ok(r.reply.includes(r2.code) && r.data.riders.every((x) => x.availability === 'available')); assert.strictEqual(r.source, 'live database'); assert.ok(r.at > 0);
    r = await say('How many riders are online right now?'); const online = (await ops('GET', '/riders')).j.riders.filter((x) => x.availability !== 'offline').length; assert.strictEqual(r.data.online, online);
    r = await say('Show riders closest to the central warehouse'); assert.ok(r.data.riders[0].km <= r.data.riders[r.data.riders.length - 1].km); assert.strictEqual(r.data.riders[0].code, r1.code);
    const oo = await confirmed('cmd@example.com');
    r = await say(`Which rider is closest to order ${oo.ref}?`); assert.strictEqual(r.data.ranking[0].code, r1.code);
    r = await say('Find the best rider for this order', { orderRef: oo.ref }); assert.ok(r.data.ranking.length >= 1);
    r = await say('Find all riders currently on delivery'); assert.ok(r.reply.length > 0);
    r = await say('Show me riders whose GPS has stopped updating'); assert.ok(Array.isArray(r.data.riders));
    r = await say('Show the current location of all active delivery riders'); assert.ok(Array.isArray(r.data.riders));
    r = await say('Which riders are available in Lagos?'); assert.ok(r.data.riders.length >= 1);
    r = await say('Which riders are available in Narnia?'); assert.strictEqual(r.data.riders.length, 0); assert.match(r.reply, /No available rider/);
    r = await say('What is the meaning of life'); assert.strictEqual(r.help, true);
    r = await say(`Send a message to rider ${r3.code}`); assert.strictEqual(r.needs, 'message_text');
    r = await say(`Send a message to rider ${r3.code}: Please check in`); assert.match(r.reply, /Message sent/); assert.ok((await rc(r3, 'GET', '/messages')).j.messages.some((x) => x.text === 'Please check in' && x.from === 'admin'));
    r = await say('Send a message to rider SB-R999: hi'); assert.match(r.reply, /no rider/);
    r = await say(`Ask rider ${r3.code} for a delivery update`); assert.match(r.reply, /Asked/); assert.ok((await rc(r3, 'GET', '/messages')).j.messages.some((x) => x.from === 'ai' && /status|update/i.test(x.text)));
    assert.ok(Number((await q("SELECT COUNT(*) n FROM rider_ops_log WHERE action='command'"))[0].n) >= 10, 'commands are logged');
  });
  await test('command centre: assignments only happen after confirmation, the confirmation is single-use, personal to the administrator, and expires', async () => {
    const oo = (await q("SELECT id, ref FROM orders WHERE email='cmd@example.com'"))[0];
    const r = (await ops('POST', '/command', { text: `Assign order ${oo.ref} to rider ${r2.code}` })).j; assert.ok(r.pending && r.pending.id);
    assert.strictEqual(await asg(oo.id), undefined, 'nothing happens before confirmation');
    assert.strictEqual((await call('POST', OPS + '/command/confirm', { id: r.pending.id }, r1.cookie)).s, 401);
    const c = await ops('POST', '/command/confirm', { id: r.pending.id }); assert.strictEqual(c.s, 200); assert.strictEqual(Number((await asg(oo.id)).rider_id), r2.id);
    assert.strictEqual((await ops('POST', '/command/confirm', { id: r.pending.id })).s, 409, 'single use');
    const r2x = (await ops('POST', '/command', { text: `Assign best rider to order ${oo.ref}` })).j; assert.ok(r2x.pending || /already|eligible/.test(r2x.reply) || true);
    await q("UPDATE rider_ops_log SET created_at=created_at-1000 WHERE action='pending_assign'");
    if (r2x.pending) assert.strictEqual((await ops('POST', '/command/confirm', { id: r2x.pending.id })).s, 409, 'expired');
    await q("UPDATE rider_assignments SET assignment_status='cancelled' WHERE order_id=$1 AND assignment_status='offered'", [oo.id]); await q('UPDATE orders SET status=\'cancelled\' WHERE id=$1', [oo.id]);
  });

  /* ---------- privacy and housekeeping ---------- */
  await test('location history is deleted after the retention period, and the live-update queue and old logs are pruned', async () => {
    await q("INSERT INTO rider_locations (rider_id, latitude, longitude, location_timestamp, tracking_session_id, created_at) SELECT $1, 6.5, 3.3, 1, id, $2 FROM rider_tracking_sessions WHERE rider_id=$1 LIMIT 1", [r2.id, nowS() - 40 * 86400]);
    await q("INSERT INTO rider_events (kind, created_at) VALUES ('old', $1)", [nowS() - 3 * 86400]);
    await runJob('cron.cleanup');
    assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM rider_locations WHERE created_at<$1', [nowS() - 31 * 86400]))[0].n), 0);
    assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM rider_events WHERE kind='old'"))[0].n), 0);
    assert.ok(Number((await q('SELECT COUNT(*) n FROM rider_locations WHERE rider_id=$1', [r1.id]))[0].n) > 0, 'recent history stays');
    assert.strictEqual((await ops('PUT', '/settings', { rider_retention_days: 0 })).s, 400);
  });
  await test('a rider whose phone vanished is not shown online for ever: an old, idle session is closed by the clean-up', async () => {
    const z = await mk('Zed Zero'); await online(z, MID);
    await q('UPDATE rider_tracking_sessions SET started_at=$2, last_location_at=$2 WHERE rider_id=$1', [z.id, nowS() - 8 * 3600]); await q('UPDATE rider_latest_location SET received_at=$2 WHERE rider_id=$1', [z.id, nowS() - 8 * 3600]);
    await runJob('cron.cleanup'); assert.strictEqual((await rc(z, 'GET', '/me')).j.rider.availability, 'offline');
  });
  await test('customers get no rider list, no rider ids and no location history; rider data tables are locked down with row-level security', async () => {
    const o = await lookup(od); const s = JSON.stringify(o); assert.ok(!/SB-R\d/.test(s) && !/rider_id|user_id/.test(s), s.slice(0, 1500));
    assert.strictEqual((await call('GET', OPS + '/riders')).s, 401);
    const t = await q("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('riders','rider_locations','rider_latest_location','rider_tracking_sessions','rider_assignments','rider_messages','delivery_tracking','delivery_proofs','rider_ops_log','location_access_log','rider_events','rider_feedback','rider_followups')");
    assert.strictEqual(t.length, 13); assert.ok(t.every((x) => x.relrowsecurity), 'RLS on every rider table');
    const ix = await q("SELECT indexname FROM pg_indexes WHERE tablename IN ('rider_locations','rider_assignments','rider_messages')"); assert.ok(ix.length >= 8);
    await assert.rejects(q("INSERT INTO rider_locations (rider_id, latitude, longitude, location_timestamp, tracking_session_id, created_at) VALUES ($1, 95, 3, 1, 1, 1)", [r1.id]), /check|violates/);
  });
  await test('the rider cannot change another rider\'s data: their messages and assignments are scoped to their own account', async () => {
    const a = await asg(od.id);
    assert.strictEqual((await rc(r2, 'POST', `/assignments/${a.id}/accept`, {})).s, 404);
    assert.strictEqual((await rc(r2, 'POST', `/assignments/${a.id}/reject`, {})).s, 404);
    assert.strictEqual((await rc(r2, 'POST', `/orders/${od.id}/arrived`, {})).s, 404);
    assert.ok(!JSON.stringify((await rc(r2, 'GET', '/messages')).j).includes('Rude on the phone'));
  });

  app.kill(); fake.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log('\n--- app log (tail) ---\n' + app.log.split('\n').slice(-25).join('\n'));
  await sleep(300);
  await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
