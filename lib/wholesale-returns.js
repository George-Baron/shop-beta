'use strict';
// Wholesale returns. Same road as retail returns: a request (the buyer, or our team for the buyer) -> reviewed by a person with Orders: Edit (the Operations Manager)
// -> approved by the OWNER -> refunded (automatically through Paystack when the quote was paid that way, otherwise Finance records the bank transfer).
// Only delivered quotes can be returned. Only the GOODS are refunded (delivery and service fees are not, unless the owner agrees by hand). Returned goods can go back
// into the wholesale warehouse. Retail stock is never touched.
const crypto = require('crypto');
const { get, all, run, now } = require('./db');
const S = require('./shop');
const { str, int, fail } = S;

const REASONS = { faulty: 'Faulty or damaged goods', wrong_item: 'Wrong item sent', short_delivery: 'Items missing from the delivery', not_as_described: 'Not as described', agreed: 'Return agreed with our account manager', other: 'Something else' };
const OPEN = ['requested', 'recommended', 'awaiting_settlement', 'settling'];
const WORDS = { requested: 'Waiting for review', recommended: 'Reviewed, waiting for the owner to approve', awaiting_settlement: 'Approved, refund on its way', settling: 'Refund being sent', settled: 'Refunded', rejected: 'Declined', cancelled: 'Cancelled' };
const isOwner = (a) => !!a && a.role === 'admin';
const who = (a) => str(a.name || a.email || 'Staff', 80);
const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');
const parse = (r) => ({ ...r, items: Array.isArray(r.items) ? r.items : JSON.parse(r.items || '[]') });
const event = (qid, status, note, by) => run('INSERT INTO wholesale_events (quote_id,status,note,by,created) VALUES (?,?,?,?,?)', qid, status, note, by, now());
const N = () => require('./notify');
async function mailBuyer(a, subject, html) { try { await S.queueMail(a.email, subject, S.mailWrap(await S.getSettings(), html)); } catch (e) { console.error('Wholesale return email failed:', e.message); } }
async function acct(id) { return get('SELECT * FROM wholesale_accounts WHERE id=?', id); }

const days = async () => Math.max(0, int((await S.getSettings()).wholesale_return_days, 7) || 7);
async function goodsBack(quoteId, exceptId = 0) {   // Naira of goods already refunded on this quote
  return Number((await get("SELECT COALESCE(SUM(approved_amount),0)::bigint n FROM wholesale_returns WHERE quote_id=? AND status='settled' AND id<>?", quoteId, exceptId)).n);
}
async function returnedQty(quoteId) {
  const by = {};
  for (const r of await all("SELECT items FROM wholesale_returns WHERE quote_id=? AND status IN ('requested','recommended','awaiting_settlement','settling','settled')", quoteId))
    for (const i of parse(r).items) by[i.item_id] = (by[i.item_id] || 0) + Number(i.qty);
  return by;
}
async function eligibility(q, opts = {}) {
  const d = await days(), out = { can: false, reason: '', days: d, deadline: null, past_window: false, lines: [] };
  if (q.status !== 'delivered') { out.reason = 'Only a delivered order can be returned.'; return out; }
  out.deadline = q.delivered_at ? Number(q.delivered_at) + d * 86400 : null;
  if (out.deadline && now() > out.deadline) { out.past_window = true; if (!opts.staff) { out.reason = `The ${d}-day return window for this order has closed. Please contact us.`; return out; } }
  const open = await get("SELECT 1 x FROM wholesale_returns WHERE quote_id=? AND status IN ('requested','recommended','awaiting_settlement','settling')", q.id);
  if (open) { out.reason = 'A return is already open for this order.'; return out; }
  const back = await returnedQty(q.id);
  out.lines = (await all('SELECT id, product_id, name, qty, unit_price FROM wholesale_quote_items WHERE quote_id=? ORDER BY id', q.id)).map((i) => ({ item_id: Number(i.id), product_id: Number(i.product_id), name: i.name, qty: Number(i.qty), returnable: Math.max(0, Number(i.qty) - (back[i.id] || 0)), unit_price: Number(i.unit_price) }));
  if (!out.lines.some((l) => l.returnable > 0)) { out.reason = 'Everything on this order has already been returned.'; return out; }
  out.can = true; return out;
}

