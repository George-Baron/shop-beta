'use strict';
// Daily, weekly and monthly operations reports. Built by code from recorded data and stored as they were, so a report never changes after the fact.
// No model writes any figure. Times are Africa/Lagos (UTC+1, no daylight saving): a "day" runs from 00:00 to 24:00 Lagos time.
const { get, all, run, now } = require('../db');
const D = require('./data');
const I = require('./intel');
const LG = require('./logistics');
const St = require('./store');
const OFFSET = 3600, DAY = 86400;
const num = (v) => Number(v) || 0;
const ngn = (n) => '₦' + Math.round(num(n)).toLocaleString('en-NG');

// The most recent COMPLETE period of each kind that ended before `t`. Returns { start, end } as epoch seconds (end exclusive).
function lastPeriod(kind, t) {
  const lagos = t + OFFSET, dayStart = Math.floor(lagos / DAY) * DAY;           // today 00:00 Lagos, expressed on the shifted clock
  let s, e;
  if (kind === 'daily') { e = dayStart; s = e - DAY; }
  else if (kind === 'weekly') { const dow = new Date(dayStart * 1000).getUTCDay(), sinceMon = (dow + 6) % 7; e = dayStart - sinceMon * DAY; s = e - 7 * DAY; }
  else { const d = new Date(dayStart * 1000); e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; const p = new Date((e - 1) * 1000); s = Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), 1) / 1000; }
  return { start: s - OFFSET, end: e - OFFSET };
}
const label = (kind, p) => { const d = (x) => new Date((x + OFFSET) * 1000).toISOString().slice(0, 10); return kind === 'daily' ? `Daily report ${d(p.start)}` : kind === 'weekly' ? `Weekly report ${d(p.start)} to ${d(p.end - 1)}` : `Monthly report ${new Date((p.start + OFFSET) * 1000).toISOString().slice(0, 7)}`; };

async function build(kind, p) {
  const q = { from: p.start, to: p.end - 1 }, days = Math.max(1, Math.round((p.end - p.start) / DAY));
  const [orders, delivery, profit, perf, sup, fc, risk] = await Promise.all([D.orders(q), D.deliveryPerformance(q), I.profitability({ from: p.start, to: p.end - 1 }), I.performance({ days }), I.supplierScorecards({ days: Math.max(days, 30) }), I.demandForecast({ limit: 10 }), I.atRisk()]);
  const ex = await get("SELECT COUNT(*) raised, COUNT(*) FILTER (WHERE severity IN ('high','critical')) serious, COUNT(*) FILTER (WHERE status IN ('resolved','closed')) resolved FROM ops_exceptions WHERE created>=? AND created<?", p.start, p.end);
  const openEx = await all("SELECT severity, COUNT(*) n FROM ops_exceptions WHERE status IN ('open','acknowledged') GROUP BY severity");
  const ap = await get("SELECT COUNT(*) n, COUNT(*) FILTER (WHERE status='approved' OR status='completed') approved, COUNT(*) FILTER (WHERE status='rejected') rejected, COUNT(*) FILTER (WHERE status='pending') pending FROM ops_approvals WHERE created>=? AND created<?", p.start, p.end);
  const rev = await get(`SELECT COALESCE(SUM(o.total),0) revenue, COUNT(*) n FROM orders o WHERE ${D.SALE} AND o.created>=? AND o.created<?`, p.start, p.end);
  const ship = await LG.scorecards();
  const data = { period: p, orders, delivery_performance: delivery, sales: { orders: num(rev.n), revenue: num(rev.revenue) }, profitability: profit, exceptions: { raised: num(ex.raised), serious: num(ex.serious), resolved: num(ex.resolved), open_now: Object.fromEntries(openEx.map((x) => [x.severity, num(x.n)])) },
    approvals: { requested: num(ap.n), approved: num(ap.approved), rejected: num(ap.rejected), pending_now: num(ap.pending) }, ai_performance: perf, suppliers: sup.suppliers, delivery_providers: ship, stock_risk: { at_risk_count: fc.at_risk, top: fc.products.filter((x) => x.will_stock_out_before_restock).slice(0, 10), forecast_accuracy: fc.accuracy }, orders_at_risk: { count: risk.count, top: risk.at_risk.slice(0, 10) } };
  const h = [];
  h.push(`${data.sales.orders} order(s) placed worth ${ngn(data.sales.revenue)}.`);
  h.push(`${num(orders.delivered)} delivered, ${num(orders.cancelled)} cancelled, ${num(delivery.failed_deliveries !== undefined ? delivery.failed_deliveries : orders.failed_deliveries)} failed delivery attempt(s).`);
  if (profit.totals.gross_margin_pct != null) h.push(`Gross margin ${profit.totals.gross_margin_pct}% on ${profit.orders_with_known_cost} of ${profit.orders_in_range} orders (${profit.coverage_pct}% had every cost recorded).`); else h.push(profit.orders_in_range ? `Margin could not be worked out: no order in this period had every product cost recorded.` : 'No sales in this period.');
  if (profit.negative_margin.length) h.push(`${profit.negative_margin.length} order(s) sold at a loss.`);
  h.push(`${data.exceptions.raised} operational issue(s) raised (${data.exceptions.serious} serious), ${data.exceptions.resolved} resolved; ${Object.values(data.exceptions.open_now).reduce((a, b) => a + b, 0)} open now.`);
  if (fc.at_risk) h.push(`${fc.at_risk} product(s) forecast to run out before they can be restocked.`);
  if (risk.count) h.push(`${risk.count} open order(s) are taking longer than usual.`);
  const under = sup.suppliers.filter((s) => /^Underperforming/.test(s.verdict)).length; if (under) h.push(`${under} supplier(s) are underperforming and need a decision.`);
  const underP = ship.filter((s) => /^Underperforming/.test(s.verdict)).length; if (underP) h.push(`${underP} delivery provider(s) are underperforming and need a decision.`);
  if (perf.orders.delivered_without_proof) h.push(`${perf.orders.delivered_without_proof} delivered order(s) have no proof of delivery.`);
  return { data, headline: h };
}

