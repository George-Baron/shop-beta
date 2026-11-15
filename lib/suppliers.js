'use strict';
// Suppliers: the companies that ship goods to our customers. Admin only. Cost and margin never leave the admin API.
const crypto = require('crypto');
const { get, all, run, now } = require('./db');
const S = require('./shop');
const storage = require('./storage');
const C = require('./countries');
const { fail, str, int } = S;

const METHODS = ['air', 'sea', 'courier', 'local'];
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// Reads and checks what the admin typed. Returns clean values; fails with a plain message otherwise.
function read(b, cur = {}) {
  const name = str(b.name, 100) || cur.name || '';
  if (!name) fail(400, 'Please enter the supplier name.');
  const country = str(b.country, 2).toUpperCase() || cur.country || '';
  if (!C.isCountry(country)) fail(400, 'Please choose the supplier\'s country.');
  const currency = str(b.currency, 3).toUpperCase() || cur.currency || '';
  if (!C.isCurrency(currency)) fail(400, 'Please choose the currency this supplier invoices in.');
  const email = str(b.email, 120).toLowerCase();
  if (email && !S.isEmail(email)) fail(400, 'That email address is not valid.');
  const whatsapp = str(b.whatsapp, 30);
  if (whatsapp && !/^\+?[0-9 ()-]{6,24}$/.test(whatsapp)) fail(400, 'WhatsApp number: use digits with the country code, for example +86 138 0000 0000.');
  const methods = [...new Set((Array.isArray(b.shipping_methods) ? b.shipping_methods : String(b.shipping_methods || '').split(',')).map((m) => String(m).trim().toLowerCase()).filter(Boolean))];
  if (methods.some((m) => !METHODS.includes(m))) fail(400, 'Shipping methods can be: air, sea, courier, local delivery.');
  const processing = int(b.processing_days, 3), payDays = int(b.payment_days, 0);
  if (processing < 0 || processing > 120) fail(400, 'Processing days must be between 0 and 120.');
  if (payDays < 0 || payDays > 365) fail(400, 'Payment days must be between 0 and 365.');
  const status = b.status === undefined ? (cur.status || 'active') : str(b.status, 10);
  if (!['active', 'paused'].includes(status)) fail(400, 'Status must be active or paused.');
  let margin_type = b.margin_type === undefined ? (cur.margin_type || null) : (str(b.margin_type, 10) || null), margin_value = b.margin_value === undefined ? (cur.margin_value == null ? null : Number(cur.margin_value)) : num(b.margin_value);
  if (margin_type && !['percent', 'fixed'].includes(margin_type)) fail(400, 'The margin rule must be a percentage or a fixed amount.');
  if (!margin_type || margin_value == null) { margin_type = null; margin_value = null; }
  else if (margin_value < 0 || (margin_type === 'percent' && margin_value > 1000)) fail(400, 'That margin is not valid.');
  return { name, country, contact_name: str(b.contact_name, 80), email, whatsapp, address: str(b.address, 300), currency, payment_terms: str(b.payment_terms, 60), payment_days: payDays,
    processing_days: processing, shipping_methods: methods.join(','), margin_type, margin_value, notes: str(b.notes, 2000), status };
}

const shape = (s) => s && ({ ...s, id: Number(s.id), created: Number(s.created), updated: Number(s.updated), country_name: C.countryName(s.country), shipping_methods: s.shipping_methods ? s.shipping_methods.split(',') : [],
  margin_value: s.margin_value == null ? null : Number(s.margin_value) });

async function load(id) { const s = await get('SELECT * FROM suppliers WHERE id=?', int(id)); if (!s) fail(404, 'Supplier not found.'); return shape(s); }

// Orders, late deliveries, cancellations, defects, average rating, and the rates that matter.
async function performance(id) {
  const r = await get(`SELECT COUNT(*) FILTER (WHERE kind='order') AS orders, COUNT(*) FILTER (WHERE kind='late') AS late, COUNT(*) FILTER (WHERE kind='cancellation') AS cancellations,
    COUNT(*) FILTER (WHERE kind='defect') AS defects, ROUND(AVG(rating)::numeric, 2) AS rating, COUNT(*) FILTER (WHERE kind='rating') AS ratings FROM supplier_events WHERE supplier_id=?`, id);
  const orders = Number(r.orders), pct = (n) => (orders ? Math.round((Number(n) / orders) * 1000) / 10 : null);
  return { orders, late: Number(r.late), cancellations: Number(r.cancellations), defects: Number(r.defects), ratings: Number(r.ratings), rating: r.rating == null ? null : Number(r.rating),
    on_time_pct: orders ? Math.max(0, Math.round((1 - Number(r.late) / orders) * 1000) / 10) : null, cancel_pct: pct(r.cancellations), defect_pct: pct(r.defects) };
}

async function list({ status, q } = {}) {
  const where = [], args = [];
  if (['active', 'paused'].includes(status)) { where.push('s.status=?'); args.push(status); }
  const text = str(q, 60).toLowerCase();
  if (text) { where.push("lower(s.name) LIKE ? ESCAPE '\\'"); args.push('%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%'); }
  const rows = await all(`SELECT s.*, (SELECT COUNT(*) FROM supplier_events e WHERE e.supplier_id=s.id AND e.kind='order') AS orders,
    (SELECT ROUND(AVG(rating)::numeric,2) FROM supplier_events e WHERE e.supplier_id=s.id AND e.kind='rating') AS rating
    FROM suppliers s ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.status, lower(s.name) LIMIT 500`, ...args);
  return rows.map((s) => ({ ...shape(s), orders: Number(s.orders), rating: s.rating == null ? null : Number(s.rating) }));
}

