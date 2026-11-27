'use strict';
// Delivery providers, recorded rates, shipments and tracking (database side of courier-select.js).
// Nothing here contacts a courier. A shipment moves forward only because a person recorded what the courier reported; a booking request is a record plus a
// task for staff, and becomes "booked" only when a person enters the tracking reference the courier actually issued. Every change is written to the audit log.
const { get, all, run, tx, now } = require('../db');
const S = require('../shop');
const St = require('./store');
const AP = require('./approvals');
const CS = require('./courier-select');
const { fail, str, int } = S;
const n = (v) => (v == null || v === '' ? null : Number(v));

const KINDS = ['courier', 'third_party', 'freight', 'cargo', 'independent_rider'], PSTATUS = ['approved', 'under_review', 'suspended'];
const FLOW = { booking_requested: ['booked', 'cancelled'], booked: ['collected', 'in_transit', 'cancelled', 'failed'], collected: ['in_transit', 'out_for_delivery', 'failed', 'returned'],
  in_transit: ['in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned'], out_for_delivery: ['delivered', 'failed', 'in_transit', 'returned'], failed: [], returned: [], cancelled: [], delivered: [], delivered_claimed: [] };
const POD = ['courier_confirmation', 'otp', 'signature', 'photo', 'customer_confirmation'];
const who = (u) => (u && (u.name || u.email)) || 'staff';
const log = (u, type, desc, rel, id, extra = {}) => St.logAction({ agent: 'logistics', actor_kind: 'human', actor_user: u && u.id, actor_name: who(u), action_type: type, description: desc, related_type: rel, related_id: String(id), status: 'done', ...extra });

