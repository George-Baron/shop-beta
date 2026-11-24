'use strict';
// Returns after delivery. The customer asks (a few questions), staff review and approve, the approved refund waits for settlement,
// and settlement sends the money back to where it came from (the gateway refund for the card share, the VELTO wallet for the wallet share).
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const { fail, str, int } = S;

const OPEN = ['requested', 'recommended', 'awaiting_settlement', 'settling'];
const REASONS = { faulty: 'Faulty or damaged', wrong_item: 'Wrong item sent', not_as_described: 'Not as described', missing_parts: 'Missing parts or items', changed_mind: 'Changed my mind', other: 'Something else' };
const SELLER_FAULT = ['faulty', 'wrong_item', 'not_as_described', 'missing_parts'];
const CONDITIONS = { unopened: 'Unopened', opened_unused: 'Opened but unused', used: 'Used', damaged: 'Damaged' };
const STATUS_WORDS = { requested: 'Waiting for review', recommended: 'Reviewed, waiting for the owner to approve', awaiting_settlement: 'Approved, refund awaiting settlement', settling: 'Refund being sent', settled: 'Refunded', rejected: 'Not approved', cancelled: 'Cancelled by you' };
const DAY = 86400;
const parse = (r) => { let items = []; try { items = JSON.parse(r.items || '[]'); } catch { /* */ } return { ...r, items }; };
const naira = (k) => '₦' + (Number(k) / 100).toLocaleString('en-NG');

// ---------- rules ----------
async function deliveredAt(o) {
  if (o.delivered_at) return Number(o.delivered_at);
  const e = await get("SELECT created FROM order_events WHERE order_id=? AND status='delivered' ORDER BY id DESC LIMIT 1", o.id);
  return e ? Number(e.created) : 0;
}
// What is returnable on this order now: the quantity left on each line, and whether the customer can ask at all (and if not, why).
async function eligibility(o, opts = {}) {
  const out = { can: false, reason: '', days: 0, deadline: null, lines: [] };
  if (o.status !== 'delivered') return out;                       // nothing to say before delivery
  if (o.payment_status !== 'paid') { out.reason = 'This order was not paid, so there is nothing to refund.'; return out; }
  if (o.is_pharmacy) { out.reason = 'Medicines are returned through our pharmacy team. Please contact us with your order number.'; return out; }
  const days = Number((await S.getSettings()).return_days || 7) || 7, at = await deliveredAt(o);
  out.days = days; out.deadline = at ? at + days * DAY : null;
  if (out.deadline && now() > out.deadline) { out.past_window = true; if (!opts.staff) { out.reason = `The ${days}-day return window for this order has closed.`; return out; } else out.reason = ''; }
  const prior = (await all("SELECT status, items FROM order_returns WHERE order_id=? AND status IN ('requested','recommended','awaiting_settlement','settling','settled')", o.id)).map(parse);
  const taken = {}; for (const r of prior) for (const i of r.items) taken[i.item_id] = (taken[i.item_id] || 0) + Number(i.qty);
  const items = o.items || await all('SELECT * FROM order_items WHERE order_id=?', o.id);
  out.lines = items.map((i) => ({ item_id: Number(i.id), name: i.name + (i.variant_label ? ` (${i.variant_label})` : ''), price: Number(i.price), qty: Number(i.qty) - (taken[i.id] || 0), image: i.image || '', emoji: i.emoji || '' })).filter((l) => l.qty > 0);
  if (prior.some((r) => OPEN.includes(r.status))) { out.reason = 'You already have a return open for this order.'; out.open = true; return out; }
  if (!out.lines.length) { out.reason = 'Every item on this order has already been returned.'; return out; }
  out.can = true; return out;
}
// What the chosen items are worth after the order's own discounts; plus the delivery fee when we got it wrong and the whole order comes back.
function valueOf(o, picked, reason, wholeOrder) {
  const sub = Number(o.subtotal) || 1, off = Math.min(sub, Number(o.discount || 0) + Number(o.points_discount || 0)), f = (sub - off) / sub;
  let v = Math.round(picked.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0) * f);
  if (wholeOrder && SELLER_FAULT.includes(reason)) v += Number(o.delivery_fee || 0);
  return Math.max(0, Math.min(v, Number(o.total)));
}
async function refundedSoFar(orderId, exceptId = 0) {
  const r = await get("SELECT COALESCE(SUM(approved_amount),0) n FROM order_returns WHERE order_id=? AND status='settled' AND id<>?", orderId, exceptId);
  return Number(r.n);
}

