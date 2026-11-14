'use strict';
// 6A delivery: quotes (distance, route, fee, ETA), one pickup leg per partner, rider flow, timers, and the handover code.
const { get, all, run, tx, now } = require('./db');
const geo = require('./geo');
const maps = require('./maps');
const handover = require('./handover');
const queue = require('./queue');
const S_ = () => require('./shop'); // loaded on first use: shop.js and this file need each other

const ACTIVE = ['paid', 'confirmed', 'dispatched'];
const str = (v, n = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, n) : '');
const coord = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
const mapped = (o) => o.dest_lat !== null && o.dest_lat !== undefined;

/* ---------------- quote ---------------- */
function problem(code, message, S, extra = {}) {
  const alternatives = [];
  if (S.pickup_address) alternatives.push({ type: 'pickup', label: 'Collect from our store', detail: S.pickup_address });
  alternatives.push({ type: 'change_location', label: 'Choose a different delivery point' });
  return { ok: false, code, message, alternatives, ...extra };
}

// One pickup per partner that has an item in the cart. Items with no partner come from the default partner.
async function partnersFor(productIds) {
  const rows = productIds.length ? await all('SELECT id, partner_id FROM products WHERE id = ANY(?::int[])', productIds) : [];
  const def = await get('SELECT * FROM partners WHERE is_default=1 AND active=1');
  const ids = new Set(); let needDefault = !rows.length;
  for (const r of rows) { if (r.partner_id) ids.add(r.partner_id); else needDefault = true; }
  const out = ids.size ? await all('SELECT * FROM partners WHERE id = ANY(?::int[])', [...ids]) : [];
  if (needDefault && def && !out.some((p) => p.id === def.id)) out.push(def);
  return { partners: out, def };
}

// Never throws for business problems: returns { ok:false, code, message, alternatives } so the page can offer another option.
async function quote({ lat, lng, state, productIds, stateFee, free }) {
  const S = await S_().getSettings();
  lat = coord(lat); lng = coord(lng);
  if (!geo.validCoord(lat, lng)) return problem('bad_point', 'Please drop a pin on the map, use your location, or search your address.', S);
  if (!geo.inNigeria(lat, lng)) return problem('outside_nigeria', 'That point is outside Nigeria. We only deliver within Nigeria. Please choose a point in Nigeria.', S);
  const { partners } = await partnersFor(productIds);
  const usable = partners.filter((p) => p.active && p.lat !== null && p.lng !== null);
  if (!usable.length || usable.length !== partners.length) return problem('no_partner', 'Delivery from our partner stores is not set up for these items yet.', S);
  const dest = { lat, lng };
  const legs = [];
  for (const p of usable) {
    const r = await maps.route({ lat: p.lat, lng: p.lng }, dest, S);
    legs.push({ partnerId: p.id, name: p.name, address: p.address, phone: p.phone, pickup: { lat: p.lat, lng: p.lng }, radius_km: p.radius_km, km: r.km, minutes: r.minutes, line: r.line, source: r.source });
  }
  const range = geo.checkRange(legs, S);
  if (!range.ok) {
    const b = range.problems[0];
    return problem('out_of_range', `Your point is ${b.km} km from ${b.name}. We deliver up to ${b.limit} km from each store.`, S, { problems: range.problems });
  }
  const covered = await get("SELECT 1 x FROM rider_states rs JOIN users u ON u.id=rs.user_id WHERE u.role='rider' AND rs.state=? LIMIT 1", state);
  if (!covered) return problem('no_rider', `We do not have a rider covering ${state} right now.`, S);
  const fee = geo.deliveryFee(stateFee, legs, S, { free });
  const eta = geo.etaMinutes(legs, S), t = now(), start = geo.startFor(t, S), r = geo.rules(S);
  return {
    ok: true, legs, distanceKm: legs.reduce((m, l) => Math.max(m, l.km), 0), ...fee, etaMinutes: eta, estimated: legs.some((l) => l.source === 'estimate'),
    deferred: start.deferred, opensAt: start.opensAt, promisedAt: start.startAt + Math.max(eta, r.promiseMin) * 60, cutoff: r.cutoff, open: r.open,
  };
}
// The shape sent to the browser (no phone numbers of partners beyond what the customer needs).
const publicQuote = (q) => (q.ok ? { ...q, legs: q.legs.map((l) => ({ name: l.name, address: l.address, pickup: l.pickup, km: l.km, minutes: l.minutes, line: l.line, source: l.source })) } : q);

