'use strict';
// Order stage rules: where an order is, who must act, whether it is late, and whether delivery was proven. No database.
const assert = require('assert');
const S = require('../lib/ops/order-stage');
let passed = 0, failed = 0;
const test = (n, f) => { try { f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const now = 1_000_000, sla = S.normalizeSla({});
const base = { kind: 'order', status: 'confirmed', payment_method: 'card', payment_status: 'paid', created: now - 7200, confirmed_at: now - 3600, own_lines: 1, ds_lines: 0, ds_open: 0, delivery: 'home', proof_rows: 0 };
const c = (o) => S.classifyOrder({ ...base, ...o }, now);

console.log('\nRetail and shared order stages');
test('unpaid card order waits on the customer and is never "late"', () => { const x = c({ status: 'pending', payment_status: 'unpaid', created: now - 9000 }); assert.strictEqual(x.stage, 'awaiting_payment'); assert.strictEqual(S.lateness(x, {}, sla, now).late, false); });
test('an order unpaid for 3+ days is abandoned and ends', () => { const x = c({ status: 'pending', payment_status: 'unpaid', created: now - 4 * 86400 }); assert.ok(x.terminal); assert.strictEqual(x.outcome, 'abandoned'); });
test('pay on delivery is confirmed by staff, not left waiting for payment', () => assert.strictEqual(c({ status: 'pending', payment_method: 'pod', payment_status: 'unpaid' }).stage, 'awaiting_confirmation'));
test('a paid, unassigned order is awaiting dispatch and late after the allowance', () => { const x = c({ ready: true }); assert.strictEqual(x.stage, 'awaiting_dispatch'); assert.ok(S.lateness(x, {}, sla, now).late); });
test('an offered rider who has not answered is its own stage', () => assert.strictEqual(c({ ra_status: 'offered', ra_at: now - 60 }).stage, 'awaiting_rider_acceptance'));
test('rider on the way is in delivery; the promised time decides lateness', () => {
  const f = { ra_status: 'in_transit', rider_id: 5, picked_up_at: now - 3000, promised_at: now - 600 }, x = c(f), L = S.lateness(x, f, sla, now);
  assert.strictEqual(x.stage, 'in_delivery'); assert.ok(L.late); assert.strictEqual(L.overdue_min, 10);
});
test('a delivery 4 hours past the promise is critical', () => { const f = { rider_id: 5, picked_up_at: now - 20000, promised_at: now - 4 * 3600 }; assert.strictEqual(S.lateness(c(f), f, sla, now).severity, 'critical'); });
test('locked handover needs a person at once', () => { const x = c({ handover_locked: true, rider_id: 5 }); assert.strictEqual(x.stage, 'under_investigation'); assert.strictEqual(S.lateness(x, {}, sla, now).severity, 'high'); });
test('a failed attempt with no rider is flagged', () => assert.strictEqual(c({ ra_status: 'failed', ra_at: now - 100 }).stage, 'delivery_failed'));
test('the store marking delivered completes it; cancelled and refunded end it', () => { assert.strictEqual(c({ status: 'delivered' }).outcome, 'delivered'); assert.strictEqual(c({ status: 'cancelled' }).outcome, 'cancelled'); assert.strictEqual(c({ status: 'refunded' }).outcome, 'refunded'); });
test('pickup orders wait on the customer, not on dispatch', () => assert.strictEqual(c({ delivery: 'pickup' }).stage, 'awaiting_pickup'));

console.log('\nDropshipping and international');
test('supplier items not shipped: awaiting dropshipper, owned by the supplier', () => { const x = c({ own_lines: 0, ds_lines: 1, ds_open: 1, ds_waiting: 1, ds_since: now - 200000 }); assert.strictEqual(x.stage, 'awaiting_dropshipper'); assert.strictEqual(x.owner, 'supplier'); assert.ok(S.lateness(x, {}, sla, now).late); });
test('a supplier-reported problem goes to investigation', () => assert.strictEqual(c({ own_lines: 0, ds_lines: 1, ds_open: 1, ds_issue: true }).stage, 'under_investigation'));
test('shipped abroad is the international shipment stage', () => assert.strictEqual(c({ own_lines: 0, ds_lines: 1, ds_open: 1, ds_shipping: 1, ds_waiting: 0, international: true }).stage, 'awaiting_international_shipment'));

console.log('\nWholesale');
const w = (o) => S.classifyWholesale({ kind: 'wholesale', status: 'paid', created: now - 9000, paid_at: now - 8000, stage: 'to_pick', ...o }, now);
test('a request waits for a quotation; a quote waits on the buyer', () => { assert.strictEqual(w({ status: 'requested' }).stage, 'awaiting_wholesale_quote'); const q = w({ status: 'quoted' }); assert.strictEqual(q.stage, 'awaiting_payment'); assert.ok(S.lateness(q, {}, sla, now).customer_wait); });
test('paid wholesale moves through picking, packed, dispatched', () => { assert.strictEqual(w({}).stage, 'awaiting_wholesale_allocation'); assert.strictEqual(w({ stage: 'picking' }).stage, 'wholesale_picking'); assert.strictEqual(w({ stage: 'packed' }).stage, 'wholesale_ready'); assert.strictEqual(w({ stage: 'dispatched' }).stage, 'in_delivery'); });
test('a failed wholesale attempt is flagged; delivered completes', () => { assert.strictEqual(w({ stage: 'dispatched', failed_attempts: 1 }).stage, 'delivery_failed'); assert.strictEqual(w({ status: 'delivered' }).outcome, 'delivered'); });

console.log('\nProof of delivery');
test('OTP/photo/recipient proof is verified; none is unproven', () => { assert.strictEqual(S.proofState({ kind: 'order', own_lines: 1, ds_lines: 0, delivery: 'home', proof_rows: 1 }), 'verified'); assert.strictEqual(S.proofState({ kind: 'order', own_lines: 1, ds_lines: 0, delivery: 'home', proof_rows: 0 }), 'unproven'); });
test('pickup and supplier-only deliveries are labelled as such, never "verified"', () => { assert.strictEqual(S.proofState({ kind: 'order', delivery: 'pickup', own_lines: 1, ds_lines: 0, proof_rows: 0 }), 'pickup'); assert.strictEqual(S.proofState({ kind: 'order', own_lines: 0, ds_lines: 1, delivery: 'home', proof_rows: 0 }), 'supplier_reported'); });
test('wholesale needs a recorded signer', () => { assert.strictEqual(S.proofState({ kind: 'wholesale', delivered_by: '' }), 'unproven'); assert.strictEqual(S.proofState({ kind: 'wholesale', delivered_by: 'Driver A' }), 'verified'); });

console.log('\nSLA settings');
test('bad SLA values fall back to defaults and cannot be negative', () => { const s2 = S.normalizeSla({ awaiting_dispatch: -5, in_delivery: 'x', awaiting_confirmation: 10 }); assert.strictEqual(s2.awaiting_dispatch, S.DEFAULT_SLA.awaiting_dispatch); assert.strictEqual(s2.in_delivery, S.DEFAULT_SLA.in_delivery); assert.strictEqual(s2.awaiting_confirmation, 10); });
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