// ---------- customer ----------
async function request(o, b, by) {
  const el = await eligibility(o, { staff: !!by });
  if (!el.can) fail(400, el.reason || 'This order cannot be returned.');
  const reason = str(b.reason, 30), cond = str(b.condition, 30), pack = b.packaging === 'original' ? 'original' : b.packaging === 'no' ? 'no' : '', details = str(b.details, 1000).trim();
  if (!REASONS[reason]) fail(400, 'Tell us why you are returning it.');
  if (!CONDITIONS[cond]) fail(400, 'Tell us what condition the items are in.');
  if (!pack) fail(400, 'Tell us whether you still have the original packaging.');
  if ((reason === 'other' || SELLER_FAULT.includes(reason)) && details.length < 10) fail(400, 'Please describe the problem in a sentence or two so we can review it quickly.');
  const want = Array.isArray(b.items) ? b.items : [];
  const picked = [];
  for (const w of want) {
    const l = el.lines.find((x) => x.item_id === int(w.item_id)); const q = int(w.qty);
    if (!l || !(q >= 1)) continue;
    if (q > l.qty) fail(400, `You can return at most ${l.qty} of "${l.name}".`);
    if (picked.some((p) => p.item_id === l.item_id)) fail(400, 'Each item can only be listed once.');
    picked.push({ item_id: l.item_id, name: l.name, qty: q, price: l.price });
  }
  if (!picked.length) fail(400, 'Choose at least one item to return.');
  const whole = el.lines.every((l) => { const p = picked.find((x) => x.item_id === l.item_id); return p && p.qty === l.qty; }) && (await all("SELECT 1 FROM order_returns WHERE order_id=? AND status='settled'", o.id)).length === 0;
  const amount = valueOf(o, picked, reason, whole), t = now();
  const ref = 'RET-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
  let id;
  try { id = Number((await get('INSERT INTO order_returns (ref,order_id,user_id,reason,item_condition,packaging,details,items,requested_amount,created,updated,opened_by,opened_by_user,opened_by_name,open_note,past_window) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id', ref, o.id, o.user_id, reason, cond, pack, details, JSON.stringify(picked), amount, t, t, by ? 'staff' : 'customer', by ? by.id : null, by ? str(by.name || by.email, 80) : '', by ? str(b.note, 500).trim() : '', by && el.past_window ? 1 : 0)).id); }
  catch (e) { if (/idx_order_returns_one_open|duplicate/.test(e.message)) fail(400, 'You already have a return open for this order.'); throw e; }
  await S.addEvent(o.id, 'return', `Return ${ref} ${by ? 'opened by our team for the customer' : 'requested'}: ${picked.map((p) => p.qty + ' × ' + p.name).join(', ')}. We will review it and reply by email.`);
  require('./notify').toStaff('orders', true, { type: 'return', title: `Order ${o.ref} is to be returned`, body: `${by ? (by.name || 'A team member') + ' opened a return for ' + o.name : o.name + ' asked to return'} ${picked.length} item${picked.length === 1 ? '' : 's'} (${REASONS[reason]}). Review it, then approve or decline.`, link: '/admin#/returns', email: true }).catch(() => {});
  mailCustomer(o, `We received your return request ${ref}`, `<p>${by ? 'Our team opened' : 'We have'} your return request <b>${S.esc(ref)}</b> for order <b>${S.esc(o.ref)}</b>${by ? ' on your behalf' : ''}. Our team will review it and email you the decision. You do not need to send anything yet.</p>`);
  await maybeAutoApprove(id, amount);
  return { id, ref };
}
async function cancel(o, rid) {
  const r = await get('SELECT * FROM order_returns WHERE id=? AND order_id=?', rid, o.id);
  if (!r) fail(404, 'Return not found.');
  const c = await run("UPDATE order_returns SET status='cancelled', updated=? WHERE id=? AND status='requested'", now(), r.id);
  if (!c.changes) fail(409, 'This return has already been reviewed, so it can no longer be cancelled here. Contact us if you changed your mind.');
  await S.addEvent(o.id, 'return', `Return ${r.ref} was cancelled by the customer.`);
}
// ---------- photos (evidence the customer attaches to a request) ----------
const MAX_PHOTOS = 5, MAX_PHOTO = 4_000_000;
const KINDS = [
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];
async function addPhoto(o, rid, b) {
  const r = await get('SELECT * FROM order_returns WHERE id=? AND order_id=?', rid, o.id);
  if (!r) fail(404, 'Return not found.');
  if (r.status !== 'requested') fail(409, 'Photos can only be added while the request is waiting for review.');
  if ((await get('SELECT COUNT(*)::int n FROM order_return_photos WHERE return_id=?', r.id)).n >= MAX_PHOTOS) fail(400, `Up to ${MAX_PHOTOS} photos per return.`);
  const m = /^data:[^;]*;base64,(.*)$/s.exec(String(b.data || '')), buf = Buffer.from(m ? m[1] : String(b.data || ''), 'base64');
  if (!buf.length) fail(400, 'That photo is empty.');
  if (buf.length > MAX_PHOTO) fail(400, 'That photo is over 4 MB. Please choose a smaller one.');
  const kind = KINDS.find((k) => k.test(buf)); if (!kind) fail(400, 'Please attach a PNG, JPG or WEBP photo.');
  const stored = require('crypto').randomBytes(16).toString('hex') + '.' + kind.ext;
  try { await require('./storage').returnDocs.put(stored, buf); } catch (e) { console.error(e.message); fail(503, 'Photo storage is not available right now. You can still send the request without photos, or email them to us.'); }
  const id = Number((await get('INSERT INTO order_return_photos (return_id,stored,mime,size,created) VALUES (?,?,?,?,?) RETURNING id', r.id, stored, kind.mime, buf.length, now())).id);
  return { id };
}
async function readPhoto(returnId, photoId, orderId) {
  const p = await get('SELECT p.* FROM order_return_photos p JOIN order_returns r ON r.id=p.return_id WHERE p.id=? AND p.return_id=?' + (orderId ? ' AND r.order_id=?' : ''), ...[photoId, returnId].concat(orderId ? [orderId] : []));
  if (!p) fail(404, 'Photo not found.');
  return { mime: p.mime, buf: await require('./storage').returnDocs.get(p.stored) };
}
async function removePhoto(o, rid, photoId) {
  const r = await get('SELECT * FROM order_returns WHERE id=? AND order_id=?', rid, o.id); if (!r) fail(404, 'Return not found.');
  if (r.status !== 'requested') fail(409, 'This return has already been reviewed.');
  const p = await get('SELECT * FROM order_return_photos WHERE id=? AND return_id=?', photoId, r.id); if (!p) fail(404, 'Photo not found.');
  await run('DELETE FROM order_return_photos WHERE id=?', p.id);
  require('./storage').returnDocs.remove(p.stored).catch(() => {});
}
const photoIds = async (rid) => (await all('SELECT id FROM order_return_photos WHERE return_id=? ORDER BY id', rid)).map((x) => Number(x.id));

