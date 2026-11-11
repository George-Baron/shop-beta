'use strict';
// Business logic: settings, cart pricing, orders, stock, email, Paystack.
const crypto = require('crypto');
const { get, all, run, insert, tx, now } = require('./db');
const cache = require('./cache');
const queue = require('./queue');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const PAYSTACK_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const PAYSTACK_URL = (process.env.PAYSTACK_API_URL || 'https://api.paystack.co').replace(/\/+$/, ''); // overridden only by tests
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

// Cached for a short time (admin changes clear it at once). Callers get their own copy, so they can edit it freely.
const getSettings = async () => ({ ...(await cache.memo('settings', 30000, async () => Object.fromEntries((await all('SELECT key, value FROM settings')).map((r) => [r.key, r.value])))) });
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
    const p = await get('SELECT * FROM products WHERE id=? AND active=1', pid);
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
    lines.push({ productId: pid, variantId: v ? v.id : null, slug: p.slug, name: p.name, variantLabel: label, price: p.price, qty: q, available: avail, emoji: p.emoji, image: parseImages(p.images)[0] || '' });
  }
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);

  let discount = 0, couponCode = '', couponError = '';
  const code = str(coupon, 40);
  if (code) {
    const c = await get('SELECT * FROM coupons WHERE lower(code) = lower(?)', code);
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
// Full recount of a product's stock from its variants (admin edits only; orders use the incremental updates below).
async function recalcStock(pid) {
  if (await get('SELECT 1 x FROM variants WHERE product_id=? LIMIT 1', pid)) await run('UPDATE products SET stock = (SELECT COALESCE(SUM(stock),0) FROM variants WHERE product_id=?) WHERE id=?', pid, pid);
}
// Reserve stock. The "stock >= qty" condition makes this safe when many shoppers buy at once:
// the database row lock lets only one of them take the last unit.
async function takeStock(line) {
  const r = line.variantId
    ? await run('UPDATE variants SET stock = stock - ? WHERE id=? AND product_id=? AND stock >= ?', line.qty, line.variantId, line.productId, line.qty)
    : await run('UPDATE products SET stock = stock - ? WHERE id=? AND stock >= ?', line.qty, line.productId, line.qty);
  if (r.changes !== 1) fail(409, `Sorry, ${line.name} just sold out. Please update your cart.`);
  await run(line.variantId ? 'UPDATE products SET stock = stock - ?, sold = sold + ? WHERE id=?' : 'UPDATE products SET sold = sold + ? WHERE id=?',
    ...(line.variantId ? [line.qty, line.qty, line.productId] : [line.qty, line.productId]));
}
async function returnStock(order) {
  // Fixed order (by product, then variant) so two cancellations cannot deadlock each other.
  for (const i of await all('SELECT * FROM order_items WHERE order_id=? ORDER BY product_id, variant_id', order.id)) {
    if (i.variant_id) {
      await run('UPDATE variants SET stock = stock + ? WHERE id=?', i.qty, i.variant_id);
      await run('UPDATE products SET stock = stock + ?, sold = GREATEST(0, sold - ?) WHERE id=?', i.qty, i.qty, i.product_id);
    } else await run('UPDATE products SET stock = stock + ?, sold = GREATEST(0, sold - ?) WHERE id=?', i.qty, i.qty, i.product_id);
  }
  if (order.coupon) await run('UPDATE coupons SET used = GREATEST(0, used - 1) WHERE code = ?', order.coupon);
}

/* ---------- orders ---------- */
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function newRef() {
  for (let n = 0; n < 20; n++) {
    let r = 'SB-'; const b = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) r += REF_CHARS[b[i] % REF_CHARS.length];
    if (!await get('SELECT 1 x FROM orders WHERE ref=?', r)) return r;
  }
  return 'SB-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}
const addEvent = (orderId, status, note = '') => run('INSERT INTO order_events (order_id,status,note,created) VALUES (?,?,?,?)', orderId, status, note, now());

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
    ref: o.ref, status: o.status, phone_confirmed: !!o.phone_confirmed_at, payment_method: o.payment_method, payment_status: o.payment_status, created: o.created,
    name: o.name, phone: o.phone, state: o.state, city: o.city, address: o.address, delivery: o.delivery, delivery_fee: o.delivery_fee,
    subtotal: o.subtotal, discount: o.discount, coupon: o.coupon, total: o.total,
    items: o.items.map((i) => ({ product_id: i.product_id, name: i.name, variant_label: i.variant_label, price: i.price, qty: i.qty, emoji: i.emoji, image: i.image })),
    events: o.events,
  };
}

