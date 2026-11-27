'use strict';
// Quotation requests to suppliers. The AI drafts them for vendors a person has already added (Suppliers); it does not find suppliers on the internet
// (no research service is connected) and it never invents a vendor, a price or an address. A sent message identifies VELTO-MART's procurement assistant
// and makes no commitment on price, quantity or payment. Sending goes through the gateway (supplier.enquiry / supplier.followup) and the store's own
// email outbox, so it is approved or autonomous exactly as the rules say, and it is only marked "sent" when the email was really queued.
const { all, get, run, now } = require('../db');
const { fail, str, int } = require('../shop');
const S = require('../shop');
const St = require('./store');
const PR = require('./procure');

const WAIT_DAYS = 3, MAX_FOLLOWUPS = 2, FOLLOWUP_EVERY_DAYS = 3;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function compose(req, vendor, opts = {}) {
  const need = req.required_by ? ` We would need delivery by ${new Date(Number(req.required_by) * 1000).toISOString().slice(0, 10)}.` : '';
  const body = `Dear ${vendor.name},\n\nThis is VELTO-MART's procurement assistant writing on behalf of our operations team.\n\nWe would like a quotation for: ${req.description}${req.sku ? ' (SKU ' + req.sku + ')' : ''}.\nQuantity: ${req.qty}.${need}\n\nPlease reply with: unit price and currency, minimum order quantity, quantity available, lead time, delivery terms (Incoterm) and charges, payment terms, warranty and return terms, and how long the price is valid.\n\nThis is a request for information only. It is not an order and does not commit VELTO-MART to any price, quantity or payment.\n\nThank you,\nVELTO-MART Procurement`;
  const subject = (opts.followup ? 'Reminder: ' : '') + `Quotation request ${req.ref}: ${str(req.description, 70)}`;
  return { subject, body: opts.followup ? `Dear ${vendor.name},\n\nA gentle reminder of our quotation request ${req.ref} below. If you cannot supply this, please tell us so we can plan.\n\n----\n${body}` : body };
}

// Who could be asked for this request: vendors a person added and that are not suspended or rejected, with whether we already asked.
async function candidates(requestId) {
  const req = await get('SELECT * FROM ops_requests WHERE id=?', int(requestId)); if (!req) fail(404, 'Request not found.');
  const vs = await all("SELECT * FROM ops_vendors WHERE status NOT IN ('suspended','rejected') ORDER BY CASE status WHEN 'preferred' THEN 0 WHEN 'approved' THEN 1 WHEN 'conditional' THEN 2 ELSE 3 END, name");
  const asked = new Map((await all("SELECT vendor_id, status FROM ops_rfqs WHERE request_id=? AND status<>'cancelled'", req.id)).map((r) => [Number(r.vendor_id), r.status]));
  return { request: { id: Number(req.id), ref: req.ref, description: req.description, qty: req.qty },
    discovery: 'No supplier research service is connected, so the AI cannot search the internet. Add suppliers you have found under Suppliers (they start as "under review", unverified); they appear here.',
    vendors: vs.map((v) => ({ id: Number(v.id), ref: v.ref, name: v.name, status: v.status, country: v.country, email: v.email, can_email: !!v.email, asked: asked.get(Number(v.id)) || null })) };
}

async function draft(requestId, vendorId, by) {
  const req = await get('SELECT * FROM ops_requests WHERE id=?', int(requestId)); if (!req) fail(404, 'Request not found.');
  if (['closed', 'cancelled'].includes(req.status)) fail(409, 'This request is closed.');
  const v = await get('SELECT * FROM ops_vendors WHERE id=?', int(vendorId)); if (!v) fail(404, 'Vendor not found.');
  if (['suspended', 'rejected'].includes(v.status)) fail(409, `${v.name} is ${v.status}; do not request quotations from them.`);
  const ex = await get("SELECT id FROM ops_rfqs WHERE request_id=? AND vendor_id=? AND status<>'cancelled'", req.id, v.id); if (ex) fail(409, 'A quotation request to this vendor already exists for this request.');
  const m = compose(req, v), t = now();
  const r = await get('INSERT INTO ops_rfqs (request_id,vendor_id,status,subject,body,to_email,created,updated,created_by) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id', req.id, v.id, 'draft', m.subject, m.body, str(v.email, 160), t, t, str(by, 80));
  return one(r.id);
}
async function one(id) { const r = await get('SELECT f.*, v.name vendor, v.status vendor_status, q.ref request_ref FROM ops_rfqs f JOIN ops_vendors v ON v.id=f.vendor_id JOIN ops_requests q ON q.id=f.request_id WHERE f.id=?', int(id)); if (!r) fail(404, 'Not found.'); return { ...r, id: Number(r.id) }; }
async function list(requestId) { const w = requestId ? 'WHERE f.request_id=?' : ''; return (await all(`SELECT f.*, v.name vendor, q.ref request_ref FROM ops_rfqs f JOIN ops_vendors v ON v.id=f.vendor_id JOIN ops_requests q ON q.id=f.request_id ${w} ORDER BY f.id DESC LIMIT 200`, ...(requestId ? [int(requestId)] : []))).map((r) => ({ ...r, id: Number(r.id) })); }

