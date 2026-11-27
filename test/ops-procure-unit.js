'use strict';
// Scoring, landed cost and comparison maths (lib/ops/procure.js). No database. Run with: npm run test:ops-procure:unit
const assert = require('assert');
const PR = require('../lib/ops/procure');
let passed = 0, failed = 0;
const test = (n, f) => { try { f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); } };
const V = (o = {}) => ({ name: 'V', country: 'NG', status: 'approved', verification: { registration: { state: 'verified' }, contact: { state: 'verified' } }, payment_days: 30, return_policy: 'x', warranty: 'y', ...o });
const Q = (o = {}) => ({ id: 1, unit_price: 100, currency: 'NGN', moq: 1, qty_available: 1000, lead_days: 5, ...o });
const cmp = (entries, req = { qty: 100 }, rates = {}) => PR.compare({ request: req, entries, rates });

console.log('\nWeights');
test('the default weights are the ones in the brief and add up to 100', () => { assert.strictEqual(Object.values(PR.DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0), 100); assert.strictEqual(PR.DEFAULT_WEIGHTS.quality, 20); });
test('bad weights fall back to the defaults', () => { assert.deepStrictEqual(PR.normalizeWeights({ quality: -5, landed_cost: 'x' }).quality, 20); assert.deepStrictEqual(PR.normalizeWeights(null), PR.DEFAULT_WEIGHTS); });
test('changing a weight changes the ranking', () => {
  const a = { quote: Q({ id: 1, unit_price: 100 }), vendor: V({ name: 'Cheap' }), rating: { quality: 10 } }, b = { quote: Q({ id: 2, unit_price: 130 }), vendor: V({ name: 'Good' }), rating: { quality: 100 } };
  const heavyQ = PR.compare({ request: { qty: 10 }, entries: [a, b], weights: { quality: 100, landed_cost: 1 }, rates: {} }), heavyC = PR.compare({ request: { qty: 10 }, entries: [a, b], weights: { quality: 1, landed_cost: 100 }, rates: {} });
  assert.strictEqual(heavyQ.rows[0].vendor.name, 'Good'); assert.strictEqual(heavyC.rows[0].vendor.name, 'Cheap');
});

console.log('\nVerification');
test('a vendor cannot be approved without verified registration and contact', () => { assert.ok(!PR.canBeApproved({}).ok); assert.ok(!PR.canBeApproved({ registration: { state: 'vendor_supplied' }, contact: { state: 'verified' } }).ok); assert.ok(PR.canBeApproved({ registration: { state: 'verified' }, contact: { state: 'verified' } }).ok); });
test('what the vendor says counts for less than what a person checked', () => { assert.ok(PR.verifiedShare({ registration: { state: 'vendor_supplied' } }) < PR.verifiedShare({ registration: { state: 'verified' } })); });

console.log('\nLanded cost');
test('a local price is goods + freight + VAT on goods and freight', () => { const l = PR.quoteLanded({ country: 'NG' }, Q({ unit_price: 100, freight: 100, vat_pct: 10 }), 10, {}); assert.strictEqual(l.ngn, 1000 + 100 + 110); assert.strictEqual(l.estimated, false); });
test('a foreign price adds duty, VAT and charges and is marked as an estimate', () => { const l = PR.quoteLanded({ country: 'CN' }, Q({ unit_price: 10, currency: 'USD', incoterm: 'FOB', freight: 100, duty_pct: 10, vat_pct: 7.5 }), 100, { USD: 1000 }); assert.ok(l.ngn > 1100 * 1000); assert.ok(l.estimated); });
test('with no exchange rate the cost is unknown, never guessed', () => { const l = PR.quoteLanded({ country: 'CN' }, Q({ currency: 'USD' }), 10, {}); assert.strictEqual(l.ngn, null); assert.ok(l.error); const m = PR.quoteLanded({ country: 'NG' }, Q({ currency: 'EUR' }), 10, {}); assert.strictEqual(m.ngn, null); });

