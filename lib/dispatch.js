'use strict';
// Dispatch: who should carry an order, offers and their answers, the delivery steps, and the follow-up/escalation watcher.
//   rank(orderId)        who is eligible, who is not and why, and a score for each eligible rider
//   offer(...)           one live assignment per order, enforced by a unique index; the rider must accept within the timeout
//   accept / reject      atomic: the order row is locked, so two riders can never both win the same delivery
//   watch()              runs every 30 s: expires unanswered offers, follows up on silent GPS, late deliveries and slow pickups
//   sweep()              runs every 60 s: orders that are ready and have no rider are ranked, then offered or recommended per the dispatch mode
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const geo = require('./geo');
const R = require('./riders');
const { fail, str } = S;

const READY = ['paid', 'confirmed', 'processing'];          // an order can be dispatched once it is paid or confirmed
const readySql = `o.status IN ('paid','confirmed','processing') AND o.delivery NOT IN ('pickup','international') AND o.rider_id IS NULL AND o.accepted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM rider_assignments a WHERE a.order_id=o.id AND a.assignment_status IN ${R.LIVE_ASSIGN})`;
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const round1 = (n) => Math.round(n * 10) / 10;
const notifyDesk = (n) => require('./notify').toStaff('delivery', true, { type: 'rider', link: '/admin#/riders', ...n });
// True the first time (order, kind) is recorded: lets the AI say each thing once.
async function once(orderId, kind) { const r = await get('INSERT INTO rider_followups (order_id, kind, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING created_at', orderId, kind, now()); return !!r; }
const followupAt = async (orderId, kind) => { const r = await get('SELECT created_at FROM rider_followups WHERE order_id=? AND kind=?', orderId, kind); return r ? Number(r.created_at) : 0; };

/* ---------- where the goods are collected ---------- */
async function pickupPoint(orderId) {
  return (await get('SELECT p.* FROM order_pickups op JOIN partners p ON p.id=op.partner_id WHERE op.order_id=? AND op.picked_up_at IS NULL ORDER BY op.id LIMIT 1', orderId))
    || (await get('SELECT * FROM partners WHERE active=1 AND is_default=1 ORDER BY id LIMIT 1')) || (await get('SELECT * FROM partners WHERE active=1 ORDER BY id LIMIT 1')) || null;
}
const areaMatch = (areas, order) => { const list = String(areas || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); if (!list.length) return true; const hay = `${order.address} ${order.city} ${order.state} ${order.landmark}`.toLowerCase(); return list.some((a) => hay.includes(a)); };
const stateMatch = (cov, order) => { const list = String(cov || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); return !list.length || list.includes(String(order.state || '').trim().toLowerCase()); };

