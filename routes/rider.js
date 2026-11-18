'use strict';
// Rider screen API. A rider only ever sees orders assigned to them, and the customer's pin and phone only while the delivery is active.
const express = require('express');
const { get, all, run, tx, now } = require('../lib/db');
const S = require('../lib/shop');
const A = require('../lib/auth');
const D = require('../lib/delivery');
const R = require('../lib/riders');
const geo = require('../lib/geo');
const DP = require('../lib/dispatch');
const CAT = require('../lib/catalog');
const { fail, int, str } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(A.requireRider);
// Every rider account has a profile (older accounts get one the first time they sign in).
router.use(ah(async (req, res, next) => { req.rider = await R.ensureProfile(req.user); next(); }));

const ACTIVE = "('paid','confirmed','processing','shipped')";
const nav = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
const osm = (lat, lng) => `https://www.openstreetmap.org/directions?route=%3B${lat}%2C${lng}`;

async function view(o) {
  const pickups = await all('SELECT op.partner_id, op.dist_km, op.eta_min, op.picked_up_at, p.name, p.address, p.phone, p.lat, p.lng FROM order_pickups op JOIN partners p ON p.id=op.partner_id WHERE op.order_id=? ORDER BY op.id', o.id);
  const items = await all('SELECT name, variant_label, qty FROM order_items WHERE order_id=? ORDER BY id', o.id);
  return {
    id: o.id, ref: o.ref, status: o.status, assignment: (await get(`SELECT assignment_status FROM rider_assignments WHERE order_id=? AND rider_id=? ORDER BY id DESC LIMIT 1`, o.id, (await R.riderOfUser(o.rider_id)).id) || {}).assignment_status || null, payment_method: o.payment_method, collect: o.payment_method === 'pod' ? o.total : 0, // cash to collect at the door
    customer: { name: o.name, phone: o.phone, address: o.address, city: o.city, state: o.state, landmark: o.landmark, lat: o.lat, lng: o.lng, nav: o.lat == null ? '' : nav(o.lat, o.lng), nav_osm: o.lat == null ? '' : osm(o.lat, o.lng) },
    pickups: pickups.map((p) => ({ partner_id: Number(p.partner_id), name: p.name, address: p.address, phone: p.phone, lat: p.lat == null ? null : Number(p.lat), lng: p.lng == null ? null : Number(p.lng), km: p.dist_km == null ? null : Number(p.dist_km), picked_up_at: p.picked_up_at, nav: nav(p.lat, p.lng), nav_osm: osm(p.lat, p.lng) })),
    pharmacy: o.is_pharmacy ? { recipient_name_required: true, temp_sensitive: !!o.temp_sensitive } : null,
    items, notes: o.notes, locked: !!o.handover_locked, attempts: o.handover_attempts,
    stages: { placed: o.created, accepted: o.accepted_at, picked_up: o.picked_up_at, on_way: o.on_way_at, delivered: o.delivered_at }, promised_at: o.promised_at, late: !!(o.promised_at && Number(o.promised_at) < now() && o.status !== 'delivered'),
  };
}
async function mine(req) {
  const o = await S.loadOrder('id=? AND rider_id=?', int(req.params.id), req.user.id);
  if (!o) fail(404, 'That order is not assigned to you.');
  return o;
}

