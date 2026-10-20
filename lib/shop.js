'use strict';
// Business logic: settings, cart pricing, orders, stock, email, Paystack.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const PAYSTACK_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Shop-Beta <onboarding@resend.dev>';
const TZ_OFFSET = Math.round(Number(process.env.TZ_OFFSET_HOURS ?? 1) * 3600);

/* ---------- small helpers ---------- */
const str = (v, max = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');
const int = (v, d = 0) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : d; };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const isEmail = (s) => EMAIL_RE.test(s) && s.length <= 120;
const parseImages = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; } };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (n) => '₦' + Number(n || 0).toLocaleString('en-NG');
const todayISO = () => new Date(Date.now() + TZ_OFFSET * 1000).toISOString().slice(0, 10);
const dayStart = (t) => Math.floor((t + TZ_OFFSET) / 86400) * 86400 - TZ_OFFSET;

const getSettings = () => Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
const paystackLive = () => !!PAYSTACK_KEY;

/* ---------- products ---------- */
const RATING_JOIN = 'LEFT JOIN (SELECT product_id, AVG(rating) r, COUNT(*) n FROM reviews WHERE approved=1 GROUP BY product_id) rv ON rv.product_id = p.id';
const offPct = (p) => (p.compare_price > p.price ? Math.round(((p.compare_price - p.price) / p.compare_price) * 100) : 0);
const card = (p) => ({
  id: p.id, slug: p.slug, name: p.name, brand: p.brand, image: parseImages(p.images)[0] || '', emoji: p.emoji,
  price: p.price, compare_price: p.compare_price, off: offPct(p), new_arrival: p.new_arrival, stock: p.stock,
  rating: Math.round((p.rating || 0) * 10) / 10, rating_n: p.rating_n || 0,
});

/* ---------- delivery ---------- */
function deliveryFor(S, zone, discounted, selected) {
  if (!zone) return {};
  const threshold = int(S.free_shipping_threshold);
  const free = threshold > 0 && discounted >= threshold;
  const mult = Math.max(1, Number(S.express_multiplier) || 1.5);
  const options = {
    standard: { label: 'Standard delivery', fee: free ? 0 : zone.fee, eta: zone.eta },
    express: { label: 'Express delivery', fee: Math.max(zone.fee, Math.round((zone.fee * mult) / 50) * 50), eta: 'Priority dispatch, faster than standard' },
  };
  if (S.pickup_address) options.pickup = { label: 'Store pickup', fee: 0, eta: 'Ready within a few hours. ' + S.pickup_address };
  const sel = options[selected] ? selected : 'standard';
  return { options, selected: sel, fee: options[sel].fee, free, threshold: free ? 0 : threshold };
}

