'use strict';
// Advanced intelligence over REAL records: demand forecasts, supplier scorecards, order profitability, at-risk open orders and how well the AI itself is doing.
// Every figure is computed by code from the store's tables. Where a cost or a history is not recorded the result says so and leaves the number out;
// nothing is estimated silently, and "verified" and "estimated" are never mixed.
const { get, all, now } = require('../db');
const D = require('./data');
const F = require('./forecast');
const ST = require('./order-stage');
const LG = require('./logistics');
const num = (v) => Number(v) || 0;
const r1 = (n) => Math.round(n * 10) / 10;
const pct = (a, b) => (b > 0 ? r1((a / b) * 100) : null);
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

/* ---------- demand forecast ---------- */
async function demandForecast({ limit = 40 } = {}) {
  const t = now(), today = Math.floor(t / 86400), from = (today - 89) * 86400;
  const rows = await all(`SELECT oi.product_id pid, (o.created/86400) AS d, SUM(oi.qty) q FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE ${D.SALE} AND o.created>=? AND oi.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dropship_lines l WHERE l.order_item_id=oi.id) GROUP BY 1,2`, from);
  const by = new Map(); for (const r of rows) { const p = num(r.pid); if (!by.has(p)) by.set(p, new Map()); by.get(p).set(num(r.d), num(r.q)); }
  if (!by.size) return { products: [], accuracy: null, assumptions: assume(), note: 'No retail sales in the last 90 days.' };
  const prods = new Map((await all('SELECT id, name, stock FROM products WHERE id = ANY(?::bigint[])', [...by.keys()])).map((p) => [num(p.id), p]));
  const onOrder = await incoming(), out = [], mapes = [];
  for (const [pid, days] of by) {
    const p = prods.get(pid); if (!p) continue;
    const first = Math.min(...days.keys()), daily = []; for (let d = first; d <= today; d++) daily.push(days.get(d) || 0);
    const f = F.forecast(daily, { stock: num(p.stock), on_order: onOrder.get(pid) || 0, lead_days: 7, cover_days: 7 }), bt = F.backtest(daily);
    if (bt && bt.mape_pct != null) mapes.push(bt.mape_pct);
    out.push({ product_id: pid, name: p.name, ...f, backtest: bt });
  }
  out.sort((a, b) => (a.stockout_in_days == null ? 9e9 : a.stockout_in_days) - (b.stockout_in_days == null ? 9e9 : b.stockout_in_days));
  return { products: out.slice(0, Math.min(200, limit)), total_products: out.length, at_risk: out.filter((x) => x.will_stock_out_before_restock).length, no_forecast: out.filter((x) => x.confidence === 'none').length,
    accuracy: mapes.length ? { products_tested: mapes.length, mean_error_pct: r1(mapes.reduce((a, b) => a + b, 0) / mapes.length), basis: 'Average weekly forecast error over the last 4 weeks, measured only on products with 56+ days of history.' } : null, assumptions: assume() };
}
const assume = () => ['Retail stock only (wholesale stock is separate and never mixed in).', 'Dropshipped items are excluded; the supplier holds that stock.', 'Assumes 7 days to restock and 7 days of cover; set real supplier lead times to improve this.', 'Days before a product\'s first sale are not counted as zero-demand days.'];
async function incoming() {
  const m = new Map(), pos = await all("SELECT p.id, p.lines, COALESCE((SELECT SUM(qty_received) FROM ops_po_receipts r WHERE r.po_id=p.id),0) got FROM ops_purchase_orders p WHERE p.status IN ('approved','sent','accepted','dispatched') AND p.destination='retail'");
  for (const p of pos) { const lines = p.lines || [], ordered = lines.reduce((a, l) => a + num(l.qty), 0), left = ordered > 0 ? Math.max(0, 1 - num(p.got) / ordered) : 0; for (const l of lines) if (l.product_id) m.set(num(l.product_id), (m.get(num(l.product_id)) || 0) + Math.round(num(l.qty) * left)); }
  return m;
}

