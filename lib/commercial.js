'use strict';
// Commercial operations: one workspace for the team that looks after partner stores and wholesale quotations, plus the reports behind it.
// Every report answers in the same shape as lib/wh-reports.js: { name, title, note, from, to, summary, columns, rows }.
const { get, all, run, now } = require('./db');
const S = require('./shop');
const St = require('./staff');
const X = require('./xlsx');
const { fail, str, int } = S;

const LAGOS = 3600, DAY = 86400;
const ymd = (sec) => new Date((sec + LAGOS) * 1000).toISOString().slice(0, 10);
function period(q) {
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
  const nowS = Math.floor(Date.now() / 1000);
  const to = ok(q.to) ? q.to : ymd(nowS), from = ok(q.from) ? q.from : ymd(nowS - 29 * DAY);
  const a = Date.parse(from + 'T00:00:00Z') / 1000 - LAGOS, b = Date.parse(to + 'T00:00:00Z') / 1000 - LAGOS + DAY;
  if (b <= a) fail(400, 'The end date must not be before the start date.');
  if (b - a > 800 * DAY) fail(400, 'Choose a period of at most two years.');
  return { from, to, a, b };
}
const C = (key, label, type = 'text') => ({ key, label, type });
const n = (v) => Number(v || 0);
const sum = (rows, k) => rows.reduce((t, r) => t + n(r[k]), 0);
// A sale = not cancelled/refunded, and paid online or pay-on-delivery (same rule as the dashboard).
const SALE = "o.status NOT IN ('cancelled','refunded') AND (o.payment_method='pod' OR o.payment_status='paid')";

/* ---------- people who can be a relationship officer ---------- */
async function partnerOfficers() { return (await St.whoCan('partners', true)).map((u) => ({ id: Number(u.id), name: u.name })); }
async function assignOfficer(vendorId, userId, actor) {
  const v = await get('SELECT id, name FROM vendors WHERE id=?', int(vendorId)); if (!v) fail(404, 'Partner store not found.');
  let o = null;
  if (userId) { o = (await partnerOfficers()).find((x) => x.id === Number(userId)); if (!o) fail(400, 'That person cannot look after partner stores. Give their role Edit access to "Partner stores" first.'); }
  await run('UPDATE vendors SET officer_id=?, officer_at=? WHERE id=?', o ? o.id : null, o ? now() : null, v.id);
  if (o) await require('./notify').notify([o.id], { type: 'partner', title: `You now look after ${v.name}`, body: `${actor && actor.name ? actor.name : 'The store owner'} assigned this partner store to you.`, link: '/admin#/vendors' });
}

