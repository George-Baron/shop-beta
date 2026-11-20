'use strict';
// International suppliers: directory, catalogue (manual and Excel/CSV upload), price comparison, payments the business made (records only),
// outstanding balances, private supporting documents, and encrypted bank details.
const crypto = require('crypto');
const { get, all, run, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const FX = require('./fx');
const X = require('../xlsx');
const storage = require('../storage');
const { fail, str } = S;

const INCOTERMS = ['', 'EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];
const STATUSES = ['active', 'paused', 'blocked'];
const DOC_TYPES = ['supplier_invoice', 'purchase_agreement', 'proforma_invoice', 'packing_list', 'certificate_of_origin', 'bill_of_lading', 'air_waybill', 'insurance_certificate', 'import_permit', 'customs_declaration', 'other'];
const DOC_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const MAX_DOC = 8 * 1024 * 1024;
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const cur = async (v, label) => { const c = String(v || '').toUpperCase(); if (!(await get('SELECT 1 x FROM trade_currencies WHERE code=?', c))) fail(400, `${label}: unknown currency.`); return c; };
const date = (v, label) => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v))) fail(400, `${label}: use the form 2026-12-31.`); return String(v); };

/* ---------- bank details: AES-256-GCM, key from TRADE_DATA_KEY. Without the key, bank details cannot be saved or read. ---------- */
const keyOf = () => { const k = process.env.TRADE_DATA_KEY || ''; return k.length >= 32 ? crypto.createHash('sha256').update(k).digest() : null; };
const bankConfigured = () => !!keyOf();
function seal(text) { const k = keyOf(), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv), enc = Buffer.concat([c.update(text, 'utf8'), c.final()]); return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64'); }
function unseal(blob) { const k = keyOf(), b = Buffer.from(String(blob).slice(3), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); }

const shape = (r) => ({
  id: Number(r.id), name: r.name, country_code: r.country_code, country: r.country_name || undefined, address: r.address, contact_person: r.contact_person, email: r.email, phone: r.phone, website: r.website,
  currency: r.currency, payment_terms: r.payment_terms, shipping_terms: r.shipping_terms, incoterm: r.incoterm, rating: r.rating == null ? null : Number(r.rating), status: r.status, notes: r.notes,
  has_bank_details: !!r.bank_details_enc, created: Number(r.created), updated: Number(r.updated),
});

