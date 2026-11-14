'use strict';
const PC = require('./pharmacy-core');
// Business logic: settings, cart pricing, orders, stock, email, Paystack.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const queue = require('./queue');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const PAYSTACK_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Shop-Beta <onboarding@resend.dev>';
const RESEND_URL = process.env.RESEND_API_URL || 'https://api.resend.com'; // overridden only by tests
const PAYSTACK_URL = process.env.PAYSTACK_API_URL || 'https://api.paystack.co';
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

const cache = require('./cache');
const getSettings = async () => ({ ...(await cache.cached('settings', 10000, async () => Object.fromEntries((await all("SELECT key, value FROM settings WHERE key NOT IN ('cache_version','handover_secret')")).map((r) => [r.key, r.value])))) }); // a copy, so callers can edit it freely
const paystackLive = () => !!PAYSTACK_KEY;
// Demo payments mark orders paid without any money. They exist for local testing only and are OFF in production unless explicitly allowed.
const demoAllowed = () => process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEMO_PAYMENTS === '1';

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
async function priceCart({ items, coupon, state, delivery }) {
  const S = await getSettings();
  const lines = [], issues = [], merged = new Map();
  for (const it of (Array.isArray(items) ? items : []).slice(0, 60)) {
    const pid = int(it && it.productId), vid = it && it.variantId ? int(it.variantId) : null, qty = int(it && it.qty);
    if (pid <= 0 || qty < 1) continue;
    const k = pid + ':' + (vid || 0); const cur = merged.get(k);
    merged.set(k, { pid, vid, qty: Math.min(99, (cur ? cur.qty : 0) + qty) });
  }
  for (const { pid, vid, qty } of merged.values()) {
    const p = await get(`SELECT p.* FROM products p WHERE p.id=? AND p.active=1 AND ${PC.visibleSql('p')}`, pid);
    if (!p) { issues.push({ productId: pid, message: 'An item in your cart is no longer available.' }); continue; }
    const hasVariants = !!(await get('SELECT 1 x FROM variants WHERE product_id=? LIMIT 1', pid));
    let v = null, avail = p.stock, label = '';
    if (hasVariants) {
      v = vid ? await get('SELECT * FROM variants WHERE id=? AND product_id=?', vid, pid) : null;
      if (!v) { issues.push({ productId: pid, message: `${p.name} is no longer available in that option.` }); continue; }
      avail = v.stock; label = [v.size, v.color].filter(Boolean).join(' · ');
    }
    if (avail <= 0) { issues.push({ productId: pid, message: `${p.name} is sold out and no longer available.` }); continue; }
    let q = qty;
    if (q > avail) { q = avail; issues.push({ productId: pid, message: `Only ${avail} of ${p.name} available. We adjusted your quantity.` }); }
    lines.push({ productId: pid, variantId: v ? v.id : null, slug: p.slug, name: p.name, variantLabel: label, price: p.price, qty: q, available: avail, emoji: p.emoji, image: parseImages(p.images)[0] || '', ...(p.is_pharmacy ? { pharm: true, rx: !!p.rx_required } : {}) });
  }
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);

  let discount = 0, couponCode = '', couponError = '';
  const code = str(coupon, 40);
  if (code) {
    const c = await get('SELECT * FROM coupons WHERE code = ?', code);
    if (!c || !c.active) couponError = 'That promo code is not valid.';
    else if (c.expires_at && c.expires_at < todayISO()) couponError = 'That promo code has expired.';
    else if (c.max_uses > 0 && c.used >= c.max_uses) couponError = 'That promo code has been fully used.';
    else if (subtotal < c.min_spend) couponError = `Spend at least ${naira(c.min_spend)} to use ${c.code}.`;
    else if (!lines.length) couponError = '';
    else { discount = c.type === 'percent' ? Math.floor((subtotal * Math.min(100, c.value)) / 100) : Math.min(c.value, subtotal); couponCode = c.code; }
  }
  const zone = state ? await get('SELECT * FROM zones WHERE state = ?', str(state, 60)) : null;
  const dl = deliveryFor(S, zone, subtotal - discount, delivery);
  const total = subtotal - discount + (dl.options ? dl.fee : 0);
  return { lines, subtotal, discount, coupon: couponCode, couponError, issues, delivery: dl, total, zone };
}