// Make the report for the last complete period of this kind if it does not exist yet. Safe to call repeatedly.
async function ensure(kind, t = now()) {
  const p = lastPeriod(kind, t);
  if (await get('SELECT id FROM ops_reports WHERE kind=? AND period_start=?', kind, p.start)) return { kind, created: false };
  const { data, headline } = await build(kind, p);
  const r = await get('INSERT INTO ops_reports (kind,period_start,period_end,title,headline,data,generated_by,generated) VALUES (?,?,?,?,?::jsonb,?::jsonb,?,?) ON CONFLICT DO NOTHING RETURNING id', kind, p.start, p.end, label(kind, p), JSON.stringify(headline), JSON.stringify(data), St.AI_NAME || 'VELTO AI', now());
  if (r) await St.logAction({ agent: 'orchestrator', actor_kind: 'ai_autonomous', action_type: 'report.generate', description: `${label(kind, p)} generated`, related_type: 'report', related_id: String(r.id), status: 'done' });
  return { kind, created: !!r, id: r ? Number(r.id) : null };
}
// Runs from the worker every hour. A daily report appears once the new Lagos day has begun; weekly after Monday starts; monthly after the 1st.
async function ensureAll(t = now()) { const out = []; for (const k of ['daily', 'weekly', 'monthly']) out.push(await ensure(k, t)); return out; }
const list = async (kind = '') => (await all(`SELECT id, kind, period_start, period_end, title, headline, generated_by, generated FROM ops_reports ${kind ? 'WHERE kind=?' : ''} ORDER BY period_start DESC, id DESC LIMIT 60`, ...(kind ? [kind] : []))).map((r) => ({ ...r, id: Number(r.id), period_start: Number(r.period_start), period_end: Number(r.period_end), generated: Number(r.generated) }));
const getOne = async (id) => { const r = await get('SELECT * FROM ops_reports WHERE id=?', Number(id)); return r ? { ...r, id: Number(r.id), period_start: Number(r.period_start), period_end: Number(r.period_end), generated: Number(r.generated) } : null; };

module.exports = { lastPeriod, build, ensure, ensureAll, list, getOne, label };
