'use strict';
// Step 6 of dropshipping: money. Everything here is admin-only and holds our cost and margin: none of it is ever sent to a customer or a supplier.
//   payables       what we owe each supplier (per purchase order, in the supplier's currency), when, and who paid it with which reference
//   line costs     duty, extra shipping, handling, payment fee, other (whole Naira)
//   refunds        to customers (recorded in step 4, amounts kept here) and from suppliers (credit against a payable, or cash)
//   returns        a customer return that goes back to the supplier, tracked until the supplier answers
//   profit         per item and per order, grouped by order / supplier / country / product / day / month, always from the prices and rates fixed at the time
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const P = require('./pricing');
const FX = require('./fx');
const CUR = require('./currency');
const DO = require('./dropship-orders');
const { fail, str, int } = S;

const COST_KINDS = { duty: 'Import duty', shipping: 'Extra shipping', handling: 'Handling', gateway_fee: 'Payment fee charged', other: 'Other' };
const RETURN_NEXT = { requested: ['approved', 'rejected'], approved: ['sent_back', 'rejected'], sent_back: ['received', 'rejected'], received: ['closed'], rejected: ['closed'], closed: [] };
const RETURN_LABEL = { requested: 'Return requested', approved: 'Approved by supplier', sent_back: 'Sent back', received: 'Received by supplier', rejected: 'Rejected by supplier', closed: 'Closed' };
const DAY = 86400;
const n2 = (x) => Math.round(Number(x) * 100) / 100;
const num = (x, label, { min = 0, max = 1e12 } = {}) => {
  const v = typeof x === 'string' ? Number(x.replace(/,/g, '')) : Number(x);
  if (x === '' || x == null || !Number.isFinite(v) || v < min || v > max) fail(400, `${label} must be a number from ${min} to ${max}.`);
  return v;
};

/* ---------- pure money maths (no database): the report and the tests use the same function ---------- */
// l: { sell_price, qty, paid, sent, cost_ngn, unit_cost, ship_cost, refunds_ngn, supplier_refunds_ngn, costs: {duty, shipping, handling, gateway_fee, other}, fee_estimate }
// Revenue counts once the customer has paid. Supplier cost counts once we have ordered. Everything is whole Naira.
function lineProfit(l) {
  const revenue = l.paid ? l.sell_price * l.qty : 0;
  const cost = l.sent && l.cost_ngn != null ? Number(l.cost_ngn) : 0;
  const goodsPart = l.sent && l.cost_ngn != null && (Number(l.unit_cost) + Number(l.ship_cost)) > 0
    ? Math.round(cost * Number(l.unit_cost) / (Number(l.unit_cost) + Number(l.ship_cost))) : cost;
  const c = l.costs || {};
  const fee = c.gateway_fee > 0 ? c.gateway_fee : (l.paid ? Math.round(l.fee_estimate || 0) : 0);
  const out = {
    revenue, refunds: l.refunds_ngn || 0,
    supplier_cost: goodsPart, supplier_shipping: cost - goodsPart,
    extra_shipping: c.shipping || 0, duty: c.duty || 0, fees: fee, other: (c.handling || 0) + (c.other || 0),
    supplier_refunds: l.supplier_refunds_ngn || 0, cost_known: !(l.sent && l.cost_ngn == null), fee_estimated: !(c.gateway_fee > 0) && l.paid && fee > 0,
  };
  out.total_costs = out.supplier_cost + out.supplier_shipping + out.extra_shipping + out.duty + out.fees + out.other;
  out.net_profit = revenue - out.refunds - out.total_costs + out.supplier_refunds;
  out.margin_pct = revenue > 0 ? Math.round((out.net_profit / revenue) * 1000) / 10 : null;
  return out;
}
const SUM_KEYS = ['revenue', 'refunds', 'supplier_cost', 'supplier_shipping', 'extra_shipping', 'duty', 'fees', 'other', 'supplier_refunds', 'total_costs', 'net_profit'];
function addInto(t, p) { for (const k of SUM_KEYS) t[k] = (t[k] || 0) + (p[k] || 0); t.lines = (t.lines || 0) + 1; if (!p.cost_known) t.unknown_cost = (t.unknown_cost || 0) + 1; if (p.fee_estimated) t.estimated_fees = (t.estimated_fees || 0) + 1; return t; }
const finish = (t) => ({ ...t, margin_pct: t.revenue > 0 ? Math.round((t.net_profit / t.revenue) * 1000) / 10 : null, unknown_cost: t.unknown_cost || 0, estimated_fees: t.estimated_fees || 0 });