/* ---------- cart pricing (the only place prices are decided) ---------- */
function priceCart({ items, coupon, state, delivery }) {
  const S = getSettings();
  const lines = [], issues = [], merged = new Map();
  for (const it of (Array.isArray(items) ? items : []).slice(0, 60)) {
    const pid = int(it && it.productId), vid = it && it.variantId ? int(it.variantId) : null, qty = int(it && it.qty);
    if (pid <= 0 || qty < 1) continue;
    const k = pid + ':' + (vid || 0); const cur = merged.get(k);
    merged.set(k, { pid, vid, qty: Math.min(99, (cur ? cur.qty : 0) + qty) });
  }
  for (const { pid, vid, qty } of merged.values()) {
    const p = get('SELECT * FROM products WHERE id=? AND active=1', pid);
    if (!p) { issues.push({ productId: pid, message: 'An item in your cart is no longer available.' }); continue; }
    const hasVariants = !!get('SELECT 1 x FROM variants WHERE product_id=? LIMIT 1', pid);
    let v = null, avail = p.stock, label = '';
    if (hasVariants) {
      v = vid ? get('SELECT * FROM variants WHERE id=? AND product_id=?', vid, pid) : null;
      if (!v) { issues.push({ productId: pid, message: `${p.name} is no longer available in that option.` }); continue; }
      avail = v.stock; label = [v.size, v.color].filter(Boolean).join(' · ');
    }
    if (avail <= 0) { issues.push({ productId: pid, message: `${p.name} is sold out and no longer available.` }); continue; }
    let q = qty;
    if (q > avail) { q = avail; issues.push({ productId: pid, message: `Only ${avail} of ${p.name} available. We adjusted your quantity.` }); }
    lines.push({ productId: pid, variantId: v ? v.id : null, slug: p.slug, name: p.name, variantLabel: label, price: p.price, qty: q, available: avail, emoji: p.emoji, image: parseImages(p.images)[0] || '' });
  }
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);

  let discount = 0, couponCode = '', couponError = '';
  const code = str(coupon, 40);
  if (code) {
    const c = get('SELECT * FROM coupons WHERE code = ?', code);
    if (!c || !c.active) couponError = 'That promo code is not valid.';
    else if (c.expires_at && c.expires_at < todayISO()) couponError = 'That promo code has expired.';
    else if (c.max_uses > 0 && c.used >= c.max_uses) couponError = 'That promo code has been fully used.';
    else if (subtotal < c.min_spend) couponError = `Spend at least ${naira(c.min_spend)} to use ${c.code}.`;
    else if (!lines.length) couponError = '';
    else { discount = c.type === 'percent' ? Math.floor((subtotal * Math.min(100, c.value)) / 100) : Math.min(c.value, subtotal); couponCode = c.code; }
  }
  const zone = state ? get('SELECT * FROM zones WHERE state = ?', str(state, 60)) : null;
  const dl = deliveryFor(S, zone, subtotal - discount, delivery);
  const total = subtotal - discount + (dl.options ? dl.fee : 0);
  return { lines, subtotal, discount, coupon: couponCode, couponError, issues, delivery: dl, total, zone };
}

/* ---------- stock ---------- */
function recalcStock(pid) {
  if (get('SELECT 1 x FROM variants WHERE product_id=? LIMIT 1', pid)) run('UPDATE products SET stock = (SELECT COALESCE(SUM(stock),0) FROM variants WHERE product_id=?) WHERE id=?', pid, pid);
}
function takeStock(line) {
  const r = line.variantId
    ? run('UPDATE variants SET stock = stock - ? WHERE id=? AND stock >= ?', line.qty, line.variantId, line.qty)
    : run('UPDATE products SET stock = stock - ? WHERE id=? AND stock >= ?', line.qty, line.productId, line.qty);
  if (r.changes !== 1) fail(409, `Sorry, ${line.name} just sold out. Please update your cart.`);
  recalcStock(line.productId);
  run('UPDATE products SET sold = sold + ? WHERE id=?', line.qty, line.productId);
}
function returnStock(order) {
  for (const i of all('SELECT * FROM order_items WHERE order_id=?', order.id)) {
    if (i.variant_id) run('UPDATE variants SET stock = stock + ? WHERE id=?', i.qty, i.variant_id);
    else run('UPDATE products SET stock = stock + ? WHERE id=?', i.qty, i.product_id);
    recalcStock(i.product_id);
    run('UPDATE products SET sold = MAX(0, sold - ?) WHERE id=?', i.qty, i.product_id);
  }
  if (order.coupon) run('UPDATE coupons SET used = MAX(0, used - 1) WHERE code = ?', order.coupon);
}

/* ---------- orders ---------- */
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRef() {
  for (let n = 0; n < 20; n++) {
    let r = 'SB-'; const b = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) r += REF_CHARS[b[i] % REF_CHARS.length];
    if (!get('SELECT 1 x FROM orders WHERE ref=?', r)) return r;
  }
  return 'SB-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}
const addEvent = (orderId, status, note = '') => run('INSERT INTO order_events (order_id,status,note,created) VALUES (?,?,?,?)', orderId, status, note, now());