/* ---------- stock ---------- */
async function recalcStock(pid) {
  if (await get('SELECT 1 x FROM variants WHERE product_id=? LIMIT 1', pid)) await run('UPDATE products SET stock = (SELECT COALESCE(SUM(stock),0) FROM variants WHERE product_id=?) WHERE id=?', pid, pid);
}
async function takeStock(line) {
  const r = line.variantId
    ? await run('UPDATE variants SET stock = stock - ? WHERE id=? AND stock >= ?', line.qty, line.variantId, line.qty)
    : await run('UPDATE products SET stock = stock - ? WHERE id=? AND stock >= ?', line.qty, line.productId, line.qty);
  if (r.changes !== 1) fail(409, `Sorry, ${line.name} just sold out. Please update your cart.`);
  await recalcStock(line.productId);
  cache.drop('stock:' + line.productId); // the product page's short-lived stock copy on this instance (other instances catch up within 3 s)
  await run('UPDATE products SET sold = sold + ? WHERE id=?', line.qty, line.productId);
}
async function returnStock(order) {
  for (const i of await all('SELECT * FROM order_items WHERE order_id=?', order.id)) {
    if (i.variant_id) await run('UPDATE variants SET stock = stock + ? WHERE id=?', i.qty, i.variant_id);
    else await run('UPDATE products SET stock = stock + ? WHERE id=?', i.qty, i.product_id);
    await recalcStock(i.product_id);
    cache.drop('stock:' + i.product_id);
    await run('UPDATE products SET sold = GREATEST(0, sold - ?) WHERE id=?', i.qty, i.product_id);
  }
  if (order.coupon) await run('UPDATE coupons SET used = GREATEST(0, used - 1) WHERE code = ?', order.coupon);
}

/* ---------- orders ---------- */
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function newRef() {
  for (let n = 0; n < 20; n++) {
    let r = 'SB-'; const b = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) r += REF_CHARS[b[i] % REF_CHARS.length];
    if (!(await get('SELECT 1 x FROM orders WHERE ref=?', r))) return r;
  }
  return 'SB-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}
const addEvent = async (orderId, status, note = '') => run('INSERT INTO order_events (order_id,status,note,created) VALUES (?,?,?,?)', orderId, status, note, now());

async function loadOrder(where, ...args) {
  const o = await get(`SELECT * FROM orders WHERE ${where}`, ...args);
  if (!o) return null;
  o.items = await all('SELECT * FROM order_items WHERE order_id=? ORDER BY id', o.id);
  o.events = await all('SELECT status, note, created FROM order_events WHERE order_id=? ORDER BY id', o.id);
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
    pharmacy: o.is_pharmacy ? { rx_required: !!o.rx_required, rx_status: o.rx_status, temp_sensitive: !!o.temp_sensitive, held: !!o.pharm_hold, needs_payment: o.payment_method === 'paystack' && o.payment_status !== 'paid' && o.status !== 'cancelled' && (!o.rx_required || o.rx_status === 'verified') && !o.pharm_hold } : null,
    delivery_info: o.lat == null ? null : {
      landmark: o.landmark, km: o.dist_km == null ? null : Number(o.dist_km), eta_min: o.eta_min, promised_at: o.promised_at,
      accepted_at: o.accepted_at, picked_up_at: o.picked_up_at, on_way_at: o.on_way_at, delivered_at: o.delivered_at,
      lat: o.lat, lng: o.lng, locked: !!o.handover_locked,
    },
  };
}

/* ---------- order states ----------
   pending -> paid (online) or confirmed (pay on delivery, after the confirmation call) -> processing -> shipped -> delivered
   Orders only move forward. They can be cancelled until they are delivered. A delivered or cancelled order is final. */
