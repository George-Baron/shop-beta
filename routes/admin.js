'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { get, all, run, tx, now, DATA_DIR } = require('../lib/db');
const S = require('../lib/shop');
const A = require('../lib/auth');
const jobs = require('../lib/jobs');
const { slugify } = require('../lib/seed');
const { fail, str, int, isEmail, parseImages, getSettings, dayStart } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const STATUSES = ['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled'];
// "Sales" = orders that are not cancelled and are either paid online or pay-on-delivery.
const SALE = "o.status <> 'cancelled' AND (o.payment_method = 'pod' OR o.payment_status = 'paid')";

/* ---------- first-run admin account ---------- */
router.get('/setup', (req, res) => res.json({ needed: !get("SELECT 1 x FROM users WHERE role='admin'") }));
router.post('/setup', A.limiter('setup', 10, 3600000), ah(async (req, res) => {
  if (get("SELECT 1 x FROM users WHERE role='admin'")) fail(403, 'An administrator already exists. Please sign in.');
  const b = req.body || {}, email = str(b.email, 120).toLowerCase(), name = str(b.name, 80) || 'Store owner';
  if (!isEmail(email)) fail(400, 'Please enter a valid email address.');
  if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) fail(400, 'Your password must be at least 8 characters.');
  if (get('SELECT 1 x FROM users WHERE email=?', email)) fail(409, 'That email is already registered as a customer. Use a different email.');
  const r = run("INSERT INTO users (name,email,phone,password,role,created) VALUES (?,?,'',?, 'admin', ?)", name, email, await A.hashPassword(b.password), now());
  A.startSession(req, res, Number(r.lastInsertRowid));
  res.json({ user: A.publicUser(get('SELECT * FROM users WHERE id=?', Number(r.lastInsertRowid))) });
}));

router.use(A.requireAdmin);

/* ---------- dashboard ---------- */
router.get('/dashboard', (req, res) => {
  const t = now(), ds = dayStart(t);
  const sales = (from, to = t + 86400) => get(`SELECT COALESCE(SUM(o.total),0) rev, COUNT(*) n FROM orders o WHERE o.created >= ? AND o.created < ? AND ${SALE}`, from, to);
  const days = [];
  for (let i = 13; i >= 0; i--) { const s = ds - i * 86400; days.push({ t: s, rev: sales(s, s + 86400).rev }); }
  res.json({
    today: sales(ds), week: sales(ds - 6 * 86400), month: sales(ds - 29 * 86400), all: sales(0),
    customers: get("SELECT COUNT(*) n FROM users WHERE role='customer'").n,
    byStatus: all('SELECT status, COUNT(*) n FROM orders GROUP BY status'),
    days,
    recent: all('SELECT id, ref, name, total, status, created FROM orders ORDER BY id DESC LIMIT 8'),
    top: all(`SELECT oi.name, SUM(oi.qty) qty, SUM(oi.price*oi.qty) rev FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE ${SALE} GROUP BY oi.product_id ORDER BY qty DESC LIMIT 5`),
    low: all('SELECT id, name, stock FROM products WHERE active=1 AND stock<=5 ORDER BY stock, id LIMIT 8'),
    unread: get('SELECT COUNT(*) n FROM messages WHERE read=0').n,
  });
});

