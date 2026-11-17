'use strict';
// Wholesale warehouse reports. Every report answers with the same shape so one screen (and one CSV button) can show them all:
//   { name, title, note, from, to, summary: [{label, value, type}], columns: [{key, label, type}], rows: [...] }
// type: money (naira), int, hours, date (epoch seconds), text. Periods are whole days in Lagos time (UTC+1).
const { get, all } = require('./db');
const S = require('./shop');
const WH = require('./warehouse');
const { fail, str, int } = S;

const LAGOS = 3600, DAY = 86400;
const ymd = (sec) => new Date((sec + LAGOS) * 1000).toISOString().slice(0, 10);
function period(q) {
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
  const nowS = Math.floor(Date.now() / 1000);
  const to = ok(q.to) ? q.to : ymd(nowS), from = ok(q.from) ? q.from : ymd(nowS - 29 * DAY);
  const a = Date.parse(from + 'T00:00:00Z') / 1000 - LAGOS, b = Date.parse(to + 'T00:00:00Z') / 1000 - LAGOS + DAY;   // [a, b)
  if (b <= a) fail(400, 'The end date must not be before the start date.');
  if (b - a > 800 * DAY) fail(400, 'Choose a period of at most two years.');
  return { from, to, a, b };
}
const C = (key, label, type = 'text') => ({ key, label, type });
const sum = (rows, k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0);
const n = (v) => Number(v || 0);