/* ---------- supplier scorecards ---------- */
// KPIs that exist in the records. Invoice accuracy, product quality and disputes are NOT recorded anywhere yet, so they are listed as not tracked rather than guessed.
function verdict({ sample, min, success_pct, on_time_pct }) {
  if (sample < min) return `Not enough history (${sample} of ${min} finished)`;
  if ((success_pct != null && success_pct < 85) || (on_time_pct != null && on_time_pct < 70)) return 'Underperforming: review, renegotiate or suspend (a person decides)';
  if ((success_pct != null && success_pct >= 95) && (on_time_pct == null || on_time_pct >= 90)) return 'Strong';
  return 'Acceptable';
}
async function supplierScorecards({ days = 90 } = {}) {
  const from = now() - days * 86400, out = [];
  for (const v of await all('SELECT id, name, status FROM ops_vendors ORDER BY name')) {
    const r = await get(`SELECT COUNT(*) n, COALESCE(SUM(qty_ordered),0) ordered, COALESCE(SUM(qty_received),0) got, COUNT(*) FILTER (WHERE on_time=1) ontime, COUNT(*) FILTER (WHERE on_time IS NOT NULL) timed FROM ops_po_receipts rc JOIN ops_purchase_orders p ON p.id=rc.po_id WHERE p.vendor_id=? AND rc.created>=?`, v.id, from);
    const po = await get("SELECT COUNT(*) FILTER (WHERE status NOT IN ('draft','pending_approval')) placed, COUNT(*) FILTER (WHERE status='cancelled') cancelled FROM ops_purchase_orders WHERE vendor_id=? AND created>=?", v.id, from);
    if (!num(po.placed) && !num(r.n)) continue;
    const fill = pct(num(r.got), num(r.ordered)), ot = pct(num(r.ontime), num(r.timed));
    out.push({ kind: 'purchasing', id: num(v.id), name: v.name, status: v.status, orders_placed: num(po.placed), received: num(r.n), fill_rate_pct: fill, on_time_pct: ot, cancelled_pct: pct(num(po.cancelled), num(po.placed) + 0), success_pct: fill, verdict: verdict({ sample: num(r.n), min: 3, success_pct: fill, on_time_pct: ot }) });
  }
  for (const s of await all("SELECT id, name, status FROM suppliers ORDER BY name")) {
    const r = await get(`SELECT COUNT(*) n, COUNT(*) FILTER (WHERE status='delivered') delivered, COUNT(*) FILTER (WHERE status IN ('delivered','refunded','returned','cancelled')) finished, COUNT(*) FILTER (WHERE status='cancelled') cancelled,
      COUNT(*) FILTER (WHERE issue_kind IS NOT NULL AND issue_kind<>'') issues, AVG((supplier_response_at - sent_at)/3600.0) FILTER (WHERE supplier_response_at IS NOT NULL AND sent_at IS NOT NULL) resp_h, AVG((shipped_at - sent_at)/3600.0) FILTER (WHERE shipped_at IS NOT NULL AND sent_at IS NOT NULL) ship_h
      FROM dropship_lines WHERE supplier_id=? AND created>=?`, s.id, from);
    if (!num(r.n)) continue;
    const succ = pct(num(r.delivered), num(r.finished));
    out.push({ kind: 'dropshipping', id: num(s.id), name: s.name, status: s.status, lines: num(r.n), finished: num(r.finished), success_pct: succ, cancelled_pct: pct(num(r.cancelled), num(r.n)), issue_pct: pct(num(r.issues), num(r.n)), response_hours: r.resp_h != null ? r1(num(r.resp_h)) : null, ship_hours: r.ship_h != null ? r1(num(r.ship_h)) : null, verdict: verdict({ sample: num(r.finished), min: 5, success_pct: succ, on_time_pct: null }) });
  }
  return { window_days: days, suppliers: out, not_tracked: ['Product quality', 'Invoice accuracy', 'Disputes', 'Returns by supplier'], note: 'Scored only from recorded purchase receipts and dropship lines. A supplier with too little history is not scored.' };
}

