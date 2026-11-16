'use strict';
// Requests for quotation (RFQ). An approved wholesale buyer lists what they want (including things we do not stock), our commercial team prices it,
// sends a quotation, the buyer accepts or declines, and an accepted quotation becomes a normal wholesale order (see lib/wholesale.js: goods set aside, pay, ship).
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const W = require('./wholesale');
const N = require('./notify');
const X = require('./xlsx');
const storage = require('./storage');
const { fail, str, int, naira } = S;

const STEPS = ['draft', 'submitted', 'received', 'review', 'sourcing', 'quote_prepared', 'quote_sent', 'accepted', 'converted', 'completed'];
const LABEL = { draft: 'Draft', submitted: 'Submitted', received: 'Received by our commercial team', review: 'Under review', sourcing: 'Supplier sourcing in progress', quote_prepared: 'Quotation prepared', quote_sent: 'Quotation sent', accepted: 'Quotation accepted', rejected: 'Rejected', converted: 'Converted to a sales order', completed: 'Completed' };
const EDITABLE_PRICING = ['received', 'review', 'sourcing', 'quote_prepared', 'quote_sent'];
const MAX_ITEMS = 200, MAX_FILES = 5, MAX_FILE = 5 * 1024 * 1024, DAY = 86400;
const FILE_TYPES = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const MAGIC = { pdf: (b) => b.slice(0, 4).toString() === '%PDF', png: (b) => b[0] === 0x89 && b[1] === 0x50, jpg: (b) => b[0] === 0xff && b[1] === 0xd8, jpeg: (b) => b[0] === 0xff && b[1] === 0xd8, xlsx: (b) => b[0] === 0x50 && b[1] === 0x4b, docx: (b) => b[0] === 0x50 && b[1] === 0x4b, xls: (b) => b[0] === 0xd0 && b[1] === 0xcf };