/* ---------------- checkout ---------------- */
// Called by createOrder. Returns null when this order is not a mapped delivery.
async function readLocation(S, body, delivery) {
  if (S.map_checkout !== '1' || delivery === 'pickup') return null;
  const L = body.location || {};
  const lat = coord(L.lat), lng = coord(L.lng);
  const phone = str(L.phone, 30);
  if (phone && phone.replace(/\D/g, '').length < 7) S_().fail(400, 'Please enter a valid phone number for the rider to call.');
  return { lat, lng, landmark: str(L.landmark, 120), phone, text: str(L.address, 200) };
}
async function saveOrderDelivery(oid, loc, q) {
  await run('UPDATE orders SET dest_lat=?, dest_lng=?, dest_landmark=?, dest_phone=?, distance_km=?, eta_min=? WHERE id=?', loc.lat, loc.lng, loc.landmark, loc.phone, q.distanceKm, q.etaMinutes, oid);
  for (const l of q.legs) await run('INSERT INTO order_legs (order_id,partner_id,partner_name,partner_address,partner_phone,pickup_lat,pickup_lng,distance_km) VALUES (?,?,?,?,?,?,?,?)', oid, l.partnerId, l.name, l.address, l.phone, l.pickup.lat, l.pickup.lng, l.km);
}

/* ---------------- timer + code, started when paid (online) or confirmed (pay on delivery) ---------------- */
async function onStart(orderId) {
  const o = await get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o || !mapped(o) || o.started_at) return;
  const S = await S_().getSettings(), r = geo.rules(S), t = now(), start = geo.startFor(t, S);
  const c = handover.newCode(o.ref);
  await run('UPDATE orders SET started_at=?, promised_at=?, handover_nonce=?, handover_hash=? WHERE id=? AND started_at IS NULL', t, start.startAt + Math.max(o.eta_min || 0, r.promiseMin) * 60, c.nonce, c.hash, orderId);
}
const codeFor = (o) => (o.handover_hash && o.handover_nonce && !o.handover_used_at && ['paid', 'confirmed', 'dispatched'].includes(o.status) ? handover.codeFor(o.ref, o.handover_nonce) : '');

/* ---------------- views ---------------- */
function timeline(o, t = now()) {
  const stages = [
    { key: 'placed', label: 'Order placed', at: o.created },
    { key: 'paid', label: o.payment_method === 'pod' ? 'Confirmed' : 'Paid', at: o.started_at || null },
    { key: 'accepted', label: 'Accepted by rider', at: o.accepted_at || null },
    { key: 'picked_up', label: 'Picked up', at: o.picked_up_at || null },
    { key: 'on_the_way', label: 'On the way', at: o.on_the_way_at || null },
    { key: 'delivered', label: 'Delivered', at: o.delivered_at || null },
  ];
  const end = o.delivered_at || (['cancelled', 'refunded'].includes(o.status) ? null : t);
  return { stages, started_at: o.started_at || null, promised_at: o.promised_at || null, elapsed_s: o.started_at && end ? Math.max(0, end - o.started_at) : null, late: geo.isLate(o, t) || (!!o.delivered_at && !!o.promised_at && o.delivered_at > o.promised_at) };
}
const legsOf = (orderId) => all('SELECT id, partner_name, partner_address, partner_phone, pickup_lat, pickup_lng, distance_km, picked_up_at FROM order_legs WHERE order_id=? ORDER BY id', orderId);

// What the customer sees on the tracking page. The rider's position only while the delivery is on the way.
async function trackingFor(o) {
  const t = now(), out = { status: o.status, mapped: mapped(o), timeline: timeline(o, t), code: codeFor(o), locked: !!o.handover_locked, rider: null, destination: null };
  if (!mapped(o)) return out;
  const active = ACTIVE.includes(o.status);
  if (active) out.destination = { lat: o.dest_lat, lng: o.dest_lng };
  if (o.rider_id) {
    const u = await get('SELECT name FROM users WHERE id=?', o.rider_id);
    out.rider = { name: u ? u.name.split(' ')[0] : '', position: null };
    if (o.status === 'dispatched') { const p = await get('SELECT lat, lng, created FROM rider_points WHERE order_id=? ORDER BY id DESC LIMIT 1', o.id); if (p) out.rider.position = { lat: p.lat, lng: p.lng, at: p.created }; }
  }
  out.legs = (await legsOf(o.id)).map((l) => ({ name: l.partner_name, picked_up_at: l.picked_up_at }));
  if (active) out.eta_at = o.promised_at || null;
  return out;
}