async function request(q, b, by) {
  const el = await eligibility(q, { staff: !!by }); if (!el.can) fail(400, el.reason);
  const reason = REASONS[b.reason] ? b.reason : 'other', details = str(b.details, 1000).trim();
  if (details.length < 10) fail(400, 'Please tell us what is wrong, in a sentence or two.');
  const picked = [];
  for (const it of Array.isArray(b.items) ? b.items.slice(0, 100) : []) {
    const l = el.lines.find((x) => x.item_id === int(it.item_id)), qty = int(it.qty); if (!l || qty < 1) continue;
    if (qty > l.returnable) fail(400, `You can return at most ${l.returnable} of "${l.name}".`);
    if (picked.some((p) => p.item_id === l.item_id)) fail(400, 'Each product can only be listed once.');
    picked.push({ item_id: l.item_id, product_id: l.product_id, name: l.name, qty, unit_price: l.unit_price });
  }
  if (!picked.length) fail(400, 'Choose at least one product and how many are coming back.');
  const amount = picked.reduce((a, p) => a + p.qty * p.unit_price, 0), ref = 'WR-' + crypto.randomBytes(4).toString('hex').toUpperCase(), t = now();
  let id;
  try { id = Number((await get('INSERT INTO wholesale_returns (ref,quote_id,account_id,reason,details,items,requested_amount,opened_by,opened_by_user,opened_by_name,open_note,past_window,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id', ref, q.id, q.account_id, reason, details, JSON.stringify(picked), amount, by ? 'staff' : 'buyer', by ? by.id : null, by ? who(by) : '', by ? str(b.note, 500).trim() : '', by && el.past_window ? 1 : 0, t, t)).id); }
  catch (e) { if (/idx_wholesale_returns_one_open|duplicate/.test(e.message)) fail(400, 'A return is already open for this order.'); throw e; }
  const a = await acct(q.account_id);
  await event(q.id, q.status, `Return ${ref} ${by ? 'opened by our team for the buyer' : 'requested by the buyer'}: ${picked.map((p) => p.qty + ' × ' + p.name).join(', ')} (${naira(amount)}).`, by ? who(by) : (a.business_name || 'buyer'));
  N().toStaff('orders', true, { type: 'return', title: `Wholesale return ${ref} to review`, body: `${a.business_name}: ${picked.length} product${picked.length === 1 ? '' : 's'}, ${naira(amount)}. ${REASONS[reason]}.`, link: '/admin#/returns' }).catch(() => {});
  await mailBuyer(a, `Return ${ref} received`, `<p>${by ? 'Our team opened' : 'We have'} your return request <b>${S.esc(ref)}</b> for order <b>${S.esc(q.order_no || q.ref)}</b>${by ? ' on your behalf' : ''}. We will review it and email you the decision.</p>`);
  return { id, ref };
}

