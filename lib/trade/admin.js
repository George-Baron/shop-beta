'use strict';
// Global Trade administration: countries, currencies, the dashboard and the trade audit log.
const { get, all, run, tx, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const FX = require('./fx');
const { fail, str } = S;

/* ---------- countries ---------- */
const FLAGS = ['export_to', 'export_from', 'import_from', 'import_to', 'tax_id_required', 'postal_required', 'active'];
const shapeCountry = (c) => ({ code: c.code, name: c.name, iso3: c.iso3, dial_code: c.dial_code, currency_code: c.currency_code || '', region: c.region, export_to: !!Number(c.export_to), export_from: !!Number(c.export_from), import_from: !!Number(c.import_from), import_to: !!Number(c.import_to),
  tax_id_required: !!Number(c.tax_id_required), tax_id_label: c.tax_id_label, vat_label: c.vat_label, postal_required: !!Number(c.postal_required), postal_regex: c.postal_regex, default_incoterm: c.default_incoterm, duty_arrangement: c.duty_arrangement, config: c.config || {}, active: !!Number(c.active) });

async function countries(q = {}) {
  const where = [], args = [];
  if (q.q) { where.push('(name ILIKE ? OR code ILIKE ?)'); const s = '%' + String(q.q).slice(0, 40).replace(/[%_]/g, '') + '%'; args.push(s, s); }
  if (q.enabled === '1') where.push('(export_to=1 OR export_from=1 OR import_from=1 OR import_to=1)');
  return (await all(`SELECT * FROM trade_countries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sort, name`, ...args)).map(shapeCountry);
}
async function saveCountry(code, b, user, ip) {
  code = String(code || '').toUpperCase(); const c = await get('SELECT * FROM trade_countries WHERE code=?', code); if (!c) fail(404, 'Country not found.');
  b = b || {}; const sets = [], vals = [];
  for (const f of FLAGS) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f] === true || b[f] === 1 || b[f] === '1' ? 1 : 0); }
  if (b.tax_id_label !== undefined) { sets.push('tax_id_label=?'); vals.push(str(b.tax_id_label, 60)); }
  if (b.vat_label !== undefined) { sets.push('vat_label=?'); vals.push(str(b.vat_label, 30) || 'VAT'); }
  if (b.default_incoterm !== undefined) { const v = String(b.default_incoterm || '').toUpperCase(); if (v && !T.SCHEMA.default_incoterm.options.includes(v)) fail(400, 'Unknown Incoterm.'); sets.push('default_incoterm=?'); vals.push(v); }
  if (b.duty_arrangement !== undefined) { if (!['DAP', 'DDP'].includes(b.duty_arrangement)) fail(400, 'Duty arrangement must be DAP or DDP.'); sets.push('duty_arrangement=?'); vals.push(b.duty_arrangement); }
  if (b.postal_regex !== undefined) {
    const rx = str(b.postal_regex, 120);
    if (rx) { if (/(\+|\*|\{)\s*\)\s*[+*{]/.test(rx)) fail(400, 'That postal-code pattern is not allowed (it could hang the server).'); try { new RegExp(rx); } catch { fail(400, 'That postal-code pattern is not valid.'); } }
    sets.push('postal_regex=?'); vals.push(rx);
  }
  if (b.config !== undefined) { if (typeof b.config !== 'object' || Array.isArray(b.config) || JSON.stringify(b.config).length > 4000) fail(400, 'Country notes are too long or invalid.'); sets.push('config=?::jsonb'); vals.push(JSON.stringify(b.config)); }
  if (!sets.length) return shapeCountry(c);
  await run(`UPDATE trade_countries SET ${sets.join(',')} WHERE code=?`, ...vals, code);
  const next = shapeCountry(await get('SELECT * FROM trade_countries WHERE code=?', code));
  await T.audit(user, 'country.update', 'trade_countries', code, Object.fromEntries(Object.keys(b).filter((k) => k in next).map((k) => [k, next[k]])), ip);
  return next;
}
// Turn the same flag on or off for many countries at once (for example "ship to" for the whole of Europe).
async function bulkCountries(b, user, ip) {
  const codes = (Array.isArray(b.codes) ? b.codes : []).map((x) => String(x).toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)).slice(0, 300), flag = b.flag, on = b.on ? 1 : 0;
  if (!codes.length) fail(400, 'Choose at least one country.');
  if (!['export_to', 'export_from', 'import_from', 'import_to'].includes(flag)) fail(400, 'Unknown setting.');
  const r = await run(`UPDATE trade_countries SET ${flag}=? WHERE code = ANY(?::text[])`, on, codes);
  await T.audit(user, 'country.bulk', 'trade_countries', '', { flag, on, count: r.changes }, ip);
  return { changed: r.changes };
}