/* ---------- orders ---------- */
router.get('/orders', (req, res) => {
  const where = ['1=1'], args = [];
  const status = str(req.query.status, 20);
  if (STATUSES.includes(status)) { where.push('status=?'); args.push(status); }
  const q = str(req.query.q, 80).toLowerCase();
  if (q) { const l = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; where.push("(LOWER(ref) LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')"); args.push(l, l, l, l); }
  const total = get(`SELECT COUNT(*) n FROM orders WHERE ${where.join(' AND ')}`, ...args).n;
  const per = 20, pages = Math.max(1, Math.ceil(total / per)), page = Math.min(pages, Math.max(1, int(req.query.page, 1)));
  res.json({ orders: all(`SELECT id, ref, name, email, phone, total, status, payment_method, payment_status, created FROM orders WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, ...args), total, page, pages });
});
router.get('/orders/:id', (req, res) => {
  const o = S.loadOrder('id=?', int(req.params.id));
  if (!o) fail(404, 'Order not found.');
  res.json({ order: o });
});
router.put('/orders/:id', (req, res) => {
  const o = S.loadOrder('id=?', int(req.params.id));
  if (!o) fail(404, 'Order not found.');
  const status = str(req.body.status, 20), note = str(req.body.note, 300);
  if (!STATUSES.includes(status)) fail(400, 'Unknown status.');
  if (o.status === 'cancelled') fail(400, 'This order is cancelled and cannot be changed.');
  if (status === 'cancelled') S.cancelOrder(o, note || 'Cancelled by the store');
  else if (status === o.status) { if (note) S.addEvent(o.id, status, note); }
  else {
    if (['processing', 'shipped', 'delivered'].includes(status) && o.payment_method === 'paystack' && o.payment_status !== 'paid') fail(400, 'This order has not been paid yet. Mark it as paid first if you received the money.');
    tx(() => {
      run('UPDATE orders SET status=? WHERE id=?', status, o.id);
      if (status === 'paid' || (status === 'delivered' && o.payment_method === 'pod')) run("UPDATE orders SET payment_status='paid' WHERE id=?", o.id);
      S.addEvent(o.id, status, note);
    });
    S.mailOrderStatus(o, status, note);
  }
  res.json({ ok: true });
});

/* ---------- products ---------- */
router.get('/products', (req, res) => {
  const where = ['1=1'], args = [];
  const store = str(req.query.store, 40);
  if (store) { where.push('p.store=?'); args.push(store); }
  const q = str(req.query.q, 80).toLowerCase();
  if (q) { const l = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; where.push("(LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(p.sku) LIKE ? ESCAPE '\\' OR LOWER(p.brand) LIKE ? ESCAPE '\\')"); args.push(l, l, l); }
  res.json({ products: all(`SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 300`, ...args) });
});
router.get('/products/:id', (req, res) => {
  const p = get('SELECT * FROM products WHERE id=?', int(req.params.id));
  if (!p) fail(404, 'Product not found.');
  res.json({ product: { ...p, images: parseImages(p.images), variants: all('SELECT id, size, color, stock FROM variants WHERE product_id=? ORDER BY id', p.id) } });
});

const okImage = (u) => typeof u === 'string' && u.length <= 500 && (/^\/uploads\/[a-f0-9]{16,}\.(png|jpg|webp|gif)$/.test(u) || /^https:\/\/[^\s"'<>]+$/.test(u));
function readProduct(b) {
  const name = str(b.name, 140);
  if (!name) fail(400, 'Please enter a product name.');
  const store = str(b.store, 40);
  if (!get('SELECT 1 x FROM stores WHERE slug=?', store)) fail(400, 'Please choose a department.');
  let category_id = b.category_id ? int(b.category_id) : null;
  if (category_id && !get('SELECT 1 x FROM categories WHERE id=? AND store=?', category_id, store)) category_id = null;
  const price = int(b.price, -1);
  if (price < 0 || b.price === '' || b.price == null) fail(400, 'Please enter a price.');
  let compare = Math.max(0, int(b.compare_price));
  if (compare <= price) compare = 0;
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 8);
  if (images.some((u) => !okImage(u))) fail(400, 'One of the photo links is not allowed. Use an upload or an https link.');
  const variants = (Array.isArray(b.variants) ? b.variants : []).slice(0, 80).map((v) => ({ id: int(v && v.id) || null, size: str(v && v.size, 30), color: str(v && v.color, 30), stock: Math.max(0, int(v && v.stock)) }));
  if (variants.some((v) => !v.size && !v.color)) fail(400, 'Each variant needs a size or a colour. Remove the empty rows.');
  return {
    name, store, category_id, price, compare, brand: str(b.brand, 60), description: str(b.description, 4000), sku: str(b.sku, 40), emoji: str(b.emoji, 8) || '📦',
    size_label: str(b.size_label, 20) || 'Size', images, variants, stock: Math.max(0, int(b.stock)),
    featured: b.featured ? 1 : 0, bestseller: b.bestseller ? 1 : 0, new_arrival: b.new_arrival ? 1 : 0, active: b.active ? 1 : 0,
  };
}
function saveVariants(pid, variants) {
  const have = new Set(all('SELECT id FROM variants WHERE product_id=?', pid).map((v) => v.id));
  const keep = new Set();
  for (const v of variants) {
    if (v.id && have.has(v.id)) { run('UPDATE variants SET size=?, color=?, stock=? WHERE id=?', v.size, v.color, v.stock, v.id); keep.add(v.id); }
    else run('INSERT INTO variants (product_id,size,color,stock) VALUES (?,?,?,?)', pid, v.size, v.color, v.stock);
  }
  for (const id of have) if (!keep.has(id)) run('DELETE FROM variants WHERE id=?', id);
  if (variants.length) S.recalcStock(pid);
}
const uniqueSlug = (name, ignoreId) => {
  const base = slugify(name); let s = base, n = 2;
  while (get('SELECT 1 x FROM products WHERE slug=? AND id<>?', s, ignoreId || 0)) s = `${base}-${n++}`;
  return s;
};
router.post('/products', (req, res) => {
  const p = readProduct(req.body || {});
  const id = tx(() => {
    const r = run('INSERT INTO products (slug,store,category_id,name,brand,description,price,compare_price,stock,sku,emoji,images,size_label,featured,bestseller,new_arrival,active,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      uniqueSlug(p.name), p.store, p.category_id, p.name, p.brand, p.description, p.price, p.compare, p.variants.length ? 0 : p.stock, p.sku, p.emoji, JSON.stringify(p.images), p.size_label, p.featured, p.bestseller, p.new_arrival, p.active, now());
    const pid = Number(r.lastInsertRowid);
    saveVariants(pid, p.variants);
    return pid;
  });
  res.json({ ok: true, id });
});
router.put('/products/:id', (req, res) => {
  const id = int(req.params.id);
  if (!get('SELECT 1 x FROM products WHERE id=?', id)) fail(404, 'Product not found.');
  const p = readProduct(req.body || {});
  tx(() => {
    run('UPDATE products SET store=?,category_id=?,name=?,brand=?,description=?,price=?,compare_price=?,stock=?,sku=?,emoji=?,images=?,size_label=?,featured=?,bestseller=?,new_arrival=?,active=? WHERE id=?',
      p.store, p.category_id, p.name, p.brand, p.description, p.price, p.compare, p.variants.length ? 0 : p.stock, p.sku, p.emoji, JSON.stringify(p.images), p.size_label, p.featured, p.bestseller, p.new_arrival, p.active, id);
    saveVariants(id, p.variants);
  });
  res.json({ ok: true });
});
router.delete('/products/:id', (req, res) => {
  const id = int(req.params.id);
  if (get('SELECT 1 x FROM order_items WHERE product_id=? LIMIT 1', id)) { run('UPDATE products SET active=0 WHERE id=?', id); return res.json({ ok: true, archived: true }); }
  run('DELETE FROM products WHERE id=?', id);
  res.json({ ok: true });
});

/* ---------- photo upload (stored on disk, served from /uploads) ---------- */
const MAGIC = [
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];
router.post('/upload', (req, res) => {
  const m = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.data) || ''));
  if (!m) fail(400, 'Please choose a PNG, JPG, WEBP or GIF image.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 2_000_000) fail(400, 'That image is over 2 MB.');
  const kind = MAGIC.find((k) => k.test(buf));
  if (!kind) fail(400, 'That file is not a valid image.');
  const name = crypto.randomBytes(12).toString('hex') + '.' + kind.ext;
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buf);
  res.json({ url: '/uploads/' + name });
});

/* ---------- departments & categories ---------- */
router.get('/categories', (req, res) => res.json({
  stores: all('SELECT * FROM stores ORDER BY sort, slug'),
  categories: all('SELECT c.id, c.store, c.slug, c.name, c.icon, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id) n FROM categories c ORDER BY c.sort, c.id'),
}));
const uniqueCatSlug = (store, name, ignoreId) => {
  const base = `${store}-${slugify(name)}`; let s = base, n = 2;
  while (get('SELECT 1 x FROM categories WHERE slug=? AND id<>?', s, ignoreId || 0)) s = `${base}-${n++}`;
  return s;
};
router.post('/categories', (req, res) => {
  const store = str(req.body.store, 40), name = str(req.body.name, 40);
  if (!get('SELECT 1 x FROM stores WHERE slug=?', store)) fail(400, 'Unknown department.');
  if (!name) fail(400, 'Please enter a category name.');
  const sort = (get('SELECT COALESCE(MAX(sort),0)+1 n FROM categories WHERE store=?', store)).n;
  run('INSERT INTO categories (store,slug,name,icon,sort) VALUES (?,?,?,?,?)', store, uniqueCatSlug(store, name), name, str(req.body.icon, 8) || '🛍', sort);
  res.json({ ok: true });
});
router.put('/categories/:id', (req, res) => {
  const id = int(req.params.id), c = get('SELECT * FROM categories WHERE id=?', id), name = str(req.body.name, 40);
  if (!c) fail(404, 'Category not found.');
  if (!name) fail(400, 'Please enter a category name.');
  run('UPDATE categories SET name=?, icon=? WHERE id=?', name, str(req.body.icon, 8) || '🛍', id);
  res.json({ ok: true });
});
router.delete('/categories/:id', (req, res) => { run('DELETE FROM categories WHERE id=?', int(req.params.id)); res.json({ ok: true }); });
const STORE_FIELDS = ['name', 'tab_label', 'icon', 'tagline', 'hero_title', 'hero_sub', 'hero_cta', 'promo1_title', 'promo1_sub', 'promo2_title', 'promo2_sub', 'banner_title', 'banner_sub'];
router.put('/stores/:slug', (req, res) => {
  const slug = str(req.params.slug, 40);
  if (!get('SELECT 1 x FROM stores WHERE slug=?', slug)) fail(404, 'Department not found.');
  const b = req.body || {};
  if (!str(b.name, 100) || !str(b.tab_label, 40)) fail(400, 'The name and tab label cannot be empty.');
  if (!b.active && get('SELECT COUNT(*) n FROM stores WHERE active=1 AND slug<>?', slug).n === 0) fail(400, 'At least one department must stay visible.');
  run(`UPDATE stores SET ${STORE_FIELDS.map((f) => f + '=?').join(', ')}, active=? WHERE slug=?`, ...STORE_FIELDS.map((f) => str(b[f], 200)), b.active ? 1 : 0, slug);
  res.json({ ok: true });
});

/* ---------- customers ---------- */
router.get('/customers', (req, res) => res.json({
  customers: all(`SELECT u.id, u.name, u.email, u.phone, u.created, (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) orders,
    (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.user_id=u.id AND ${SALE}) spent FROM users u WHERE u.role='customer' ORDER BY u.id DESC LIMIT 500`),
}));

/* ---------- coupons ---------- */
router.get('/coupons', (req, res) => res.json({ coupons: all('SELECT * FROM coupons ORDER BY rowid DESC') }));
router.post('/coupons', (req, res) => {
  const b = req.body || {}, code = str(b.code, 30).toUpperCase();
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) fail(400, 'Codes use letters, numbers, - or _ (3 to 30 characters).');
  const type = b.type === 'fixed' ? 'fixed' : 'percent', value = int(b.value);
  if (value < 1 || (type === 'percent' && value > 100)) fail(400, type === 'percent' ? 'Percent off must be between 1 and 100.' : 'Enter the amount off in Naira.');
  const exp = str(b.expires_at, 10);
  if (exp && !/^\d{4}-\d{2}-\d{2}$/.test(exp)) fail(400, 'Use the date format YYYY-MM-DD.');
  run(`INSERT INTO coupons (code,type,value,min_spend,max_uses,expires_at,active) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET type=excluded.type, value=excluded.value, min_spend=excluded.min_spend, max_uses=excluded.max_uses, expires_at=excluded.expires_at, active=excluded.active`,
  code, type, value, Math.max(0, int(b.min_spend)), Math.max(0, int(b.max_uses)), exp, b.active ? 1 : 0);
  res.json({ ok: true });
});
router.delete('/coupons/:code', (req, res) => { run('DELETE FROM coupons WHERE code=?', str(req.params.code, 30)); res.json({ ok: true }); });

/* ---------- reviews ---------- */
router.get('/reviews', (req, res) => res.json({ reviews: all('SELECT r.id, r.rating, r.title, r.body, r.name, r.approved, r.created, p.name product FROM reviews r JOIN products p ON p.id=r.product_id ORDER BY r.id DESC LIMIT 200') }));
router.put('/reviews/:id', (req, res) => { run('UPDATE reviews SET approved=? WHERE id=?', req.body.approved ? 1 : 0, int(req.params.id)); res.json({ ok: true }); });
router.delete('/reviews/:id', (req, res) => { run('DELETE FROM reviews WHERE id=?', int(req.params.id)); res.json({ ok: true }); });

/* ---------- messages ---------- */
router.get('/messages', (req, res) => res.json({ messages: all('SELECT * FROM messages ORDER BY id DESC LIMIT 200') }));
router.put('/messages/:id', (req, res) => { run('UPDATE messages SET read=? WHERE id=?', req.body.read ? 1 : 0, int(req.params.id)); res.json({ ok: true }); });
router.delete('/messages/:id', (req, res) => { run('DELETE FROM messages WHERE id=?', int(req.params.id)); res.json({ ok: true }); });

/* ---------- marketing ---------- */
router.get('/newsletter', (req, res) => res.json({ subscribers: all('SELECT email, created FROM newsletter ORDER BY created DESC LIMIT 2000') }));
router.get('/abandoned', (req, res) => res.json({ carts: all('SELECT email, cart, created, reminded FROM abandoned ORDER BY created DESC LIMIT 200').map((c) => { let cart = []; try { cart = JSON.parse(c.cart); } catch { /* empty */ } return { ...c, cart }; }) }));
router.post('/abandoned/remind', (req, res) => res.json({ sent: jobs.remindAbandoned() }));
router.get('/outbox', (req, res) => res.json({ emails: all('SELECT id, to_email, subject, sent, created FROM outbox ORDER BY id DESC LIMIT 100'), live: !!process.env.RESEND_API_KEY }));

/* ---------- settings ---------- */
const TEXT_KEYS = ['store_name', 'tagline', 'announcement', 'contact_phone', 'address', 'pickup_address', 'tax_note', 'ga_id', 'meta_pixel_id'];
const URL_KEYS = ['logo_url', 'instagram', 'facebook', 'x_twitter', 'tiktok'];
router.get('/settings', (req, res) => {
  const settings = getSettings(); delete settings.demo_seeded;
  res.json({ settings, zones: all('SELECT state, fee, eta, pod FROM zones ORDER BY sort, state'), paystack: { live: S.paystackLive() } });
});
router.put('/settings', (req, res) => {
  const b = req.body || {}, s = b.settings || {}, out = {};
  for (const k of TEXT_KEYS) if (k in s) out[k] = str(s[k], 300);
  if (!out.store_name && 'store_name' in s) fail(400, 'The store name cannot be empty.');
  for (const k of ['ga_id', 'meta_pixel_id']) if (out[k] && !/^[A-Za-z0-9_-]{1,40}$/.test(out[k])) fail(400, `${k === 'ga_id' ? 'The Google Analytics ID' : 'The Meta Pixel ID'} should only contain letters, numbers and dashes.`);
  for (const k of URL_KEYS) if (k in s) { const v = str(s[k], 300); if (v && !/^https:\/\/[^\s"'<>]+$/.test(v)) fail(400, `${k.replace('_', ' ')} must be a link starting with https://`); out[k] = v; }
  if ('contact_email' in s) { const v = str(s.contact_email, 120); if (v && !isEmail(v)) fail(400, 'Please enter a valid contact email.'); out.contact_email = v; }
  if ('whatsapp' in s) out.whatsapp = str(s.whatsapp, 20).replace(/\D/g, '');
  if ('free_shipping_threshold' in s) out.free_shipping_threshold = String(Math.max(0, int(s.free_shipping_threshold)));
  if ('return_days' in s) out.return_days = String(Math.min(365, Math.max(0, int(s.return_days))));
  if ('express_multiplier' in s) { const m = Number(s.express_multiplier); out.express_multiplier = String(Number.isFinite(m) ? Math.min(5, Math.max(1, m)) : 1.5); }
  for (const k of ['pod_enabled', 'paystack_enabled']) if (k in s) out[k] = s[k] === '1' || s[k] === true ? '1' : '0';
  tx(() => {
    for (const [k, v] of Object.entries(out)) run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
    for (const z of (Array.isArray(b.zones) ? b.zones : []).slice(0, 60)) run('UPDATE zones SET fee=?, eta=?, pod=? WHERE state=?', Math.max(0, int(z.fee)), str(z.eta, 30), z.pod ? 1 : 0, str(z.state, 60));
  });
  res.json({ ok: true });
});

module.exports = router;