/* ---------- profitability ---------- */
// Pure: one order's recorded figures in, a margin out, with every gap named. Catalogue cost (products.cost_price) is a standard cost, not what was actually paid.
function margin(r) {
  const goods = num(r.goods), gaps = [];
  if (num(r.own_unknown) > 0) gaps.push('catalogue cost missing on ' + num(r.own_unknown) + ' item(s)');
  if (num(r.ds_unknown) > 0) gaps.push('supplier cost not recorded on ' + num(r.ds_unknown) + ' dropship line(s)');
  const known = gaps.length === 0, cost = num(r.own_cogs) + num(r.ds_cost) + num(r.commission);
  const shipKnown = num(r.ship_rows) > 0 && num(r.ship_unknown) === 0, ship = shipKnown ? num(r.ship_cost) : 0;
  if (!shipKnown) gaps.push(num(r.ship_unknown) > 0 ? 'courier cost in a foreign currency not converted' : 'delivery cost not recorded (rider or own delivery)');
  const gross = goods - cost, contribution = gross + num(r.delivery_fee) - ship;
  return { known, goods, cost: Math.round(cost), gross_margin: Math.round(gross), gross_margin_pct: goods > 0 ? r1((gross / goods) * 100) : null, delivery_fee_charged: num(r.delivery_fee), delivery_cost_recorded: shipKnown, delivery_cost: Math.round(ship), contribution: Math.round(contribution), gaps };
}
async function profitability({ from, to } = {}) {
  const q = D.range({ from, to });
  const rows = await all(`SELECT o.id, o.ref, (${D.CHANNEL_SQL}) ch, o.delivery_fee,
    (SELECT COALESCE(SUM(oi.price*oi.qty),0) FROM order_items oi WHERE oi.order_id=o.id) goods,
    (SELECT COALESCE(SUM(oi.commission),0) FROM order_items oi WHERE oi.order_id=o.id) commission,
    (SELECT COUNT(*) FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=o.id AND NOT EXISTS (SELECT 1 FROM dropship_lines l WHERE l.order_item_id=oi.id) AND COALESCE(p.cost_price,0)<=0) own_unknown,
    (SELECT COALESCE(SUM(p.cost_price*oi.qty),0) FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=o.id AND p.cost_price>0 AND NOT EXISTS (SELECT 1 FROM dropship_lines l WHERE l.order_item_id=oi.id)) own_cogs,
    (SELECT COALESCE(SUM(l.cost_ngn),0) FROM dropship_lines l WHERE l.order_id=o.id AND l.status NOT IN ('cancelled','refunded','returned')) ds_cost,
    (SELECT COUNT(*) FROM dropship_lines l WHERE l.order_id=o.id AND l.status NOT IN ('cancelled','refunded','returned') AND l.cost_ngn IS NULL) ds_unknown,
    (SELECT COALESCE(SUM(s.cost),0) FROM ops_shipments s WHERE s.order_kind='order' AND s.order_id=o.id AND s.currency='NGN' AND s.status<>'cancelled') ship_cost,
    (SELECT COUNT(*) FROM ops_shipments s WHERE s.order_kind='order' AND s.order_id=o.id AND s.status<>'cancelled') ship_rows,
    (SELECT COUNT(*) FROM ops_shipments s WHERE s.order_kind='order' AND s.order_id=o.id AND s.status<>'cancelled' AND s.currency<>'NGN') ship_unknown
    FROM orders o WHERE ${D.SALE} AND o.created>=? AND o.created<=? ORDER BY o.id DESC LIMIT 5000`, q.from, q.to);
  const list = rows.map((r) => ({ id: num(r.id), ref: r.ref, channel: r.ch, ...margin(r) })), known = list.filter((x) => x.known), by = {};
  for (const x of known) { const b = by[x.channel] = by[x.channel] || { orders: 0, goods: 0, gross_margin: 0, contribution: 0 }; b.orders++; b.goods += x.goods; b.gross_margin += x.gross_margin; b.contribution += x.contribution; }
  const goods = known.reduce((a, x) => a + x.goods, 0), gm = known.reduce((a, x) => a + x.gross_margin, 0);
  return { range: q, orders_in_range: list.length, orders_with_known_cost: known.length, coverage_pct: pct(known.length, list.length), totals: { goods: Math.round(goods), gross_margin: Math.round(gm), gross_margin_pct: goods > 0 ? r1((gm / goods) * 100) : null },
    by_channel: Object.entries(by).map(([channel, b]) => ({ channel, ...b, gross_margin_pct: b.goods > 0 ? r1((b.gross_margin / b.goods) * 100) : null })),
    negative_margin: known.filter((x) => x.gross_margin < 0).slice(0, 25), excessive_delivery: known.filter((x) => x.delivery_cost_recorded && x.goods > 0 && x.delivery_cost > 0.25 * x.goods).slice(0, 25),
    basis: 'Only orders whose product costs are all recorded are counted. Catalogue cost is a standard cost, not necessarily what was paid. Delivery cost is included only where a courier shipment recorded it; rider pay is not recorded.', unknown_orders: list.length - known.length };
}

