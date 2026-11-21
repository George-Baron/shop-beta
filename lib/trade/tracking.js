'use strict';
// Shipment tracking: customer lookup (order number or tracking number + the email used at checkout) and a staff overview of shipments in transit.
// Tracking facts come only from carrier updates or staff entries recorded in shipment_tracking_events. Nothing is guessed.
const { get, all } = require('../db');
const S = require('../shop');
const { fail } = S;

const STAGES = ['order_confirmed', 'processing', 'packed', 'dispatched', 'export_customs', 'departed_origin', 'in_transit', 'arrived_destination', 'import_customs', 'customs_released', 'out_for_delivery', 'delivered'];
const LABEL = { order_confirmed: 'Order confirmed', processing: 'Processing', packed: 'Packed', dispatched: 'Dispatched', export_customs: 'Export customs', departed_origin: 'Left Nigeria', in_transit: 'In transit', arrived_destination: 'Arrived in destination country', import_customs: 'Import customs', customs_released: 'Released by customs', out_for_delivery: 'Out for delivery', delivered: 'Delivered', delayed: 'Delayed', exception: 'Problem with delivery', customs_hold: 'Held at customs' };
const NOT_FOUND = 'We could not find a shipment with those details. Check the order or tracking number and the email used at checkout.';

async function lookup(b) {
  const q = String(b.query || '').trim().toUpperCase().slice(0, 60), email = String(b.email || '').trim().toLowerCase().slice(0, 120);
  if (!q || !/^\S+@\S+\.\S+$/.test(email)) fail(400, 'Enter your order or tracking number and the email you used at checkout.');
  const eo = await get(`SELECT eo.* FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE (UPPER(o.ref)=? OR UPPER(eo.ref)=? OR UPPER(eo.tracking_number)=?) AND LOWER(eo.ship_email)=? AND o.payment_status IN ('paid','refunded') ORDER BY eo.id DESC LIMIT 1`, q, q, q, email);
  if (!eo) fail(404, NOT_FOUND);
  const ev = await all('SELECT stage, description, location, occurred_at FROM shipment_tracking_events WHERE export_order_id=? ORDER BY occurred_at, id', eo.id);
  const reached = new Set(ev.map((e) => e.stage));
  return { order_ref: (await get('SELECT ref FROM orders WHERE id=?', eo.order_id)).ref, status: eo.status, carrier: eo.carrier || null, tracking_number: eo.tracking_number || null, eta: eo.eta || null, destination: { country: eo.destination_country, city: eo.city },
    stages: STAGES.map((s) => ({ stage: s, label: LABEL[s], reached: reached.has(s) })), problem: ['delayed', 'exception', 'customs_hold'].filter((s) => reached.has(s)).pop() || null,
    timeline: ev.map((e) => ({ stage: e.stage, label: LABEL[e.stage] || e.stage, description: e.description, location: e.location, at: Number(e.occurred_at) })),
    note: eo.carrier && eo.tracking_number ? 'Updates come from the carrier or from our team. They can take a few hours to appear.' : 'Your parcel has not been handed to a carrier yet.' };
}

async function overview(q = {}) {
  const stale = Math.max(1, Number(q.stale_days) || 3) * 86400, t = Math.floor(Date.now() / 1000);
  const rows = await all(`SELECT eo.ref, o.ref order_ref, eo.status, eo.destination_country, eo.carrier, eo.tracking_number, eo.eta, eo.ship_name,
    (SELECT stage FROM shipment_tracking_events e WHERE e.export_order_id=eo.id ORDER BY occurred_at DESC, id DESC LIMIT 1) last_stage,
    (SELECT occurred_at FROM shipment_tracking_events e WHERE e.export_order_id=eo.id ORDER BY occurred_at DESC, id DESC LIMIT 1) last_at,
    (SELECT source FROM shipment_tracking_events e WHERE e.export_order_id=eo.id ORDER BY occurred_at DESC, id DESC LIMIT 1) last_source
    FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE eo.status IN ('dispatched','in_transit','customs','out_for_delivery') ORDER BY eo.id DESC LIMIT 300`);
  const out = rows.map((r) => { const last = r.last_at == null ? null : Number(r.last_at), problem = ['delayed', 'exception', 'customs_hold'].includes(r.last_stage), isStale = last == null || t - last > stale;
    return { ref: r.ref, order_ref: r.order_ref, customer: r.ship_name, country: r.destination_country, status: r.status, carrier: r.carrier, tracking_number: r.tracking_number, eta: r.eta, last_stage: r.last_stage, last_at: last, last_source: r.last_source, problem, stale: isStale, flag: problem ? 'problem' : isStale ? 'no_recent_update' : 'ok' }; });
  return { shipments: out, counts: { in_flight: out.length, problems: out.filter((x) => x.problem).length, stale: out.filter((x) => x.stale && !x.problem).length }, stale_days: stale / 86400 };
}
module.exports = { lookup, overview, STAGES, LABEL };