const newRef = () => { const d = new Date(); return `RFQ-${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; };
const event = (id, status, note, by) => run('INSERT INTO rfq_events (rfq_id,status,note,by,created) VALUES (?,?,?,?,?)', id, status, str(note, 400), str(by, 80), now());
const priced = (r) => ['quote_sent', 'accepted', 'rejected', 'converted', 'completed'].includes(r.status) && Number(r.quote_total) > 0; // the buyer sees prices only once a quotation was sent
const expired = (r) => r.status === 'quote_sent' && r.quote_valid_until && Number(r.quote_valid_until) < now();

/* ---------- reading one request ---------- */
async function load(ref, accountId) {
  const r = await get(`SELECT * FROM rfqs WHERE ref=? ${accountId ? 'AND account_id=?' : ''}`, String(ref || ''), ...(accountId ? [accountId] : []));
  if (!r) fail(404, 'That request was not found.');
  return r;
}
async function shape(r, forBuyer) {
  const items = await all('SELECT i.*, p.name AS match_name, COALESCE((SELECT b.on_hand - b.reserved FROM wholesale_stock_balances b JOIN wholesale_warehouses w ON w.id=b.warehouse_id AND w.code=\'MAIN\' WHERE b.product_id=p.id), 0) AS match_stock, p.sku AS match_sku, p.price AS match_price FROM rfq_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.rfq_id=? ORDER BY i.id', r.id);
  const showPrices = !forBuyer || priced(r);
  const files = (await all('SELECT id, name, size, created FROM rfq_files WHERE rfq_id=? ORDER BY id', r.id)).map((f) => ({ id: Number(f.id), name: f.name, size: Number(f.size), created: Number(f.created) }));
  const events = (await all('SELECT status, note, by, created FROM rfq_events WHERE rfq_id=? ORDER BY id', r.id)).map((e) => ({ status: e.status, label: LABEL[e.status] || e.status, note: e.note, by: forBuyer ? '' : e.by, created: Number(e.created) }));
  const out = {
    ref: r.ref, status: expired(r) ? 'expired' : r.status, label: expired(r) ? 'Quotation expired' : LABEL[r.status], steps: STEPS.map((k) => ({ key: k, label: LABEL[k] })), step: Math.max(0, STEPS.indexOf(r.status)),
    company: r.company, contact_name: r.contact_name, email: r.email, phone: r.phone, delivery_location: r.delivery_location, required_date: r.required_date, comments: r.comments,
    created: Number(r.created), submitted_at: r.submitted_at ? Number(r.submitted_at) : null, quoted_at: r.quoted_at ? Number(r.quoted_at) : null, can_edit: r.status === 'draft',
    reject_reason: ['rejected'].includes(r.status) ? r.reject_reason : '', items: items.map((i) => ({
      id: Number(i.id), name: i.name, description: i.description, barcode: i.barcode, qty: Number(i.qty), brand: i.brand, packaging: i.packaging, target_price: i.target_price == null ? null : Number(i.target_price),
      ...(showPrices ? { unit_price: i.unit_price == null ? null : Number(i.unit_price), line_total: i.unit_price == null ? null : Number(i.unit_price) * Number(i.qty), item_note: i.item_note } : {}),
      ...(forBuyer ? {} : { product_id: i.product_id ? Number(i.product_id) : null, match_name: i.match_name, match_sku: i.match_sku, match_stock: i.match_stock == null ? null : Number(i.match_stock), match_price: i.match_price == null ? null : Number(i.match_price) }),
    })), files, events,
  };
  if (showPrices && Number(r.quote_total) > 0) Object.assign(out, { quote: { goods: Number(r.quote_goods), logistics: Number(r.quote_logistics), service_pct: Number(r.quote_service_pct), service: Number(r.quote_service), total: Number(r.quote_total), valid_until: r.quote_valid_until ? Number(r.quote_valid_until) : null, note: r.quote_note, shipment_plan: r.shipment_plan } });
  if (r.sales_ref) out.sales_ref = r.sales_ref;
  if (!forBuyer) Object.assign(out, { assigned_to: r.assigned_to ? Number(r.assigned_to) : null, assigned_name: r.assigned_to ? ((await get('SELECT name FROM users WHERE id=?', r.assigned_to)) || {}).name || '' : '', account_id: Number(r.account_id), raw_status: r.status });
  return out;
}

/* ---------- the buyer's side ---------- */
function cleanItems(list) {
  if (!Array.isArray(list)) fail(400, 'Add at least one product to your request.');
  if (list.length > MAX_ITEMS) fail(400, `A request can list up to ${MAX_ITEMS} products. Please split it into two requests.`);
  const out = [], errors = [];
  list.forEach((x, n) => {
    x = x || {}; const row = `Line ${n + 1}`, name = str(x.name, 140), qty = Number(String(x.qty).replace(/[,\s]/g, ''));
    const empty = !name && !x.qty && !x.description && !x.barcode; if (empty) return;
    if (!name) return errors.push(`${row}: the product name is missing.`);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10_000_000) return errors.push(`${row} (${name}): the quantity must be a whole number of 1 or more.`);
    let tp = null; if (x.target_price !== undefined && x.target_price !== null && String(x.target_price).trim() !== '') { const t = Number(String(x.target_price).replace(/[₦,\s]/g, '')); if (!Number.isFinite(t) || t < 0 || t > 2_000_000_000) return errors.push(`${row} (${name}): the target price must be an amount in naira.`); tp = Math.round(t); }
    out.push({ name, description: str(x.description, 600), barcode: str(x.barcode, 40), qty, brand: str(x.brand, 60), packaging: str(x.packaging, 80), target_price: tp });
  });
  if (errors.length) fail(400, errors.slice(0, 6).join(' ') + (errors.length > 6 ? ` And ${errors.length - 6} more.` : ''));
  if (!out.length) fail(400, 'Add at least one product to your request.');
  return out;
}
const cleanDate = (s) => { const d = str(s, 10); if (!d) return ''; if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) fail(400, 'Please give the date you need the goods as year-month-day, for example 2026-12-20.'); return d; };

async function save(user, ref, b) {
  const a = await W.approvedAccount(user), items = cleanItems(b.items);
  const head = { delivery_location: str(b.delivery_location, 300), required_date: cleanDate(b.required_date), comments: str(b.comments, 2000), contact_name: str(b.contact_name, 80) || a.contact_name, phone: str(b.phone, 30) || a.phone, email: str(b.email, 120) || a.email };
  return tx(async () => {
    let r;
    if (ref) { r = await load(ref, a.id); if (r.status !== 'draft') fail(409, 'This request was already submitted, so it cannot be edited. Contact us if something must change.'); }
    else {
      for (let i = 0; i < 5 && !r; i++) { try { const id = Number((await run('INSERT INTO rfqs (ref,account_id,company,status,created,updated) VALUES (?,?,?,?,?,?)', newRef(), a.id, a.business_name, 'draft', now(), now())).lastInsertRowid); r = await get('SELECT * FROM rfqs WHERE id=?', id); } catch (e) { if (!(e && e.code === '23505')) throw e; } }
      if (!r) fail(500, 'Could not start the request. Please try again.');
      await event(r.id, 'draft', 'Draft started', a.contact_name);
    }
    await run('UPDATE rfqs SET delivery_location=?, required_date=?, comments=?, contact_name=?, phone=?, email=?, updated=? WHERE id=?', head.delivery_location, head.required_date, head.comments, head.contact_name, head.phone, head.email, now(), r.id);
    await run('DELETE FROM rfq_items WHERE rfq_id=?', r.id);
    for (const i of items) await run('INSERT INTO rfq_items (rfq_id,name,description,barcode,qty,brand,packaging,target_price) VALUES (?,?,?,?,?,?,?,?)', r.id, i.name, i.description, i.barcode, i.qty, i.brand, i.packaging, i.target_price);
    return r.ref;
  });
}
async function submit(user, ref) {
  const a = await W.approvedAccount(user), r = await load(ref, a.id);
  if (r.status !== 'draft') fail(409, 'This request was already submitted.');
  const n = Number((await get('SELECT COUNT(*) n FROM rfq_items WHERE rfq_id=?', r.id)).n); if (!n) fail(400, 'Add at least one product before you submit.');
  if (!r.delivery_location) fail(400, 'Please tell us where the goods should be delivered.');
  await tx(async () => {
    await run("UPDATE rfqs SET status='submitted', submitted_at=?, updated=? WHERE id=?", now(), now(), r.id);
    // an item that carries one of our own barcodes is matched to that product straight away
    await run("UPDATE rfq_items i SET product_id=p.id FROM products p WHERE i.rfq_id=? AND i.barcode<>'' AND p.barcode=i.barcode AND p.vendor_id IS NULL AND p.active=1 AND i.product_id IS NULL", r.id);
    await event(r.id, 'submitted', `Submitted with ${n} product${n === 1 ? '' : 's'}`, a.contact_name);
  });
  await N.toStaff('rfq', true, { type: 'rfq', title: `New request for quotation ${r.ref} from ${a.business_name}`, body: `${n} product${n === 1 ? '' : 's'}, deliver to ${r.delivery_location}.`, link: '/admin#/rfq', email: true });
  await N.toAccount(a.id, { type: 'rfq', title: `We received your request ${r.ref}`, body: 'Our commercial team will start on it soon.', link: '/wholesale' });
}
async function removeDraft(user, ref) {
  const a = await W.approvedAccount(user), r = await load(ref, a.id);
  if (r.status !== 'draft') fail(409, 'Only a draft can be deleted.');
  const files = await all('SELECT stored FROM rfq_files WHERE rfq_id=?', r.id);
  await run('DELETE FROM rfqs WHERE id=?', r.id);
  for (const f of files) storage.rfqDocs.remove(f.stored).catch(() => {});
}
async function mine(user) {
  const a = await W.accountOf(user); if (!a) return { requests: [], summary: {} };
  const rows = await all('SELECT r.*, (SELECT COUNT(*) FROM rfq_items i WHERE i.rfq_id=r.id) AS n FROM rfqs r WHERE r.account_id=? ORDER BY r.id DESC LIMIT 200', a.id);
  const sum = { total: 0, pending: 0, quotations: 0, accepted: 0, rejected: 0, expired: 0 };
  const requests = rows.map((r) => {
    const st = expired(r) ? 'expired' : r.status; if (r.status !== 'draft') sum.total++;
    if (['submitted', 'received', 'review', 'sourcing', 'quote_prepared'].includes(r.status)) sum.pending++;
    if (st === 'quote_sent') sum.quotations++; if (['accepted', 'converted', 'completed'].includes(r.status)) sum.accepted++; if (r.status === 'rejected') sum.rejected++; if (st === 'expired') sum.expired++;
    return { ref: r.ref, status: st, label: expired(r) ? 'Quotation expired' : LABEL[r.status], items: Number(r.n), created: Number(r.created), submitted_at: r.submitted_at ? Number(r.submitted_at) : null, total: priced(r) ? Number(r.quote_total) : null, valid_until: priced(r) && r.quote_valid_until ? Number(r.quote_valid_until) : null };
  });
  return { requests, summary: sum };
}
async function mineOne(user, ref) { const a = await W.accountOf(user); if (!a) fail(403, 'Please apply to become a wholesale buyer first.'); return shape(await load(ref, a.id), true); }
async function respond(user, ref, accept, reason) {
  const a = await W.approvedAccount(user), r = await load(ref, a.id);
  if (r.status !== 'quote_sent') fail(409, 'There is no quotation waiting for your answer.');
  if (expired(r)) fail(410, 'This quotation has expired. Please ask us for a new one.');
  if (!accept && !str(reason, 300)) fail(400, 'Please tell us briefly why, so we can improve the next quotation.');
  await run('UPDATE rfqs SET status=?, reject_reason=?, closed_at=?, updated=? WHERE id=?', accept ? 'accepted' : 'rejected', accept ? '' : str(reason, 300), accept ? null : now(), now(), r.id);
  await event(r.id, accept ? 'accepted' : 'rejected', accept ? 'Quotation accepted by the buyer' : 'Quotation declined: ' + str(reason, 300), a.contact_name);
  await N.toStaff('rfq', true, { type: 'rfq', title: `${a.business_name} ${accept ? 'accepted' : 'declined'} the quotation for ${r.ref}`, body: accept ? 'Convert it to a sales order.' : str(reason, 200), link: '/admin#/rfq', email: true });
}

/* ---------- files ---------- */
async function addFile(user, ref, b, adminSide) {
  const r = adminSide ? await load(ref) : await load(ref, (await W.approvedAccount(user)).id);
  if (!adminSide && !['draft', 'submitted', 'received', 'review', 'sourcing'].includes(r.status)) fail(409, 'Files can no longer be added to this request.');
  if ((await get('SELECT COUNT(*) n FROM rfq_files WHERE rfq_id=?', r.id)).n >= MAX_FILES) fail(400, `Up to ${MAX_FILES} files per request.`);
  const name = str(b.name, 120).replace(/[^\w .()\-]/g, '_') || 'file', ext = (name.split('.').pop() || '').toLowerCase();
  if (!FILE_TYPES[ext]) fail(400, 'Please attach a PDF, Excel, CSV, Word, PNG or JPG file.');
  const m = /^data:[^;]*;base64,(.*)$/s.exec(String(b.data || '')), buf = Buffer.from(m ? m[1] : String(b.data || ''), 'base64');
  if (!buf.length) fail(400, 'That file is empty.'); if (buf.length > MAX_FILE) fail(400, 'That file is over 5 MB.');
  if (ext !== 'csv' && !(MAGIC[ext] && MAGIC[ext](buf))) fail(400, 'That file does not look like a real ' + ext.toUpperCase() + ' file.');
  const stored = crypto.randomBytes(16).toString('hex') + '.' + ext;
  try { await storage.rfqDocs.put(stored, buf); } catch (e) { console.error(e.message); fail(503, 'File storage is not available right now. Please try again, or send the file by email.'); }
  const id = Number((await run('INSERT INTO rfq_files (rfq_id,name,stored,size,mime,created) VALUES (?,?,?,?,?,?)', r.id, name, stored, buf.length, FILE_TYPES[ext], now())).lastInsertRowid);
  return { id, name };
}
async function readFile(user, ref, fileId, adminSide) {
  const r = adminSide ? await load(ref) : await load(ref, (await W.accountOf(user) || {}).id || 0);
  const f = await get('SELECT * FROM rfq_files WHERE id=? AND rfq_id=?', int(fileId), r.id); if (!f) fail(404, 'File not found.');
  return { name: f.name, mime: f.mime, buf: await storage.rfqDocs.get(f.stored) };
}
async function removeFile(user, ref, fileId) {
  const a = await W.approvedAccount(user), r = await load(ref, a.id); if (r.status !== 'draft') fail(409, 'Files can only be removed while the request is a draft.');
  const f = await get('SELECT * FROM rfq_files WHERE id=? AND rfq_id=?', int(fileId), r.id); if (!f) fail(404, 'File not found.');
  await run('DELETE FROM rfq_files WHERE id=?', f.id); storage.rfqDocs.remove(f.stored).catch(() => {});
}

/* ---------- spreadsheet in and out ---------- */
const COLS = [['Product Name', 'name', ['product name', 'name', 'product', 'item', 'item name']], ['Description', 'description', ['description', 'details', 'specification', 'spec']], ['Barcode / Code', 'barcode', ['barcode', 'barcode code', 'code', 'ean', 'sku', 'reference']], ['Quantity', 'qty', ['quantity', 'qty', 'units']], ['Preferred Brand', 'brand', ['preferred brand', 'brand']], ['Preferred Packaging', 'packaging', ['preferred packaging', 'packaging', 'pack', 'pack size']], ['Target Price', 'target_price', ['target price', 'price', 'budget', 'unit price']]];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const template = () => X.writeXlsx([{ name: 'Request', rows: [COLS.map((c) => c[0]), ['Example: Indomie Chicken Noodles 70g', 'Carton of 40', '', '200', 'Indomie', 'Carton', '9500']], widths: [34, 30, 16, 10, 18, 20, 14] }, { name: 'Instructions', rows: [['Fill one product per row. Product Name and Quantity are required. Delete the example row. Upload this file on the New request page.']], widths: [100] }]);
function parseSheet(buf, filename) {
  let rows; try { rows = X.readSheet(buf, filename); } catch (e) { if (e instanceof X.SheetError) fail(400, e.message); throw e; }
  if (rows.length < 2) fail(400, 'The file has no product rows under the column names.');
  const head = rows[0].map(norm), at = {}; for (const [, key, names] of COLS) { const i = head.findIndex((h) => names.includes(h)); if (i >= 0) at[key] = i; }
  if (at.name === undefined || at.qty === undefined) fail(400, 'The file needs the columns "Product Name" and "Quantity". Download the template to see the layout.');
  if (rows.length - 1 > MAX_ITEMS) fail(400, `Up to ${MAX_ITEMS} products per request.`);
  const items = rows.slice(1).map((r) => Object.fromEntries(COLS.map(([, key]) => [key, at[key] === undefined ? '' : String(r[at[key]] == null ? '' : r[at[key]]).trim()]))).filter((x) => x.name || x.qty);
  return { items };
}
const exportFile = (v) => X.writeXlsx([{ name: 'Request', rows: [
  ['Request', v.ref], ['Status', v.label], ['Company', v.company], ['Contact', v.contact_name + ' · ' + v.phone + ' · ' + v.email], ['Deliver to', v.delivery_location], ['Needed by', v.required_date], ['Notes', v.comments], [],
  ['Product Name', 'Description', 'Barcode / Code', 'Quantity', 'Preferred Brand', 'Preferred Packaging', 'Target Price', ...(v.quote ? ['Quoted Unit Price', 'Line Total'] : [])],
  ...v.items.map((i) => [i.name, i.description, i.barcode, i.qty, i.brand, i.packaging, i.target_price == null ? '' : i.target_price, ...(v.quote ? [i.unit_price == null ? '' : i.unit_price, i.line_total == null ? '' : i.line_total] : [])]),
  ...(v.quote ? [[], ['Goods', v.quote.goods], ['Logistics', v.quote.logistics], ['Service fee', v.quote.service], ['Total', v.quote.total]] : []),
], widths: [34, 30, 16, 10, 18, 20, 14, 16, 14] }]);

/* ---------- our team's side ---------- */
async function adminList(q) {
  const where = ["r.status<>'draft'"], args = [];
  if (q.status && /^[a-z_]+$/.test(q.status)) { if (q.status === 'expired') where.push("r.status='quote_sent' AND r.quote_valid_until < ?"), args.push(now()); else where.push('r.status=?'), args.push(q.status); }
  if (q.assigned === 'none') where.push('r.assigned_to IS NULL'); else if (/^\d+$/.test(String(q.assigned || ''))) where.push('r.assigned_to=?'), args.push(Number(q.assigned));
  if (q.q) { where.push('(r.ref ILIKE ? OR r.company ILIKE ?)'); args.push('%' + String(q.q).slice(0, 60) + '%', '%' + String(q.q).slice(0, 60) + '%'); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.from || ''))) where.push('r.submitted_at >= ?'), args.push(Math.floor(Date.parse(q.from) / 1000));
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.to || ''))) where.push('r.submitted_at < ?'), args.push(Math.floor(Date.parse(q.to) / 1000) + DAY);
  const rows = await all(`SELECT r.*, u.name AS aname, (SELECT COUNT(*) FROM rfq_items i WHERE i.rfq_id=r.id) AS n FROM rfqs r LEFT JOIN users u ON u.id=r.assigned_to WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 300`, ...args);
  const counts = {}; for (const c of await all("SELECT status, COUNT(*) n FROM rfqs WHERE status<>'draft' GROUP BY status")) counts[c.status] = Number(c.n);
  return { requests: rows.map((r) => ({ ref: r.ref, company: r.company, status: expired(r) ? 'expired' : r.status, label: expired(r) ? 'Quotation expired' : LABEL[r.status], items: Number(r.n), submitted_at: r.submitted_at ? Number(r.submitted_at) : null, assigned_to: r.assigned_to ? Number(r.assigned_to) : null, assigned_name: r.aname || '', total: Number(r.quote_total) || null })), counts };
}
const adminOne = async (ref) => shape(await load(ref), false);
async function officers() { return (await require('./staff').whoCan('rfq', true)).map((u) => ({ id: Number(u.id), name: u.name })); }
async function assign(ref, userId, actor) {
  const r = await load(ref); if (r.status === 'draft') fail(409, 'The buyer has not submitted this yet.');
  let u = null; if (userId) { u = (await officers()).find((o) => o.id === Number(userId)); if (!u) fail(400, 'That person cannot work on RFQs.'); }
  await run('UPDATE rfqs SET assigned_to=?, assigned_at=?, updated=? WHERE id=?', u ? u.id : null, u ? now() : null, now(), r.id);
  await event(r.id, r.status, u ? `Assigned to ${u.name}` : 'Unassigned', actor.name);
  if (u && r.status === 'submitted') { await run("UPDATE rfqs SET status='received' WHERE id=?", r.id); await event(r.id, 'received', 'Received by our commercial team', actor.name); await N.toAccount(r.account_id, { type: 'rfq', title: `${r.ref}: our commercial team is on it`, link: '/wholesale' }); }
  if (u && Number(u.id) !== Number(actor.id)) await N.notify([u.id], { type: 'rfq', title: `${r.ref} was assigned to you`, body: r.company, link: '/admin#/rfq', email: true });
}
const STAFF_MOVES = { received: ['submitted'], review: ['submitted', 'received', 'sourcing'], sourcing: ['received', 'review'] };
async function setStatus(ref, status, note, actor) {
  const r = await load(ref);
  if (status === 'rejected') {
    if (!['submitted', 'received', 'review', 'sourcing', 'quote_prepared'].includes(r.status)) fail(409, 'This request cannot be rejected at this stage.');
    if (!str(note, 300)) fail(400, 'Please give the buyer a reason.');
    await run("UPDATE rfqs SET status='rejected', reject_reason=?, closed_at=?, updated=? WHERE id=?", str(note, 300), now(), now(), r.id); await event(r.id, 'rejected', note, actor.name);
    return N.toAccount(r.account_id, { type: 'rfq', title: `${r.ref}: we cannot quote this request`, body: str(note, 300), link: '/wholesale', email: true });
  }
  if (!STAFF_MOVES[status] || !STAFF_MOVES[status].includes(r.status)) fail(409, `A request that is "${LABEL[r.status]}" cannot move to "${LABEL[status] || status}".`);
  await run('UPDATE rfqs SET status=?, updated=? WHERE id=?', status, now(), r.id); await event(r.id, status, note, actor.name);
  await N.toAccount(r.account_id, { type: 'rfq', title: `${r.ref}: ${LABEL[status].toLowerCase()}`, link: '/wholesale' });
}
async function match(q) {
  const t = '%' + str(q, 60) + '%'; if (str(q, 60).length < 2) return [];
  return (await all("SELECT p.id, p.name, p.sku, p.barcode, p.price, COALESCE((SELECT b.on_hand - b.reserved FROM wholesale_stock_balances b JOIN wholesale_warehouses w ON w.id=b.warehouse_id AND w.code='MAIN' WHERE b.product_id=p.id), 0) AS stock, p.brand FROM products p WHERE p.vendor_id IS NULL AND active=1 AND p.store<>'pharmacy' AND (p.name ILIKE ? OR p.sku ILIKE ? OR p.barcode ILIKE ? OR p.brand ILIKE ?) ORDER BY p.name LIMIT 12", t, t, t, t)).map((p) => ({ ...p, id: Number(p.id), price: Number(p.price), stock: Number(p.stock) }));
}
// Save the prices. items: [{ id, unit_price, product_id?, item_note?, drop? }]. A line marked "drop" is removed from the quotation (we cannot supply it).
async function saveQuote(ref, b, actor) {
  const r = await load(ref); if (!EDITABLE_PRICING.includes(r.status)) fail(409, 'This request is not at the pricing stage.');
  const cfg = await W.cfg(), list = Array.isArray(b.items) ? b.items : fail(400, 'Send the lines to price.');
  const logistics = Math.round(Number(b.logistics_fee) || 0), pct = Number(b.service_pct === undefined || b.service_pct === '' ? cfg.service_pct : b.service_pct), days = Math.min(90, Math.max(1, int(b.valid_days, cfg.valid_days)));
  if (logistics < 0 || logistics > 2_000_000_000) fail(400, 'The logistics fee is not valid.'); if (!(pct >= 0 && pct <= 100)) fail(400, 'The service fee must be a percentage from 0 to 100.');
  await tx(async () => {
    for (const x of list) {
      const it = await get('SELECT * FROM rfq_items WHERE id=? AND rfq_id=?', int(x.id), r.id); if (!it) fail(400, 'One of the lines does not belong to this request.');
      if (x.drop) { await run('DELETE FROM rfq_items WHERE id=?', it.id); continue; }
      const up = x.unit_price === null || x.unit_price === '' || x.unit_price === undefined ? null : Math.round(Number(x.unit_price));
      if (up !== null && (!Number.isFinite(up) || up < 0 || up > 2_000_000_000)) fail(400, `The price for "${it.name}" is not valid.`);
      let pid = it.product_id; if ('product_id' in x) { pid = x.product_id ? int(x.product_id) : null; if (pid && !(await get("SELECT 1 x FROM products WHERE id=? AND vendor_id IS NULL AND store<>'pharmacy'", pid))) fail(400, 'You can only match a line to one of our own non-pharmacy products.'); }
      await run('UPDATE rfq_items SET unit_price=?, product_id=?, item_note=? WHERE id=?', up, pid, str(x.item_note !== undefined ? x.item_note : it.item_note, 200), it.id);
    }
    const left = await all('SELECT unit_price, qty FROM rfq_items WHERE rfq_id=?', r.id); if (!left.length) fail(400, 'A quotation needs at least one line.');
    const complete = left.every((i) => i.unit_price != null), goods = left.reduce((s, i) => s + (i.unit_price == null ? 0 : Number(i.unit_price) * Number(i.qty)), 0), service = Math.round(goods * pct / 100);
    const prepared = complete && b.finalize !== false;
    await run('UPDATE rfqs SET quote_goods=?, quote_logistics=?, quote_service_pct=?, quote_service=?, quote_total=?, quote_valid_until=?, quote_note=?, shipment_plan=?, status=?, updated=? WHERE id=?',
      goods, logistics, pct, service, complete ? goods + logistics + service : 0, now() + days * DAY, str(b.quote_note, 500), str(b.shipment_plan, 500), prepared ? 'quote_prepared' : (r.status === 'quote_sent' ? 'review' : r.status), now(), r.id);
    if (prepared) await event(r.id, 'quote_prepared', `Quotation prepared: ${naira(goods + logistics + service)}`, actor.name); else await event(r.id, r.status, 'Prices saved (not all lines are priced yet)', actor.name);
  });
}
async function sendQuote(ref, actor) {
  const r = await load(ref); if (r.status !== 'quote_prepared') fail(409, 'Prepare the quotation first (every line needs a price).');
  const n = Number((await get('SELECT COUNT(*) n FROM rfq_items WHERE rfq_id=? AND unit_price IS NULL', r.id)).n); if (n) fail(409, `${n} line${n === 1 ? ' is' : 's are'} still without a price.`);
  const c = await W.cfg(), days = Math.max(1, Math.ceil((Number(r.quote_valid_until) - now()) / DAY));
  await run("UPDATE rfqs SET status='quote_sent', quoted_at=?, quote_valid_until=?, updated=? WHERE id=?", now(), now() + days * DAY, now(), r.id);
  await event(r.id, 'quote_sent', `Quotation sent, valid for ${days} day${days === 1 ? '' : 's'}`, actor.name);
  await N.toAccount(r.account_id, { type: 'rfq', title: `Your quotation for ${r.ref} is ready`, body: `Total ${naira(r.quote_total)}. Valid for ${days} day${days === 1 ? '' : 's'}.`, link: '/wholesale', email: true });
  void c;
}
async function convert(ref, actor) {
  const r = await load(ref); if (r.status !== 'accepted') fail(409, 'Only an accepted quotation can become a sales order.');
  const items = await all('SELECT i.*, p.name AS pname, p.price AS plist, COALESCE((SELECT b.on_hand - b.reserved FROM wholesale_stock_balances b JOIN wholesale_warehouses w ON w.id=b.warehouse_id AND w.code=\'MAIN\' WHERE b.product_id=p.id), 0) AS stock, p.active FROM rfq_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.rfq_id=? ORDER BY i.id', r.id);
  const problems = []; for (const i of items) { if (!i.product_id) problems.push(`"${i.name}" is not matched to a catalogue product. Add it to the catalogue and match it first.`); else if (!i.active) problems.push(`"${i.pname}" is switched off in the catalogue.`); else if (Number(i.stock) < Number(i.qty)) problems.push(`"${i.pname}": only ${i.stock} in the wholesale warehouse, ${i.qty} needed.`); }
  if (problems.length) fail(409, problems.slice(0, 5).join(' ') + (problems.length > 5 ? ` And ${problems.length - 5} more.` : ''));
  const sales = await W.orderFromRfq(r, items.map((i) => ({ product_id: Number(i.product_id), name: i.pname, qty: Number(i.qty), list_price: Number(i.plist), unit_price: Number(i.unit_price) })), actor.name);
  await run("UPDATE rfqs SET status='converted', sales_ref=?, updated=? WHERE id=?", sales, now(), r.id);
  await event(r.id, 'converted', `Converted to sales order ${sales}`, actor.name);
  await N.toAccount(r.account_id, { type: 'rfq', title: `${r.ref} is now order ${sales}`, body: 'Please pay to confirm shipment. Open Wholesale to see the invoice.', link: '/wholesale', email: true });
  await N.toStaff('finance', false, { type: 'rfq', title: `Order ${sales} (from ${r.ref}) is waiting for payment`, link: '/admin#/wholesale' });
  return sales;
}

module.exports = { STEPS, LABEL, save, submit, removeDraft, mine, mineOne, respond, addFile, readFile, removeFile, template, parseSheet, exportFile, adminList, adminOne, officers, assign, setStatus, match, saveQuote, sendQuote, convert, shape, load };