// The returns on an order as the customer sees them (no staff names, no gateway details).
async function forCustomer(o) {
  const rows = (await all('SELECT * FROM order_returns WHERE order_id=? ORDER BY id DESC', o.id)).map(parse);
  const out = rows.map((r) => ({
    id: Number(r.id), ref: r.ref, status: r.status === 'recommended' ? 'requested' : r.status, status_text: r.status === 'recommended' ? STATUS_WORDS.requested : STATUS_WORDS[r.status], reason: REASONS[r.reason] || r.reason, items: r.items.map((i) => ({ name: i.name, qty: i.qty })),
    requested_amount: r.requested_amount, approved_amount: r.approved_amount, note: r.status === 'rejected' || r.status === 'awaiting_settlement' || r.status === 'settled' ? r.decision_note : '',
    refunded_to: r.status === 'settled' ? refundWords(r) : '', created: Number(r.created), settled_at: r.settled_at ? Number(r.settled_at) : null, can_cancel: r.status === 'requested',
  }));
  for (const x of out) x.photos = await photoIds(x.id);
  return out;
}
function refundWords(r) {
  const parts = [];
  if (Number(r.wallet_refunded)) parts.push(`${naira(r.wallet_refunded)} to your VELTO wallet`);
  if (Number(r.gateway_refunded)) parts.push(r.settle_method === 'manual' ? `${naira(r.gateway_refunded)} paid to you directly` : `${naira(r.gateway_refunded)} back to the card or account you paid with (your bank can take a few working days to show it)`);
  return parts.join(' and ');
}
function mailCustomer(o, subject, html) {
  (async () => { const set = await S.getSettings(); await S.queueMail(o.email, subject, S.mailWrap(set, html)); })().catch((e) => console.error('Return email failed:', e.message));
}
function tellPartners(r, o, charged) {
  (async () => {
    for (const v of vendorShares(r, o)) {
      const us = (await all("SELECT id FROM users WHERE vendor_id=? AND role='vendor'", v.vendor_id)).map((u) => Number(u.id)); if (!us.length) continue;
      await require('./notify').notify(us, { type: 'return', title: `Return on order ${o.ref}`, body: charged ? `A customer returned your item(s) and was refunded. ₦${v.amount.toLocaleString('en-NG')} was taken off your balance. See Earnings.` : 'A customer returned your item(s) and was refunded. This one was covered by us, so your balance is unchanged.', link: '/partner#/earnings' });
    }
  })().catch((e) => console.error('Partner return notice failed:', e.message));
}
const tellCustomer = (o, title, body) => { if (o.user_id) require('./notify').notify([o.user_id], { type: 'return', title, body, link: `/order/${o.ref}` }).catch(() => {}); };