/* ---------- providers and their recorded rates ---------- */
async function createProvider(user, b) {
  const name = str(b.name, 80); if (!name) fail(400, 'A provider needs a name.');
  const code = str(b.code, 20).toUpperCase().replace(/[^A-Z0-9_-]/g, '') || name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (!code) fail(400, 'A provider needs a short code.'); if (await get('SELECT id FROM ops_providers WHERE code=?', code)) fail(409, 'A provider with this code exists already.');
  const t = now(), kind = KINDS.includes(b.kind) ? b.kind : 'courier';
  const id = Number((await get('INSERT INTO ops_providers (code,name,kind,status,coverage,contact,notes,created,updated) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id', code, name, kind, 'under_review', str(b.coverage, 300), str(b.contact, 200), str(b.notes, 600), t, t)).id);
  await log(user, 'provider.create', `Delivery provider ${name} added as "under review"`, 'provider', id);
  return id;
}
// A person approves or suspends. Nobody is approved just by being added, and the AI can never do this itself.
async function setProviderStatus(user, id, status, reason) {
  if (!PSTATUS.includes(status)) fail(400, 'Unknown status.'); const p = await get('SELECT * FROM ops_providers WHERE id=?', int(id)); if (!p) fail(404, 'Provider not found.');
  if (status === 'approved' && !str(reason, 300)) fail(400, 'Say why this provider is approved (for example, contract or reference checked).');
  await run('UPDATE ops_providers SET status=?, updated=? WHERE id=?', status, now(), p.id);
  await log(user, 'provider.status', `${p.name}: ${p.status} → ${status}. ${str(reason, 300)}`, 'provider', p.id); return { from: p.status, to: status };
}
async function addRate(user, providerId, b) {
  const p = await get('SELECT * FROM ops_providers WHERE id=?', int(providerId)); if (!p) fail(404, 'Provider not found.');
  const price = n(b.price); if (!(price > 0)) fail(400, 'A rate needs a price above zero.');
  if (!['provider_quote', 'contract', 'published_rate_card'].includes(b.source)) fail(400, 'Say where the rate came from: provider quote, contract, or published rate card.');
  if (!str(b.source_ref, 200)) fail(400, 'Give a reference for the rate (quote number, email date, contract name). Rates are never entered from memory.');
  const mx = n(b.max_kg), mn = n(b.min_kg) || 0; if (mx != null && mx < mn) fail(400, 'The maximum weight is below the minimum.');
  const id = Number((await get(`INSERT INTO ops_rate_cards (provider_id,service,destination,min_kg,max_kg,price,currency,eta_days_min,eta_days_max,insured,source,source_ref,valid_until,recorded_by,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    p.id, str(b.service, 40) || 'standard', str(b.destination, 60) || '*', mn, mx, price, str(b.currency, 3).toUpperCase() || 'NGN', int(b.eta_days_min) || null, int(b.eta_days_max) || null, !!b.insured, b.source, str(b.source_ref, 200), int(b.valid_until) || null, who(user), now())).id);
  await log(user, 'rate.add', `Rate recorded for ${p.name}: ${price} ${str(b.currency, 3).toUpperCase() || 'NGN'} to ${str(b.destination, 60) || 'anywhere'} (${b.source}: ${str(b.source_ref, 80)})`, 'provider', p.id); return id;
}
async function listProviders() {
  const ps = await all('SELECT * FROM ops_providers ORDER BY status, name'), t = now(), out = [];
  for (const p of ps) out.push({ ...p, id: Number(p.id), rates: (await all('SELECT * FROM ops_rate_cards WHERE provider_id=? ORDER BY id DESC LIMIT 50', p.id)).map((r) => ({ ...r, id: Number(r.id), expired: !!(r.valid_until && Number(r.valid_until) < t) })), record: CS.trackRecord(await providerShipments(p.id)) });
  return out;
}
const providerShipments = (pid) => all('SELECT status, eta, closed_at, created, last_event_at, (SELECT COUNT(*) > 0 FROM ops_shipment_events e WHERE e.shipment_id=s.id AND e.note ILIKE ? ) AS lost_or_damaged FROM ops_shipments s WHERE provider_id=?', '[lost-or-damaged]%', pid);

/* ---------- comparing for one order ---------- */
async function shipFacts(orderId, weightOverride) {
  const o = await get('SELECT id, ref, state, country, name FROM orders WHERE id=?', int(orderId)); if (!o) fail(404, 'Order not found.');
  const w = await get(`SELECT SUM(oi.qty * p.weight_kg) kg, COUNT(*) FILTER (WHERE p.weight_kg IS NULL OR p.weight_kg <= 0) unknown FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?`, o.id);
  const kg = n(weightOverride) > 0 ? n(weightOverride) : (Number(w.unknown) === 0 && n(w.kg) > 0 ? n(w.kg) : null);
  return { order: o, ship: { state: o.state, country: o.country || 'NG', weight_kg: kg } };
}
async function compareForOrder(orderId, { weight_kg } = {}) {
  const { order, ship } = await shipFacts(orderId, weight_kg), cfg = await St.getConfig();
  const cards = await all('SELECT r.*, p.id pid FROM ops_rate_cards r JOIN ops_providers p ON p.id=r.provider_id'), provs = new Map((await all('SELECT * FROM ops_providers')).map((p) => [Number(p.id), p]));
  const options = [], rec = {};
  for (const c of cards) { const p = provs.get(Number(c.provider_id)); rec[p.id] = rec[p.id] || CS.trackRecord(await providerShipments(p.id)); const conv = await AP.toNgn(Number(c.price), c.currency);
    options.push({ provider: { ...p, id: Number(p.id) }, card: { ...c, id: Number(c.id), price: Number(c.price) }, ngn: conv.unknown ? null : conv.ngn, record: rec[p.id] }); }
  const r = CS.compare({ ship, options, weights: cfg.delivery_weights });
  const rider = 'Internal riders are not priced here. They are offered automatically by rider dispatch, which is usually cheaper for local orders.';
  const open = await get("SELECT ref, status FROM ops_shipments WHERE order_kind='order' AND order_id=? AND status NOT IN ('delivered','delivered_claimed','failed','returned','cancelled')", order.id);
  return { order: { id: Number(order.id), ref: order.ref, state: order.state, country: order.country || 'NG' }, ship, ...r, no_rates: cards.length === 0, note: rider, existing_shipment: open || null };
}

/* ---------- shipments ---------- */
async function refOf() { return 'SHP-' + String(Number((await get("SELECT nextval('ops_shipment_seq') v")).v)).padStart(5, '0'); }
// Called by the gateway handler once the booking request is allowed (and approved if it needed to be). It records the request and tells staff to book it.
async function createFromRequest(p, byUser) {
  const order = await get('SELECT id, ref, status FROM orders WHERE id=?', int(p.order_id)); if (!order) throw new Error('Order not found.');
  if (['delivered', 'cancelled', 'refunded'].includes(order.status)) throw new Error(`Order ${order.ref} is ${order.status}, so no shipment can be booked.`);
  const card = await get('SELECT r.*, pr.name pname, pr.status pstatus FROM ops_rate_cards r JOIN ops_providers pr ON pr.id=r.provider_id WHERE r.id=?', int(p.rate_id)); if (!card) throw new Error('That recorded rate no longer exists.');
  if (card.pstatus !== 'approved') throw new Error(`${card.pname} is not an approved provider.`);
  if (card.valid_until && Number(card.valid_until) < now()) throw new Error('That recorded rate has expired. Get a current quotation.');
  if (Number(card.price) !== Number(p.price) || String(card.currency) !== String(p.currency)) throw new Error('The rate changed after it was reviewed, so it needs to be reviewed again.');
  if (await get("SELECT id FROM ops_shipments WHERE order_kind='order' AND order_id=? AND status NOT IN ('delivered','delivered_claimed','failed','returned','cancelled')", order.id)) throw new Error(`Order ${order.ref} already has a shipment in progress. Nobody is booked twice.`);
  const t = now(), ref = await refOf();
  const id = Number((await get(`INSERT INTO ops_shipments (ref,order_kind,order_id,provider_id,rate_id,service,status,cost,currency,weight_kg,approval_id,requested_by,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ref, 'order', order.id, card.provider_id, card.id, card.service, 'booking_requested', card.price, card.currency, n(p.weight_kg), int(p.approval_id) || null, byUser || 'AI', t, t)).id);
  await run("INSERT INTO ops_shipment_events (shipment_id,status,note,occurred_at,source,recorded_by,created) VALUES (?,?,?,?,?,?,?)", id, 'booking_requested', `Booking with ${card.pname} requested at the recorded rate ${card.price} ${card.currency}`, t, 'staff', byUser || 'AI', t);
  await St.createTask({ title: `Book ${ref} with ${card.pname} for order ${order.ref}`, detail: `Book this delivery with ${card.pname} (${card.service}), then enter the tracking reference they give you on the shipment. The AI cannot book couriers yet; no courier API is connected.`, department: 'couriers', priority: 'high', related_type: 'shipment', related_id: String(id) }, null).catch(() => {});
  return { shipment_id: id, ref };
}
async function recordBooking(user, id, b) {
  const s = await get('SELECT * FROM ops_shipments WHERE id=?', int(id)); if (!s) fail(404, 'Shipment not found.');
  if (s.status !== 'booking_requested') fail(409, `This shipment is ${s.status.replace(/_/g, ' ')}.`);
  const tr = str(b.tracking_ref, 80); if (!tr) fail(400, 'Enter the tracking reference the courier gave you. It cannot be made up.');
  if (await get('SELECT id FROM ops_shipments WHERE tracking_ref=? AND provider_id=? AND id<>?', tr, s.provider_id, s.id)) fail(409, 'This tracking reference is already on another shipment.');
  const t = now(); await run("UPDATE ops_shipments SET status='booked', tracking_ref=?, eta=?, updated=?, last_event_at=? WHERE id=?", tr, int(b.eta) || null, t, t, s.id);
  await run("INSERT INTO ops_shipment_events (shipment_id,status,note,occurred_at,source,recorded_by,created) VALUES (?,?,?,?,?,?,?)", s.id, 'booked', `Booked. Courier tracking reference ${tr}`, t, 'staff', who(user), t);
  await log(user, 'shipment.booked', `${s.ref} booked with the courier, tracking ${tr}`, 'shipment', s.id, { external_ref: tr }); return { ok: true };
}
// A person records what the courier reported. Delivery is only "delivered" with proof; otherwise it is "delivered_claimed" and a person must follow up.
async function addEvent(user, id, b, source = 'staff') {
  const s = await get('SELECT * FROM ops_shipments WHERE id=?', int(id)); if (!s) fail(404, 'Shipment not found.');
  const to = str(b.status, 30); if (!(FLOW[s.status] || []).includes(to)) fail(409, `A shipment that is ${s.status.replace(/_/g, ' ')} cannot move to ${to.replace(/_/g, ' ')}.`);
  if (to === 'booked') fail(400, 'Use the booking step to enter the tracking reference.');
  const t = now(), at = Math.min(int(b.occurred_at) || t, t); if (at < Number(s.created) - 86400) fail(400, 'That event time is before this shipment existed.');
  let status = to, pk = '', pr = '';
  if (to === 'delivered') { pk = str(b.pod_kind, 30); pr = str(b.pod_ref, 200); if (POD.includes(pk) && pr) status = 'delivered'; else { status = 'delivered_claimed'; pk = ''; pr = ''; } }
  const close = ['delivered', 'delivered_claimed', 'failed', 'returned', 'cancelled'].includes(status);
  await tx(async () => {
    await run('UPDATE ops_shipments SET status=?, updated=?, last_event_at=?, attempts=attempts+?, pod_kind=?, pod_ref=?, closed_at=? WHERE id=?', status, t, at, to === 'failed' ? 1 : 0, pk || s.pod_kind, pr || s.pod_ref, close ? at : null, s.id);
    await run('INSERT INTO ops_shipment_events (shipment_id,status,location,note,occurred_at,source,recorded_by,created) VALUES (?,?,?,?,?,?,?,?)', s.id, status, str(b.location, 120), (b.lost_or_damaged ? '[lost-or-damaged] ' : '') + str(b.note, 300), at, source, who(user), t);
  });
  await log(user, 'shipment.event', `${s.ref}: ${s.status} → ${status}${status !== to ? ' (no proof of delivery given)' : ''}`, 'shipment', s.id);
  return { status, proof_accepted: status === 'delivered', needs_proof: status === 'delivered_claimed' };
}
async function cancelShipment(user, id, reason) { const s = await get('SELECT * FROM ops_shipments WHERE id=?', int(id)); if (!s) fail(404, 'Shipment not found.'); if (!(FLOW[s.status] || []).includes('cancelled')) fail(409, 'This shipment can no longer be cancelled here.'); return addEvent(user, id, { status: 'cancelled', note: reason }); }
async function listShipments({ status = '', open = false, provider = '' } = {}) {
  const w = [], a = []; if (provider) { w.push('lower(p.name) LIKE ?'); a.push('%' + String(provider).toLowerCase().replace(/[\\%_]/g, '').slice(0, 60) + '%'); } if (status) { w.push('s.status=?'); a.push(status); } if (open) w.push('s.closed_at IS NULL');
  const rows = await all(`SELECT s.*, p.name provider, o.ref order_ref FROM ops_shipments s JOIN ops_providers p ON p.id=s.provider_id LEFT JOIN orders o ON o.id=s.order_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 300`, ...a);
  return rows.map((r) => ({ ...r, id: Number(r.id), order_id: Number(r.order_id), cost: Number(r.cost) }));
}
async function getShipment(id) { const s = (await all('SELECT s.*, p.name provider, o.ref order_ref FROM ops_shipments s JOIN ops_providers p ON p.id=s.provider_id LEFT JOIN orders o ON o.id=s.order_id WHERE s.id=?', int(id)))[0]; if (!s) return null; return { ...s, events: await all('SELECT * FROM ops_shipment_events WHERE shipment_id=? ORDER BY id', s.id) }; }

// Ask for a shipment to be booked at a recorded rate. Goes through the gateway: the mode, the approval level for the amount and the audit log all apply.
async function requestBooking(ctx, { order_id, rate_id, weight_kg, justification }) {
  const card = await get('SELECT r.*, pr.name pname, pr.status pstatus FROM ops_rate_cards r JOIN ops_providers pr ON pr.id=r.provider_id WHERE r.id=?', int(rate_id)); if (!card) fail(404, 'Rate not found.');
  const o = await get('SELECT id, ref, country FROM orders WHERE id=?', int(order_id)); if (!o) fail(404, 'Order not found.');
  if (card.pstatus !== 'approved') fail(409, `${card.pname} is "${card.pstatus.replace('_', ' ')}", so nothing can be booked with them.`);
  if (card.valid_until && Number(card.valid_until) < now()) fail(409, 'That recorded rate has expired. Get a current quotation first.');
  const intl = (o.country || 'NG') !== 'NG', type = intl ? 'courier.book_intl' : 'courier.book_local';
  return require('./gateway').perform(ctx, type, { summary: `Book ${card.pname} (${card.service}) for order ${o.ref}`, justification: str(justification, 600) || `Delivery of ${o.ref}`, amount: Number(card.price), currency: card.currency, counterparty: card.pname, related_type: 'order', related_id: String(o.id), payload: { order_id: Number(o.id), rate_id: Number(card.id), price: Number(card.price), currency: card.currency, weight_kg: n(weight_kg) } });
}

/* ---------- the watch: problems a person must hear about ---------- */
async function watch(raise) {
  const t = now(), seen = [], rows = await all(`SELECT s.*, p.name provider, o.ref order_ref FROM ops_shipments s JOIN ops_providers p ON p.id=s.provider_id LEFT JOIN orders o ON o.id=s.order_id WHERE s.closed_at IS NULL OR s.status IN ('delivered_claimed','failed') AND s.closed_at > ?`, t - 7 * 86400);
  const hrs = (x) => Math.round((t - Number(x)) / 360) / 10, base = (s) => ({ related_type: 'shipment', related_id: String(s.id), department: 'couriers', auto: true });
  for (const s of rows) {
    const mk = async (kind, severity, title, detail, action) => { const key = `${kind}:${s.id}`; seen.push(key); await raise({ ...base(s), kind, severity, dedupe_key: key, title, detail, impact: `Order ${s.order_ref || s.order_id} is waiting on this delivery.`, recommended_action: action }); };
    if (s.status === 'booking_requested' && t - Number(s.created) > 2 * 3600) await mk('shipment_unbooked', t - Number(s.created) > 6 * 3600 ? 'high' : 'medium', `${s.ref} has not been booked with ${s.provider}`, `Requested ${hrs(s.created)}h ago and no tracking reference entered.`, 'Book it with the courier and enter the tracking reference, or cancel the request.');
    if (s.status === 'booked' && t - Number(s.last_event_at || s.created) > 12 * 3600) await mk('shipment_not_collected', 'medium', `${s.ref} not collected by ${s.provider}`, `Booked ${hrs(s.last_event_at || s.created)}h ago with no collection recorded.`, 'Call the courier and confirm collection.');
    if (['collected', 'in_transit', 'out_for_delivery'].includes(s.status) && t - Number(s.last_event_at || s.created) > 24 * 3600) await mk('shipment_stale', 'medium', `${s.ref} has no tracking update for ${hrs(s.last_event_at)}h`, `Last update ${hrs(s.last_event_at)}h ago (${s.status.replace(/_/g, ' ')}). Tracking ${s.tracking_ref}.`, 'Check the courier tracking and record the latest status.');
    if (s.eta && Number(s.eta) < t && !s.closed_at) await mk('shipment_late', Number(s.eta) < t - 86400 ? 'high' : 'medium', `${s.ref} is past its estimated delivery`, `Estimated ${hrs(s.eta)}h ago and not delivered.`, 'Chase the courier and tell the customer.');
    if (s.status === 'failed') await mk('shipment_failed', 'high', `${s.ref} delivery failed`, `${s.provider} could not deliver. Attempts: ${s.attempts}.`, 'Contact the customer and arrange another attempt, or return the goods.');
    if (s.status === 'delivered_claimed') await mk('shipment_no_proof', 'medium', `${s.ref} reported delivered without proof`, 'No OTP, signature, photo, customer or courier confirmation has been recorded.', 'Get the proof from the courier or the customer and record it.');
  }
  return seen;
}

/* ---------- scorecards ---------- */
async function scorecards() {
  const out = []; for (const p of await all("SELECT * FROM ops_providers ORDER BY name")) {
    const rec = CS.trackRecord(await providerShipments(p.id)), cost = await get("SELECT AVG(cost) avg_cost, COUNT(DISTINCT currency) cur FROM ops_shipments WHERE provider_id=? AND status IN ('delivered','delivered_claimed')", p.id);
    const hrs = await get("SELECT AVG(closed_at - created) / 3600.0 h FROM ops_shipments WHERE provider_id=? AND status='delivered' AND closed_at IS NOT NULL", p.id);
    out.push({ id: Number(p.id), name: p.name, status: p.status, connection: p.connection, ...rec, avg_cost: Number(cost.cur) === 1 && cost.avg_cost != null ? Math.round(Number(cost.avg_cost)) : null, avg_delivery_hours: hrs.h != null ? Math.round(Number(hrs.h) * 10) / 10 : null,
      verdict: !rec.enough ? `Not enough history (${rec.finished} of ${CS.MIN_SAMPLE} finished shipments)` : rec.success_pct < 85 ? 'Underperforming: review, renegotiate or suspend (needs a person to decide)' : 'Performing' });
  }
  return out;
}

module.exports = { KINDS, PSTATUS, FLOW, POD, createProvider, setProviderStatus, addRate, listProviders, compareForOrder, requestBooking, createFromRequest, recordBooking, addEvent, cancelShipment, listShipments, getShipment, watch, scorecards };