router.get('/orders', ah(async (req, res) => {
  const rows = await all(`SELECT id FROM orders WHERE rider_id=? AND status IN ${ACTIVE} ORDER BY promised_at NULLS LAST, id`, req.user.id);
  const out = [];
  for (const r of rows) out.push(await view(await S.loadOrder('id=?', r.id)));
  res.json({ orders: out });
}));
// Recommended route from the rider's latest verified position to the next stop (the next parcel to collect, then the customer).
router.get('/orders/:id/route', ah(async (req, res) => {
  const o = await mine(req), v = await view(o);
  const next = v.pickups.find((p) => !p.picked_up_at && p.lat != null);
  const to = next ? { kind: 'pickup', name: next.name, lat: next.lat, lng: next.lng } : (o.lat != null ? { kind: 'customer', name: o.name, lat: Number(o.lat), lng: Number(o.lng) } : null);
  const l = await get('SELECT latitude, longitude, received_at FROM rider_latest_location WHERE rider_id=? AND plausible=1', req.rider.id);
  const c = await R.cfg(), fresh = l && now() - Number(l.received_at) <= c.rider_stale_s;
  const out = { to, from: fresh ? { lat: Number(l.latitude), lng: Number(l.longitude), at: Number(l.received_at) } : null };
  if (to && fresh) { const r = await geo.route(out.from, to).catch(() => null); if (r) out.route = { km: r.km, minutes: r.minutes, line: r.line, approx: !!r.approx }; }
  res.json(out);
}));
router.post('/orders/:id/accept', ah(async (req, res) => {
  const o = await mine(req);
  if (!['paid', 'confirmed', 'processing'].includes(o.status)) fail(409, `This order is ${o.status}.`);
  if (o.accepted_at) return res.json({ ok: true });
  res.json(await DP.acceptOrder(o.id, req.user.id));
}));
router.post('/orders/:id/pickup', ah(async (req, res) => {
  const o = await mine(req), pid = int(req.body.partnerId);
  if (o.status !== 'processing' || !o.accepted_at) fail(409, 'Accept the delivery first.');
  await tx(async () => {
    const r = await run('UPDATE order_pickups SET picked_up_at=? WHERE order_id=? AND partner_id=? AND picked_up_at IS NULL', now(), o.id, pid);
    if (!r.changes) fail(404, 'That pickup is not on this order, or is already collected.');
    const left = await get('SELECT COUNT(*) n FROM order_pickups WHERE order_id=? AND picked_up_at IS NULL', o.id);
    const p = await get('SELECT name FROM partners WHERE id=?', pid);
    await S.addEvent(o.id, 'processing', `Collected from ${p.name}`);
    if (!left.n) await run('UPDATE orders SET picked_up_at=? WHERE id=?', now(), o.id);
  });
  const left2 = await get('SELECT COUNT(*) n FROM order_pickups WHERE order_id=? AND picked_up_at IS NULL', o.id);
  if (!left2.n) await DP.step(o.id, req.user.id, 'picked_up', 'All parcels collected');
  res.json({ ok: true });
}));
router.post('/orders/:id/start', ah(async (req, res) => {
  const o = await mine(req);
  if (o.status !== 'processing' || !o.accepted_at) fail(409, 'Accept the delivery first.');
  if (await get('SELECT 1 x FROM order_pickups WHERE order_id=? AND picked_up_at IS NULL', o.id)) fail(409, 'Collect every parcel from its pickup point first.');
  await tx(async () => {
    await run("UPDATE orders SET status='shipped', on_way_at=?, picked_up_at=COALESCE(picked_up_at, ?) WHERE id=? AND status='processing'", now(), now(), o.id);
    await S.addEvent(o.id, 'shipped', 'On the way to you');
  });
  await DP.step(o.id, req.user.id, 'in_transit', 'On the way to the customer');
  await S.mailOrderStatus(o, 'shipped', '');
  res.json({ ok: true });
}));
// The rider app sends its position about every 15 seconds, and only while the delivery is on the way.
router.post('/orders/:id/location', A.limiter('rider-loc', 30, 60000), ah(async (req, res) => {
  const o = await mine(req), lat = Number(req.body.lat), lng = Number(req.body.lng);
  if (o.status !== 'shipped') return res.json({ ok: true, tracking: false });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'Bad location.');
  const last = await get('SELECT created FROM rider_points WHERE order_id=? ORDER BY id DESC LIMIT 1', o.id);
  if (!last || now() - Number(last.created) >= 10) await run('INSERT INTO rider_points (order_id, rider_id, lat, lng, created) VALUES (?,?,?,?,?)', o.id, req.user.id, lat, lng, now());
  res.json({ ok: true, tracking: true });
}));
router.post('/orders/:id/complete', A.limiter('rider-code', 40, 600000), ah(async (req, res) => {
  const b = req.body || {};
  const r = await D.completeWithCode(int(req.params.id), req.user.id, b.code, { lat: Number(b.lat), lng: Number(b.lng) }, String(b.recipientName || '').slice(0, 80));
  if (!r.ok) return res.status(r.status || 400).json({ error: r.message, locked: !!r.locked });
  await DP.delivered(int(req.params.id), req.rider, { proofUrl: String(b.proofImage || ''), recipient: String(b.recipientName || ''), where: { lat: Number(b.lat), lng: Number(b.lng) } });
  res.json({ ok: true });
}));