// Sends (or re-sends as a reminder) through the store's email outbox. Returns what really happened.
async function send(id, { followup = false, by = 'AI' } = {}) {
  const f = await one(id);
  if (f.status === 'cancelled') fail(409, 'This request was cancelled.');
  if (f.status === 'answered') fail(409, 'This vendor already answered.');
  if (followup && f.status !== 'sent') fail(409, 'Send the request first.');
  if (!followup && f.status === 'sent') fail(409, 'Already sent.');
  if (followup && f.followups >= MAX_FOLLOWUPS) fail(409, `Already reminded ${MAX_FOLLOWUPS} times; a person should call them.`);
  if (['suspended', 'rejected'].includes(f.vendor_status)) fail(409, 'This vendor is suspended or rejected.');
  if (!f.to_email) { await St.createTask({ title: `Send quotation request ${f.ref} to ${f.vendor}`, detail: 'The vendor has no email address on file. Copy the message from Procurement and send it another way, then mark it sent.', department: 'procurement', related_type: 'rfq', related_id: String(f.id) }, by); return { sent: false, reason: 'The vendor has no email address, so a task was created for staff to send it.' }; }
  if (!S.mailOn) { await St.createTask({ title: `Send quotation request ${f.ref} to ${f.vendor}`, detail: 'Email sending is not configured (RESEND_API_KEY). Copy the message and send it by hand, then mark it sent.', department: 'procurement', related_type: 'rfq', related_id: String(f.id) }, by); return { sent: false, reason: 'Email is not configured, so a task was created for staff to send it by hand.' }; }
  const req = await get('SELECT * FROM ops_requests WHERE id=?', (await get('SELECT request_id FROM ops_rfqs WHERE id=?', f.id)).request_id), v = await get('SELECT * FROM ops_vendors WHERE id=?', f.vendor_id);
  const m = followup ? compose(req, v, { followup: true }) : { subject: f.subject, body: f.body };
  await S.queueMail(f.to_email, m.subject, '<div style="font-family:sans-serif;white-space:pre-wrap">' + esc(m.body) + '</div>');
  const t = now();
  if (followup) await run('UPDATE ops_rfqs SET followups=followups+1, last_followup_at=?, updated=? WHERE id=?', t, t, f.id);
  else await run("UPDATE ops_rfqs SET status='sent', sent_at=?, sent_by=?, updated=? WHERE id=?", t, str(by, 80), t, f.id);
  return { sent: true, followup, to: f.to_email };
}
// A person sent it outside the system (phone, WhatsApp, their own email).
async function markSent(id, by) { const f = await one(id); if (f.status !== 'draft') fail(409, 'Only a draft can be marked sent.'); await run("UPDATE ops_rfqs SET status='sent', sent_at=?, sent_by=?, updated=? WHERE id=?", now(), str(by, 80) + ' (by hand)', now(), f.id); return one(id); }
async function cancel(id) { const f = await one(id); if (f.status === 'answered') fail(409, 'Already answered.'); await run("UPDATE ops_rfqs SET status='cancelled', updated=? WHERE id=?", now(), f.id); return one(id); }

// A quotation on file for the same request and vendor means they answered.
async function syncAnswered() {
  const r = await run("UPDATE ops_rfqs f SET status='answered', answered_at=?, updated=? WHERE f.status IN ('sent','draft') AND EXISTS (SELECT 1 FROM ops_quotations q WHERE q.request_id=f.request_id AND q.vendor_id=f.vendor_id)", now(), now());
  return r.changes || 0;
}
async function watch(raise) {
  await syncAnswered(); const t = now();
  for (const f of await all("SELECT f.id, f.ref, f.sent_at, f.followups, f.last_followup_at, v.name vendor, q.ref request_ref FROM ops_rfqs f JOIN ops_vendors v ON v.id=f.vendor_id JOIN ops_requests q ON q.id=f.request_id WHERE f.status='sent' AND q.status IN ('open','quoted')")) {
    const since = Number(f.last_followup_at || f.sent_at), days = Math.floor((t - since) / 86400);
    if (days >= WAIT_DAYS) await raise({ kind: 'rfq_unanswered', severity: f.followups >= MAX_FOLLOWUPS ? 'medium' : 'low', dedupe_key: 'rfq_unanswered:' + f.id, title: `${f.vendor} has not answered ${f.ref} (${f.request_ref}) for ${days} days`, detail: `Reminders sent: ${f.followups} of ${MAX_FOLLOWUPS}.`, impact: 'The purchase cannot be priced without an answer.', recommended_action: f.followups >= MAX_FOLLOWUPS ? 'Call the vendor or ask another vendor.' : 'Send a reminder from Procurement.', department: 'suppliers', related_type: 'rfq', related_id: String(f.id), auto: true });
  }
}
module.exports = { WAIT_DAYS, MAX_FOLLOWUPS, compose, candidates, draft, one, list, send, markSent, cancel, syncAnswered, watch };