// "2026-11-20" -> start of that day in Lagos (UTC+1). to is inclusive.
const dayStart = (s) => { const t = Date.parse(String(s) + 'T00:00:00+01:00'); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
function period(q = {}) {
  const t = now(), from = q.from ? dayStart(q.from) : t - 30 * DAY, toD = q.to ? dayStart(q.to) : null;
  if (q.from && from == null) fail(400, 'The start date is not valid.');
  if (q.to && toD == null) fail(400, 'The end date is not valid.');
  const to = toD == null ? t + DAY : toD + DAY;
  if (to <= from) fail(400, 'The end date is before the start date.');
  if (to - from > 800 * DAY) fail(400, 'Choose a period of up to two years.');
  return { from, to };
}
const lagosDay = (t) => new Date((Number(t) + 3600) * 1000).toISOString().slice(0, 10);

/* ---------- payables ---------- */
// Called when a purchase order is sent. Doing it twice does nothing.
async function openPayable(poId) {
  const po = await get('SELECT so.id, so.supplier_id, so.currency, so.total_cost, so.sent_at, s.payment_days FROM supplier_orders so JOIN suppliers s ON s.id = so.supplier_id WHERE so.id = ?', int(poId));
  if (!po) fail(404, 'Purchase order not found.');
  const t = now();
  await run('INSERT INTO supplier_payables (po_id, supplier_id, currency, amount, due_at, created) VALUES (?,?,?,?,?,?) ON CONFLICT (po_id) DO NOTHING', po.id, po.supplier_id, po.currency, n2(po.total_cost), t + Number(po.payment_days || 0) * DAY, t);
}
const shapePayable = (r, t) => {
  const amount = Number(r.amount), credit = Number(r.credit), net = n2(amount - credit);
  return { id: Number(r.id), po_id: Number(r.po_id), po_ref: r.po_ref, order_ref: r.order_ref, supplier_id: Number(r.supplier_id), supplier: r.supplier, currency: r.currency, amount, credit, net,
    due_at: Number(r.due_at), status: r.status, overdue: r.status === 'open' && Number(r.due_at) < t, paid_at: r.paid_at == null ? null : Number(r.paid_at), paid_amount: r.paid_amount == null ? null : Number(r.paid_amount),
    paid_ngn: r.paid_ngn == null ? null : Number(r.paid_ngn), paid_ref: r.paid_ref, paid_by: r.paid_by, note: r.note };
};
const PAY_SQL = `SELECT p.*, so.ref po_ref, o.ref order_ref, s.name supplier FROM supplier_payables p JOIN supplier_orders so ON so.id = p.po_id JOIN orders o ON o.id = so.order_id JOIN suppliers s ON s.id = p.supplier_id`;
async function payables(q = {}) {
  const t = now(), w = [], a = [];
  if (['open', 'paid', 'void'].includes(q.status)) { w.push('p.status = ?'); a.push(q.status); }
  if (q.supplier_id) { w.push('p.supplier_id = ?'); a.push(int(q.supplier_id)); }
  const rows = (await all(`${PAY_SQL} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY (p.status = 'open') DESC, p.due_at ASC, p.id DESC LIMIT 500`, ...a)).map((r) => shapePayable(r, t));
  let rates = {}; try { rates = await require('./dropship').rates(); } catch { /* shown as unknown */ }
  const by = new Map();
  for (const r of rows.filter((x) => x.status === 'open')) {
    const k = r.supplier_id + ':' + r.currency, g = by.get(k) || { supplier_id: r.supplier_id, supplier: r.supplier, currency: r.currency, owed: 0, overdue: 0, due_7d: 0, orders: 0, owed_ngn: null };
    g.owed = n2(g.owed + r.net); g.orders++; if (r.overdue) g.overdue = n2(g.overdue + r.net); else if (r.due_at < t + 7 * DAY) g.due_7d = n2(g.due_7d + r.net);
    by.set(k, g);
  }
  const suppliers = [...by.values()].map((g) => { try { g.owed_ngn = Math.round(FX.toNaira(g.owed, g.currency, rates)); } catch { g.owed_ngn = null; } return g; });
  return { payables: rows, suppliers, total_owed_ngn: suppliers.every((g) => g.owed_ngn != null) ? suppliers.reduce((a, g) => a + g.owed_ngn, 0) : null, expecting: await expectingRefunds() };
}
// Marks it paid with a reference (a bank transfer number, a wire reference). Nothing leaves the bank from here: this records that it was done.
async function payPayable(id, b, actor) {
  const ref = str(b.reference, 80);
  if (ref.length < 2) fail(400, 'Enter the payment reference (for example the transfer or wire number).');
  return tx(async () => {
    const p = await get('SELECT * FROM supplier_payables WHERE id = ? FOR UPDATE', int(id));
    if (!p) fail(404, 'Payable not found.');
    if (p.status === 'paid') return { unchanged: true };
    if (p.status !== 'open') fail(409, 'This payable is not open.');
    const net = n2(Number(p.amount) - Number(p.credit));
    const amt = b.paid_amount === undefined || b.paid_amount === '' ? net : n2(num(b.paid_amount, 'The amount paid', { min: 0 }));
    if (net > 0 && amt <= 0) fail(400, 'Enter the amount you paid.');
    const ngn = b.paid_ngn === undefined || b.paid_ngn === '' ? null : Math.round(num(b.paid_ngn, 'The Naira you spent', { min: 0 }));
    await run("UPDATE supplier_payables SET status='paid', paid_at=?, paid_amount=?, paid_ngn=?, paid_ref=?, paid_by=?, note=? WHERE id=?", now(), amt, ngn, ref, str(actor, 80), str(b.note, 300), p.id);
    return { unchanged: false };
  });
}

/* ---------- extra costs on an item ---------- */
async function addCost(lineId, b, actor) {
  const l = await get('SELECT id, paid_at FROM dropship_lines WHERE id = ?', int(lineId));
  if (!l) fail(404, 'Item not found.');
  if (!l.paid_at) fail(409, 'The customer has not paid for this item yet.');
  const kind = str(b.kind, 20); if (!COST_KINDS[kind]) fail(400, 'Choose the type of cost.');
  const amt = Math.round(num(b.amount, 'The amount', { min: 1, max: 100000000 }));
  const r = await run('INSERT INTO dropship_line_costs (line_id, kind, amount_ngn, note, created_by, created) VALUES (?,?,?,?,?,?)', l.id, kind, amt, str(b.note, 200), str(actor, 80), now());
  return Number(r.lastInsertRowid);
}
async function removeCost(id) { const r = await run('DELETE FROM dropship_line_costs WHERE id = ?', int(id)); if (!r.changes) fail(404, 'Cost not found.'); }

/* ---------- supplier refunds ---------- */
const lineCostSupplier = (l) => n2((Number(l.unit_cost) + Number(l.ship_cost)) * l.qty);
async function recordSupplierRefund(lineId, b, actor) {
  const mode = str(b.mode, 8); if (!['credit', 'cash'].includes(mode)) fail(400, 'Choose credit against what we owe, or cash received.');
  const ref = str(b.reference, 80);
  if (mode === 'cash' && ref.length < 2) fail(400, 'Enter the reference of the money you received.');
  return tx(async () => {
    const l = await get('SELECT * FROM dropship_lines WHERE id = ? FOR UPDATE', int(lineId));
    if (!l) fail(404, 'Item not found.');
    if (!l.sent_at) fail(409, 'This item was never ordered from the supplier, so there is nothing to claim back.');
    if (!['issue', 'cancelled', 'refunded', 'returned'].includes(l.status)) fail(409, 'A supplier refund can be recorded for an item that has a problem, was cancelled or was returned.');
    const max = lineCostSupplier(l), done = Number((await get('SELECT COALESCE(SUM(amount),0) s FROM supplier_refunds WHERE line_id = ?', l.id)).s);
    const amt = n2(num(b.amount, 'The amount', { min: 0.01, max: 1e10 }));
    if (amt + done > max + 0.005) fail(400, `The supplier cannot refund more than we paid for this item (${max.toFixed(2)} ${l.cost_currency}, ${done.toFixed(2)} already recorded).`);
    if (mode === 'credit') {
      const p = l.po_id ? await get('SELECT * FROM supplier_payables WHERE po_id = ? FOR UPDATE', l.po_id) : null;
      if (!p || p.status !== 'open') fail(409, 'We have already paid this purchase order, so record the refund as cash received.');
      if (Number(p.credit) + amt > Number(p.amount) + 0.005) fail(400, 'That is more than we owe on this purchase order. Record the rest as cash received.');
      await run('UPDATE supplier_payables SET credit = credit + ? WHERE id = ?', amt, p.id);
    }
    const rate = l.cost_fx_rate != null ? Number(l.cost_fx_rate) : (l.cost_ngn != null && max > 0 ? Number(l.cost_ngn) / max : null);
    const ngn = rate != null ? Math.round(amt * rate) : 0;
    const r = await run('INSERT INTO supplier_refunds (line_id, supplier_id, currency, amount, amount_ngn, mode, reference, note, created_by, created) VALUES (?,?,?,?,?,?,?,?,?,?)', l.id, l.supplier_id, l.cost_currency, amt, ngn, mode, ref, str(b.note, 200), str(actor, 80), now());
    await run('INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, created) VALUES (?,?,?,?,?,?)', l.id, l.status, l.status, `Supplier refund recorded: ${amt.toFixed(2)} ${l.cost_currency} (${mode})`, str(actor, 80) || 'admin', now());
    return Number(r.lastInsertRowid);
  });
}
// Items we paid (or owe) a supplier for that went wrong, with no supplier refund recorded yet: a to-do list so nobody forgets to claim the money back.
async function expectingRefunds() {
  const rows = await all(`SELECT l.id, l.status, l.qty, l.unit_cost, l.ship_cost, l.cost_currency, l.issue_kind, o.ref order_ref, s.name supplier, i.name,
      COALESCE((SELECT SUM(amount) FROM supplier_refunds r WHERE r.line_id = l.id), 0) got, r.status return_status
    FROM dropship_lines l JOIN orders o ON o.id = l.order_id JOIN suppliers s ON s.id = l.supplier_id JOIN order_items i ON i.id = l.order_item_id LEFT JOIN dropship_returns r ON r.line_id = l.id
    WHERE l.sent_at IS NOT NULL AND (l.status IN ('issue','cancelled','refunded') OR (l.status = 'returned' AND COALESCE(r.status,'') <> 'rejected'))
    ORDER BY l.updated DESC LIMIT 200`);
  return rows.map((l) => ({ line_id: Number(l.id), order_ref: l.order_ref, supplier: l.supplier, name: l.name, status: l.status, issue_kind: l.issue_kind, return_status: l.return_status || '', currency: l.cost_currency, cost: lineCostSupplier(l), recorded: Number(l.got) }))
    .filter((l) => l.recorded + 0.005 < l.cost);
}

/* ---------- returns to the supplier ---------- */
async function startReturn(lineId, b, actor) {
  const reason = str(b.reason, 300); if (reason.length < 3) fail(400, 'Say why the item is being returned.');
  return tx(async () => {
    const l = await get('SELECT id, status, sell_price, qty FROM dropship_lines WHERE id = ? FOR UPDATE', int(lineId));
    if (!l) fail(404, 'Item not found.');
    if (await get('SELECT 1 x FROM dropship_returns WHERE line_id = ?', l.id)) fail(409, 'A return is already open for this item.');
    if (l.status !== 'delivered') fail(409, 'Only a delivered item can be returned.');
    await DO.transition(l.id, 'returned', { actor, note: 'Return: ' + reason, key: 'return:' + l.id });
    await run('UPDATE dropship_lines SET refund_due = ? WHERE id = ?', l.sell_price * l.qty, l.id);
    const r = await run('INSERT INTO dropship_returns (line_id, reason, rma_no, created, updated, created_by) VALUES (?,?,?,?,?,?)', l.id, reason, str(b.rma_no, 60), now(), now(), str(actor, 80));
    return Number(r.lastInsertRowid);
  });
}
async function updateReturn(id, b, actor) {
  return tx(async () => {
    const r = await get('SELECT * FROM dropship_returns WHERE id = ? FOR UPDATE', int(id));
    if (!r) fail(404, 'Return not found.');
    const to = str(b.status, 12) || r.status, set = { updated: now() };
    for (const k of ['rma_no', 'carrier', 'tracking_no']) if (b[k] !== undefined) set[k] = str(b[k], 80);
    if (b.note !== undefined) set.note = str(b.note, 300);
    if (to !== r.status) {
      if (!(RETURN_NEXT[r.status] || []).includes(to)) fail(409, `A return that is "${RETURN_LABEL[r.status]}" cannot go to "${RETURN_LABEL[to] || to}".`);
      if (to === 'sent_back' && !((set.carrier ?? r.carrier) && (set.tracking_no ?? r.tracking_no))) fail(400, 'Enter the carrier and tracking number of the parcel going back.');
      set.status = to;
      const l = await get('SELECT id, status FROM dropship_lines WHERE id = ?', r.line_id);
      await run('INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, created) VALUES (?,?,?,?,?,?)', l.id, l.status, l.status, 'Return to supplier: ' + RETURN_LABEL[to], str(actor, 80) || 'admin', now());
    }
    const cols = Object.keys(set);
    await run(`UPDATE dropship_returns SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`, ...cols.map((c) => set[c]), r.id);
    return { status: set.status || r.status };
  });
}
async function returns(q = {}) {
  const open = q.all ? '' : "WHERE r.status NOT IN ('closed')";
  const rows = await all(`SELECT r.*, l.status line_status, l.qty, l.sell_price, o.ref order_ref, s.name supplier, i.name FROM dropship_returns r JOIN dropship_lines l ON l.id = r.line_id JOIN orders o ON o.id = l.order_id JOIN suppliers s ON s.id = l.supplier_id JOIN order_items i ON i.id = l.order_item_id ${open} ORDER BY r.id DESC LIMIT 200`);
  return rows.map((r) => ({ id: Number(r.id), line_id: Number(r.line_id), order_ref: r.order_ref, supplier: r.supplier, name: r.name, status: r.status, label: RETURN_LABEL[r.status], next: RETURN_NEXT[r.status], reason: r.reason, rma_no: r.rma_no, carrier: r.carrier, tracking_no: r.tracking_no, note: r.note,
    line_status: r.line_status, refund_due: Number(r.sell_price) * r.qty, created: Number(r.created) }));
}

/* ---------- one item's money, for the admin screen ---------- */
async function lineMoney(lineId) {
  const l = await get('SELECT l.*, o.ref order_ref, o.currency order_currency, o.fx_rate order_fx FROM dropship_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = ?', int(lineId));
  if (!l) fail(404, 'Item not found.');
  const costs = await all('SELECT id, kind, amount_ngn, note, created_by, created FROM dropship_line_costs WHERE line_id = ? ORDER BY id', l.id);
  const sref = await all('SELECT id, currency, amount, amount_ngn, mode, reference, note, created_by, created FROM supplier_refunds WHERE line_id = ? ORDER BY id', l.id);
  const cref = await get('SELECT amount_ngn, reference, note, created_by, created FROM dropship_refunds WHERE line_id = ?', l.id);
  const ret = await get('SELECT id, status, reason, rma_no, carrier, tracking_no, note FROM dropship_returns WHERE line_id = ?', l.id);
  const p = (await profitLines({ line_id: l.id }))[0];
  return { line_id: Number(l.id), order_ref: l.order_ref, status: l.status, sell_total: l.sell_price * l.qty, cost_currency: l.cost_currency, cost_supplier: lineCostSupplier(l), cost_ngn: l.cost_ngn, cost_fx_rate: l.cost_fx_rate == null ? null : Number(l.cost_fx_rate),
    customer_currency: l.order_currency, customer_fx_rate: l.order_fx == null ? null : Number(l.order_fx), costs: costs.map((c) => ({ ...c, id: Number(c.id), label: COST_KINDS[c.kind], created: Number(c.created) })),
    supplier_refunds: sref.map((r) => ({ ...r, id: Number(r.id), amount: Number(r.amount), created: Number(r.created) })), customer_refund: cref ? { ...cref, created: Number(cref.created) } : null, refund_due: l.refund_due,
    return: ret ? { ...ret, id: Number(ret.id), next: RETURN_NEXT[ret.status], label: RETURN_LABEL[ret.status] } : null, profit: p ? p.profit : null };
}

/* ---------- profit reports ---------- */
async function profitLines(q = {}) {
  const w = ['l.paid_at IS NOT NULL'], a = [];
  if (q.from != null) { w.push('l.paid_at >= ?'); a.push(q.from); }
  if (q.to != null) { w.push('l.paid_at < ?'); a.push(q.to); }
  if (q.line_id) { w.push('l.id = ?'); a.push(int(q.line_id)); }
  if (q.supplier_id) { w.push('l.supplier_id = ?'); a.push(int(q.supplier_id)); }
  if (q.country) { w.push('o.country = ?'); a.push(String(q.country).toUpperCase().slice(0, 2)); }
  const rows = await all(`SELECT l.id, l.order_id, l.product_id, l.supplier_id, l.status, l.qty, l.sell_price, l.unit_cost, l.ship_cost, l.cost_currency, l.cost_ngn, l.cost_fx_rate, l.paid_at, l.sent_at,
      o.ref order_ref, o.country, o.currency order_currency, o.fx_rate order_fx, o.total order_total, s.name supplier, i.name,
      COALESCE((SELECT amount_ngn FROM dropship_refunds r WHERE r.line_id = l.id), 0) refunds_ngn,
      COALESCE((SELECT SUM(amount_ngn) FROM supplier_refunds r WHERE r.line_id = l.id), 0) srefunds_ngn
    FROM dropship_lines l JOIN orders o ON o.id = l.order_id JOIN suppliers s ON s.id = l.supplier_id JOIN order_items i ON i.id = l.order_item_id
    WHERE ${w.join(' AND ')} ORDER BY l.paid_at DESC, l.id DESC LIMIT 20000`, ...a);
  const ids = rows.map((r) => Number(r.id)), costs = new Map();
  if (ids.length) for (const c of await all(`SELECT line_id, kind, SUM(amount_ngn) amt FROM dropship_line_costs WHERE line_id = ANY(?) GROUP BY line_id, kind`, ids)) { const m = costs.get(Number(c.line_id)) || {}; m[c.kind] = Number(c.amt); costs.set(Number(c.line_id), m); }
  const fees = await require('./dropship').settings().catch(() => P.DEFAULTS), f = { fee_pct: fees.fee_pct, fee_flat: fees.fee_flat, fee_flat_from: fees.fee_flat_from, fee_cap: fees.fee_cap };
  return rows.map((r) => {
    const rev = r.sell_price * r.qty, fee_estimate = r.order_total > 0 ? P.paymentFee(Number(r.order_total), f) * Math.min(1, rev / Number(r.order_total)) : 0;
    const profit = lineProfit({ sell_price: r.sell_price, qty: r.qty, paid: true, sent: !!r.sent_at, cost_ngn: r.cost_ngn, unit_cost: r.unit_cost, ship_cost: r.ship_cost, refunds_ngn: Number(r.refunds_ngn), supplier_refunds_ngn: Number(r.srefunds_ngn), costs: costs.get(Number(r.id)) || {}, fee_estimate });
    return { id: Number(r.id), order_id: Number(r.order_id), order_ref: r.order_ref, product_id: Number(r.product_id), supplier_id: Number(r.supplier_id), supplier: r.supplier, name: r.name, country: r.country, status: r.status, paid_at: Number(r.paid_at),
      qty: r.qty, cost_currency: r.cost_currency, cost_fx_rate: r.cost_fx_rate == null ? null : Number(r.cost_fx_rate), customer_currency: r.order_currency, customer_fx_rate: r.order_fx == null ? null : Number(r.order_fx), profit };
  });
}
const GROUPS = {
  order: { key: (l) => l.order_ref, label: 'Order' }, supplier: { key: (l) => l.supplier, label: 'Supplier' }, country: { key: (l) => l.country, label: 'Customer country' },
  product: { key: (l) => l.name, label: 'Product' }, day: { key: (l) => lagosDay(l.paid_at), label: 'Day' }, month: { key: (l) => lagosDay(l.paid_at).slice(0, 7), label: 'Month' },
};
async function report(q = {}) {
  const group = GROUPS[q.group] ? q.group : 'order', { from, to } = period(q);
  const lines = await profitLines({ from, to, supplier_id: q.supplier_id, country: q.country });
  const map = new Map(), total = {};
  for (const l of lines) {
    const k = GROUPS[group].key(l), g = map.get(k) || { key: k, rates: new Set(), paid_at: l.paid_at, ids: new Set() };
    addInto(g, l.profit); g.ids.add(l.order_id);
    g.rates.add(`${l.cost_currency}${l.cost_currency === 'NGN' ? '' : ' @ ' + (l.cost_fx_rate == null ? '?' : l.cost_fx_rate)}`);
    if (group === 'order') g.customer = `${l.customer_currency}${l.customer_currency === 'NGN' ? '' : ' @ ' + (l.customer_fx_rate == null ? '?' : l.customer_fx_rate)}`;
    map.set(k, g); addInto(total, l.profit);
  }
  const rows = [...map.values()].map((g) => ({ ...finish(g), orders: g.ids.size, supplier_rates: [...g.rates].join(', '), customer_rate: g.customer || '', ids: undefined, rates: undefined }))
    .sort((x, y) => (group === 'day' || group === 'month' ? (x.key < y.key ? 1 : -1) : y.net_profit - x.net_profit));
  return { group, group_label: GROUPS[group].label, from, to, rows, total: finish(total), note: 'Revenue is the price of the items the customer paid for (delivery fees are not included). Supplier cost uses the exchange rate fixed when the order was placed. Payment fees are estimated from your fee settings unless the real fee is entered on the item.' };
}
const COLS = [['revenue', 'Revenue'], ['refunds', 'Customer refunds'], ['supplier_cost', 'Supplier cost'], ['supplier_shipping', 'Supplier shipping'], ['extra_shipping', 'Extra shipping'], ['duty', 'Duty'], ['fees', 'Payment fees'], ['other', 'Other costs'], ['supplier_refunds', 'Supplier refunds'], ['net_profit', 'Net profit'], ['margin_pct', 'Margin %']];
async function exportXlsx(q) {
  const r = await report(q), X = require('./xlsx');
  const head = [r.group_label, 'Orders', 'Items', ...(r.group === 'order' ? ['Customer currency and rate'] : []), 'Supplier currency and rate', ...COLS.map((c) => c[1])];
  const body = r.rows.map((x) => [x.key, x.orders, x.lines, ...(r.group === 'order' ? [x.customer_rate] : []), x.supplier_rates, ...COLS.map(([k]) => (x[k] == null ? '' : x[k]))]);
  const t = r.total, foot = ['Total', '', t.lines || 0, ...(r.group === 'order' ? [''] : []), '', ...COLS.map(([k]) => (t[k] == null ? '' : t[k]))];
  const info = [['Dropshipping profit report'], ['From', lagosDay(r.from)], ['To', lagosDay(r.to - DAY)], ['Grouped by', r.group_label], ['All amounts are Naira.'], [r.note]];
  const pay = await payables({ status: 'open' });
  const pw = [['Supplier', 'Purchase order', 'Order', 'Currency', 'Amount', 'Credit', 'Owed', 'Due', 'Overdue'], ...pay.payables.map((p) => [p.supplier, p.po_ref, p.order_ref, p.currency, p.amount, p.credit, p.net, lagosDay(p.due_at), p.overdue ? 'Yes' : ''])];
  return X.writeXlsx([{ name: 'Profit', rows: [head, ...body, foot], widths: [26, 9, 8, 22, 22, ...COLS.map(() => 14)] }, { name: 'Open payables', rows: pw, widths: [24, 16, 16, 9, 12, 12, 12, 12, 9] }, { name: 'About', rows: info, header: false, widths: [20, 90] }]);
}

module.exports = { COST_KINDS, RETURN_NEXT, RETURN_LABEL, GROUPS, lineProfit, period, dayStart, openPayable, payables, payPayable, addCost, removeCost, recordSupplierRefund, expectingRefunds, startReturn, updateReturn, returns, lineMoney, profitLines, report, exportXlsx };