/* ---------- ranking ---------- */
// Returns { order, pickup, ranking: [...best first], excluded: [{ id, code, name, reasons }] }. Reads only; offers nothing.
async function rank(orderId, { exclude = [] } = {}) {
  const c = await R.cfg(), t = now();
  const order = await S.loadOrder('id=?', orderId); if (!order) fail(404, 'Order not found.');
  const pickup = await pickupPoint(orderId);
  const cust = order.lat != null && order.lng != null ? { lat: Number(order.lat), lng: Number(order.lng) } : null;
  const declined = new Set((await all("SELECT rider_id FROM rider_assignments WHERE order_id=? AND assignment_status IN ('rejected','expired')", orderId)).map((x) => Number(x.rider_id)));
  const rows = await all(`SELECT r.*, u.coverage, u.active AS user_active, s.id AS sid, s.permission_status, l.latitude, l.longitude, l.received_at, l.accuracy,
      (SELECT COUNT(*) FROM rider_assignments a WHERE a.rider_id=r.id AND a.assignment_status IN ${R.LIVE_ASSIGN}) AS live_n
    FROM riders r JOIN users u ON u.id=r.user_id LEFT JOIN rider_tracking_sessions s ON s.rider_id=r.id AND s.ended_at IS NULL LEFT JOIN rider_latest_location l ON l.rider_id=r.id ORDER BY r.id`);
  const qty = order.items.reduce((n, i) => n + Number(i.qty || 0), 0), bulky = qty > c.rider_bulky_qty;
  const excluded = [], pool = [];
  for (const x of rows) {
    const why = [];
    if (x.suspended || !x.user_active) why.push('suspended');
    if (x.verification_status !== 'verified') why.push('not verified');
    if (!['available', 'on_delivery'].includes(x.availability_status)) why.push(x.availability_status === 'offline' ? 'offline' : x.availability_status.replace('_', ' '));
    if (Number(x.live_n) >= Number(x.maximum_delivery_capacity)) why.push('at delivery capacity');
    if (declined.has(Number(x.id)) || exclude.includes(Number(x.id))) why.push('already declined or missed this order');
    if (!stateMatch(x.coverage, order)) why.push('does not cover ' + (order.state || 'this state'));
    if (!areaMatch(x.service_areas, order)) why.push('outside service area');
    if (bulky && !['car', 'van', 'truck'].includes(x.vehicle_type)) why.push('vehicle too small for a large order');
    if (order.is_pharmacy) { try { await require('./pharmacy').checkRider(order, x.user_id); } catch (e) { why.push(e.message || 'not allowed for medicines'); } }
    const age = x.received_at == null ? null : t - Number(x.received_at);
    const noGps = !x.sid || x.permission_status !== 'granted' || age == null || age > c.rider_stale_s;
    if (noGps && c.rider_allow_no_gps !== '1') why.push(!x.sid ? 'no tracking session' : x.permission_status !== 'granted' ? 'location permission ' + x.permission_status : age == null ? 'no location yet' : 'location is stale');
    if (!noGps && pickup && geo.haversineKm({ lat: x.latitude, lng: x.longitude }, { lat: Number(pickup.lat), lng: Number(pickup.lng) }) > c.rider_max_pickup_km) why.push(`more than ${c.rider_max_pickup_km} km from the pickup point`);
    if (why.length) excluded.push({ id: Number(x.id), code: x.code, name: x.full_name, reasons: why }); else pool.push({ x, age, noGps });
  }
  // Road distance and time for the closest few; the rest get a straight-line estimate marked approximate. Straight-line is never the only basis where routing works.
  for (const p of pool) p.line = !p.noGps && pickup ? geo.haversineKm({ lat: p.x.latitude, lng: p.x.longitude }, { lat: Number(pickup.lat), lng: Number(pickup.lng) }) : null;
  pool.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));
  let leg = null;
  if (pickup && cust) leg = await geo.route({ lat: Number(pickup.lat), lng: Number(pickup.lng) }, cust);
  else if (order.dist_km != null) leg = { km: Number(order.dist_km), minutes: Number(order.eta_min) || Math.round(Number(order.dist_km) * 2.5), approx: true };
  const w = c.weights, wsum = w.proximity + w.availability + w.eta + w.workload + w.performance;
  const ranking = [];
  for (let i = 0; i < pool.length; i++) {
    const { x, age, noGps } = pool[i];
    let pk = null, pm = null, approx = false;
    if (!noGps && pickup) {
      if (i < 6) { const r = await geo.route({ lat: x.latitude, lng: x.longitude }, { lat: Number(pickup.lat), lng: Number(pickup.lng) }); pk = r.km; pm = r.minutes; approx = !!r.approx; }
      else { pk = round1(pool[i].line * 1.3); pm = Math.round((pk / 25) * 60); approx = true; }
    }
    const perf = await R.performance(x.id), n = Number(x.live_n), cap = Number(x.maximum_delivery_capacity);
    const parts = {
      proximity: pk == null ? 0 : clamp01(1 - pk / c.rider_max_pickup_km),
      availability: x.availability_status === 'available' && n === 0 ? 1 : 0.5,
      eta: pm == null ? 0 : clamp01(1 - (pm + (leg ? leg.minutes : 0)) / 120),
      workload: clamp01(1 - n / cap),
      performance: perf.score,
    };
    const score = Math.round(((parts.proximity * w.proximity + parts.availability * w.availability + parts.eta * w.eta + parts.workload * w.workload + parts.performance * w.performance) / wsum) * 1000) / 10;
    ranking.push({ rider_id: Number(x.id), user_id: Number(x.user_id), code: x.code, name: x.full_name, vehicle: x.vehicle_type, availability: x.availability_status, score, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100)])),
      pickup_km: pk, pickup_min: pm, delivery_km: leg ? leg.km : null, delivery_min: leg ? leg.minutes : null, total_min: pm != null && leg ? pm + leg.minutes : null, active_deliveries: n, capacity: cap, location_age_s: age, approx: approx || !!(leg && leg.approx), has_location: !noGps, score_basis: perf.score_basis });
  }
  ranking.sort((a, b) => b.score - a.score || (a.pickup_km ?? 1e9) - (b.pickup_km ?? 1e9));
  return { order: { id: Number(order.id), ref: order.ref, status: order.status, city: order.city, state: order.state, has_pin: !!cust }, pickup: pickup ? { id: Number(pickup.id), name: pickup.name, address: pickup.address } : null, ranking, excluded, weights: w };
}