/* ---------- directory ---------- */
async function list(q) {
  const { per, offset, page } = T.page(q, 25), w = [], a = [];
  if (q.q) { w.push('(s.name ILIKE ? OR s.contact_person ILIKE ? OR s.email ILIKE ?)'); const l = `%${String(q.q).slice(0, 60)}%`; a.push(l, l, l); }
  if (q.country) { w.push('s.country_code=?'); a.push(String(q.country).toUpperCase()); }
  if (q.status) { w.push('s.status=?'); a.push(String(q.status)); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const total = Number((await get(`SELECT COUNT(*) n FROM international_suppliers s ${where}`, ...a)).n);
  const rows = await all(`SELECT s.*, c.name country_name, (SELECT COUNT(*) FROM import_purchase_orders p WHERE p.supplier_id=s.id AND p.status<>'cancelled') pos, (SELECT COUNT(*) FROM supplier_products sp WHERE sp.supplier_id=s.id AND sp.active=1) products
    FROM international_suppliers s JOIN trade_countries c ON c.code=s.country_code ${where} ORDER BY lower(s.name) LIMIT ? OFFSET ?`, ...a, per, offset);
  return { total, page, per, suppliers: rows.map((r) => ({ ...shape(r), po_count: Number(r.pos), product_count: Number(r.products) })) };
}
async function load(id) { const r = await get('SELECT s.*, c.name country_name FROM international_suppliers s JOIN trade_countries c ON c.code=s.country_code WHERE s.id=?', Number(id) || 0); if (!r) fail(404, 'Supplier not found.'); return r; }

async function balances(id) {   // per currency, so different currencies are never added together
  const owed = await all("SELECT currency, COALESCE(SUM(total),0) v FROM import_purchase_orders WHERE supplier_id=? AND status='approved' GROUP BY currency", id);
  const paid = await all('SELECT currency, COALESCE(SUM(amount),0) v FROM supplier_payments WHERE supplier_id=? GROUP BY currency', id);
  const m = new Map();
  for (const r of owed) m.set(r.currency, { currency: r.currency, ordered: Number(r.v), paid: 0 });
  for (const r of paid) { const x = m.get(r.currency) || { currency: r.currency, ordered: 0, paid: 0 }; x.paid = Number(r.v); m.set(r.currency, x); }
  return [...m.values()].map((x) => ({ ...x, outstanding: T.roundTo(x.ordered - x.paid, 4) }));
}
async function get1(id) {
  const r = await load(id);
  const [pos, prods, docs, pays] = await Promise.all([
    all("SELECT id, po_number, status, currency, total, expected_arrival, created FROM import_purchase_orders WHERE supplier_id=? ORDER BY id DESC LIMIT 50", r.id),
    catalogue(r.id), documents({ supplier_id: r.id }), all('SELECT * FROM supplier_payments WHERE supplier_id=? ORDER BY paid_on DESC, id DESC LIMIT 50', r.id),
  ]);
  return { supplier: shape(r), purchase_history: pos.map((p) => ({ ...p, id: Number(p.id), total: Number(p.total), created: Number(p.created) })), products: prods, documents: docs, balances: await balances(r.id), payments: pays.map(payShape), bank_configured: bankConfigured() };
}
async function fields(b, cur0) {
  const name = str(b.name, 120); if (!name) fail(400, 'Supplier name is required.');
  const country = String(b.country_code || '').toUpperCase(); if (!(await get('SELECT 1 x FROM trade_countries WHERE code=?', country))) fail(400, 'Choose the supplier\'s country.');
  const email = str(b.email, 120).toLowerCase(); if (email && !S.isEmail(email)) fail(400, 'That email address does not look right.');
  const website = str(b.website, 200); if (website && !/^https?:\/\/[^\s]+$/i.test(website)) fail(400, 'The website must start with http:// or https://.');
  const incoterm = String(b.incoterm || '').toUpperCase(); if (!INCOTERMS.includes(incoterm)) fail(400, 'Unknown Incoterm.');
  const status = b.status ? String(b.status) : (cur0 ? cur0.status : 'active'); if (!STATUSES.includes(status)) fail(400, 'Unknown supplier status.');
  const rating = b.rating === '' || b.rating == null ? null : T.dec(b.rating, 'Rating', { min: 0, max: 5, places: 1 });
  return { name, country_code: country, address: str(b.address, 300), contact_person: str(b.contact_person, 100), email, phone: str(b.phone, 40), website, currency: await cur(b.currency || 'USD', 'Currency'),
    payment_terms: str(b.payment_terms, 200), shipping_terms: str(b.shipping_terms, 200), incoterm, rating, status, notes: str(b.notes, 2000) };
}
async function save(id, b, user, ip) {
  const cur0 = id ? await load(id) : null, f = await fields(b, cur0), t = now();
  const dup = await get('SELECT id FROM international_suppliers WHERE lower(name)=lower(?) AND country_code=? AND id<>?', f.name, f.country_code, id || 0);
  if (dup) fail(409, 'A supplier with this name already exists in that country.');
  if (id) {
    await run('UPDATE international_suppliers SET name=?,country_code=?,address=?,contact_person=?,email=?,phone=?,website=?,currency=?,payment_terms=?,shipping_terms=?,incoterm=?,rating=?,status=?,notes=?,updated=? WHERE id=?',
      f.name, f.country_code, f.address, f.contact_person, f.email, f.phone, f.website, f.currency, f.payment_terms, f.shipping_terms, f.incoterm, f.rating, f.status, f.notes, t, id);
    await T.audit(user, 'supplier.update', 'international_suppliers', id, { name: f.name, status: f.status }, ip);
    return shape(await load(id));
  }
  const r = await run('INSERT INTO international_suppliers (name,country_code,address,contact_person,email,phone,website,currency,payment_terms,shipping_terms,incoterm,rating,status,notes,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    f.name, f.country_code, f.address, f.contact_person, f.email, f.phone, f.website, f.currency, f.payment_terms, f.shipping_terms, f.incoterm, f.rating, f.status, f.notes, t, t);
  await T.audit(user, 'supplier.create', 'international_suppliers', r.lastInsertRowid, { name: f.name }, ip);
  return shape(await load(r.lastInsertRowid));
}
async function remove(id, user, ip) {
  const s = await load(id);
  if (await get('SELECT 1 x FROM import_purchase_orders WHERE supplier_id=? LIMIT 1', s.id) || await get('SELECT 1 x FROM supplier_payments WHERE supplier_id=? LIMIT 1', s.id)) fail(409, 'This supplier has orders or payments on record. Set it to "paused" or "blocked" instead of deleting it.');
  const docs = await all("SELECT stored_name FROM trade_documents WHERE supplier_id=? AND stored_name<>''", s.id);
  await run('DELETE FROM international_suppliers WHERE id=?', s.id);
  for (const d of docs) storage.tradeDocs.remove(d.stored_name).catch(() => {});
  await T.audit(user, 'supplier.delete', 'international_suppliers', s.id, { name: s.name }, ip);
  return { ok: true };
}

/* ---------- bank details (Finance permission is enforced by the route gate) ---------- */
async function getBank(id, user, ip) {
  const s = await load(id);
  if (!s.bank_details_enc) return { configured: bankConfigured(), details: '' };
  if (!bankConfigured()) fail(503, 'Bank details are stored encrypted, but the encryption key (TRADE_DATA_KEY) is not set on this server.');
  let details; try { details = unseal(s.bank_details_enc); } catch { fail(500, 'The saved bank details could not be decrypted. Check that TRADE_DATA_KEY has not changed.'); }
  await T.audit(user, 'supplier.bank.view', 'international_suppliers', s.id, {}, ip);   // who looked, never what
  return { configured: true, details };
}
async function setBank(id, text, user, ip) {
  const s = await load(id);
  if (!bankConfigured()) fail(503, 'Bank details cannot be saved until a secret key is set on the server. Add TRADE_DATA_KEY (at least 32 random characters) to the environment, then try again.');
  const v = String(text || '').trim().slice(0, 1500);
  await run('UPDATE international_suppliers SET bank_details_enc=?, updated=? WHERE id=?', v ? seal(v) : '', now(), s.id);
  await T.audit(user, v ? 'supplier.bank.set' : 'supplier.bank.clear', 'international_suppliers', s.id, {}, ip);
  return { ok: true, has_bank_details: !!v };
}

/* ---------- catalogue ---------- */
const prodShape = (r) => ({ id: Number(r.id), supplier_id: Number(r.supplier_id), supplier_sku: r.supplier_sku, name: r.name, description: r.description, hs_code: r.hs_code, unit_cost: Number(r.unit_cost), currency: r.currency, moq: Number(r.moq),
  lead_time_days: Number(r.lead_time_days), product_id: r.product_id == null ? null : Number(r.product_id), product_name: r.product_name || undefined, active: !!Number(r.active), updated: Number(r.updated) });
async function catalogue(supplierId) { return (await all('SELECT sp.*, p.name product_name FROM supplier_products sp LEFT JOIN products p ON p.id=sp.product_id WHERE sp.supplier_id=? ORDER BY sp.active DESC, lower(sp.name)', supplierId)).map(prodShape); }
async function productFields(b, s) {
  const name = str(b.name, 200); if (!name) fail(400, 'Product name is required.');
  let hs = T.hsClean(b.hs_code); if (hs && !T.HS_OK.test(hs)) fail(400, 'HS code: use digits and dots, for example 6109.10.');
  const unit = T.dec(b.unit_cost, 'Unit cost', { min: 0 }); if (unit == null) fail(400, 'Unit cost is required.');
  const moq = T.dec(b.moq === '' || b.moq == null ? 1 : b.moq, 'Minimum order quantity', { min: 1, max: 1e7, places: 0 });
  const lead = T.dec(b.lead_time_days === '' || b.lead_time_days == null ? 0 : b.lead_time_days, 'Lead time', { min: 0, max: 730, places: 0 });
  let productId = b.product_id === undefined ? undefined : null;   // undefined = leave an existing link alone
  if (b.product_id) { productId = Number(b.product_id); if (!(await get('SELECT 1 x FROM products WHERE id=?', productId))) fail(400, 'The linked Velto-Mart product was not found.'); }
  return { sku: str(b.supplier_sku, 80), name, description: str(b.description, 1000), hs, unit, currency: await cur(b.currency || s.currency, 'Currency'), moq, lead, productId, active: b.active === undefined ? 1 : bool(b.active) };
}
async function saveProduct(supplierId, id, b) {
  const s = await load(supplierId), f = await productFields(b, s), t = now();
  if (f.sku) { const d = await get('SELECT id FROM supplier_products WHERE supplier_id=? AND lower(supplier_sku)=lower(?) AND id<>?', s.id, f.sku, id || 0); if (d) fail(409, 'This supplier already has a product with that supplier SKU.'); }
  if (id) {
    const r = await run('UPDATE supplier_products SET supplier_sku=?,name=?,description=?,hs_code=?,unit_cost=?,currency=?,moq=?,lead_time_days=?,product_id=?,active=?,updated=? WHERE id=? AND supplier_id=?', f.sku, f.name, f.description, f.hs, f.unit, f.currency, f.moq, f.lead, f.productId === undefined ? (await get('SELECT product_id FROM supplier_products WHERE id=?', id) || {}).product_id || null : f.productId, f.active, t, id, s.id);
    if (!r.changes) fail(404, 'Catalogue item not found.');
    return prodShape(await get('SELECT * FROM supplier_products WHERE id=?', id));
  }
  const r = await run('INSERT INTO supplier_products (supplier_id,supplier_sku,name,description,hs_code,unit_cost,currency,moq,lead_time_days,product_id,active,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', s.id, f.sku, f.name, f.description, f.hs, f.unit, f.currency, f.moq, f.lead, f.productId || null, f.active, t);
  return prodShape(await get('SELECT * FROM supplier_products WHERE id=?', r.lastInsertRowid));
}
async function deleteProduct(supplierId, id) {
  const used = await get('SELECT 1 x FROM import_purchase_order_items WHERE supplier_product_id=? LIMIT 1', Number(id));
  if (used) { await run('UPDATE supplier_products SET active=0, updated=? WHERE id=? AND supplier_id=?', now(), Number(id), Number(supplierId)); return { ok: true, deactivated: true }; }
  await run('DELETE FROM supplier_products WHERE id=? AND supplier_id=?', Number(id), Number(supplierId)); return { ok: true };
}

const HEADERS = [['supplier_sku', 'Supplier SKU'], ['name', 'Product name'], ['description', 'Description'], ['hs_code', 'HS code'], ['unit_cost', 'Unit cost'], ['currency', 'Currency'], ['moq', 'Minimum order quantity'], ['lead_time_days', 'Lead time (days)'], ['linked_sku', 'Velto-Mart SKU (optional)']];
const MAX_ROWS = 2000;
function template(format) {
  const rows = [HEADERS.map((h) => h[1]), ['ABC-100', 'Cotton T-shirt, plain', 'Adult sizes S-XXL', '6109.10', 4.5, 'USD', 100, 21, '']];
  return format === 'csv' ? { buffer: X.writeCsv(rows), type: 'text/csv; charset=utf-8', ext: 'csv' } : { buffer: X.writeXlsx([{ name: 'Catalogue', rows, widths: HEADERS.map(() => 22) }]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
}
async function parseCatalogue(supplierId, buf, filename) {
  const s = await load(supplierId);
  let sheet; try { sheet = X.readSheet(buf, filename); } catch (e) { if (e instanceof X.SheetError) fail(400, e.message); throw e; }
  if (sheet.length < 2) fail(400, 'The file has no product rows.');
  if (sheet.length - 1 > MAX_ROWS) fail(400, `Please upload at most ${MAX_ROWS} products at a time.`);
  const idx = {}; sheet[0].forEach((h, i) => { const k = HEADERS.find(([key, label]) => label.toLowerCase() === String(h).trim().toLowerCase() || key === String(h).trim().toLowerCase()); if (k && !(k[0] in idx)) idx[k[0]] = i; });
  if (!('name' in idx) || !('unit_cost' in idx)) fail(400, 'The first row must contain the column titles from the template (at least "Product name" and "Unit cost").');
  const rows = [], errors = [], seen = new Set();
  for (let r = 1; r < sheet.length; r++) {
    const row = sheet[r], cell = (k) => (k in idx ? String(row[idx[k]] == null ? '' : row[idx[k]]).trim() : ''), n = r + 1;
    if (row.every((c) => String(c == null ? '' : c).trim() === '')) continue;
    try {
      const b = { supplier_sku: cell('supplier_sku'), name: cell('name'), description: cell('description'), hs_code: cell('hs_code'), unit_cost: cell('unit_cost'), currency: cell('currency') || s.currency, moq: cell('moq'), lead_time_days: cell('lead_time_days') };
      const lk = cell('linked_sku'); if (lk) { const p = await all('SELECT id FROM products WHERE sku=?', lk); if (p.length !== 1) fail(400, p.length ? `More than one product has SKU "${lk.slice(0, 40)}".` : `No Velto-Mart product has SKU "${lk.slice(0, 40)}".`); b.product_id = p[0].id; }
      const f = await productFields(b, s);
      const key = f.sku ? 'sku:' + f.sku.toLowerCase() : 'name:' + f.name.toLowerCase() + '|' + f.currency;
      if (seen.has(key)) fail(400, 'This product appears twice in the file.'); seen.add(key);
      rows.push({ row: n, b, f });
    } catch (e) { if (e.status) errors.push({ row: n, error: e.message }); else throw e; }
  }
  return { supplier: s, rows, errors };
}
async function previewCatalogue(supplierId, buf, filename) { const p = await parseCatalogue(supplierId, buf, filename); return { total: p.rows.length + p.errors.length, ok: p.rows.length, errors: p.errors.slice(0, 50), sample: p.rows.slice(0, 10).map((r) => ({ row: r.row, name: r.f.name, unit_cost: r.f.unit, currency: r.f.currency, moq: r.f.moq })) }; }
async function commitCatalogue(supplierId, buf, filename, user, ip) {
  const p = await parseCatalogue(supplierId, buf, filename); let created = 0, updated = 0;
  for (const r of p.rows) {
    const ex = r.f.sku ? await get('SELECT id FROM supplier_products WHERE supplier_id=? AND lower(supplier_sku)=lower(?)', p.supplier.id, r.f.sku) : await get('SELECT id FROM supplier_products WHERE supplier_id=? AND lower(name)=lower(?) AND currency=? AND supplier_sku=\'\'', p.supplier.id, r.f.name, r.f.currency);
    await saveProduct(p.supplier.id, ex ? Number(ex.id) : 0, r.b); if (ex) updated++; else created++;
  }
  await T.audit(user, 'supplier.catalogue.import', 'international_suppliers', p.supplier.id, { created, updated, skipped: p.errors.length }, ip);
  return { created, updated, skipped: p.errors.length, errors: p.errors.slice(0, 50) };
}

/* ---------- price comparison across suppliers ---------- */
async function compare(q) {
  const w = ['sp.active=1', "s.status='active'"], a = [];
  if (q.product_id) { w.push('sp.product_id=?'); a.push(Number(q.product_id) || 0); }
  else if (q.q && String(q.q).trim().length >= 2) { const l = `%${String(q.q).trim().slice(0, 60)}%`; w.push('(sp.name ILIKE ? OR sp.supplier_sku ILIKE ? OR sp.hs_code ILIKE ?)'); a.push(l, l, l); }
  else fail(400, 'Search for a product name, supplier SKU or HS code, or choose a linked product.');
  const rows = await all(`SELECT sp.*, s.name supplier, s.country_code, s.rating, s.incoterm FROM supplier_products sp JOIN international_suppliers s ON s.id=sp.supplier_id WHERE ${w.join(' AND ')} ORDER BY sp.unit_cost LIMIT 100`, ...a);
  const out = [];
  for (const r of rows) {
    let ngn = null, note = '';
    try { ngn = (await FX.convert(Number(r.unit_cost), r.currency, 'NGN', { markup: false })).amount; } catch (e) { note = 'No usable exchange rate, so this price is shown in its own currency only.'; }
    out.push({ ...prodShape(r), supplier: r.supplier, supplier_country: r.country_code, supplier_rating: r.rating == null ? null : Number(r.rating), incoterm: r.incoterm, unit_cost_ngn: ngn, note });
  }
  out.sort((x, y) => (x.unit_cost_ngn == null) - (y.unit_cost_ngn == null) || (x.unit_cost_ngn || 0) - (y.unit_cost_ngn || 0));
  return { items: out, note: 'Prices are converted at the latest stored exchange rate for comparison only. Supplier prices are what the supplier quoted; they are not confirmed until a purchase order is approved.' };
}

/* ---------- payments the business made to suppliers (records only: Finance permission) ---------- */
const payShape = (r) => ({ id: Number(r.id), supplier_id: Number(r.supplier_id), po_id: r.po_id == null ? null : Number(r.po_id), currency: r.currency, amount: Number(r.amount), amount_ngn: r.amount_ngn == null ? null : Number(r.amount_ngn), method: r.method, reference: r.reference, paid_on: r.paid_on instanceof Date ? r.paid_on.toISOString().slice(0, 10) : String(r.paid_on).slice(0, 10), note: r.note, created: Number(r.created) });
async function listPayments(q) {
  const w = [], a = []; if (q.supplier_id) { w.push('supplier_id=?'); a.push(Number(q.supplier_id) || 0); }
  return { payments: (await all(`SELECT * FROM supplier_payments ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY paid_on DESC, id DESC LIMIT 200`, ...a)).map(payShape) };
}
async function recordPayment(supplierId, b, user, ip) {
  const s = await load(supplierId), amount = T.dec(b.amount, 'Amount', { min: 0.0001 }), currency = await cur(b.currency || s.currency, 'Currency'), paidOn = date(b.paid_on, 'Payment date');
  if (!paidOn) fail(400, 'Enter the date the payment was made.');
  if (Date.parse(paidOn) > Date.now() + 86400000) fail(400, 'The payment date cannot be in the future.');
  let po = null; if (b.po_id) { po = await get('SELECT * FROM import_purchase_orders WHERE id=? AND supplier_id=?', Number(b.po_id) || 0, s.id); if (!po) fail(404, 'That purchase order does not belong to this supplier.'); if (po.currency !== currency) fail(400, `This order is in ${po.currency}; record the payment in ${po.currency}.`); }
  let rate = null, ngn = null;
  if (b.fx_rate_to_ngn !== undefined && b.fx_rate_to_ngn !== '') { rate = T.dec(b.fx_rate_to_ngn, 'Exchange rate', { min: 0.000001, places: 8 }); ngn = T.roundTo(amount * rate, 2); }   // the rate the bank actually gave, typed by staff
  else if (currency === 'NGN') { rate = 1; ngn = amount; }
  const method = ['bank_transfer', 'card', 'cash', 'letter_of_credit', 'other'].includes(b.method) ? b.method : 'bank_transfer';
  const r = await run('INSERT INTO supplier_payments (supplier_id,po_id,currency,amount,fx_rate_to_ngn,amount_ngn,method,reference,paid_on,note,created_by,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', s.id, po ? po.id : null, currency, amount, rate, ngn, method, str(b.reference, 100), paidOn, str(b.note, 300), user ? user.id : null, now());
  await T.audit(user, 'supplier.payment.record', 'supplier_payments', r.lastInsertRowid, { supplier: s.name, amount, currency }, ip);
  return { payment: payShape(await get('SELECT * FROM supplier_payments WHERE id=?', r.lastInsertRowid)), balances: await balances(s.id) };
}
async function deletePayment(id, user, ip) {
  const p = await get('SELECT * FROM supplier_payments WHERE id=?', Number(id) || 0); if (!p) fail(404, 'Payment not found.');
  await run('DELETE FROM supplier_payments WHERE id=?', p.id); await T.audit(user, 'supplier.payment.delete', 'supplier_payments', p.id, { amount: Number(p.amount), currency: p.currency }, ip);
  return { balances: await balances(p.supplier_id) };
}
async function payables() {
  const sup = await all("SELECT DISTINCT supplier_id FROM import_purchase_orders WHERE status='approved'"), out = [];
  for (const { supplier_id } of sup) { const s = await get('SELECT id, name FROM international_suppliers WHERE id=?', supplier_id); for (const b of await balances(supplier_id)) if (b.outstanding > 0) out.push({ supplier_id: Number(s.id), supplier: s.name, ...b }); }
  return { payables: out };
}

/* ---------- supporting documents (private storage, downloaded only through the admin API) ---------- */
const docShape = (r) => ({ id: Number(r.id), doc_type: r.doc_type, number: r.number, file_name: r.file_name, mime: r.mime, size_bytes: Number(r.size_bytes), po_id: r.po_id == null ? null : Number(r.po_id), import_shipment_id: r.import_shipment_id == null ? null : Number(r.import_shipment_id), supplier_id: r.supplier_id == null ? null : Number(r.supplier_id), status: r.status, created: Number(r.created) });
async function documents(f) {
  const w = ["origin='uploaded'"], a = [];
  for (const k of ['supplier_id', 'po_id', 'import_shipment_id']) if (f[k]) { w.push(`${k}=?`); a.push(Number(f[k])); }
  return (await all(`SELECT * FROM trade_documents WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT 100`, ...a)).map(docShape);
}
async function addDocument(target, b, buf, user, ip) {
  const type = String(b.doc_type || ''); if (!DOC_TYPES.includes(type)) fail(400, 'Choose what kind of document this is.');
  const fname = String(b.filename || 'document').replace(/[^\w.\- ]/g, '_').slice(0, 100), ext = (fname.split('.').pop() || '').toLowerCase();
  if (!DOC_MIME[ext]) fail(400, 'Upload a PDF, image (PNG/JPG), Excel, CSV or Word file.');
  if (buf.length > MAX_DOC) fail(400, 'That file is larger than 8 MB.'); if (!buf.length) fail(400, 'That file is empty.');
  const magic = { pdf: () => buf.subarray(0, 4).toString() === '%PDF', png: () => buf[0] === 0x89 && buf.subarray(1, 4).toString() === 'PNG', jpg: () => buf[0] === 0xff && buf[1] === 0xd8, jpeg: () => buf[0] === 0xff && buf[1] === 0xd8, xlsx: () => buf.subarray(0, 2).toString() === 'PK', docx: () => buf.subarray(0, 2).toString() === 'PK', csv: () => !buf.includes(0) }[ext];
  if (!magic()) fail(400, 'That file does not look like a real ' + ext.toUpperCase() + ' file.');
  const stored = crypto.randomBytes(16).toString('hex') + '.' + ext;
  try { await storage.tradeDocs.put(stored, buf); } catch (e) { console.error(e.message); fail(503, 'File storage is not available right now. Please try again.'); }
  const r = await run("INSERT INTO trade_documents (doc_type,number,po_id,import_shipment_id,supplier_id,origin,file_name,storage_path,stored_name,mime,size_bytes,status,created_by,created) VALUES (?,?,?,?,?,'uploaded',?,?,?,?,?,'issued',?,?)",
    type, str(b.number, 60), target.po_id || null, target.import_shipment_id || null, target.supplier_id || null, fname, 'private:' + stored, stored, DOC_MIME[ext], buf.length, user ? user.id : null, now());
  await T.audit(user, 'trade_document.upload', 'trade_documents', r.lastInsertRowid, { type, file: fname }, ip);
  return docShape(await get('SELECT * FROM trade_documents WHERE id=?', r.lastInsertRowid));
}
async function fetchDocument(id) {
  const d = await get("SELECT * FROM trade_documents WHERE id=? AND stored_name<>''", Number(id) || 0); if (!d) fail(404, 'Document not found.');
  let buf; try { buf = await storage.tradeDocs.get(d.stored_name); } catch (e) { console.error(e.message); fail(503, 'The file could not be read from storage right now.'); }
  return { name: d.file_name, mime: d.mime, buf };
}
async function removeDocument(id, user, ip) {
  const d = await get("SELECT * FROM trade_documents WHERE id=? AND origin='uploaded'", Number(id) || 0); if (!d) fail(404, 'Document not found.');
  await run('DELETE FROM trade_documents WHERE id=?', d.id); if (d.stored_name) storage.tradeDocs.remove(d.stored_name).catch(() => {});
  await T.audit(user, 'trade_document.delete', 'trade_documents', d.id, { file: d.file_name }, ip); return { ok: true };
}

module.exports = { INCOTERMS, DOC_TYPES, bankConfigured, list, get: get1, save, remove, getBank, setBank, catalogue, saveProduct, deleteProduct, template, previewCatalogue, commitCatalogue, compare,
  listPayments, recordPayment, deletePayment, payables, balances, documents, addDocument, fetchDocument, removeDocument, load };