// ---------- partner share ----------
// What a partner store loses when these items come back: the line's value after our commission, scaled down if staff approved less than the customer asked for.
function vendorShares(r, o) {
  const ratio = Number(r.requested_amount) > 0 ? Math.min(1, Number(r.approved_amount || r.requested_amount) / Number(r.requested_amount)) : 1, by = {};
  for (const i of r.items) {
    const oi = o.items.find((x) => Number(x.id) === Number(i.item_id)); if (!oi || !oi.vendor_id) continue;
    const q = Number(i.qty), net = Number(oi.price) * q - Math.round(Number(oi.commission || 0) * q / Math.max(1, Number(oi.qty)));
    const v = by[oi.vendor_id] || (by[oi.vendor_id] = { vendor_id: Number(oi.vendor_id), name: oi.vendor_name || '', amount: 0 });
    v.amount += net;
  }
  return Object.values(by).map((v) => ({ ...v, amount: Math.max(0, Math.round(v.amount * ratio)) })).filter((v) => v.amount > 0);
}

// ---------- staff ----------
const LISTCOLS = `r.*, o.ref AS order_ref, o.name AS customer, o.email, o.payment_method, o.total AS order_total`;
async function list(q = {}) {
  const w = [], a = [];
  if (q.status && (OPEN.concat(['settled', 'rejected', 'cancelled'])).includes(q.status)) { w.push('r.status=?'); a.push(q.status); }
  if (q.q) { const t = '%' + String(q.q).toLowerCase().replace(/[\\%_]/g, '').slice(0, 60) + '%'; w.push('(lower(o.ref) LIKE ? OR lower(r.ref) LIKE ? OR lower(o.name) LIKE ? OR lower(o.email) LIKE ?)'); a.push(t, t, t, t); }
  const rows = (await all(`SELECT ${LISTCOLS} FROM order_returns r JOIN orders o ON o.id=r.order_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY CASE r.status WHEN 'requested' THEN 0 WHEN 'recommended' THEN 0 WHEN 'awaiting_settlement' THEN 1 WHEN 'settling' THEN 1 ELSE 2 END, r.id DESC LIMIT 300`, ...a)).map(parse);
  const counts = {}; for (const c of await all('SELECT status, COUNT(*)::int n FROM order_returns GROUP BY status')) counts[c.status] = c.n;
  return { returns: rows.map(shape), counts, labels: STATUS_WORDS };
}
const shape = (r) => ({ id: Number(r.id), ref: r.ref, order_ref: r.order_ref, customer: r.customer, email: r.email, status: r.status, status_text: STATUS_WORDS[r.status], opened_by: r.opened_by || 'customer', opened_by_name: r.opened_by_name || '', open_note: r.open_note || '', past_window: !!Number(r.past_window || 0), recommended_amount: r.recommended_amount == null ? null : Number(r.recommended_amount), recommended_note: r.recommended_note || '', recommended_by: r.recommended_by_name || '', approval: r.approval || '', auto_settle: r.auto_settle || '', reason: REASONS[r.reason] || r.reason, items: r.items, requested_amount: r.requested_amount, approved_amount: r.approved_amount, created: Number(r.created), payment_method: r.payment_method });
// How an approved refund will be split between the VELTO wallet and the card/bank.
async function plan(r, o) {
  const A = Number(r.approved_amount || r.requested_amount) * 100, totalK = Number(o.total) * 100, walletTotal = Number(o.wallet_amount || 0);
  const prior = await get("SELECT COALESCE(SUM(wallet_refunded),0) w FROM order_returns WHERE order_id=? AND status='settled' AND id<>?", o.id, r.id);
  const walletPart = o.user_id ? Math.max(0, Math.min(Math.round(A * walletTotal / Math.max(1, totalK)), walletTotal - Number(prior.w))) : 0;
  return { amount: A, wallet: walletPart, card: A - walletPart, cash_order: o.payment_method === 'pod', gateway: o.gateway || 'paystack', can_auto: o.payment_method === 'paystack' && (o.gateway || 'paystack') === 'paystack' && !!o.paystack_ref && S.paystackLive(), has_wallet: !!o.user_id };
}
async function detail(id) {
  const r0 = await get('SELECT * FROM order_returns WHERE id=?', id); if (!r0) fail(404, 'Return not found.');
  const r = parse(r0), o = await S.loadOrder('id=?', r.order_id);
  const cap = Number(o.total) - await refundedSoFar(o.id, r.id);
  return { return: { ...shape({ ...r, order_ref: o.ref, customer: o.name, email: o.email, payment_method: o.payment_method }), packaging: r.packaging, condition: CONDITIONS[r.item_condition] || r.item_condition, details: r.details, decision_note: r.decision_note, decided_by: r.decided_by_name, decided_at: r.decided_at && Number(r.decided_at), settle_method: r.settle_method, settle_reference: r.settle_reference, wallet_refunded: Number(r.wallet_refunded), gateway_refunded: Number(r.gateway_refunded), gateway_status: r.gateway_status, gateway_ref: r.gateway_ref, restocked: !!r.restocked, settled_by: r.settled_by_name, settled_at: r.settled_at && Number(r.settled_at), last_error: r.last_error },
    order: { ref: o.ref, status: o.status, total: o.total, subtotal: o.subtotal, delivery_fee: o.delivery_fee, payment_method: o.payment_method, wallet_amount: Number(o.wallet_amount || 0), phone: o.phone, delivered_at: await deliveredAt(o) || null }, photos: await photoIds(r.id), vendor_shares: vendorShares(r, o), charge_vendor: !!Number(r.charge_vendor), max_refund: Math.max(0, cap), plan: ['awaiting_settlement', 'requested', 'recommended'].includes(r.status) ? await plan(r, o) : null };
}
// Two-step approval. A reviewer (the Operations Manager, or anyone with Orders: Edit) RECOMMENDS: the request moves to "recommended" and the owner is told.
// The owner (or the small-amount rule, when switched on) APPROVES: the refund is then sent automatically where the payment allows it.
const isOwner = (actor) => !!actor && (actor.role === 'admin' || actor.system === true);
const who = (actor) => str(actor.name || actor.email || 'Staff', 80);
async function approve(id, actor, b) {
  const d = await detail(id), r = d.return;
  if (!['requested', 'recommended'].includes(r.status)) fail(409, 'This return was already reviewed.');
  const owner = isOwner(actor), note = str(b.note, 500).trim();
  const base = owner && r.recommended_amount != null ? r.recommended_amount : r.requested_amount;
  const amount = int(b.amount === undefined ? base : b.amount);
  if (!(amount >= 1) || amount > d.max_refund) fail(400, `The refund must be between ₦1 and ₦${d.max_refund.toLocaleString('en-NG')} (what is left on this order).`);
  if (amount !== r.requested_amount && amount !== r.recommended_amount && note.length < 5) fail(400, 'You changed the amount. Please add a short note saying why, so the customer understands.');
  const o = await S.loadOrder('id=?', (await get('SELECT order_id FROM order_returns WHERE id=?', id)).order_id), t = now();
  if (!owner) {
    if (r.status !== 'requested') fail(409, 'This return is already waiting for the owner.');
    const c = await run("UPDATE order_returns SET status='recommended', recommended_amount=?, recommended_note=?, recommended_by=?, recommended_by_name=?, recommended_at=?, updated=? WHERE id=? AND status='requested'", amount, note, actor.id, who(actor), t, t, id);
    if (!c.changes) fail(409, 'This return was already reviewed.');
    await S.addEvent(o.id, 'return', `Return ${r.ref} reviewed by our team and sent for final approval.`, { internal: true });
    const adm = await all("SELECT id FROM users WHERE role='admin' AND active<>0");
    require('./notify').notify(adm, { type: 'return', title: `Return needs your approval: order ${o.ref}`, body: `${who(actor)} recommends refunding ₦${amount.toLocaleString('en-NG')} for return ${r.ref}. Approve it and the refund is sent automatically.${note ? ' Note: ' + note : ''}`, link: '/admin#/returns', email: true }).catch(() => {});
    return { stage: 'recommended' };
  }
  const how = actor.system ? 'auto' : 'owner';
  const c = await run("UPDATE order_returns SET status='awaiting_settlement', approved_amount=?, decision_note=?, decided_by=?, decided_by_name=?, decided_at=?, approval=?, updated=? WHERE id=? AND status IN ('requested','recommended')", amount, note || (r.recommended_note || ''), actor.id || null, actor.system ? 'Auto-approval (small amount)' : who(actor), t, how, t, id);
  if (!c.changes) fail(409, 'This return was already reviewed.');
  await S.addEvent(o.id, 'return', `Return ${r.ref} approved: ₦${amount.toLocaleString('en-NG')} refund.`);
  const shownNote = note || r.recommended_note || '';
  tellCustomer(o, `Return ${r.ref} approved`, `Your return for order ${o.ref} was approved. Your refund of ₦${amount.toLocaleString('en-NG')} is on its way.`);
  mailCustomer(o, `Your return ${r.ref} was approved`, `<p>Good news: your return <b>${S.esc(r.ref)}</b> for order <b>${S.esc(o.ref)}</b> was approved.</p><p>Your refund of <b>₦${amount.toLocaleString('en-NG')}</b> is being processed. We will email you again when it has been sent.</p>${shownNote ? `<p>Note from our team: ${S.esc(shownNote)}</p>` : ''}`);
  const res = { stage: 'approved', auto: null };
  // refund automatically when the payment can be sent back by itself (Paystack card share and/or wallet share); otherwise finance settles it by hand
  const P = await plan({ ...r, approved_amount: amount }, o);
  const autoOn = String((await S.getSettings()).return_auto_refund) !== '0';   // the owner can switch automatic sending off: approval then only queues the refund for Finance
  if (autoOn && (P.can_auto || (P.card === 0 && P.has_wallet))) {
    try { await settle(id, actor.system ? { id: null, name: 'Auto-approval' } : actor, { method: 'original' }); await run("UPDATE order_returns SET auto_settle='done' WHERE id=?", id); res.auto = { ok: true }; }
    catch (e) {
      await run("UPDATE order_returns SET auto_settle='failed' WHERE id=?", id); res.auto = { ok: false, error: e.message };
      require('./notify').toStaff('finance', true, { type: 'return', title: `Automatic refund did not go through: order ${o.ref}`, body: `${e.message} Return ${r.ref} is approved and waiting; open it to retry or settle by hand.`, link: '/admin#/returns', email: true }).catch(() => {});
    }
  } else {
    await run("UPDATE order_returns SET auto_settle='manual_needed' WHERE id=?", id); res.auto = { ok: false, manual: true };
    require('./notify').toStaff('finance', true, { type: 'return', title: `Refund awaiting settlement: order ${o.ref}`, body: `₦${amount.toLocaleString('en-NG')} for return ${r.ref} is approved but cannot be sent automatically (${!autoOn ? 'automatic refunds are switched off' : P.cash_order ? 'cash on delivery' : 'not a Paystack payment'}). Settle it by hand.`, link: '/admin#/returns' }).catch(() => {});
  }
  return res;
}
// Optional small-amount rule: a request at or under the limit (shop setting return_auto_approve_max, Naira, 0 = off) is approved and refunded by itself.
async function maybeAutoApprove(id, amount) {
  const max = Number((await S.getSettings()).return_auto_approve_max || 0);
  if (!(max > 0) || amount > max) return null;
  try { return await approve(id, { system: true, id: null, name: 'Auto-approval' }, {}); } catch (e) { console.error('Auto-approval skipped:', e.message); return null; }
}
async function reject(id, actor, b) {
  const note = str(b.note, 500).trim(); if (note.length < 5) fail(400, 'Tell the customer why the return is not approved.');
  const r = await get('SELECT * FROM order_returns WHERE id=?', id); if (!r) fail(404, 'Return not found.');
  if (r.status === 'recommended' && !isOwner(actor)) fail(403, 'This return is waiting for the owner, who makes the final decision.');
  const c = await run("UPDATE order_returns SET status='rejected', decision_note=?, decided_by=?, decided_by_name=?, decided_at=?, updated=? WHERE id=? AND status IN ('requested','recommended')", note, actor.id, str(actor.name || actor.email, 80), now(), now(), id);
  if (!c.changes) fail(409, 'This return was already reviewed.');
  const o = await S.loadOrder('id=?', r.order_id);
  await S.addEvent(o.id, 'return', `Return ${r.ref} was not approved. ${note}`);
  tellCustomer(o, `Return ${r.ref} not approved`, `We could not approve your return for order ${o.ref}. ${note}`);
  mailCustomer(o, `About your return ${r.ref}`, `<p>We reviewed your return request <b>${S.esc(r.ref)}</b> for order <b>${S.esc(o.ref)}</b> and could not approve it.</p><p>${S.esc(note)}</p><p>If you think this is a mistake, reply to this email or contact us with your order number.</p>`);
}