// Admin view of an order: never includes the code hash; the customer pin only while the order is active.
async function adminView(o) {
  const t = now(), active = ACTIVE.includes(o.status);
  const { handover_hash, handover_nonce, ...rest } = o; // eslint-disable-line no-unused-vars
  const rider = o.rider_id ? await get('SELECT id, name, phone FROM users WHERE id=?', o.rider_id) : null;
  const v = { ...rest, rider, legs: await legsOf(o.id), timeline: timeline(o, t), has_code: !!handover_hash, audit: await all('SELECT actor, action, reason, created FROM handover_audit WHERE order_id=? ORDER BY id', o.id) };
  if (!active) { v.dest_lat = null; v.dest_lng = null; }
  return v;
}

/* ---------------- admin: assign ---------------- */
async function assign(order, riderId, actor) {
  const { fail, addEvent } = S_();
  return tx(async () => {
    const o = await get('SELECT * FROM orders WHERE id=? FOR UPDATE', order.id);
    if (!mapped(o)) fail(400, 'This order has no delivery point, so it cannot be given to a rider.');
    if (!['paid', 'confirmed'].includes(o.status) || o.on_the_way_at) fail(409, 'An order can only be given to a rider after it is paid or confirmed and before it is on the way.');
    const r = await get("SELECT u.id, u.name FROM users u JOIN rider_states rs ON rs.user_id=u.id WHERE u.id=? AND u.role='rider' AND rs.state=?", riderId, o.state);
    if (!r) fail(400, `That rider does not cover ${o.state}.`);
    await run('UPDATE orders SET rider_id=?, assigned_at=?, accepted_at=NULL WHERE id=?', r.id, now(), o.id);
    await addEvent(o.id, o.status, `Assigned to a rider by ${str(actor, 80) || 'staff'}`);
    return r;
  });
}

/* ---------------- rider flow ---------------- */
async function lockedOrder(ref, riderId) {
  const { fail } = S_();
  const o = await get('SELECT * FROM orders WHERE ref=? FOR UPDATE', str(ref, 20).toUpperCase());
  if (!o || o.rider_id !== riderId) fail(404, 'That order is not assigned to you.');
  if (!ACTIVE.includes(o.status)) fail(409, 'This order is no longer active.');
  return o;
}
async function accept(ref, riderId) {
  const { fail, addEvent } = S_();
  return tx(async () => {
    const o = await lockedOrder(ref, riderId);
    if (o.accepted_at) return o;
    if (!['paid', 'confirmed'].includes(o.status)) fail(409, 'This order cannot be accepted now.');
    await run("UPDATE orders SET accepted_at=?, status='confirmed' WHERE id=?", now(), o.id);
    if (o.status === 'paid') await addEvent(o.id, 'confirmed', 'Accepted by the rider');
    else await addEvent(o.id, 'confirmed', 'Rider accepted the delivery');
    return o;
  });
}
async function pickup(ref, riderId, legId) {
  const { fail, addEvent } = S_();
  return tx(async () => {
    const o = await lockedOrder(ref, riderId);
    if (!o.accepted_at) fail(409, 'Accept the order first.');
    const l = await get('SELECT * FROM order_legs WHERE id=? AND order_id=? FOR UPDATE', legId, o.id);
    if (!l) fail(404, 'Pickup not found.');
    if (!l.picked_up_at) {
      await run('UPDATE order_legs SET picked_up_at=? WHERE id=?', now(), l.id);
      await addEvent(o.id, o.status, `Picked up from ${l.partner_name}`);
    }
    const left = await get('SELECT COUNT(*)::int n FROM order_legs WHERE order_id=? AND picked_up_at IS NULL', o.id);
    if (!left.n && !o.picked_up_at) await run('UPDATE orders SET picked_up_at=? WHERE id=?', now(), o.id);
    return { allPickedUp: !left.n };
  });
}
async function start(ref, riderId) {
  const { fail, addEvent } = S_();
  return tx(async () => {
    const o = await lockedOrder(ref, riderId);
    if (o.status === 'dispatched') return o;
    if (!o.picked_up_at) fail(409, 'Pick up every item first.');
    await run("UPDATE orders SET status='dispatched', on_the_way_at=? WHERE id=? AND status='confirmed'", now(), o.id);
    await addEvent(o.id, 'dispatched', 'Rider is on the way');
    await queue.enqueue('order-mail', { kind: 'status', orderId: o.id, status: 'dispatched', note: '' });
    return o;
  });
}
// Rider location: only while the delivery is on the way, and at most one point per 10 seconds.
async function ping(ref, riderId, lat, lng) {
  const { fail } = S_();
  lat = coord(lat); lng = coord(lng);
  if (!geo.validCoord(lat, lng) || !geo.inNigeria(lat, lng)) fail(400, 'That location is not valid.');
  const o = await get('SELECT id, rider_id, status FROM orders WHERE ref=?', str(ref, 20).toUpperCase());
  if (!o || o.rider_id !== riderId) fail(404, 'That order is not assigned to you.');
  if (o.status !== 'dispatched') return { recorded: false };
  const last = await get('SELECT created FROM rider_points WHERE order_id=? ORDER BY id DESC LIMIT 1', o.id);
  if (last && now() - last.created < 10) return { recorded: false };
  await run('INSERT INTO rider_points (order_id,rider_id,lat,lng,created) VALUES (?,?,?,?,?)', o.id, riderId, lat, lng, now());
  return { recorded: true };
}