/* ================= rider dashboard (profile, availability, GPS, offers, chat) ================= */
router.get('/me', ah(async (req, res) => res.json(await R.me(req.rider.id))));
router.post('/online', A.limiter('rider-online', 30, 60000), ah(async (req, res) => res.json(await R.goOnline(req.rider, req.body || {}))));
router.post('/offline', ah(async (req, res) => res.json(await R.goOffline(req.rider))));
router.post('/status', ah(async (req, res) => res.json(await R.setStatus(req.rider, String(req.body && req.body.status || '')))));
router.post('/permission', ah(async (req, res) => res.json(await R.reportPermission(req.rider, String(req.body && req.body.status || '')))));
// Position updates from the dashboard. Only accepted inside an open, consented tracking session.
router.post('/location', A.limiter('rider-fix', 240, 60000), ah(async (req, res) => res.json(await R.ingest(req.rider, req.body || {}))));
router.get('/history', ah(async (req, res) => res.json({ history: await R.history(req.rider.id, { limit: 50 }) })));

// Offers waiting for the rider's answer. The full address and the customer's phone are shown only after the rider accepts.
router.get('/offers', ah(async (req, res) => {
  const rows = await all("SELECT a.id, a.order_id, a.assigned_at, a.assignment_timeout_at, a.pickup_km, a.delivery_km, a.eta_min FROM rider_assignments a WHERE a.rider_id=? AND a.assignment_status='offered' ORDER BY a.id", req.rider.id);
  const out = [];
  for (const a of rows) {
    const o = await S.loadOrder('id=?', a.order_id), p = await DP.pickupPoint(a.order_id); if (!o) continue;
    out.push({ id: Number(a.id), ref: o.ref, pickup: p ? { name: p.name, address: p.address } : null, deliver_to: [o.landmark, o.city, o.state].filter(Boolean).join(', '), pickup_km: a.pickup_km == null ? null : Number(a.pickup_km), delivery_km: a.delivery_km == null ? (o.dist_km == null ? null : Number(o.dist_km)) : Number(a.delivery_km), eta_min: a.eta_min,
      fee: o.delivery_fee, collect: o.payment_method === 'pod' ? o.total : 0, package: o.items.map((i) => `${i.qty} × ${i.name}`), notes: o.notes || '', pharmacy: !!o.is_pharmacy, offered_at: Number(a.assigned_at), timeout_at: a.assignment_timeout_at ? Number(a.assignment_timeout_at) : null });
  }
  res.json({ offers: out, now: now() });
}));
router.post('/assignments/:id/accept', A.limiter('rider-accept', 60, 60000), ah(async (req, res) => res.json(await DP.accept(int(req.params.id), req.user.id))));
router.post('/assignments/:id/reject', ah(async (req, res) => res.json(await DP.reject(int(req.params.id), req.user.id, req.body && req.body.reason))));
router.post('/orders/:id/arrived', ah(async (req, res) => { await mine(req); res.json(await DP.arrived(int(req.params.id), req.rider)); }));
router.post('/orders/:id/report', A.limiter('rider-report', 30, 600000), ah(async (req, res) => { await mine(req); res.json(await DP.report(int(req.params.id), req.rider, String(req.body && req.body.type || ''), req.body && req.body.note)); }));

// Chat with the operations desk and the AI Operations Manager.
router.get('/messages', ah(async (req, res) => { const m = await R.thread(req.rider.id, { before: int(req.query.before) }); await R.markRead(req.rider.id, 'rider'); res.json({ messages: m, ai_name: R.AI_NAME }); }));
router.post('/messages', A.limiter('rider-msg', 60, 60000), ah(async (req, res) => {
  const b = req.body || {}, oid = b.orderId ? int(b.orderId) : null;
  if (oid && !(await get('SELECT 1 x FROM rider_assignments WHERE order_id=? AND rider_id=?', oid, req.rider.id))) fail(404, 'That order is not one of yours.');
  res.json({ ok: true, id: await R.post({ riderId: req.rider.id, kind: 'rider', senderId: req.user.id, text: b.text, orderId: oid, type: b.attachment ? 'image' : 'text', attachment: str(b.attachment, 300) }) });
}));
router.post('/messages/read', ah(async (req, res) => { await R.markRead(req.rider.id, 'rider'); res.json({ ok: true }); }));
// Photos: chat images, delivery proof, the rider's own profile picture.
router.post('/photo', A.limiter('rider-photo', 30, 600000), express.json({ limit: '4mb' }), ah(async (req, res) => {
  const url = await CAT.putImage(req.body && req.body.data);
  if (req.body.profile) await run('UPDATE riders SET profile_image=?, updated_at=? WHERE id=?', url, now(), req.rider.id);
  res.json({ url });
}));
// Live updates (server-sent events) for this rider only.
router.get('/stream', ah(async (req, res) => R.subscribe(req, res, { riderId: req.rider.id })));

module.exports = router;