/* ---------- offers ---------- */
function offerText(order, pickup, rk, c) {
  const items = order.items.slice(0, 3).map((i) => `${i.qty} × ${i.name}`).join(', ') + (order.items.length > 3 ? ` and ${order.items.length - 3} more` : '');
  return `New delivery request ${order.ref}. Pick up at ${pickup ? pickup.name : 'the store'}${rk && rk.pickup_km != null ? ` (about ${rk.pickup_km} km from you)` : ''}, deliver in ${[order.city, order.state].filter(Boolean).join(', ') || 'the customer area'}${rk && rk.delivery_km != null ? ` (about ${rk.delivery_km} km)` : ''}. Delivery fee ${S.naira(order.delivery_fee)}. Package: ${items}.${order.notes ? ' Customer note: ' + order.notes : ''} Please accept or reject within ${Math.round(c.rider_offer_timeout_s / 60 * 10) / 10} minutes.`;
}
// by: 'ai' (the dispatcher; the rider must be eligible), 'admin' (a person chose; availability rules are relaxed, never verification, suspension or capacity).
async function offer(orderId, riderId, { by = 'ai', actor = '', actorId = null, rk = null } = {}) {
  const c = await R.cfg(), t = now();
  let created;
  try {
    created = await tx(async () => {
      const order = await get('SELECT * FROM orders WHERE id=? FOR UPDATE', orderId);
      if (!order) fail(404, 'Order not found.');
      if (!READY.includes(order.status) || order.delivery === 'pickup') fail(409, order.status === 'pending' ? 'Wait until the order is paid or confirmed before assigning a rider.' : `This order is ${order.delivery === 'pickup' ? 'a store pickup' : order.status}; it cannot be given to a rider.`);
      if (order.rider_id || order.accepted_at) fail(409, 'This order already has a rider.');
      const rider = await get('SELECT r.*, u.active AS ua FROM riders r JOIN users u ON u.id=r.user_id WHERE r.id=? FOR UPDATE OF r', riderId);
      if (!rider) fail(404, 'Rider not found.');
      if (rider.suspended || !rider.ua) fail(409, 'This rider is suspended.');
      if (rider.verification_status !== 'verified') fail(409, 'This rider has not been verified.');
      if (by === 'ai' && rider.availability_status === 'offline') fail(409, 'This rider is offline.');
      if (by === 'ai' && !['available', 'on_delivery'].includes(rider.availability_status)) fail(409, 'This rider is not available.');
      if (Number((await get(`SELECT COUNT(*) n FROM rider_assignments WHERE rider_id=? AND assignment_status IN ${R.LIVE_ASSIGN}`, riderId)).n) >= Number(rider.maximum_delivery_capacity)) fail(409, 'This rider is at delivery capacity.');
      const live = await get(`SELECT id, assignment_status FROM rider_assignments WHERE order_id=? AND assignment_status IN ${R.LIVE_ASSIGN}`, orderId);
      if (live) { if (live.assignment_status !== 'offered' || by === 'ai') fail(409, 'This order already has a rider or a pending offer.'); await run("UPDATE rider_assignments SET assignment_status='cancelled', closed_reason='replaced_by_admin' WHERE id=?", live.id); }
      const a = await get(`INSERT INTO rider_assignments (rider_id, order_id, assignment_status, offered_by, assigned_at, assignment_timeout_at, score, score_detail, pickup_km, delivery_km, eta_min)
        VALUES (?,?,'offered',?,?,?,?,?::jsonb,?,?,?) RETURNING id`, riderId, orderId, by, t, rider.availability_status === 'offline' ? null : t + c.rider_offer_timeout_s, rk ? rk.score : null, JSON.stringify(rk || {}), rk ? rk.pickup_km : null, rk ? rk.delivery_km : null, rk ? rk.total_min : null);
      await S.addEvent(orderId, order.status, `Offered to rider ${rider.full_name} (${rider.code}) by ${by === 'ai' ? R.AI_NAME : actor || 'an administrator'}`, { internal: true });
      return { id: Number(a.id), order, rider };
    });
  } catch (e) { if (e && e.code === '23505') fail(409, 'Another rider or offer already holds this order.'); throw e; }
  const full = await S.loadOrder('id=?', orderId), pickup = await pickupPoint(orderId);
  await R.post({ riderId, kind: by === 'ai' ? 'ai' : 'admin', senderId: by === 'ai' ? null : actorId, text: offerText(full, pickup, rk, c), orderId, type: 'assignment' });
  await R.emit(riderId, 'both', 'offer', { assignment_id: created.id, order_id: orderId });
  await R.logOps(by === 'ai' ? 'ai' : actor || 'admin', 'offer', { orderId, riderId, detail: { assignment: created.id, score: rk && rk.score, parts: rk && rk.parts } });
  return created.id;
}
// An unanswered or rejected offer is released and the order goes back to the ranking, minus the riders who already declined it.
async function afterRelease(orderId) {
  try { await dispatchOrder(orderId); } catch (e) { console.error('Re-dispatch failed:', e.message); }
}
async function dispatchOrder(orderId, { force = false } = {}) {
  const c = await R.cfg();
  if (c.rider_dispatch_mode === 'manual' && !force) return { ok: false, mode: 'manual' };
  if (!(await get(`SELECT 1 x FROM orders o WHERE o.id=? AND ${readySql}`, orderId))) return { ok: false, reason: 'not_ready' };
  const r = await rank(orderId);
  if (!r.ranking.length) {
    if (await once(orderId, 'no_rider:' + Math.floor(now() / 3600))) {   // tell the desk once an hour, and keep looking meanwhile
      await notifyDesk({ title: `No rider available for order ${r.order.ref}`, body: `The order is waiting. ${r.excluded.length} riders were checked; none is eligible (e.g. ${(r.excluded[0] && r.excluded[0].reasons[0]) || 'no riders registered'}). It will be offered as soon as one is.` });
      await R.logOps('ai', 'no_eligible_rider', { orderId, detail: { excluded: r.excluded.slice(0, 10) } });
    }
    return { ok: false, reason: 'no_eligible_rider', excluded: r.excluded };
  }
  const top = r.ranking[0];
  if (c.rider_dispatch_mode === 'auto') {
    try { const id = await offer(orderId, top.rider_id, { by: 'ai', rk: top }); return { ok: true, offered: true, assignment_id: id, rider: top }; }
    catch (e) { if (e.status === 409) return { ok: false, reason: 'conflict', message: e.message }; throw e; }
  }
  if (await once(orderId, 'recommend:' + top.rider_id)) {
    await notifyDesk({ title: `Recommended rider for ${r.order.ref}: ${top.name}`, body: `${top.code} scores ${top.score}/100${top.pickup_km != null ? `, ${top.pickup_km} km from pickup` : ''}. Open Riders to assign.` });
    await R.logOps('ai', 'recommend', { orderId, riderId: top.rider_id, detail: { score: top.score, parts: top.parts } });
  }
  return { ok: true, offered: false, recommended: top };
}
async function sweep() {
  const c = await R.cfg(); if (c.rider_dispatch_mode === 'manual') return 0;
  const orders = await all(`SELECT o.id FROM orders o WHERE ${readySql} ORDER BY o.promised_at NULLS LAST, o.id LIMIT 25`);
  for (const o of orders) { try { await dispatchOrder(Number(o.id)); } catch (e) { console.error('Dispatch of order', o.id, 'failed:', e.message); } }
  return orders.length;
}