const shape = (r, extra = {}) => ({
  id: Number(r.id), ref: r.ref, quote_ref: r.quote_ref, order_no: r.order_no || '', business: r.business_name || '', status: r.status, status_text: WORDS[r.status], reason: REASONS[r.reason] || r.reason, details: r.details, items: r.items, requested_amount: Number(r.requested_amount),
  recommended_amount: r.recommended_amount == null ? null : Number(r.recommended_amount), recommended_note: r.recommended_note || '', recommended_by: r.recommended_by_name || '',
  approved_amount: r.approved_amount == null ? null : Number(r.approved_amount), decision_note: r.decision_note || '', decided_by: r.decided_by_name || '', approval: r.approval || '',
  opened_by: r.opened_by, opened_by_name: r.opened_by_name || '', open_note: r.open_note || '', past_window: !!Number(r.past_window || 0),
  settle_method: r.settle_method || '', settle_reference: r.settle_reference || '', gateway_ref: r.gateway_ref || '', gateway_status: r.gateway_status || '', auto_settle: r.auto_settle || '', last_error: r.last_error || '', restocked: !!Number(r.restocked || 0),
  settled_by: r.settled_by_name || '', settled_at: r.settled_at ? Number(r.settled_at) : null, created: Number(r.created), ...extra,
});
const COLS = 'r.*, q.ref AS quote_ref, q.order_no, a.business_name';
const FROM = 'FROM wholesale_returns r JOIN wholesale_quotes q ON q.id=r.quote_id JOIN wholesale_accounts a ON a.id=r.account_id';
async function list(q = {}) {
  const st = str(q.status, 30), rows = await all(`SELECT ${COLS} ${FROM} ${st ? 'WHERE r.status=?' : ''} ORDER BY CASE WHEN r.status IN ('requested','recommended') THEN 0 WHEN r.status IN ('awaiting_settlement','settling') THEN 1 ELSE 2 END, r.id DESC LIMIT 200`, ...(st ? [st] : []));
  return { returns: rows.map((r) => shape(parse(r))) };
}
async function load(id) { const r = await get(`SELECT ${COLS} ${FROM} WHERE r.id=?`, id); if (!r) fail(404, 'Return not found.'); return parse(r); }
async function plan(r, q) {
  const auto = q.payment_method === 'paystack' && !!q.payment_ref && !String(q.payment_ref).startsWith('DEMO-') && S.paystackLive();
  return { can_auto: auto, bank: q.payment_method === 'transfer' || q.payment_method === 'bank', payment_method: q.payment_method };
}
async function detail(id) {
  const r = await load(id), q = await get('SELECT * FROM wholesale_quotes WHERE id=?', r.quote_id), cap = Number(q.goods_total) - await goodsBack(r.quote_id, r.id);
  return { return: shape(r), max_refund: Math.max(0, cap), plan: await plan(r, q), quote: { ref: q.ref, order_no: q.order_no || '', goods_total: Number(q.goods_total), total: Number(q.total), payment_method: q.payment_method, delivered_at: q.delivered_at ? Number(q.delivered_at) : null } };
}
async function forBuyer(account, quoteRef) {
  const q = await get('SELECT * FROM wholesale_quotes WHERE ref=? AND account_id=?', str(quoteRef, 20).toUpperCase(), account.id); if (!q) fail(404, 'Quote not found.');
  const el = await eligibility(q), rows = await all(`SELECT ${COLS} ${FROM} WHERE r.quote_id=? ORDER BY r.id DESC`, q.id);
  return { can: el.can, reason: el.reason, days: el.days, deadline: el.deadline, lines: el.lines, reasons: REASONS,
    returns: rows.map((x) => { const s = shape(parse(x)); const open = x.status === 'recommended'; return { ref: s.ref, status: open ? 'requested' : s.status, status_text: open ? WORDS.requested : s.status_text, reason: s.reason, items: s.items, requested_amount: s.requested_amount, approved_amount: ['awaiting_settlement', 'settling', 'settled'].includes(x.status) ? s.approved_amount : null, decision_note: s.status === 'rejected' ? s.decision_note : '', can_cancel: x.status === 'requested', created: s.created }; }) };
}
async function cancel(account, ref) {
  const r = await get('SELECT r.* FROM wholesale_returns r WHERE r.ref=? AND r.account_id=?', str(ref, 20).toUpperCase(), account.id); if (!r) fail(404, 'Return not found.');
  const c = await run("UPDATE wholesale_returns SET status='cancelled', updated=? WHERE id=? AND status='requested'", now(), r.id);
  if (!c.changes) fail(409, 'This return is already being handled, so it can no longer be cancelled. Please contact us.');
  await event(r.quote_id, 'delivered', `Return ${r.ref} cancelled by the buyer.`, account.business_name || 'buyer');
}

