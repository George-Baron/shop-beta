'use strict';
const crypto = require('crypto');
const express = require('express');
const { get, all, run, tx, now } = require('../lib/db');
const S_ = require('../lib/shop');
const A = require('../lib/auth');
const { fail, str, int, isEmail, parseImages, card, RATING_JOIN, getSettings, esc } = S_;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const PRODUCT_SELECT = `SELECT p.*, c.name AS category, c.slug AS category_slug, COALESCE(rv.r,0) AS rating, COALESCE(rv.n,0) AS rating_n
  FROM products p LEFT JOIN categories c ON c.id = p.category_id ${RATING_JOIN}`;
const PER_PAGE = 20;

/* ================= config ================= */
router.get('/config', (req, res) => {
  const S = getSettings();
  const stores = all('SELECT * FROM stores WHERE active=1 ORDER BY sort, slug');
  const slugs = new Set(stores.map((s) => s.slug));
  const settings = { ...S }; delete settings.demo_seeded; delete settings.pod_enabled; delete settings.paystack_enabled;
  res.json({
    settings, stores,
    categories: all('SELECT id, store, slug, name, icon FROM categories ORDER BY sort, id').filter((c) => slugs.has(c.store)),
    zones: all('SELECT state, fee, eta, pod FROM zones ORDER BY sort, state').map((z) => ({ ...z, pod: z.pod && S.pod_enabled === '1' ? 1 : 0 })),
    payments: { paystack: S.paystack_enabled === '1', pod: S.pod_enabled === '1', demo: !S_.paystackLive() },
    user: req.user ? A.publicUser(req.user) : null,
  });
});

/* ================= catalogue ================= */
router.get('/home/:slug', (req, res) => {
  const store = get('SELECT * FROM stores WHERE slug=? AND active=1', str(req.params.slug, 40));
  if (!store) fail(404, 'Department not found.');
  const list = (cond, order, limit) => all(`${PRODUCT_SELECT} WHERE p.active=1 AND p.store=? ${cond} ORDER BY ${order} LIMIT ${limit}`, store.slug).map(card);
  res.json({
    store, categories: all('SELECT id, slug, name, icon FROM categories WHERE store=? ORDER BY sort, id', store.slug),
    featured: list('AND p.featured=1', 'p.id DESC', 10),
    bestsellers: list('AND p.bestseller=1', 'p.sold DESC, p.id DESC', 10),
    newArrivals: list('AND p.new_arrival=1', 'p.created DESC', 8),
    deals: list('AND p.compare_price > p.price', '(p.compare_price - p.price) * 1.0 / p.compare_price DESC', 10),
  });
});

const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
router.get('/products', (req, res) => {
  const q = req.query, where = ['p.active=1'], args = [], facetWhere = ['p.active=1'], facetArgs = [];
  const store = str(q.store, 40), category = str(q.category, 60);
  if (store) { where.push('p.store=?'); args.push(store); facetWhere.push('p.store=?'); facetArgs.push(store); }
  if (category) { where.push('c.slug=?'); args.push(category); facetWhere.push('c.slug=?'); facetArgs.push(category); }
  for (const w of str(q.q, 80).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5)) {
    const l = '%' + likeEsc(w) + '%';
    where.push("(LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(p.brand) LIKE ? ESCAPE '\\' OR LOWER(p.sku) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.name,'')) LIKE ? ESCAPE '\\' OR LOWER(p.description) LIKE ? ESCAPE '\\')");
    args.push(l, l, l, l, l);
  }
  const min = int(q.min, -1), max = int(q.max, -1);
  if (min >= 0) { where.push('p.price >= ?'); args.push(min); }
  if (max >= 0) { where.push('p.price <= ?'); args.push(max); }
  if (q.size) { where.push('EXISTS (SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.size=?)'); args.push(str(q.size, 30)); }
  if (q.color) { where.push('EXISTS (SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.color=?)'); args.push(str(q.color, 30)); }
  if (int(q.rating) > 0) { where.push('COALESCE(rv.r,0) >= ?'); args.push(Math.min(5, int(q.rating))); }
  if (q.instock) where.push('p.stock > 0');
  if (q.flag === 'deals') where.push('p.compare_price > p.price');
  if (q.flag === 'new') where.push('p.new_arrival=1');
  if (q.flag === 'best') where.push('p.bestseller=1');
  const order = {
    popular: 'p.sold DESC, p.id DESC', newest: 'p.created DESC, p.id DESC', price_asc: 'p.price ASC', price_desc: 'p.price DESC',
    rating: 'COALESCE(rv.r,0) DESC, COALESCE(rv.n,0) DESC', name: 'p.name COLLATE NOCASE ASC',
  }[q.sort] || 'p.featured DESC, p.id DESC';
  const from = `FROM products p LEFT JOIN categories c ON c.id = p.category_id ${RATING_JOIN} WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) n ${from}`, ...args).n;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE)), page = Math.min(pages, Math.max(1, int(q.page, 1)));
  const products = all(`SELECT p.*, c.name AS category, COALESCE(rv.r,0) AS rating, COALESCE(rv.n,0) AS rating_n ${from} ORDER BY ${order} LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`, ...args).map(card);
  const fr = all(`SELECT DISTINCT v.size, v.color FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN categories c ON c.id=p.category_id WHERE ${facetWhere.join(' AND ')}`, ...facetArgs);
  const nat = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  res.json({ products, total, page, pages, facets: { sizes: [...new Set(fr.map((x) => x.size).filter(Boolean))].sort(nat), colors: [...new Set(fr.map((x) => x.color).filter(Boolean))].sort(nat) } });
});

