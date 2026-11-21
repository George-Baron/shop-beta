'use strict';
// Trade reports. Every figure is read from saved records. Where a cost or a rate is not on file the cell is left empty and the report says so;
// nothing is estimated. Reports can be filtered by date and country and downloaded as Excel, CSV or PDF.
const { get, all, now } = require('../db');
const S = require('../shop');
const X = require('../xlsx');
const PDF = require('./pdf');
const FX = require('./fx');
const { fail } = S;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const days = (secs) => (secs == null ? null : Math.round((Number(secs) / 86400) * 10) / 10);

function range(q) {
  const d = (v, end) => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) fail(400, 'Dates must look like 2026-12-31.'); return Math.floor(new Date(String(v) + (end ? 'T23:59:59Z' : 'T00:00:00Z')).getTime() / 1000); };
  const to = d(q.to, true) || now() + 86400, from = d(q.from, false) || to - 90 * 86400; if (from > to) fail(400, 'The start date is after the end date.');
  const country = q.country ? String(q.country).toUpperCase().slice(0, 2) : ''; if (country && !/^[A-Z]{2}$/.test(country)) fail(400, 'Choose a valid country.');
  return { from, to, country };
}
const C = (key, label, type = 'text') => ({ key, label, type });
const PAID = "o.payment_status IN ('paid','refunded') AND eo.status <> 'cancelled'";

