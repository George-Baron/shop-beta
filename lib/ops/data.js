'use strict';
// What the AI looks at: read-only questions asked of the store's REAL tables (orders, stock, riders, suppliers, dropshipping, trade).
// Nothing here writes, and nothing is guessed: where the system does not record something, the answer says so (null / "not recorded") instead of inventing a number.
const { get, all, now } = require('../db');
const { readySql } = require('../dispatch');
const { int } = require('../shop');

const SALE = "o.status NOT IN ('cancelled','refunded') AND (o.payment_method='pod' OR o.payment_status='paid')";
const ACTIVE = "('paid','confirmed','processing','shipped')";
const num = (v) => Number(v) || 0;
// Which sales channel an order belongs to. The store does not record whether a web visitor or an app placed it, so "retail" covers both (a later phase adds that field).
const CHANNEL_SQL = `CASE WHEN COALESCE(NULLIF(o.country,''),'NG')<>'NG' THEN 'international' WHEN o.ds_lines>0 THEN 'dropshipping'
  WHEN EXISTS (SELECT 1 FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=o.id AND p.vendor_id IS NOT NULL) THEN 'partner' ELSE 'retail' END`;
const CHANNELS = ['retail', 'partner', 'dropshipping', 'international'];

function range(q = {}) {
  const to = int(q.to) || now(), from = int(q.from) || to - 30 * 86400;
  return { from: Math.min(from, to), to };
}
const filters = (q, alias = 'o') => {
  const w = [], a = [];
  if (CHANNELS.includes(q.channel)) { w.push(`(${CHANNEL_SQL.replace(/\bo\./g, alias + '.')}) = ?`); a.push(q.channel); }
  if (/^[A-Za-z]{2}$/.test(q.country || '')) { w.push(`COALESCE(NULLIF(${alias}.country,''),'NG') = ?`); a.push(q.country.toUpperCase()); }
  return { sql: w.length ? ' AND ' + w.join(' AND ') : '', args: a };
};

