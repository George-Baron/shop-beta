'use strict';
// Rider management: profiles, availability, consent-based GPS tracking sessions, location ingestion and freshness, the rider chat,
// performance figures, the access log for precise locations, and the live-update hub (server-sent events).
// Dispatch (who gets which order) is in dispatch.js; the admin command centre is in rider-agent.js.
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const geo = require('./geo');
const { fail, str, int } = S;

const STATUSES = ['offline', 'available', 'busy', 'on_delivery', 'unavailable'];
const VEHICLES = ['bicycle', 'motorcycle', 'tricycle', 'car', 'van', 'truck'];
const LIVE_ASSIGN = "('offered','accepted','arrived_pickup','picked_up','in_transit')";
const ACTIVE_ASSIGN = "('accepted','arrived_pickup','picked_up','in_transit')";   // the rider has taken it on
const AI_NAME = 'VELTO-MART AI Operations Manager';

/* ---------- settings (stored in the settings table, keys starting rider_) ---------- */
const DEFAULTS = {
  rider_weights: JSON.stringify({ proximity: 30, availability: 25, eta: 20, workload: 15, performance: 10 }),
  rider_dispatch_mode: 'recommend',        // manual (no AI offers) | recommend (AI ranks, an admin confirms) | auto (AI offers to the best rider)
  rider_offer_timeout_s: '120',            // how long a rider has to answer an offer
  rider_live_s: '90', rider_stale_s: '300',// a fix older than live_s is "recent", older than stale_s is "stale" and never counts as live
  rider_interval_idle_s: '60', rider_interval_assigned_s: '30', rider_interval_active_s: '15',
  rider_max_pickup_km: '25',               // riders further than this from the pickup point are not offered the order
  rider_max_accuracy_m: '200',             // fixes less accurate than this are stored but not trusted
  rider_allow_no_gps: '0',                 // 1 = riders without a usable location may still be offered orders (they score zero for distance)
  rider_bulky_qty: '8',                    // orders with more items than this need a car, van or truck
  rider_retention_days: '30',              // location history is deleted after this many days
  rider_ack_s: '180',                      // how long the AI waits for a rider's answer to a follow-up before telling the desk
  rider_overdue_grace_min: '10',           // minutes after the promised time before a delivery counts as delayed
  rider_pickup_slow_min: '30',             // minutes after acceptance with no arrival at the pickup point
  rider_confirm_policy: 'always',          // always = command-centre assignments need a confirm tap
};
const INT_KEYS = { rider_offer_timeout_s: [20, 3600], rider_live_s: [15, 900], rider_stale_s: [60, 3600], rider_interval_idle_s: [10, 600], rider_interval_assigned_s: [5, 300], rider_interval_active_s: [5, 120], rider_max_pickup_km: [1, 200], rider_max_accuracy_m: [10, 2000], rider_bulky_qty: [1, 500], rider_retention_days: [1, 365], rider_ack_s: [30, 3600], rider_overdue_grace_min: [0, 240], rider_pickup_slow_min: [5, 240] };
async function cfg() {
  const rows = await all("SELECT key, value FROM settings WHERE key LIKE 'rider\\_%'");
  const c = { ...DEFAULTS }; for (const r of rows) c[r.key] = r.value;
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = c[k];
  out.weights = parseWeights(c.rider_weights);
  for (const [k, [lo, hi]] of Object.entries(INT_KEYS)) out[k] = Math.min(hi, Math.max(lo, Number(c[k]) || Number(DEFAULTS[k])));
  return out;
}
function parseWeights(raw) {
  let w; try { w = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { w = null; }
  const keys = ['proximity', 'availability', 'eta', 'workload', 'performance'], d = JSON.parse(DEFAULTS.rider_weights), o = {};
  for (const k of keys) { const n = Number(w && w[k]); o[k] = Number.isFinite(n) && n >= 0 ? n : d[k]; }
  if (!keys.some((k) => o[k] > 0)) return d;
  return o;
}
async function saveSettings(b) {
  const out = {};
  if ('weights' in b) {
    const w = b.weights || {}, o = {};
    for (const k of ['proximity', 'availability', 'eta', 'workload', 'performance']) { const n = Number(w[k]); if (!Number.isFinite(n) || n < 0 || n > 100) fail(400, `The weight for ${k} must be a number from 0 to 100.`); o[k] = n; }
    if (!Object.values(o).some((n) => n > 0)) fail(400, 'At least one weight must be above zero.');
    out.rider_weights = JSON.stringify(o);
  }
  for (const [k, [lo, hi]] of Object.entries(INT_KEYS)) if (k in b) { const n = Number(b[k]); if (!Number.isFinite(n) || n < lo || n > hi) fail(400, `${k.replace(/^rider_/, '').replace(/_/g, ' ')} must be between ${lo} and ${hi}.`); out[k] = String(Math.round(n)); }
  if ('rider_dispatch_mode' in b) { if (!['manual', 'recommend', 'auto'].includes(b.rider_dispatch_mode)) fail(400, 'Dispatch mode must be manual, recommend or auto.'); out.rider_dispatch_mode = b.rider_dispatch_mode; }
  if ('rider_allow_no_gps' in b) out.rider_allow_no_gps = b.rider_allow_no_gps ? '1' : '0';
  if ('rider_confirm_policy' in b) { if (!['always', 'never'].includes(b.rider_confirm_policy)) fail(400, 'Confirmation policy must be always or never.'); out.rider_confirm_policy = b.rider_confirm_policy; }
  for (const [k, v] of Object.entries(out)) await run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value', k, v);
  return cfg();
}

/* ---------- live-update hub ---------- */
// Screens listen with server-sent events. Changes are written to rider_events (and positions to rider_latest_location); one poller per web instance
// reads them and passes them to the people connected to that instance, so it works with several instances and through Supabase's connection pooler.
const hub = { subs: new Set(), timer: null, lastEvent: 0, lastLoc: 0, busy: false, sent: new Map() };
async function emit(riderId, audience, kind, payload = {}) {
  try { await run('INSERT INTO rider_events (rider_id, audience, kind, payload, created_at) VALUES (?,?,?,?::jsonb,?)', riderId || null, audience, kind, JSON.stringify(payload), now()); } catch (e) { console.error('Rider event failed:', e.message); }
}
async function poll() {
  if (hub.busy || !hub.subs.size) return; hub.busy = true;
  try {
    const evs = await all('SELECT id, rider_id, audience, kind, payload FROM rider_events WHERE id>? ORDER BY id LIMIT 500', hub.lastEvent);
    for (const ev of evs) {
      hub.lastEvent = Number(ev.id);
      for (const s of hub.subs) {
        const ok = s.admin ? ev.audience !== 'rider' : (ev.audience !== 'admin' && Number(ev.rider_id) === s.riderId);
        if (ok) s.send(ev.kind, { ...ev.payload, rider_id: ev.rider_id == null ? null : Number(ev.rider_id) });
      }
    }
    if ([...hub.subs].some((s) => s.admin)) {
      const rows = await all('SELECT l.rider_id, l.latitude, l.longitude, l.accuracy, l.received_at FROM rider_latest_location l WHERE l.received_at>=? ORDER BY l.received_at LIMIT 500', hub.lastLoc);
      for (const r of rows) { hub.lastLoc = Math.max(hub.lastLoc, Number(r.received_at)); const rid = Number(r.rider_id); if (hub.sent.get(rid) === Number(r.received_at)) continue; hub.sent.set(rid, Number(r.received_at)); for (const s of hub.subs) if (s.admin) s.send('location', { rider_id: Number(r.rider_id), lat: r.latitude, lng: r.longitude, accuracy: r.accuracy, at: Number(r.received_at) }); }
    }
  } catch (e) { console.error('Rider hub poll failed:', e.message); } finally { hub.busy = false; }
}
async function subscribe(req, res, { admin, riderId }) {
  if (!hub.subs.size) { const m = await get('SELECT COALESCE(MAX(id),0) m FROM rider_events'); hub.lastEvent = Number(m.m); hub.lastLoc = now(); hub.sent.clear(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (kind, data) => { try { res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* connection closed */ } };
  const sub = { admin: !!admin, riderId: Number(riderId) || 0, send };
  hub.subs.add(sub); res.write('retry: 3000\n\n'); send('hello', { ok: true, at: now() });
  if (!hub.timer) { hub.timer = setInterval(poll, Number(process.env.RIDER_HUB_POLL_MS) || 1500); hub.timer.unref(); }
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20000); beat.unref();
  req.on('close', () => { clearInterval(beat); hub.subs.delete(sub); if (!hub.subs.size && hub.timer) { clearInterval(hub.timer); hub.timer = null; } });
}

/* ---------- profile ---------- */
const riderOfUser = (userId) => get('SELECT * FROM riders WHERE user_id=?', userId);
const riderById = (id) => get('SELECT * FROM riders WHERE id=?', id);
const riderByCode = (code) => get('SELECT * FROM riders WHERE upper(code)=upper(?)', String(code || '').trim());
// Makes sure a rider account has a profile. Called when an administrator creates a rider and when a rider signs in.
async function ensureProfile(user, extra = {}) {
  const have = await riderOfUser(user.id); if (have) return have;
  const t = now();
  await run("INSERT INTO riders (user_id, full_name, phone, email, vehicle_type, vehicle_registration, service_areas, verification_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (user_id) DO NOTHING",
    user.id, user.name, user.phone || '', user.email || '', VEHICLES.includes(extra.vehicle_type) ? extra.vehicle_type : 'motorcycle', str(extra.vehicle_registration, 30), str(extra.service_areas, 300), extra.verification_status === 'pending' ? 'pending' : 'verified', t, t);
  return riderOfUser(user.id);
}
async function updateProfile(id, b, by) {
  const r = await riderById(id); if (!r) fail(404, 'Rider not found.');
  const set = [], args = [];
  const add = (col, v) => { set.push(`${col}=?`); args.push(v); };
  if ('vehicle_type' in b) { if (!VEHICLES.includes(b.vehicle_type)) fail(400, 'Choose a vehicle type from the list.'); add('vehicle_type', b.vehicle_type); }
  if ('vehicle_registration' in b) add('vehicle_registration', str(b.vehicle_registration, 30).toUpperCase());
  if ('service_areas' in b) add('service_areas', str(b.service_areas, 300));
  if ('maximum_delivery_capacity' in b) { const n = int(b.maximum_delivery_capacity); if (n < 1 || n > 20) fail(400, 'Capacity must be from 1 to 20 deliveries at a time.'); add('maximum_delivery_capacity', n); }
  if ('verification_status' in b) { if (!['pending', 'verified', 'rejected'].includes(b.verification_status)) fail(400, 'Unknown verification status.'); add('verification_status', b.verification_status); }
  if ('profile_image' in b) { const u = String(b.profile_image || ''); if (u && !/^(\/uploads\/[A-Za-z0-9._-]+|https:\/\/[^\s"'<>]+)$/.test(u)) fail(400, 'That photo link is not valid.'); add('profile_image', u); }
  if ('full_name' in b) { const n = str(b.full_name, 80); if (n.length < 2) fail(400, 'A rider needs a name.'); add('full_name', n); await run('UPDATE users SET name=? WHERE id=?', n, r.user_id); }
  if (!set.length) return r;
  set.push('updated_at=?'); args.push(now());
  await run(`UPDATE riders SET ${set.join(', ')} WHERE id=?`, ...args, id);
  await logOps(by || 'admin', 'profile_updated', { riderId: id, detail: Object.keys(b) });
  await emit(id, 'both', 'rider_updated', {});
  return riderById(id);
}
async function suspend(id, reason, by) {
  reason = str(reason, 300); if (reason.length < 5) fail(400, 'Please write the reason for the suspension.');
  const r = await riderById(id); if (!r) fail(404, 'Rider not found.');
  if (await get(`SELECT 1 x FROM rider_assignments WHERE rider_id=? AND assignment_status IN ${ACTIVE_ASSIGN}`, id)) fail(409, 'This rider is holding a delivery. Resolve it (hand over or reassign) before suspending the account.');
  await tx(async () => {
    await endSession(id, 'suspended');
    await cancelOffers(id, 'rider_suspended');
    await run("UPDATE riders SET suspended=1, suspended_reason=?, availability_status='offline', last_status_at=?, updated_at=? WHERE id=?", reason, now(), now(), id);
    await run('UPDATE users SET active=0 WHERE id=?', r.user_id);
    await run('DELETE FROM sessions WHERE user_id=?', r.user_id);   // signed out everywhere
  });
  await logOps(by, 'suspended', { riderId: id, detail: { reason } });
  await emit(id, 'both', 'rider_updated', {});
}
async function reactivate(id, by) {
  const r = await riderById(id); if (!r) fail(404, 'Rider not found.');
  await run("UPDATE riders SET suspended=0, suspended_reason='', updated_at=? WHERE id=?", now(), id);
  await run('UPDATE users SET active=1 WHERE id=?', r.user_id);
  await logOps(by, 'reactivated', { riderId: id });
  await emit(id, 'both', 'rider_updated', {});
}

/* ---------- log ---------- */
async function logOps(actor, action, { orderId = null, riderId = null, detail = {} } = {}) {
  try { await run('INSERT INTO rider_ops_log (actor, action, order_id, rider_id, detail, created_at) VALUES (?,?,?,?,?::jsonb,?)', String(actor || 'system').slice(0, 80), action, orderId, riderId, JSON.stringify(detail || {}), now()); } catch (e) { console.error('Ops log failed:', e.message); }
}
// Records that a person looked at precise rider locations. One row per person, rider and purpose every 10 minutes, so a map that refreshes does not fill the log.
async function logAccess(user, riderId, purpose, ip) {
  try {
    const t = now();
    if (await get('SELECT 1 x FROM location_access_log WHERE viewer_id=? AND purpose=? AND rider_id IS NOT DISTINCT FROM ? AND created_at>?', user.id, purpose, riderId || null, t - 600)) return;
    await run('INSERT INTO location_access_log (viewer_id, viewer_name, rider_id, purpose, ip, created_at) VALUES (?,?,?,?,?,?)', user.id, user.name || user.email || '', riderId || null, purpose, str(ip, 60), t);
  } catch (e) { console.error('Access log failed:', e.message); }
}

/* ---------- tracking sessions, availability ---------- */
const openSession = (riderId) => get('SELECT * FROM rider_tracking_sessions WHERE rider_id=? AND ended_at IS NULL', riderId);
async function endSession(riderId, reason) {
  await run("UPDATE rider_tracking_sessions SET ended_at=?, tracking_status='ended', end_reason=? WHERE rider_id=? AND ended_at IS NULL", now(), reason || '', riderId);
  await run('DELETE FROM rider_latest_location WHERE rider_id=?', riderId);   // an offline rider has no position on the map
}
const activeCount = async (riderId) => Number((await get(`SELECT COUNT(*) n FROM rider_assignments WHERE rider_id=? AND assignment_status IN ${ACTIVE_ASSIGN}`, riderId)).n);
async function setAvail(riderId, status) {
  const r = await run('UPDATE riders SET availability_status=?, last_status_at=?, updated_at=? WHERE id=? AND availability_status<>?', status, now(), now(), riderId, status);
  if (r.changes) await emit(riderId, 'both', 'availability', { status });
}
// After an assignment changes: an available rider with work in hand shows as on delivery, and goes back to available when the work is done.
async function refreshAvailability(riderId) {
  const r = await riderById(riderId); if (!r || r.suspended) return;
  const n = await activeCount(riderId);
  if (r.availability_status === 'available' && n > 0) await setAvail(riderId, 'on_delivery');
  else if (r.availability_status === 'on_delivery' && n === 0) await setAvail(riderId, 'available');
}
async function goOnline(rider, b) {
  if (rider.suspended) fail(403, 'Your account is suspended. Contact the operations desk.');
  if (rider.verification_status !== 'verified') fail(403, 'Your account has not been verified yet. The operations desk will verify it, then you can go online.');
  if (!rider.location_consent_at && !b.consent) fail(400, 'Please read and accept the location notice first.');
  const perm = ['granted', 'denied', 'unavailable', 'gps_disabled'].includes(b.permission) ? b.permission : 'unavailable';
  const t = now();
  await tx(async () => {
    await run("UPDATE rider_tracking_sessions SET ended_at=?, tracking_status='ended', end_reason='replaced' WHERE rider_id=? AND ended_at IS NULL", t, rider.id);
    await run('INSERT INTO rider_tracking_sessions (rider_id, started_at, permission_status, tracking_status, client) VALUES (?,?,?,?,?)', rider.id, t, perm, perm === 'granted' ? 'active' : 'paused', str(b.client, 120));
    if (!rider.location_consent_at) await run('UPDATE riders SET location_consent_at=? WHERE id=?', t, rider.id);
    await run("UPDATE riders SET availability_status=CASE WHEN ?>0 THEN 'on_delivery' ELSE 'available' END, last_status_at=?, updated_at=? WHERE id=?", await activeCount(rider.id), t, t, rider.id);
  });
  await logOps('rider', 'went_online', { riderId: rider.id, detail: { permission: perm } });
  await emit(rider.id, 'both', 'availability', { status: 'available' });
  return me(rider.id);
}
// A rider with a delivery in hand cannot just disappear: they need an administrator to move the delivery first (or an admin can force them off).
async function goOffline(rider, { force = false, by = 'rider', reason = '' } = {}) {
  if (!force && (await activeCount(rider.id))) fail(409, 'You are carrying a delivery. Finish it, or ask the operations desk to take it over (use "Request assistance" in Messages) before you go offline.');
  await tx(async () => {
    await cancelOffers(rider.id, 'rider_offline');
    await endSession(rider.id, force ? 'forced_by_admin' : 'rider_offline');
    await run("UPDATE riders SET availability_status='offline', last_status_at=?, updated_at=? WHERE id=?", now(), now(), rider.id);
  });
  await logOps(by, force ? 'forced_offline' : 'went_offline', { riderId: rider.id, detail: { reason } });
  await emit(rider.id, 'both', 'availability', { status: 'offline' });
  try { await require('./dispatch').sweep(); } catch (e) { console.error('Dispatch after offline failed:', e.message); }   // tell the AI: orders waiting for a rider are looked at again
  return me(rider.id);
}
async function cancelOffers(riderId, why) {
  const rows = await all("UPDATE rider_assignments SET assignment_status='cancelled', closed_reason=? WHERE rider_id=? AND assignment_status='offered' RETURNING order_id", why, riderId);
  for (const o of rows) await run("UPDATE orders SET rider_id=NULL WHERE id=? AND rider_id=? AND accepted_at IS NULL", o.order_id, (await riderById(riderId)).user_id);
}
async function setStatus(rider, status) {
  if (rider.suspended) fail(403, 'Your account is suspended.');
  if (!['available', 'busy', 'unavailable', 'on_delivery'].includes(status)) fail(400, 'Choose Available, Busy or Temporarily unavailable. To stop working, use Go offline.');
  if (!(await openSession(rider.id))) fail(409, 'You are offline. Tap Go online first.');
  const n = await activeCount(rider.id);
  if (status === 'on_delivery' && !n) fail(409, 'You have no delivery in hand.');
  if (status === 'available' && n) status = 'on_delivery';
  await setAvail(rider.id, status);
  await logOps('rider', 'status_' + status, { riderId: rider.id });
  return me(rider.id);
}
// The rider's device reports that location permission was refused or the GPS was switched off.
async function reportPermission(rider, status) {
  if (!['granted', 'denied', 'gps_disabled', 'unavailable'].includes(status)) fail(400, 'Unknown permission status.');
  const s = await openSession(rider.id); if (!s) fail(409, 'You are offline.');
  await run('UPDATE rider_tracking_sessions SET permission_status=?, tracking_status=? WHERE id=?', status, status === 'granted' ? 'active' : 'paused', s.id);
  await emit(rider.id, 'both', 'tracking', { permission: status });
  return me(rider.id);
}

/* ---------- location ---------- */
const rad = (d) => (d * Math.PI) / 180;
const km = (a, b) => geo.haversineKm(a, b);
function intervalFor(c, assignmentStatus) {
  if (assignmentStatus === 'picked_up' || assignmentStatus === 'in_transit') return c.rider_interval_active_s;
  if (assignmentStatus === 'accepted' || assignmentStatus === 'arrived_pickup' || assignmentStatus === 'offered') return c.rider_interval_assigned_s;
  return c.rider_interval_idle_s;
}
async function ingest(rider, b) {
  const c = await cfg(), t = now();
  const s = await openSession(rider.id);
  if (!s) fail(409, 'Tracking is not active. Tap Go online to start a tracking session.');
  if (s.permission_status !== 'granted') fail(409, 'Location permission is not granted on this device.');
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) fail(400, 'That location is not valid.');
  const acc = b.accuracy == null || b.accuracy === '' ? null : Number(b.accuracy);
  if (acc !== null && (!Number.isFinite(acc) || acc < 0)) fail(400, 'Bad accuracy value.');
  let ts = Number(b.timestamp); if (!Number.isFinite(ts) || ts <= 0) ts = t; else if (ts > 1e11) ts = Math.floor(ts / 1000);   // the device sends milliseconds
  if (ts > t + 120) fail(400, 'The location time is in the future. Check the phone clock.');
  if (ts < t - 600) fail(400, 'That location is too old to use.');
  const prev = await get('SELECT * FROM rider_latest_location WHERE rider_id=?', rider.id);
  const minGap = Math.max(3, Math.floor(c.rider_interval_active_s / 3));
  if (prev && t - Number(prev.received_at) < minGap) return { ok: true, skipped: true, interval: await recommended(rider.id, c) };   // too soon: no need to store it
  let plausible = 1, why = '';
  if (acc !== null && acc > c.rider_max_accuracy_m) { plausible = 0; why = 'accuracy'; }
  if (prev && plausible) {
    const dt = Math.max(1, ts - Number(prev.location_timestamp)), d = km({ lat: prev.latitude, lng: prev.longitude }, { lat, lng }) * 1000;
    if (d > 300 && d / dt > 70) { plausible = 0; why = 'jump'; }   // more than 250 km/h between two fixes: a GPS glitch or a faked position
  }
  const sp = b.speed == null || b.speed === '' ? null : Number(b.speed), hd = b.heading == null || b.heading === '' ? null : Number(b.heading);
  const move = sp == null || !Number.isFinite(sp) ? 'unknown' : sp > 1 ? 'moving' : 'stationary';
  const live = await get(`SELECT order_id, assignment_status FROM rider_assignments WHERE rider_id=? AND assignment_status IN ${ACTIVE_ASSIGN} ORDER BY id DESC LIMIT 1`, rider.id);
  const oid = live ? live.order_id : null, vals = [lat, lng, acc, Number.isFinite(hd) ? hd : null, Number.isFinite(sp) ? sp : null, ts];
  await tx(async () => {
    await run('INSERT INTO rider_locations (rider_id, latitude, longitude, accuracy, heading, speed, location_timestamp, tracking_session_id, order_id, movement_status, plausible, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', rider.id, ...vals, s.id, oid, move, plausible, t);
    if (plausible) {
      await run(`INSERT INTO rider_latest_location (rider_id, latitude, longitude, accuracy, heading, speed, location_timestamp, received_at, tracking_session_id, order_id, movement_status, plausible)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT (rider_id) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, accuracy=excluded.accuracy, heading=excluded.heading, speed=excluded.speed,
        location_timestamp=excluded.location_timestamp, received_at=excluded.received_at, tracking_session_id=excluded.tracking_session_id, order_id=excluded.order_id, movement_status=excluded.movement_status, plausible=1`,
        rider.id, ...vals, t, s.id, oid, move);
      await run("UPDATE rider_tracking_sessions SET last_location_at=?, tracking_status='active' WHERE id=?", t, s.id);
      if (live && live.assignment_status === 'in_transit') {   // the customer's map reads rider_points, and only for their own delivery that is on the way
        const last = await get('SELECT created FROM rider_points WHERE order_id=? ORDER BY id DESC LIMIT 1', live.order_id);
        if (!last || t - Number(last.created) >= 10) await run('INSERT INTO rider_points (order_id, rider_id, lat, lng, created) VALUES (?,?,?,?,?)', live.order_id, rider.user_id, lat, lng, t);
      }
      if (oid) await run("DELETE FROM rider_followups WHERE order_id=? AND kind LIKE 'gps%'", oid);   // updates are flowing again, so a later gap is a new problem
    }
  });
  return { ok: true, accepted: !!plausible, reason: why, interval: intervalFor(c, live && live.assignment_status) };
}
async function recommended(riderId, c) {
  const live = await get(`SELECT assignment_status FROM rider_assignments WHERE rider_id=? AND assignment_status IN ${LIVE_ASSIGN} ORDER BY id DESC LIMIT 1`, riderId);
  return intervalFor(c || await cfg(), live && live.assignment_status);
}
// live | recent | stale | gps_disabled | permission_denied | offline. An old position is never shown as live.
function locationStatus(r, session, latest, c) {
  if (!session || r.availability_status === 'offline') return 'offline';
  if (session.permission_status === 'denied') return 'permission_denied';
  if (session.permission_status === 'gps_disabled' || session.permission_status === 'unavailable') return 'gps_disabled';
  if (!latest) return 'stale';
  const age = now() - Number(latest.received_at);
  return age <= c.rider_live_s ? 'live' : age <= c.rider_stale_s ? 'recent' : 'stale';
}
const LOC_LABEL = { live: 'Live', recent: 'Recently updated', stale: 'Stale location', gps_disabled: 'GPS disabled', permission_denied: 'Permission denied', offline: 'Offline' };

/* ---------- views ---------- */
async function me(riderId) {
  const c = await cfg(), r = await riderById(riderId);
  const u = await get('SELECT id, name, email, phone, coverage FROM users WHERE id=?', r.user_id);
  const s = await openSession(riderId), latest = await get('SELECT * FROM rider_latest_location WHERE rider_id=?', riderId);
  const p = await performance(riderId);
  const day = S.dayStart(now());
  const stats = await get(`SELECT
      (SELECT COUNT(*) FROM rider_assignments WHERE rider_id=? AND assignment_status='offered') AS offers,
      (SELECT COUNT(*) FROM rider_assignments WHERE rider_id=? AND assignment_status IN ('accepted','arrived_pickup')) AS accepted,
      (SELECT COUNT(*) FROM rider_assignments WHERE rider_id=? AND assignment_status IN ('picked_up','in_transit')) AS active,
      (SELECT COUNT(*) FROM rider_assignments WHERE rider_id=? AND assignment_status='delivered' AND delivered_at>=?) AS done_today,
      (SELECT COUNT(*) FROM rider_assignments WHERE rider_id=? AND assignment_status IN ('failed','cancelled','rejected','expired') AND assigned_at>=?) AS failed_today`, riderId, riderId, riderId, riderId, day, riderId, day);
  const unread = Number((await get("SELECT COUNT(*) n FROM rider_messages WHERE rider_id=? AND read_at IS NULL AND sender_kind<>'rider'", riderId)).n);
  const ls = locationStatus(r, s, latest, c);
  return {
    rider: { id: Number(r.id), code: r.code, full_name: r.full_name, profile_image: r.profile_image, phone: r.phone || u.phone, email: r.email || u.email, vehicle_type: r.vehicle_type, vehicle_registration: r.vehicle_registration, service_areas: r.service_areas, states: u.coverage, verification_status: r.verification_status, suspended: !!r.suspended, availability: r.availability_status, capacity: Number(r.maximum_delivery_capacity), consent: !!r.location_consent_at },
    tracking: { active: !!s, session_id: s ? Number(s.id) : null, permission: s ? s.permission_status : null, status: ls, label: LOC_LABEL[ls], last_fix_at: latest ? Number(latest.received_at) : null, interval_s: await recommended(riderId, c), started_at: s ? Number(s.started_at) : null },
    stats: { available_requests: Number(stats.offers), accepted: Number(stats.accepted), active: Number(stats.active), completed_today: Number(stats.done_today), failed_today: Number(stats.failed_today), earnings: null },
    performance: p, unread,
  };
}
// Everything the admin screens need about every rider (precise positions: the caller must be logistics staff, and the request is logged).
async function roster(filters = {}) {
  const c = await cfg(), t = now();
  const rows = await all(`SELECT r.*, u.coverage, u.active AS user_active, s.id AS sid, s.permission_status, s.started_at AS session_start,
      l.latitude, l.longitude, l.accuracy, l.received_at, l.heading, l.speed, l.movement_status,
      a.id AS aid, a.assignment_status, a.order_id, a.assigned_at, a.assignment_timeout_at,
      o.ref AS order_ref, o.status AS order_status, o.name AS cust_name, o.city, o.state AS ostate, o.address, o.lat AS dlat, o.lng AS dlng, o.promised_at,
      (SELECT COUNT(*) FROM rider_messages m WHERE m.rider_id=r.id AND m.read_at IS NULL AND m.sender_kind='rider') AS unread,
      (SELECT COUNT(*) FROM rider_assignments x WHERE x.rider_id=r.id AND x.assignment_status IN ${ACTIVE_ASSIGN}) AS active_n
    FROM riders r JOIN users u ON u.id=r.user_id
    LEFT JOIN rider_tracking_sessions s ON s.rider_id=r.id AND s.ended_at IS NULL
    LEFT JOIN rider_latest_location l ON l.rider_id=r.id
    LEFT JOIN LATERAL (SELECT * FROM rider_assignments WHERE rider_id=r.id AND assignment_status IN ${LIVE_ASSIGN} ORDER BY id DESC LIMIT 1) a ON TRUE
    LEFT JOIN orders o ON o.id=a.order_id ORDER BY r.id`);
  let out = rows.map((x) => {
    const latest = x.latitude == null ? null : { received_at: x.received_at }, ls = locationStatus(x, x.sid ? { permission_status: x.permission_status } : null, latest, c);
    const hasPos = x.latitude != null && (ls === 'live' || ls === 'recent' || ls === 'stale');
    const dest = x.dlat != null ? { lat: x.dlat, lng: x.dlng } : null;
    const straight = hasPos && dest ? Math.round(km({ lat: x.latitude, lng: x.longitude }, dest) * 10) / 10 : null;
    const marker = x.suspended ? 'suspended' : ls === 'stale' && x.availability_status !== 'offline' ? 'stale' : x.availability_status === 'available' && x.assignment_status === 'offered' ? 'assigned' : x.availability_status;
    return {
      id: Number(x.id), code: x.code, name: x.full_name, phone: x.phone, vehicle: x.vehicle_type, plate: x.vehicle_registration, service_areas: x.service_areas, states: x.coverage,
      availability: x.availability_status, verification: x.verification_status, suspended: !!x.suspended, capacity: Number(x.maximum_delivery_capacity), active_deliveries: Number(x.active_n), unread: Number(x.unread),
      marker, gps: ls, gps_label: LOC_LABEL[ls], gps_active: ls === 'live' || ls === 'recent',
      position: hasPos ? { lat: x.latitude, lng: x.longitude, accuracy: x.accuracy, heading: x.heading, speed: x.speed, movement: x.movement_status, at: Number(x.received_at), age_s: t - Number(x.received_at) } : null,
      assignment: x.aid ? { id: Number(x.aid), status: x.assignment_status, order_id: Number(x.order_id), order_ref: x.order_ref, order_status: x.order_status, customer: x.cust_name, destination: [x.address, x.city, x.ostate].filter(Boolean).join(', '), dest: dest, straight_km: straight, promised_at: x.promised_at ? Number(x.promised_at) : null, timeout_at: x.assignment_timeout_at ? Number(x.assignment_timeout_at) : null } : null,
    };
  });
  const f = filters;
  if (f.q) { const q = String(f.q).toLowerCase(); out = out.filter((r) => r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q) || String(r.phone).replace(/\s/g, '').includes(q.replace(/\s/g, ''))); }
  if (f.availability) out = out.filter((r) => r.availability === f.availability);
  if (f.assigned === '1') out = out.filter((r) => r.assignment && r.assignment.status === 'offered');
  if (f.gps === 'active') out = out.filter((r) => r.gps_active); else if (f.gps === 'inactive') out = out.filter((r) => !r.gps_active);
  if (f.freshness) out = out.filter((r) => r.gps === f.freshness);
  if (f.area) { const a = String(f.area).toLowerCase(); out = out.filter((r) => `${r.service_areas},${r.states}`.toLowerCase().includes(a)); }
  if (f.delivery === '1') out = out.filter((r) => r.assignment && r.assignment.status !== 'offered'); else if (f.delivery === '0') out = out.filter((r) => !r.assignment);
  if (f.order) out = out.filter((r) => r.assignment && r.assignment.order_ref === String(f.order).toUpperCase());
  return out;
}

async function performance(riderId) {
  const t = now(), week = t - 7 * 86400;
  const a = await get(`SELECT COUNT(*) total,
      COUNT(*) FILTER (WHERE accepted_at IS NOT NULL) accepted,
      COUNT(*) FILTER (WHERE assignment_status='rejected') rejected,
      COUNT(*) FILTER (WHERE assignment_status='expired') expired,
      COUNT(*) FILTER (WHERE assignment_status='delivered') completed,
      COUNT(*) FILTER (WHERE assignment_status='failed' AND excused=0) failed,
      COUNT(*) FILTER (WHERE assignment_status='failed' AND excused=1) failed_excused,
      AVG(pickup_at - accepted_at) FILTER (WHERE pickup_at IS NOT NULL AND accepted_at IS NOT NULL) avg_pickup,
      AVG(delivered_at - pickup_at) FILTER (WHERE delivered_at IS NOT NULL AND pickup_at IS NOT NULL) avg_delivery
    FROM rider_assignments WHERE rider_id=?`, riderId);
  const ot = await get(`SELECT COUNT(*) FILTER (WHERE a.delivered_at <= o.promised_at) on_time, COUNT(*) n FROM rider_assignments a JOIN orders o ON o.id=a.order_id
      WHERE a.rider_id=? AND a.assignment_status='delivered' AND o.promised_at IS NOT NULL AND a.excused=0`, riderId);
  const fb = await get('SELECT AVG(rating) avg, COUNT(rating) rated, COUNT(*) FILTER (WHERE complaint<>\'\') complaints FROM rider_feedback WHERE rider_id=?', riderId);
  const g = await get('SELECT COUNT(*) n, COUNT(*) FILTER (WHERE plausible=1) ok FROM rider_locations WHERE rider_id=? AND created_at>?', riderId, week);
  const hrs = await get('SELECT COALESCE(SUM(COALESCE(ended_at, ?) - started_at),0) s FROM rider_tracking_sessions WHERE rider_id=? AND started_at>?', t, riderId, week);
  const total = Number(a.total), done = Number(a.completed), failed = Number(a.failed), answered = Number(a.accepted) + Number(a.rejected) + Number(a.expired);
  const enough = total >= 5;
  const completion = done + failed ? done / (done + failed) : null, onTime = Number(ot.n) ? Number(ot.on_time) / Number(ot.n) : null;
  return {
    total_assignments: total, accepted: Number(a.accepted), rejected: Number(a.rejected), expired: Number(a.expired), completed: done, failed, failed_excused: Number(a.failed_excused),
    acceptance_rate: answered ? Number(a.accepted) / answered : null,
    avg_pickup_min: a.avg_pickup == null ? null : Math.round(Number(a.avg_pickup) / 6) / 10, avg_delivery_min: a.avg_delivery == null ? null : Math.round(Number(a.avg_delivery) / 6) / 10,
    on_time_pct: onTime == null ? null : Math.round(onTime * 100), completion_pct: completion == null ? null : Math.round(completion * 100),
    rating: fb.avg == null ? null : Math.round(Number(fb.avg) * 10) / 10, ratings: Number(fb.rated), complaints: Number(fb.complaints),
    gps_plausible_pct: Number(g.n) ? Math.round((Number(g.ok) / Number(g.n)) * 100) : null,
    fixes_per_online_hour: Number(hrs.s) >= 600 ? Math.round(Number(g.n) / (Number(hrs.s) / 3600)) : null,
    // 0..1 for the dispatch score; a new rider with fewer than 5 deliveries gets a neutral 0.7 instead of a guess
    score: enough ? Math.max(0, Math.min(1, 0.6 * (completion == null ? 0.7 : completion) + 0.4 * (onTime == null ? 0.7 : onTime))) : 0.7, score_basis: enough ? 'verified records' : 'new rider (fewer than 5 assignments): neutral score',
  };
}

/* ---------- chat ---------- */
async function post({ riderId, kind, senderId = null, text, orderId = null, type = 'text', attachment = '' }) {
  text = str(text, 2000); if (!text) fail(400, 'Write a message first.');
  const r = await riderById(riderId); if (!r) fail(404, 'Rider not found.');
  if (attachment && !/^(\/uploads\/[A-Za-z0-9._-]+|https:\/\/[^\s"'<>]+)$/.test(attachment)) fail(400, 'That attachment is not valid.');
  const fromRider = kind === 'rider';
  const row = await get('INSERT INTO rider_messages (rider_id, sender_id, sender_kind, recipient_id, order_id, message, message_type, attachment_url, created_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id',
    riderId, senderId, kind, fromRider ? null : r.user_id, orderId, text, type, attachment, now());
  await emit(riderId, 'both', 'message', { id: Number(row.id), from: kind });
  if (kind === 'ai' || kind === 'system') await logOps(kind, 'message', { riderId, orderId, detail: { type, text: text.slice(0, 300) } });
  return Number(row.id);
}
const aiSay = (riderId, text, orderId, type = 'instruction') => post({ riderId, kind: 'ai', text, orderId, type });
const senderName = (m) => (m.sender_kind === 'ai' ? AI_NAME : m.sender_kind === 'system' ? 'VELTO-MART system' : m.sender_kind === 'admin' ? (m.sender_name || 'Operations desk') : (m.sender_name || 'Rider'));
async function thread(riderId, { before = 0, limit = 50 } = {}) {
  limit = Math.min(100, Math.max(1, limit));
  const rows = await all(`SELECT m.*, u.name AS sender_name, o.ref AS order_ref FROM rider_messages m LEFT JOIN users u ON u.id=m.sender_id LEFT JOIN orders o ON o.id=m.order_id
    WHERE m.rider_id=? ${before ? 'AND m.id<?' : ''} ORDER BY m.id DESC LIMIT ${limit}`, riderId, ...(before ? [before] : []));
  return rows.reverse().map((m) => ({ id: Number(m.id), from: m.sender_kind, sender: senderName(m), text: m.message, type: m.message_type, order_ref: m.order_ref || '', attachment: m.attachment_url, at: Number(m.created_at), delivered: m.delivered_at != null || m.read_at != null, read: m.read_at != null }));
}
// The reader opens the thread: everything the other side sent is now read (and the sender's screen can show the read receipt).
async function markRead(riderId, side) {
  const r = await run(side === 'rider' ? "UPDATE rider_messages SET read_at=?, delivered_at=COALESCE(delivered_at,?) WHERE rider_id=? AND read_at IS NULL AND sender_kind<>'rider'" : "UPDATE rider_messages SET read_at=?, delivered_at=COALESCE(delivered_at,?) WHERE rider_id=? AND read_at IS NULL AND sender_kind='rider'", now(), now(), riderId);
  if (r.changes) await emit(riderId, 'both', 'read', { by: side });
}
async function inbox() {   // the desk: one line per rider with chat activity
  const rows = await all(`SELECT r.id, r.code, r.full_name, MAX(m.id) last_id, COUNT(*) FILTER (WHERE m.read_at IS NULL AND m.sender_kind='rider') unread
    FROM riders r JOIN rider_messages m ON m.rider_id=r.id GROUP BY r.id ORDER BY MAX(m.id) DESC LIMIT 100`);
  const out = [];
  for (const x of rows) { const m = await get('SELECT message, sender_kind, created_at FROM rider_messages WHERE id=?', x.last_id); out.push({ rider_id: Number(x.id), code: x.code, name: x.full_name, unread: Number(x.unread), last: m.message.slice(0, 80), last_from: m.sender_kind, at: Number(m.created_at) }); }
  return out;
}

/* ---------- history, feedback, upkeep ---------- */
async function history(riderId, { limit = 50 } = {}) {
  return (await all(`SELECT a.id, a.assignment_status status, a.assigned_at, a.accepted_at, a.pickup_at, a.delivered_at, a.pickup_km, a.delivery_km, a.excused, a.closed_reason, a.reject_reason, o.ref, o.city, o.state FROM rider_assignments a JOIN orders o ON o.id=a.order_id WHERE a.rider_id=? ORDER BY a.id DESC LIMIT ${Math.min(200, limit)}`, riderId))
    .map((x) => ({ ...x, id: Number(x.id), assigned_at: Number(x.assigned_at), accepted_at: x.accepted_at && Number(x.accepted_at), pickup_at: x.pickup_at && Number(x.pickup_at), delivered_at: x.delivered_at && Number(x.delivered_at) }));
}
async function addFeedback(riderId, b, by) {
  const rating = b.rating == null || b.rating === '' ? null : int(b.rating), complaint = str(b.complaint, 500);
  if (rating !== null && (rating < 1 || rating > 5)) fail(400, 'A rating is from 1 to 5.');
  if (rating === null && !complaint) fail(400, 'Give a rating or write the complaint.');
  const o = b.order_ref ? await get('SELECT id FROM orders WHERE ref=?', String(b.order_ref).toUpperCase()) : null;
  if (b.order_ref && !o) fail(404, 'That order number was not found.');
  await run('INSERT INTO rider_feedback (rider_id, order_id, rating, complaint, recorded_by, created_at) VALUES (?,?,?,?,?,?)', riderId, o ? o.id : null, rating, complaint, str(by, 80), now());
}
async function cleanup() {
  const c = await cfg(), t = now();
  await run('DELETE FROM rider_locations WHERE created_at<?', t - c.rider_retention_days * 86400);
  await run('DELETE FROM rider_events WHERE created_at<?', t - 86400);
  await run('DELETE FROM rider_ops_log WHERE created_at<?', t - 180 * 86400);
  await run('DELETE FROM location_access_log WHERE created_at<?', t - 365 * 86400);
  await run('DELETE FROM rider_followups WHERE created_at<?', t - 30 * 86400);
  await run('DELETE FROM delivery_tracking WHERE event_timestamp<?', t - 365 * 86400);
  // a session whose phone vanished (no fix for a long time) is closed, so the rider is not shown online for ever
  const dead = await all(`SELECT s.rider_id FROM rider_tracking_sessions s WHERE s.ended_at IS NULL AND COALESCE(s.last_location_at, s.started_at) < ? AND NOT EXISTS (SELECT 1 FROM rider_assignments a WHERE a.rider_id=s.rider_id AND a.assignment_status IN ${ACTIVE_ASSIGN})`, t - 6 * 3600);
  for (const d of dead) { await endSession(d.rider_id, 'inactive'); await run("UPDATE riders SET availability_status='offline', last_status_at=?, updated_at=? WHERE id=?", t, t, d.rider_id); await emit(d.rider_id, 'both', 'availability', { status: 'offline' }); }
}
// Writes a status change of a delivery, with the rider's last known position, to the history the admin can review.
async function track(orderId, riderId, status, note = '') {
  const l = riderId ? await get('SELECT latitude, longitude FROM rider_latest_location WHERE rider_id=?', riderId) : null;
  await run('INSERT INTO delivery_tracking (order_id, rider_id, latitude, longitude, delivery_status, note, event_timestamp) VALUES (?,?,?,?,?,?,?)', orderId, riderId || null, l ? l.latitude : null, l ? l.longitude : null, status, str(note, 300), now());
  await emit(riderId, 'both', 'delivery', { order_id: orderId, status });
}

module.exports = { STATUSES, VEHICLES, LIVE_ASSIGN, ACTIVE_ASSIGN, AI_NAME, DEFAULTS, cfg, saveSettings, parseWeights, subscribe, emit, riderOfUser, riderById, riderByCode, ensureProfile, updateProfile, suspend, reactivate, logOps, logAccess, openSession, endSession, setAvail, refreshAvailability, activeCount, goOnline, goOffline, setStatus, reportPermission, ingest, locationStatus, LOC_LABEL, me, roster, performance, post, aiSay, thread, markRead, inbox, history, addFeedback, cleanup, track, cancelOffers, km };