/* ---------- the workspace ---------- */
async function overview(user, q) {
  const perms = await St.permsOf(user), view = (m) => perms.includes('*') || perms.includes(m + ':view') || perms.includes(m + ':edit');
  const p = period(q), out = { from: p.from, to: p.to, sections: [] };
  const officer = /^\d+$/.test(String(q.officer || '')) ? int(q.officer) : q.officer === 'none' ? 'none' : 0;
  out.me = { id: Number(user.id), name: user.name };
  out.officers = view('partners') || view('rfq') ? [...new Map([...(await partnerOfficers()), ...(await require('./rfq').officers())].map((o) => [o.id, o])).values()] : [];

  if (view('partners')) {
    const byStatus = Object.fromEntries((await all('SELECT status, COUNT(*) n FROM vendors GROUP BY status')).map((r) => [r.status, n(r.n)]));
    const where = ['1=1'], args = [];
    if (officer === 'none') where.push('v.officer_id IS NULL'); else if (officer) { where.push('v.officer_id=?'); args.push(officer); }
    if (/^\d+$/.test(String(q.partner || ''))) { where.push('v.id=?'); args.push(int(q.partner)); }
    if (['pending', 'approved', 'rejected', 'suspended'].includes(q.pstatus)) { where.push('v.status=?'); args.push(q.pstatus); }
    const list = await all(`SELECT v.id, v.name, v.status, v.city, v.state, v.created, v.officer_id, o.name AS officer_name,
        (SELECT COUNT(*) FROM products p WHERE p.vendor_id=v.id AND p.listing='pending') AS awaiting,
        (SELECT COUNT(*) FROM products p WHERE p.vendor_id=v.id AND p.listing='approved' AND p.active=1) AS live,
        (SELECT COALESCE(SUM(oi.price*oi.qty),0) FROM order_items oi JOIN orders o2 ON o2.id=oi.order_id WHERE oi.vendor_id=v.id AND o2.created>=? AND o2.created<? AND ${SALE.replace(/\bo\./g, 'o2.')}) AS sales
      FROM vendors v LEFT JOIN users o ON o.id=v.officer_id WHERE ${where.join(' AND ')} ORDER BY (v.status='pending') DESC, v.created DESC LIMIT 200`, p.a, p.b, ...args);
    out.sections.push({ key: 'partners', title: 'Partner stores', counts: { pending: n(byStatus.pending), approved: n(byStatus.approved), rejected: n(byStatus.rejected), suspended: n(byStatus.suspended),
      unassigned: n((await get("SELECT COUNT(*) n FROM vendors WHERE officer_id IS NULL AND status IN ('pending','approved')")).n),
      productsAwaiting: n((await get("SELECT COUNT(*) n FROM products WHERE vendor_id IS NOT NULL AND listing='pending'")).n) },
      rows: list.map((r) => ({ id: Number(r.id), name: r.name, status: r.status, place: [r.city, r.state].filter(Boolean).join(', '), created: Number(r.created), officerId: r.officer_id ? Number(r.officer_id) : null, officer: r.officer_name || '', awaiting: n(r.awaiting), live: n(r.live), sales: view('reports') || view('finance') ? n(r.sales) : null })) });
  }
  if (view('rfq')) {
    const where = ["r.status <> 'draft'"], args = [];
    if (officer === 'none') where.push('r.assigned_to IS NULL'); else if (officer) { where.push('r.assigned_to=?'); args.push(officer); }
    if (/^[a-z_]+$/.test(String(q.rstatus || ''))) { where.push('r.status=?'); args.push(q.rstatus); }
    const counts = Object.fromEntries((await all("SELECT status, COUNT(*) n FROM rfqs WHERE status<>'draft' GROUP BY status")).map((r) => [r.status, n(r.n)]));
    const list = await all(`SELECT r.ref, r.company, r.status, r.assigned_to, u.name AS officer_name, r.submitted_at, r.created, r.quote_total, r.quote_valid_until,
        (SELECT COUNT(*) FROM rfq_items i WHERE i.rfq_id=r.id) AS items
      FROM rfqs r LEFT JOIN users u ON u.id=r.assigned_to WHERE ${where.join(' AND ')} AND r.created>=? AND r.created<? ORDER BY (r.status IN ('submitted','received','review','sourcing','quote_prepared')) DESC, r.id DESC LIMIT 200`, ...args, p.a, p.b);
    out.sections.push({ key: 'rfq', title: 'Quotation requests', counts: { ...counts,
      unassigned: n((await get("SELECT COUNT(*) n FROM rfqs WHERE assigned_to IS NULL AND status IN ('submitted','received','review','sourcing','quote_prepared')")).n),
      mine: n((await get("SELECT COUNT(*) n FROM rfqs WHERE assigned_to=? AND status IN ('submitted','received','review','sourcing','quote_prepared','quote_sent')", user.id)).n) },
      rows: list.map((r) => ({ ref: r.ref, company: r.company, status: r.status, officerId: r.assigned_to ? Number(r.assigned_to) : null, officer: r.officer_name || '', created: Number(r.created), items: n(r.items), total: n(r.quote_total) || null, expired: r.status === 'quote_sent' && r.quote_valid_until && Number(r.quote_valid_until) < now() })) });
  }
  if (!out.sections.length) fail(403, 'Your role does not include commercial operations.');
  return out;
}

