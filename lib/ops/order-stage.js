'use strict';
// Where an order is, who has to act, and whether it is late. Pure: it takes plain facts and returns the answer. No database, no clock of its own.
// The facts come from the store's real tables (lib/ops/orders.js). Nothing here changes an order and nothing is estimated.

const STAGES = {
  awaiting_payment: { label: 'Awaiting payment', owner: 'customer' },
  awaiting_confirmation: { label: 'Awaiting confirmation', owner: 'orders' },
  awaiting_inventory: { label: 'Awaiting stock', owner: 'procurement' },
  awaiting_dropshipper: { label: 'Awaiting supplier (dropship)', owner: 'supplier' },
  awaiting_international_shipment: { label: 'International shipment in progress', owner: 'forwarder' },
  awaiting_dispatch: { label: 'Awaiting delivery assignment', owner: 'dispatch' },
  awaiting_rider_acceptance: { label: 'Awaiting rider acceptance', owner: 'rider' },
  awaiting_pickup: { label: 'Awaiting customer pickup', owner: 'customer' },
  in_delivery: { label: 'Out for delivery', owner: 'rider' },
  delivery_failed: { label: 'Delivery failed', owner: 'dispatch' },
  under_investigation: { label: 'Under investigation', owner: 'orders' },
  awaiting_wholesale_quote: { label: 'Awaiting wholesale quotation', owner: 'wholesale' },
  awaiting_wholesale_allocation: { label: 'Awaiting wholesale picking', owner: 'wholesale' },
  wholesale_picking: { label: 'Wholesale picking and packing', owner: 'wholesale' },
  wholesale_ready: { label: 'Wholesale packed, awaiting dispatch', owner: 'wholesale' },
  completed: { label: 'Completed', owner: '' }, cancelled: { label: 'Cancelled', owner: '' }, abandoned: { label: 'Abandoned (never paid)', owner: '' },
};
const TERMINAL = new Set(['completed', 'cancelled', 'abandoned']);
// Minutes an order may sit in each stage before it counts as late. 0 means "problem as soon as it is in this stage". Management can change them.
const DEFAULT_SLA = { awaiting_payment: 60, awaiting_confirmation: 30, awaiting_inventory: 240, awaiting_dropshipper: 2880, awaiting_international_shipment: 20160, awaiting_dispatch: 15, awaiting_rider_acceptance: 10, awaiting_pickup: 1440, in_delivery: 180, delivery_failed: 0, under_investigation: 0, awaiting_wholesale_quote: 240, awaiting_wholesale_allocation: 240, wholesale_picking: 480, wholesale_ready: 240 };
// Stages where the customer is the one who has to act: shown on the board, but not an operational problem for staff.
const CUSTOMER_STAGES = new Set(['awaiting_payment', 'awaiting_pickup']);
const ABANDON_AFTER = 3 * 86400;

function normalizeSla(raw) {
  const out = {};
  for (const k of Object.keys(DEFAULT_SLA)) { const v = raw && Number(raw[k]); out[k] = Number.isFinite(v) && v >= 0 && v <= 43200 ? Math.round(v) : DEFAULT_SLA[k]; }
  return out;
}

// f: facts about one order. Returns { stage, owner, since, next_action, sla_min, terminal, outcome }.
function classifyOrder(f, now) {
  const done = (stage, outcome) => ({ stage, owner: '', since: f.delivered_at || f.created, next_action: '', terminal: true, outcome });
  if (f.status === 'cancelled') return done('cancelled', 'cancelled');
  if (f.status === 'refunded') return done('cancelled', 'refunded');
  if (f.status === 'delivered') return done('completed', 'delivered');
  const r = (stage, since, next) => ({ stage, owner: STAGES[stage].owner, since: since || f.created, next_action: next, terminal: false, outcome: '' });
  const pod = f.payment_method === 'pod', paid = f.payment_status === 'paid';

  if (f.status === 'pending' && !paid && !pod) return now - f.created > ABANDON_AFTER ? done('abandoned', 'abandoned') : r('awaiting_payment', f.created, 'Waiting for the customer to pay. Send a payment reminder if it stays unpaid.');
  if (f.handover_locked) return r('under_investigation', f.on_way_at || f.picked_up_at || f.created, 'Handover is locked after wrong codes. A person must check with the rider and customer.');
  if (f.ra_status === 'failed' && !f.rider_id) return r('delivery_failed', f.ra_at || f.created, 'The last delivery attempt failed. Contact the customer and arrange another attempt.');
  if (f.ds_issue) return r('under_investigation', f.created, 'A supplier reported a problem with an item. Contact the supplier and the customer.');
  if (f.status === 'pending' || f.status === 'paid') return r('awaiting_confirmation', f.created, 'Confirm the order so it can be prepared and dispatched.');

  // The order rides on an import/export consignment: it follows that consignment, and must not be offered to a local rider.
  if (f.trade_status && ['draft', 'booked', 'in_transit', 'arrived', 'cleared'].includes(f.trade_status)) {
    const say = { draft: 'is still being prepared. Complete the documents and book it with the forwarder.', booked: 'is booked. Track departure.', in_transit: 'is in transit. Track it to arrival.', arrived: 'has arrived. Clear customs.', cleared: 'has cleared customs. Arrange final delivery.' };
    return r('awaiting_international_shipment', f.trade_since || f.confirmed_at || f.created, `Consignment ${f.trade_ref} ${say[f.trade_status]}`);
  }
  const ownOpen = f.own_lines > 0 && !f.rider_id && !f.picked_up_at && !f.on_way_at;
  if (ownOpen && f.short_items && f.short_items.length) return r('awaiting_inventory', f.confirmed_at || f.created, 'Stock is short for ' + f.short_items.map((s) => `${s.name} (need ${s.qty}, have ${s.stock})`).join(', ') + '. Restock or contact the customer.');
  if (f.ds_open > 0 && !ownOpen) {
    const shipping = f.ds_shipping > 0 && f.ds_waiting === 0;
    if (shipping && (f.international || f.ds_customs)) return r('awaiting_international_shipment', f.ds_since || f.created, 'The supplier has shipped. Track the shipment and customs clearance.');
    return r('awaiting_dropshipper', f.ds_since || f.confirmed_at || f.created, shipping ? 'The supplier has shipped. Track the parcel to the customer.' : 'Waiting for the supplier to accept and ship. Chase the supplier if it is late.');
  }
  if (f.ready) return r('awaiting_dispatch', f.confirmed_at || f.created, 'Assign a rider or a courier.');
  if (f.ra_status === 'offered') return r('awaiting_rider_acceptance', f.ra_at, 'A rider was offered the delivery and has not accepted. Offer it to another rider if it stays unanswered.');
  if (['accepted', 'arrived_pickup', 'picked_up', 'in_transit'].includes(f.ra_status) || f.status === 'shipped' || f.rider_id) return r('in_delivery', f.picked_up_at || f.on_way_at || f.accepted_at || f.confirmed_at, 'On its way. Track it until the customer confirms delivery.');
  if (f.delivery === 'pickup') return r('awaiting_pickup', f.confirmed_at || f.created, 'Ready for the customer to collect.');
  return r('under_investigation', f.confirmed_at || f.created, 'The order is in a state the system does not recognise. A person should look at it.');
}

