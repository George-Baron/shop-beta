'use strict';
// Demand forecasting from real sales history. Pure: arrays of daily unit sales in, a forecast and an honest confidence out.
// With too little history it says so and gives no number. It also measures its own accuracy against what actually sold (backtest), so nobody has to trust it blindly.
const MIN_HISTORY_DAYS = 14;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);
const r2 = (n) => Math.round(n * 100) / 100;

// daily: units sold per day, OLDEST FIRST, covering from the first sale to today (zero days included). historyDays: days since the first sale.
function rate(daily) {
  const n = daily.length;
  if (n < MIN_HISTORY_DAYS) return null;
  const a7 = avg(daily.slice(-7)), a28 = avg(daily.slice(-28)), all = avg(daily.slice(-90));
  const r = n >= 28 ? 0.5 * a7 + 0.3 * a28 + 0.2 * all : 0.6 * a7 + 0.4 * avg(daily);
  return { daily_rate: r2(r), avg7: r2(a7), avg28: r2(a28), avg_all: r2(all) };
}
function trend(rt) { if (!rt) return 'unknown'; if (rt.avg28 === 0) return rt.avg7 > 0 ? 'rising' : 'steady'; const d = rt.avg7 / rt.avg28; return d >= 1.25 ? 'rising' : d <= 0.75 ? 'falling' : 'steady'; }
function confidence(daily) {
  const n = daily.length, units = sum(daily);
  if (n < MIN_HISTORY_DAYS) return 'none'; if (units < 5) return 'low';
  const zero = daily.filter((d) => d === 0).length / n;            // many empty days = lumpy demand, harder to predict
  if (n >= 60 && units >= 30 && zero < 0.6) return 'high'; if (n >= 28 && units >= 10) return 'medium'; return 'low';
}
// opts: { stock, on_order, lead_days, cover_days }
function forecast(daily, opts = {}) {
  const rt = rate(daily), conf = confidence(daily), stock = Math.max(0, Number(opts.stock) || 0), onOrder = Math.max(0, Number(opts.on_order) || 0), lead = Number(opts.lead_days) || 7, cover = Number(opts.cover_days) || 7;
  if (!rt) return { confidence: 'none', history_days: daily.length, units_sold: sum(daily), basis: `Only ${daily.length} day(s) of sales history; at least ${MIN_HISTORY_DAYS} are needed, so no forecast is made.`, stock, on_order: onOrder };
  const days = rt.daily_rate > 0 ? stock / rt.daily_rate : null, withIncoming = rt.daily_rate > 0 ? (stock + onOrder) / rt.daily_rate : null;
  const need = rt.daily_rate * (lead + cover) - stock - onOrder;
  return { confidence: conf, history_days: daily.length, units_sold: sum(daily), ...rt, trend: trend(rt), stock, on_order: onOrder, days_of_stock: days == null ? null : r2(days), days_of_stock_with_incoming: withIncoming == null ? null : r2(withIncoming),
    stockout_in_days: days == null ? null : Math.floor(days), will_stock_out_before_restock: days != null && withIncoming != null && withIncoming < lead, reorder_qty: conf === 'low' ? null : Math.max(0, Math.ceil(need)),
    basis: `${rt.daily_rate}/day from ${daily.length} days of sales; assumes ${lead} days to restock and ${cover} days of cover${conf === 'low' ? '. Confidence is low, so no order quantity is suggested' : ''}.` };
}
// Weekly backtest: for each of the last `weeks` weeks, forecast from the days before it and compare with what really sold. Needs at least 56 days.
function backtest(daily, weeks = 4) {
  if (daily.length < 56) return null;
  const out = [];
  for (let w = weeks; w >= 1; w--) {
    const end = daily.length - (w - 1) * 7, start = end - 7, before = daily.slice(0, start), rt = rate(before); if (!rt) continue;
    const actual = sum(daily.slice(start, end)), predicted = rt.daily_rate * 7; out.push({ predicted: r2(predicted), actual });
  }
  if (!out.length) return null;
  const tot = sum(out.map((x) => x.actual)), err = sum(out.map((x) => Math.abs(x.predicted - x.actual)));
  return { weeks: out.length, mape_pct: tot > 0 ? r2((err / tot) * 100) : null, bias_units: r2(sum(out.map((x) => x.predicted - x.actual))), samples: out };
}
// Open-order lateness risk: how long orders have taken in this stage before (minutes), versus how long this one has been waiting.
function stageRisk(durations, elapsedMin, minSample = 10) {
  const d = durations.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (d.length < minSample) return { known: false, basis: `Only ${d.length} past orders reached this stage (need ${minSample}), so no prediction.` };
  const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))], p50 = q(0.5), p75 = q(0.75), p90 = q(0.9);
  const level = elapsedMin > p90 ? 'high' : elapsedMin > p75 ? 'medium' : 'normal';
  return { known: true, level, typical_min: Math.round(p50), p75_min: Math.round(p75), p90_min: Math.round(p90), basis: `Typical ${Math.round(p50)} min, slower than 75% of ${d.length} past orders after ${Math.round(p75)} min, than 90% after ${Math.round(p90)} min.` };
}

module.exports = { MIN_HISTORY_DAYS, rate, confidence, forecast, backtest, stageRisk };