/* ---------- reports ---------- */
const REPORTS = {
  async 'partner-performance'(q) {
    const p = period(q);
    const rows = (await all(`SELECT v.name, v.status, o.name AS officer, v.commission_pct,
        COUNT(DISTINCT x.order_id) AS orders, COALESCE(SUM(x.qty),0) AS units, COALESCE(SUM(x.price*x.qty),0) AS sales, COALESCE(SUM(x.commission),0) AS commission
      FROM vendors v LEFT JOIN users o ON o.id=v.officer_id
      LEFT JOIN (SELECT oi.vendor_id, oi.order_id, oi.qty, oi.price, oi.commission FROM order_items oi JOIN orders o2 ON o2.id=oi.order_id WHERE o2.created>=? AND o2.created<? AND ${SALE.replace(/\bo\./g, 'o2.')}) x ON x.vendor_id=v.id
      WHERE v.status IN ('approved','suspended') GROUP BY v.id, o.name ORDER BY sales DESC, v.name`, p.a, p.b))
      .map((r) => ({ name: r.name, status: r.status, officer: r.officer || '', commission_pct: n(r.commission_pct), orders: n(r.orders), units: n(r.units), sales: n(r.sales), commission: n(r.commission), net: n(r.sales) - n(r.commission), avg: n(r.orders) ? Math.round(n(r.sales) / n(r.orders)) : 0 }));
    return { from: p.from, to: p.to, title: 'Partner store performance', note: 'Sales are partner products on orders that were paid or are pay-on-delivery and not cancelled or refunded. Net is sales minus our commission.',
      summary: [{ label: 'Active partner stores', value: rows.length, type: 'int' }, { label: 'Partner sales', value: sum(rows, 'sales'), type: 'money' }, { label: 'Our commission', value: sum(rows, 'commission'), type: 'money' }, { label: 'Stores with no sales', value: rows.filter((r) => !r.orders).length, type: 'int' }],
      columns: [C('name', 'Partner store'), C('status', 'Status'), C('officer', 'Relationship officer'), C('orders', 'Orders', 'int'), C('units', 'Units', 'int'), C('sales', 'Sales', 'money'), C('avg', 'Average order', 'money'), C('commission_pct', 'Commission %', 'int'), C('commission', 'Our commission', 'money'), C('net', 'Net to partner', 'money')], rows };
  },
  async 'partner-catalogue'() {
    const rows = (await all(`SELECT v.name, v.status, COUNT(p.id) AS total,
        COUNT(p.id) FILTER (WHERE p.listing='approved') AS approved, COUNT(p.id) FILTER (WHERE p.listing='pending') AS pending, COUNT(p.id) FILTER (WHERE p.listing='rejected') AS rejected,
        COUNT(p.id) FILTER (WHERE p.listing='approved' AND p.active=1 AND p.stock<=0) AS out_of_stock, COUNT(p.id) FILTER (WHERE p.images IS NULL OR p.images IN ('','[]')) AS no_photo
      FROM vendors v LEFT JOIN products p ON p.vendor_id=v.id GROUP BY v.id ORDER BY pending DESC, v.name`)).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, ['name', 'status'].includes(k) ? v : n(v)])));
    return { title: 'Partner catalogues', note: 'What each partner store has submitted and where it stands. "Awaiting review" is the queue for the catalogue team.',
      summary: [{ label: 'Products from partners', value: sum(rows, 'total'), type: 'int' }, { label: 'Awaiting our review', value: sum(rows, 'pending'), type: 'int' }, { label: 'Live and out of stock', value: sum(rows, 'out_of_stock'), type: 'int' }, { label: 'Without a photo', value: sum(rows, 'no_photo'), type: 'int' }],
      columns: [C('name', 'Partner store'), C('status', 'Status'), C('total', 'Products', 'int'), C('approved', 'Approved', 'int'), C('pending', 'Awaiting review', 'int'), C('rejected', 'Rejected', 'int'), C('out_of_stock', 'Out of stock', 'int'), C('no_photo', 'No photo', 'int')], rows };
  },
  async 'rfq-pipeline'(q) {
    const p = period(q);
    const rows = (await all(`SELECT r.ref, r.company, r.status, u.name AS officer, r.created, r.submitted_at, r.quoted_at, r.closed_at, r.quote_total
      FROM rfqs r LEFT JOIN users u ON u.id=r.assigned_to WHERE r.status<>'draft' AND r.created>=? AND r.created<? ORDER BY r.id DESC`, p.a, p.b))
      .map((r) => ({ ref: r.ref, company: r.company, status: r.status, officer: r.officer || '', created: Number(r.created), quoted_hours: r.quoted_at && r.submitted_at ? Math.round((Number(r.quoted_at) - Number(r.submitted_at)) / 360) / 10 : null, total: n(r.quote_total) }));
    const won = rows.filter((r) => ['accepted', 'converted', 'completed'].includes(r.status)), sent = rows.filter((r) => ['quote_sent', 'accepted', 'rejected', 'converted', 'completed'].includes(r.status)), hrs = rows.filter((r) => r.quoted_hours != null);
    return { from: p.from, to: p.to, title: 'Quotation request pipeline', note: 'Requests created in the period. Time to quote is from the buyer submitting to us sending the quotation.',
      summary: [{ label: 'Requests', value: rows.length, type: 'int' }, { label: 'Quotations sent', value: sent.length, type: 'int' }, { label: 'Accepted or converted', value: won.length, type: 'int' }, { label: 'Average hours to quote', value: hrs.length ? Math.round(sum(hrs, 'quoted_hours') / hrs.length * 10) / 10 : null, type: 'hours' }, { label: 'Value won', value: sum(won, 'total'), type: 'money' }],
      columns: [C('ref', 'Request'), C('company', 'Buyer'), C('status', 'Status'), C('officer', 'Officer'), C('created', 'Created', 'date'), C('quoted_hours', 'Hours to quote', 'hours'), C('total', 'Quotation total', 'money')], rows };
  },
  async 'retail-sales'(q) {
    const p = period(q);
    const rows = (await all(`SELECT to_char(to_timestamp(o.created + ${LAGOS}) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*) AS orders, COALESCE(SUM(o.total),0) AS revenue FROM orders o WHERE o.created>=? AND o.created<? AND ${SALE} GROUP BY 1 ORDER BY 1`, p.a, p.b))
      .map((r) => ({ day: r.day, orders: n(r.orders), revenue: n(r.revenue), avg: n(r.orders) ? Math.round(n(r.revenue) / n(r.orders)) : 0 }));
    return { from: p.from, to: p.to, title: 'Retail sales by day', note: 'Orders that were paid online or are pay-on-delivery, not cancelled or refunded. Days are Lagos days.',
      summary: [{ label: 'Orders', value: sum(rows, 'orders'), type: 'int' }, { label: 'Revenue', value: sum(rows, 'revenue'), type: 'money' }, { label: 'Average order', value: sum(rows, 'orders') ? Math.round(sum(rows, 'revenue') / sum(rows, 'orders')) : 0, type: 'money' }],
      columns: [C('day', 'Day'), C('orders', 'Orders', 'int'), C('revenue', 'Revenue', 'money'), C('avg', 'Average order', 'money')], rows };
  },
  async 'employee-performance'(q) {
    const p = period(q);
    const rows = (await all(`SELECT u.name, COALESCE(r.name, '') AS role_name,
        COUNT(a.id) FILTER (WHERE a.status<400) AS actions,
        COUNT(a.id) FILTER (WHERE a.status<400 AND a.method='PUT' AND a.path LIKE '/api/admin/orders/%') AS orders,
        COUNT(a.id) FILTER (WHERE a.status<400 AND a.path LIKE '/api/admin/vendors%') AS partners,
        COUNT(a.id) FILTER (WHERE a.status<400 AND a.path LIKE '/api/admin/rfq%') AS rfq_actions,
        COUNT(a.id) FILTER (WHERE a.status<400 AND (a.path LIKE '/api/admin/products%' OR a.path LIKE '/api/admin/catalog/commit%')) AS products,
        (SELECT COUNT(*) FROM rfqs f WHERE f.assigned_to=u.id AND f.created>=? AND f.created<?) AS rfqs_assigned,
        (SELECT COUNT(*) FROM rfqs f WHERE f.assigned_to=u.id AND f.created>=? AND f.created<? AND f.status IN ('accepted','converted','completed')) AS rfqs_won,
        (SELECT COUNT(*) FROM vendors v WHERE v.officer_id=u.id) AS partners_managed
      FROM users u LEFT JOIN staff_roles r ON r.id=u.staff_role_id LEFT JOIN audit_log a ON a.user_id=u.id AND a.created>=? AND a.created<?
      WHERE u.role='staff' GROUP BY u.id, r.name ORDER BY actions DESC, u.name`, p.a, p.b, p.a, p.b, p.a, p.b)).map((r) => ({ name: r.name, role_name: r.role_name, actions: n(r.actions), orders: n(r.orders), partners: n(r.partners), rfq_actions: n(r.rfq_actions), products: n(r.products), rfqs_assigned: n(r.rfqs_assigned), rfqs_won: n(r.rfqs_won), partners_managed: n(r.partners_managed) }));
    return { from: p.from, to: p.to, title: 'Employee performance', note: 'Counts of recorded changes (reading a screen is not counted), quotation requests assigned and won, and partner stores looked after. These are activity counts, not a verdict on quality.',
      summary: [{ label: 'Employees', value: rows.length, type: 'int' }, { label: 'Changes recorded', value: sum(rows, 'actions'), type: 'int' }, { label: 'Requests won', value: sum(rows, 'rfqs_won'), type: 'int' }],
      columns: [C('name', 'Employee'), C('role_name', 'Role'), C('actions', 'Changes', 'int'), C('orders', 'Orders handled', 'int'), C('products', 'Product changes', 'int'), C('partners', 'Partner actions', 'int'), C('rfq_actions', 'Quotation actions', 'int'), C('rfqs_assigned', 'Requests assigned', 'int'), C('rfqs_won', 'Requests won', 'int'), C('partners_managed', 'Partners managed', 'int')], rows };
  },
};
const LIST = [['partner-performance', 'Partner store performance', true, true], ['partner-catalogue', 'Partner catalogues', false, false], ['rfq-pipeline', 'Quotation request pipeline', true, false], ['retail-sales', 'Retail sales by day', true, true], ['employee-performance', 'Employee performance', true, false]]
  .map(([name, title, dated, money]) => ({ name, title, dated, money }));
