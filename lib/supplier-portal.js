'use strict';
// Step 7 of dropshipping: the optional supplier portal (switched on with SUPPLIER_PORTAL_ENABLED=1).
// A supplier signs in and sees ONLY its own purchase orders: where to ship, what to send, what we pay it for each item. It can confirm an item (with its order number),
// add tracking, or say it cannot supply. It never sees what the customer paid, our margin, other suppliers, another supplier's orders, or any customer email.
// Everything that affects price or stock is only a proposal: a price or stock change, and a "cannot supply", wait for an admin to accept them.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const A = require('./auth');
const C = require('./countries');
const DO = require('./dropship-orders');
const D = require('./dropship');
const PW = require('./passwords');
const { fail, str, int, esc } = S;

const enabled = () => process.env.SUPPLIER_PORTAL_ENABLED === '1';
const needOn = () => { if (!enabled()) fail(403, 'The supplier portal is switched off. Set SUPPLIER_PORTAL_ENABLED=1 to turn it on.'); };
const INVITE_SECS = 72 * 3600;
const REJECT_KINDS = { out_of_stock: 'Out of stock', supplier_cancelled: 'We cannot supply this', price_changed: 'Our price has changed', other: 'Other reason' };
const ACTIONS = ['shipped', 'in_transit', 'customs'];        // what a supplier may move an item to; delivery is confirmed by us
// What the supplier sees for each stage, in its own words.
const SEEN = { sent: 'New: please confirm', confirmed: 'Confirmed', shipped: 'Shipped', in_transit: 'In transit', customs: 'In customs', delivered: 'Delivered', issue: 'Problem reported: waiting for our decision', cancelled: 'Cancelled by us', refunded: 'Cancelled by us', returned: 'Returned' };
const naturalDate = (t) => new Date(Number(t) * 1000).toISOString().slice(0, 10);
const alert = (subject, html) => DO.alertAdmin(subject, html);

/* ---------- who is calling ---------- */
async function mine(user) {
  needOn();
  if (!user || user.role !== 'supplier' || !user.supplier_id) fail(401, 'Please sign in as a supplier.');
  const s = await get('SELECT * FROM suppliers WHERE id = ?', user.supplier_id);
  if (!s) fail(401, 'Your supplier account was not found.');
  return s;
}
const actorOf = (user, sup) => `supplier: ${str(user.name, 40)} (${str(sup.name, 40)})`;
async function profile(user) {
  const s = await mine(user);
  const open = await get("SELECT COUNT(*) n FROM dropship_lines l JOIN supplier_orders so ON so.id = l.po_id WHERE l.supplier_id = ? AND so.status = 'sent' AND l.status = 'sent'", s.id);
  return { id: Number(s.id), name: s.name, currency: s.currency, contact_name: s.contact_name, status: s.status, to_confirm: Number(open.n), user: { name: user.name, email: user.email } };
}