console.log('\nComparison');
test('only approved vendors on valid, sufficient quotes qualify', () => {
  const now = 1000, c = PR.compare({ now, request: { qty: 100 }, rates: {}, entries: [
    { quote: Q({ id: 1 }), vendor: V({ name: 'ok' }) }, { quote: Q({ id: 2 }), vendor: V({ name: 'review', status: 'under_review' }) }, { quote: Q({ id: 3, valid_until: 5 }), vendor: V({ name: 'expired' }) },
    { quote: Q({ id: 4, moq: 500 }), vendor: V({ name: 'moq' }) }, { quote: Q({ id: 5, qty_available: 10 }), vendor: V({ name: 'short' }) }, { quote: Q({ id: 6 }), vendor: V({ name: 'susp', status: 'suspended' }) }] });
  assert.deepStrictEqual(c.rows.filter((r) => r.qualified).map((r) => r.vendor.name), ['ok']);
});
test('the cheapest advertised price does not win on its own', () => {
  const c = cmp([{ quote: Q({ id: 1, unit_price: 90 }), vendor: V({ name: 'Cheap', warranty: '', return_policy: '', verification: {} }), rating: { quality: 20, responsiveness: 20 } }, { quote: Q({ id: 2, unit_price: 100 }), vendor: V({ name: 'Solid' }), rating: { quality: 95, responsiveness: 95 } }]);
  assert.strictEqual(c.highlights.cheapest_qualifying, 1); assert.strictEqual(c.highlights.recommended, 2);
});
test('a near tie goes to the preferred supplier', () => {
  const c = cmp([{ quote: Q({ id: 1 }), vendor: V({ name: 'A', status: 'approved' }) }, { quote: Q({ id: 2 }), vendor: V({ name: 'B', status: 'preferred' }) }]); assert.strictEqual(c.highlights.recommended, 2);
});
test('fewer than three qualified quotations is flagged; none gives no recommendation', () => {
  assert.ok(cmp([{ quote: Q(), vendor: V() }]).notes.some((n) => /Only 1 qualified/.test(n)));
  const none = cmp([{ quote: Q(), vendor: V({ status: 'under_review' }) }]); assert.strictEqual(none.highlights.recommended, null); assert.strictEqual(none.recommended_reason, '');
});
test('a score says how much of the weight had real data; missing data is left out, not zero', () => {
  const c = cmp([{ quote: Q({ qty_available: null }), vendor: V() }]), e = c.rows[0].evaluation;
  assert.strictEqual(e.factors.quality.score, null); assert.ok(e.coverage < 100); assert.ok(e.score > 0);
});
test('delivery history changes the delivery factor', () => {
  const good = cmp([{ quote: Q(), vendor: V(), stats: { receipts: 3, on_time_pct: 100, fill_pct: 100 } }]).rows[0].evaluation.factors.delivery.score, bad = cmp([{ quote: Q(), vendor: V(), stats: { receipts: 3, on_time_pct: 0, fill_pct: 50 } }]).rows[0].evaluation.factors.delivery.score;
  assert.ok(good > bad);
});
test('a quotation with an unknown cost is flagged and not ranked on cost', () => {
  const c = cmp([{ quote: Q({ id: 1, currency: 'USD' }), vendor: V({ country: 'CN' }) }, { quote: Q({ id: 2 }), vendor: V() }]);
  assert.strictEqual(c.rows.find((r) => r.quote.id === 1).qualified, false); assert.ok(c.notes.some((n) => /exchange rate/.test(n)));
});

console.log('\nPurchase order totals');
test('a local PO carries VAT; a foreign one leaves duty and VAT to customs', () => {
  assert.strictEqual(PR.poTotals({ vendor: V(), quote: Q({ unit_price: 100, freight: 50, vat_pct: 10 }), qty: 10 }).total, 1000 + 50 + 105);
  const f = PR.poTotals({ vendor: V({ country: 'CN' }), quote: Q({ unit_price: 100, freight: 50, vat_pct: 10, duty_pct: 20 }), qty: 10 }); assert.strictEqual(f.tax, 0); assert.strictEqual(f.total, 1050);
});
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