/* ---------- the rider's answers ---------- */
async function mineLive(id, userId) {
  const a = await get('SELECT a.*, r.user_id, r.full_name, r.code FROM rider_assignments a JOIN riders r ON r.id=a.rider_id WHERE a.id=?', id);
  if (!a || Number(a.user_id) !== Number(userId)) fail(404, 'That delivery request is not yours.');
  return a;
}
async function accept(assignmentId, userId) {
  const t = now();
  const res = await tx(async () => {
    const a0 = await mineLive(assignmentId, userId);
    const a = await get('SELECT * FROM rider_assignments WHERE id=? FOR UPDATE', assignmentId);
    if (a.assignment_status === 'accepted') return { again: true, a, order: await get('SELECT * FROM orders WHERE id=?', a.order_id) };
    if (a.assignment_status !== 'offered') fail(409, a.assignment_status === 'expired' ? 'This request timed out and was given to someone else.' : `This request is ${a.assignment_status}.`);
    if (a.assignment_timeout_at && Number(a.assignment_timeout_at) < t) { await run("UPDATE rider_assignments SET assignment_status='expired', closed_reason='timeout' WHERE id=?", a.id); return { expired: true, a }; }
    const order = await get('SELECT * FROM orders WHERE id=? FOR UPDATE', a.order_id);
    if (!order || !READY.includes(order.status)) { await run("UPDATE rider_assignments SET assignment_status='cancelled', closed_reason='order_changed' WHERE id=?", a.id); return { gone: true, a }; }
    if (order.rider_id && Number(order.rider_id) !== Number(userId)) { await run("UPDATE rider_assignments SET assignment_status='cancelled', closed_reason='taken' WHERE id=?", a.id); return { gone: true, a }; }
    const cap = await get('SELECT maximum_delivery_capacity cap, suspended FROM riders WHERE id=?', a.rider_id);
    if (cap.suspended) fail(403, 'Your account is suspended.');
    if (Number((await get(`SELECT COUNT(*) n FROM rider_assignments WHERE rider_id=? AND assignment_status IN ${R.ACTIVE_ASSIGN}`, a.rider_id)).n) >= Number(cap.cap)) fail(409, 'You are at your delivery limit. Finish a delivery first.');
    await run("UPDATE rider_assignments SET assignment_status='accepted', accepted_at=? WHERE id=?", t, a.id);
    await run("UPDATE orders SET rider_id=?, accepted_at=?, status=CASE WHEN status IN ('paid','confirmed') THEN 'processing' ELSE status END WHERE id=?", userId, t, order.id);
    await S.addEvent(order.id, 'processing', `Rider ${a0.full_name} accepted the delivery`);
    return { a, order, first: order.status !== 'processing' };
  });
  if (res.expired) { await R.emit(res.a.rider_id, 'both', 'offer_closed', { assignment_id: Number(res.a.id) }); await afterRelease(res.a.order_id); fail(409, 'This request timed out and was given to someone else.'); }
  if (res.gone) { await R.emit(res.a.rider_id, 'both', 'offer_closed', { assignment_id: Number(res.a.id) }); fail(409, 'This delivery is no longer available.'); }
  if (!res.again) {
    await R.refreshAvailability(res.a.rider_id);
    await R.track(res.a.order_id, res.a.rider_id, 'accepted');
    await R.logOps('rider', 'accepted', { orderId: res.a.order_id, riderId: res.a.rider_id });
    await R.post({ riderId: res.a.rider_id, kind: 'rider', senderId: userId, text: `Accepted delivery ${await refOf(res.a.order_id)}.`, orderId: res.a.order_id, type: 'response' });
    await R.aiSay(res.a.rider_id, `Thank you. ${await refOf(res.a.order_id)} is yours. Head to the pickup point, then tap "Arrived at pickup". I have told the warehouse.`, res.a.order_id, 'instruction');
    await notifyDesk({ title: `${(await R.riderById(res.a.rider_id)).full_name} accepted order ${await refOf(res.a.order_id)}`, body: 'The warehouse can prepare the parcel for collection.' });
    if (res.first) { const o = await S.loadOrder('id=?', res.a.order_id); await S.mailOrderStatus(o, 'processing', ''); }
    await R.emit(res.a.rider_id, 'both', 'assignment', { order_id: Number(res.a.order_id), status: 'accepted' });
  }
  return { ok: true };
}
const refOf = async (orderId) => (await get('SELECT ref FROM orders WHERE id=?', orderId)).ref;
async function reject(assignmentId, userId, reason) {
  reason = str(reason, 200);
  const a = await mineLive(assignmentId, userId);
  const r = await run("UPDATE rider_assignments SET assignment_status='rejected', rejected_at=?, reject_reason=? WHERE id=? AND assignment_status='offered'", now(), reason, assignmentId);
  if (!r.changes) fail(409, `This request is ${a.assignment_status}.`);
  await run('UPDATE orders SET rider_id=NULL WHERE id=? AND rider_id=? AND accepted_at IS NULL', a.order_id, userId);   // a manually assigned order goes back to the pool
  const ref = await refOf(a.order_id);
  await R.logOps('rider', 'rejected', { orderId: a.order_id, riderId: a.rider_id, detail: { reason } });
  await R.post({ riderId: a.rider_id, kind: 'rider', senderId: userId, text: `Rejected delivery ${ref}${reason ? ': ' + reason : '.'}`, orderId: a.order_id, type: 'response' });
  await S.addEvent(a.order_id, (await get('SELECT status FROM orders WHERE id=?', a.order_id)).status, `Rider ${a.full_name} declined the delivery`, { internal: true });
  await R.emit(a.rider_id, 'both', 'offer_closed', { assignment_id: Number(a.id) });
  await afterRelease(a.order_id);
  return { ok: true };
}
async function expireOffers() {
  const t = now();
  const rows = await all("UPDATE rider_assignments SET assignment_status='expired', closed_reason='timeout' WHERE assignment_status='offered' AND assignment_timeout_at IS NOT NULL AND assignment_timeout_at<? RETURNING id, rider_id, order_id", t);
  for (const a of rows) {
    const rd = await R.riderById(a.rider_id), ref = await refOf(a.order_id);
    await run('UPDATE orders SET rider_id=NULL WHERE id=? AND rider_id=? AND accepted_at IS NULL', a.order_id, rd.user_id);
    await R.logOps('ai', 'offer_expired', { orderId: a.order_id, riderId: a.rider_id });
    await R.aiSay(a.rider_id, `The request for ${ref} timed out and was offered to someone else.`, a.order_id, 'reminder');
    await R.emit(a.rider_id, 'both', 'offer_closed', { assignment_id: Number(a.id) });
    await S.addEvent(a.order_id, (await get('SELECT status FROM orders WHERE id=?', a.order_id)).status, `Rider ${rd.full_name} did not answer in time`, { internal: true });
    await afterRelease(a.order_id);
  }
  return rows.length;
}

