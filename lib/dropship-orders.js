'use strict';
// The dropship order flow. One customer order can mix our own stock, partner-store items and dropship items; every dropship item has its own line here.
//   pending_payment -> paid -> sent (purchase order sent) -> confirmed (supplier accepted) -> shipped (tracking) -> in_transit -> customs -> delivered
//   plus: issue (out of stock / supplier cancelled: the customer chooses an alternative or a refund), cancelled, refunded, returned.
// Rules kept here: nothing is ordered before payment is confirmed; the customer is never charged a different price after checkout (sell_price is fixed);
// every change is an event with who made it; a repeated request (same key, or already in that state) changes nothing.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const C = require('./countries');
const PDF = require('./pdf');
const FX = require('./fx');
const { fail, str, int, esc } = S;

const NEXT = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['sent', 'cancelled'],
  sent: ['confirmed', 'issue', 'cancelled'],
  confirmed: ['shipped', 'issue', 'cancelled'],
  shipped: ['in_transit', 'customs', 'delivered', 'issue'],
  in_transit: ['customs', 'delivered', 'issue'],
  customs: ['delivered', 'issue'],
  delivered: ['returned'],
  issue: ['paid', 'confirmed', 'shipped', 'cancelled'],      // paid again = the customer took an alternative, so it goes back to be ordered
  cancelled: ['refunded'],
  returned: ['refunded'],
  refunded: [],
};
const STATES = Object.keys(NEXT);
const TERMINAL = ['delivered', 'cancelled', 'refunded', 'returned'];
const GONE = ['cancelled', 'refunded'];                       // items that will not arrive
const ONWARD = ['shipped', 'in_transit', 'customs', 'delivered'];
const STAGES = ['paid', 'sent', 'confirmed', 'shipped', 'in_transit', 'customs', 'delivered'];
const allowed = (from, to) => (NEXT[from] || []).includes(to);

// What the customer reads. No supplier names, codes, costs or margins anywhere.
const LABEL = {
  pending_payment: 'Waiting for payment', paid: 'Order received', sent: 'Being prepared for dispatch', confirmed: 'Confirmed for dispatch', shipped: 'Shipped',
  in_transit: 'In transit', customs: 'Clearing customs', delivered: 'Delivered', issue: 'Needs your decision', cancelled: 'Cancelled', refunded: 'Refunded', returned: 'Returned',
};
const ISSUE_TEXT = {
  out_of_stock: 'This item is no longer available from our supplier.', supplier_cancelled: 'Our supplier could not fulfil this item.', price_changed: 'This item can no longer be supplied at the price you paid.',
  lost: 'The parcel was lost on its way to you.', damaged: 'The item was damaged.', other: 'There is a problem with this item.',
};
const ISSUE_KINDS = Object.keys(ISSUE_TEXT);
const cleanUrl = (u) => { u = str(u, 300); return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ''; };
const flagOn = () => process.env.DROPSHIP_ORDERS_ENABLED === '1';

