'use strict';
// Forecasting, accuracy measurement, stage-risk, margins, verdicts and report periods. No database.
const assert = require('assert');
const F = require('../lib/ops/forecast'), I = require('../lib/ops/intel'), R = require('../lib/ops/reports');
let passed = 0, failed = 0;
const test = (n, f) => { try { f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const flat = (n, v) => Array.from({ length: n }, () => v);

console.log('\nDemand forecast');
test('under 14 days of history gives no forecast and says why', () => { const f = F.forecast(flat(10, 3), { stock: 5 }); assert.strictEqual(f.confidence, 'none'); assert.strictEqual(f.daily_rate, undefined); assert.ok(/at least 14/.test(f.basis)); });
test('steady demand: rate, days of stock, stock-out before restock and a reorder quantity', () => {
  const f = F.forecast(flat(90, 3), { stock: 15, on_order: 0, lead_days: 7, cover_days: 7 });
  assert.strictEqual(f.daily_rate, 3); assert.strictEqual(f.days_of_stock, 5); assert.strictEqual(f.will_stock_out_before_restock, true); assert.strictEqual(f.reorder_qty, 27); assert.strictEqual(f.confidence, 'high');
});
test('incoming stock is counted before warning of a stock-out', () => { const f = F.forecast(flat(90, 3), { stock: 15, on_order: 30, lead_days: 7 }); assert.strictEqual(f.will_stock_out_before_restock, false); });
test('rising and falling demand are detected', () => { assert.strictEqual(F.forecast([...flat(60, 1), ...flat(7, 5)], {}).trend, 'rising'); assert.strictEqual(F.forecast([...flat(60, 5), ...flat(7, 1)], {}).trend, 'falling'); });
test('very few sales means low confidence and no suggested order quantity', () => { const d = flat(30, 0); d[3] = 1; d[20] = 1; const f = F.forecast(d, { stock: 0 }); assert.strictEqual(f.confidence, 'low'); assert.strictEqual(f.reorder_qty, null); });
test('zero demand never divides by zero', () => { const f = F.forecast(flat(40, 0), { stock: 5 }); assert.strictEqual(f.days_of_stock, null); assert.strictEqual(f.will_stock_out_before_restock, false); });
test('the backtest measures real error: perfect steady demand has ~0%, a sudden jump does not', () => {
  assert.strictEqual(F.backtest(flat(90, 3)).mape_pct, 0); const jump = [...flat(70, 2), ...flat(20, 8)]; assert.ok(F.backtest(jump).mape_pct > 15);
  assert.strictEqual(F.backtest(flat(40, 3)), null);
});

console.log('\nAt-risk prediction');
test('a stage with too few past orders is not predicted', () => assert.strictEqual(F.stageRisk([10, 20, 30], 500).known, false));
test('slower than most past orders is flagged by how much', () => { const d = Array.from({ length: 20 }, (_, i) => 10 + i * 5); assert.strictEqual(F.stageRisk(d, 5).level, 'normal'); assert.strictEqual(F.stageRisk(d, 90).level, 'medium'); assert.strictEqual(F.stageRisk(d, 500).level, 'high'); });

console.log('\nMargins');
const row = (o) => ({ goods: 10000, own_unknown: 0, own_cogs: 6000, ds_cost: 0, ds_unknown: 0, commission: 500, delivery_fee: 1000, ship_cost: 0, ship_rows: 0, ship_unknown: 0, ...o });
test('a fully costed order has a margin; delivery cost not recorded is stated, not invented', () => { const m = I.margin(row()); assert.strictEqual(m.known, true); assert.strictEqual(m.gross_margin, 3500); assert.strictEqual(m.gross_margin_pct, 35); assert.strictEqual(m.delivery_cost_recorded, false); assert.ok(m.gaps.some((g) => /delivery cost not recorded/.test(g))); });
test('a missing product cost makes the margin unknown, never zero-cost', () => { const m = I.margin(row({ own_unknown: 1 })); assert.strictEqual(m.known, false); assert.ok(m.gaps.some((g) => /catalogue cost missing/.test(g))); });
test('a recorded courier cost reduces contribution; a foreign-currency one is not guessed', () => { const m = I.margin(row({ ship_rows: 1, ship_cost: 1500 })); assert.strictEqual(m.delivery_cost_recorded, true); assert.strictEqual(m.contribution, 3500 + 1000 - 1500); assert.strictEqual(I.margin(row({ ship_rows: 1, ship_unknown: 1 })).delivery_cost_recorded, false); });
test('dropship cost counts and an unrecorded supplier cost makes it unknown', () => { assert.strictEqual(I.margin(row({ own_cogs: 0, ds_cost: 7000 })).gross_margin, 2500); assert.strictEqual(I.margin(row({ ds_unknown: 1 })).known, false); });
test('selling below cost is a negative margin', () => assert.ok(I.margin(row({ own_cogs: 11000 })).gross_margin < 0));

console.log('\nVerdicts');
test('too little history is not scored; poor results are flagged for a person; strong ones are called strong', () => {
  assert.ok(/Not enough/.test(I.verdict({ sample: 2, min: 5, success_pct: 100 }))); assert.ok(/Underperforming.*person decides/.test(I.verdict({ sample: 10, min: 5, success_pct: 70 })));
  assert.ok(/Underperforming/.test(I.verdict({ sample: 10, min: 3, success_pct: 99, on_time_pct: 50 }))); assert.strictEqual(I.verdict({ sample: 10, min: 5, success_pct: 97 }), 'Strong'); assert.strictEqual(I.verdict({ sample: 10, min: 5, success_pct: 90 }), 'Acceptable');
});
test('median ignores junk', () => { assert.strictEqual(I.median([5, 1, 3]), 3); assert.strictEqual(I.median([]), null); });

console.log('\nReport periods (Lagos time)');
const t = Date.UTC(2026, 10, 26, 17, 0) / 1000;      // Thu 26 Nov 2026 18:00 Lagos
test('daily is the previous full Lagos day', () => { const p = R.lastPeriod('daily', t); assert.strictEqual(new Date(p.start * 1000).toISOString(), '2026-11-24T23:00:00.000Z'); assert.strictEqual(p.end - p.start, 86400); });
test('weekly is the previous Monday to Sunday', () => { const p = R.lastPeriod('weekly', t); assert.strictEqual(new Date(p.start * 1000).toISOString(), '2026-11-15T23:00:00.000Z'); assert.strictEqual(p.end - p.start, 7 * 86400); });
test('monthly is the previous calendar month', () => { const p = R.lastPeriod('monthly', t); assert.strictEqual(new Date(p.start * 1000).toISOString(), '2026-09-30T23:00:00.000Z'); assert.strictEqual(new Date(p.end * 1000).toISOString(), '2026-10-31T23:00:00.000Z'); });
test('just after midnight Lagos the new day is not in the report yet', () => { const a = R.lastPeriod('daily', Date.UTC(2026, 10, 26, 23, 30) / 1000), b = R.lastPeriod('daily', Date.UTC(2026, 10, 26, 22, 30) / 1000); assert.strictEqual(a.start - b.start, 86400); });
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
