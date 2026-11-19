'use strict';
// Reports a partner store can run on its own sales and catalogue. Same shape as lib/commercial.js, so one screen and one download path serve them all.
// A store sees only its own rows. No customer names, phones or addresses appear in any of them.
const { all, get } = require('./db');
const S = require('./shop');
const V = require('./vendors');
const Cm = require('./commercial');
const { fail } = S;
const n = (v) => Number(v || 0);
const sum = (rows, k) => rows.reduce((t, r) => t + n(r[k]), 0);
const C = (key, label, type = 'text') => ({ key, label, type });
const SALE = "o.status NOT IN ('cancelled','refunded') AND (o.payment_method='pod' OR o.payment_status='paid')";
const LAGOS = 3600;

const REPORTS = {
  async 'sales-by-product'(v, q) {
    const p = Cm.period(q);
    const rows = (await all(`SELECT MAX(oi.name) AS name, COUNT(DISTINCT oi.order_id) AS orders, SUM(oi.qty) AS units, SUM(oi.price*oi.qty) AS sales, SUM(oi.commission) AS commission
      FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.vendor_id=? AND o.created>=? AND o.created<? AND ${SALE} GROUP BY oi.product_id ORDER BY sales DESC`, v.id, p.a, p.b))
      .map((r) => ({ name: r.name, orders: n(r.orders), units: n(r.units), sales: n(r.sales), commission: n(r.commission), net: n(r.sales) - n(r.commission) }));
    return { from: p.from, to: p.to, title: 'Sales by product', note: 'Orders that were paid online or are pay-on-delivery, not cancelled or refunded. Net is sales minus our commission.',
      summary: [{ label: 'Products sold', value: rows.length, type: 'int' }, { label: 'Units', value: sum(rows, 'units'), type: 'int' }, { label: 'Sales', value: sum(rows, 'sales'), type: 'money' }, { label: 'Net to you', value: sum(rows, 'net'), type: 'money' }],
      columns: [C('name', 'Product'), C('orders', 'Orders', 'int'), C('units', 'Units', 'int'), C('sales', 'Sales', 'money'), C('commission', 'Our commission', 'money'), C('net', 'Net to you', 'money')], rows };
  },
  async 'sales-by-day'(v, q) {
    const p = Cm.period(q);
    const rows = (await all(`SELECT to_char(to_timestamp(o.created + ${LAGOS}) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(DISTINCT oi.order_id) AS orders, SUM(oi.qty) AS units, SUM(oi.price*oi.qty) AS sales, SUM(oi.commission) AS commission
      FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.vendor_id=? AND o.created>=? AND o.created<? AND ${SALE} GROUP BY 1 ORDER BY 1`, v.id, p.a, p.b))
      .map((r) => ({ day: r.day, orders: n(r.orders), units: n(r.units), sales: n(r.sales), commission: n(r.commission), net: n(r.sales) - n(r.commission) }));
    return { from: p.from, to: p.to, title: 'Sales by day', note: 'Days are Lagos days. Same rule as Sales by product.',
      summary: [{ label: 'Orders', value: sum(rows, 'orders'), type: 'int' }, { label: 'Sales', value: sum(rows, 'sales'), type: 'money' }, { label: 'Net to you', value: sum(rows, 'net'), type: 'money' }],
      columns: [C('day', 'Day'), C('orders', 'Orders', 'int'), C('units', 'Units', 'int'), C('sales', 'Sales', 'money'), C('commission', 'Our commission', 'money'), C('net', 'Net to you', 'money')], rows };
  },
  async 'catalogue-status'(v) {
    const rows = (await all(`SELECT p.name, s.name AS department, p.price, p.stock, p.active, p.listing, p.listing_note, p.images FROM products p LEFT JOIN stores s ON s.slug=p.store WHERE p.vendor_id=? ORDER BY (p.listing='pending') DESC, (p.listing='rejected') DESC, p.name`, v.id))
      .map((r) => { let ph = 0; try { ph = JSON.parse(r.images || '[]').length; } catch { /* none */ } return { name: r.name, department: r.department || '', price: n(r.price), stock: n(r.stock), status: r.listing === 'approved' ? (r.active ? 'Live' : 'Approved, hidden') : r.listing === 'pending' ? 'Waiting for review' : 'Rejected', photos: ph, note: r.listing_note || '' }; });
    return { title: 'My catalogue', note: 'Where each product stands. "Waiting for review" products are not visible to customers yet; a rejected product shows our note.',
      summary: [{ label: 'Products', value: rows.length, type: 'int' }, { label: 'Live', value: rows.filter((r) => r.status === 'Live').length, type: 'int' }, { label: 'Waiting for review', value: rows.filter((r) => r.status === 'Waiting for review').length, type: 'int' }, { label: 'Rejected', value: rows.filter((r) => r.status === 'Rejected').length, type: 'int' }, { label: 'Out of stock', value: rows.filter((r) => r.status === 'Live' && !r.stock).length, type: 'int' }],
      columns: [C('name', 'Product'), C('department', 'Department'), C('price', 'Price', 'money'), C('stock', 'Stock', 'int'), C('status', 'Status'), C('photos', 'Photos', 'int'), C('note', 'Our note')], rows };
  },
  async payouts(v) {
    const b = await V.balanceOf(v.id);
    const rows = (await all('SELECT amount, method, reference, note, created FROM vendor_payouts WHERE vendor_id=? ORDER BY id DESC LIMIT 500', v.id)).map((r) => ({ created: n(r.created), amount: n(r.amount), method: r.method, reference: r.reference, note: r.note }));
    return { title: 'Earnings and payouts', note: 'Delivered orders only. Balance is what we still owe you: net of commission, minus payouts already made.',
      summary: [{ label: 'Delivered sales', value: b.gross, type: 'money' }, { label: 'Our commission', value: b.commission, type: 'money' }, { label: 'Paid to you', value: b.paid, type: 'money' }, { label: 'Balance owed to you', value: b.balance, type: 'money' }, { label: 'Still being delivered (net)', value: b.in_progress, type: 'money' }],
      columns: [C('created', 'Paid on', 'date'), C('amount', 'Amount', 'money'), C('method', 'Method'), C('reference', 'Reference'), C('note', 'Note')], rows };
  },
};
const LIST = [['sales-by-product', 'Sales by product', true], ['sales-by-day', 'Sales by day', true], ['catalogue-status', 'My catalogue', false], ['payouts', 'Earnings and payouts', false]].map(([name, title, dated]) => ({ name, title, dated }));
async function report(user, name, q) {
  const v = await V.mine(user);
  const fn = Object.prototype.hasOwnProperty.call(REPORTS, name) ? REPORTS[name] : null;
  if (!fn) fail(404, 'No such report.');
  return { name, ...(await fn(v, q || {})) };
}
module.exports = { report, LIST, file: Cm.file };