/* ---------- currencies ---------- */
async function currencies() {
  return (await all('SELECT * FROM trade_currencies ORDER BY is_base DESC, active DESC, sort, code')).map((c) => ({ code: c.code, name: c.name, symbol: c.symbol, decimals: Number(c.decimals), is_base: !!Number(c.is_base), active: !!Number(c.active) }));
}
async function saveCurrency(code, b, user, ip) {
  code = String(code || '').toUpperCase(); const c = await get('SELECT * FROM trade_currencies WHERE code=?', code); if (!c) fail(404, 'Currency not found.');
  if (b.active !== undefined) {
    const on = b.active === true || b.active === 1 || b.active === '1' ? 1 : 0;
    if (!on && Number(c.is_base)) fail(400, 'The base currency (NGN) cannot be switched off.');
    await run('UPDATE trade_currencies SET active=? WHERE code=?', on, code);
  }
  if (b.symbol !== undefined) await run('UPDATE trade_currencies SET symbol=? WHERE code=?', str(b.symbol, 6), code);
  await T.audit(user, 'currency.update', 'trade_currencies', code, { active: b.active, symbol: b.symbol }, ip);
  return currencies();
}

/* ---------- dashboard ---------- */
// All figures are read from real records. With no international orders yet, everything is simply 0.
async function dashboard(q = {}) {
  const to = q.to ? Math.floor(new Date(String(q.to).slice(0, 10) + 'T23:59:59Z').getTime() / 1000) : now() + 86400, from = q.from ? Math.floor(new Date(String(q.from).slice(0, 10) + 'T00:00:00Z').getTime() / 1000) : to - 90 * 86400;
  if (!Number.isFinite(from) || !Number.isFinite(to)) fail(400, 'Please choose a valid date range.');
  const SALE = "eo.status <> 'cancelled' AND o.payment_status = 'paid'";
  const one = async (sql, ...a) => (await get(sql, ...a)) || {};
  const exp = await one(`SELECT COUNT(*) n, COALESCE(SUM(o.total),0) rev_ngn FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE eo.created BETWEEN ? AND ? AND ${SALE}`, from, to);
  const expAll = await one('SELECT COUNT(*) n FROM export_orders WHERE created BETWEEN ? AND ?', from, to);
  const exStatus = await all('SELECT status, COUNT(*) n FROM export_orders WHERE created BETWEEN ? AND ? GROUP BY status', from, to);
  const imp = await one("SELECT COUNT(*) n, COALESCE(SUM(s.landed_cost * COALESCE(s.fx_rate_to_ngn,0)),0) landed_ngn, COALESCE(SUM(s.freight * COALESCE(s.fx_rate_to_ngn,0)),0) freight_ngn, COALESCE(SUM((s.customs_duties+s.import_taxes) * COALESCE(s.fx_rate_to_ngn,0)),0) duties_ngn FROM import_shipments s WHERE s.created BETWEEN ? AND ?", from, to);
  const imStatus = await all('SELECT status, COUNT(*) n FROM import_shipments WHERE created BETWEEN ? AND ? GROUP BY status', from, to);
  const transit = Number((await one("SELECT (SELECT COUNT(*) FROM export_orders WHERE status IN ('dispatched','in_transit','customs','out_for_delivery')) + (SELECT COUNT(*) FROM import_shipments WHERE status IN ('dispatched','in_transit','arrived_port','local_transit')) n")).n);
  const delivered = Number((await one("SELECT COUNT(*) n FROM export_orders WHERE status='delivered' AND updated BETWEEN ? AND ?", from, to)).n);
  const customs = Number((await one("SELECT (SELECT COUNT(*) FROM export_orders WHERE status='customs') + (SELECT COUNT(*) FROM import_shipments WHERE status IN ('customs_clearance','customs_hold')) n")).n);
  const delayed = Number((await one("SELECT COUNT(DISTINCT x) n FROM (SELECT export_order_id x FROM shipment_tracking_events WHERE stage IN ('delayed','exception','customs_hold') AND export_order_id IS NOT NULL AND occurred_at BETWEEN ? AND ? UNION SELECT id FROM export_orders WHERE eta < CURRENT_DATE AND status NOT IN ('delivered','cancelled','returned','pending')) d", from, to)).n);
  const byCountry = await all(`SELECT eo.destination_country code, c.name, COUNT(*) orders, COALESCE(SUM(o.total),0) revenue_ngn FROM export_orders eo JOIN orders o ON o.id=eo.order_id JOIN trade_countries c ON c.code=eo.destination_country WHERE eo.created BETWEEN ? AND ? AND ${SALE} GROUP BY 1,2 ORDER BY 4 DESC LIMIT 20`, from, to);
  const importByCountry = await all('SELECT s.supplier_country code, c.name, COUNT(*) shipments, COALESCE(SUM(s.landed_cost * COALESCE(s.fx_rate_to_ngn,0)),0) landed_ngn FROM import_shipments s JOIN trade_countries c ON c.code=s.supplier_country WHERE s.created BETWEEN ? AND ? GROUP BY 1,2 ORDER BY 4 DESC LIMIT 20', from, to);
  const shipExp = Number((await one("SELECT COALESCE(SUM(b.cost * CASE WHEN b.currency='NGN' THEN 1 ELSE COALESCE(eo.fx_rate_to_ngn,0) END),0) v FROM shipping_bookings b JOIN export_orders eo ON eo.id=b.export_order_id WHERE b.status='booked' AND b.created BETWEEN ? AND ?", from, to)).v);
  const payable = Number((await one("SELECT COALESCE(SUM(s.purchase_value * COALESCE(s.fx_rate_to_ngn,0)),0) v FROM import_shipments s WHERE s.status NOT IN ('draft','quotation_requested')")).v);
  const daily = await all(`SELECT to_char(to_timestamp(eo.created) AT TIME ZONE 'UTC','YYYY-MM-DD') d, COUNT(*) orders, COALESCE(SUM(o.total),0) revenue_ngn FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE eo.created BETWEEN ? AND ? AND ${SALE} GROUP BY 1 ORDER BY 1`, from, to);
  const rates = await FX.table();
  return {
    range: { from, to }, currency: 'NGN',
    kpi: { international_sales_ngn: Number(exp.rev_ngn), export_orders: Number(expAll.n), paid_export_orders: Number(exp.n), import_orders: Number(imp.n), in_transit: transit, delivered, pending_customs: customs, delayed,
      import_cost_ngn: Number(imp.landed_ngn), export_revenue_ngn: Number(exp.rev_ngn), shipping_expense_ngn: shipExp, duties_taxes_ngn: Number(imp.duties_ngn), outstanding_supplier_ngn: payable },
    export_by_status: exStatus.map((r) => ({ status: r.status, n: Number(r.n) })), import_by_status: imStatus.map((r) => ({ status: r.status, n: Number(r.n) })),
    sales_by_country: byCountry.map((r) => ({ code: r.code, name: r.name, orders: Number(r.orders), revenue_ngn: Number(r.revenue_ngn) })),
    imports_by_country: importByCountry.map((r) => ({ code: r.code, name: r.name, shipments: Number(r.shipments), landed_ngn: Number(r.landed_ngn) })),
    daily: daily.map((r) => ({ date: r.d, orders: Number(r.orders), revenue_ngn: Number(r.revenue_ngn) })),
    rates_attention: rates.filter((r) => !r.is_base && (r.missing || r.stale)).map((r) => ({ code: r.code, missing: r.missing, stale: r.stale })),
    notes: ['Outstanding supplier payments are the purchase value of approved import shipments. Payments to suppliers are recorded in Phase 4.', 'Figures in NGN use the exchange rate saved on each record when it was created.'],
  };
}

async function auditLog(q = {}) {
  const { per, offset, page } = T.page(q, 50), where = [], args = [];
  if (q.entity) { where.push('entity=?'); args.push(String(q.entity).slice(0, 60)); }
  if (q.action) { where.push('action ILIKE ?'); args.push(String(q.action).slice(0, 60).replace(/[%_]/g, '') + '%'); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return { total: (await get(`SELECT COUNT(*) n FROM trade_audit_logs ${w}`, ...args)).n, page, per, rows: await all(`SELECT id, user_name, action, entity, entity_id, detail, created FROM trade_audit_logs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, per, offset) };
}

module.exports = { countries, saveCountry, bulkCountries, currencies, saveCurrency, dashboard, auditLog };