async function report(name, q) {
  const fn = Object.prototype.hasOwnProperty.call(REPORTS, name) ? REPORTS[name] : null;
  if (!fn) fail(404, 'No such report.');
  return { name, ...(await fn(q || {})) };
}
// The same report as a file: CSV, or Excel with a summary sheet.
const cell = (v, t) => (v == null ? '' : t === 'date' && v ? new Date(Number(v) * 1000).toISOString().slice(0, 16).replace('T', ' ') : v);
function file(rep, format) {
  const head = rep.columns.map((c) => c.label), body = rep.rows.map((r) => rep.columns.map((c) => cell(r[c.key], c.type)));
  if (format === 'csv') return { buf: X.writeCsv([head, ...body]), type: 'text/csv; charset=utf-8', ext: 'csv' };
  const info = [['Report', rep.title], ...(rep.from ? [['From', rep.from], ['To', rep.to]] : []), ['Created', new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'], ['', ''], ...rep.summary.map((s) => [s.label, s.value == null ? '' : s.value]), ['', ''], ['Note', rep.note || '']];
  return { buf: X.writeXlsx([{ name: 'Report', rows: [head, ...body], widths: rep.columns.map((c) => Math.max(14, c.label.length + 4)) }, { name: 'Summary', rows: info, widths: [28, 60], header: false }]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
}
// csv, pdf or (default) Excel
async function fileAs(rep, format) {
  if (format === 'pdf') return { buf: await require('./report-pdf').reportPdf(rep, { store: (await require('./shop').getSettings()).store_name }), type: 'application/pdf', ext: 'pdf' };
  return file(rep, format === 'csv' ? 'csv' : 'xlsx');
}
const canSeeEmployees = async (user) => { const p = await St.permsOf(user); return p.includes('*') || p.includes('reports:edit'); };
module.exports = { canSeeEmployees, overview, partnerOfficers, assignOfficer, report, LIST, file, fileAs, period };
