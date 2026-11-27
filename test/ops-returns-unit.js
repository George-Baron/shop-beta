'use strict';
// Return assessment rules, no database. Run with: npm run test:ops-returns:unit
const assert = require('assert');
const { assess } = require('../lib/ops/returns-assess'), P = require('../lib/ops/policy');
let passed = 0, failed = 0;
const test = (n, f) => { try { f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); } };
const f = (o = {}) => ({ reason: 'faulty', condition: 'damaged', packaging: 'original', requested_ngn: 5000, max_refund_ngn: 6000, photos: 2, vendors: [], prior_settled_90d: 0, thresholds: P.DEFAULT_THRESHOLDS, ...o });
test('fault with photos: approve in full, routine level', () => { const a = assess(f()); assert.strictEqual(a.action, 'approve_full'); assert.strictEqual(a.amount_ngn, 5000); assert.strictEqual(a.approval_level, 1); });
test('fault without a photo: ask for evidence, do not approve', () => { const a = assess(f({ photos: 0 })); assert.strictEqual(a.action, 'ask_evidence'); assert.ok(a.evidence_missing.length); });
test('missing parts needs no photo', () => assert.strictEqual(assess(f({ reason: 'missing_parts', photos: 0 })).action, 'approve_full'));
test('change of mind: unopened full, opened a person decides, used or damaged reject', () => {
  assert.strictEqual(assess(f({ reason: 'changed_mind', condition: 'unopened' })).action, 'approve_full');
  assert.strictEqual(assess(f({ reason: 'changed_mind', condition: 'opened_unused' })).action, 'needs_decision');
  assert.strictEqual(assess(f({ reason: 'changed_mind', condition: 'used' })).action, 'reject');
  const d = assess(f({ reason: 'changed_mind', condition: 'damaged' })); assert.strictEqual(d.action, 'reject'); assert.strictEqual(d.amount_ngn, 0);
});
test('unknown reason goes to a person', () => assert.strictEqual(assess(f({ reason: 'other' })).action, 'needs_decision'));
test('nothing left on the order: reject, no money', () => { const a = assess(f({ max_refund_ngn: 0 })); assert.strictEqual(a.action, 'reject'); assert.strictEqual(a.amount_ngn, 0); assert.strictEqual(a.approval_level, 0); });
test('amount above what is left is capped and flagged', () => { const a = assess(f({ requested_ngn: 9000, max_refund_ngn: 6000 })); assert.strictEqual(a.amount_ngn, 6000); assert.ok(a.flags.length); });
test('approval level follows the refund thresholds', () => {
  assert.strictEqual(assess(f({ requested_ngn: 100000, max_refund_ngn: 1e6 })).approval_level, 1);
  assert.strictEqual(assess(f({ requested_ngn: 100001, max_refund_ngn: 1e6 })).approval_level, 2);
  assert.strictEqual(assess(f({ requested_ngn: 600000, max_refund_ngn: 1e7 })).approval_level, 3);
  assert.strictEqual(assess(f({ requested_ngn: 3000000, max_refund_ngn: 1e7 })).approval_level, 4);
});
test('repeat returner is never recommended for straight approval', () => { const a = assess(f({ prior_settled_90d: 3 })); assert.strictEqual(a.action, 'needs_decision'); assert.ok(a.flags.some((x) => /90 days/.test(x))); assert.strictEqual(assess(f({ prior_settled_90d: 2 })).action, 'approve_full'); });
test('stock is never restocked without inspection', () => { for (const c of ['unopened', 'opened_unused', 'used', 'damaged']) assert.ok(/inspect/.test(assess(f({ condition: c })).restock)); assert.strictEqual(assess(f({ condition: 'damaged' })).restock, 'do_not_restock_until_inspected'); });
test('partner responsibility only for seller faults', () => {
  const v = [{ name: 'Acme', amount: 4000 }];
  assert.strictEqual(assess(f({ vendors: v })).supplier_responsibility.charge_vendor, true);
  assert.strictEqual(assess(f({ vendors: v, reason: 'changed_mind', condition: 'unopened' })).supplier_responsibility.charge_vendor, false);
  assert.strictEqual(assess(f()).supplier_responsibility.charge_vendor, false);
});
test('damaged item with a non-fault reason is flagged', () => assert.ok(assess(f({ reason: 'changed_mind', condition: 'damaged' })).flags.some((x) => /damaged/.test(x))));
test('past-window return opened by staff is flagged', () => assert.ok(assess(f({ past_window: true })).flags.some((x) => /window/.test(x))));
test('it only ever recommends: no field commits money or stock', () => { const a = assess(f()); assert.ok(!('execute' in a) && !('refund' in a)); assert.ok(['approve_full', 'reject', 'ask_evidence', 'needs_decision'].includes(a.action)); });
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
