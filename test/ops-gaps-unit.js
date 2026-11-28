'use strict';
// Pure rules for the gap-closing modules. Run with: npm run test:ops-gaps:unit
const assert = require('assert');
const { plan } = require('../lib/ops/fulfilment-plan'), RF = require('../lib/ops/rfq');
let passed = 0, failed = 0;
const test = (n, f) => { try { f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); } };
const wh = (id, name, a) => ({ id, name, available: a });
const L = (pid, qty) => ({ product_id: pid, name: 'P' + pid, qty });

test('one warehouse can fill it: single parcel, from the one with most spare stock', () => {
  const p = plan([L(1, 5), L(2, 3)], [wh(1, 'Lagos', { 1: 6, 2: 3 }), wh(2, 'Abuja', { 1: 50, 2: 50 })]);
  assert.strictEqual(p.mode, 'single'); assert.strictEqual(p.shipments[0].warehouse, 'Abuja'); assert.ok(p.complete);
});
test('no single warehouse: split across as few as possible', () => {
  const p = plan([L(1, 10), L(2, 10)], [wh(1, 'A', { 1: 10, 2: 0 }), wh(2, 'B', { 1: 0, 2: 10 }), wh(3, 'C', { 1: 4, 2: 4 })]);
  assert.strictEqual(p.mode, 'split'); assert.strictEqual(p.shipments.length, 2); assert.ok(p.complete);
  const tot = {}; for (const s of p.shipments) for (const l of s.lines) tot[l.product_id] = (tot[l.product_id] || 0) + l.qty; assert.deepStrictEqual(tot, { 1: 10, 2: 10 });
});
test('never ships more than a warehouse has, never more than ordered', () => {
  const ws = [wh(1, 'A', { 1: 3 }), wh(2, 'B', { 1: 4 })], p = plan([L(1, 6)], ws);
  for (const s of p.shipments) for (const l of s.lines) assert.ok(l.qty <= (s.warehouse === 'A' ? 3 : 4));
  assert.strictEqual(p.shipments.flatMap((s) => s.lines).reduce((a, l) => a + l.qty, 0), 6);
});
test('shortfall is reported, not invented', () => {
  const p = plan([L(1, 20)], [wh(1, 'A', { 1: 5 }), wh(2, 'B', { 1: 6 })]);
  assert.strictEqual(p.complete, false); assert.deepStrictEqual(p.shortfalls, [{ product_id: 1, name: 'P1', short_by: 9 }]); assert.ok(/procurement/i.test(p.note));
});
test('no stock anywhere: nothing shipped', () => { const p = plan([L(1, 2)], [wh(1, 'A', {})]); assert.strictEqual(p.mode, 'none'); assert.strictEqual(p.shipments.length, 0); assert.strictEqual(p.complete, false); });
test('the same product on two lines counts once, added together', () => {
  const p = plan([L(1, 60), L(1, 60)], [wh(1, 'A', { 1: 100 }), wh(2, 'B', { 1: 30 })]);
  assert.strictEqual(p.shipments.flatMap((s) => s.lines).reduce((a, l) => a + l.qty, 0), 120); assert.ok(p.complete); assert.strictEqual(p.mode, 'split');
});
test('empty order is not "complete"', () => assert.strictEqual(plan([], [wh(1, 'A', {})]).complete, false));
test('RFQ message identifies the sender, asks for the key terms and commits to nothing', () => {
  const m = RF.compose({ ref: 'REQ-00001', description: 'Kettle 1.7L', sku: 'K1', qty: 200, required_by: null }, { name: 'Acme Ltd' });
  assert.ok(/procurement assistant/i.test(m.body)); assert.ok(/does not commit/i.test(m.body)); assert.ok(/minimum order quantity/i.test(m.body) && /valid/i.test(m.body) && /lead time/i.test(m.body));
  assert.ok(m.subject.includes('REQ-00001')); assert.ok(!/we will pay|purchase order is attached|confirm the order/i.test(m.body));
});
test('RFQ reminder keeps the original request and names the reminder', () => {
  const m = RF.compose({ ref: 'REQ-1', description: 'X', qty: 1 }, { name: 'V' }, { followup: true }); assert.ok(/^Reminder:/.test(m.subject)); assert.ok(/gentle reminder/.test(m.body)); assert.ok(/Quantity: 1/.test(m.body));
});
test('reminders are limited', () => assert.ok(RF.MAX_FOLLOWUPS <= 3 && RF.WAIT_DAYS >= 1));
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