// Settlement: claim the return so only one person can do it, send the gateway part (outside the database transaction), then record everything in one transaction.
async function settle(id, actor, b) {
  const method = ['original', 'wallet', 'manual'].includes(b.method) ? b.method : 'original', reference = str(b.reference, 120).trim(), restock = !!b.restock, chargeVendor = b.charge_vendor === undefined ? true : !!b.charge_vendor;
  const r0 = await get('SELECT * FROM order_returns WHERE id=?', id); if (!r0) fail(404, 'Return not found.');
  if (r0.status === 'settled') fail(409, 'This refund was already settled.');
  if (r0.status === 'requested') fail(409, 'Review and approve the return first.');
  if (r0.status === 'recommended') fail(409, 'This return is waiting for the owner\'s approval.');
  if (!['awaiting_settlement', 'settling'].includes(r0.status)) fail(409, 'This return is not waiting for settlement.');
  if (method === 'manual' && reference.length < 3) fail(400, 'Enter the reference of the refund you paid (bank transfer or Paystack dashboard reference).');
  const o = await S.loadOrder('id=?', r0.order_id), r = parse(r0), P = await plan(r, o);
  if (method === 'wallet' && !P.has_wallet) fail(400, 'This was a guest order with no customer account, so there is no wallet to credit. Choose "Paid manually".');
  if (method === 'original' && P.card > 0) {
    if (P.cash_order) fail(400, 'This order was paid in cash on delivery, so there is no card to refund. Choose "VELTO wallet" or "Paid manually".');
    if (!(o.payment_method === 'paystack' && (o.gateway || 'paystack') === 'paystack')) fail(400, 'This payment was not made through Paystack. Refund it in the payment provider\'s dashboard, then choose "Paid manually".');
  }
  // claim (a stuck claim older than 10 minutes can be taken over; a gateway refund that already went through is never sent twice)
  const t = now();
  const claim = await run("UPDATE order_returns SET status='settling', settling_at=?, last_error='', updated=? WHERE id=? AND (status='awaiting_settlement' OR (status='settling' AND settling_at < ?))", t, t, id, t - 600);
  if (!claim.changes) fail(409, 'Someone else is settling this refund right now.');
  let walletK = 0, cardK = 0, gw = { id: r0.gateway_ref || '', status: r0.gateway_status || '' };
  try {
    if (method === 'wallet') { walletK = P.amount; }
    else if (method === 'manual') { cardK = P.amount; gw = { id: reference, status: 'paid by hand' }; }
    else {
      walletK = P.wallet; cardK = P.card;
      if (cardK > 0 && !gw.id) {
        const totalK = Number(o.total) * 100, cardTotalK = Math.max(1, totalK - Number(o.wallet_amount || 0)), base = o.charge_amount != null ? Number(o.charge_amount) : cardTotalK;
        gw = await S.paystackRefund(o, Math.max(1, Math.round(base * cardK / cardTotalK)), `Refund for returned items, order ${o.ref}`);
        await run('UPDATE order_returns SET gateway_ref=?, gateway_status=? WHERE id=?', gw.id, gw.status, id);   // remember it at once: a retry must never refund twice
      }
    }
  } catch (e) { await run("UPDATE order_returns SET status='awaiting_settlement', last_error=?, updated=? WHERE id=?", str(e.message, 300), now(), id); throw e; }
  await tx(async () => {
    const cur = await get('SELECT status FROM order_returns WHERE id=? FOR UPDATE', id); if (!cur || cur.status !== 'settling') fail(409, 'This refund is no longer being settled.');
    if (walletK > 0) await require('./wallet').post({ userId: o.user_id, type: 'refund', amount: walletK, idemKey: 'return:' + id, orderRef: o.ref, description: `Refund for returned items, order ${o.ref}`, allowFrozen: true });
    let restocked = 0;
    if (restock) { const back = r.items.map((i) => ({ ...(o.items.find((x) => Number(x.id) === Number(i.item_id)) || {}), qty: i.qty })).filter((i) => i.product_id); await S.returnItemsStock(back); restocked = 1; }
    await run("UPDATE order_returns SET charge_vendor=?, status='settled', settle_method=?, settle_reference=?, wallet_refunded=?, gateway_refunded=?, gateway_ref=?, gateway_status=?, restocked=?, settled_by=?, settled_by_name=?, settled_at=?, updated=?, last_error='' WHERE id=?",
      chargeVendor ? 1 : 0, method, method === 'manual' ? reference : '', walletK, cardK, gw.id || '', gw.status || '', restocked, actor.id, str(actor.name || actor.email, 80), now(), now(), id);
    // every item sent back and the whole order value refunded: the order itself becomes "refunded" (points used go back to the customer; points earned are reversed by the loyalty sweep)
    const settled = (await all("SELECT items, approved_amount FROM order_returns WHERE order_id=? AND status='settled'", o.id)).map(parse), got = {}; let money = 0;
    for (const s of settled) { money += Number(s.approved_amount); for (const i of s.items) got[i.item_id] = (got[i.item_id] || 0) + Number(i.qty); }
    const all_back = o.items.every((i) => (got[i.id] || 0) >= Number(i.qty));
    const where = refundWords({ ...r, wallet_refunded: walletK, gateway_refunded: cardK, settle_method: method });
    await S.addEvent(o.id, all_back ? 'refunded' : 'return', `Return ${r.ref} settled: ₦${Number(r.approved_amount).toLocaleString('en-NG')} refunded (${where}).`);
    const wholeOrder = all_back && money >= Number(o.total) - 1;
    // partner stores: take the returned goods off their balance (when the whole order is refunded it leaves their figures by itself, see lib/vendors.js balanceOf)
    if (chargeVendor && !wholeOrder) {
      for (const v of vendorShares({ ...r, approved_amount: r.approved_amount }, o)) {
        await run('INSERT INTO vendor_adjustments (vendor_id,order_id,return_id,amount,kind,note,created) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', v.vendor_id, o.id, id, -v.amount, 'return', `Return ${r.ref} on order ${o.ref}`, now());
      }
    }
    if (wholeOrder) {
      await run("UPDATE orders SET status='refunded', payment_status='refunded', handover_nonce='' WHERE id=? AND status='delivered'", o.id);
      await require('./loyalty').returnOrderPoints(o).catch(() => {});
    }
  });
  const where = refundWords({ wallet_refunded: walletK, gateway_refunded: cardK, settle_method: method });
  tellPartners(r, o, chargeVendor);
  tellCustomer(o, `Refund sent for return ${r.ref}`, `₦${Number(r.approved_amount).toLocaleString('en-NG')} was refunded: ${where}.`);
  mailCustomer(o, `Your refund for return ${r.ref}`, `<p>Your refund of <b>₦${Number(r.approved_amount).toLocaleString('en-NG')}</b> for order <b>${S.esc(o.ref)}</b> has been sent: ${S.esc(where)}.</p>`);
  return { ok: true, wallet: walletK, card: cardK, gateway_status: gw.status };
}
// Counts and the newest waiting returns for the dashboard.
async function summary() {
  const c = await get("SELECT COUNT(*) FILTER (WHERE status='requested')::int requested, COUNT(*) FILTER (WHERE status='recommended')::int recommended, COUNT(*) FILTER (WHERE status IN ('awaiting_settlement','settling'))::int awaiting FROM order_returns");
  const recent = await all("SELECT r.id, r.ref, r.status, r.requested_amount, r.approved_amount, o.ref AS order_ref, o.name AS customer FROM order_returns r JOIN orders o ON o.id=r.order_id WHERE r.status IN ('requested','recommended','awaiting_settlement','settling') ORDER BY r.id DESC LIMIT 6");
  return { requested: c.requested, recommended: c.recommended, awaiting: c.awaiting, recent };
}
module.exports = { addPhoto, readPhoto, removePhoto, vendorShares, eligibility, request, cancel, forCustomer, list, detail, approve, reject, settle, summary, REASONS, CONDITIONS, OPEN };