/* ---------- lines are created with the order, in the same transaction ---------- */
async function createLines(orderId) {
  const items = await all(`SELECT oi.id, oi.product_id, oi.qty, oi.price, p.fulfilment FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id`, orderId);
  let rates = null;
  const ds = items.filter((i) => i.fulfilment === 'dropship');
  for (const i of ds) {
    const d = await get('SELECT dp.supplier_id, dp.cost, dp.ship_cost, dp.supplier_sku, s.currency FROM dropship_products dp JOIN suppliers s ON s.id = dp.supplier_id WHERE dp.product_id = ?', i.product_id);
    if (!d) fail(409, 'One of the items can no longer be ordered. Please update your cart.');
    let costNgn = null, costRate = null;
    try { rates = rates || await require('./dropship').rates(); costNgn = Math.round(FX.toNaira((Number(d.cost) + Number(d.ship_cost)) * i.qty, d.currency, rates)); costRate = FX.toNaira(1, d.currency, rates); } catch { /* no rate: margin reports show it as unknown */ }
    const r = await run(`INSERT INTO dropship_lines (order_item_id, order_id, product_id, supplier_id, qty, sell_price, unit_cost, ship_cost, cost_currency, cost_ngn, cost_fx_rate, supplier_sku, created, updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, i.id, orderId, i.product_id, d.supplier_id, i.qty, i.price, d.cost, d.ship_cost, d.currency, costNgn, costRate, d.supplier_sku, now(), now());
    await run("INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, created) VALUES (?,?,?,?,?,?)", Number(r.lastInsertRowid), '', 'pending_payment', 'Order placed', 'customer', now());
  }
  await run('UPDATE orders SET ds_lines = ?, own_lines = ?, ds_open = ? WHERE id = ?', ds.length, items.length - ds.length, ds.length, orderId);
  return ds.length;
}

/* ---------- the one place a line changes state ---------- */
// opts: { actor, key, note, expectedFrom, fields: { supplier_order_no, carrier, tracking_no, tracking_url, issue_kind, issue_note, po_id }, system }
// Returns { line, unchanged }. Asking for the state a line is already in, or repeating a key, is a quiet success.
async function transition(lineId, to, opts = {}) {
  if (!STATES.includes(to)) fail(400, 'Unknown status.');
  const actor = str(opts.actor, 80) || 'system', key = str(opts.key, 80), f = opts.fields || {};
  let mail = null;
  const out = await tx(async () => {
    const l = await get('SELECT * FROM dropship_lines WHERE id = ? FOR UPDATE', int(lineId));
    if (!l) fail(404, 'Item not found.');
    if (key && await get("SELECT 1 x FROM dropship_events WHERE line_id = ? AND event_key = ?", l.id, key)) return { line: l, unchanged: true };
    if (opts.expectedFrom && l.status !== opts.expectedFrom) fail(409, `This item is now "${LABEL[l.status] || l.status}". Reload and check before changing it.`);
    if (l.status === to) return { line: l, unchanged: true };
    if (!allowed(l.status, to)) fail(409, `An item cannot go from "${l.status}" to "${to}".`);
    const o = await get('SELECT id, ref, status, payment_status, own_lines, name, email, access_token FROM orders WHERE id = ? FOR UPDATE', l.order_id);
    if (!['pending_payment', 'cancelled'].includes(to) && to !== 'refunded' && o.payment_status !== 'paid') fail(409, 'The payment for this order is not confirmed yet. Nothing is ordered or shipped before payment.');
    if (o.status === 'cancelled' && !['cancelled', 'refunded'].includes(to)) fail(409, 'This order is cancelled.');
    const set = { status: to, updated: now() }, note = str(opts.note, 300);
    if (to === 'paid') { set.paid_at = l.paid_at || now(); if (l.status === 'issue') Object.assign(set, { po_id: null, supplier_order_no: '', carrier: '', tracking_no: '', tracking_url: '', issue_kind: '', issue_note: '' }); }
    if (to === 'sent') { if (!l.po_id && !f.po_id) fail(409, 'Create the purchase order first.'); set.sent_at = now(); if (f.po_id) set.po_id = f.po_id; }
    if (to === 'confirmed') {
      const no = str(f.supplier_order_no, 80) || l.supplier_order_no;
      if (!no) fail(400, 'Enter the supplier\'s order number.');
      set.supplier_order_no = no;
    }
    if (to === 'shipped') {
      const carrier = str(f.carrier, 60) || l.carrier, no = str(f.tracking_no, 80) || l.tracking_no;
      if (!carrier || !no) fail(400, 'Enter the carrier and the tracking number before marking an item shipped.');
      Object.assign(set, { carrier, tracking_no: no, tracking_url: f.tracking_url === undefined ? l.tracking_url : cleanUrl(f.tracking_url), shipped_at: l.shipped_at || now() });
      if (f.supplier_order_no && !l.supplier_order_no) set.supplier_order_no = str(f.supplier_order_no, 80);
    }
    if (['in_transit', 'customs', 'delivered'].includes(to)) {      // carrier and tracking may be corrected on the way
      if (f.carrier !== undefined && str(f.carrier, 60)) set.carrier = str(f.carrier, 60);
      if (f.tracking_no !== undefined && str(f.tracking_no, 80)) set.tracking_no = str(f.tracking_no, 80);
      if (f.tracking_url !== undefined) set.tracking_url = cleanUrl(f.tracking_url);
    }
    if (to === 'delivered') set.delivered_at = now();
    if (to === 'issue') {
      if (!ISSUE_KINDS.includes(f.issue_kind)) fail(400, 'Choose what went wrong.');
      Object.assign(set, { issue_kind: f.issue_kind, issue_note: str(f.issue_note, 300), customer_choice: '', alt_product_id: null });
    }
    if (to === 'cancelled') set.refund_due = o.payment_status === 'paid' && l.status !== 'pending_payment' ? l.sell_price * l.qty : 0;
    if (to === 'refunded') { set.refund_due = 0; set.refund_reference = str(f.refund_reference, 80); }
    const cols = Object.keys(set);
    await run(`UPDATE dropship_lines SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`, ...cols.map((c) => set[c]), l.id);
    await run('INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, event_key, created) VALUES (?,?,?,?,?,?,?)', l.id, l.status, to, note, actor, key, now());
    await syncOrder(l.order_id);
    const fresh = await get('SELECT * FROM dropship_lines WHERE id = ?', l.id);
    mail = { o, line: fresh, from: l.status };
    return { line: fresh, unchanged: false };
  });
  if (mail && !out.unchanged) await lineMail({ o: mail.o }, mail.line, mail.from).catch((e) => console.error('Dropship email error:', e.message));
  return out;
}

// A dropship-only order has no rider and no handover code: its status follows its items. A mixed order keeps its own status, but cannot finish before its supplier items do.
async function syncOrder(orderId) {
  const o = await get('SELECT id, status, payment_status, own_lines, ds_lines, coupon FROM orders WHERE id = ? FOR UPDATE', orderId);
  const lines = await all('SELECT status FROM dropship_lines WHERE order_id = ?', orderId);
  await run('UPDATE orders SET ds_open = ? WHERE id = ?', lines.filter((l) => !TERMINAL.includes(l.status)).length, orderId);
  if (!lines.length || o.own_lines > 0 || o.payment_status !== 'paid' || ['cancelled', 'refunded', 'delivered'].includes(o.status)) return;
  const live = lines.filter((l) => !GONE.includes(l.status));
  let target = null, note = '';
  if (!live.length) { await run("UPDATE orders SET status='cancelled' WHERE id = ?", orderId); await S.addEvent(orderId, 'cancelled', 'None of the items could be supplied. Refund the customer the full amount, then mark the order Refunded.'); return; }
  if (live.every((l) => ['delivered', 'returned'].includes(l.status)) && live.some((l) => l.status === 'delivered')) { target = 'delivered'; note = 'All items delivered'; }
  else if (live.every((l) => ONWARD.includes(l.status))) { target = 'shipped'; note = 'Your items are on their way'; }
  else if (live.some((l) => ['sent', 'confirmed', ...ONWARD].includes(l.status))) { target = 'processing'; note = 'Your order is being prepared for dispatch'; }
  const rank = { pending: 0, paid: 1, confirmed: 1, processing: 2, shipped: 3, delivered: 4 };
  if (target && rank[target] > rank[o.status]) { await run('UPDATE orders SET status = ? WHERE id = ?', target, orderId); await S.addEvent(orderId, target, note); }
}

/* ---------- when the order is paid / cancelled / refunded ---------- */
async function onPaid(orderId, actor = 'payment') {
  for (const l of await all("SELECT id FROM dropship_lines WHERE order_id = ? AND status = 'pending_payment' ORDER BY id", orderId)) {
    await run("UPDATE dropship_lines SET status='paid', paid_at=?, updated=? WHERE id=? AND status='pending_payment'", now(), now(), l.id);
    await run("INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, created) VALUES (?,?,?,?,?,?)", l.id, 'pending_payment', 'paid', 'Payment confirmed', actor, now());
  }
}
// Cancelling a whole order: items not yet ordered are simply cancelled; once a supplier has the order each item must be cancelled one by one, so nobody forgets to tell the supplier.
async function cancelLinesForOrder(orderId, actor) {
  const lines = await all('SELECT * FROM dropship_lines WHERE order_id = ? ORDER BY id', orderId);
  if (lines.some((l) => ['sent', 'confirmed', ...ONWARD].includes(l.status))) fail(409, 'Some items have already been ordered from the supplier. Cancel those items one by one first (Dropshipping > Supplier orders), so the supplier is told.');
  const paid = (await get('SELECT payment_status FROM orders WHERE id = ?', orderId)).payment_status === 'paid';
  for (const l of lines.filter((x) => !GONE.includes(x.status))) {
    await run("UPDATE dropship_lines SET status='cancelled', refund_due=?, po_id=NULL, updated=? WHERE id=?", paid && l.status !== 'pending_payment' ? l.sell_price * l.qty : 0, now(), l.id);
    await run('INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, created) VALUES (?,?,?,?,?,?)', l.id, l.status, 'cancelled', 'Order cancelled', str(actor, 80) || 'system', now());
  }
  await run('UPDATE orders SET ds_open = 0 WHERE id = ?', orderId);
}
async function markRefunded(orderId, actor) {
  for (const l of await all("SELECT id, status, refund_due FROM dropship_lines WHERE order_id = ? AND status IN ('cancelled','returned')", orderId)) {
    await run('INSERT INTO dropship_refunds (line_id, amount_ngn, reference, note, created_by, created) VALUES (?,?,?,?,?,?) ON CONFLICT (line_id) DO NOTHING', l.id, l.refund_due || 0, '', 'Order refunded', str(actor, 80) || 'system', now());
    await run("UPDATE dropship_lines SET status='refunded', refund_due=0, updated=? WHERE id=?", now(), l.id);
    await run('INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, created) VALUES (?,?,?,?,?,?)', l.id, l.status, 'refunded', 'Order refunded', str(actor, 80) || 'system', now());
  }
}
// Money for one item goes back by hand (Paystack or Stripe dashboard, or bank). This records that it was done.
// amount (optional) is what was really sent back, up to what the customer paid for the item. It is kept for the profit report.
async function recordRefund(lineId, { reference, note, actor, amount }) {
  return tx(async () => {
    const l = await get('SELECT status, refund_due, sell_price, qty FROM dropship_lines WHERE id = ? FOR UPDATE', int(lineId));
    if (!l) fail(404, 'Item not found.');
    if (l.status === 'refunded') return { line: l, unchanged: true };
    if (!['cancelled', 'returned'].includes(l.status)) fail(409, 'Only a cancelled or returned item can be marked refunded.');
    let amt = l.refund_due || 0;
    if (amount !== undefined && amount !== null && amount !== '') {
      amt = Math.round(Number(amount));
      if (!Number.isFinite(amt) || amt < 0 || amt > l.sell_price * l.qty) fail(400, `The refund must be from 0 to ${S.naira(l.sell_price * l.qty)}, what the customer paid for this item.`);
    }
    await run('INSERT INTO dropship_refunds (line_id, amount_ngn, reference, note, created_by, created) VALUES (?,?,?,?,?,?) ON CONFLICT (line_id) DO NOTHING', int(lineId), amt, str(reference, 80), str(note, 200), str(actor, 80), now());
    return transition(lineId, 'refunded', { actor, note: note || 'Refund recorded', fields: { refund_reference: reference }, key: 'refund:' + lineId });
  });
}

/* ---------- customer view ---------- */
async function shipments(orderId, full) {
  const rows = await all(`SELECT l.*, oi.name, oi.variant_label, oi.image, oi.emoji FROM dropship_lines l JOIN order_items oi ON oi.id = l.order_item_id WHERE l.order_id = ? ORDER BY l.id`, orderId);
  const out = [];
  for (const l of rows) {
    const alt = l.status === 'issue' && l.alt_product_id ? await get('SELECT id, slug, name, images, emoji FROM products WHERE id = ?', l.alt_product_id) : null;
    out.push({
      id: Number(l.id), name: l.name, variant_label: l.variant_label, qty: l.qty, emoji: l.emoji, image: l.image,
      status: l.status, label: LABEL[l.status], stage: STAGES.indexOf(l.status), stages: STAGES.map((s) => LABEL[s]),
      carrier: full ? l.carrier : '', tracking_no: full ? l.tracking_no : '', tracking_url: full ? l.tracking_url : '',
      needs_choice: l.status === 'issue' && !l.customer_choice, issue: l.status === 'issue' ? (ISSUE_TEXT[l.issue_kind] || '') : '',
      alternative: alt ? { name: alt.name, slug: alt.slug, image: S.parseImages(alt.images)[0] || '', emoji: alt.emoji } : null,
      refund_due: l.refund_due || 0,
      history: (await all('SELECT to_status, created FROM dropship_events WHERE line_id = ? ORDER BY id', l.id)).map((e) => ({ label: LABEL[e.to_status], at: Number(e.created) })),
    });
  }
  return out;
}
async function lineOf(order, lineId) {
  const l = await get('SELECT * FROM dropship_lines WHERE id = ? AND order_id = ?', int(lineId), order.id);
  if (!l) fail(404, 'Item not found.');
  return l;
}
const alertAdmin = async (subject, html) => { try { const st = await S.getSettings(); if (st.contact_email) await S.queueMail(st.contact_email, subject, S.mailWrap(st, html)); } catch (e) { console.error('Admin alert failed:', e.message); } };
// The customer decides: a full refund of the item, or the alternative we offered (same price: they are never charged more).
async function choose(order, lineId, choice) {
  const l = await lineOf(order, lineId);
  if (l.status !== 'issue') fail(409, 'There is nothing to decide for this item.');
  if (choice === 'refund') {
    const r = await transition(l.id, 'cancelled', { actor: 'customer', note: 'The customer chose a full refund', key: 'choice:' + l.issue_kind + ':' + l.updated });
    await run("UPDATE dropship_lines SET customer_choice='refund' WHERE id=?", l.id);
    await alertAdmin(`Refund chosen: ${order.ref}`, `<p>${esc(order.name)} chose a full refund for an item on order <b>${esc(order.ref)}</b> (${S.naira(l.sell_price * l.qty)}). Please refund them and record it under Dropshipping > Supplier orders.</p>`);
    return r;
  }
  if (choice !== 'alternative') fail(400, 'Choose a refund or the alternative.');
  if (!l.alt_product_id) fail(409, 'No alternative has been offered for this item.');
  const r = await applyAlternative(l, 'customer');
  await alertAdmin(`Alternative accepted: ${order.ref}`, `<p>${esc(order.name)} accepted the alternative for an item on order <b>${esc(order.ref)}</b>. It is back in the queue to order from the supplier.</p>`);
  return r;
}
// The alternative replaces the item on the order at the ORIGINAL price and quantity, so the total the customer paid does not change.
async function applyAlternative(l, actor) {
  const p = await altProduct(l.alt_product_id, l.product_id);
  await tx(async () => {
    const cur = await get('SELECT status, alt_product_id FROM dropship_lines WHERE id = ? FOR UPDATE', l.id);
    if (cur.status !== 'issue' || !cur.alt_product_id) fail(409, 'This item has already been dealt with.');
    const imgs = S.parseImages(p.images);
    await run("UPDATE order_items SET product_id=?, variant_id=NULL, name=?, variant_label='', emoji=?, image=? WHERE id=?", p.id, p.name, p.emoji, imgs[0] || '', l.order_item_id);
    let rates = null, costNgn = null, costRate = null;
    try { rates = await require('./dropship').rates(); costNgn = Math.round(FX.toNaira((Number(p.cost) + Number(p.ship_cost)) * l.qty, p.currency, rates)); costRate = FX.toNaira(1, p.currency, rates); } catch { /* unknown */ }
    await run("UPDATE dropship_lines SET product_id=?, supplier_id=?, unit_cost=?, ship_cost=?, cost_currency=?, cost_ngn=?, cost_fx_rate=?, supplier_sku=?, customer_choice='alternative', updated=? WHERE id=?", p.id, p.supplier_id, p.cost, p.ship_cost, p.currency, costNgn, costRate, p.supplier_sku, now(), l.id);
  });
  return transition(l.id, 'paid', { actor, note: `Replaced with ${p.name} at the original price`, key: 'alt:' + l.alt_product_id + ':' + l.updated });
}
async function altProduct(id, notId) {
  const p = await get(`SELECT p.id, p.name, p.images, p.emoji, p.price, dp.supplier_id, dp.cost, dp.ship_cost, dp.supplier_sku, s.currency FROM products p JOIN dropship_products dp ON dp.product_id = p.id JOIN suppliers s ON s.id = dp.supplier_id
    WHERE p.id = ? AND p.active = 1 AND p.listing = 'approved' AND s.status = 'active' AND (dp.supplier_stock IS NULL OR dp.supplier_stock > 0)`, int(id));
  if (!p || Number(p.id) === Number(notId)) fail(400, 'That product cannot be offered: it must be an active dropship product that is in stock with an active supplier.');
  return p;
}
async function proposeAlternative(lineId, productId, actor) {
  const l = await get('SELECT * FROM dropship_lines WHERE id = ?', int(lineId));
  if (!l) fail(404, 'Item not found.');
  if (l.status !== 'issue') fail(409, 'An alternative can only be offered while the item is waiting for the customer.');
  const p = await altProduct(productId, l.product_id);
  await run('UPDATE dropship_lines SET alt_product_id = ?, updated = ? WHERE id = ?', p.id, now(), l.id);
  await run('INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, created) VALUES (?,?,?,?,?,?)', l.id, 'issue', 'issue', `Offered ${p.name} as an alternative`, str(actor, 80), now());
  let loss = false;
  try { const rates = await require('./dropship').rates(); loss = Math.round(FX.toNaira((Number(p.cost) + Number(p.ship_cost)) * l.qty, p.currency, rates)) > l.sell_price * l.qty; } catch { /* unknown */ }
  const o = await S.loadOrder('id=?', l.order_id);
  await lineMail({ o }, { ...l, alt_product_id: p.id, status: 'issue' }, 'issue', true).catch(() => {});
  return { alternative: { id: Number(p.id), name: p.name }, loses_money: loss };
}

/* ---------- emails to the customer ---------- */
async function lineMail({ o }, l, from, proposed) {
  const st = await S.getSettings(), link = `${S.BASE_URL}/order/${o.ref}?t=${o.access_token}`, item = (await get('SELECT name FROM order_items WHERE id = ?', l.order_item_id)).name;
  const hi = `<p>Hi ${esc(String(o.name).split(' ')[0])},</p>`, go = `<p><a href="${link}">Open your order</a></p>`;
  let subject, body;
  if (l.status === 'shipped' && from !== 'shipped') {
    subject = `Order ${o.ref}: ${item} has shipped`;
    body = `${hi}<p><b>${esc(item)}</b> is on its way.</p><p>Carrier: <b>${esc(l.carrier)}</b><br>Tracking number: <b>${esc(l.tracking_no)}</b>${l.tracking_url ? `<br><a href="${esc(l.tracking_url)}">Track this parcel</a>` : ''}</p>${go}`;
  } else if (l.status === 'delivered') { subject = `Order ${o.ref}: ${item} was delivered`; body = `${hi}<p><b>${esc(item)}</b> has been delivered. Thank you!</p>${go}`; }
  else if (l.status === 'customs') { subject = `Order ${o.ref}: ${item} is clearing customs`; body = `${hi}<p><b>${esc(item)}</b> has reached customs in your country. It continues as soon as it is cleared.</p>${go}`; }
  else if (l.status === 'issue') {
    subject = proposed ? `Order ${o.ref}: an alternative for ${item}` : `Order ${o.ref}: we need your decision about ${item}`;
    body = `${hi}<p>${esc(ISSUE_TEXT[l.issue_kind] || 'There is a problem with this item.')} <b>${esc(item)}</b> is affected, and we are sorry.</p><p>You can choose <b>a full refund</b> for this item${l.alt_product_id ? ' or <b>the alternative we found, at the same price you paid</b>' : ''}. Please choose on your order page:</p>${go}`;
  } else if (l.status === 'cancelled') { subject = `Order ${o.ref}: ${item} was cancelled`; body = `${hi}<p><b>${esc(item)}</b> was cancelled.${l.refund_due ? ` We will refund ${S.naira(l.refund_due)} to your original payment method.` : ''}</p>${go}`; }
  else if (l.status === 'refunded') { subject = `Order ${o.ref}: refund sent`; body = `${hi}<p>Your refund for <b>${esc(item)}</b> has been sent. Banks can take a few days to show it.</p>${go}`; }
  else return;
  await S.queueMail(o.email, subject, S.mailWrap(st, body));
}

/* ---------- purchase orders ---------- */
const fmtMoney = (n, cur) => `${Number(n).toFixed(2)} ${cur}`;
async function poData(poId) {
  const po = await get('SELECT * FROM supplier_orders WHERE id = ?', int(poId));
  if (!po) fail(404, 'Purchase order not found.');
  const sup = await get('SELECT * FROM suppliers WHERE id = ?', po.supplier_id), o = await S.loadOrder('id=?', po.order_id);
  const lines = await all(`SELECT l.*, oi.name, oi.variant_label FROM dropship_lines l JOIN order_items oi ON oi.id = l.order_item_id WHERE l.po_id = ? ORDER BY l.id`, po.id);
  return { po, sup, o, lines, store: await S.getSettings() };
}
// The words of the order. Only what the supplier needs to ship the parcel: no customer email, no price the customer paid, no other customers.
function poLines({ po, sup, o, lines, store }) {
  const cur = po.currency, dest = C.countryName(o.country || 'NG');
  const ship = [o.name, [o.address, o.landmark].filter(Boolean).join(', '), [o.city, o.state].filter(Boolean).join(', ') + (o.postcode ? ' ' + o.postcode : ''), dest, 'Phone: ' + o.phone].filter(Boolean);
  const rows = lines.map((l, i) => ({ n: i + 1, sku: l.supplier_sku || '-', name: l.name + (l.variant_label ? ' (' + l.variant_label + ')' : ''), qty: l.qty, unit: Number(l.unit_cost), ship: Number(l.ship_cost), total: (Number(l.unit_cost) + Number(l.ship_cost)) * l.qty }));
  return { cur, ship, rows, total: rows.reduce((a, r) => a + r.total, 0), dest, store };
}
function poText(d) {
  const { po, sup } = d, x = poLines(d);
  const t = [`PURCHASE ORDER ${po.ref}`, `From: ${x.store.store_name}`, `To: ${sup.name}${sup.contact_name ? ' (attn ' + sup.contact_name + ')' : ''}`, `Date: ${new Date().toISOString().slice(0, 10)}`, '',
    'Please supply the items below and ship them DIRECTLY to the customer. Do not put any invoice, price list or promotion in the parcel.', '', 'SHIP TO:', ...x.ship, '', 'ITEMS:'];
  for (const r of x.rows) t.push(`${r.n}. [${r.sku}] ${r.name} x ${r.qty} @ ${fmtMoney(r.unit, x.cur)}${r.ship ? ' + shipping ' + fmtMoney(r.ship, x.cur) + ' each' : ''} = ${fmtMoney(r.total, x.cur)}`);
  t.push('', `TOTAL: ${fmtMoney(x.total, x.cur)}`, `Payment terms: ${sup.payment_terms || 'as agreed'}`, '', `Please reply with your order number, and the carrier and tracking number when it ships. Quote ${po.ref}.`,
    `Contact: ${[x.store.contact_email, x.store.contact_phone].filter(Boolean).join(' / ')}`);
  return t.join('\n');
}
function poPdf(d) {
  const { po, sup } = d, x = poLines(d), b = [];
  b.push({ text: 'PURCHASE ORDER', font: 'HB', size: 18, gap: 2 }, { text: po.ref, font: 'HB', size: 12, gap: 10 });
  b.push({ text: `From: ${x.store.store_name}`, font: 'HB' }, { text: [x.store.address, x.store.contact_email, x.store.contact_phone].filter(Boolean).join('\n'), gap: 8 });
  b.push({ text: `To: ${sup.name}`, font: 'HB' }, { text: [sup.contact_name && 'Attn: ' + sup.contact_name, sup.address, C.countryName(sup.country), sup.email].filter(Boolean).join('\n'), gap: 8 });
  b.push({ text: `Date: ${new Date().toISOString().slice(0, 10)}     Currency: ${x.cur}`, gap: 8 });
  b.push({ text: 'SHIP DIRECTLY TO (the customer)', font: 'HB' }, { text: x.ship.join('\n'), gap: 4 }, { text: 'Please do not include any invoice, price list or promotion in the parcel.', gap: 10 });
  b.push({ text: 'No  SKU            Description                          Qty   Unit price     Total', font: 'C', size: 8 });
  for (const r of x.rows) b.push({ text: `${String(r.n).padEnd(3)} ${r.sku.slice(0, 14).padEnd(14)} ${r.name.slice(0, 34).padEnd(34)} ${String(r.qty).padStart(3)} ${r.unit.toFixed(2).padStart(12)} ${r.total.toFixed(2).padStart(10)}`, font: 'C', size: 8, gap: 1 });
  b.push({ text: `TOTAL: ${fmtMoney(x.total, x.cur)}`, font: 'HB', size: 12, gap: 8 });
  b.push({ text: `Payment terms: ${sup.payment_terms || 'as agreed'}`, gap: 6 }, { text: `Please reply with your order number, and the carrier and tracking number when the parcel ships. Quote ${po.ref}.`, gap: 4 });
  return PDF.build(b, { title: po.ref });
}
async function buildPO(orderId, supplierId, actor) {
  return tx(async () => {
    const o = await get('SELECT id, payment_status, status FROM orders WHERE id = ? FOR UPDATE', int(orderId));
    if (!o) fail(404, 'Order not found.');
    if (o.payment_status !== 'paid' || o.status === 'cancelled') fail(409, 'This order has not been paid, so nothing can be ordered from the supplier. Never order before payment is confirmed.');
    const sup = await get('SELECT * FROM suppliers WHERE id = ?', int(supplierId));
    if (!sup) fail(404, 'Supplier not found.');
    if (sup.status !== 'active') fail(409, 'This supplier is paused. Un-pause the supplier, or cancel the items.');
    const lines = await all("SELECT * FROM dropship_lines WHERE order_id = ? AND supplier_id = ? AND status = 'paid' AND po_id IS NULL ORDER BY id FOR UPDATE", o.id, sup.id);
    if (!lines.length) fail(409, 'Nothing is waiting to be ordered from this supplier for that order.');
    const cur = sup.currency, total = lines.reduce((a, l) => a + (Number(l.unit_cost) + Number(l.ship_cost)) * l.qty, 0);
    const r = await run('INSERT INTO supplier_orders (supplier_id, order_id, currency, total_cost, created, created_by) VALUES (?,?,?,?,?,?)', sup.id, o.id, lines.every((l) => l.cost_currency === cur) ? cur : cur, total, now(), str(actor, 80));
    const id = Number(r.lastInsertRowid), ref = 'PO-' + String(id).padStart(5, '0');
    await run('UPDATE supplier_orders SET ref = ? WHERE id = ?', ref, id);
    for (const l of lines) await run('UPDATE dropship_lines SET po_id = ?, updated = ? WHERE id = ?', id, now(), l.id);
    const d = await poData(id);
    await run('UPDATE supplier_orders SET body = ? WHERE id = ?', poText(d), id);
    return id;
  });
}
async function cancelPO(poId, actor) {
  await tx(async () => {
    const po = await get('SELECT * FROM supplier_orders WHERE id = ? FOR UPDATE', int(poId));
    if (!po) fail(404, 'Purchase order not found.');
    if (po.status === 'cancelled') return;
    if (po.status === 'sent') fail(409, 'This order was already sent to the supplier. Cancel the items instead, so the supplier is told.');
    await run("UPDATE supplier_orders SET status='cancelled' WHERE id = ?", po.id);
    await run("UPDATE dropship_lines SET po_id = NULL, updated = ? WHERE po_id = ? AND status = 'paid'", now(), po.id);
  });
}
// Sends (or records that you sent) the purchase order. Email carries the PDF. Marking it sent moves its items to "sent to supplier". Doing it twice does nothing.
async function sendPO(poId, via, actor) {
  const d = await poData(poId);
  if (d.po.status === 'cancelled') fail(409, 'This purchase order was cancelled.');
  if (d.po.status === 'sent') return { unchanged: true, po: d.po };
  if (!['email', 'whatsapp', 'manual'].includes(via)) fail(400, 'Choose how it was sent.');
  if (via === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.sup.email || '')) fail(400, 'This supplier has no email address. Add one, or send it by WhatsApp.');
    const st = d.store, text = d.po.body || poText(d);
    await S.queueMail(d.sup.email, `Purchase order ${d.po.ref} from ${st.store_name}`, S.mailWrap(st, `<p>Please find purchase order <b>${esc(d.po.ref)}</b> attached.</p><pre style="white-space:pre-wrap;font-family:inherit">${esc(text)}</pre>`), { filename: d.po.ref + '.pdf', content: poPdf(d).toString('base64') });
  }
  await tx(async () => {
    const po = await get('SELECT status FROM supplier_orders WHERE id = ? FOR UPDATE', d.po.id);
    if (po.status !== 'draft') return;
    await run("UPDATE supplier_orders SET status='sent', sent_via=?, sent_at=? WHERE id=?", via, now(), d.po.id);
    await require('./dropship-money').openPayable(d.po.id);
    for (const l of d.lines.filter((x) => x.status === 'paid')) await transition(l.id, 'sent', { actor, note: `Purchase order ${d.po.ref} sent by ${via}`, key: 'po:' + d.po.id + ':sent', fields: { po_id: d.po.id } });
  });
  return { unchanged: false, po: (await poData(poId)).po };
}
const waLink = (sup, text) => { const n = String(sup.whatsapp || '').replace(/\D/g, ''); return n.length >= 8 ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : ''; };

/* ---------- admin: queues and the watchdog ---------- */
const PLACE_HOURS = 24, CONFIRM_DAYS = 3, ANSWER_DAYS = 3;
function overdue(l, procDays) {
  const t = now();
  if (l.status === 'paid' && !l.po_id && l.paid_at && t - Number(l.paid_at) > PLACE_HOURS * 3600) return 'Paid more than a day ago and still not ordered from the supplier';
  if (l.status === 'sent' && l.sent_at && t - Number(l.sent_at) > CONFIRM_DAYS * 86400) return 'The supplier has not confirmed this order';
  if (l.status === 'confirmed' && l.sent_at && t - Number(l.sent_at) > (Number(procDays || 3) + CONFIRM_DAYS) * 86400) return 'Past the supplier\'s processing time and not shipped';
  if (l.status === 'issue' && !l.customer_choice && t - Number(l.updated) > ANSWER_DAYS * 86400) return 'The customer has not answered yet';
  return '';
}
const adminLine = (l) => ({
  id: Number(l.id), order_id: Number(l.order_id), order_ref: l.order_ref, status: l.status, qty: l.qty, name: l.name, variant_label: l.variant_label, product_id: Number(l.product_id), supplier_id: Number(l.supplier_id), supplier_name: l.supplier_name,
  supplier_sku: l.supplier_sku, po_id: l.po_id == null ? null : Number(l.po_id), po_ref: l.po_ref || '', po_status: l.po_status || '', supplier_order_no: l.supplier_order_no, carrier: l.carrier, tracking_no: l.tracking_no, tracking_url: l.tracking_url,
  issue_kind: l.issue_kind, issue_note: l.issue_note, alt_product_id: l.alt_product_id == null ? null : Number(l.alt_product_id), customer_choice: l.customer_choice, refund_due: l.refund_due, refund_reference: l.refund_reference,
  sell_total: l.sell_price * l.qty, unit_cost: Number(l.unit_cost), ship_cost: Number(l.ship_cost), cost_currency: l.cost_currency, cost_ngn: l.cost_ngn,
  paid_at: l.paid_at == null ? null : Number(l.paid_at), sent_at: l.sent_at == null ? null : Number(l.sent_at), updated: Number(l.updated), overdue: overdue(l, l.processing_days),
  next: NEXT[l.status] || [],
});
const LINE_SQL = `SELECT l.*, oi.name, oi.variant_label, o.ref AS order_ref, o.name AS customer_name, o.country AS customer_country, s.name AS supplier_name, s.processing_days, po.ref AS po_ref, po.status AS po_status
  FROM dropship_lines l JOIN order_items oi ON oi.id = l.order_item_id JOIN orders o ON o.id = l.order_id JOIN suppliers s ON s.id = l.supplier_id LEFT JOIN supplier_orders po ON po.id = l.po_id`;
async function queue() {
  const ready = await all(`${LINE_SQL} WHERE l.status = 'paid' AND l.po_id IS NULL AND o.payment_status = 'paid' AND o.status <> 'cancelled' ORDER BY l.paid_at, l.id`);
  const groups = new Map();
  for (const l of ready) {
    const k = l.order_id + ':' + l.supplier_id;
    if (!groups.has(k)) groups.set(k, { order_id: Number(l.order_id), order_ref: l.order_ref, customer_name: l.customer_name, country: l.customer_country, supplier_id: Number(l.supplier_id), supplier_name: l.supplier_name, lines: [] });
    groups.get(k).lines.push(adminLine(l));
  }
  const open = await all(`${LINE_SQL} WHERE NOT (l.status = ANY(?)) AND NOT (l.status = 'paid' AND l.po_id IS NULL) AND l.status <> 'pending_payment' ORDER BY l.updated DESC LIMIT 300`, TERMINAL);
  const refunds = await all(`${LINE_SQL} WHERE l.status IN ('cancelled','returned') AND l.refund_due > 0 ORDER BY l.updated DESC LIMIT 100`);
  const drafts = await all("SELECT po.id, po.ref, po.status, po.currency, po.total_cost, s.name AS supplier_name, o.ref AS order_ref FROM supplier_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN orders o ON o.id = po.order_id WHERE po.status = 'draft' ORDER BY po.id DESC LIMIT 100");
  const act = open.map(adminLine);
  return { ready: [...groups.values()], drafts: drafts.map((d) => ({ ...d, id: Number(d.id), total_cost: Number(d.total_cost) })), active: act, refunds: refunds.map(adminLine), overdue: act.filter((x) => x.overdue).length + [...groups.values()].filter((g) => g.lines.some((x) => x.overdue)).length };
}
async function lineDetail(id) {
  const l = (await all(`${LINE_SQL} WHERE l.id = ?`, int(id)))[0];
  if (!l) fail(404, 'Item not found.');
  return { line: adminLine(l), events: (await all('SELECT from_status, to_status, note, actor, created FROM dropship_events WHERE line_id = ? ORDER BY id', l.id)).map((e) => ({ ...e, created: Number(e.created) })) };
}
// Checks for orders that are stuck and emails the shop owner one digest (at most every 12 hours).
async function watch() {
  const q = await queue();
  const stuck = [...q.ready.flatMap((g) => g.lines), ...q.active].filter((l) => l.overdue);
  if (!stuck.length) return { stuck: 0 };
  const last = await get("SELECT value FROM dropship_settings WHERE key = 'last_digest'");
  if (last && now() - Number(last.value) < 12 * 3600) return { stuck: stuck.length, emailed: false };
  await run("INSERT INTO dropship_settings (key, value) VALUES ('last_digest', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", String(now()));
  await alertAdmin(`${stuck.length} supplier order(s) need attention`, `<p>These dropship items are stuck:</p><ul>${stuck.slice(0, 30).map((l) => `<li>${esc(l.order_ref)}: ${esc(l.name)} (${esc(l.supplier_name)}). ${esc(l.overdue)}</li>`).join('')}</ul><p>Open Dropshipping > Supplier orders.</p>`);
  return { stuck: stuck.length, emailed: true };
}

module.exports = { alertAdmin, NEXT, STATES, TERMINAL, STAGES, LABEL, allowed, flagOn, createLines, transition, syncOrder, onPaid, cancelLinesForOrder, markRefunded, recordRefund, shipments, choose, proposeAlternative, applyAlternative, buildPO, cancelPO, sendPO, poData, poText, poPdf, waLink, queue, lineDetail, overdue, watch };