/* ---------- open orders likely to be late ---------- */
async function atRisk() {
  const hist = await all(`SELECT stage, mins FROM (SELECT e.to_stage stage, (LEAD(e.detected) OVER (PARTITION BY e.kind, e.ref_id ORDER BY e.id) - e.detected)/60.0 mins FROM ops_order_stage_events e) x WHERE mins IS NOT NULL`);
  const dur = {}; for (const h of hist) (dur[h.stage] = dur[h.stage] || []).push(num(h.mins));
  const t = now(), open = await all('SELECT kind, ref_id, ref, channel, stage, stage_since FROM ops_order_watch WHERE closed_at IS NULL'), out = []; let unknown = 0;
  for (const w of open) {
    if (ST.CUSTOMER_STAGES.has(w.stage)) continue;
    const el = (t - num(w.stage_since)) / 60, risk = F.stageRisk(dur[w.stage] || [], el);
    if (!risk.known) { unknown++; continue; } if (risk.level !== 'normal') out.push({ kind: w.kind, id: num(w.ref_id), ref: w.ref, channel: w.channel, stage: w.stage, stage_label: (ST.STAGES[w.stage] || {}).label || w.stage, waiting_min: Math.round(el), level: risk.level, basis: risk.basis });
  }
  out.sort((a, b) => (b.level === 'high') - (a.level === 'high') || b.waiting_min - a.waiting_min);
  return { at_risk: out.slice(0, 100), count: out.length, open_orders: open.length, not_predictable: unknown, note: 'Predictions come from how long past orders spent in the same stage. A stage with fewer than 10 past orders is not predicted.' };
}

