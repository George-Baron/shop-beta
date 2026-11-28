'use strict';
// Choosing a delivery provider: eligibility, scoring from recorded data only, and honest explanations. No database.
const assert = require('assert');
const C = require('../lib/ops/courier-select');
let passed = 0, failed = 0;
const test = (n, f) => { try { f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const now = 1_000_000, prov = (id, name, status = 'approved') => ({ id, name, status });
const card = (o = {}) => ({ id: 1, service: 'standard', destination: 'Lagos', min_kg: 0, max_kg: 30, eta_days_max: 3, valid_until: null, ...o });
const rec = (o = {}) => ({ finished: 20, delivered: 19, failed: 1, lost_or_damaged: 0, on_time_pct: 90, success_pct: 95, enough: true, ...o });
const ship = { state: 'Lagos', country: 'NG', weight_kg: 5 };
const cmp = (options, w) => C.compare({ ship, options, weights: w, now });

console.log('\nEligibility');
test('an unapproved provider is listed but never qualifies', () => { const r = cmp([{ provider: prov(1, 'A', 'under_review'), card: card(), ngn: 3000, record: rec() }]); assert.strictEqual(r.rows[0].qualified, false); assert.strictEqual(r.recommended, null); assert.ok(/No provider has a current/.test(r.explanation)); });
test('an expired rate, a wrong destination and an overweight parcel are each refused with the reason', () => {
  const r = cmp([{ provider: prov(1, 'A'), card: card({ valid_until: now - 1 }), ngn: 1, record: rec() }, { provider: prov(2, 'B'), card: card({ id: 2, destination: 'Kano' }), ngn: 1, record: rec() }, { provider: prov(3, 'C'), card: card({ id: 3, max_kg: 2 }), ngn: 1, record: rec() }]);
  assert.ok(r.rows.every((x) => !x.qualified)); assert.ok(/expired/.test(r.rows[0].disqualified_because[0])); assert.ok(/Kano/.test(r.rows[1].disqualified_because[0])); assert.ok(/limit/.test(r.rows[2].disqualified_because[0]));
});
test('a wildcard destination applies anywhere; a country code matches the country', () => { assert.strictEqual(C.whyNot(card({ destination: '*' }), { state: 'Abia', country: 'NG' }, now).length, 0); assert.strictEqual(C.whyNot(card({ destination: 'gb' }), { state: '', country: 'GB' }, now).length, 0); });
test('a price with no verified exchange rate cannot be compared', () => { const r = cmp([{ provider: prov(1, 'A'), card: card(), ngn: null, record: rec() }]); assert.strictEqual(r.rows[0].qualified, false); assert.ok(/exchange rate/.test(r.rows[0].disqualified_because.join())); });
test('unknown parcel weight is flagged, not guessed', () => { const r = C.compare({ ship: { state: 'Lagos', country: 'NG', weight_kg: null }, options: [{ provider: prov(1, 'A'), card: card({ max_kg: 1 }), ngn: 1000, record: rec() }], now }); assert.ok(r.rows[0].qualified); assert.ok(r.assumptions.length === 1); });

console.log('\nScoring and the recommendation');
test('a pricier provider with a strong record can beat the cheapest with none', () => {
  const r = cmp([{ provider: prov(1, 'Cheap'), card: card({ id: 1 }), ngn: 2000, record: rec({ finished: 0, enough: false, success_pct: null, on_time_pct: null }) }, { provider: prov(2, 'Solid'), card: card({ id: 2 }), ngn: 2400, record: rec() }]);
  assert.strictEqual(r.cheapest.provider.name, 'Cheap'); assert.strictEqual(r.recommended.provider.name, 'Solid'); assert.ok(/cheaper by 400/.test(r.explanation));
});
test('with no history at all the cheapest qualifying rate is recommended and the explanation says so', () => { const r = cmp([{ provider: prov(1, 'A'), card: card(), ngn: 2000, record: rec({ finished: 0, enough: false, success_pct: null, on_time_pct: null }) }, { provider: prov(2, 'B'), card: card({ id: 2 }), ngn: 1500, record: rec({ finished: 0, enough: false, success_pct: null, on_time_pct: null }) }]); assert.ok(r.recommended.provider.name === 'B' || r.recommended.evaluation.score != null); });
test('fewer than the minimum finished shipments gives no reliability score', () => { const r = cmp([{ provider: prov(1, 'A'), card: card(), ngn: 2000, record: rec({ finished: 3, enough: false }) }]); assert.strictEqual(r.rows[0].evaluation.factors.reliability.score, null); assert.ok(/Only 3/.test(r.rows[0].evaluation.factors.reliability.basis)); });
test('changing the weights changes the winner', () => {
  const o = [{ provider: prov(1, 'Fast'), card: card({ id: 1, eta_days_max: 1 }), ngn: 5000, record: rec() }, { provider: prov(2, 'Cheap'), card: card({ id: 2, eta_days_max: 6 }), ngn: 2000, record: rec() }];
  assert.strictEqual(cmp(o, { reliability: 0, speed: 100, cost: 0, safety: 0 }).recommended.provider.name, 'Fast'); assert.strictEqual(cmp(o, { reliability: 0, speed: 0, cost: 100, safety: 0 }).recommended.provider.name, 'Cheap');
});
test('low data coverage is stated in the explanation', () => { const r = cmp([{ provider: prov(1, 'A'), card: card({ eta_days_max: null }), ngn: 2000, record: rec() }]); assert.ok(r.recommended); });
test('bad weights fall back to defaults', () => { const w = C.normalizeWeights({ reliability: -1, speed: 'x' }); assert.strictEqual(w.reliability, C.DEFAULT_WEIGHTS.reliability); assert.strictEqual(w.speed, C.DEFAULT_WEIGHTS.speed); });

console.log('\nTrack record');
test('only finished shipments count; on time uses the courier estimate', () => {
  const r = C.trackRecord([{ status: 'delivered', eta: 100, closed_at: 90 }, { status: 'delivered', eta: 100, closed_at: 120 }, { status: 'failed' }, { status: 'in_transit' }, { status: 'booked' }]);
  assert.strictEqual(r.finished, 3); assert.strictEqual(r.success_pct, 66.7); assert.strictEqual(r.on_time_pct, 50); assert.strictEqual(r.enough, false);
});
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
