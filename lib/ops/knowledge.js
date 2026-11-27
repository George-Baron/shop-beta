'use strict';
// Operational knowledge (spec section 21): notes people record that the AI reads before it answers or recommends. Procedures, handling needs,
// contract terms, supplier and delivery notes, past exceptions. Every note can carry an end date; after it the AI calls the note out of date.
// Prices are NOT kept here: supplier prices live in quotations with their date and source, and an old quotation is never shown as a current price.
const { all, get, run, now } = require('../db');
const { fail, str, int } = require('../shop');
const CATEGORIES = ['procedure', 'policy', 'handling', 'contract', 'supplier_note', 'delivery_note', 'exception', 'other'];
const SUBJECTS = ['', 'product', 'vendor', 'provider', 'warehouse'];
const shape = (r) => ({ ...r, id: Number(r.id), valid_until: r.valid_until == null ? null : Number(r.valid_until), created: Number(r.created), updated: Number(r.updated), out_of_date: r.valid_until != null && Number(r.valid_until) < now() });

async function add(user, b) {
  const title = str(b.title, 160).trim(), body = str(b.body, 4000).trim();
  if (!title || !body) fail(400, 'A note needs a title and some text.');
  if (!CATEGORIES.includes(b.category)) fail(400, 'Pick a category.');
  const st = SUBJECTS.includes(b.subject_type) ? b.subject_type : '';
  if (st && !str(b.subject_ref, 80).trim()) fail(400, 'Say which ' + st + ' this note is about.');
  const until = b.valid_until ? int(b.valid_until) : null; if (b.valid_until && !(until > now())) fail(400, 'The end date must be in the future.');
  const who = user ? user.name || user.email : '';
  const r = await get('INSERT INTO ops_knowledge (category,title,body,subject_type,subject_ref,valid_until,created_by,updated_by,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id', b.category, title, body, st, st ? str(b.subject_ref, 80).trim() : '', until, who, who, now(), now());
  return get('SELECT * FROM ops_knowledge WHERE id=?', r.id).then(shape);
}
async function update(user, id, b) {
  const k = await get('SELECT * FROM ops_knowledge WHERE id=?', int(id)); if (!k) fail(404, 'Note not found.');
  const title = b.title === undefined ? k.title : str(b.title, 160).trim(), body = b.body === undefined ? k.body : str(b.body, 4000).trim();
  if (!title || !body) fail(400, 'A note needs a title and some text.');
  const until = b.valid_until === undefined ? k.valid_until : (b.valid_until ? int(b.valid_until) : null), status = ['active', 'archived'].includes(b.status) ? b.status : k.status;
  await run('UPDATE ops_knowledge SET title=?, body=?, valid_until=?, status=?, updated_by=?, updated=? WHERE id=?', title, body, until, status, user ? user.name || user.email : '', now(), k.id);
  return get('SELECT * FROM ops_knowledge WHERE id=?', k.id).then(shape);
}
// q: { q (text), subject_type, subject_ref, category, include_old }
async function search(q = {}) {
  const w = ["status='active'"], a = [];
  if (CATEGORIES.includes(q.category)) { w.push('category=?'); a.push(q.category); }
  if (SUBJECTS.includes(q.subject_type) && q.subject_type) { w.push('subject_type=?'); a.push(q.subject_type); if (q.subject_ref) { w.push('lower(subject_ref)=lower(?)'); a.push(String(q.subject_ref)); } }
  if (q.q) { const t = '%' + String(q.q).toLowerCase().replace(/[\\%_]/g, '').slice(0, 60) + '%'; w.push('(lower(title) LIKE ? OR lower(body) LIKE ?)'); a.push(t, t); }
  const rows = (await all(`SELECT * FROM ops_knowledge WHERE ${w.join(' AND ')} ORDER BY updated DESC LIMIT 100`, ...a)).map(shape);
  return { notes: rows.filter((r) => q.include_old || !r.out_of_date), out_of_date: rows.filter((r) => r.out_of_date).length, note: 'Notes marked out of date are not current facts. Prices are never kept here; read the quotations.' };
}
// Supplier price history for one vendor and product: every quotation with its age, source and whether it is still valid. Nothing is called "current" unless it has not expired.
async function priceHistory({ vendor_id, product_id }) {
  const rows = await all(`SELECT q.ref, q.unit_price, q.currency, q.moq, q.source, q.source_ref, q.valid_until, q.created, v.name vendor FROM ops_quotations q JOIN ops_vendors v ON v.id=q.vendor_id JOIN ops_requests r ON r.id=q.request_id
    WHERE (?::bigint IS NULL OR q.vendor_id=?) AND (?::bigint IS NULL OR r.product_id=?) ORDER BY q.created DESC LIMIT 50`, int(vendor_id) || null, int(vendor_id) || null, int(product_id) || null, int(product_id) || null);
  const t = now();
  return rows.map((r) => ({ ref: r.ref, vendor: r.vendor, unit_price: Number(r.unit_price), currency: r.currency, moq: r.moq, source: r.source, source_ref: r.source_ref, quoted_on: Number(r.created), valid_until: r.valid_until == null ? null : Number(r.valid_until), age_days: Math.floor((t - Number(r.created)) / 86400), still_valid: r.valid_until != null && Number(r.valid_until) > t, status: r.valid_until == null ? 'no expiry recorded: confirm before relying on it' : Number(r.valid_until) > t ? 'valid' : 'expired: ask for a fresh quote' }));
}
module.exports = { CATEGORIES, SUBJECTS, add, update, search, priceHistory };