const REPORTS = {
  // ----- stock -----
  async stock() {
    const wh = await WH.mainWarehouseId();
    const rows = (await all(`SELECT p.name, p.sku, p.store, b.on_hand, b.reserved, b.on_hand - b.reserved AS available, p.wholesale_price
      FROM wholesale_stock_balances b JOIN products p ON p.id=b.product_id WHERE b.warehouse_id=? AND b.on_hand > 0 ORDER BY p.store, p.name`, wh))
      .map((r) => ({ ...r, on_hand: n(r.on_hand), reserved: n(r.reserved), available: n(r.available), wholesale_price: r.wholesale_price == null ? null : n(r.wholesale_price), value: r.wholesale_price == null ? 0 : n(r.on_hand) * n(r.wholesale_price) }));
    return { title: 'Stock in the warehouse', note: 'Valued at the wholesale selling price (the system does not hold what you paid for the goods). Products with no wholesale price show a value of zero.',
      summary: [{ label: 'Products held', value: rows.length, type: 'int' }, { label: 'Units on hand', value: sum(rows, 'on_hand'), type: 'int' }, { label: 'Units set aside for buyers', value: sum(rows, 'reserved'), type: 'int' }, { label: 'Value at wholesale prices', value: sum(rows, 'value'), type: 'money' }],
      columns: [C('name', 'Product'), C('sku', 'SKU'), C('store', 'Department'), C('on_hand', 'On hand', 'int'), C('reserved', 'Set aside', 'int'), C('available', 'Available', 'int'), C('wholesale_price', 'Wholesale price', 'money'), C('value', 'Value', 'money')], rows };
  },
  async 'low-stock'() {
    const wh = await WH.mainWarehouseId();
    const rows = (await all(`SELECT p.name, p.sku, p.store, b.on_hand, b.reserved, b.on_hand - b.reserved AS available, b.reorder_level
      FROM wholesale_stock_balances b JOIN products p ON p.id=b.product_id WHERE b.warehouse_id=? AND b.reorder_level > 0 AND b.on_hand - b.reserved <= b.reorder_level ORDER BY (b.on_hand - b.reserved) - b.reorder_level, p.name`, wh))
      .map((r) => ({ ...r, on_hand: n(r.on_hand), reserved: n(r.reserved), available: n(r.available), reorder_level: n(r.reorder_level), shortfall: n(r.reorder_level) - n(r.available) }));
    return { title: 'Low stock', note: 'Products whose available stock has fallen to their reorder level. Set reorder levels on the Stock screen.',
      summary: [{ label: 'Products to reorder', value: rows.length, type: 'int' }, { label: 'Out of stock', value: rows.filter((r) => r.available <= 0).length, type: 'int' }],
      columns: [C('name', 'Product'), C('sku', 'SKU'), C('store', 'Department'), C('available', 'Available', 'int'), C('reorder_level', 'Reorder at', 'int'), C('shortfall', 'Short by', 'int')], rows };
  },
  async movements(q) {
    const p = period(q);
    const rows = (await all(`SELECT p.name, p.sku,
        COALESCE(SUM(CASE WHEN m.type IN ('opening','receipt','transfer_in') THEN m.qty END),0) AS received,
        COALESCE(SUM(CASE WHEN m.type='return' THEN m.qty END),0) AS returned,
        COALESCE(SUM(CASE WHEN m.type='adjustment' THEN m.delta_on_hand END),0) AS adjusted,
        COALESCE(SUM(CASE WHEN m.type='damaged' THEN m.qty END),0) AS damaged,
        COALESCE(SUM(CASE WHEN m.type='expired' THEN m.qty END),0) AS expired,
        COALESCE(SUM(CASE WHEN m.type='dispatch' THEN m.qty END),0) AS dispatched,
        COALESCE((SELECT b.on_hand FROM wholesale_stock_balances b WHERE b.product_id=p.id LIMIT 1),0) AS on_hand_now
      FROM wholesale_stock_movements m JOIN products p ON p.id=m.product_id WHERE m.created >= ? AND m.created < ? GROUP BY p.id, p.name, p.sku ORDER BY p.name`, p.a, p.b))
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, ['name', 'sku'].includes(k) ? v : n(v)])));
    return { title: 'Stock movements', note: 'What came in and went out of the warehouse in the period. "On hand now" is today\'s balance, not the balance at the end of the period.', from: p.from, to: p.to,
      summary: [{ label: 'Received', value: sum(rows, 'received'), type: 'int' }, { label: 'Dispatched to buyers', value: sum(rows, 'dispatched'), type: 'int' }, { label: 'Damaged + expired', value: sum(rows, 'damaged') + sum(rows, 'expired'), type: 'int' }, { label: 'Returned by buyers', value: sum(rows, 'returned'), type: 'int' }],
      columns: [C('name', 'Product'), C('sku', 'SKU'), C('received', 'Received', 'int'), C('returned', 'Returned', 'int'), C('adjusted', 'Count corrections (net)', 'int'), C('damaged', 'Damaged', 'int'), C('expired', 'Expired', 'int'), C('dispatched', 'Dispatched', 'int'), C('on_hand_now', 'On hand now', 'int')], rows };
  },
  // ----- sales (money: needs reports or finance) -----
  async sales(q) {
    const p = period(q);
    const rows = (await all(`SELECT i.name, MAX(pr.sku) AS sku, SUM(i.qty) AS units, SUM(i.qty * i.unit_price) AS revenue, COUNT(DISTINCT qt.id) AS orders
      FROM wholesale_quote_items i JOIN wholesale_quotes qt ON qt.id=i.quote_id LEFT JOIN products pr ON pr.id=i.product_id
      WHERE qt.order_no IS NOT NULL AND qt.status IN ('paid','shipped','delivered') AND qt.paid_at >= ? AND qt.paid_at < ? GROUP BY i.name ORDER BY revenue DESC`, p.a, p.b))
      .map((r) => ({ ...r, units: n(r.units), revenue: n(r.revenue), orders: n(r.orders) }));
    const t = await get(`SELECT COUNT(*) AS orders, COALESCE(SUM(goods_total),0) AS goods, COALESCE(SUM(logistics_fee),0) AS logistics, COALESCE(SUM(service_fee),0) AS service, COALESCE(SUM(total),0) AS total
      FROM wholesale_quotes WHERE order_no IS NOT NULL AND status IN ('paid','shipped','delivered') AND paid_at >= ? AND paid_at < ?`, p.a, p.b);
    return { title: 'Wholesale sales by product', note: 'Paid orders only, by the date the payment was received.', from: p.from, to: p.to,
      summary: [{ label: 'Paid orders', value: n(t.orders), type: 'int' }, { label: 'Goods sold', value: n(t.goods), type: 'money' }, { label: 'Logistics fees', value: n(t.logistics), type: 'money' }, { label: 'Service fees', value: n(t.service), type: 'money' }, { label: 'Total received', value: n(t.total), type: 'money' }, { label: 'Average order', value: n(t.orders) ? Math.round(n(t.total) / n(t.orders)) : 0, type: 'money' }],
      columns: [C('name', 'Product'), C('sku', 'SKU'), C('orders', 'Orders', 'int'), C('units', 'Units sold', 'int'), C('revenue', 'Sales value', 'money')], rows };
  },
  async buyers(q) {
    const p = period(q);
    const rows = (await all(`SELECT a.business_name, a.contact_name, a.phone, COUNT(*) AS orders, SUM(qt.total) AS total, MAX(qt.paid_at) AS last_order
      FROM wholesale_quotes qt JOIN wholesale_accounts a ON a.id=qt.account_id WHERE qt.order_no IS NOT NULL AND qt.status IN ('paid','shipped','delivered') AND qt.paid_at >= ? AND qt.paid_at < ? GROUP BY a.id ORDER BY total DESC`, p.a, p.b))
      .map((r) => ({ ...r, orders: n(r.orders), total: n(r.total), last_order: n(r.last_order) }));
    return { title: 'Wholesale sales by buyer', note: 'Paid orders only.', from: p.from, to: p.to,
      summary: [{ label: 'Buying customers', value: rows.length, type: 'int' }, { label: 'Total received', value: sum(rows, 'total'), type: 'money' }],
      columns: [C('business_name', 'Buyer'), C('contact_name', 'Contact'), C('phone', 'Phone'), C('orders', 'Orders', 'int'), C('total', 'Total paid', 'money'), C('last_order', 'Last order', 'date')], rows };
  },
  async receivables() {
    const nowS = Math.floor(Date.now() / 1000);
    const rows = (await all(`SELECT qt.ref, a.business_name, a.phone, qt.total, qt.accepted_at, qt.pay_by FROM wholesale_quotes qt JOIN wholesale_accounts a ON a.id=qt.account_id WHERE qt.status='accepted' ORDER BY qt.pay_by NULLS LAST`))
      .map((r) => ({ ...r, total: n(r.total), accepted_at: n(r.accepted_at), pay_by: r.pay_by == null ? null : n(r.pay_by), overdue_days: r.pay_by != null && n(r.pay_by) < nowS ? Math.ceil((nowS - n(r.pay_by)) / DAY) : 0 }));
    return { title: 'Waiting for payment', note: 'Quotations the buyer accepted that are not paid yet. The goods are set aside for them until the payment date; after that the quote lapses and the goods are released.',
      summary: [{ label: 'Quotes waiting', value: rows.length, type: 'int' }, { label: 'Amount waiting', value: sum(rows, 'total'), type: 'money' }, { label: 'Past the payment date', value: rows.filter((r) => r.overdue_days > 0).length, type: 'int' }],
      columns: [C('ref', 'Quote'), C('business_name', 'Buyer'), C('phone', 'Phone'), C('total', 'Amount', 'money'), C('accepted_at', 'Accepted', 'date'), C('pay_by', 'Pay by', 'date'), C('overdue_days', 'Days overdue', 'int')], rows };
  },
  async invoices(q) {
    const p = period(q);
    const rows = (await all(`SELECT i.invoice_no, i.order_no, i.issued, a.business_name, i.total, qt.payment_method, qt.payment_ref, qt.status AS order_status FROM wholesale_invoices i JOIN wholesale_quotes qt ON qt.id=i.quote_id JOIN wholesale_accounts a ON a.id=i.account_id WHERE i.issued >= ? AND i.issued < ? ORDER BY i.id`, p.a, p.b))
      .map((r) => ({ ...r, issued: n(r.issued), total: n(r.total), order_status: r.order_status === 'cancelled' ? 'Cancelled after payment: refund by hand' : 'Valid' }));
    return { title: 'Final invoices issued', note: 'One invoice per paid order, numbered in order with no gaps. An order cancelled after payment keeps its invoice and is marked here, because the system does not issue credit notes yet.', from: p.from, to: p.to,
      summary: [{ label: 'Invoices', value: rows.length, type: 'int' }, { label: 'Total', value: sum(rows, 'total'), type: 'money' }, { label: 'Cancelled after payment', value: rows.filter((r) => r.order_status !== 'Valid').length, type: 'int' }],
      columns: [C('invoice_no', 'Invoice'), C('order_no', 'Order'), C('issued', 'Issued', 'date'), C('business_name', 'Buyer'), C('total', 'Total', 'money'), C('order_status', 'Status'), C('payment_method', 'Paid by'), C('payment_ref', 'Payment reference')], rows };
  },
  // ----- fulfilment performance -----
  async fulfilment(q) {
    const p = period(q), nowS = Math.floor(Date.now() / 1000);
    const rows = (await all(`SELECT qt.order_no, a.business_name, qt.paid_at, f.stage, f.picked_at, f.packed_at, f.dispatched_at, f.delivered_at, f.failed_attempts
      FROM wholesale_fulfilments f JOIN wholesale_quotes qt ON qt.id=f.quote_id JOIN wholesale_accounts a ON a.id=qt.account_id
      WHERE qt.status IN ('paid','shipped','delivered') AND qt.paid_at >= ? AND qt.paid_at < ? ORDER BY qt.paid_at`, p.a, p.b))
      .map((r) => { const h = (t) => (t ? Math.round(((n(t) - n(r.paid_at)) / 3600) * 10) / 10 : null); return { order_no: r.order_no, business_name: r.business_name, paid_at: n(r.paid_at), stage: require('./fulfilment').STAGE_LABEL[r.stage] || r.stage, hours_to_pick: h(r.picked_at), hours_to_dispatch: h(r.dispatched_at), hours_to_deliver: h(r.delivered_at), failed_attempts: n(r.failed_attempts), late: !r.dispatched_at && nowS - n(r.paid_at) > 48 * 3600 ? 'Yes' : '' }; });
    const avg = (k) => { const v = rows.map((r) => r[k]).filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : 0; };
    return { title: 'Fulfilment speed', note: 'Hours from payment to each step. "Late" means paid more than 48 hours ago and still not dispatched.', from: p.from, to: p.to,
      summary: [{ label: 'Orders', value: rows.length, type: 'int' }, { label: 'Average hours to pick', value: avg('hours_to_pick'), type: 'hours' }, { label: 'Average hours to dispatch', value: avg('hours_to_dispatch'), type: 'hours' }, { label: 'Average hours to deliver', value: avg('hours_to_deliver'), type: 'hours' }, { label: 'Late orders', value: rows.filter((r) => r.late).length, type: 'int' }, { label: 'Failed delivery attempts', value: sum(rows, 'failed_attempts'), type: 'int' }],
      columns: [C('order_no', 'Order'), C('business_name', 'Buyer'), C('paid_at', 'Paid', 'date'), C('stage', 'Stage'), C('hours_to_pick', 'Hours to pick', 'hours'), C('hours_to_dispatch', 'Hours to dispatch', 'hours'), C('hours_to_deliver', 'Hours to deliver', 'hours'), C('failed_attempts', 'Failed attempts', 'int'), C('late', 'Late')], rows };
  },
};
const LIST = [
  ['stock', 'Stock and value', false], ['low-stock', 'Low stock', false], ['movements', 'Stock movements', true], ['fulfilment', 'Fulfilment speed', true],
  ['sales', 'Sales by product', true, true], ['buyers', 'Sales by buyer', true, true], ['invoices', 'Invoices issued', true, true], ['receivables', 'Waiting for payment', false, true],
].map(([name, title, dated, money]) => ({ name, title, dated: !!dated, money: !!money }));

async function run(name, q = {}) {
  const fn = Object.prototype.hasOwnProperty.call(REPORTS, name) ? REPORTS[name] : null;
  if (!fn) fail(404, 'No such report.');
  return { name, ...(await fn(q)) };
}
module.exports = { run, LIST };