// Reviewer recommends; the owner approves. Approval refunds automatically when the payment allows it.
async function approve(id, actor, b) {
  const d = await detail(id), r = d.return;
  if (!['requested', 'recommended'].includes(r.status)) fail(409, 'This return was already reviewed.');
  const owner = isOwner(actor), note = str(b.note, 500).trim(), base = owner && r.recommended_amount != null ? r.recommended_amount : r.requested_amount, amount = int(b.amount === undefined ? base : b.amount);
  if (!(amount >= 1) || amount > d.max_refund) fail(400, `The refund must be between ₦1 and ${naira(d.max_refund)} (the goods value left on this order).`);
  if (amount !== r.requested_amount && amount !== r.recommended_amount && note.length < 5) fail(400, 'You changed the amount. Please add a short note saying why.');
  const row = await load(id), a = await acct(row.account_id), q = await get('SELECT * FROM wholesale_quotes WHERE id=?', row.quote_id), t = now();
  if (!owner) {
    if (r.status !== 'requested') fail(409, 'This return is already waiting for the owner.');
    const c = await run("UPDATE wholesale_returns SET status='recommended', recommended_amount=?, recommended_note=?, recommended_by=?, recommended_by_name=?, recommended_at=?, updated=? WHERE id=? AND status='requested'", amount, note, actor.id, who(actor), t, t, id);
    if (!c.changes) fail(409, 'This return was already reviewed.');
    await event(q.id, q.status, `Return ${r.ref} reviewed by our team and sent for final approval.`, who(actor));
    N().notify(await all("SELECT id FROM users WHERE role='admin' AND active<>0"), { type: 'return', title: `Wholesale return needs your approval: ${row.business_name}`, body: `${who(actor)} recommends refunding ${naira(amount)} for ${r.ref}.${note ? ' Note: ' + note : ''}`, link: '/admin#/returns', email: true }).catch(() => {});
    return { stage: 'recommended' };
  }
  const c = await run("UPDATE wholesale_returns SET status='awaiting_settlement', approved_amount=?, decision_note=?, decided_by=?, decided_by_name=?, decided_at=?, approval='owner', updated=? WHERE id=? AND status IN ('requested','recommended')", amount, note || row.recommended_note || '', actor.id, who(actor), t, t, id);
  if (!c.changes) fail(409, 'This return was already reviewed.');
  await event(q.id, q.status, `Return ${r.ref} approved: ${naira(amount)} refund.`, who(actor));
  N().toAccount(q.account_id, { type: 'order', title: `Return ${r.ref} approved`, body: `Your refund of ${naira(amount)} is on its way.`, link: '/wholesale' }).catch(() => {});
  await mailBuyer(a, `Your return ${r.ref} was approved`, `<p>Your return <b>${S.esc(r.ref)}</b> for order <b>${S.esc(q.order_no || q.ref)}</b> was approved. A refund of <b>${naira(amount)}</b> is being processed and we will email you when it has been sent.</p>${note || row.recommended_note ? `<p>Note from our team: ${S.esc(note || row.recommended_note)}</p>` : ''}`);
  const res = { stage: 'approved', auto: null }, P = await plan(row, q), autoOn = String((await S.getSettings()).return_auto_refund) !== '0';
  if (autoOn && P.can_auto) {
    try { await settle(id, actor, { method: 'original' }); await run("UPDATE wholesale_returns SET auto_settle='done' WHERE id=?", id); res.auto = { ok: true }; }
    catch (e) { await run("UPDATE wholesale_returns SET auto_settle='failed' WHERE id=?", id); res.auto = { ok: false, error: e.message }; N().toStaff('finance', true, { type: 'return', title: `Automatic wholesale refund did not go through: ${r.ref}`, body: `${e.message} It is approved and waiting; open it to retry or pay by hand.`, link: '/admin#/returns', email: true }).catch(() => {}); }
  } else {
    await run("UPDATE wholesale_returns SET auto_settle='manual_needed' WHERE id=?", id); res.auto = { ok: false, manual: true };
    N().toStaff('finance', true, { type: 'return', title: `Wholesale refund awaiting payment: ${r.ref}`, body: `${naira(amount)} to ${row.business_name} is approved. Pay it by bank transfer and record the reference.`, link: '/admin#/returns' }).catch(() => {});
  }
  return res;
}
async function reject(id, actor, b) {
  const r = await load(id), note = str(b.note, 500).trim(); if (note.length < 5) fail(400, 'Please tell the buyer why the return is declined.');
  if (r.status === 'recommended' && !isOwner(actor)) fail(403, 'This return is waiting for the owner, who makes the final decision.');
  const c = await run("UPDATE wholesale_returns SET status='rejected', decision_note=?, decided_by=?, decided_by_name=?, decided_at=?, updated=? WHERE id=? AND status IN ('requested','recommended')", note, actor.id, who(actor), now(), now(), id);
  if (!c.changes) fail(409, 'This return was already reviewed.');
  const a = await acct(r.account_id); await event(r.quote_id, 'delivered', `Return ${r.ref} declined: ${note}`, who(actor));
  await mailBuyer(a, `Your return ${r.ref} was not approved`, `<p>We could not approve return <b>${S.esc(r.ref)}</b>.</p><p>${S.esc(note)}</p><p>Please contact us if you would like to talk it through.</p>`);
}
async function settle(id, actor, b) {
  const method = b.method === 'manual' ? 'manual' : 'original', reference = str(b.reference, 120).trim(), restock = !!b.restock, r0 = await get('SELECT * FROM wholesale_returns WHERE id=?', id);
  if (!r0) fail(404, 'Return not found.');
  if (r0.status === 'settled') fail(409, 'This refund was already settled.');
  if (r0.status === 'requested') fail(409, 'Review and approve the return first.');
  if (r0.status === 'recommended') fail(409, 'This return is waiting for the owner\'s approval.');
  if (!['awaiting_settlement', 'settling'].includes(r0.status)) fail(409, 'This return is not waiting for settlement.');
  if (method === 'manual' && reference.length < 3) fail(400, 'Enter the bank transfer reference of the refund you paid.');
  const q = await get('SELECT * FROM wholesale_quotes WHERE id=?', r0.quote_id), r = parse(r0), P = await plan(r, q);
  if (method === 'original' && !P.can_auto) fail(400, P.bank ? 'This order was paid by bank transfer, so there is no card to refund. Pay the buyer by transfer, then choose "Paid manually" and enter the reference.' : 'This payment cannot be refunded automatically. Refund it yourself, then choose "Paid manually".');
  const t = now();
  const claim = await run("UPDATE wholesale_returns SET status='settling', settling_at=?, last_error='', updated=? WHERE id=? AND (status='awaiting_settlement' OR (status='settling' AND settling_at < ?))", t, t, id, t - 600);
  if (!claim.changes) fail(409, 'Someone else is settling this refund right now.');
  let gw = { id: r0.gateway_ref || '', status: r0.gateway_status || '' };
  try {
    if (method === 'manual') gw = { id: reference, status: 'paid by hand' };
    else if (!gw.id) gw = await S.paystackRefund({ ref: q.ref, paystack_ref: q.payment_ref, currency: 'NGN' }, Number(r.approved_amount) * 100, `Refund for returned goods, order ${q.order_no || q.ref}`);
  } catch (e) { await run("UPDATE wholesale_returns SET status='awaiting_settlement', last_error=?, settling_at=NULL, updated=? WHERE id=?", str(e.message, 300), now(), id); throw e; }
  let putBack = 0;
  if (restock) { try { await require('./warehouse').receive(r.items.map((i) => ({ productId: i.product_id, qty: i.qty })), { reference: r.ref, note: `Returned by the buyer, ${r.ref}`, by: who(actor), userId: actor.id || null, key: 'wr-restock-' + id }); putBack = 1; } catch (e) { console.error('Wholesale restock failed:', e.message); } }
  const c = await run("UPDATE wholesale_returns SET status='settled', settle_method=?, settle_reference=?, gateway_ref=?, gateway_status=?, restocked=?, settled_by_name=?, settled_at=?, updated=? WHERE id=? AND status='settling'", method, method === 'manual' ? reference : '', gw.id, gw.status, putBack, who(actor), now(), now(), id);
  if (!c.changes) fail(409, 'This refund changed while it was being settled. Please open it again.');
  const a = await acct(r.account_id), how = method === 'manual' ? `by bank transfer (ref ${reference})` : 'to the card or bank account used to pay through Paystack';
  await event(r.quote_id, 'delivered', `Return ${r.ref} settled: ${naira(r.approved_amount)} refunded ${how}${putBack ? '; goods put back in stock' : ''}.`, who(actor));
  N().toAccount(r.account_id, { type: 'order', title: `Refund sent for return ${r.ref}`, body: `${naira(r.approved_amount)} was refunded.`, link: '/wholesale' }).catch(() => {});
  await mailBuyer(a, `Your refund for return ${r.ref}`, `<p>Your refund of <b>${naira(r.approved_amount)}</b> for order <b>${S.esc(q.order_no || q.ref)}</b> has been sent ${S.esc(how)}.</p>`);
  return { ok: true, gateway_status: gw.status, restocked: !!putBack };
}
async function summary() {
  const c = await get("SELECT COUNT(*) FILTER (WHERE status='requested')::int requested, COUNT(*) FILTER (WHERE status='recommended')::int recommended, COUNT(*) FILTER (WHERE status IN ('awaiting_settlement','settling'))::int awaiting FROM wholesale_returns");
  return c;
}
module.exports = { REASONS, eligibility, request, list, detail, forBuyer, cancel, approve, reject, settle, summary };
