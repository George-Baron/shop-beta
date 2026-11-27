'use strict';
// Import & Export enquiries from the public page. A visitor says what they want brought in (import) or what they want to buy from Nigeria (export);
// the team follows up by email or phone. No money moves here: a real deal becomes a wholesale quote or a dropship order.
const crypto = require('crypto');
const { get, all, run, now } = require('./db');
const S = require('./shop');
const { str, int, fail, isEmail } = S;

const KINDS = { import: 'Import: bring goods into Nigeria for me', export: 'Export: I want to buy Nigerian goods abroad' };
const STATUSES = { new: 'New', in_progress: 'In progress', quoted: 'Quote sent', won: 'Won', lost: 'Lost', spam: 'Spam' };
const SHIPPING = ['air', 'sea', 'any'];

async function create(b, user) {
  const kind = b.kind === 'export' ? 'export' : b.kind === 'import' ? 'import' : ''; if (!kind) fail(400, 'Please choose Import or Export.');
  const name = str(b.name, 80).trim(), email = str(b.email, 120).trim().toLowerCase(), phone = str(b.phone, 30).trim(), item = str(b.item, 200).trim(), details = str(b.details, 2000).trim(), country = str(b.country, 60).trim();
  if (name.length < 2) fail(400, 'Please tell us your name.');
  if (!isEmail(email)) fail(400, 'Please enter a valid email address so we can reply.');
  if (item.length < 3) fail(400, kind === 'import' ? 'Please tell us what you want to import.' : 'Please tell us which products you want to buy.');
  if (country.length < 2) fail(400, kind === 'import' ? 'Please tell us which country the goods would come from.' : 'Please tell us which country they would go to.');
  if (details.length < 10) fail(400, 'Please add a few details (specification, use, anything we should know).');
  // The same person sending the same thing twice in a day is one enquiry, not two.
  const dup = await get("SELECT ref FROM trade_enquiries WHERE email=? AND kind=? AND lower(item)=lower(?) AND created > ?", email, kind, item, now() - 86400);
  if (dup) return { ref: dup.ref, duplicate: true };
  const ref = 'TE-' + crypto.randomBytes(4).toString('hex').toUpperCase(), t = now();
  await run('INSERT INTO trade_enquiries (ref,kind,name,company,email,phone,country,item,quantity,budget,timeline,shipping,details,user_id,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ref, kind, name, str(b.company, 120).trim(), email, phone, country, item, str(b.quantity, 80).trim(), str(b.budget, 80).trim(), str(b.timeline, 80).trim(), SHIPPING.includes(b.shipping) ? b.shipping : 'any', details, user ? user.id : null, t, t);
  const st = await S.getSettings();
  require('./notify').toStaff('rfq', true, { type: 'order', title: `New ${kind} enquiry ${ref}`, body: `${name}${b.company ? ' (' + str(b.company, 60) + ')' : ''}: ${item} (${country}).`, link: '/admin#/tradeenq', email: true }).catch(() => {});
  try { await S.queueMail(email, `We received your ${kind} enquiry ${ref}`, S.mailWrap(st, `<p>Hello ${S.esc(name)},</p><p>Thank you. We have your ${kind} enquiry <b>${S.esc(ref)}</b> about <b>${S.esc(item)}</b> (${S.esc(country)}). Someone from our team will contact you, usually within 2 working days, to talk about prices, timing and how it would be shipped.</p><p>Please keep this reference if you write to us.</p>`)); } catch (e) { console.error('Trade enquiry email failed:', e.message); }
  return { ref };
}

const shape = (r) => ({ id: Number(r.id), ref: r.ref, kind: r.kind, status: r.status, status_text: STATUSES[r.status], name: r.name, company: r.company, email: r.email, phone: r.phone, country: r.country, item: r.item, quantity: r.quantity, budget: r.budget, timeline: r.timeline, shipping: r.shipping, details: r.details, has_account: !!r.user_id, note: r.note, handled_by: r.handled_by, created: Number(r.created), updated: Number(r.updated), contacted_at: r.contacted_at ? Number(r.contacted_at) : null });
async function list(q = {}) {
  const w = [], a = [];
  if (STATUSES[q.status]) { w.push('status=?'); a.push(q.status); }
  if (KINDS[q.kind]) { w.push('kind=?'); a.push(q.kind); }
  const s = str(q.q, 80).trim(); if (s) { w.push("(name ILIKE ? OR email ILIKE ? OR company ILIKE ? OR item ILIKE ? OR ref ILIKE ?)"); const l = '%' + s.replace(/[%_]/g, '') + '%'; a.push(l, l, l, l, l); }
  const rows = await all(`SELECT * FROM trade_enquiries ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, id DESC LIMIT 300`, ...a);
  const c = await get("SELECT COUNT(*) FILTER (WHERE status='new')::int fresh, COUNT(*) FILTER (WHERE status IN ('new','in_progress'))::int open FROM trade_enquiries");
  return { enquiries: rows.map(shape), counts: { new: c.fresh, open: c.open } };
}
async function update(id, actor, b) {
  const r = await get('SELECT * FROM trade_enquiries WHERE id=?', id); if (!r) fail(404, 'Enquiry not found.');
  const status = STATUSES[b.status] ? b.status : r.status, note = b.note === undefined ? r.note : str(b.note, 2000), t = now();
  const touched = r.status === 'new' && status !== 'new' && !r.contacted_at;
  await run('UPDATE trade_enquiries SET status=?, note=?, handled_by=?, contacted_at=?, updated=? WHERE id=?', status, note, str(actor.name || actor.email, 80), touched ? t : r.contacted_at, t, id);
  return shape(await get('SELECT * FROM trade_enquiries WHERE id=?', id));
}
module.exports = { KINDS, STATUSES, create, list, update };