async function create(user, b) {
  const v = read(b), t = now();
  const r = await run('INSERT INTO suppliers (name,country,contact_name,email,whatsapp,address,currency,payment_terms,payment_days,processing_days,shipping_methods,margin_type,margin_value,notes,status,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    v.name, v.country, v.contact_name, v.email, v.whatsapp, v.address, v.currency, v.payment_terms, v.payment_days, v.processing_days, v.shipping_methods, v.margin_type, v.margin_value, v.notes, v.status, t, t);
  return Number(r.lastInsertRowid);
}
async function update(id, b) {
  const cur = await load(id), v = read(b, cur);
  await run('UPDATE suppliers SET name=?,country=?,contact_name=?,email=?,whatsapp=?,address=?,currency=?,payment_terms=?,payment_days=?,processing_days=?,shipping_methods=?,margin_type=?,margin_value=?,notes=?,status=?,updated=? WHERE id=?',
    v.name, v.country, v.contact_name, v.email, v.whatsapp, v.address, v.currency, v.payment_terms, v.payment_days, v.processing_days, v.shipping_methods, v.margin_type, v.margin_value, v.notes, v.status, now(), cur.id);
}

/* ---------- performance ledger ---------- */
async function addEvent(user, id, b) {
  const s = await load(id), kind = str(b.kind, 15);
  if (!['order', 'late', 'cancellation', 'defect', 'rating'].includes(kind)) fail(400, 'Choose order, late delivery, cancellation, defect or rating.');
  let rating = null;
  if (kind === 'rating') { rating = int(b.rating); if (rating < 1 || rating > 5) fail(400, 'A rating is 1 to 5 stars.'); }
  const qty = kind === 'rating' ? 1 : Math.min(500, Math.max(1, int(b.count, 1)));
  for (let i = 0; i < qty; i++) await run('INSERT INTO supplier_events (supplier_id,kind,rating,ref,note,created,created_by) VALUES (?,?,?,?,?,?,?)', s.id, kind, rating, str(b.ref, 60), str(b.note, 300), now(), String(user.name || user.email).slice(0, 80));
}
const events = (id, n = 50) => all('SELECT id, kind, rating, ref, note, created, created_by FROM supplier_events WHERE supplier_id=? ORDER BY id DESC LIMIT ?', int(id), n);

/* ---------- documents (private bucket) ---------- */
const FILE_TYPES = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.length > 5 && b.toString('latin1', 0, 5) === '%PDF-' },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', test: (b) => b.length > 4 && b.readUInt32BE(0) === 0x504b0304 },
];
async function addDocument(user, id, kind, buf, filename) {
  const s = await load(id);
  if (!['registration', 'agreement', 'other'].includes(kind)) fail(400, 'Choose business registration, contact agreement or other.');
  if (!buf.length) fail(400, 'Please choose a file.');
  if (buf.length > 8_000_000) fail(400, 'That file is over 8 MB.');
  const type = FILE_TYPES.find((t) => t.test(buf));
  if (!type) fail(400, 'Documents must be a PDF, JPG, PNG or Word (.docx) file.');
  if ((await get('SELECT COUNT(*) n FROM supplier_documents WHERE supplier_id=?', s.id)).n >= 30) fail(400, 'This supplier already has 30 documents. Remove an old one first.');
  const key = `supplier-${s.id}-${kind}-${crypto.randomBytes(6).toString('hex')}.${type.ext}`;
  await storage.supplierDocs.put(key, buf);
  const r = await run('INSERT INTO supplier_documents (supplier_id,kind,file_key,file_name,mime,bytes,created,created_by) VALUES (?,?,?,?,?,?,?,?)', s.id, kind, key, str(filename, 100).replace(/[^\w .()-]/g, '_') || 'document', type.mime, buf.length, now(), String(user.name || user.email).slice(0, 80));
  return Number(r.lastInsertRowid);
}
const documents = (id) => all('SELECT id, kind, file_name, mime, bytes, created, created_by FROM supplier_documents WHERE supplier_id=? ORDER BY id DESC', int(id));
async function openDocument(supplierId, docId) {
  const d = await get('SELECT * FROM supplier_documents WHERE id=? AND supplier_id=?', int(docId), int(supplierId));
  if (!d) fail(404, 'Document not found.');
  return { buf: await storage.supplierDocs.get(d.file_key), mime: d.mime, name: d.file_name, doc: d };
}
async function removeDocument(supplierId, docId) {
  const d = await get('SELECT * FROM supplier_documents WHERE id=? AND supplier_id=?', int(docId), int(supplierId));
  if (!d) fail(404, 'Document not found.');
  await run('DELETE FROM supplier_documents WHERE id=?', d.id);
  storage.supplierDocs.remove(d.file_key).catch((e) => console.error('Could not delete supplier file:', e.message));
}

module.exports = { METHODS, read, shape, load, list, create, update, performance, addEvent, events, addDocument, documents, openDocument, removeDocument };