/* ---------- admin: manual assignment and releasing a delivery ---------- */
async function manualAssign(orderId, riderUserId, actor, actorId = null) {
  if (!riderUserId) return unassign(orderId, actor);
  const rd = await R.riderOfUser(riderUserId); if (!rd) fail(400, 'Choose an active rider.');
  const prev = await get('SELECT rider_id FROM orders WHERE id=? AND accepted_at IS NULL', orderId);
  if (prev && prev.rider_id) await run('UPDATE orders SET rider_id=NULL WHERE id=?', orderId);   // a not-yet-accepted rider is replaced
  try { return await offer(orderId, rd.id, { by: 'admin', actor, actorId }); }
  catch (e) { if (prev && prev.rider_id) await run('UPDATE orders SET rider_id=? WHERE id=? AND rider_id IS NULL', prev.rider_id, orderId); throw e; }
}
async function unassign(orderId, actor) {
  const live = await get(`SELECT * FROM rider_assignments WHERE order_id=? AND assignment_status IN ${R.LIVE_ASSIGN}`, orderId);
  if (!live) { await run("UPDATE orders SET rider_id=NULL, accepted_at=NULL WHERE id=? AND status<>'shipped'", orderId); return null; }
  if (['picked_up', 'in_transit'].includes(live.assignment_status)) fail(409, 'The rider already has the parcel. Use "Take delivery back" and confirm where the parcel is.');
  await run("UPDATE rider_assignments SET assignment_status='cancelled', closed_reason='removed_by_admin' WHERE id=?", live.id);
  await run("UPDATE orders SET rider_id=NULL, accepted_at=NULL WHERE id=? AND status<>'shipped'", orderId);
  await S.addEvent(orderId, (await get('SELECT status FROM orders WHERE id=?', orderId)).status, 'Rider removed', { internal: true });
  await R.refreshAvailability(live.rider_id); await R.emit(live.rider_id, 'both', 'offer_closed', { assignment_id: Number(live.id) });
  await R.logOps(actor, 'unassigned', { orderId, riderId: live.rider_id });
  return live.id;
}
// Take a delivery back from a rider (cannot reach them, breakdown, ...). If the rider already collected the parcel, the administrator must confirm
// where the parcel is (custody) first; the order then goes back into the queue for a new rider.
async function release(assignmentId, { custody, reason, excused = false, outcome = 'reassigned', actor = 'admin' }) {
  reason = str(reason, 300); if (reason.length < 5) fail(400, 'Write the reason (at least 5 characters). It is saved on the order.');
  if (!['reassigned', 'failed'].includes(outcome)) fail(400, 'Unknown outcome.');
  const a = await get('SELECT a.*, r.user_id, r.full_name FROM rider_assignments a JOIN riders r ON r.id=a.rider_id WHERE a.id=?', assignmentId);
  if (!a) fail(404, 'Assignment not found.');
  const held = ['picked_up', 'in_transit'].includes(a.assignment_status);
  if (!R.ACTIVE_ASSIGN.includes(a.assignment_status) && a.assignment_status !== 'offered') fail(409, `This assignment is already ${a.assignment_status}.`);
  if (held && !['returned_to_store', 'with_new_rider', 'lost'].includes(custody)) fail(409, 'The rider has collected the parcel. Say where it is now: returned to the store, handed to a new rider, or lost.');
  await tx(async () => {
    await run("UPDATE rider_assignments SET assignment_status=?, closed_reason=?, excused=? WHERE id=?", outcome, `${reason}${held ? ' [custody: ' + custody + ']' : ''}`.slice(0, 300), excused ? 1 : 0, a.id);
    const o = await get('SELECT status FROM orders WHERE id=? FOR UPDATE', a.order_id);
    if (o && !['delivered', 'cancelled', 'refunded'].includes(o.status)) {
      await run("UPDATE orders SET rider_id=NULL, accepted_at=NULL, picked_up_at=NULL, on_way_at=NULL, status=CASE WHEN status='shipped' THEN 'processing' ELSE status END WHERE id=?", a.order_id);
      if (held && custody === 'returned_to_store') await run('UPDATE order_pickups SET picked_up_at=NULL WHERE order_id=?', a.order_id);
      await S.addEvent(a.order_id, o.status === 'shipped' ? 'processing' : o.status, `Delivery taken back from rider ${a.full_name} by ${actor}: ${reason}${held ? ` (parcel: ${custody.replace(/_/g, ' ')})` : ''}`, { internal: true });
    }
  });
  await R.refreshAvailability(a.rider_id);
  await R.track(a.order_id, a.rider_id, outcome, reason);
  await R.logOps(actor, 'released', { orderId: a.order_id, riderId: a.rider_id, detail: { reason, custody: custody || null, outcome, excused } });
  await R.aiSay(a.rider_id, `The operations desk took delivery ${await refOf(a.order_id)} back from you. Reason: ${reason}.`, a.order_id, 'alert');
  await R.emit(a.rider_id, 'both', 'assignment', { order_id: Number(a.order_id), status: outcome });
  if (custody !== 'lost') afterRelease(a.order_id);
  return { ok: true };
}

