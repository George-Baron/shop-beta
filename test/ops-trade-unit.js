'use strict';
// Consignment readiness rules. No database.
const assert = require('assert');
const { readiness } = require('../lib/ops/trade-readiness');
let passed = 0, failed = 0;
const test = (n, f) => { try { f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const now = 2_000_000;
const ship = (o = {}) => ({ direction: 'import', status: 'draft', customs_status: 'not_started', incoterm: 'FOB', currency: 'USD', party_name: 'Acme Ltd', party_address: '1 Road', party_country: 'CN', party_tax_id: 'X1', party_contact: 'a@b', forwarder: 'Fwd Co', freight: 5000, insurance: 1000, duty_pct: 10, agent_fee: 2000, fx_rate: 1500, eta: null, bill_no: '', ...o });
const item = (o = {}) => ({ description: 'Phone case', hs_code: '392690', origin_country: 'CN', qty: 10, unit_value: 5, weight_kg: 0.1, ...o });
const facts = (o = {}) => ({ shipment: ship(o.ship), items: o.items || [item()], issued: o.issued || ['commercial_invoice', 'packing_list', 'proforma'], files: o.files || [], checklist: o.checklist || { items: [] }, flags: o.flags || [], stock: o.stock || [], vendor: o.vendor === undefined ? null : o.vendor });
const codes = (r, k = 'blockers') => r[k].map((b) => b.code);

console.log('\nImports');
test('a complete draft import is ready to book', () => { const r = readiness(facts(), now); assert.strictEqual(r.ready, true); assert.deepStrictEqual(codes(r), []); assert.ok(/Ready to book/.test(r.next_step)); });
test('no goods, no HS code and no values each block it; missing origin and weight only warn', () => {
  const r = readiness(facts({ items: [item({ hs_code: '', origin_country: '', weight_kg: null }), item({ unit_value: 0 })] }), now);
  assert.ok(codes(r).includes('hs_missing')); assert.ok(codes(r).includes('value_missing')); assert.ok(codes(r, 'warnings').includes('origin_missing')); assert.ok(codes(r, 'warnings').includes('weight_missing'));
  assert.ok(codes(readiness(facts({ items: [] }), now)).includes('no_items'));
});
test('an unverified supplier blocks; a verified one does not', () => { assert.ok(codes(readiness(facts({ vendor: { verified: false } }), now)).includes('vendor_unverified')); assert.ok(!codes(readiness(facts({ vendor: { verified: true } }), now)).includes('vendor_unverified')); });
test('missing invoice and packing list block', () => { const r = readiness(facts({ issued: [] }), now); assert.ok(codes(r).includes('invoice_missing')); assert.ok(codes(r).includes('packing_missing')); });
test('a booked or moving shipment with no transport document is blocked', () => { assert.ok(codes(readiness(facts({ ship: { status: 'booked' } }), now)).includes('transport_doc_missing')); assert.ok(!codes(readiness(facts({ ship: { status: 'booked', bill_no: 'AWB123' } }), now)).includes('transport_doc_missing')); });
test('landed cost gaps are named, never guessed', () => { const r = readiness(facts({ ship: { freight: 0, duty_pct: 0, agent_fee: 0, fx_rate: null } }), now); assert.strictEqual(r.cost_gaps.length, 4); assert.ok(/not guess|Missing/.test(r.warnings.find((w) => w.code === 'cost_incomplete').message + r.warnings.find((w) => w.code === 'cost_incomplete').fix)); });
test('freight is not demanded when the Incoterm already includes it', () => assert.ok(!readiness(facts({ ship: { freight: 0, incoterm: 'CIF' } }), now).cost_gaps.includes('freight')));
test('an expected arrival in the past is blocked; customs hold is blocked', () => { assert.ok(codes(readiness(facts({ ship: { status: 'in_transit', bill_no: 'B1', eta: now - 3 * 86400 } }), now)).includes('eta_passed')); assert.ok(codes(readiness(facts({ ship: { status: 'arrived', bill_no: 'B1', customs_status: 'held' } }), now)).includes('customs_held')); });

console.log('\nCompliance');
test('regulated goods go to compliance and block; they are never self-approved', () => {
  const r = readiness(facts({ flags: [{ slug: 'batteries', label: 'Batteries', action: 'review', why: 'mentions "lithium"', item: 'Lithium pack' }] }), now);
  assert.ok(codes(r).includes('restricted_review')); assert.strictEqual(r.needs_compliance, true); assert.strictEqual(r.ready, false);
});
test('a prohibited class says do not ship', () => { const r = readiness(facts({ flags: [{ slug: 'weapons', label: 'Weapons', action: 'block', why: 'x', item: 'y' }] }), now); assert.ok(/Do not ship/.test(r.blockers.find((b) => b.code === 'restricted_blocked').fix)); });
test('required permit reminders still pending block; ticked or optional ones do not', () => {
  const pend = { items: [{ required: true, status: 'pending', title: 'SON conformity' }, { required: true, status: 'done', title: 'Done one' }, { required: false, status: 'pending', title: 'Optional' }] };
  const r = readiness(facts({ checklist: pend }), now); assert.ok(codes(r).includes('checklist_open')); assert.ok(/1 required/.test(r.blockers.find((b) => b.code === 'checklist_open').message));
  assert.ok(!codes(readiness(facts({ checklist: { items: [{ required: true, status: 'done', title: 'x' }] } }), now)).includes('checklist_open'));
});

console.log('\nExports');
const ex = (o = {}) => facts({ ...o, ship: { direction: 'export', party_name: 'Buyer GmbH', party_country: 'DE', ...o.ship } });
test('an export needs the buyer address and country; tax id only warns', () => { const r = readiness(ex({ ship: { party_address: '', party_country: '', party_tax_id: '' } }), now); assert.ok(codes(r).includes('buyer_address')); assert.ok(codes(r).includes('buyer_country')); assert.ok(codes(r, 'warnings').includes('buyer_tax_id')); });
test('short stock blocks an export', () => { const r = readiness(ex({ stock: [{ description: 'Phone case', need: 10, have: 4 }] }), now); assert.ok(codes(r).includes('stock_short')); });
test('exports do not get import-only cost or supplier checks', () => { const r = readiness(ex({ ship: { freight: 0 } }), now); assert.strictEqual(r.cost_gaps.length, 0); });
test('delivered and cancelled are never "ready"', () => { assert.strictEqual(readiness(facts({ ship: { status: 'delivered' } }), now).ready, false); assert.strictEqual(readiness(facts({ ship: { status: 'cancelled' } }), now).ready, false); });
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