// Wholesale: a quotation becomes an order when the buyer has paid. Earlier statuses are requests and quotes.
function classifyWholesale(f, now) {
  const done = (stage, outcome) => ({ stage, owner: '', since: f.delivered_at || f.created, next_action: '', terminal: true, outcome });
  if (f.status === 'delivered') return done('completed', 'delivered');
  if (f.status === 'declined') return done('cancelled', 'declined');
  if (f.status === 'cancelled') return done('cancelled', 'cancelled');
  if (f.status === 'expired') return done('cancelled', 'expired');
  const r = (stage, since, next) => ({ stage, owner: STAGES[stage].owner, since: since || f.created, next_action: next, terminal: false, outcome: '' });
  if (f.status === 'requested') return r('awaiting_wholesale_quote', f.created, 'A buyer asked for a quotation. Prepare and send it.');
  if (f.status === 'quoted' || f.status === 'accepted') return r('awaiting_payment', f.accepted_at || f.quoted_at || f.created, 'Waiting for the buyer to pay the quotation.');
  if (f.failed_attempts > 0 && f.stage === 'dispatched') return r('delivery_failed', f.dispatched_at || f.paid_at, 'A delivery attempt failed. Contact the buyer and arrange another attempt.');
  if (f.status === 'shipped' || f.stage === 'dispatched') return r('in_delivery', f.dispatched_at || f.shipped_at || f.paid_at, 'On its way to the buyer. Get the delivery note signed.');
  if (f.stage === 'packed') return r('wholesale_ready', f.packed_at || f.paid_at, 'Packed. Dispatch it.');
  if (f.stage === 'picking' || f.stage === 'picked') return r('wholesale_picking', f.picking_started || f.paid_at, 'Being picked and packed.');
  return r('awaiting_wholesale_allocation', f.paid_at || f.created, 'Paid. Start picking from the wholesale warehouse.');
}

// How late is it, and how serious? For in_delivery the promised time (if there is one) decides, else the stage allowance.
function lateness(c, f, sla, now) {
  if (c.terminal) return { minutes_in_stage: 0, sla_min: 0, overdue_min: 0, late: false, severity: 'none', customer_wait: false };
  const mins = Math.max(0, Math.floor((now - c.since) / 60));
  let allowed = sla[c.stage] != null ? sla[c.stage] : 0, overdue = Math.max(0, mins - allowed);
  if (c.stage === 'in_delivery' && f.promised_at) { allowed = Math.max(0, Math.floor((f.promised_at - c.since) / 60)); overdue = Math.max(0, Math.floor((now - f.promised_at) / 60)); }
  const customer = CUSTOMER_STAGES.has(c.stage);
  const needs = ['delivery_failed', 'under_investigation'].includes(c.stage);
  const late = !customer && (needs || overdue > 0);
  let sev = 'none';
  if (late) {
    if (needs) sev = 'high';
    else if (c.stage === 'in_delivery') sev = overdue >= 240 ? 'critical' : overdue >= 60 ? 'high' : 'medium';
    else { const ratio = allowed > 0 ? overdue / allowed : 9; sev = ratio >= 3 ? 'high' : ratio >= 1 ? 'medium' : 'low'; }
  }
  return { minutes_in_stage: mins, sla_min: allowed, overdue_min: overdue, late, severity: sev, customer_wait: customer };
}

// Proof that a delivered order really arrived. The store's own handover (OTP / signature / photo) is what counts; a date alone is not proof.
function proofState(f) {
  if (f.kind === 'wholesale') return f.delivered_by ? 'verified' : 'unproven';
  if (f.delivery === 'pickup') return 'pickup';
  if (f.proof_rows > 0) return 'verified';
  if (f.own_lines === 0 && f.ds_lines > 0) return 'supplier_reported';
  return 'unproven';
}

module.exports = { STAGES, TERMINAL, DEFAULT_SLA, CUSTOMER_STAGES, normalizeSla, classifyOrder, classifyWholesale, lateness, proofState };