// `idemKey` is the shopper's "Place order" tap id. Two requests with the same key (a double tap, a retry after a dropped connection)
// produce ONE order: the second waits for the first to finish and gets that order back (order.replayed = true).
async function createOrder(body, user, idemKey) {
  const key = idemKey === undefined || idemKey === null || idemKey === '' ? '' : String(idemKey);
  if (key && !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) fail(400, 'Invalid request key.');
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
  if (method === 'paystack' && S.paystack_enabled !== '1') fail(400, 'Online payment is not available right now.');
  if (!method) fail(400, 'Please choose a payment method.');

  const priced = await priceCart({ items: body.items, coupon: body.coupon, state, delivery });
  if (!priced.lines.length) fail(400, priced.issues[0] ? priced.issues[0].message : 'Your cart is empty.');
  if (priced.couponError) fail(400, priced.couponError);
  if (priced.issues.some((i) => /sold out|no longer available/.test(i.message))) fail(409, priced.issues[0].message);

  const hash = key ? crypto.createHash('sha256').update(JSON.stringify([
    (body.items || []).map((i) => [i.productId, i.variantId || null, i.qty]), String(body.coupon || '').toUpperCase(), name, email, phone, state, city, address, delivery, method, str(body.notes, 300)])).digest('hex') : '';
  return tx(async () => {
    if (key) {
      // The first request puts its key in. A second one with the same key waits here until the first finishes, then sees it was taken.
      const mine = await get('INSERT INTO idempotency_keys (key, request_hash, created) VALUES (?,?,?) ON CONFLICT (key) DO NOTHING RETURNING key', key, hash, now());
      if (!mine) {
        const prev = await get('SELECT request_hash, order_id FROM idempotency_keys WHERE key=?', key);
        if (!prev || prev.request_hash !== hash) fail(422, 'This request was already used for a different order. Please refresh the page and try again.');
        const again = await loadOrder('id=?', prev.order_id);
        again.replayed = true; return again;
      }
    }
    // Always lock products in the same order so two shoppers buying the same items cannot deadlock.
    const lines = [...priced.lines].sort((a, b) => a.productId - b.productId || (a.variantId || 0) - (b.variantId || 0));
    for (const l of lines) await takeStock(l);
    if (priced.coupon) {
      const c = await run('UPDATE coupons SET used = used + 1 WHERE code = ? AND (max_uses = 0 OR used < max_uses)', priced.coupon);
      if (c.changes !== 1) fail(400, 'That promo code has been fully used.');
    }
    const ref = await newRef(), t = now();
    const oid = await insert(`INSERT INTO orders (ref,user_id,status,payment_method,payment_status,name,email,phone,state,city,address,notes,delivery,delivery_fee,subtotal,discount,coupon,total,created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ref, user ? user.id : null, 'pending', method, 'unpaid', name, email, phone, state, city, delivery === 'pickup' ? '' : address, str(body.notes, 300),
    delivery, priced.delivery.fee || 0, priced.subtotal, priced.discount, priced.coupon, priced.total, t);
    for (const l of priced.lines) await run('INSERT INTO order_items (order_id,product_id,variant_id,name,variant_label,price,qty,emoji,image) VALUES (?,?,?,?,?,?,?,?,?)', oid, l.productId, l.variantId, l.name, l.variantLabel, l.price, l.qty, l.emoji, l.image);
    await addEvent(oid, 'pending', method === 'pod' ? 'Order placed. Pay on delivery.' : 'Order placed. Waiting for payment.');
    if (key) await run('UPDATE idempotency_keys SET order_id=? WHERE key=?', oid, key);
    await run('DELETE FROM abandoned WHERE email = ?', email);
    // The confirmation email is queued in this same transaction: the order and its email job are saved together or not at all.
    if (method === 'pod') await queue.enqueue('order-mail', { kind: 'placed', orderId: oid });
    return loadOrder('id=?', oid);
  });
}

/* ---------- order states ----------
   pending -> paid (online, when Paystack confirms) -> confirmed -> dispatched -> delivered
   pending -> confirmed (pay on delivery, only after staff phoned the customer) -> dispatched -> delivered
   cancelled: from pending, paid, confirmed or dispatched. refunded: after money was taken (paid online, or cash collected). */
const ORDER_STATUSES = ['pending', 'paid', 'confirmed', 'dispatched', 'delivered', 'cancelled', 'refunded'];
const OPEN = ['pending', 'paid', 'confirmed', 'dispatched'];

// What staff may do next with this order (the admin screen shows exactly this list).
function allowedNext(o) {
  const out = [];
  const online = o.payment_method === 'paystack', pod = o.payment_method === 'pod', paid = o.payment_status === 'paid';
  if (o.status === 'pending') {
    if (online && !paid) out.push('paid');                         // only to record a payment Paystack could not confirm by itself (e.g. bank transfer checked by hand)
    if (pod && o.phone_confirmed_at) out.push('confirmed');       // normally reached through "Confirm by phone"
  }
  if (o.status === 'paid') out.push('confirmed');
  if (o.status === 'confirmed') out.push('dispatched');
  if (o.status === 'dispatched') out.push('delivered');
  if (OPEN.includes(o.status)) out.push('cancelled');
  if (paid && ['paid', 'confirmed', 'dispatched', 'delivered', 'cancelled'].includes(o.status)) out.push('refunded');
  return out;
}

// Safe to call twice at the same time: only the call that actually flips the status returns the stock.
async function cancelOrder(order, note) {
  await tx(async () => {
    const r = await run("UPDATE orders SET status='cancelled' WHERE id=? AND status IN ('pending','paid','confirmed','dispatched')", order.id);
    if (r.changes !== 1) return;
    await returnStock(order);
    const paidAlready = (await get('SELECT payment_status FROM orders WHERE id=?', order.id)).payment_status === 'paid';
    await addEvent(order.id, 'cancelled', (note || 'Order cancelled') + (paidAlready ? ' Payment had been received: refund the customer, then mark the order Refunded.' : ''));
  });
}

// Money goes back by hand (Paystack dashboard or bank); this records it. Stock returns only if the goods never left (not yet dispatched).
async function refundOrder(order, note) {
  return tx(async () => {
    const cur = await get('SELECT status, payment_status FROM orders WHERE id=? FOR UPDATE', order.id);
    if (!cur || cur.payment_status !== 'paid' || !['paid', 'confirmed', 'dispatched', 'delivered', 'cancelled'].includes(cur.status)) fail(409, 'This order cannot be refunded (no payment was received, or it is already refunded).');
    await run("UPDATE orders SET status='refunded', payment_status='refunded' WHERE id=?", order.id);
    const back = ['paid', 'confirmed'].includes(cur.status);
    if (back) await returnStock(order);
    await addEvent(order.id, 'refunded', (note || 'Refund recorded') + (back ? ' Stock returned.' : cur.status === 'cancelled' ? '' : ' Stock was not returned automatically: adjust it if the goods came back.'));
    return true;
  });
}

// Pay on delivery: staff phone the customer; only then can the order be confirmed and dispatched.
async function confirmByPhone(order, actor, note) {
  return tx(async () => {
    const r = await run("UPDATE orders SET status='confirmed', phone_confirmed_at=?, phone_confirmed_by=?, phone_confirm_note=? WHERE id=? AND status='pending' AND payment_method='pod' AND phone_confirmed_at IS NULL", now(), str(actor, 80), str(note, 300), order.id);
    if (r.changes !== 1) fail(409, 'This order is not waiting for a confirmation call (it was already confirmed, cancelled, or is not pay on delivery).');
    await addEvent(order.id, 'confirmed', `Confirmed by phone by ${str(actor, 80) || 'staff'}${note ? ': ' + str(note, 300) : ''}`);
    await queue.enqueue('order-mail', { kind: 'status', orderId: order.id, status: 'confirmed', note: '' });
    return true;
  });
}

// The one place staff status changes go through. Every change is compare-and-set: if someone else changed the order a moment ago, this fails
// with 409 instead of overwriting it.
async function changeStatus(order, to, note, actor) {
  if (!ORDER_STATUSES.includes(to)) fail(400, 'Unknown status.');
  if (to === order.status) { if (note) await addEvent(order.id, order.status, note); return; }
  if (to === 'confirmed' && order.status === 'pending' && order.payment_method === 'pod' && !order.phone_confirmed_at) fail(400, 'Pay on delivery orders must be confirmed by phone first. Use "Confirm by phone".');
  if (['dispatched', 'delivered'].includes(to) && order.payment_method === 'paystack' && order.payment_status !== 'paid') fail(400, 'This order has not been paid yet.');
  if (!allowedNext(order).includes(to)) fail(400, `An order that is "${order.status}" cannot be changed to "${to}".`);
  if (to === 'cancelled') { await cancelOrder(order, note || 'Cancelled by the store'); return; }
  if (to === 'refunded') { await refundOrder(order, note); await queue.enqueue('order-mail', { kind: 'status', orderId: order.id, status: 'refunded', note: note || '' }); return; }
  if (to === 'paid') { await markPaid(order, null, note || `Marked as paid by ${actor || 'staff'}`); return; }
  await tx(async () => {
    const r = await run('UPDATE orders SET status=? WHERE id=? AND status=?', to, order.id, order.status);
    if (r.changes !== 1) fail(409, 'This order was just changed by someone else. Reload it and try again.');
    if (to === 'delivered' && order.payment_method === 'pod') await run("UPDATE orders SET payment_status='paid' WHERE id=?", order.id);
    await addEvent(order.id, to, note || (to === 'delivered' && order.payment_method === 'pod' ? 'Delivered. Cash collected.' : ''));
    if (['confirmed', 'dispatched', 'delivered'].includes(to)) await queue.enqueue('order-mail', { kind: 'status', orderId: order.id, status: to, note: note || '' });
  });
}

// Safe to call twice at the same time (the webhook and the return page often arrive together): only one call marks it paid.
async function markPaid(order, paystackRef, note) {
  return tx(async () => {
    const r = await run("UPDATE orders SET payment_status='paid', paystack_ref=? WHERE id=? AND payment_status<>'paid'", paystackRef || order.paystack_ref, order.id);
    if (r.changes !== 1) return false;
    const cur = (await get('SELECT status FROM orders WHERE id=?', order.id)).status;
    if (cur === 'pending') {
      await run("UPDATE orders SET status='paid' WHERE id=?", order.id); await addEvent(order.id, 'paid', note || 'Payment received');
      await queue.enqueue('order-mail', { kind: 'paid', orderId: order.id }); // saved together with the "paid" flip
    } else if (cur === 'cancelled') await addEvent(order.id, 'cancelled', 'Payment arrived after this order was cancelled. Refund the customer, then mark the order Refunded.');
    else await addEvent(order.id, cur, note || 'Payment received');
    return true;
  });
}

/* ---------- Paystack ---------- */
async function paystackInitialize(order) {
  const res = await fetch(PAYSTACK_URL + '/transaction/initialize', {
    method: 'POST', headers: { Authorization: 'Bearer ' + PAYSTACK_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: order.email, amount: order.total * 100, currency: 'NGN', reference: order.ref, callback_url: `${BASE_URL}/order/${order.ref}`, metadata: { order_id: order.id, name: order.name } }),
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
async function settleWithPaystack(ref) {
  const order = await loadOrder('ref=?', ref);
  if (!order || order.payment_method !== 'paystack') return null;
  if (order.payment_status === 'paid') return order;
  const data = await paystackVerify(ref);
  if (data && data.status === 'success') {
    // All of these must match, or the order is NOT marked paid: same reference, naira, and exactly the order total (Paystack counts in kobo).
    const problem = String(data.reference || '').toUpperCase() !== order.ref ? 'a different reference'
      : data.currency !== 'NGN' ? 'currency ' + data.currency
        : Number(data.amount) !== order.total * 100 ? `amount ${naira(Math.round(Number(data.amount) / 100))} instead of ${naira(order.total)}` : '';
    if (!problem) await markPaid(order, String(data.reference || ref));
    else {
      const note = 'Paystack reports a successful payment with ' + problem + '. The order was NOT marked paid: check it in the Paystack dashboard.';
      const last = await get('SELECT note FROM order_events WHERE order_id=? ORDER BY id DESC LIMIT 1', order.id);
      if (!last || last.note !== note) await addEvent(order.id, order.status, note); // once, not on every retry
    }
  }
  return loadOrder('ref=?', ref);
}
// Starts the Paystack payment for an order exactly once, even if the same request arrives several times at once.
// The first request claims the order ("starting:<time>") and talks to Paystack; the others wait for its answer and return the same address.
async function startPayment(order) {
  const fresh = await get('SELECT pay_url FROM orders WHERE id=?', order.id);
  if (fresh && /^https?:/.test(fresh.pay_url)) return fresh.pay_url;
  const t = now();
  const claimed = (await run("UPDATE orders SET pay_url=? WHERE id=? AND (pay_url='' OR (pay_url LIKE 'starting:%' AND CAST(SUBSTRING(pay_url FROM 10) AS BIGINT) < ?))", 'starting:' + t, order.id, t - 30)).changes === 1;
  if (claimed) {
    try { const url = await paystackInitialize(order); await run('UPDATE orders SET pay_url=? WHERE id=?', url, order.id); return url; }
    catch (e) { await run("UPDATE orders SET pay_url='' WHERE id=? AND pay_url LIKE 'starting:%'", order.id); throw e; }
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const row = await get('SELECT pay_url FROM orders WHERE id=?', order.id);
    if (row && /^https?:/.test(row.pay_url)) return row.pay_url;
    if (row && row.pay_url === '') break; // the other request failed
  }
  fail(409, 'Your payment is still being set up. Please wait a moment and press Pay again.');
}
function verifyWebhookSignature(raw, sig) {
  if (!PAYSTACK_KEY || !raw || !sig) return false;
  const h = crypto.createHmac('sha512', PAYSTACK_KEY).update(raw).digest('hex');
  const a = Buffer.from(h), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- email (stored in the outbox; the worker sends them through Resend when a key is set) ---------- */
async function queueMail(to, subject, html) {
  if (!to) return;
  const id = await insert('INSERT INTO outbox (to_email,subject,body,sent,created) VALUES (?,?,?,0,?)', to, subject, html, now());
  // Sending is done by the background worker (retries, shows in Admin > Jobs if it keeps failing). Saved in the same transaction as the outbox row.
  if (RESEND_KEY) await queue.enqueue('email', { outboxId: id });
}
const mailWrap = (S, inner) => `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#16181d"><h2 style="margin:0 0 12px">${esc(S.store_name)}</h2>${inner}<p style="color:#667085;font-size:12px;margin-top:24px">${esc(S.store_name)} · ${esc(S.contact_email)}</p></div>`;
const itemsHtml = (o) => `<table style="width:100%;border-collapse:collapse;font-size:14px">${o.items.map((i) => `<tr><td style="padding:6px 0">${esc(i.name)}${i.variant_label ? ' <span style="color:#667085">(' + esc(i.variant_label) + ')</span>' : ''} × ${i.qty}</td><td style="text-align:right">${naira(i.price * i.qty)}</td></tr>`).join('')}<tr><td style="padding-top:8px;color:#667085">Delivery</td><td style="text-align:right;padding-top:8px">${o.delivery_fee ? naira(o.delivery_fee) : 'Free'}</td></tr><tr><td><b>Total</b></td><td style="text-align:right"><b>${naira(o.total)}</b></td></tr></table>`;
const orderLink = (o) => `${BASE_URL}/order/${o.ref}?email=${encodeURIComponent(o.email)}`;
async function mailOrderPlaced(o) {
  const S = await getSettings();
  await queueMail(o.email, `Your ${S.store_name} order ${o.ref}`, mailWrap(S, `<p>Hi ${esc(o.name.split(' ')[0])}, thank you for your order.</p><p>Order <b>${esc(o.ref)}</b> · ${o.payment_method === 'pod' ? 'Pay on delivery' : 'Online payment'}</p>${itemsHtml(o)}<p><a href="${esc(orderLink(o))}">Track your order</a></p>`));
  if (S.contact_email) await queueMail(S.contact_email, `New order ${o.ref} (${naira(o.total)})`, mailWrap(S, `<p>New order from ${esc(o.name)} (${esc(o.phone)}), ${esc(o.state)}.</p>${itemsHtml(o)}<p>Payment: ${o.payment_method === 'pod' ? 'Pay on delivery' : 'Paystack'}</p><p><a href="${BASE_URL}/admin">Open the dashboard</a></p>`));
}
async function mailOrderPaid(o) {
  const S = await getSettings();
  await queueMail(o.email, `Payment received for ${o.ref}`, mailWrap(S, `<p>Hi ${esc(o.name.split(' ')[0])}, we have received your payment of <b>${naira(o.total)}</b> for order <b>${esc(o.ref)}</b>. We are getting it ready.</p>${itemsHtml(o)}<p><a href="${esc(orderLink(o))}">View your order</a></p>`));
  if (S.contact_email) await queueMail(S.contact_email, `Paid order ${o.ref} (${naira(o.total)})`, mailWrap(S, `<p>${esc(o.name)} (${esc(o.phone)}), ${esc(o.state)} has paid online.</p>${itemsHtml(o)}<p><a href="${BASE_URL}/admin">Open the dashboard</a></p>`));
}
async function mailOrderStatus(o, status, note) {
  const S = await getSettings();
  const words = { confirmed: 'is confirmed and being prepared', dispatched: 'is on its way', delivered: 'has been delivered', cancelled: 'has been cancelled', refunded: 'has been refunded' }[status];
  if (!words) return;
  await queueMail(o.email, `Order ${o.ref} ${{ confirmed: 'confirmed', dispatched: 'on its way', delivered: 'delivered', cancelled: 'cancelled', refunded: 'refunded' }[status]}`, mailWrap(S, `<p>Hi ${esc(o.name.split(' ')[0])}, your order <b>${esc(o.ref)}</b> ${words}.</p>${note ? `<p>${esc(note)}</p>` : ''}<p><a href="${esc(orderLink(o))}">View your order</a></p>`));
}

module.exports = {
  HttpError, fail, BASE_URL, TZ_OFFSET, str, int, isEmail, parseImages, esc, naira, todayISO, dayStart, getSettings, paystackLive,
  RATING_JOIN, offPct, card, priceCart, recalcStock, createOrder, cancelOrder, refundOrder, confirmByPhone, changeStatus, allowedNext, ORDER_STATUSES, markPaid, loadOrder, publicOrder, addEvent,
  paystackInitialize, startPayment, settleWithPaystack, verifyWebhookSignature, queueMail, mailWrap, mailOrderPlaced, mailOrderPaid, mailOrderStatus, returnStock,
};