/* ---------- orders ---------- */
async function orders(q = {}) {
  const { from, to } = range(q), f = filters(q), t = now();
  const inRange = (await all(`SELECT o.status, COUNT(*) n FROM orders o WHERE o.created>=? AND o.created<=? ${f.sql} GROUP BY o.status`, from, to, ...f.args));
  const by = Object.fromEntries(inRange.map((r) => [r.status, num(r.n)]));
  const snap = async (where) => num((await get(`SELECT COUNT(*) n FROM orders o WHERE ${where} ${f.sql}`, ...f.args)).n);
  const channels = await all(`SELECT (${CHANNEL_SQL}) ch, COUNT(*) n FROM orders o WHERE o.created>=? AND o.created<=? GROUP BY 1`, from, to);
  const status = q.status && ['pending', 'paid', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'].includes(q.status) ? q.status : '';
  return {
    range: { from, to },
    total: Object.values(by).reduce((a, b) => a + b, 0),
    by_status: by,
    by_channel: Object.fromEntries(CHANNELS.map((c) => [c, num((channels.find((x) => x.ch === c) || {}).n)])),
    // "now" counts: how many are in each state today, whatever date they were placed
    awaiting_payment: await snap("o.status='pending' AND o.payment_status<>'paid'"),
    awaiting_processing: await snap("o.status IN ('paid','confirmed')"),
    awaiting_dispatch: await snap(readySql),
    in_transit: await snap("o.status='shipped'"),
    delayed: await get(`SELECT COUNT(*) n FROM orders o WHERE o.promised_at IS NOT NULL AND o.promised_at<? AND o.status IN ${ACTIVE} AND o.delivered_at IS NULL ${f.sql}`, t, ...f.args).then((r) => num(r.n)),
    delivered: by.delivered || 0, cancelled: by.cancelled || 0,
    failed_deliveries: num((await get("SELECT COUNT(*) n FROM rider_assignments WHERE assignment_status='failed' AND assigned_at>=? AND assigned_at<=?", from, to)).n),
    filter_status: status ? by[status] || 0 : null,
  };
}
async function delayedOrders(limit = 25, q = {}) {
  const f = filters(q), t = now();
  const rows = await all(`SELECT o.id, o.ref, o.status, o.name, o.state, o.total, o.promised_at, o.rider_id, (${CHANNEL_SQL}) channel FROM orders o
    WHERE o.promised_at IS NOT NULL AND o.promised_at<? AND o.status IN ${ACTIVE} AND o.delivered_at IS NULL ${f.sql} ORDER BY o.promised_at LIMIT ${Math.min(100, Math.max(1, limit))}`, t, ...f.args);
  return rows.map((r) => ({ id: num(r.id), ref: r.ref, status: r.status, customer: r.name, state: r.state, total: num(r.total), channel: r.channel, promised_at: num(r.promised_at), late_minutes: Math.round((t - num(r.promised_at)) / 60), rider_assigned: !!r.rider_id }));
}
async function awaitingDispatch(limit = 25) {
  const t = now();
  const rows = await all(`SELECT o.id, o.ref, o.status, o.name, o.state, o.total, o.created, o.promised_at FROM orders o WHERE ${readySql} ORDER BY o.promised_at NULLS LAST, o.id LIMIT ${Math.min(100, Math.max(1, limit))}`);
  return rows.map((r) => ({ id: num(r.id), ref: r.ref, status: r.status, customer: r.name, state: r.state, total: num(r.total), waiting_minutes: Math.round((t - num(r.created)) / 60), promised_at: r.promised_at ? num(r.promised_at) : null }));
}
async function deliveryPerformance(q = {}) {
  const { from, to } = range(q), f = filters(q);
  const r = await get(`SELECT COUNT(*) n, COUNT(*) FILTER (WHERE o.delivered_at<=o.promised_at) ontime FROM orders o WHERE o.status='delivered' AND o.promised_at IS NOT NULL AND o.delivered_at IS NOT NULL AND o.delivered_at>=? AND o.delivered_at<=? ${f.sql}`, from, to, ...f.args);
  const n = num(r.n);
  return { delivered_with_promise: n, on_time: num(r.ontime), on_time_pct: n ? Math.round((num(r.ontime) / n) * 1000) / 10 : null };
}

/* ---------- stock ---------- */
const LEAD_DAYS = 7, SAFETY_DAYS = 3, COVER_DAYS = 14;   // planning defaults until each supplier's own lead time is recorded (phase 2)
async function retailStock(opts = {}) {
  const t = now(), low = Math.max(0, int(opts.low, 5));
  const rows = await all(`WITH v AS (SELECT oi.product_id, SUM(oi.qty) q FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.created>=? AND ${SALE} GROUP BY oi.product_id),
      inc AS (SELECT ti.product_id, SUM(ti.qty) q FROM trade_items ti JOIN trade_shipments s ON s.id=ti.shipment_id WHERE s.direction='import' AND s.status IN ('booked','in_transit','arrived','cleared') AND ti.product_id IS NOT NULL GROUP BY ti.product_id)
    SELECT p.id, p.name, p.sku, p.stock, COALESCE(v.q,0) sold30, COALESCE(inc.q,0) incoming FROM products p LEFT JOIN v ON v.product_id=p.id LEFT JOIN inc ON inc.product_id=p.id
    WHERE p.active=1 AND p.fulfilment='own' AND p.vendor_id IS NULL`, t - 30 * 86400);
  const items = rows.map((r) => {
    const stock = num(r.stock), sold = num(r.sold30), daily = sold / 30, incoming = num(r.incoming);
    const reorderPoint = Math.ceil(daily * (LEAD_DAYS + SAFETY_DAYS)), target = Math.ceil(daily * (LEAD_DAYS + SAFETY_DAYS + COVER_DAYS));
    return { id: num(r.id), name: r.name, sku: r.sku, stock, incoming, sold_30d: sold, avg_daily_demand: Math.round(daily * 100) / 100, days_of_cover: daily > 0 ? Math.round((stock / daily) * 10) / 10 : null,
      expected_stockout: daily > 0 && stock > 0 ? t + Math.floor((stock / daily) * 86400) : null, reorder_point: reorderPoint, recommended_qty: daily > 0 && stock + incoming <= reorderPoint ? Math.max(0, target - stock - incoming) : 0 };
  });
  return {
    assumptions: { lead_days: LEAD_DAYS, safety_days: SAFETY_DAYS, cover_days: COVER_DAYS, note: 'Planning defaults. Retail stock is already net of items held for open orders; supplier lead times arrive with the procurement phase.' },
    products: items.length,
    low: items.filter((i) => i.stock > 0 && i.stock <= low).length,
    critical: items.filter((i) => i.stock === 0 && i.sold_30d > 0).length,      // out of stock and still selling
    out_of_stock: items.filter((i) => i.stock === 0).length,
    overstocked: items.filter((i) => i.stock >= 20 && (i.sold_30d === 0 || (i.days_of_cover != null && i.days_of_cover > 120))).length,
    reorder_candidates: items.filter((i) => i.recommended_qty > 0).sort((a, b) => (a.days_of_cover ?? 1e9) - (b.days_of_cover ?? 1e9)).slice(0, 25),
    critical_items: items.filter((i) => i.stock === 0 && i.sold_30d > 0).sort((a, b) => b.sold_30d - a.sold_30d).slice(0, 25),
    low_items: items.filter((i) => i.stock > 0 && i.stock <= low).sort((a, b) => a.stock - b.stock).slice(0, 25),
  };
}
// The wholesale warehouse is a separate stock. It is never added to retail numbers.
async function wholesaleStock() {
  const wh = await all(`SELECT w.id, w.name, COUNT(b.id) lines, COALESCE(SUM(b.on_hand),0) on_hand, COALESCE(SUM(b.reserved),0) reserved FROM wholesale_warehouses w LEFT JOIN wholesale_stock_balances b ON b.warehouse_id=w.id GROUP BY w.id, w.name ORDER BY w.id`);
  const low = await all(`SELECT p.name, p.sku, b.on_hand, b.reserved, b.reorder_level FROM wholesale_stock_balances b JOIN products p ON p.id=b.product_id WHERE b.reorder_level>0 AND b.on_hand-b.reserved<=b.reorder_level ORDER BY (b.on_hand-b.reserved) LIMIT 25`);
  return { warehouses: wh.map((w) => ({ id: num(w.id), name: w.name, lines: num(w.lines), on_hand: num(w.on_hand), reserved: num(w.reserved), available: num(w.on_hand) - num(w.reserved) })), below_reorder_level: low.map((l) => ({ name: l.name, sku: l.sku, on_hand: num(l.on_hand), reserved: num(l.reserved), available: num(l.on_hand) - num(l.reserved), reorder_level: num(l.reorder_level) })) };
}

/* ---------- riders ---------- */
async function riders() {
  const t = now(), by = await all("SELECT availability_status s, COUNT(*) n FROM riders WHERE suspended=0 AND verification_status='verified' GROUP BY availability_status");
  const stale = num((await get("SELECT COUNT(*) n FROM riders r JOIN rider_latest_location l ON l.rider_id=r.id WHERE r.suspended=0 AND r.availability_status IN ('available','on_delivery') AND l.received_at<?", t - 300)).n);
  const live = num((await get("SELECT COUNT(*) n FROM rider_assignments WHERE assignment_status IN ('offered','accepted','arrived_pickup','picked_up','in_transit')")).n);
  const m = Object.fromEntries(by.map((r) => [r.s, num(r.n)]));
  return { verified_riders: Object.values(m).reduce((a, b) => a + b, 0), available: m.available || 0, on_delivery: m.on_delivery || 0, busy: m.busy || 0, offline: m.offline || 0, live_assignments: live, stale_gps: stale };
}

/* ---------- suppliers, dropshipping ---------- */
async function suppliers() {
  const t = now();
  const s = await get("SELECT COUNT(*) FILTER (WHERE status='active') active, COUNT(*) FILTER (WHERE status='paused') paused FROM suppliers");
  const thin = num((await get("SELECT COUNT(*) n FROM suppliers s WHERE s.status='active' AND (SELECT COUNT(*) FROM supplier_events e WHERE e.supplier_id=s.id AND e.kind='order') < 3")).n);
  const pay = await all("SELECT currency, COALESCE(SUM(amount-credit),0) owed, COALESCE(SUM(amount-credit) FILTER (WHERE due_at<?),0) overdue, COUNT(*) FILTER (WHERE due_at<?) overdue_n FROM supplier_payables WHERE status='open' GROUP BY currency", t, t);
  const lines = await all("SELECT status, COUNT(*) n FROM dropship_lines WHERE status NOT IN ('delivered','cancelled','refunded','returned') GROUP BY status");
  const po = num((await get("SELECT COUNT(DISTINCT so.id) n FROM supplier_orders so JOIN dropship_lines l ON l.po_id=so.id WHERE so.status='sent' AND l.status NOT IN ('delivered','cancelled','refunded','returned')")).n);
  return { active: num(s.active), paused: num(s.paused), awaiting_evaluation: thin, outstanding_purchase_orders: po, open_dropship_lines: Object.fromEntries(lines.map((l) => [l.status, num(l.n)])),
    payables: pay.map((p) => ({ currency: p.currency, owed: num(p.owed), overdue: num(p.overdue), overdue_count: num(p.overdue_n) })) };
}
// Supplier items that are stuck: paid but never sent to the supplier, or sent and not confirmed or shipped in the supplier's own processing time plus 2 days.
async function stuckDropship(limit = 25) {
  const t = now();
  return (await all(`SELECT l.id, l.status, l.order_id, o.ref, s.name supplier, l.sent_at, l.paid_at, s.processing_days FROM dropship_lines l JOIN suppliers s ON s.id=l.supplier_id JOIN orders o ON o.id=l.order_id
    WHERE (l.status='paid' AND l.paid_at<?) OR (l.status IN ('sent','confirmed') AND l.sent_at IS NOT NULL AND l.sent_at < ?::bigint - (s.processing_days+2)*86400) ORDER BY COALESCE(l.sent_at,l.paid_at) LIMIT ${Math.min(100, limit)}`, t - 86400, t))
    .map((r) => ({ line_id: num(r.id), order_ref: r.ref, supplier: r.supplier, status: r.status, waiting_hours: Math.round((t - num(r.sent_at || r.paid_at)) / 3600) }));
}
// Orders where a supplier cost is recorded and is higher than the price the customer paid.
async function negativeMargin(limit = 25) {
  return (await all(`SELECT l.id, o.ref, l.qty, l.sell_price, l.cost_ngn FROM dropship_lines l JOIN orders o ON o.id=l.order_id WHERE l.cost_ngn IS NOT NULL AND l.status NOT IN ('cancelled','refunded','returned') AND l.cost_ngn > l.sell_price*l.qty ORDER BY (l.cost_ngn - l.sell_price*l.qty) DESC LIMIT ${Math.min(100, limit)}`))
    .map((r) => ({ line_id: num(r.id), order_ref: r.ref, revenue: num(r.sell_price) * num(r.qty), cost_ngn: num(r.cost_ngn), loss: num(r.cost_ngn) - num(r.sell_price) * num(r.qty) }));
}

/* ---------- import / export ---------- */
async function trade() {
  const t = now(), by = await all("SELECT direction, status, COUNT(*) n FROM trade_shipments GROUP BY direction, status");
  const count = (dir, f) => by.filter((b) => b.direction === dir && f(b.status)).reduce((a, b) => a + num(b.n), 0);
  const holds = await all("SELECT id, ref, direction, customs_status, dest_country FROM trade_shipments WHERE customs_status IN ('held','queried') AND status NOT IN ('delivered','cancelled') ORDER BY id DESC LIMIT 25");
  const late = await all("SELECT id, ref, direction, eta FROM trade_shipments WHERE eta IS NOT NULL AND eta<? AND status IN ('booked','in_transit') ORDER BY eta LIMIT 25", t);
  return { import_active: count('import', (s) => !['delivered', 'cancelled'].includes(s)), export_active: count('export', (s) => !['delivered', 'cancelled'].includes(s)),
    in_transit: by.filter((b) => b.status === 'in_transit').reduce((a, b) => a + num(b.n), 0), pending_customs: num((await get("SELECT COUNT(*) n FROM trade_shipments WHERE status IN ('arrived','in_transit','booked') AND customs_status IN ('docs_ready','submitted','queried','held')")).n),
    customs_holds: holds.map((h) => ({ id: num(h.id), ref: h.ref, direction: h.direction, customs_status: h.customs_status, country: h.dest_country })), past_eta: late.map((h) => ({ id: num(h.id), ref: h.ref, direction: h.direction, eta: num(h.eta), late_days: Math.max(1, Math.round((t - num(h.eta)) / 86400)) })) };
}

/* ---------- money (only what the system records) ---------- */
async function money(q = {}) {
  const { from, to } = range(q), f = filters(q);
  const sales = await get(`SELECT COALESCE(SUM(o.total),0) revenue, COUNT(*) n, COALESCE(SUM(o.delivery_fee),0) delivery_fees FROM orders o WHERE o.created>=? AND o.created<=? AND ${SALE} ${f.sql}`, from, to, ...f.args);
  const refunded = await get(`SELECT COALESCE(SUM(o.total),0) amount, COUNT(*) n FROM orders o WHERE o.status='refunded' AND o.created>=? AND o.created<=? ${f.sql}`, from, to, ...f.args);
  const proc = await all('SELECT currency, COALESCE(SUM(amount),0) amount, COUNT(*) n FROM supplier_payables WHERE created>=? AND created<=? GROUP BY currency', from, to);
  const paid = await get("SELECT COALESCE(SUM(paid_ngn),0) ngn FROM supplier_payables WHERE status='paid' AND paid_at>=? AND paid_at<=?", from, to);
  const ds = await get("SELECT COALESCE(SUM(sell_price*qty),0) revenue, COALESCE(SUM(cost_ngn) FILTER (WHERE cost_ngn IS NOT NULL),0) cost, COUNT(*) FILTER (WHERE cost_ngn IS NOT NULL) with_cost, COUNT(*) n FROM dropship_lines WHERE status='delivered' AND delivered_at>=? AND delivered_at<=?", from, to);
  return {
    range: { from, to }, sales: { revenue: num(sales.revenue), orders: num(sales.n), delivery_fees_collected: num(sales.delivery_fees) }, refunds: { orders_refunded: num(refunded.n), amount: num(refunded.amount) },
    procurement_recorded: { by_currency: proc.map((p) => ({ currency: p.currency, amount: num(p.amount), purchase_orders: num(p.n) })), paid_ngn: num(paid.ngn), note: 'Supplier purchase orders for dropshipping. Stock purchases and imports are recorded when the procurement phase is built.' },
    dropship_margin: { delivered_lines: num(ds.n), lines_with_recorded_cost: num(ds.with_cost), revenue: num(ds.revenue), recorded_cost_ngn: num(ds.cost), complete: num(ds.n) === num(ds.with_cost) },
    not_recorded: ['Rider and courier delivery costs', 'Warehouse handling', 'Packaging', 'Other operating expenses'],   // the store has no ledger for these yet; the AI will not estimate them
  };
}

/* ---------- returns and refunds ---------- */
async function returnsRefunds() {
  const r = await get("SELECT COUNT(*) FILTER (WHERE status IN ('requested','approved','sent_back')) pending FROM dropship_returns");
  const ref = await get("SELECT COUNT(*) n, COALESCE(SUM(refund_due),0) amount FROM dropship_lines WHERE refund_due>0 AND refund_reference=''");
  return { pending_returns: num(r.pending), pending_refunds: num(ref.n), pending_refund_amount: num(ref.amount), note: 'Dropshipping returns and refunds. Other refund types are folded in when the refunds workflow is built.' };
}

/* ---------- the AI's own books ---------- */
async function opsSummary() {
  const ap = await all("SELECT status, COUNT(*) n FROM ops_approvals GROUP BY status");
  const ex = await all("SELECT severity, COUNT(*) n FROM ops_exceptions WHERE status IN ('open','acknowledged') GROUP BY severity");
  const jobs = await all("SELECT kind, COUNT(*) n, MAX(last_error) err FROM jobs WHERE state='failed' AND COALESCE(finished,created)>=? GROUP BY kind", now() - 86400);
  return { approvals: Object.fromEntries(ap.map((a) => [a.status, num(a.n)])), exceptions: Object.fromEntries(ex.map((e) => [e.severity, num(e.n)])), failed_jobs: jobs.map((j) => ({ kind: j.kind, count: num(j.n), last_error: String(j.err || '').slice(0, 160) })) };
}

async function overview(q = {}) {
  const [o, perf, rs, ws, rd, sp, tr, mo, rr, ops] = await Promise.all([orders(q), deliveryPerformance(q), retailStock(), wholesaleStock(), riders(), suppliers(), trade(), money(q), returnsRefunds(), opsSummary()]);
  return { generated_at: now(), filters: { channel: CHANNELS.includes(q.channel) ? q.channel : '', country: /^[A-Za-z]{2}$/.test(q.country || '') ? q.country.toUpperCase() : '', status: q.status || '' }, orders: o, delivery_performance: perf, retail_stock: { ...rs, reorder_candidates: rs.reorder_candidates.slice(0, 8), critical_items: rs.critical_items.slice(0, 8), low_items: rs.low_items.slice(0, 8) }, wholesale_stock: ws, riders: rd, suppliers: sp, trade: tr, money: mo, returns_refunds: rr, ops: ops,
    not_filterable_yet: ['business unit', 'branch', 'warehouse', 'supplier', 'customer', 'product', 'delivery provider'] };
}

module.exports = { SALE, CHANNELS, range, orders, delayedOrders, awaitingDispatch, deliveryPerformance, retailStock, wholesaleStock, riders, suppliers, stuckDropship, negativeMargin, trade, money, returnsRefunds, opsSummary, overview };