router.post('/products/by-ids', (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => int(x)).filter((x) => x > 0).slice(0, 24);
  if (!ids.length) return res.json({ products: [] });
  const rows = all(`${PRODUCT_SELECT} WHERE p.active=1 AND p.id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  res.json({ products: ids.map((i) => byId.get(i)).filter(Boolean).map(card) });
});

router.get('/products/:slug', (req, res) => {
  const p = get(`${PRODUCT_SELECT} WHERE p.active=1 AND p.slug=?`, str(req.params.slug, 120));
  if (!p) fail(404, 'We could not find that product.');
  const variants = all('SELECT id, size, color, stock FROM variants WHERE product_id=? ORDER BY id', p.id);
  const reviews = all('SELECT name, rating, title, body, created FROM reviews WHERE product_id=? AND approved=1 ORDER BY id DESC LIMIT 50', p.id);
  const dist = [5, 4, 3, 2, 1].map((s) => ({ stars: s, n: reviews.filter((r) => r.rating === s).length }));
  const related = all(`${PRODUCT_SELECT} WHERE p.active=1 AND p.store=? AND p.id<>? ORDER BY (p.category_id IS ? ) DESC, p.sold DESC LIMIT 5`, p.store, p.id, p.category_id).map(card);
  res.json({
    product: { ...card(p), store: p.store, category: p.category || '', category_slug: p.category_slug || '', description: p.description, sku: p.sku, size_label: p.size_label, images: parseImages(p.images), variants, reviews, dist },
    related,
  });
});

router.post('/products/:id/reviews', A.limiter('review', 8, 3600000), (req, res) => {
  const pid = int(req.params.id), b = req.body || {};
  const p = get('SELECT id FROM products WHERE id=? AND active=1', pid);
  if (!p) fail(404, 'We could not find that product.');
  const rating = int(b.rating), body = str(b.body, 1000), title = str(b.title, 80);
  if (rating < 1 || rating > 5) fail(400, 'Please choose a star rating.');
  if (body.length < 3) fail(400, 'Please write a few words about the product.');
  const name = req.user ? req.user.name : str(b.name, 60);
  if (!name) fail(400, 'Please enter your name.');
  if (req.user && get('SELECT 1 x FROM reviews WHERE product_id=? AND user_id=?', pid, req.user.id)) fail(409, 'You have already reviewed this product.');
  run('INSERT INTO reviews (product_id,user_id,name,rating,title,body,approved,created) VALUES (?,?,?,?,?,?,1,?)', pid, req.user ? req.user.id : null, name, rating, title, body, now());
  res.json({ ok: true });
});

/* ================= cart & checkout ================= */
router.post('/cart/price', (req, res) => {
  const { zone, ...out } = S_.priceCart(req.body || {});
  res.json(out);
});

router.post('/cart/abandon', A.limiter('abandon', 40, 3600000), (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  if (!isEmail(email)) return res.json({ ok: true });
  const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 30).map((i) => ({ productId: int(i && i.productId), variantId: i && i.variantId ? int(i.variantId) : null, qty: Math.min(99, Math.max(1, int(i && i.qty, 1))) })).filter((i) => i.productId > 0);
  if (!items.length) return res.json({ ok: true });
  run('INSERT INTO abandoned (email,cart,created,reminded) VALUES (?,?,?,0) ON CONFLICT(email) DO UPDATE SET cart=excluded.cart, created=excluded.created, reminded=0', email, JSON.stringify(items), now());
  res.json({ ok: true });
});

router.post('/checkout', A.limiter('checkout', 20, 3600000), ah(async (req, res) => {
  const order = S_.createOrder(req.body || {}, req.user);
  if (order.payment_method === 'pod') { S_.mailOrderPlaced(order); return res.json({ ref: order.ref, next: 'pod' }); }
  if (!S_.paystackLive()) return res.json({ ref: order.ref, next: 'demo' });
  try { return res.json({ ref: order.ref, next: 'paystack', url: await S_.paystackInitialize(order) }); }
  catch (err) { S_.cancelOrder(order, 'Payment could not be started'); throw err; }
}));

/* ================= orders ================= */
function ownedOrder(req, ref, email) {
  const o = S_.loadOrder('ref=?', str(ref, 20).toUpperCase());
  const e = str(email, 120).toLowerCase();
  const ok = o && ((req.user && (o.user_id === req.user.id || req.user.role === 'admin')) || (e && o.email.toLowerCase() === e));
  if (!ok) fail(404, 'We could not find an order with those details. Check the order number and email.');
  return o;
}
router.post('/orders/lookup', A.limiter('lookup', 40, 600000), (req, res) => {
  res.json({ order: S_.publicOrder(ownedOrder(req, req.body.ref, req.body.email)) });
});
router.post('/orders/:ref/cancel', A.limiter('cancel', 10, 600000), (req, res) => {
  const o = ownedOrder(req, req.params.ref, req.body.email);
  if (o.status !== 'pending' || o.payment_status === 'paid') fail(400, 'This order can no longer be cancelled. Please contact us.');
  S_.cancelOrder(o, 'Cancelled by customer');
  res.json({ ok: true });
});
router.get('/orders', A.requireUser, (req, res) => {
  const orders = all('SELECT id, ref, status, total, created FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 100', req.user.id)
    .map((o) => ({ ref: o.ref, status: o.status, total: o.total, created: o.created, items: all('SELECT name, qty FROM order_items WHERE order_id=?', o.id) }));
  res.json({ orders });
});

/* ================= payments ================= */
router.get('/paystack/verify', A.limiter('verify', 40, 600000), ah(async (req, res) => {
  const ref = str(req.query.reference || req.query.trxref, 20).toUpperCase();
  if (!S_.paystackLive()) return res.json({ ok: true });
  const o = await S_.settleWithPaystack(ref);
  res.json({ ok: !!o, payment_status: o ? o.payment_status : null });
}));
router.post('/paystack/webhook', ah(async (req, res) => {
  if (!S_.verifyWebhookSignature(req.rawBody, req.headers['x-paystack-signature'])) return res.status(401).json({ error: 'Bad signature' });
  const ev = req.body || {};
  if (ev.event === 'charge.success' && ev.data && ev.data.reference) await S_.settleWithPaystack(str(ev.data.reference, 40).toUpperCase());
  res.json({ ok: true });
}));
// Demo mode only (no PAYSTACK_SECRET_KEY set): lets you test the whole order flow without real money.
router.post('/pay/demo/:ref', A.limiter('demo', 30, 600000), (req, res) => {
  if (S_.paystackLive()) fail(404, 'Not found.');
  const o = S_.loadOrder('ref=?', str(req.params.ref, 20).toUpperCase());
  if (!o || o.payment_method !== 'paystack' || o.payment_status === 'paid' || o.status !== 'pending') fail(400, 'This order is not waiting for payment.');
  if (req.body.outcome === 'fail') S_.cancelOrder(o, 'Demo payment failed');
  else S_.markPaid(o, 'DEMO-' + o.ref, 'Payment received (demo)');
  res.json({ ok: true });
});

/* ================= accounts ================= */
const pwOk = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;
router.post('/auth/register', A.limiter('register', 10, 3600000), ah(async (req, res) => {
  const b = req.body || {}, name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 30);
  if (!name) fail(400, 'Please enter your name.');
  if (!isEmail(email)) fail(400, 'Please enter a valid email address.');
  if (!pwOk(b.password)) fail(400, 'Your password must be at least 8 characters.');
  if (get('SELECT 1 x FROM users WHERE email=?', email)) fail(409, 'An account with that email already exists. Try signing in.');
  const r = run("INSERT INTO users (name,email,phone,password,role,created) VALUES (?,?,?,?, 'customer', ?)", name, email, phone, await A.hashPassword(b.password), now());
  A.startSession(req, res, Number(r.lastInsertRowid));
  res.json({ user: A.publicUser(get('SELECT * FROM users WHERE id=?', Number(r.lastInsertRowid))) });
}));
router.post('/auth/login', ah(async (req, res) => {
  const b = req.body || {}, email = str(b.email, 120).toLowerCase(), pw = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  if (!A.hit('login-ip:' + req.ip, 30, 900000) || !A.hit('login-email:' + email, 8, 900000)) fail(429, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
  const u = get('SELECT * FROM users WHERE email=?', email);
  const good = u ? await A.checkPassword(pw, u.password) : await A.burn(pw);
  if (!u || !good) fail(401, 'That email and password do not match.');
  if (req.sessionToken) run('DELETE FROM sessions WHERE id=?', A.sha(req.sessionToken));
  A.startSession(req, res, u.id);
  res.json({ user: A.publicUser(u) });
}));
router.post('/auth/logout', (req, res) => { A.endSession(req, res); res.json({ ok: true }); });
router.post('/auth/forgot', A.limiter('forgot', 6, 3600000), (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  const u = isEmail(email) ? get('SELECT * FROM users WHERE email=?', email) : null;
  if (u) {
    const token = crypto.randomBytes(32).toString('hex');
    run('DELETE FROM resets WHERE user_id=?', u.id);
    run('INSERT INTO resets (token,user_id,expires) VALUES (?,?,?)', A.sha(token), u.id, now() + 3600);
    const S = getSettings();
    S_.queueMail(u.email, `Reset your ${S.store_name} password`, S_.mailWrap(S, `<p>Hi ${esc(u.name.split(' ')[0])}, use the link below to choose a new password. It works for one hour.</p><p><a href="${S_.BASE_URL}/forgot?token=${token}">Choose a new password</a></p><p>If you did not ask for this, you can ignore this email.</p>`));
  }
  res.json({ ok: true });
});
router.post('/auth/reset', A.limiter('reset', 15, 3600000), ah(async (req, res) => {
  const token = str(req.body.token, 80);
  if (!pwOk(req.body.password)) fail(400, 'Your password must be at least 8 characters.');
  const r = /^[0-9a-f]{64}$/.test(token) ? get('SELECT * FROM resets WHERE token=? AND expires>?', A.sha(token), now()) : null;
  if (!r) fail(400, 'This reset link has expired. Please ask for a new one.');
  const hash = await A.hashPassword(req.body.password);
  run('UPDATE users SET password=? WHERE id=?', hash, r.user_id);
  run('DELETE FROM resets WHERE user_id=?', r.user_id);
  A.dropUserSessions(r.user_id);
  A.startSession(req, res, r.user_id);
  res.json({ user: A.publicUser(get('SELECT * FROM users WHERE id=?', r.user_id)) });
}));
router.get('/me', (req, res) => res.json({ user: req.user ? A.publicUser(req.user) : null }));
router.put('/me', A.requireUser, ah(async (req, res) => {
  const b = req.body || {}, name = str(b.name, 80), phone = str(b.phone, 30);
  if (!name) fail(400, 'Please enter your name.');
  if (b.newPassword) {
    if (!pwOk(b.newPassword)) fail(400, 'Your new password must be at least 8 characters.');
    if (!(await A.checkPassword(String(b.password || ''), req.user.password))) fail(400, 'Your current password is not correct.');
    run('UPDATE users SET password=? WHERE id=?', await A.hashPassword(b.newPassword), req.user.id);
    A.dropUserSessions(req.user.id, req.sessionToken);
  }
  run('UPDATE users SET name=?, phone=? WHERE id=?', name, phone, req.user.id);
  res.json({ user: A.publicUser(get('SELECT * FROM users WHERE id=?', req.user.id)) });
}));

router.get('/addresses', A.requireUser, (req, res) => res.json({ addresses: all('SELECT id,label,name,phone,state,city,address FROM addresses WHERE user_id=? ORDER BY id DESC', req.user.id) }));
router.post('/addresses', A.requireUser, (req, res) => {
  const b = req.body || {}, state = str(b.state, 60), address = str(b.address, 200);
  if (!get('SELECT 1 x FROM zones WHERE state=?', state)) fail(400, 'Please choose a state.');
  if (address.length < 4) fail(400, 'Please enter your street address.');
  if (get('SELECT COUNT(*) n FROM addresses WHERE user_id=?', req.user.id).n >= 10) fail(400, 'You can save up to 10 addresses.');
  run('INSERT INTO addresses (user_id,label,name,phone,state,city,address) VALUES (?,?,?,?,?,?,?)', req.user.id, str(b.label, 30) || 'Home', str(b.name, 80), str(b.phone, 30), state, str(b.city, 60), address);
  res.json({ ok: true });
});
router.delete('/addresses/:id', A.requireUser, (req, res) => { run('DELETE FROM addresses WHERE id=? AND user_id=?', int(req.params.id), req.user.id); res.json({ ok: true }); });

/* ================= wishlist ================= */
router.get('/wishlist', A.requireUser, (req, res) => res.json({ ids: all('SELECT product_id FROM wishlist WHERE user_id=?', req.user.id).map((r) => r.product_id) }));
router.post('/wishlist-merge', A.requireUser, (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => int(x)).filter((x) => x > 0).slice(0, 200);
  tx(() => { for (const id of ids) if (get('SELECT 1 x FROM products WHERE id=?', id)) run('INSERT OR IGNORE INTO wishlist (user_id,product_id) VALUES (?,?)', req.user.id, id); });
  res.json({ ok: true });
});
router.post('/wishlist/:id', A.requireUser, (req, res) => {
  const id = int(req.params.id);
  if (get('SELECT 1 x FROM products WHERE id=?', id)) run('INSERT OR IGNORE INTO wishlist (user_id,product_id) VALUES (?,?)', req.user.id, id);
  res.json({ ok: true });
});
router.delete('/wishlist/:id', A.requireUser, (req, res) => { run('DELETE FROM wishlist WHERE user_id=? AND product_id=?', req.user.id, int(req.params.id)); res.json({ ok: true }); });

/* ================= contact & newsletter ================= */
router.post('/contact', A.limiter('contact', 6, 3600000), (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot: real visitors never fill this in
  const name = str(b.name, 80), email = str(b.email, 120), body = str(b.body, 2000), subject = str(b.subject, 120);
  if (!name || !isEmail(email) || body.length < 3) fail(400, 'Please fill in your name, a valid email and your message.');
  run('INSERT INTO messages (name,email,subject,body,read,created) VALUES (?,?,?,?,0,?)', name, email, subject, body, now());
  const S = getSettings();
  if (S.contact_email) S_.queueMail(S.contact_email, `New message: ${subject || '(no subject)'}`, S_.mailWrap(S, `<p><b>${esc(name)}</b> (${esc(email)}) wrote:</p><p style="white-space:pre-wrap">${esc(body)}</p>`));
  res.json({ ok: true });
});
router.post('/newsletter', A.limiter('news', 10, 3600000), (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  if (!isEmail(email)) fail(400, 'Please enter a valid email address.');
  run('INSERT OR IGNORE INTO newsletter (email,created) VALUES (?,?)', email, now());
  res.json({ ok: true });
});

module.exports = router;