const RANK = { pending: 0, paid: 1, confirmed: 1, processing: 2, shipped: 3, delivered: 4 };
const STATUSES = ['pending', 'paid', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];
// A refund can follow any order where money was taken, even a delivered or cancelled one.
const REFUNDABLE = ['paid', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
// Returns an error message if the order may not move to `to`, otherwise ''.
function checkTransition(o, to, settings) {
  if (!STATUSES.includes(to)) return 'Unknown status.';
  if (o.status === 'refunded') return 'This order is refunded and cannot be changed.';
  if (to === 'refunded') return o.payment_status === 'paid' && REFUNDABLE.includes(o.status) ? '' : 'This order cannot be refunded (no payment was received, or it is already refunded).';
  if (o.status === 'cancelled') return 'This order is cancelled and cannot be changed.';
  if (o.status === 'delivered' && to !== 'delivered') return 'This order is already delivered and cannot be changed.';
  if (to === 'cancelled') return '';
  if (o.rx_required && o.rx_status !== 'verified' && to !== 'pending') return 'This order has prescription-only medicines. The pharmacist must approve the prescription first.';
  if (o.pharm_hold && to !== 'pending') return 'This order has an open pharmacy flag. The superintendent pharmacist must review it first.';
  if (to === 'paid' && o.payment_method === 'pod') return 'Pay-on-delivery orders are marked paid when they are delivered. Use Confirmed after the phone call.';
  if (to === 'confirmed' && o.payment_method !== 'pod') return 'Only pay-on-delivery orders need a confirmation call.';
  if (to === 'delivered' && o.handover_nonce) return 'Delivery is completed with the customer\'s handover code. If the rider cannot enter it, use "Override" and write the reason.';
  if (RANK[to] < RANK[o.status]) return `An order cannot go back from ${o.status} to ${to}.`;
  if (['processing', 'shipped', 'delivered'].includes(to)) {
    if (o.payment_method === 'paystack' && o.payment_status !== 'paid') return 'This order has not been paid yet. Mark it as paid first if you received the money.';
    if (o.payment_method === 'pod' && settings.pod_confirm_required !== '0' && !o.confirmed_at) return 'Call the customer to confirm this pay-on-delivery order first, then mark it Confirmed.';
  }
  return '';
}
const fingerprint = (b, email) => crypto.createHash('sha256').update(JSON.stringify([
  (Array.isArray(b.items) ? b.items : []).map((i) => [Number(i.productId) || 0, Number(i.variantId) || 0, Number(i.qty) || 0]).sort(),
  str(b.coupon, 40).toUpperCase(), b.delivery || '', b.payment || '', str((b.address || {}).state, 60), email, (Array.isArray(b.prescriptionIds) ? b.prescriptionIds.map(Number).sort() : []), b.location ? [Math.round(Number(b.location.lat) * 1e4), Math.round(Number(b.location.lng) * 1e4)] : null])).digest('hex');
const IDEM_RE = /^[A-Za-z0-9_-]{16,64}$/;

async function createOrder(body, user, idemKey) {
  const contact = body.contact || {}, addr = body.address || {};
  const name = str(contact.name, 80), email = str(contact.email, 120).toLowerCase(), phone = str(contact.phone, 30);
  if (!name || !isEmail(email)) fail(400, 'Please enter your name and a valid email address.');
  if (phone.replace(/\D/g, '').length < 7) fail(400, 'Please enter a valid phone number.');
  const state = str(addr.state, 60);
  const zone = await get('SELECT * FROM zones WHERE state=?', state);
  if (!zone) fail(400, 'Please choose your delivery state.');
  const S = await getSettings();
  const delivery = ['standard', 'express', 'pickup'].includes(body.delivery) ? body.delivery : 'standard';
  if (delivery === 'pickup' && !S.pickup_address) fail(400, 'Store pickup is not available.');
  const address = str(addr.address, 200), city = str(addr.city, 60);
  if (delivery !== 'pickup' && address.length < 4) fail(400, 'Please enter your street address.');
  const method = body.payment === 'pod' ? 'pod' : body.payment === 'paystack' ? 'paystack' : '';
  if (method === 'pod' && (S.pod_enabled !== '1' || !zone.pod || delivery === 'pickup')) fail(400, 'Pay on delivery is not available for this order. Please pay online.');
  if (method === 'paystack' && (S.paystack_enabled !== '1' || !(paystackLive() || demoAllowed()))) fail(400, 'Online payment is not available right now. Please choose pay on delivery.');
  // Pay-on-delivery orders hold stock before any money moves, so one phone or email may have only a couple waiting for the confirmation call.
  if (method === 'pod') {
    const digits = phone.replace(/\D/g, '').slice(-10);
    const open = await get("SELECT COUNT(*) n FROM orders WHERE payment_method='pod' AND status='pending' AND confirmed_at IS NULL AND (lower(email)=? OR right(regexp_replace(phone,'[^0-9]','','g'),10)=?)", email, digits);
    if (Number(open.n) >= 2) fail(429, 'You already have 2 pay-on-delivery orders waiting for our confirmation call. Please wait for it, or pay online.');
  }
  if (!method) fail(400, 'Please choose a payment method.');

  // The same checkout key means the same order: a double click, a retry after a dropped connection, or a back-and-resubmit never charges twice.
  const key = typeof idemKey === 'string' && IDEM_RE.test(idemKey) ? idemKey : null, fp = fingerprint(body, email);
  const replay = async () => {
    const prev = await loadOrder('idem_key=?', key);
    if (!prev) return null;
    if (prev.idem_hash !== fp) fail(409, 'Your cart or details changed since that attempt. Please place the order again.');
    prev.replayed = true; return prev;
  };
  if (key) { const prev = await replay(); if (prev) return prev; }

  const priced = await priceCart({ items: body.items, coupon: body.coupon, state, delivery });
  if (!priced.lines.length) fail(400, priced.issues[0] ? priced.issues[0].message : 'Your cart is empty.');
  if (priced.couponError) fail(400, priced.couponError);
  if (priced.issues.some((i) => /sold out|no longer available/.test(i.message))) fail(409, priced.issues[0].message);
  // Medicines (only possible when the pharmacy department is switched on): identity, prescription and separate-order rules.
  const PH = PC.enabled() ? require('./pharmacy') : null;
  const ph = PH ? await PH.inspectCart(priced.lines, user, body) : null;
  const rxChecked = ph ? await PH.checkPrescriptions(ph, priced.lines, user, body) : null;
  // Delivery mapping: the server decides distance, fee and promised time itself. The pin from the browser is only a place, never a price.
  let geoQ = null;
  if (delivery !== 'pickup') {
    const loc = body.location || {};
    geoQ = await require('./delivery').quote({ lat: loc.lat, lng: loc.lng, state, items: priced.lines.map((l) => ({ productId: l.productId })) });
    if (geoQ.mapped && loc.lat === undefined) fail(400, 'Please drop a pin on the map so we know where to deliver.');
    if (geoQ.mapped && !geoQ.ok) fail(422, geoQ.message);
    if (geoQ.mapped && geoQ.extraFee) { priced.delivery.fee = (priced.delivery.fee || 0) + geoQ.extraFee; priced.total += geoQ.extraFee; }
  }
  // Lock rows in a fixed order so two checkouts never wait on each other in a circle.
  const lines = [...priced.lines].sort((a, b) => (a.productId - b.productId) || ((a.variantId || 0) - (b.variantId || 0)));

  const place = () => tx(async () => {
    for (const l of lines) await takeStock(l);
    const ref = await newRef(), t = now();
    const r = await run(`INSERT INTO orders (ref,user_id,status,payment_method,payment_status,name,email,phone,state,city,address,notes,delivery,delivery_fee,subtotal,discount,coupon,total,created,idem_key,idem_hash,lat,lng,landmark,dist_km,eta_min,promised_at,access_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ref, user ? user.id : null, 'pending', method, 'unpaid', name, email, phone, state, city, delivery === 'pickup' ? '' : address, str(body.notes, 300),
      delivery, priced.delivery.fee || 0, priced.subtotal, priced.discount, priced.coupon, priced.total, t, key, fp,
      geoQ && geoQ.mapped ? Number(body.location.lat) : null, geoQ && geoQ.mapped ? Number(body.location.lng) : null, geoQ && geoQ.mapped ? str(body.location.landmark, 150) : '',
      geoQ && geoQ.mapped ? geoQ.km : null, geoQ && geoQ.mapped ? geoQ.etaMin : null, geoQ && geoQ.mapped ? geoQ.promisedAt : null, crypto.randomBytes(24).toString('hex'));
    const oid = Number(r.lastInsertRowid);
    if (geoQ && geoQ.mapped) for (const l of geoQ.legs) await run('INSERT INTO order_pickups (order_id, partner_id, dist_km, eta_min) VALUES (?,?,?,?)', oid, l.partnerId, l.km, l.minutes);
    for (const l of priced.lines) await run('INSERT INTO order_items (order_id,product_id,variant_id,name,variant_label,price,qty,emoji,image) VALUES (?,?,?,?,?,?,?,?,?)', oid, l.productId, l.variantId, l.name, l.variantLabel, l.price, l.qty, l.emoji, l.image);
    if (priced.coupon) {
      const c = await run('UPDATE coupons SET used = used + 1 WHERE code = ? AND (max_uses = 0 OR used < max_uses)', priced.coupon);
      if (c.changes !== 1) fail(409, 'That promo code has just been fully used. Please remove it and try again.');
    }
    await addEvent(oid, 'pending', method === 'pod' ? 'Order placed. Pay on delivery.' : 'Order placed. Waiting for payment.');
    await run('DELETE FROM abandoned WHERE email = ?', email);
    if (ph) await PH.attach(oid, ph, rxChecked, user);
    return loadOrder('id=?', oid);
  });
  const refClash = (e) => e && e.code === '23505' && /orders_ref_key/.test(String(e.constraint || e.message || ''));
  const idemClash = (e) => key && e && e.code === '23505' && /idx_orders_idem/.test(String(e.constraint || e.message || ''));
  try { return await place(); } catch (e) {
    if (idemClash(e)) { const prev = await replay(); if (prev) return prev; } // two identical requests raced: the loser gets the winner's order
    if (!refClash(e)) throw e;
  }
  return place(); // a rare order-reference clash: the whole transaction was rolled back, so try once more
}

// Money goes back by hand (Paystack dashboard or bank); this records it. Stock returns only if the goods never left (not yet shipped).
async function refundOrder(order, note) {
  return tx(async () => {
    const cur = await get('SELECT status, payment_status FROM orders WHERE id=? FOR UPDATE', order.id);
    if (!cur || cur.payment_status !== 'paid' || !REFUNDABLE.includes(cur.status)) fail(409, 'This order cannot be refunded (no payment was received, or it is already refunded).');
    await run("UPDATE orders SET status='refunded', payment_status='refunded', handover_nonce='' WHERE id=?", order.id);
    const back = ['paid', 'confirmed', 'processing'].includes(cur.status);
    if (back) { await returnStock(order); await PC.releaseFill(order.id); }
    await addEvent(order.id, 'refunded', (note || 'Refund recorded') + (back ? ' Stock returned.' : cur.status === 'cancelled' ? '' : ' Stock was not returned automatically: adjust it if the goods came back.'));
    return true;
  });
}

async function cancelOrder(order, note) {
  if (order.status === 'cancelled') return;
  await tx(async () => {
    await run("UPDATE orders SET status='cancelled', handover_nonce='' WHERE id=?", order.id);
    await returnStock(order);
    await PC.releaseFill(order.id);
    const paidAlready = (await get('SELECT payment_status FROM orders WHERE id=?', order.id)).payment_status === 'paid';
    await addEvent(order.id, 'cancelled', (note || 'Order cancelled') + (paidAlready ? ' Payment had been received: refund the customer, then mark the order Refunded.' : ''));
  });
}

async function markPaid(order, paystackRef, note) {
  if (order.payment_status === 'paid') return false;
  await tx(async () => {
    await run("UPDATE orders SET payment_status='paid', paystack_ref=? WHERE id=?", paystackRef || order.paystack_ref, order.id);
    const rxHold = (order.rx_required && order.rx_status !== 'verified') || !!order.pharm_hold;
    if (order.status === 'pending' && rxHold) await addEvent(order.id, 'pending', 'Payment received. Your order goes ahead once the pharmacist approves the prescription.');
    else if (order.status === 'pending') { await run("UPDATE orders SET status='paid' WHERE id=?", order.id); await addEvent(order.id, 'paid', note || 'Payment received'); await require('./delivery').issueCode(order.id); }
    else if (order.status === 'cancelled') await addEvent(order.id, 'cancelled', 'Payment arrived after this order was cancelled. Please refund the customer.');
    else await addEvent(order.id, order.status, note || 'Payment received');
  });
  const fresh = await loadOrder('id=?', order.id);
  if (fresh.status === 'paid') mailOrderPaid(fresh); // not awaited: never throws
  return true;
}

/* ---------- Paystack ---------- */
async function paystackInitialize(order) {
  const res = await fetch(PAYSTACK_URL + '/transaction/initialize', {
    method: 'POST', headers: { Authorization: 'Bearer ' + PAYSTACK_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: order.email, amount: order.total * 100, currency: 'NGN', reference: order.ref, callback_url: `${BASE_URL}/order/${order.ref}?t=${order.access_token}`, metadata: { order_id: order.id, name: order.name } }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.status || !d.data || !d.data.authorization_url) throw new HttpError(502, 'We could not start the payment. Please try again or choose pay on delivery.');
  return d.data.authorization_url;
}
async function paystackVerify(ref) {
  const res = await fetch(PAYSTACK_URL + '/transaction/verify/' + encodeURIComponent(ref), { headers: { Authorization: 'Bearer ' + PAYSTACK_KEY }, signal: AbortSignal.timeout(15000) });
  const d = await res.json().catch(() => ({}));
  return res.ok && d.status ? d.data : null;
}
// Confirms with Paystack that the money for this order really arrived, then marks it paid.
async function settleWithPaystack(ref, { strict = false } = {}) {
  const order = await loadOrder('ref=?', ref);
  if (!order || order.payment_method !== 'paystack') return null;
  if (order.payment_status === 'paid') return order;
  const data = await paystackVerify(ref);
  if (!data && strict) throw new Error('Paystack could not confirm the payment yet');
  if (data && data.status === 'success') {
    // Money must match exactly: reference, currency and amount. Anything else is left for a person to review, never marked paid.
    const bad = String(data.reference || ref).toUpperCase() !== ref ? 'reference differs'
      : data.currency !== 'NGN' ? `currency was ${data.currency}`
      : Number(data.amount) !== order.total * 100 ? `amount was ${Number(data.amount) / 100}, order total is ${order.total}` : '';
    if (bad) { await addEvent(order.id, order.status, `Payment check failed (${bad}). Not marked paid. Please review with Paystack.`); console.error(`Payment mismatch on ${ref}: ${bad}`); }
    else await markPaid(order, String(data.reference || ref));
  }
  return loadOrder('ref=?', ref);
}
function verifyWebhookSignature(raw, sig) {
  if (!PAYSTACK_KEY || !raw || !sig) return false;
  const h = crypto.createHmac('sha512', PAYSTACK_KEY).update(raw).digest('hex');
  const a = Buffer.from(h), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- email (stored in the outbox; sent through Resend when a key is set) ---------- */
async function queueMail(to, subject, html) {
  if (!to) return;
  const r = await run('INSERT INTO outbox (to_email,subject,body,sent,created) VALUES (?,?,?,0,?)', to, subject, html, now());
  if (!RESEND_KEY) return;
  // The worker sends it (with retries); the order or request that caused it never waits for the email provider.
  const id = Number(r.lastInsertRowid);
  await queue.enqueue('email', { outboxId: id }, { key: 'email:' + id });
}
// Called by the worker. Throws when Resend is down so the job is retried.
async function sendOutboxEmail(outboxId) {
  const m = await get('SELECT * FROM outbox WHERE id=?', outboxId);
  if (!m || m.sent) return;
  if (!RESEND_KEY) return;
  const res = await fetch(RESEND_URL + '/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': 'shopbeta-outbox-' + m.id },
    body: JSON.stringify({ from: MAIL_FROM, to: [m.to_email], subject: m.subject, html: m.body }), signal: AbortSignal.timeout(15000),
  });
  if (res.ok) { await run('UPDATE outbox SET sent=1 WHERE id=?', m.id); return; }
  const t = (await res.text().catch(() => '')).slice(0, 200);
  const err = new Error(`Resend answered ${res.status} ${t}`);
  if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) err.permanent = true; // bad address / bad key: retrying will not help
  throw err;
}
const mailWrap = (S, inner) => `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#16181d"><h2 style="margin:0 0 12px">${esc(S.store_name)}</h2>${inner}<p style="color:#667085;font-size:12px;margin-top:24px">${esc(S.store_name)} · ${esc(S.contact_email)}</p></div>`;
const itemsHtml = (o) => `<table style="width:100%;border-collapse:collapse;font-size:14px">${o.items.map((i) => `<tr><td style="padding:6px 0">${esc(i.name)}${i.variant_label ? ' <span style="color:#667085">(' + esc(i.variant_label) + ')</span>' : ''} × ${i.qty}</td><td style="text-align:right">${naira(i.price * i.qty)}</td></tr>`).join('')}<tr><td style="padding-top:8px;color:#667085">Delivery</td><td style="text-align:right;padding-top:8px">${o.delivery_fee ? naira(o.delivery_fee) : 'Free'}</td></tr><tr><td><b>Total</b></td><td style="text-align:right"><b>${naira(o.total)}</b></td></tr></table>`;
const orderLink = (o) => `${BASE_URL}/order/${o.ref}?email=${encodeURIComponent(o.email)}${o.access_token ? '&t=' + o.access_token : ''}`;
async function mailOrderPlaced(o) {
  try {
  const S = await getSettings();
  await queueMail(o.email, `Your ${S.store_name} order ${o.ref}`, mailWrap(S, `<p>Hi ${esc(o.name.split(' ')[0])}, thank you for your order.</p><p>Order <b>${esc(o.ref)}</b> · ${o.payment_method === 'pod' ? 'Pay on delivery' : 'Online payment'}</p>${itemsHtml(o)}<p><a href="${esc(orderLink(o))}">Track your order</a></p>`));
  if (S.contact_email) await queueMail(S.contact_email, `New order ${o.ref} (${naira(o.total)})`, mailWrap(S, `<p>New order from ${esc(o.name)} (${esc(o.phone)}), ${esc(o.state)}.</p>${itemsHtml(o)}<p>Payment: ${o.payment_method === 'pod' ? 'Pay on delivery' : 'Paystack'}</p><p><a href="${BASE_URL}/admin">Open the dashboard</a></p>`));
  } catch (e) { console.error('Email error:', e.message); }
}
const codeHtml = async (o) => { const c = await require('./delivery').visibleCode(o); return c ? `<p style="font-size:15px">Your delivery code is <b style="font-size:22px;letter-spacing:3px">${c}</b>.<br>Give it to the rider only when your parcel is in your hands. Never share it before that.</p>` : ''; };
async function mailOrderPaid(o) {
  try {
  const S = await getSettings();
  await queueMail(o.email, `Payment received for ${o.ref}`, mailWrap(S, `<p>Hi ${esc(o.name.split(' ')[0])}, we have received your payment of <b>${naira(o.total)}</b> for order <b>${esc(o.ref)}</b>. We are getting it ready.</p>${itemsHtml(o)}${await codeHtml(o)}<p><a href="${esc(orderLink(o))}">View your order</a></p>`));
  if (S.contact_email) await queueMail(S.contact_email, `Paid order ${o.ref} (${naira(o.total)})`, mailWrap(S, `<p>${esc(o.name)} (${esc(o.phone)}), ${esc(o.state)} has paid online.</p>${itemsHtml(o)}<p><a href="${BASE_URL}/admin">Open the dashboard</a></p>`));
  } catch (e) { console.error('Email error:', e.message); }
}
async function mailOrderStatus(o, status, note) {
  const words = { confirmed: 'is confirmed', processing: 'is being prepared', shipped: 'is on its way', delivered: 'has been delivered', cancelled: 'has been cancelled' }[status];
  if (!words) return;
  try {
    const S = await getSettings();
    await queueMail(o.email, `Order ${o.ref} ${words.replace('is ', '').replace('has been ', '')}`, mailWrap(S, `<p>Hi ${esc(o.name.split(' ')[0])}, your order <b>${esc(o.ref)}</b> ${words}.</p>${note ? `<p>${esc(note)}</p>` : ''}${status === 'confirmed' ? await codeHtml(await loadOrder('id=?', o.id)) : ''}<p><a href="${esc(orderLink(o))}">View your order</a></p>`));
  } catch (e) { console.error('Email error:', e.message); }
}

module.exports = {
  HttpError, fail, demoAllowed, checkTransition, refundOrder, STATUSES, BASE_URL, TZ_OFFSET, str, int, isEmail, parseImages, esc, naira, todayISO, dayStart, getSettings, paystackLive,
  RATING_JOIN, offPct, card, priceCart, recalcStock, createOrder, cancelOrder, markPaid, loadOrder, publicOrder, addEvent,
  paystackInitialize, settleWithPaystack, verifyWebhookSignature, queueMail, sendOutboxEmail, mailWrap, mailOrderPlaced, mailOrderStatus, returnStock,
};