/* ---------- how well is the AI doing ---------- */
async function performance({ days = 30 } = {}) {
  const t = now(), from = t - days * 86400;
  const w = await get("SELECT COUNT(*) seen, COUNT(*) FILTER (WHERE outcome='delivered') delivered, COUNT(*) FILTER (WHERE outcome='delivered' AND proof='verified') verified, COUNT(*) FILTER (WHERE outcome='delivered' AND proof='unproven') unproven FROM ops_order_watch WHERE first_seen>=?", from);
  const ot = await get("SELECT COUNT(*) FILTER (WHERE o.delivered_at<=o.promised_at) ontime, COUNT(*) n FROM ops_order_watch w JOIN orders o ON w.kind='order' AND o.id=w.ref_id WHERE w.outcome='delivered' AND w.closed_at>=? AND o.promised_at IS NOT NULL AND o.delivered_at IS NOT NULL", from);
  const ex = await get("SELECT COUNT(*) raised, COUNT(*) FILTER (WHERE status IN ('resolved','closed')) resolved, AVG((resolved_at-created)/3600.0) FILTER (WHERE resolved_at IS NOT NULL) hrs FROM ops_exceptions WHERE created>=?", from);
  const ap = await all("SELECT a.status, a.created, (SELECT MIN(d.created) FROM ops_approval_decisions d WHERE d.approval_id=a.id) first_decision FROM ops_approvals a WHERE a.created>=?", from);
  const responded = ap.filter((a) => a.first_decision).map((a) => (num(a.first_decision) - num(a.created)) / 60);
  const ac = await all("SELECT status, COUNT(*) n FROM ops_actions WHERE created>=? AND actor_kind IN ('ai_autonomous','ai_approved') GROUP BY status", from), acs = Object.fromEntries(ac.map((x) => [x.status, num(x.n)]));
  const done = acs.done || 0, failed = acs.failed || 0, pending = acs.pending_approval || 0, recommended = acs.recommended || 0, blocked = acs.blocked || 0;
  const sav = await verifiedSavings(from);
  return { window_days: days,
    orders: { watched: num(w.seen), delivered: num(w.delivered), delivered_with_verified_proof_pct: pct(num(w.verified), num(w.delivered)), delivered_without_proof: num(w.unproven), on_time_pct: pct(num(ot.ontime), num(ot.n)), on_time_basis: `${num(ot.n)} delivered orders that had a promised time` },
    exceptions: { raised: num(ex.raised), resolved: num(ex.resolved), resolved_pct: pct(num(ex.resolved), num(ex.raised)), avg_hours_to_resolve: ex.hrs != null ? r1(num(ex.hrs)) : null },
    approvals: { requested: ap.length, answered: responded.length, median_response_minutes: median(responded) == null ? null : Math.round(median(responded)), pending: ap.filter((a) => a.status === 'pending').length, expired: ap.filter((a) => a.status === 'expired').length },
    ai_actions: { executed: done, failed, awaiting_approval: pending, recommended_only: recommended, blocked, execution_success_pct: pct(done, done + failed), human_intervention_pct: pct(pending, done + failed + pending), note: 'Success rate counts executed vs failed actions. Human intervention is the share of changing actions that needed a person to approve.' },
    savings: sav };
}
// VERIFIED: a received purchase order priced below the previous received price for the same product (actual receipts only).
// ESTIMATED: the gap between the dearest and the chosen quotation for requests that became orders. Never cash that was banked; shown separately.
async function verifiedSavings(from) {
  const pos = await all("SELECT p.id, p.vendor_id, p.currency, p.lines, p.created, (SELECT MAX(received_at) FROM ops_po_receipts r WHERE r.po_id=p.id) rcv, COALESCE((SELECT SUM(qty_received) FROM ops_po_receipts r WHERE r.po_id=p.id),0) got FROM ops_purchase_orders p WHERE p.status='received' ORDER BY COALESCE((SELECT MAX(received_at) FROM ops_po_receipts r WHERE r.po_id=p.id), p.created)");
  const last = new Map(), verified = {}; let compared = 0;
  for (const p of pos) for (const l of p.lines || []) {
    if (!l.product_id) continue; const key = l.product_id + ':' + p.currency, prev = last.get(key), price = num(l.unit_price);
    if (prev != null && num(p.rcv) >= from) { compared++; verified[p.currency] = (verified[p.currency] || 0) + (prev - price) * num(l.qty); }
    last.set(key, price);
  }
  const est = await all(`SELECT q.currency, q.unit_price chosen, r.qty, (SELECT MAX(q2.unit_price) FROM ops_quotations q2 WHERE q2.request_id=r.id AND q2.currency=q.currency) hi, (SELECT COUNT(*) FROM ops_quotations q3 WHERE q3.request_id=r.id) nq
    FROM ops_purchase_orders p JOIN ops_quotations q ON q.id=p.quotation_id JOIN ops_requests r ON r.id=p.request_id WHERE p.created>=? AND p.status NOT IN ('draft','cancelled')`, from);
  const byCur = {}; for (const e of est) if (num(e.nq) >= 2) byCur[e.currency] = (byCur[e.currency] || 0) + Math.max(0, (num(e.hi) - num(e.chosen)) * num(e.qty));
  return { verified: { price_change_vs_last_paid_by_currency: Object.fromEntries(Object.entries(verified).map(([k, v]) => [k, Math.round(v)])), comparisons: compared, note: 'Positive means received orders cost less than the previous received price for the same product (actual receipts only). Currencies are never added together.' },
    estimated_opportunity: { by_currency: Object.fromEntries(Object.entries(byCur).map(([k, v]) => [k, Math.round(v)])), note: 'ESTIMATE: dearest recorded quotation minus the chosen one, on requests that had at least 2 quotations. Not money saved until goods are received at that price.' } };
}

module.exports = { demandForecast, supplierScorecards, verdict, margin, profitability, atRisk, performance, verifiedSavings, median };