// Complete the delivery with the code the customer reads out. Locks after 5 wrong tries.
async function deliver(ref, riderId, code, pos) {
  const { fail, addEvent } = S_();
  const res = await tx(async () => {
    const o = await lockedOrder(ref, riderId);
    if (o.status !== 'dispatched') fail(409, 'Start the delivery first.');
    if (o.handover_used_at || !o.handover_hash) fail(409, 'This code can no longer be used.');
    if (o.handover_locked) fail(423, 'This order is locked after too many wrong codes. Please call the office: an administrator must confirm the delivery.', { locked: true });
    if (!handover.matches(o.ref, code, o.handover_hash)) {
      const left = handover.MAX_ATTEMPTS - (o.handover_attempts + 1);
      await run('UPDATE orders SET handover_attempts = handover_attempts + 1, handover_locked = ? WHERE id=?', left <= 0 ? 1 : 0, o.id);
      if (left <= 0) await addEvent(o.id, o.status, 'Handover code locked after too many wrong attempts. Admin override needed.');
      return { wrong: true, left: Math.max(0, left) };
    }
    return { o };
  });
  if (res.wrong) {
    // The attempt count must be saved even though the rider gets an error, so the failure is returned outside the transaction.
    fail(res.left ? 400 : 423, res.left ? `That code is not right. ${res.left} ${res.left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. The order is locked: call the office, an administrator must confirm the delivery.', { attemptsLeft: res.left, locked: !res.left });
  }
  return finish(res.o, { lat: pos && coord(pos.lat), lng: pos && coord(pos.lng), how: 'code' });
}
async function finish(o, { lat, lng, how, reason, actor }) {
  const { fail, addEvent } = S_();
  return tx(async () => {
    const pod = o.payment_method === 'pod';
    const hasPos = geo.validCoord(lat, lng);
    // Single use: only the call that really flips the order from dispatched to delivered gets through.
    const r = await run(`UPDATE orders SET status='delivered', delivered_at=?, handover_used_at=?, delivered_lat=?, delivered_lng=?, handover_attempts=0, handover_locked=0,
      cash_collected = CASE WHEN ? THEN total ELSE cash_collected END, payment_status = CASE WHEN ? THEN 'paid' ELSE payment_status END
      WHERE id=? AND status IN ('dispatched','confirmed','paid') AND handover_used_at IS NULL`, now(), now(), hasPos ? lat : null, hasPos ? lng : null, pod, pod, o.id);
    if (r.changes !== 1) fail(409, 'This order was already delivered or cancelled.');
    await addEvent(o.id, 'delivered', how === 'code' ? 'Delivered. Handover code confirmed.' + (pod ? ' Cash collected.' : '') : `Delivery confirmed by admin override (${str(actor, 80)}): ${reason}`);
    await queue.enqueue('order-mail', { kind: 'status', orderId: o.id, status: 'delivered', note: '' });
    return { delivered: true, cash: pod ? o.total : 0 };
  });
}

/* ---------------- admin override ---------------- */
async function override(order, actor, action, reason) {
  const { fail, addEvent } = S_();
  reason = str(reason, 300);
  if (reason.length < 8) fail(400, 'Please write the reason for this override (at least a short sentence). It is logged.');
  if (!['unlock', 'deliver'].includes(action)) fail(400, 'Unknown override.');
  return tx(async () => {
    const o = await get('SELECT * FROM orders WHERE id=? FOR UPDATE', order.id);
    if (!o || !mapped(o) || !o.handover_hash || o.handover_used_at) fail(409, 'This order has no active handover code.');
    if (!o.handover_locked) fail(409, 'The code is not locked. Overrides are only for locked orders.');
    await run('INSERT INTO handover_audit (order_id,actor,action,reason,created) VALUES (?,?,?,?,?)', o.id, str(actor, 80), action, reason, now());
    if (action === 'unlock') {
      await run('UPDATE orders SET handover_attempts=0, handover_locked=0 WHERE id=?', o.id);
      await addEvent(o.id, o.status, 'Handover code unlocked by an administrator');
      return { unlocked: true };
    }
    if (o.status !== 'dispatched') fail(409, 'The delivery has not started.');
    return finish(o, { how: 'override', reason, actor });
  });
}

// Staff cannot mark a coded order delivered by hand; it goes through the code or an override.
const needsCode = (o) => !!o.handover_hash && !o.handover_used_at;
async function onCancel(orderId) { await run("UPDATE orders SET handover_hash='', handover_nonce='' WHERE id=?", orderId); }

/* ---------------- rider screens ---------------- */
async function riderOrders(riderId) {
  const rows = await all(`SELECT * FROM orders WHERE rider_id=? AND status IN ('paid','confirmed','dispatched') ORDER BY COALESCE(promised_at, created)`, riderId);
  return Promise.all(rows.map((o) => riderSummary(o)));
}
const riderSummary = async (o) => ({ ref: o.ref, status: o.status, city: o.city, state: o.state, accepted: !!o.accepted_at, timeline: timeline(o), legs: (await legsOf(o.id)).length });
async function riderDetail(ref, riderId) {
  const { fail } = S_();
  const o = await get('SELECT * FROM orders WHERE ref=?', str(ref, 20).toUpperCase());
  if (!o || o.rider_id !== riderId) fail(404, 'That order is not assigned to you.');
  const active = ACTIVE.includes(o.status);
  const items = await all('SELECT name, variant_label, qty, emoji FROM order_items WHERE order_id=? ORDER BY id', o.id);
  const base = { ref: o.ref, status: o.status, accepted: !!o.accepted_at, picked_up: !!o.picked_up_at, items, timeline: timeline(o), payment_method: o.payment_method, locked: !!o.handover_locked, attempts: o.handover_attempts };
  if (!active) return { ...base, active: false }; // no customer location once the order is finished
  const legs = (await legsOf(o.id)).map((l) => ({ id: l.id, name: l.partner_name, address: l.partner_address, phone: l.partner_phone, picked_up_at: l.picked_up_at, lat: l.pickup_lat, lng: l.pickup_lng,
    directions: { google: geo.googleDirections(l.pickup_lat, l.pickup_lng), osm: geo.osmDirections(l.pickup_lat, l.pickup_lng) } }));
  return { ...base, active: true, legs, collect: o.payment_method === 'pod' && o.payment_status !== 'paid' ? o.total : 0,
    customer: { name: o.name, phone: o.dest_phone || o.phone, address: o.address, city: o.city, state: o.state, landmark: o.dest_landmark, lat: o.dest_lat, lng: o.dest_lng,
      directions: { google: geo.googleDirections(o.dest_lat, o.dest_lng), osm: geo.osmDirections(o.dest_lat, o.dest_lng) } } };
}

// Tracking points are deleted after 30 days (NDPA: keep personal data no longer than needed).
const POINT_DAYS = 30;
async function purge() {
  const t = now();
  return { points: (await run('DELETE FROM rider_points WHERE created < ?', t - POINT_DAYS * 86400)).changes, cache: await maps.purgeCache() };
}

module.exports = { ACTIVE, POINT_DAYS, quote, publicQuote, readLocation, saveOrderDelivery, onStart, codeFor, timeline, trackingFor, adminView, assign, accept, pickup, start, ping, deliver, override, needsCode, onCancel, riderOrders, riderDetail, purge, mapped, partnersFor };