function loadOrder(where, ...args) {
  const o = get(`SELECT * FROM orders WHERE ${where}`, ...args);
  if (!o) return null;
  o.items = all('SELECT * FROM order_items WHERE order_id=? ORDER BY id', o.id);
  o.events = all('SELECT status, note, created FROM order_events WHERE order_id=? ORDER BY id', o.id);
  return o;
}
// What a customer is allowed to see: no internal ids beyond what the pages need.
function publicOrder(o) {
  return {
    ref: o.ref, status: o.status, payment_method: o.payment_method, payment_status: o.payment_status, created: o.created,
    name: o.name, phone: o.phone, state: o.state, city: o.city, address: o.address, delivery: o.delivery, delivery_fee: o.delivery_fee,
    subtotal: o.subtotal, discount: o.discount, coupon: o.coupon, total: o.total,
    items: o.items.map((i) => ({ product_id: i.product_id, name: i.name, variant_label: i.variant_label, price: i.price, qty: i.qty, emoji: i.emoji, image: i.image })),
    events: o.events,
  };
}

function createOrder(body, user) {
  const contact = body.contact || {}, addr = body.address || {};
  const name = str(contact.name, 80), email = str(contact.email, 120).toLowerCase(), phone = str(contact.phone, 30);
  if (!name || !isEmail(email)) fail(400, 'Please enter your name and a valid email address.');
  if (phone.replace(/\D/g, '').length < 7) fail(400, 'Please enter a valid phone number.');
  const state = str(addr.state, 60);
  const zone = get('SELECT * FROM zones WHERE state=?', state);
  if (!zone) fail(400, 'Please choose your delivery state.');
  const S = getSettings();
  const delivery = ['standard', 'express', 'pickup'].includes(body.delivery) ? body.delivery : 'standard';
  if (delivery === 'pickup' && !S.pickup_address) fail(400, 'Store pickup is not available.');
  const address = str(addr.address, 200), city = str(addr.city, 60);
  if (delivery !== 'pickup' && address.length < 4) fail(400, 'Please enter your street address.');
  const method = body.payment === 'pod' ? 'pod' : body.payment === 'paystack' ? 'paystack' : '';
  if (method === 'pod' && (S.pod_enabled !== '1' || !zone.pod || delivery === 'pickup')) fail(400, 'Pay on delivery is not available for this order. Please pay online.');
  if (method === 'paystack' && S.paystack_enabled !== '1') fail(400, 'Online payment is not available right now.');
  if (!method) fail(400, 'Please choose a payment method.');

  const priced = priceCart({ items: body.items, coupon: body.coupon, state, delivery });
  if (!priced.lines.length) fail(400, priced.issues[0] ? priced.issues[0].message : 'Your cart is empty.');
  if (priced.couponError) fail(400, priced.couponError);
  if (priced.issues.some((i) => /sold out|no longer available/.test(i.message))) fail(409, priced.issues[0].message);

  return tx(() => {
    for (const l of priced.lines) takeStock(l);
    const ref = newRef(), t = now();
    const r = run(`INSERT INTO orders (ref,user_id,status,payment_method,payment_status,name,email,phone,state,city,address,notes,delivery,delivery_fee,subtotal,discount,coupon,total,created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ref, user ? user.id : null, 'pending', method, 'unpaid', name, email, phone, state, city, delivery === 'pickup' ? '' : address, str(body.notes, 300),
      delivery, priced.delivery.fee || 0, priced.subtotal, priced.discount, priced.coupon, priced.total, t);
    const oid = Number(r.lastInsertRowid);
    for (const l of priced.lines) run('INSERT INTO order_items (order_id,product_id,variant_id,name,variant_label,price,qty,emoji,image) VALUES (?,?,?,?,?,?,?,?,?)', oid, l.productId, l.variantId, l.name, l.variantLabel, l.price, l.qty, l.emoji, l.image);
    if (priced.coupon) run('UPDATE coupons SET used = used + 1 WHERE code = ?', priced.coupon);
    addEvent(oid, 'pending', method === 'pod' ? 'Order placed. Pay on delivery.' : 'Order placed. Waiting for payment.');
    run('DELETE FROM abandoned WHERE email = ?', email);
    return loadOrder('id=?', oid);
  });
}

function cancelOrder(order, note) {
  if (order.status === 'cancelled') return;
  tx(() => {
    run("UPDATE orders SET status='cancelled' WHERE id=?", order.id);
    returnStock(order);
    addEvent(order.id, 'cancelled', note || 'Order cancelled');
  });
}

function markPaid(order, paystackRef, note) {
  if (order.payment_status === 'paid') return false;
  tx(() => {
    run("UPDATE orders SET payment_status='paid', paystack_ref=? WHERE id=?", paystackRef || order.paystack_ref, order.id);
    if (order.status === 'pending') { run("UPDATE orders SET status='paid' WHERE id=?", order.id); addEvent(order.id, 'paid', note || 'Payment received'); }
    else if (order.status === 'cancelled') addEvent(order.id, 'cancelled', 'Payment arrived after this order was cancelled. Please refund the customer.');
    else addEvent(order.id, order.status, note || 'Payment received');
  });
  const fresh = loadOrder('id=?', order.id);
  if (fresh.status === 'paid') mailOrderPaid(fresh);
  return true;
}

/* ---------- Paystack ---------- */
async function paystackInitialize(order) {
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST', headers: { Authorization: 'Bearer ' + PAYSTACK_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: order.email, amount: order.total * 100, currency: 'NGN', reference: order.ref, callback_url: `${BASE_URL}/order/${order.ref}`, metadata: { order_id: order.id, name: order.name } }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.status || !d.data || !d.data.authorization_url) throw new HttpError(502, 'We could not start the payment. Please try again or choose pay on delivery.');
  return d.data.authorization_url;
}
async function paystackVerify(ref) {
  const res = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(ref), { headers: { Authorization: 'Bearer ' + PAYSTACK_KEY }, signal: AbortSignal.timeout(15000) });
  const d = await res.json().catch(() => ({}));
  return res.ok && d.status ? d.data : null;
}
// Confirms with Paystack that the money for this order really arrived, then marks it paid.
async function settleWithPaystack(ref) {
  const order = loadOrder('ref=?', ref);
  if (!order || order.payment_method !== 'paystack') return null;
  if (order.payment_status === 'paid') return order;
  const data = await paystackVerify(ref);
  if (data && data.status === 'success' && data.currency === 'NGN' && Number(data.amount) === order.total * 100) markPaid(order, String(data.reference || ref));
  return loadOrder('ref=?', ref);
}
function verifyWebhookSignature(raw, sig) {
  if (!PAYSTACK_KEY || !raw || !sig) return false;
  const h = crypto.createHmac('sha512', PAYSTACK_KEY).update(raw).digest('hex');
  const a = Buffer.from(h), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- email (stored in the outbox; sent through Resend when a key is set) ---------- */
function queueMail(to, subject, html) {
  if (!to) return;
  const r = run('INSERT INTO outbox (to_email,subject,body,sent,created) VALUES (?,?,?,0,?)', to, subject, html, now());
  if (!RESEND_KEY) return;
  const id = Number(r.lastInsertRowid);
  fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }), signal: AbortSignal.timeout(15000),
  }).then((res) => { if (res.ok) run('UPDATE outbox SET sent=1 WHERE id=?', id); else console.error('Email not sent', res.status); }).catch((e) => console.error('Email error:', e.message));
}
const mailWrap = (S, inner) => `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#16181d"><h2 style="margin:0 0 12px">${esc(S.store_name)}</h2>${inner}<p style="color:#667085;font-size:12px;margin-top:24px">${esc(S.store_name)} · ${esc(S.contact_email)}</p></div>`;
const itemsHtml = (o) => `<table style="width:100%;border-collapse:collapse;font-size:14px">${o.items.map((i) => `<tr><td style="padding:6px 0">${esc(i.name)}${i.variant_label ? ' <span style="color:#667085">(' + esc(i.variant_label) + ')</span>' : ''} × ${i.qty}</td><td style="text-align:right">${naira(i.price * i.qty)}</td></tr>`).join('')}<tr><td style="padding-top:8px;color:#667085">Delivery</td><td style="text-align:right;padding-top:8px">${o.delivery_fee ? naira(o.delivery_fee) : 'Free'}</td></tr><tr><td><b>Total</b></td><td style="text-align:right"><b>${naira(o.total)}</b></td></tr></table>`;
const orderLink = (o) => `${BASE_URL}/order/${o.ref}?email=${encodeURIComponent(o.email)}`;
function mailOrderPlaced(o) {
  const S = getSettings();
  queueMail(o.email, `Your ${S.store_name} order ${o.ref}`, mailWrap(S, `<p>Hi ${esc(o.name.split(' ')[0])}, thank you for your order.</p><p>Order <b>${esc(o.ref)}</b> · ${o.payment_method === 'pod' ? 'Pay on delivery' : 'Online payment'}</p>${itemsHtml(o)}<p><a href="${esc(orderLink(o))}">Track your order</a></p>`));
  if (S.contact_email) queueMail(S.contact_email, `New order ${o.ref} (${naira(o.total)})`, mailWrap(S, `<p>New order from ${esc(o.name)} (${esc(o.phone)}), ${esc(o.state)}.</p>${itemsHtml(o)}<p>Payment: ${o.payment_method === 'pod' ? 'Pay on delivery' : 'Paystack'}</p><p><a href="${BASE_URL}/admin">Open the dashboard</a></p>`));
}
function mailOrderPaid(o) {
  const S = getSettings();
  queueMail(o.email, `Payment received for ${o.ref}`, mailWrap(S, `<p>Hi ${esc(o.name.split(' ')[0])}, we have received your payment of <b>${naira(o.total)}</b> for order <b>${esc(o.ref)}</b>. We are getting it ready.</p>${itemsHtml(o)}<p><a href="${esc(orderLink(o))}">View your order</a></p>`));
  if (S.contact_email) queueMail(S.contact_email, `Paid order ${o.ref} (${naira(o.total)})`, mailWrap(S, `<p>${esc(o.name)} (${esc(o.phone)}), ${esc(o.state)} has paid online.</p>${itemsHtml(o)}<p><a href="${BASE_URL}/admin">Open the dashboard</a></p>`));
}
function mailOrderStatus(o, status, note) {
  const S = getSettings();
  const words = { processing: 'is being prepared', shipped: 'is on its way', delivered: 'has been delivered', cancelled: 'has been cancelled' }[status];
  if (!words) return;
  queueMail(o.email, `Order ${o.ref} ${words.replace('is ', '').replace('has been ', '')}`, mailWrap(S, `<p>Hi ${esc(o.name.split(' ')[0])}, your order <b>${esc(o.ref)}</b> ${words}.</p>${note ? `<p>${esc(note)}</p>` : ''}<p><a href="${esc(orderLink(o))}">View your order</a></p>`));
}

module.exports = {
  HttpError, fail, BASE_URL, TZ_OFFSET, str, int, isEmail, parseImages, esc, naira, todayISO, dayStart, getSettings, paystackLive,
  RATING_JOIN, offPct, card, priceCart, recalcStock, createOrder, cancelOrder, markPaid, loadOrder, publicOrder, addEvent,
  paystackInitialize, settleWithPaystack, verifyWebhookSignature, queueMail, mailWrap, mailOrderPlaced, mailOrderStatus, returnStock,
};