const REPORTS = {
  sales_by_country: { title: 'International sales by country', money: false, async run(f) {
    const rows = await all(`SELECT eo.destination_country code, c.name, COUNT(*) orders, COALESCE(SUM(o.total),0) revenue, COALESCE(AVG(o.total),0) avg FROM export_orders eo JOIN orders o ON o.id=eo.order_id JOIN trade_countries c ON c.code=eo.destination_country WHERE ${PAID} AND eo.created BETWEEN ? AND ? ${f.country ? 'AND eo.destination_country=?' : ''} GROUP BY eo.destination_country, c.name ORDER BY revenue DESC`, f.from, f.to, ...(f.country ? [f.country] : []));
    return { columns: [C('name', 'Country'), C('orders', 'Paid orders', 'int'), C('revenue_ngn', 'Sales (NGN)', 'ngn'), C('avg_ngn', 'Average order (NGN)', 'ngn')], rows: rows.map((r) => ({ name: r.name, orders: Number(r.orders), revenue_ngn: r2(r.revenue), avg_ngn: r2(r.avg) })), notes: ['Paid orders only, in naira as charged.'] };
  } },
  export_profitability: { title: 'Export profitability', async run(f) {
    const rows = await all(`SELECT eo.ref, o.ref order_ref, eo.destination_country country, eo.subtotal*eo.fx_rate_to_ngn goods_ngn, o.total total_ngn,
      (SELECT COALESCE(SUM(b.cost * CASE WHEN b.currency='NGN' THEN 1 ELSE eo.fx_rate_to_ngn END),0) FROM shipping_bookings b WHERE b.export_order_id=eo.id AND b.status='booked') ship_cost,
      (SELECT COUNT(*) FROM shipping_bookings b WHERE b.export_order_id=eo.id AND b.status='booked') booked,
      (SELECT COALESCE(SUM(i.qty*pc.avg_cost_ngn),0) FROM export_order_items i JOIN trade_product_costs pc ON pc.product_id=i.product_id WHERE i.export_order_id=eo.id) goods_cost,
      (SELECT COUNT(*) FROM export_order_items i WHERE i.export_order_id=eo.id AND NOT EXISTS (SELECT 1 FROM trade_product_costs pc WHERE pc.product_id=i.product_id)) unknown_lines
      FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE ${PAID} AND eo.created BETWEEN ? AND ? ${f.country ? 'AND eo.destination_country=?' : ''} ORDER BY eo.id DESC LIMIT 1000`, f.from, f.to, ...(f.country ? [f.country] : []));
    const out = rows.map((r) => { const known = Number(r.unknown_lines) === 0 && Number(r.booked) > 0; return { ref: r.ref, country: r.country, total_ngn: r2(r.total_ngn), goods_cost_ngn: Number(r.unknown_lines) === 0 ? r2(r.goods_cost) : null, shipping_cost_ngn: Number(r.booked) > 0 ? r2(r.ship_cost) : null, profit_ngn: known ? r2(Number(r.total_ngn) - Number(r.goods_cost) - Number(r.ship_cost)) : null, basis: known ? 'complete' : Number(r.unknown_lines) > 0 ? 'goods cost not on file' : 'no booked shipment cost' }; });
    const done = out.filter((x) => x.profit_ngn != null);
    return { columns: [C('ref', 'Order'), C('country', 'To'), C('total_ngn', 'Charged (NGN)', 'ngn'), C('goods_cost_ngn', 'Goods cost (NGN)', 'ngn'), C('shipping_cost_ngn', 'Shipping cost (NGN)', 'ngn'), C('profit_ngn', 'Profit (NGN)', 'ngn'), C('basis', 'Basis')], rows: out, summary: { orders: out.length, orders_with_complete_cost: done.length, profit_ngn: r2(done.reduce((a, x) => a + x.profit_ngn, 0)) }, notes: ['Profit is shown only when the goods cost (from received imports) and a booked carrier cost are both on file. Duties paid by customers or carriers are not included.'] };
  } },
  import_costs_by_supplier: { title: 'Import costs by supplier', async run(f) {
    const rows = await all(`SELECT sp.name, sp.country_code AS country, COUNT(*) shipments, SUM(s.purchase_value*COALESCE(s.fx_rate_to_ngn,0)) purchase, SUM(s.landed_cost*COALESCE(s.fx_rate_to_ngn,0)) landed, COUNT(*) FILTER (WHERE s.fx_rate_to_ngn IS NULL) no_rate FROM import_shipments s JOIN international_suppliers sp ON sp.id=s.supplier_id WHERE s.status NOT IN ('draft','quotation_requested') AND s.created BETWEEN ? AND ? ${f.country ? 'AND s.supplier_country=?' : ''} GROUP BY sp.id, sp.name, sp.country_code ORDER BY landed DESC NULLS LAST`, f.from, f.to, ...(f.country ? [f.country] : []));
    return { columns: [C('name', 'Supplier'), C('country', 'Country'), C('shipments', 'Shipments', 'int'), C('purchase_ngn', 'Purchase value (NGN)', 'ngn'), C('landed_ngn', 'Landed cost (NGN)', 'ngn'), C('no_rate', 'Shipments without a saved rate', 'int')], rows: rows.map((r) => ({ name: r.name, country: r.country, shipments: Number(r.shipments), purchase_ngn: r2(r.purchase), landed_ngn: r2(r.landed), no_rate: Number(r.no_rate) })), notes: ['Converted with the exchange rate saved on each shipment. Shipments with no saved rate count as 0 and are listed in the last column.'] };
  } },
  freight_by_carrier: { title: 'Freight costs by carrier', async run(f) {
    const rows = await all(`SELECT p.name, b.currency, COUNT(*) bookings, SUM(b.cost) cost, AVG(b.cost) avg FROM shipping_bookings b JOIN shipping_providers p ON p.id=b.provider_id WHERE b.status='booked' AND b.created BETWEEN ? AND ? GROUP BY p.name, b.currency ORDER BY p.name`, f.from, f.to);
    return { columns: [C('name', 'Carrier'), C('currency', 'Currency'), C('bookings', 'Booked shipments', 'int'), C('cost', 'Total cost', 'num'), C('avg', 'Average cost', 'num')], rows: rows.map((r) => ({ name: r.name, currency: r.currency, bookings: Number(r.bookings), cost: r2(r.cost), avg: r2(r.avg) })), notes: ['Only shipments confirmed by the carrier. Each currency is shown separately and not converted.'] };
  } },
  customs_charges: { title: 'Customs charges (imports)', async run(f) {
    const rows = await all(`SELECT s.import_ref, s.supplier_country country, s.currency, s.customs_duties, s.import_taxes, s.clearing_fees, s.port_charges, COALESCE(s.fx_rate_to_ngn,0) rate FROM import_shipments s WHERE (s.customs_duties+s.import_taxes+s.clearing_fees+s.port_charges) > 0 AND s.created BETWEEN ? AND ? ${f.country ? 'AND s.supplier_country=?' : ''} ORDER BY s.id DESC LIMIT 1000`, f.from, f.to, ...(f.country ? [f.country] : []));
    return { columns: [C('import_ref', 'Import'), C('country', 'From'), C('currency', 'Currency'), C('duties', 'Duties', 'num'), C('taxes', 'Taxes', 'num'), C('clearing', 'Clearing fees', 'num'), C('port', 'Port charges', 'num'), C('total_ngn', 'Total (NGN)', 'ngn')], rows: rows.map((r) => ({ import_ref: r.import_ref, country: r.country, currency: r.currency, duties: r2(r.customs_duties), taxes: r2(r.import_taxes), clearing: r2(r.clearing_fees), port: r2(r.port_charges), total_ngn: Number(r.rate) > 0 ? r2((Number(r.customs_duties) + Number(r.import_taxes) + Number(r.clearing_fees) + Number(r.port_charges)) * Number(r.rate)) : null })), notes: ['Amounts entered by staff from real clearing invoices. Empty naira total = no exchange rate saved.'] };
  } },
  landed_cost_by_product: { title: 'Landed cost per product', async run() {
    const rows = await all(`SELECT p.name, p.sku, pc.avg_cost_ngn, pc.last_landed_ngn, pc.qty_basis, s.import_ref FROM trade_product_costs pc JOIN products p ON p.id=pc.product_id LEFT JOIN import_shipments s ON s.id=pc.last_shipment_id ORDER BY p.name LIMIT 2000`);
    return { columns: [C('name', 'Product'), C('sku', 'SKU'), C('avg_cost_ngn', 'Average landed cost (NGN)', 'ngn'), C('last_landed_ngn', 'Latest landed cost (NGN)', 'ngn'), C('qty_basis', 'Units counted', 'int'), C('import_ref', 'Latest import')], rows: rows.map((r) => ({ name: r.name, sku: r.sku, avg_cost_ngn: r2(r.avg_cost_ngn), last_landed_ngn: r2(r.last_landed_ngn), qty_basis: Number(r.qty_basis), import_ref: r.import_ref })), notes: ['From goods received into stock. This report is not filtered by date.'] };
  } },
  order_performance: { title: 'International order performance', async run(f) {
    const rows = await all(`SELECT eo.status, COUNT(*) n, COALESCE(SUM(o.total),0) value FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE eo.created BETWEEN ? AND ? ${f.country ? 'AND eo.destination_country=?' : ''} GROUP BY eo.status ORDER BY n DESC`, f.from, f.to, ...(f.country ? [f.country] : []));
    const tot = rows.reduce((a, r) => a + Number(r.n), 0);
    return { columns: [C('status', 'Status'), C('orders', 'Orders', 'int'), C('share', 'Share of orders (%)', 'num'), C('value_ngn', 'Value (NGN)', 'ngn')], rows: rows.map((r) => ({ status: String(r.status).replace(/_/g, ' '), orders: Number(r.n), share: tot ? r2((Number(r.n) / tot) * 100) : 0, value_ngn: r2(r.value) })), summary: { orders: tot } };
  } },
  delivery_performance: { title: 'Shipping delivery performance and average shipping time', async run(f) {
    const rows = await all(`SELECT c.name, COALESCE(NULLIF(eo.carrier,''),'(not recorded)') carrier, COUNT(*) delivered, AVG(d.at - x.at) secs, MIN(d.at - x.at) fastest, MAX(d.at - x.at) slowest
      FROM export_orders eo JOIN trade_countries c ON c.code=eo.destination_country
      JOIN LATERAL (SELECT MIN(occurred_at) at FROM shipment_tracking_events WHERE export_order_id=eo.id AND stage='dispatched') x ON x.at IS NOT NULL
      JOIN LATERAL (SELECT MIN(occurred_at) at FROM shipment_tracking_events WHERE export_order_id=eo.id AND stage='delivered') d ON d.at IS NOT NULL
      WHERE eo.created BETWEEN ? AND ? ${f.country ? 'AND eo.destination_country=?' : ''} GROUP BY c.name, 2 ORDER BY c.name`, f.from, f.to, ...(f.country ? [f.country] : []));
    return { columns: [C('country', 'Destination'), C('carrier', 'Carrier'), C('delivered', 'Delivered', 'int'), C('avg_days', 'Average days, dispatch to delivery', 'num'), C('fastest_days', 'Fastest (days)', 'num'), C('slowest_days', 'Slowest (days)', 'num')], rows: rows.map((r) => ({ country: r.name, carrier: r.carrier, delivered: Number(r.delivered), avg_days: days(r.secs), fastest_days: days(r.fastest), slowest_days: days(r.slowest) })), notes: ['Counts only parcels with both a "dispatched" and a "delivered" update recorded.'] };
  } },
  customs_clearance_time: { title: 'Customs clearance time', async run(f) {
    const rows = await all(`SELECT c.name, COUNT(*) n, AVG(r.at - a.at) secs, MAX(r.at - a.at) slowest FROM export_orders eo JOIN trade_countries c ON c.code=eo.destination_country
      JOIN LATERAL (SELECT MIN(occurred_at) at FROM shipment_tracking_events WHERE export_order_id=eo.id AND stage='import_customs') a ON a.at IS NOT NULL
      JOIN LATERAL (SELECT MIN(occurred_at) at FROM shipment_tracking_events WHERE export_order_id=eo.id AND stage='customs_released') r ON r.at IS NOT NULL
      WHERE eo.created BETWEEN ? AND ? ${f.country ? 'AND eo.destination_country=?' : ''} GROUP BY c.name ORDER BY c.name`, f.from, f.to, ...(f.country ? [f.country] : []));
    return { columns: [C('country', 'Destination'), C('parcels', 'Cleared parcels', 'int'), C('avg_days', 'Average days in customs', 'num'), C('slowest_days', 'Slowest (days)', 'num')], rows: rows.map((r) => ({ country: r.name, parcels: Number(r.n), avg_days: days(r.secs), slowest_days: days(r.slowest) })), notes: ['Time between "import customs" and "customs released" updates for export orders. Parcels without both updates are not counted.'] };
  } },
  failed_delayed: { title: 'Failed and delayed shipments', async run(f) {
    const ev = await all(`SELECT ev.stage, ev.description, ev.occurred_at, COALESCE(eo.ref, s.import_ref) ref, CASE WHEN eo.id IS NULL THEN 'import' ELSE 'export' END kind FROM shipment_tracking_events ev LEFT JOIN export_orders eo ON eo.id=ev.export_order_id LEFT JOIN import_shipments s ON s.id=ev.import_shipment_id WHERE ev.stage IN ('delayed','exception','customs_hold') AND ev.occurred_at BETWEEN ? AND ? ${f.country ? 'AND eo.destination_country=?' : ''} ORDER BY ev.occurred_at DESC LIMIT 500`, f.from, f.to, ...(f.country ? [f.country] : []));
    const bk = f.country ? [] : await all("SELECT COALESCE(eo.ref, s.import_ref) ref, b.error, b.updated FROM shipping_bookings b LEFT JOIN export_orders eo ON eo.id=b.export_order_id LEFT JOIN import_shipments s ON s.id=b.import_shipment_id WHERE b.status='failed' AND b.updated BETWEEN ? AND ? ORDER BY b.updated DESC LIMIT 200", f.from, f.to);
    const rows = [...ev.map((e) => ({ ref: e.ref, kind: e.kind, what: String(e.stage).replace(/_/g, ' '), detail: e.description, when: new Date(Number(e.occurred_at) * 1000).toISOString().slice(0, 16).replace('T', ' ') })), ...bk.map((b) => ({ ref: b.ref, kind: 'booking', what: 'booking failed', detail: b.error, when: new Date(Number(b.updated) * 1000).toISOString().slice(0, 16).replace('T', ' ') }))];
    return { columns: [C('ref', 'Reference'), C('kind', 'Type'), C('what', 'Problem'), C('detail', 'Detail'), C('when', 'When (UTC)')], rows, summary: { delayed_or_held: ev.length, failed_bookings: bk.length } };
  } },
  payment_reconciliation: { title: 'International payment reconciliation', finance: true, async run(f) {
    const d = await require('./payments').reconciliation({ from: f.from, to: f.to });
    return { columns: [C('export_ref', 'Order'), C('currency', 'Currency'), C('ordered_ngn', 'Ordered (NGN)', 'ngn'), C('charged_ngn', 'Charged (NGN)', 'ngn'), C('fees_ngn', 'Provider fees (NGN)', 'ngn'), C('refunded_ngn', 'Refunded (NGN)', 'ngn'), C('net_ngn', 'Net (NGN)', 'ngn'), C('flag', 'Check')], rows: d.rows.filter((r) => !f.country || true).map((r) => ({ ...r, flag: r.flag.replace(/_/g, ' ') })), summary: d.totals, notes: [d.note] };
  } },
  fx_differences: { title: 'Currency exchange differences', finance: true, async run(f) {
    const rows = await all(`SELECT eo.ref, eo.currency, eo.total, eo.fx_rate_to_ngn rate, o.total ngn FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE ${PAID} AND eo.currency<>'NGN' AND eo.created BETWEEN ? AND ? ${f.country ? 'AND eo.destination_country=?' : ''} ORDER BY eo.id DESC LIMIT 1000`, f.from, f.to, ...(f.country ? [f.country] : []));
    const cache = {}; const cur = async (c) => { if (!(c in cache)) { try { cache[c] = (await FX.rate(c, 'NGN', { allowStale: true })).rate; } catch { cache[c] = null; } } return cache[c]; };
    const out = []; for (const r of rows) { const now_ = await cur(r.currency); out.push({ ref: r.ref, currency: r.currency, total: r2(r.total), rate_at_order: Number(r.rate), rate_now: now_ == null ? null : Number(now_), charged_ngn: r2(r.ngn), worth_now_ngn: now_ == null ? null : Math.round(Number(r.total) * now_), difference_ngn: now_ == null ? null : Math.round(Number(r.total) * now_) - r2(r.ngn) }); }
    return { columns: [C('ref', 'Order'), C('currency', 'Currency'), C('total', 'Order total', 'num'), C('rate_at_order', 'Rate at order', 'num'), C('rate_now', 'Rate now', 'num'), C('charged_ngn', 'Charged (NGN)', 'ngn'), C('difference_ngn', 'Difference at today\'s rate (NGN)', 'ngn')], rows: out, notes: ['Information only. Customers pay in naira at the rate fixed when they ordered; this shows how the order total would convert today. Empty = no usable exchange rate.'] };
  } },
};
const list = () => Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, finance: !!r.finance }));
async function run(key, q = {}) {
  const rep = REPORTS[key]; if (!rep) fail(404, 'Report not found.');
  const f = range(q), d = await rep.run(f);
  return { key, title: rep.title, filters: { from: f.from, to: f.to, country: f.country }, generated: now(), ...d };
}
const cellOf = (c, v) => (v == null ? '' : c.type === 'text' ? String(v) : v);
async function file(key, q, format) {
  const rep = await run(key, q), head = rep.columns.map((c) => c.label), body = rep.rows.map((r) => rep.columns.map((c) => cellOf(c, r[c.key])));
  const stamp = new Date(rep.filters.from * 1000).toISOString().slice(0, 10) + '_to_' + new Date(rep.filters.to * 1000).toISOString().slice(0, 10), name = `velto-${key}-${stamp}`;
  if (format === 'csv') return { buf: X.writeCsv([head, ...body]), type: 'text/csv; charset=utf-8', name: name + '.csv' };
  if (format === 'xlsx') {
    const info = [['Report', rep.title], ['From', new Date(rep.filters.from * 1000).toISOString().slice(0, 10)], ['To', new Date(rep.filters.to * 1000).toISOString().slice(0, 10)], ['Country', rep.filters.country || 'All'], ...(rep.notes || []).map((n) => ['Note', n])];
    return { buf: X.writeXlsx([{ name: 'Report', rows: [head, ...body], widths: rep.columns.map((c) => Math.max(14, c.label.length + 4)) }, { name: 'About', rows: info, widths: [14, 90], header: false }]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: name + '.xlsx' };
  }
  if (format === 'pdf') {
    const buf = await PDF.build(rep.title, (doc) => {
      PDF.header(doc, rep.title, key, `${new Date(rep.filters.from * 1000).toISOString().slice(0, 10)} to ${new Date(rep.filters.to * 1000).toISOString().slice(0, 10)}${rep.filters.country ? ' · ' + rep.filters.country : ''}`);
      const w = 1 / rep.columns.length; PDF.table(doc, rep.columns.map((c) => ({ h: c.label, w, align: c.type === 'text' ? 'left' : 'right' })), body.map((r) => r.map((v, i) => (typeof v === 'number' ? (rep.columns[i].type === 'int' ? String(v) : PDF.money(v)) : v))));
      (rep.notes || []).forEach((n) => PDF.note(doc, n)); PDF.note(doc, 'Generated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC from saved records.');
    });
    return { buf, type: 'application/pdf', name: name + '.pdf' };
  }
  fail(400, 'Choose excel (xlsx), csv or pdf.');
}
module.exports = { list, run, file, REPORTS };
