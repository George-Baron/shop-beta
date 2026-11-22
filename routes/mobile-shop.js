'use strict';
// Mobile API v1: shopping. Mounted inside routes/mobile.js. Every answer comes from the same code the website uses (routes/public.js `shared`,
// lib/shop.js, lib/vendors.js, lib/delivery.js): there is no second copy of prices, stock, delivery or payment rules.
const express = require('express');
const { get, all, run, tx, now } = require('../lib/db');
const S = require('../lib/shop');
const PC = require('../lib/pharmacy-core');
const cache = require('../lib/cache');
const A = require('../lib/auth');
const M = require('../lib/mobile-auth');
const V = require('../lib/vendors');
const D = require('../lib/delivery');
const geo = require('../lib/geo');
const N = require('../lib/notify');
const Push = require('../lib/push');
const log = require('../lib/log');
const P = require('./public').shared;
const { str, int, card, parseImages } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const auth = M.requireAuth;
const queryKey = (prefix, q) => { const k = prefix + JSON.stringify(Object.entries(q).sort()); return k.length <= 400 ? k : null; };
const IDEM_RE = /^[A-Za-z0-9_-]{16,64}$/;

/* ================= catalogue (public; the same short-lived caches as the website) ================= */
router.get('/config', ah(async (req, res) => { P.publicCache(res); res.json(await cache.cached('config', 30000, P.buildConfig)); }));
router.get('/home/:store', ah(async (req, res) => { const slug = str(req.params.store, 40); P.publicCache(res); res.json(await cache.cached('home:' + slug, 30000, () => P.buildHome(slug))); }));
const searchLimit = A.quickLimiter('m-search', 120, 60000, 'Too many searches. Please wait a moment and try again.');
router.get('/products', (req, res, next) => (req.query.q ? searchLimit(req, res, next) : next()), ah(async (req, res) => {
  const key = queryKey('products:', req.query);
  P.publicCache(res); res.json(key ? await cache.cached(key, 30000, () => P.listProducts(req.query)) : await P.listProducts(req.query));
}));
router.get('/products/:slug', ah(async (req, res) => {
  const slug = str(req.params.slug, 120);
  const base = await cache.cached('product:' + slug, 20000, () => P.buildProduct(slug));
  const { stock, variants } = await cache.cached('stock:' + base.product.id, 3000, async () => ({
    stock: (await get('SELECT stock FROM products WHERE id=?', base.product.id) || { stock: 0 }).stock,
    variants: await all('SELECT id, size, color, stock FROM variants WHERE product_id=? ORDER BY id', base.product.id),
  }));
  res.json({ ...base, product: { ...base.product, stock, variants } });   // stock is for display only: checkout takes it atomically and refuses what is gone
}));
async function cardsByIds(ids) {
  if (!ids.length) return [];
  const rows = await all(`${P.PRODUCT_SELECT} WHERE p.active=1 AND ${PC.visibleSql('p')} AND p.id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return ids.map((i) => byId.get(i)).filter(Boolean).map(card);
}
const idList = (v, max) => (Array.isArray(v) ? v : []).map((x) => int(x)).filter((x) => x > 0).slice(0, max);
router.post('/products/by-ids', ah(async (req, res) => res.json({ products: await cardsByIds(idList(req.body && req.body.ids, 24)) })));
router.get('/vendors', ah(async (req, res) => { const key = queryKey('vendors:', req.query); const f = () => V.listPublic({ store: str(req.query.store, 40), q: str(req.query.q, 80) }); P.publicCache(res); res.json({ stores: key ? await cache.cached(key, 30000, f) : await f() }); }));
router.get('/vendors/:slug', ah(async (req, res) => { const slug = str(req.params.slug, 80); P.publicCache(res); res.json(await cache.cached('vendor:' + slug, 30000, () => V.pagePublic(slug))); }));

/* ================= cart and delivery (the server is the only place prices are decided; the cart itself lives on the phone) ================= */
router.post('/cart/price', ah(async (req, res) => { const { zone, ...out } = await S.priceCart(req.body || {}); res.json(out); }));
router.get('/delivery/config', ah(async (req, res) => { res.set('Cache-Control', 'public, max-age=60'); res.json({ mapped: await D.hasPartners(), tiles: geo.TILE_URL, search: geo.hasProvider() }); }));
router.get('/delivery/search', M.limit('m-geo', 60, 600000, (req) => req.headers.authorization || req.clientIp || req.ip), ah(async (req, res) => res.json({ results: await geo.search(str(req.query.q, 120)) })));
router.post('/delivery/quote', M.limit('m-quote', 60, 600000, (req) => req.headers.authorization || req.clientIp || req.ip), ah(async (req, res) => {
  const b = req.body || {}, loc = b.location || {};
  const q = await D.quote({ lat: loc.lat, lng: loc.lng, state: str(b.state, 60), items: b.items });
  if (q.legs) q.legs = q.legs.map((l) => ({ name: l.name, lat: l.lat, lng: l.lng, km: l.km, minutes: l.minutes, line: l.line }));   // no partner phone numbers
  res.json(q);
}));

/* ================= checkout and orders (signed in) ================= */
// The Idempotency-Key header is required: a double tap, a retry after a dropped connection or a resend never creates a second order or a second charge.
router.post('/checkout', auth, M.limit('m-checkout', 20, 3600000, (req) => req.user.id, 'You have placed several orders in a short time. Please wait a little and try again.'), ah(async (req, res) => {
  const key = req.get('Idempotency-Key') || '';
  if (!IDEM_RE.test(key)) M.fail(400, 'idempotency_key_required', 'The app must send an Idempotency-Key header (16 to 64 letters, digits, - or _) with every checkout.');
  res.json(await P.runCheckout(req.body || {}, req.user, key));
}));

async function owned(req) {
  const o = await S.loadOrder('ref=? AND user_id=?', str(req.params.ref, 20).toUpperCase(), req.user.id);
  if (!o) M.fail(404, 'not_found', 'We could not find that order.');
  o.view = 'full';   // the signed-in owner
  return o;
}
router.get('/orders', auth, ah(async (req, res) => {
  const lim = Math.min(50, Math.max(1, int(req.query.limit, 20))), before = int(req.query.before, 0);
  const rows = await all(`SELECT o.id, o.ref, o.status, o.payment_method, o.payment_status, o.total, o.currency, o.charge_amount, o.created,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id) AS item_count,
      (SELECT name FROM order_items i WHERE i.order_id=o.id ORDER BY i.id LIMIT 1) AS first_name,
      (SELECT image FROM order_items i WHERE i.order_id=o.id ORDER BY i.id LIMIT 1) AS first_image
    FROM orders o WHERE o.user_id=? ${before ? 'AND o.id < ?' : ''} ORDER BY o.id DESC LIMIT ${lim + 1}`, req.user.id, ...(before ? [before] : []));
  const page = rows.slice(0, lim);
  res.json({ orders: page.map((o) => ({ ref: o.ref, status: o.status, payment_method: o.payment_method, payment_status: o.payment_status, total: o.total, currency: o.currency || 'NGN', charge_amount: o.charge_amount == null ? null : Number(o.charge_amount), created: Number(o.created), item_count: Number(o.item_count), first_item: o.first_name || '', first_image: o.first_image || '' })), next_before: rows.length > lim ? Number(page[page.length - 1].id) : null });
}));
router.get('/orders/:ref', auth, ah(async (req, res) => {
  const o = await owned(req), order = await P.customerOrder(o);
  const unpaidOnline = o.payment_method === 'paystack' && o.payment_status !== 'paid' && o.status === 'pending';
  res.json({ order, actions: { can_cancel: o.status === 'pending' && o.payment_status !== 'paid', can_pay: unpaidOnline && !(o.rx_required && o.rx_status !== 'verified'), can_rate_delivery: !!order.can_rate_delivery } });
}));
router.post('/orders/:ref/cancel', auth, M.limit('m-cancel', 10, 600000, (req) => req.user.id), ah(async (req, res) => {
  const o = await owned(req);
  if (o.status !== 'pending' || o.payment_status === 'paid') M.fail(400, 'cannot_cancel', 'This order can no longer be cancelled. Please contact us.');
  await S.cancelOrder(o, 'Cancelled by customer');
  res.json({ ok: true });
}));
router.post('/orders/:ref/rate-delivery', auth, M.limit('m-rate', 20, 600000, (req) => req.user.id), ah(async (req, res) => { await P.rateDelivery(await owned(req), req.body || {}); res.json({ ok: true }); }));
router.post('/orders/:ref/items/:lineId/choose', auth, M.limit('m-choose', 20, 600000, (req) => req.user.id), ah(async (req, res) => {
  await require('../lib/dropship-orders').choose(await owned(req), req.params.lineId, str(req.body && req.body.choice, 12));
  res.json({ order: await P.customerOrder(await owned(req)) });
}));

/* ---------- payment ----------
   The app never says "I paid". It asks, and the SERVER asks the gateway, then checks reference, currency and amount before the order is marked paid. */
router.get('/orders/:ref/payment-status', auth, M.limit('m-paystatus', 60, 600000, (req) => req.user.id), ah(async (req, res) => {
  let o = await owned(req), checking = false;
  if (o.payment_method === 'paystack' && o.payment_status !== 'paid' && o.status === 'pending' && (o.gateway === 'stripe' || S.paystackLive())) {
    try { await S.settleWithPaystack(o.ref); } catch (e) { checking = true; log.warn('mobile.payment_check_failed', { ref: o.ref, message: String(e.message).slice(0, 200) }); }
    o = await owned(req);
  }
  res.json({ ref: o.ref, status: o.status, payment_method: o.payment_method, payment_status: o.payment_status, gateway: o.payment_method === 'pod' ? '' : (o.gateway || 'paystack'), checking });
}));
// Resume paying for an order that is still waiting for payment (the browser was closed): the same gateway page again, never a new order.
router.post('/orders/:ref/pay', auth, M.limit('m-pay', 20, 600000, (req) => req.user.id), ah(async (req, res) => {
  const o = await owned(req);
  if (o.payment_method !== 'paystack' || o.payment_status === 'paid' || o.status !== 'pending') M.fail(409, 'not_payable', 'This order is not waiting for payment.');
  if (o.rx_required && o.rx_status !== 'verified') M.fail(409, 'awaiting_pharmacist', 'This order is waiting for the pharmacist to approve the prescription.');
  if (o.gateway !== 'stripe' && !S.paystackLive()) M.fail(400, 'payments_unavailable', 'Online payment is not available right now.');
  let url = o.pay_url;
  if (!url) { url = await S.startPayment(o); await run('UPDATE orders SET pay_url=? WHERE id=?', url, o.id); }
  res.json({ url, gateway: o.gateway === 'stripe' ? 'stripe' : 'paystack' });
}));

/* ================= addresses ================= */
async function addressFields(b) {
  b = b || {}; const state = str(b.state, 60), address = str(b.address, 200);
  if (!(await get('SELECT 1 x FROM zones WHERE state=?', state))) M.fail(400, 'invalid_state', 'Please choose a state.');
  if (address.length < 4) M.fail(400, 'invalid_address', 'Please enter your street address.');
  return { label: str(b.label, 30) || 'Home', name: str(b.name, 80), phone: str(b.phone, 30), state, city: str(b.city, 60), address };
}
const ADDR = 'id,label,name,phone,state,city,address';
router.get('/addresses', auth, ah(async (req, res) => res.json({ addresses: await all(`SELECT ${ADDR} FROM addresses WHERE user_id=? ORDER BY id DESC`, req.user.id) })));
router.post('/addresses', auth, ah(async (req, res) => {
  const f = await addressFields(req.body);
  if ((await get('SELECT COUNT(*) n FROM addresses WHERE user_id=?', req.user.id)).n >= 10) M.fail(400, 'too_many_addresses', 'You can save up to 10 addresses.');
  const id = Number((await run('INSERT INTO addresses (user_id,label,name,phone,state,city,address) VALUES (?,?,?,?,?,?,?)', req.user.id, f.label, f.name, f.phone, f.state, f.city, f.address)).lastInsertRowid);
  res.json({ address: await get(`SELECT ${ADDR} FROM addresses WHERE id=?`, id) });
}));
router.put('/addresses/:id', auth, ah(async (req, res) => {
  const f = await addressFields(req.body), id = int(req.params.id);
  const r = await run('UPDATE addresses SET label=?, name=?, phone=?, state=?, city=?, address=? WHERE id=? AND user_id=?', f.label, f.name, f.phone, f.state, f.city, f.address, id, req.user.id);
  if (!r.changes) M.fail(404, 'not_found', 'We could not find that address.');
  res.json({ address: await get(`SELECT ${ADDR} FROM addresses WHERE id=?`, id) });
}));
router.delete('/addresses/:id', auth, ah(async (req, res) => { await run('DELETE FROM addresses WHERE id=? AND user_id=?', int(req.params.id), req.user.id); res.json({ ok: true }); }));

/* ================= wishlist ================= */
const visible = (id) => get(`SELECT 1 x FROM products p WHERE id=? AND ${PC.visibleSql('p')}`, id);
router.get('/wishlist', auth, ah(async (req, res) => res.json({ ids: (await all('SELECT product_id FROM wishlist WHERE user_id=?', req.user.id)).map((r) => Number(r.product_id)) })));
router.get('/wishlist/products', auth, ah(async (req, res) => res.json({ products: await cardsByIds((await all('SELECT product_id FROM wishlist WHERE user_id=? LIMIT 200', req.user.id)).map((r) => Number(r.product_id))) })));
router.post('/wishlist/merge', auth, ah(async (req, res) => {
  const ids = idList(req.body && req.body.ids, 200);
  await tx(async () => { for (const id of ids) if (await visible(id)) await run('INSERT INTO wishlist (user_id,product_id) VALUES (?,?) ON CONFLICT DO NOTHING', req.user.id, id); });
  res.json({ ok: true });
}));
router.post('/wishlist/:id', auth, ah(async (req, res) => { const id = int(req.params.id); if (await visible(id)) await run('INSERT INTO wishlist (user_id,product_id) VALUES (?,?) ON CONFLICT DO NOTHING', req.user.id, id); res.json({ ok: true }); }));
router.delete('/wishlist/:id', auth, ah(async (req, res) => { await run('DELETE FROM wishlist WHERE user_id=? AND product_id=?', req.user.id, int(req.params.id)); res.json({ ok: true }); }));

/* ================= notification centre (the same list the website shows) ================= */
router.get('/notifications', auth, ah(async (req, res) => res.json(await N.list(req.user, req.query))));
router.get('/notifications/count', auth, ah(async (req, res) => res.json({ unread: await N.count(req.user) })));
/* ---------- support: lands in the same inbox as the website contact form (admin > Messages), with the order named ---------- */
const TOPICS = { order_issue: 'Problem with my order', delivery: 'Delivery', payment: 'Payment', return_refund: 'Return or refund', account: 'My account', other: 'Something else' };
router.post('/support', auth, M.limit('m-support', 6, 3600000, (req) => req.user.id, 'You have sent several messages already. Please wait a while, we will reply by email.'), ah(async (req, res) => {
  const b = req.body || {}, topic = TOPICS[b.topic] ? b.topic : '', text = str(b.message, 2000);
  if (!topic) M.fail(400, 'invalid_topic', 'Please choose what your message is about.');
  if (text.length < 5) M.fail(400, 'message_too_short', 'Please tell us a little more.');
  let ref = '';
  if (b.orderRef) { const o = await S.loadOrder('ref=? AND user_id=?', str(b.orderRef, 20).toUpperCase(), req.user.id); if (!o) M.fail(404, 'not_found', 'We could not find that order on your account.'); ref = o.ref; }   // only the customer's own orders can be named
  const subject = `[App] ${TOPICS[topic]}${ref ? ' - order ' + ref : ''}`;
  await run('INSERT INTO messages (name,email,subject,body,read,created) VALUES (?,?,?,?,0,?)', req.user.name, req.user.email, subject, text, now());
  const set = await S.getSettings();
  if (set.contact_email) await S.queueMail(set.contact_email, `New message: ${subject}`, S.mailWrap(set, `<p><b>${S.esc(req.user.name)}</b> (${S.esc(req.user.email)}, ${S.esc(req.user.phone || 'no phone')}) wrote from the app:</p><p style="white-space:pre-wrap">${S.esc(text)}</p>`));
  await N.toStaff('orders', true, { type: 'support', title: `Customer message: ${subject}`, link: '/admin#/messages' });
  res.json({ ok: true, message: 'We have your message and will reply to ' + req.user.email + '.' });
}));
router.get('/support/topics', ah(async (req, res) => res.json({ topics: Object.entries(TOPICS).map(([id, label]) => ({ id, label })) })));

router.get('/notifications/settings', auth, ah(async (req, res) => res.json({ settings: await Push.prefs(req.user.id) })));
router.put('/notifications/settings', auth, ah(async (req, res) => res.json({ settings: await Push.setPrefs(req.user.id, req.body || {}) })));
router.post('/push-token', auth, ah(async (req, res) => { try { await Push.register(req.user, req.mobileSession, req.body && req.body.token, req.body && req.body.platform); } catch (e) { if (e.status === 400) require('../lib/mobile-auth').fail(400, e.code, e.message); throw e; } res.json({ ok: true }); }));
router.delete('/push-token', auth, ah(async (req, res) => { await Push.unregister(req.user, req.body && req.body.token); res.json({ ok: true }); }));
router.post('/notifications/read', auth, ah(async (req, res) => { await N.markRead(req.user, req.body || {}); res.json({ ok: true, unread: await N.count(req.user) }); }));

module.exports = router;
