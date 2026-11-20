#!/usr/bin/env node
'use strict';
// Profit maths and dates for dropshipping money (no database). Run with: npm run test:dropship-money:unit
const assert = require('assert');
const M = require('../lib/dropship-money');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };
const base = { sell_price: 30000, qty: 2, paid: true, sent: true, cost_ngn: 21000, unit_cost: 10000, ship_cost: 500, refunds_ngn: 0, supplier_refunds_ngn: 0, costs: {}, fee_estimate: 0 };
(async () => {
  await test('profit = revenue - supplier cost - shipping - duty - fees - other, in whole Naira', () => {
    const p = M.lineProfit({ ...base, costs: { duty: 4000, shipping: 1000, handling: 300, other: 200, gateway_fee: 900 } });
    assert.strictEqual(p.revenue, 60000); assert.strictEqual(p.supplier_cost, 20000); assert.strictEqual(p.supplier_shipping, 1000); assert.strictEqual(p.duty, 4000); assert.strictEqual(p.extra_shipping, 1000);
    assert.strictEqual(p.fees, 900); assert.strictEqual(p.other, 500); assert.strictEqual(p.total_costs, 27400); assert.strictEqual(p.net_profit, 32600); assert.strictEqual(p.margin_pct, 54.3);
  });
  await test('the supplier cost splits into goods and shipping without losing a kobo', () => {
    const p = M.lineProfit({ ...base, cost_ngn: 10001, qty: 1, unit_cost: 10, ship_cost: 3 });
    assert.strictEqual(p.supplier_cost + p.supplier_shipping, 10001); assert.ok(Number.isInteger(p.supplier_cost));
  });
  await test('nothing is owed to the supplier before we order, and nothing is earned before the customer pays', () => {
    const a = M.lineProfit({ ...base, sent: false }); assert.strictEqual(a.supplier_cost + a.supplier_shipping, 0); assert.strictEqual(a.net_profit, 60000);
    const b = M.lineProfit({ ...base, paid: false, sent: false }); assert.strictEqual(b.revenue, 0); assert.strictEqual(b.net_profit, 0); assert.strictEqual(b.margin_pct, null);
  });
  await test('a cancelled item refunded in full after we ordered shows the loss; a supplier refund brings it back', () => {
    const lost = M.lineProfit({ ...base, refunds_ngn: 60000, fee_estimate: 1000 }); assert.strictEqual(lost.net_profit, -22000);
    const back = M.lineProfit({ ...base, refunds_ngn: 60000, fee_estimate: 1000, supplier_refunds_ngn: 21000 }); assert.strictEqual(back.net_profit, -1000, 'only the payment fee is lost');
  });
  await test('a recorded payment fee replaces the estimate; the estimate is flagged', () => {
    assert.strictEqual(M.lineProfit({ ...base, fee_estimate: 850.4 }).fees, 850); assert.strictEqual(M.lineProfit({ ...base, fee_estimate: 850.4 }).fee_estimated, true);
    const p = M.lineProfit({ ...base, fee_estimate: 850, costs: { gateway_fee: 640 } }); assert.strictEqual(p.fees, 640); assert.strictEqual(p.fee_estimated, false);
  });
  await test('an item whose cost was never worked out (no exchange rate) is flagged, not guessed', () => {
    const p = M.lineProfit({ ...base, cost_ngn: null }); assert.strictEqual(p.cost_known, false); assert.strictEqual(p.supplier_cost, 0);
  });
  await test('periods use Lagos days, the end day is included, and bad or huge periods are refused', () => {
    const p = M.period({ from: '2026-11-01', to: '2026-11-30' }); assert.strictEqual(p.from, Date.parse('2026-11-01T00:00:00+01:00') / 1000); assert.strictEqual(p.to, Date.parse('2026-12-01T00:00:00+01:00') / 1000);
    assert.throws(() => M.period({ from: 'nope' }), /start date/); assert.throws(() => M.period({ from: '2026-11-02', to: '2026-11-01' }), /before/); assert.throws(() => M.period({ from: '2020-01-01', to: '2026-01-01' }), /two years/);
  });
  await test('the return and cost types are fixed lists', () => {
    assert.deepStrictEqual(Object.keys(M.COST_KINDS).sort(), ['duty', 'gateway_fee', 'handling', 'other', 'shipping']);
    assert.deepStrictEqual(M.RETURN_NEXT.closed, []); assert.ok(M.RETURN_NEXT.requested.includes('approved') && !M.RETURN_NEXT.requested.includes('received'));
  });
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})();