/* ---------- delivery steps (called by the rider routes) ---------- */
// Orders accepted before this feature have no assignment row: make one, so the steps below always have something to update.
async function ensureLive(orderId, riderUserId) {
  const rd = await R.riderOfUser(riderUserId); if (!rd) return null;
  let a = await get(`SELECT * FROM rider_assignments WHERE order_id=? AND rider_id=? AND assignment_status IN ${R.LIVE_ASSIGN}`, orderId, rd.id);
  if (!a) {
    const o = await get('SELECT accepted_at, picked_up_at, on_way_at FROM orders WHERE id=? AND rider_id=?', orderId, riderUserId);
    if (!o) return null;
    const st = o.on_way_at ? 'in_transit' : o.picked_up_at ? 'picked_up' : o.accepted_at ? 'accepted' : 'offered';
    a = await get(`INSERT INTO rider_assignments (rider_id, order_id, assignment_status, offered_by, assigned_at, accepted_at) VALUES (?,?,?,'admin',?,?) ON CONFLICT DO NOTHING RETURNING *`, rd.id, orderId, st, now(), o.accepted_at || null)
      || await get(`SELECT * FROM rider_assignments WHERE order_id=? AND rider_id=? AND assignment_status IN ${R.LIVE_ASSIGN}`, orderId, rd.id);
  }
  return a;
}
// Legacy accept (the order was assigned directly): same effect as accepting the offer.
async function acceptOrder(orderId, riderUserId) {
  const a = await ensureLive(orderId, riderUserId); if (!a) fail(404, 'That order is not assigned to you.');
  if (a.assignment_status === 'offered') return accept(a.id, riderUserId);
  return { ok: true };
}
const COL = { arrived_pickup: 'arrived_pickup_at', picked_up: 'pickup_at', delivered: 'delivered_at', accepted: 'accepted_at' };
async function step(orderId, riderUserId, to, note = '') {
  const a = await ensureLive(orderId, riderUserId); if (!a) return;
  const order = ['accepted', 'arrived_pickup', 'picked_up', 'in_transit', 'delivered'], from = order.indexOf(a.assignment_status), n = order.indexOf(to);
  if (n <= from) return;   // never move backwards
  await run(`UPDATE rider_assignments SET assignment_status=?${COL[to] ? `, ${COL[to]}=COALESCE(${COL[to]}, ${now()})` : ''} WHERE id=?`, to, a.id);
  await R.track(orderId, a.rider_id, to, note);
  await R.emit(a.rider_id, 'both', 'assignment', { order_id: Number(orderId), status: to });
  await R.refreshAvailability(a.rider_id);
  return a;
}
async function arrived(orderId, rider) {
  const a = await ensureLive(orderId, rider.user_id); if (!a || a.assignment_status === 'offered') fail(409, 'Accept the delivery first.');
  const p = await pickupPoint(orderId), l = await get('SELECT latitude, longitude, received_at FROM rider_latest_location WHERE rider_id=?', rider.id);
  let note = 'Rider says they arrived';
  if (p && l && now() - Number(l.received_at) < 300) { const d = Math.round(R.km({ lat: l.latitude, lng: l.longitude }, { lat: Number(p.lat), lng: Number(p.lng) }) * 1000); note = d <= 300 ? `Arrival confirmed by GPS (${d} m from ${p.name})` : `Rider says they arrived, but GPS shows ${d} m from ${p.name}`; }
  else note = 'Rider says they arrived (no recent GPS to check)';
  await step(orderId, rider.user_id, 'arrived_pickup', note);
  await S.addEvent(orderId, 'processing', note);
  await R.post({ riderId: rider.id, kind: 'rider', senderId: rider.user_id, text: `Arrived at pickup for ${await refOf(orderId)}. ${note}`, orderId, type: 'response' });
  await notifyDesk({ title: `${rider.full_name} arrived at the pickup point`, body: `Order ${await refOf(orderId)}. ${note}.` });
  return { ok: true, note };
}
// The rider reports a problem. The AI acknowledges, tells the desk, and says what it recommends; it does not cancel or reassign on its own.
const REPORTS = {
  delay: { label: 'is delayed', text: 'Delay reported', rec: 'Ask for a new ETA; tell the customer if it will pass the promised time.' },
  customer_unavailable: { label: 'cannot reach the customer', text: 'Customer unavailable', rec: 'Call the customer. If they cannot be reached, take the delivery back (mark it as not the rider\'s fault) and arrange a new delivery.', excuse: true },
  incorrect_address: { label: 'has an incorrect address', text: 'Incorrect address', rec: 'Confirm the correct address with the customer and update the order, or take the delivery back.', excuse: true },
  assistance: { label: 'needs assistance', text: 'Assistance requested', rec: 'Call the rider now. If they cannot continue, take the delivery back and confirm where the parcel is.' },
  handover: { label: 'asks to hand the delivery over', text: 'Handover requested', rec: 'Agree the handover: take the delivery back, record where the parcel is, and it will be offered to another rider.' },
};
async function report(orderId, rider, type, note) {
  const def = REPORTS[type]; if (!def) fail(400, 'Unknown report type.');
  note = str(note, 400);
  const a = await ensureLive(orderId, rider.user_id); if (!a) fail(404, 'That order is not assigned to you.');
  const ref = await refOf(orderId);
  if (def.excuse) await run('UPDATE rider_assignments SET excused=1 WHERE id=?', a.id);   // reported at the time, so it will not count against the rider unless the desk disagrees
  await R.post({ riderId: rider.id, kind: 'rider', senderId: rider.user_id, text: `${def.text} for ${ref}.${note ? ' ' + note : ''}`, orderId, type: 'response' });
  await S.addEvent(orderId, (await get('SELECT status FROM orders WHERE id=?', orderId)).status, `Rider ${rider.full_name} reported: ${def.text}${note ? ' (' + note + ')' : ''}`, { internal: true });
  await R.track(orderId, rider.id, 'report_' + type, note);
  await R.aiSay(rider.id, `Thank you. I have told the operations desk (${def.text.toLowerCase()} on ${ref}). Please stay reachable and wait for instructions.`, orderId, 'instruction');
  await notifyDesk({ title: `Problem on ${ref}: ${rider.full_name} ${def.label}`, body: `${note ? note + ' ' : ''}Recommended: ${def.rec}` });
  await R.logOps('ai', 'escalated', { orderId, riderId: rider.id, detail: { type, note, recommendation: def.rec } });
  return { ok: true };
}
// The customer confirmed with the handover code (D.completeWithCode succeeded). Records the proof and frees the rider.
async function delivered(orderId, rider, { proofUrl = '', recipient = '', where = null } = {}) {
  await step(orderId, rider.user_id, 'delivered', 'Delivered; handover code confirmed by the customer');
  if (proofUrl && !/^(\/uploads\/[A-Za-z0-9._-]+|https:\/\/[^\s"'<>]+)$/.test(proofUrl)) proofUrl = '';
  await run(`INSERT INTO delivery_proofs (order_id, rider_id, otp_verified, proof_image_url, recipient_confirmation, latitude, longitude, delivery_timestamp) VALUES (?,?,1,?,?,?,?,?) ON CONFLICT (order_id) DO NOTHING`,
    orderId, rider.id, proofUrl, str(recipient, 80), where && Number.isFinite(where.lat) ? where.lat : null, where && Number.isFinite(where.lng) ? where.lng : null, now());
  await R.logOps('system', 'delivered', { orderId, riderId: rider.id });
  const ref = await refOf(orderId);
  await R.aiSay(rider.id, `Delivery ${ref} is recorded as complete. Thank you.`, orderId, 'system');
  await notifyDesk({ title: `Order ${ref} delivered by ${rider.full_name}`, body: 'Handover code confirmed by the customer.' });
  setImmediate(() => sweep().catch(() => {}));   // the rider is free again: anything waiting can be offered
}

/* ---------- follow-up and escalation ---------- */
async function watch() {
  const c = await R.cfg(), t = now();
  await expireOffers();
  // offers not answered halfway through the time allowed: one reminder
  for (const a of await all("SELECT a.id, a.rider_id, a.order_id, a.assigned_at, a.assignment_timeout_at FROM rider_assignments a WHERE a.assignment_status='offered' AND a.assignment_timeout_at IS NOT NULL")) {
    if (t >= Number(a.assigned_at) + (Number(a.assignment_timeout_at) - Number(a.assigned_at)) / 2 && (await once(a.order_id, 'nudge:' + a.id))) await R.aiSay(a.rider_id, `Reminder: please accept or reject the request for ${await refOf(a.order_id)}. It will be given to someone else soon.`, a.order_id, 'reminder');
  }
  const live = await all(`SELECT a.*, r.code, r.full_name, r.user_id, o.ref, o.promised_at, o.status AS ostatus, l.received_at, s.id AS sid, s.permission_status
    FROM rider_assignments a JOIN riders r ON r.id=a.rider_id JOIN orders o ON o.id=a.order_id
    LEFT JOIN rider_latest_location l ON l.rider_id=r.id LEFT JOIN rider_tracking_sessions s ON s.rider_id=r.id AND s.ended_at IS NULL
    WHERE a.assignment_status IN ${R.ACTIVE_ASSIGN} AND o.status NOT IN ('delivered','cancelled','refunded')`);
  for (const a of live) {
    const replied = async (since) => get("SELECT message FROM rider_messages WHERE rider_id=? AND sender_kind='rider' AND created_at>? ORDER BY id DESC LIMIT 1", a.rider_id, since);
    // 1. GPS has gone quiet while a delivery is in hand
    const lastFix = a.received_at ? Number(a.received_at) : Number(a.accepted_at || a.assigned_at), quiet = t - lastFix;
    const noPerm = a.sid && a.permission_status !== 'granted';
    if (quiet > c.rider_stale_s || noPerm) {
      if (await once(a.order_id, 'gps_ask')) await R.aiSay(a.rider_id, `${R.AI_NAME} here. I have not received your location for ${Math.max(1, Math.round(quiet / 60))} minutes while you carry ${a.ref}. Please open the app, check GPS and location permission, and reply to confirm you are OK.`, a.order_id, 'alert');
      else {
        const askedAt = await followupAt(a.order_id, 'gps_ask');
        if (askedAt && t >= askedAt + c.rider_ack_s && (await once(a.order_id, 'gps_escalate'))) {
          const rep = await replied(askedAt);
          await notifyDesk({ title: `GPS lost: ${a.full_name} (${a.code}) on ${a.ref}`, body: `No location for ${Math.round(quiet / 60)} min. ${rep ? 'Rider replied: "' + String(rep.message).slice(0, 80) + '". Their phone may have lost signal or the location permission was removed.' : 'The rider has not replied.'} Recommended: call the rider${rep ? '' : '; if unreachable, confirm where the parcel is before reassigning'}.` });
          await R.logOps('ai', 'escalated', { orderId: a.order_id, riderId: a.rider_id, detail: { type: 'gps_lost', quiet_s: quiet, replied: !!rep } });
        }
      }
    }
    // 2. Delivery past its promised time
    if (a.promised_at && t > Number(a.promised_at) + c.rider_overdue_grace_min * 60 && a.ostatus !== 'delivered') {
      if (await once(a.order_id, 'late_ask')) await R.aiSay(a.rider_id, `${R.AI_NAME} here. ${a.ref} is past its promised delivery time. Please reply with your status and a new ETA, or use "Report a delay".`, a.order_id, 'delay_alert');
      else {
        const askedAt = await followupAt(a.order_id, 'late_ask');
        if (askedAt && t >= askedAt + c.rider_ack_s && (await once(a.order_id, 'late_escalate'))) {
          const rep = await replied(askedAt);
          await notifyDesk({ title: `Delivery ${a.ref} is late (${a.full_name})`, body: `${Math.round((t - Number(a.promised_at)) / 60)} min past the promised time. ${rep ? 'Rider replied: "' + String(rep.message).slice(0, 80) + '".' : 'No reply from the rider.'} Recommended: ${rep ? 'tell the customer the new ETA' : 'call the rider, and warn the customer'}.` });
          await R.logOps('ai', 'escalated', { orderId: a.order_id, riderId: a.rider_id, detail: { type: 'late', replied: !!rep } });
        }
      }
    }
    // 3. Accepted but not at the pickup point after a long time
    if (a.assignment_status === 'accepted' && a.accepted_at && t > Number(a.accepted_at) + c.rider_pickup_slow_min * 60 && (await once(a.order_id, 'pickup_slow'))) {
      await R.aiSay(a.rider_id, `${R.AI_NAME} here. You accepted ${a.ref} ${c.rider_pickup_slow_min} minutes ago and have not arrived at the pickup point. Are you on your way? Reply with your ETA.`, a.order_id, 'reminder');
      await notifyDesk({ title: `${a.full_name} is slow to collect ${a.ref}`, body: `Accepted ${c.rider_pickup_slow_min}+ minutes ago, not yet at the pickup point. Recommended: wait for the rider's ETA; if there is none, take the delivery back (nothing is in their hands yet, so it is safe to reassign).` });
    }
  }
}

module.exports = { READY, rank, offer, dispatchOrder, sweep, accept, reject, expireOffers, manualAssign, unassign, release, acceptOrder, ensureLive, step, arrived, report, REPORTS, delivered, watch, pickupPoint, readySql, once, notifyDesk, refOf };
