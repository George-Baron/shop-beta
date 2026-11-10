'use strict';
// Rider screen API. A rider only ever sees orders assigned to them, and the customer's pin and phone only while the delivery is active.
const express = require('express');
const { get, all, run, tx, now } = require('../lib/db');
const S = require('../lib/shop');
const A = require('../lib/auth');
const D = require('../lib/delivery');
const { fail, int, str } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(A.requireRider);

const ACTIVE = "('paid','confirmed','processing','shipped')";
const nav = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
const osm = (lat, lng) => `https://www.openstreetmap.org/directions?route=%3B${lat}%2C${lng}`;

async function view(o) {
  const pickups = await all('SELECT op.partner_id, op.dist_km, op.eta_min, op.picked_up_at, p.name, p.address, p.phone, p.lat, p.lng FROM order_pickups op JOIN partners p ON p.id=op.partner_id WHERE op.order_id=? ORDER BY op.id', o.id);
  const items = await all('SELECT name, variant_label, qty FROM order_items WHERE order_id=? ORDER BY id', o.id);
  return {
    id: o.id, ref: o.ref, status: o.status, payment_method: o.payment_method, collect: o.payment_method === 'pod' ? o.total : 0, // cash to collect at the door
    customer: { name: o.name, phone: o.phone, address: o.address, city: o.city, state: o.state, landmark: o.landmark, lat: o.lat, lng: o.lng, nav: o.lat == null ? '' : nav(o.lat, o.lng), nav_osm: o.lat == null ? '' : osm(o.lat, o.lng) },
    pickups: pickups.map((p) => ({ partner_id: Number(p.partner_id), name: p.name, address: p.address, phone: p.phone, km: p.dist_km == null ? null : Number(p.dist_km), picked_up_at: p.picked_up_at, nav: nav(p.lat, p.lng), nav_osm: osm(p.lat, p.lng) })),
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
router.post('/orders/:id/accept', ah(async (req, res) => {
  const o = await mine(req);
  if (!['paid', 'confirmed', 'processing'].includes(o.status)) fail(409, `This order is ${o.status}.`);
  if (o.accepted_at) return res.json({ ok: true });
  await tx(async () => {
    await run("UPDATE orders SET accepted_at=?, status=CASE WHEN status IN ('paid','confirmed') THEN 'processing' ELSE status END WHERE id=?", now(), o.id);
    await S.addEvent(o.id, 'processing', `Rider ${req.user.name} accepted the delivery`);
  });
  if (o.status !== 'processing') await S.mailOrderStatus(o, 'processing', '');
  res.json({ ok: true });
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
  const r = await D.completeWithCode(int(req.params.id), req.user.id, b.code, { lat: Number(b.lat), lng: Number(b.lng) });
  if (!r.ok) return res.status(r.status || 400).json({ error: r.message, locked: !!r.locked });
  res.json({ ok: true });
}));

module.exports = router;