/* ---------- purchase orders (only this supplier's) ---------- */
const lineOut = (l) => ({
  id: Number(l.id), name: l.name + (l.variant_label ? ' (' + l.variant_label + ')' : ''), sku: l.supplier_sku, qty: l.qty, unit_cost: Number(l.unit_cost), ship_cost: Number(l.ship_cost), total: Math.round((Number(l.unit_cost) + Number(l.ship_cost)) * l.qty * 100) / 100,
  status: l.status, label: l.supplier_response === 'rejected' && ['sent', 'confirmed'].includes(l.status) ? 'You said you cannot supply this: waiting for our decision' : SEEN[l.status] || l.status,
  supplier_order_no: l.supplier_order_no, carrier: l.carrier, tracking_no: l.tracking_no, tracking_url: l.tracking_url,
  rejected: l.supplier_response === 'rejected' && ['sent', 'confirmed'].includes(l.status), rejected_reason: l.supplier_response_kind ? REJECT_KINDS[l.supplier_response_kind] || '' : '', rejected_note: l.supplier_response_note,
  can_confirm: l.status === 'sent' && l.supplier_response !== 'rejected', can_ship: ['confirmed', 'shipped', 'in_transit'].includes(l.status), can_reject: ['sent', 'confirmed'].includes(l.status) && l.supplier_response !== 'rejected',
});
async function loadPOs(sup, where, ...args) {
  const pos = await all(`SELECT so.id, so.ref, so.currency, so.total_cost, so.sent_at, so.order_id FROM supplier_orders so WHERE so.supplier_id = ? AND so.status = 'sent' ${where} ORDER BY so.id DESC LIMIT 200`, sup.id, ...args);
  if (!pos.length) return [];
  const lines = await all(`SELECT l.*, oi.name, oi.variant_label FROM dropship_lines l JOIN order_items oi ON oi.id = l.order_item_id WHERE l.supplier_id = ? AND l.po_id = ANY(?) ORDER BY l.id`, sup.id, pos.map((p) => Number(p.id)));
  const orders = new Map((await all('SELECT id, name, phone, address, landmark, city, state, postcode, country FROM orders WHERE id = ANY(?)', pos.map((p) => Number(p.order_id)))).map((o) => [Number(o.id), o]));
  return pos.map((p) => {
    const o = orders.get(Number(p.order_id)) || {};
    return { id: Number(p.id), ref: p.ref, currency: p.currency, total: Number(p.total_cost), sent_at: p.sent_at == null ? null : Number(p.sent_at),
      ship_to: { name: o.name, phone: o.phone, address: [o.address, o.landmark].filter(Boolean).join(', '), city: [o.city, o.state].filter(Boolean).join(', ') + (o.postcode ? ' ' + o.postcode : ''), country: C.countryName(o.country || 'NG') },
      lines: lines.filter((l) => Number(l.po_id) === Number(p.id)).map(lineOut) };
  });
}
async function orders(user, q = {}) {
  const sup = await mine(user), all_ = await loadPOs(sup, '');
  const done = (po) => po.lines.every((l) => ['delivered', 'cancelled', 'refunded', 'returned'].includes(l.status));
  return { orders: q.all === '1' ? all_ : all_.filter((p) => !done(p)), currency: sup.currency };
}
async function order(user, id) {
  const sup = await mine(user), r = await loadPOs(sup, 'AND so.id = ?', int(id));
  if (!r.length) fail(404, 'Purchase order not found.');
  return r[0];
}
// Always loads through the supplier's own id: an item of another supplier looks exactly like an item that does not exist.
async function myLine(sup, lineId) {
  const l = await get("SELECT l.* FROM dropship_lines l JOIN supplier_orders so ON so.id = l.po_id WHERE l.id = ? AND l.supplier_id = ? AND so.supplier_id = ? AND so.status = 'sent'", int(lineId), sup.id, sup.id);
  if (!l) fail(404, 'Item not found.');
  return l;
}
async function confirm(user, lineId, b) {
  const sup = await mine(user), l = await myLine(sup, lineId);
  if (l.supplier_response === 'rejected') fail(409, 'You told us you cannot supply this item. Wait for our decision.');
  const no = str(b.supplier_order_no, 80); if (!no) fail(400, 'Enter your order number for this item.');
  const r = await DO.transition(l.id, 'confirmed', { actor: actorOf(user, sup), expectedFrom: 'sent', note: 'Confirmed by the supplier', key: 'portal:confirm:' + l.id, fields: { supplier_order_no: no } });
  if (b.carrier || b.tracking_no) await track(user, l.id, b);            // "confirm and ship" in one go
  return { status: (await get('SELECT status FROM dropship_lines WHERE id = ?', l.id)).status, unchanged: r.unchanged };
}
async function track(user, lineId, b) {
  const sup = await mine(user), l = await myLine(sup, lineId);
  const to = str(b.status, 12) || 'shipped'; if (!ACTIONS.includes(to)) fail(400, 'Choose shipped, in transit or in customs. We confirm delivery ourselves.');
  const carrier = str(b.carrier, 60), no = str(b.tracking_no, 80);
  if (l.status === 'sent') fail(409, 'Confirm the item first (with your order number), then add the tracking.');
  if (!carrier || !no) fail(400, 'Enter the carrier and the tracking number.');
  if (l.status === to && (carrier !== l.carrier || no !== l.tracking_no)) {            // correcting a tracking number that was already sent
    await tx(async () => {
      await run('UPDATE dropship_lines SET carrier = ?, tracking_no = ?, tracking_url = COALESCE(?, tracking_url), updated = ? WHERE id = ?', carrier, no, b.tracking_url === undefined ? null : (/^https:\/\/[^\s"'<>]{1,280}$/.test(str(b.tracking_url, 300)) ? str(b.tracking_url, 300) : ''), now(), l.id);
      await run('INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, created) VALUES (?,?,?,?,?,?)', l.id, l.status, l.status, `Tracking corrected by the supplier: ${carrier} ${no}`, actorOf(user, sup), now());
    });
    return { status: l.status, unchanged: false, corrected: true };
  }
  const r = await DO.transition(l.id, to, { actor: actorOf(user, sup), note: 'Tracking added by the supplier', key: `portal:${to}:${l.id}:${no}`, fields: { carrier, tracking_no: no, tracking_url: b.tracking_url } });
  return { status: r.line.status, unchanged: r.unchanged };
}
// "We cannot supply this": nothing changes on the order. We are alerted, and an admin decides.
async function reject(user, lineId, b) {
  const kind = str(b.kind, 20), note = str(b.note, 300);
  if (!REJECT_KINDS[kind]) fail(400, 'Choose the reason.');
  if (note.length < 3) fail(400, 'Please tell us a little more, so we can decide what to do.');
  const sup = await mine(user);
  const out = await tx(async () => {
    const l = await get('SELECT l.*, so.ref po_ref FROM dropship_lines l JOIN supplier_orders so ON so.id = l.po_id WHERE l.id = ? AND l.supplier_id = ? AND so.supplier_id = ? AND so.status = ? FOR UPDATE', int(lineId), sup.id, sup.id, 'sent');
    if (!l) fail(404, 'Item not found.');
    if (!['sent', 'confirmed'].includes(l.status)) fail(409, 'This item can no longer be rejected.');
    if (l.supplier_response === 'rejected') return { unchanged: true };
    await run("UPDATE dropship_lines SET supplier_response='rejected', supplier_response_kind=?, supplier_response_note=?, supplier_response_at=? WHERE id=?", kind, note, now(), l.id);
    await run('INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, created) VALUES (?,?,?,?,?,?)', l.id, l.status, l.status, `Supplier says it cannot supply (${REJECT_KINDS[kind]}): ${note}`, actorOf(user, sup), now());
    return { unchanged: false, po_ref: l.po_ref };
  });
  if (!out.unchanged) await alert(`${sup.name} cannot supply an item (${out.po_ref})`, `<p><b>${esc(sup.name)}</b> says it cannot supply an item on purchase order <b>${esc(out.po_ref)}</b>: ${esc(REJECT_KINDS[kind])}. ${esc(note)}</p><p>Open Dropshipping > Supplier portal to accept (the customer is then offered an alternative or a refund) or decline.</p>`);
  return out;
}

/* ---------- the supplier's products and its change requests ---------- */
async function products(user) {
  const sup = await mine(user);
  const rows = await all(`SELECT dp.product_id, dp.supplier_sku, dp.cost, dp.ship_cost, dp.supplier_stock, dp.processing_days, p.name,
      (SELECT COUNT(*) FROM supplier_requests r WHERE r.product_id = dp.product_id AND r.status = 'pending') pending FROM dropship_products dp JOIN products p ON p.id = dp.product_id WHERE dp.supplier_id = ? ORDER BY p.name LIMIT 1000`, sup.id);
  return { currency: sup.currency, products: rows.map((r) => ({ id: Number(r.product_id), sku: r.supplier_sku, name: r.name, cost: Number(r.cost), ship_cost: Number(r.ship_cost), stock: r.supplier_stock == null ? null : Number(r.supplier_stock), processing_days: r.processing_days, pending: Number(r.pending) })) };
}
const reqOut = (r) => ({ id: Number(r.id), product_id: Number(r.product_id), name: r.name, sku: r.sku, kind: r.kind, old_cost: r.old_cost == null ? null : Number(r.old_cost), old_ship_cost: r.old_ship_cost == null ? null : Number(r.old_ship_cost), old_stock: r.old_stock == null ? null : Number(r.old_stock),
  new_cost: r.new_cost == null ? null : Number(r.new_cost), new_ship_cost: r.new_ship_cost == null ? null : Number(r.new_ship_cost), new_stock: r.new_stock == null ? null : Number(r.new_stock), note: r.note, status: r.status, created: Number(r.created), created_by: r.created_by_name,
  decided_by: r.decided_by, decided_at: r.decided_at == null ? null : Number(r.decided_at), decision_note: r.decision_note, currency: r.currency });
const REQ_SQL = `SELECT r.*, p.name, dp.supplier_sku sku, s.currency, s.name supplier FROM supplier_requests r JOIN dropship_products dp ON dp.product_id = r.product_id JOIN products p ON p.id = r.product_id JOIN suppliers s ON s.id = r.supplier_id`;
async function myRequests(user) { const sup = await mine(user); return { requests: (await all(`${REQ_SQL} WHERE r.supplier_id = ? ORDER BY r.id DESC LIMIT 200`, sup.id)).map(reqOut) }; }
const money = (x, label) => { const v = typeof x === 'string' ? Number(x.replace(/,/g, '')) : Number(x); if (x === '' || x == null || !Number.isFinite(v)) fail(400, `${label} must be a number.`); return Math.round(v * 100) / 100; };
async function request(user, b) {
  const sup = await mine(user), kind = str(b.kind, 8);
  if (!['price', 'stock'].includes(kind)) fail(400, 'Choose a price change or a stock change.');
  const p = await get('SELECT product_id, cost, ship_cost, supplier_stock FROM dropship_products WHERE product_id = ? AND supplier_id = ?', int(b.product_id), sup.id);
  if (!p) fail(404, 'Product not found.');
  let nc = null, ns = null, nst = null;
  if (kind === 'price') {
    nc = money(b.cost, 'The price'); if (nc <= 0 || nc > 1e9) fail(400, 'The price must be more than zero.');
    ns = b.ship_cost === undefined || b.ship_cost === '' ? Number(p.ship_cost) : money(b.ship_cost, 'The shipping cost'); if (ns < 0 || ns > 1e9) fail(400, 'The shipping cost must be zero or more.');
    if (nc === Number(p.cost) && ns === Number(p.ship_cost)) fail(400, 'That is the price we already have.');
  } else {
    const v = Number(b.stock); if (b.stock === '' || b.stock == null || !Number.isInteger(v) || v < 0 || v > 1e7) fail(400, 'Stock must be a whole number, 0 or more.');
    nst = v; if (p.supplier_stock != null && v === Number(p.supplier_stock)) fail(400, 'That is the stock we already have.');
  }
  const note = str(b.note, 300);
  const id = await tx(async () => {
    await run("DELETE FROM supplier_requests WHERE product_id = ? AND kind = ? AND status = 'pending'", p.product_id, kind);   // a newer proposal replaces the one still waiting
    return Number((await run('INSERT INTO supplier_requests (supplier_id, product_id, kind, old_cost, old_ship_cost, old_stock, new_cost, new_ship_cost, new_stock, note, created_by, created_by_name, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      sup.id, p.product_id, kind, p.cost, p.ship_cost, p.supplier_stock, nc, ns, nst, note, user.id, str(user.name, 80), now())).lastInsertRowid);
  });
  await alert(`${sup.name} proposed a ${kind} change`, `<p><b>${esc(sup.name)}</b> proposed a ${kind === 'price' ? `new price (${esc(sup.currency)} ${nc}, shipping ${ns})` : `new stock level (${nst})`}. Nothing changes until you approve it in Dropshipping > Supplier portal.</p>`);
  return id;
}

/* ---------- admin: logins for a supplier ---------- */
const publicLogin = (u) => ({ id: Number(u.id), name: u.name, email: u.email, phone: u.phone, active: u.active !== 0, created: Number(u.created) });
async function logins(supplierId) {
  if (!(await get('SELECT 1 x FROM suppliers WHERE id = ?', int(supplierId)))) fail(404, 'Supplier not found.');
  return { enabled: enabled(), logins: (await all("SELECT * FROM users WHERE role = 'supplier' AND supplier_id = ? ORDER BY id", int(supplierId))).map(publicLogin) };
}
async function sendInvite(u, sup, by) {
  const token = crypto.randomBytes(32).toString('hex');
  await run('DELETE FROM resets WHERE user_id = ?', u.id);
  await run('INSERT INTO resets (token, user_id, expires) VALUES (?,?,?)', A.sha(token), u.id, now() + INVITE_SECS);
  const link = `${S.BASE_URL}/forgot?token=${token}&invite=1`;
  if (!S.mailOn) return { emailed: false, invite_link: link };
  const st = await S.getSettings(), first = String(u.name || '').split(' ')[0];
  await S.queueMail(u.email, `Your ${st.store_name} supplier account`, S.mailWrap(st, `<p>Hi ${esc(first)}, ${esc(by || 'we')} set up a supplier account for <b>${esc(sup.name)}</b>. You will see only your purchase orders: confirm them, add tracking, and tell us about stock and price changes.</p><p>Your sign-in email is <b>${esc(u.email)}</b>. <a href="${link}">Choose your password</a> (the link works for 72 hours), then sign in at ${esc(S.BASE_URL)}/supplier</p>`));
  return { emailed: true };
}
async function createLogin(supplierId, b, by) {
  needOn();
  const sup = await get('SELECT * FROM suppliers WHERE id = ?', int(supplierId)); if (!sup) fail(404, 'Supplier not found.');
  const name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 30);
  if (name.length < 2) fail(400, 'Enter the person\'s name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
  if (await get('SELECT 1 x FROM users WHERE email = ?', email)) fail(409, 'That email already has an account.');
  const password = crypto.randomBytes(18).toString('base64url') + 'aZ9!';           // nobody knows it: the person chooses their own through the invite link
  const id = Number((await run("INSERT INTO users (name,email,phone,password,role,supplier_id,created) VALUES (?,?,?,?,'supplier',?,?)", name, email, phone, await A.hashPassword(password), sup.id, now())).lastInsertRowid);
  const u = await get('SELECT * FROM users WHERE id = ?', id);
  return { id, ...(await sendInvite(u, sup, by)) };
}
async function loginOf(supplierId, uid) { const u = await get("SELECT * FROM users WHERE id = ? AND role = 'supplier' AND supplier_id = ?", int(uid), int(supplierId)); if (!u) fail(404, 'Login not found.'); return u; }
async function resendInvite(supplierId, uid, by) { needOn(); const u = await loginOf(supplierId, uid); if (u.active === 0) fail(400, 'This login is switched off.'); return sendInvite(u, await get('SELECT * FROM suppliers WHERE id = ?', u.supplier_id), by); }
async function setLoginActive(supplierId, uid, on) {
  const u = await loginOf(supplierId, uid);
  await run('UPDATE users SET active = ? WHERE id = ?', on ? 1 : 0, u.id);
  if (!on) await A.dropUserSessions(u.id);            // switched off means signed out everywhere, at once
}

/* ---------- admin: what is waiting for a decision ---------- */
async function inbox() {
  const requests = (await all(`${REQ_SQL} WHERE r.status = 'pending' ORDER BY r.id`)).map((r) => ({ ...reqOut(r), supplier: r.supplier }));
  const rej = await all(`SELECT l.id, l.supplier_response_kind kind, l.supplier_response_note note, l.supplier_response_at at, l.status, l.qty, s.name supplier, so.ref po_ref, o.ref order_ref, oi.name
    FROM dropship_lines l JOIN supplier_orders so ON so.id = l.po_id JOIN suppliers s ON s.id = l.supplier_id JOIN orders o ON o.id = l.order_id JOIN order_items oi ON oi.id = l.order_item_id
    WHERE l.supplier_response = 'rejected' AND l.status IN ('sent','confirmed') ORDER BY l.supplier_response_at`);
  const prices = new Map((await all('SELECT p.id, p.price, dp.price_mode FROM products p JOIN dropship_products dp ON dp.product_id = p.id WHERE p.id = ANY(?)', requests.map((r) => r.product_id))).map((r) => [Number(r.id), r]));
  return { enabled: enabled(), requests: requests.map((r) => ({ ...r, current_price: prices.has(r.product_id) ? Number(prices.get(r.product_id).price) : null, price_mode: prices.has(r.product_id) ? prices.get(r.product_id).price_mode : null })),
    rejections: rej.map((r) => ({ line_id: Number(r.id), supplier: r.supplier, po_ref: r.po_ref, order_ref: r.order_ref, name: r.name, qty: r.qty, status: r.status, kind: r.kind, reason: REJECT_KINDS[r.kind] || r.kind, note: r.note, at: Number(r.at) })), kinds: REJECT_KINDS };
}
async function requestHistory(supplierId) { return { requests: (await all(`${REQ_SQL} WHERE r.status <> 'pending' ${supplierId ? 'AND r.supplier_id = ?' : ''} ORDER BY r.id DESC LIMIT 100`, ...(supplierId ? [int(supplierId)] : []))).map((r) => ({ ...reqOut(r), supplier: r.supplier })) }; }
async function mailSupplier(supplierId, subject, html) {
  try { for (const u of await all("SELECT email FROM users WHERE role = 'supplier' AND supplier_id = ? AND active <> 0", supplierId)) await S.queueMail(u.email, subject, S.mailWrap(await S.getSettings(), html)); } catch (e) { console.error('Supplier email failed:', e.message); }
}
// Approving applies the change to the product through the normal product update, so prices are worked out the usual way. A price kept by hand stays as it is.
async function decideRequest(user, id, b) {
  const decision = str(b.decision, 10), note = str(b.note, 300);
  if (!['approved', 'rejected'].includes(decision)) fail(400, 'Choose approve or reject.');
  if (decision === 'rejected' && note.length < 3) fail(400, 'Tell the supplier why, in a few words.');
  const r0 = await get('SELECT * FROM supplier_requests WHERE id = ?', int(id)); if (!r0) fail(404, 'Request not found.');
  if (r0.status !== 'pending') fail(409, `This request was already ${r0.status}.`);
  const before = await get('SELECT price FROM products WHERE id = ?', r0.product_id);
  const claimed = await run("UPDATE supplier_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'", decision, str(user.name || user.email, 80), now(), note, r0.id);
  if (!claimed.changes) fail(409, 'This request was just decided by someone else.');
  let after = before;
  if (decision === 'approved') {
    try {
      await D.update(user, r0.product_id, r0.kind === 'price' ? { cost: Number(r0.new_cost), ship_cost: Number(r0.new_ship_cost) } : { supplier_stock: Number(r0.new_stock) });
    } catch (e) { await run("UPDATE supplier_requests SET status = 'pending', decided_by = '', decided_at = NULL, decision_note = '' WHERE id = ?", r0.id); throw e; }   // not applied: it stays waiting
    after = await get('SELECT price FROM products WHERE id = ?', r0.product_id);
  }
  const p = await get('SELECT p.name FROM products p WHERE p.id = ?', r0.product_id);
  await mailSupplier(r0.supplier_id, `Your ${r0.kind} change for ${p.name} was ${decision}`, `<p>Your proposed ${r0.kind} change for <b>${esc(p.name)}</b> was <b>${decision}</b>.${note ? ' ' + esc(note) : ''}</p>`);
  return { status: decision, price_before: before ? Number(before.price) : null, price_after: after ? Number(after.price) : null };
}
// Accept: the item becomes a problem and the customer is told and chooses an alternative or a refund (step 4). Decline: the supplier is asked to supply it after all.
async function decideRejection(user, lineId, b) {
  const decision = str(b.decision, 10), note = str(b.note, 300);
  if (!['accept', 'decline'].includes(decision)) fail(400, 'Choose accept or decline.');
  const l = await get('SELECT * FROM dropship_lines WHERE id = ?', int(lineId));
  if (!l || l.supplier_response !== 'rejected' || !['sent', 'confirmed'].includes(l.status)) fail(409, 'There is no supplier rejection waiting on this item.');
  const actor = str(user.name || user.email, 80);
  if (decision === 'accept') {
    const kind = Object.keys(REJECT_KINDS).includes(l.supplier_response_kind) ? l.supplier_response_kind : 'other';
    await DO.transition(l.id, 'issue', { actor, note: 'Supplier rejection accepted: ' + l.supplier_response_note, key: 'portal:reject:' + l.id + ':' + l.supplier_response_at, fields: { issue_kind: kind, issue_note: l.supplier_response_note } });
    await run("UPDATE dropship_lines SET supplier_response = '', supplier_response_kind = '', supplier_response_note = '', supplier_response_at = NULL WHERE id = ?", l.id);
  } else {
    await run("UPDATE dropship_lines SET supplier_response = '', supplier_response_kind = '', supplier_response_note = '', supplier_response_at = NULL WHERE id = ?", l.id);
    await run('INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, created) VALUES (?,?,?,?,?,?)', l.id, l.status, l.status, 'Supplier rejection declined: ' + (note || 'please supply it'), actor, now());
    await mailSupplier(l.supplier_id, 'Please supply the item after all', `<p>We could not accept your note that you cannot supply an item on one of your purchase orders.${note ? ' ' + esc(note) : ''} Please supply it, or contact us.</p>`);
  }
  return { decision };
}

module.exports = { enabled, REJECT_KINDS, ACTIONS, mine, profile, orders, order, confirm, track, reject, products, myRequests, request, logins, createLogin, resendInvite, setLoginActive, inbox, requestHistory, decideRequest, decideRejection };
