'use strict';
const crypto = require('crypto');
const express = require('express');
const { get, all, run, tx, now } = require('../lib/db');
const storage = require('../lib/storage');
const cache = require('../lib/cache');
const S = require('../lib/shop');
const PC = require('../lib/pharmacy-core');
const A = require('../lib/auth');
const jobs = require('../lib/jobs');
const queue = require('../lib/queue');
const D = require('../lib/delivery');
const PW = require('../lib/passwords');
const geo = require('../lib/geo');
const { slugify } = require('../lib/seed');
const { fail, str, int, isEmail, parseImages, getSettings, dayStart } = S;

const router = express.Router();

// Anything the public catalogue shows (products, categories, departments, settings, review approvals) clears the caches: here at once, on other instances within seconds.
const CATALOGUE_WRITE = /^\/(products|categories|stores|settings|reviews|partners|riders)(\/|$)/;
router.use((req, res, next) => {
  if (req.method === 'GET' || !CATALOGUE_WRITE.test(req.path)) return next();
  cache.clear();                                  // before the change, so nobody re-fills the cache from the old data meanwhile
  res.on('finish', () => { if (res.statusCode < 400) cache.bump().catch((e) => console.error('Cache bump failed:', e.message)); else cache.clear(); });
  next();
});
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const STATUSES = S.STATUSES;
// "Sales" = orders that are not cancelled and are either paid online or pay-on-delivery.
const SALE = "o.status NOT IN ('cancelled','refunded') AND (o.payment_method = 'pod' OR o.payment_status = 'paid')";

/* ---------- first-run admin account ---------- */
// In production the first admin must be created with ADMIN_EMAIL + ADMIN_PASSWORD, or with the SETUP_CODE you put in the environment.
// Otherwise the first stranger to find /admin could become the owner.
const setupMode = () => (process.env.NODE_ENV !== 'production' ? 'open' : process.env.SETUP_CODE ? 'code' : 'closed');
router.get('/setup', ah(async (req, res) => res.json({ needed: !(await get("SELECT 1 x FROM users WHERE role='admin'")) && setupMode() !== 'closed', needsCode: setupMode() === 'code' })));
router.post('/setup', A.limiter('setup', 5, 3600000), ah(async (req, res) => {
  if (await get("SELECT 1 x FROM users WHERE role='admin'")) fail(403, 'An administrator already exists. Please sign in.');
  if (setupMode() === 'closed') fail(403, 'First-time setup is switched off. Set ADMIN_EMAIL and ADMIN_PASSWORD (or SETUP_CODE) on the server.');
  if (setupMode() === 'code') { const given = Buffer.from(String((req.body || {}).setupCode || '')), want = Buffer.from(process.env.SETUP_CODE); if (given.length !== want.length || !require('crypto').timingSafeEqual(given, want)) fail(403, 'That setup code is not right.'); }
  const b = req.body || {}, email = str(b.email, 120).toLowerCase(), name = str(b.name, 80) || 'Store owner';
  if (!isEmail(email)) fail(400, 'Please enter a valid email address.');
  { const bad = PW.check(b.password, { email, name, min: PW.STAFF_MIN }); if (bad) fail(400, bad); }
  if (await get('SELECT 1 x FROM users WHERE email=?', email)) fail(409, 'That email is already registered as a customer. Use a different email.');
  const r = await run("INSERT INTO users (name,email,phone,password,role,created) VALUES (?,?,'',?, 'admin', ?)", name, email, await A.hashPassword(b.password), now());
  await A.startSession(req, res, Number(r.lastInsertRowid), 'admin');
  res.json({ user: A.publicUser(await get('SELECT * FROM users WHERE id=?', Number(r.lastInsertRowid))) });
}));

router.use(A.requireAdmin);

// Activity log: every change an admin makes (not reads) is written down with who, what and from where. Passwords are never recorded.
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  res.on('finish', () => {
    let detail = '';
    try { const b = { ...(req.body || {}) }; for (const k of Object.keys(b)) if (/pass|token|secret|data$/i.test(k)) b[k] = '[hidden]'; detail = JSON.stringify(b).slice(0, 600); } catch { /* ignore */ }
    run('INSERT INTO audit_log (user_id,user_name,method,path,status,detail,ip,created) VALUES (?,?,?,?,?,?,?,?)', req.user ? req.user.id : null, req.user ? String(req.user.name || req.user.email).slice(0, 80) : '', req.method, req.originalUrl.slice(0, 200), res.statusCode, detail, String(req.clientIp || '').slice(0, 60), now()).catch((e) => console.error('Audit log failed:', e.message));
  });
  next();
});
router.get('/audit', ah(async (req, res) => res.json({ log: await all('SELECT id, user_name, method, path, status, detail, ip, created FROM audit_log ORDER BY id DESC LIMIT 300') })));

/* ---------- dashboard ---------- */
router.get('/dashboard', ah(async (req, res) => {
  const t = now(), ds = dayStart(t);
  const sales = async (from, to = t + 86400) => get(`SELECT COALESCE(SUM(o.total),0) rev, COUNT(*) n FROM orders o WHERE o.created >= ? AND o.created < ? AND ${SALE}`, from, to);
  const days = [];
  for (let i = 13; i >= 0; i--) { const s = ds - i * 86400; days.push({ t: s, rev: (await sales(s, s + 86400)).rev }); }
  const today = await sales(ds), week = await sales(ds - 6 * 86400), month = await sales(ds - 29 * 86400), allTime = await sales(0);
  const customers = (await get("SELECT COUNT(*) n FROM users WHERE role='customer'")).n;
  const byStatus = await all('SELECT status, COUNT(*) n FROM orders GROUP BY status');
  const recent = await all('SELECT id, ref, name, total, status, created FROM orders ORDER BY id DESC LIMIT 8');
  const top = await all(`SELECT MAX(oi.name) AS name, SUM(oi.qty) qty, SUM(oi.price*oi.qty) rev FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE ${SALE} GROUP BY oi.product_id ORDER BY qty DESC LIMIT 5`);
  const low = await all('SELECT id, name, stock FROM products WHERE active=1 AND stock<=5 ORDER BY stock, id LIMIT 8');
  const unread = (await get('SELECT COUNT(*) n FROM messages WHERE read=0')).n;
  res.json({ today, week, month, all: allTime, customers, byStatus, days, recent, top, low, unread });
}));

/* ---------- orders ---------- */
router.get('/orders', ah(async (req, res) => {
  const where = ['1=1'], args = [];
  const status = str(req.query.status, 20);
  if (STATUSES.includes(status)) { where.push('status=?'); args.push(status); }
  const q = str(req.query.q, 80).toLowerCase();
  if (q) { const l = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; where.push("(LOWER(ref) LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')"); args.push(l, l, l, l); }
  const total = (await get(`SELECT COUNT(*) n FROM orders WHERE ${where.join(' AND ')}`, ...args)).n;
  const per = 20, pages = Math.max(1, Math.ceil(total / per)), page = Math.min(pages, Math.max(1, int(req.query.page, 1)));
  res.json({ orders: await all(`SELECT id, ref, name, email, phone, total, status, payment_method, payment_status, created FROM orders WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, ...args), total, page, pages });
}));
router.get('/orders/:id', ah(async (req, res) => {
  const o = await S.loadOrder('id=?', int(req.params.id));
  if (!o) fail(404, 'Order not found.');
  delete o.handover_nonce; delete o.idem_hash;
  res.json({ order: o });
}));
router.put('/orders/:id', ah(async (req, res) => {
  const o = await S.loadOrder('id=?', int(req.params.id));
  if (!o) fail(404, 'Order not found.');
  const status = str(req.body.status, 20), note = str(req.body.note, 300);
  const problem = S.checkTransition(o, status, await getSettings());
  if (problem) fail(400, problem);
  if (status === 'cancelled') await S.cancelOrder(o, note || 'Cancelled by the store');
  else if (status === 'refunded') await S.refundOrder(o, note);
  else if (status === o.status) { if (note) await S.addEvent(o.id, status, note); }
  else {
    await tx(async () => {
      // The row is locked and re-checked, so two staff clicking at once cannot push an order through a state twice.
      const fresh = await get('SELECT status FROM orders WHERE id=? FOR UPDATE', o.id);
      if (fresh.status !== o.status) fail(409, 'Someone else just changed this order. Reload and try again.');
      await run('UPDATE orders SET status=? WHERE id=?', status, o.id);
      if (status === 'confirmed') { await run('UPDATE orders SET confirmed_at=?, confirmed_by=? WHERE id=?', now(), str(req.user.name || req.user.email, 80), o.id); await D.issueCode(o.id); }
      if (['paid', 'processing'].includes(status)) await D.issueCode(o.id);
      if (status === 'paid' || (status === 'delivered' && o.payment_method === 'pod')) await run("UPDATE orders SET payment_status='paid' WHERE id=?", o.id);
      await S.addEvent(o.id, status, status === 'confirmed' ? (note || `Confirmed by phone (${str(req.user.name || req.user.email, 80)})`) : note);
    });
    await S.mailOrderStatus(o, status, note);
  }
  res.json({ ok: true });
}));

/* ---------- products ---------- */
router.get('/products', ah(async (req, res) => {
  const where = ['1=1'], args = [];
  const store = str(req.query.store, 40);
  if (store) { where.push('p.store=?'); args.push(store); }
  const q = str(req.query.q, 80).toLowerCase();
  if (q) { const l = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; where.push("(LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(p.sku) LIKE ? ESCAPE '\\' OR LOWER(p.brand) LIKE ? ESCAPE '\\')"); args.push(l, l, l); }
  res.json({ products: await all(`SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 300`, ...args) });
}));
router.get('/products/:id', ah(async (req, res) => {
  const p = await get('SELECT * FROM products WHERE id=?', int(req.params.id));
  if (!p) fail(404, 'Product not found.');
  res.json({ product: { ...p, images: parseImages(p.images), variants: await all('SELECT id, size, color, stock FROM variants WHERE product_id=? ORDER BY id', p.id) } });
}));

const okImage = (u) => typeof u === 'string' && u.length <= 500 && (storage.isOwnUrl(u) || /^\/uploads\/[a-f0-9]{16,}\.(png|jpg|webp|gif)$/.test(u) || /^https:\/\/[^\s"'<>]+$/.test(u));
async function readProduct(b) {
  const name = str(b.name, 140);
  if (!name) fail(400, 'Please enter a product name.');
  const store = str(b.store, 40);
  if (!(await get('SELECT 1 x FROM stores WHERE slug=?', store))) fail(400, 'Please choose a department.');
  if (PC.storeHidden(store)) fail(400, 'The pharmacy department is switched off. Medicines cannot be listed until it is enabled.');
  let category_id = b.category_id ? int(b.category_id) : null;
  if (category_id && !(await get('SELECT 1 x FROM categories WHERE id=? AND store=?', category_id, store))) category_id = null;
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
async function saveVariants(pid, variants) {
  const have = new Set((await all('SELECT id FROM variants WHERE product_id=?', pid)).map((v) => v.id));
  const keep = new Set();
  for (const v of variants) {
    if (v.id && have.has(v.id)) { await run('UPDATE variants SET size=?, color=?, stock=? WHERE id=?', v.size, v.color, v.stock, v.id); keep.add(v.id); }
    else await run('INSERT INTO variants (product_id,size,color,stock) VALUES (?,?,?,?)', pid, v.size, v.color, v.stock);
  }
  for (const id of have) if (!keep.has(id)) await run('DELETE FROM variants WHERE id=?', id);
  if (variants.length) await S.recalcStock(pid);
}
const uniqueSlug = async (name, ignoreId) => {
  const base = slugify(name); let s = base, n = 2;
  while (await get('SELECT 1 x FROM products WHERE slug=? AND id<>?', s, ignoreId || 0)) s = `${base}-${n++}`;
  return s;
};
router.post('/products', ah(async (req, res) => {
  const p = await readProduct(req.body || {});
  const id = await tx(async () => {
    const r = await run('INSERT INTO products (slug,store,category_id,name,brand,description,price,compare_price,stock,sku,emoji,images,size_label,featured,bestseller,new_arrival,active,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      await uniqueSlug(p.name), p.store, p.category_id, p.name, p.brand, p.description, p.price, p.compare, p.variants.length ? 0 : p.stock, p.sku, p.emoji, JSON.stringify(p.images), p.size_label, p.featured, p.bestseller, p.new_arrival, p.active, now());
    const pid = Number(r.lastInsertRowid);
    if (p.store === PC.PHARMACY_STORE) await run("UPDATE products SET pharm_status='pending' WHERE id=?", pid);
    await saveVariants(pid, p.variants);
    return pid;
  });
  res.json({ ok: true, id });
}));
router.put('/products/:id', ah(async (req, res) => {
  const id = int(req.params.id);
  const cur = await get('SELECT is_pharmacy FROM products WHERE id=?', id);
  if (!cur) fail(404, 'Product not found.');
  if (cur.is_pharmacy && !PC.enabled() && req.body && req.body.active) fail(400, 'The pharmacy department is switched off. Medicines cannot be listed until it is enabled.');
  const p = await readProduct(req.body || {});
  await tx(async () => {
    // any edit to a pharmacy product sends it back to our superintendent pharmacist for re-approval
    if (cur.is_pharmacy || p.store === PC.PHARMACY_STORE) await run("UPDATE products SET pharm_status='pending', pharm_approved_by='', pharm_approved_at=NULL WHERE id=? AND pharm_status='approved'", id);
    await run('UPDATE products SET store=?,category_id=?,name=?,brand=?,description=?,price=?,compare_price=?,stock=?,sku=?,emoji=?,images=?,size_label=?,featured=?,bestseller=?,new_arrival=?,active=? WHERE id=?',
      p.store, p.category_id, p.name, p.brand, p.description, p.price, p.compare, p.variants.length ? 0 : p.stock, p.sku, p.emoji, JSON.stringify(p.images), p.size_label, p.featured, p.bestseller, p.new_arrival, p.active, id);
    await saveVariants(id, p.variants);
  });
  res.json({ ok: true });
}));
router.delete('/products/:id', ah(async (req, res) => {
  const id = int(req.params.id);
  if (await get('SELECT 1 x FROM order_items WHERE product_id=? LIMIT 1', id)) { await run('UPDATE products SET active=0 WHERE id=?', id); return res.json({ ok: true, archived: true }); }
  await run('DELETE FROM products WHERE id=?', id);
  res.json({ ok: true });
}));

/* ---------- photo upload (stored in object storage; see lib/storage.js) ---------- */
const MAGIC = [
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];
router.post('/upload', express.json({ limit: '4mb' }), ah(async (req, res) => { // the larger body is only read here, after the admin check above
  const m = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.data) || ''));
  if (!m) fail(400, 'Please choose a PNG, JPG, WEBP or GIF image.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 2_000_000) fail(400, 'That image is over 2 MB.');
  const kind = MAGIC.find((k) => k.test(buf));
  if (!kind) fail(400, 'That file is not a valid image.');
  const name = crypto.randomBytes(12).toString('hex') + '.' + kind.ext;
  try { res.json({ url: await storage.put(buf, name, kind.mime) }); }
  catch (e) { if (e && e.storage) fail(502, e.message); throw e; }
}));

/* ---------- departments & categories ---------- */
router.get('/categories', ah(async (req, res) => res.json({
  stores: await all('SELECT * FROM stores ORDER BY sort, slug'),
  categories: await all('SELECT c.id, c.store, c.slug, c.name, c.icon, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id) n FROM categories c ORDER BY c.sort, c.id'),
})));
const uniqueCatSlug = async (store, name, ignoreId) => {
  const base = `${store}-${slugify(name)}`; let s = base, n = 2;
  while (await get('SELECT 1 x FROM categories WHERE slug=? AND id<>?', s, ignoreId || 0)) s = `${base}-${n++}`;
  return s;
};
router.post('/categories', ah(async (req, res) => {
  const store = str(req.body.store, 40), name = str(req.body.name, 40);
  if (!(await get('SELECT 1 x FROM stores WHERE slug=?', store))) fail(400, 'Unknown department.');
  if (!name) fail(400, 'Please enter a category name.');
  const sort = (await get('SELECT COALESCE(MAX(sort),0)+1 n FROM categories WHERE store=?', store)).n;
  await run('INSERT INTO categories (store,slug,name,icon,sort) VALUES (?,?,?,?,?)', store, await uniqueCatSlug(store, name), name, str(req.body.icon, 8) || '🛍', sort);
  res.json({ ok: true });
}));
router.put('/categories/:id', ah(async (req, res) => {
  const id = int(req.params.id), c = await get('SELECT * FROM categories WHERE id=?', id), name = str(req.body.name, 40);
  if (!c) fail(404, 'Category not found.');
  if (!name) fail(400, 'Please enter a category name.');
  await run('UPDATE categories SET name=?, icon=? WHERE id=?', name, str(req.body.icon, 8) || '🛍', id);
  res.json({ ok: true });
}));
router.delete('/categories/:id', ah(async (req, res) => { await run('DELETE FROM categories WHERE id=?', int(req.params.id)); res.json({ ok: true }); }));
const STORE_FIELDS = ['name', 'tab_label', 'icon', 'tagline', 'hero_title', 'hero_sub', 'hero_cta', 'promo1_title', 'promo1_sub', 'promo2_title', 'promo2_sub', 'banner_title', 'banner_sub'];
router.put('/stores/:slug', ah(async (req, res) => {
  const slug = str(req.params.slug, 40);
  if (!(await get('SELECT 1 x FROM stores WHERE slug=?', slug))) fail(404, 'Department not found.');
  const b = req.body || {};
  if (!str(b.name, 100) || !str(b.tab_label, 40)) fail(400, 'The name and tab label cannot be empty.');
  if (!b.active && (await get('SELECT COUNT(*) n FROM stores WHERE active=1 AND slug<>?', slug)).n === 0) fail(400, 'At least one department must stay visible.');
  await run(`UPDATE stores SET ${STORE_FIELDS.map((f) => f + '=?').join(', ')}, active=? WHERE slug=?`, ...STORE_FIELDS.map((f) => str(b[f], 200)), b.active ? 1 : 0, slug);
  res.json({ ok: true });
}));

/* ---------- customers ---------- */
router.get('/customers', ah(async (req, res) => res.json({
  customers: await all(`SELECT u.id, u.name, u.email, u.phone, u.created, (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) orders,
    (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.user_id=u.id AND ${SALE}) spent FROM users u WHERE u.role='customer' ORDER BY u.id DESC LIMIT 500`),
})));

/* ---------- coupons ---------- */
router.get('/coupons', ah(async (req, res) => res.json({ coupons: await all('SELECT * FROM coupons ORDER BY created_seq DESC') })));
router.post('/coupons', ah(async (req, res) => {
  const b = req.body || {}, code = str(b.code, 30).toUpperCase();
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) fail(400, 'Codes use letters, numbers, - or _ (3 to 30 characters).');
  const type = b.type === 'fixed' ? 'fixed' : 'percent', value = int(b.value);
  if (value < 1 || (type === 'percent' && value > 100)) fail(400, type === 'percent' ? 'Percent off must be between 1 and 100.' : 'Enter the amount off in Naira.');
  const exp = str(b.expires_at, 10);
  if (exp && !/^\d{4}-\d{2}-\d{2}$/.test(exp)) fail(400, 'Use the date format YYYY-MM-DD.');
  await run(`INSERT INTO coupons (code,type,value,min_spend,max_uses,expires_at,active) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET type=excluded.type, value=excluded.value, min_spend=excluded.min_spend, max_uses=excluded.max_uses, expires_at=excluded.expires_at, active=excluded.active`,
  code, type, value, Math.max(0, int(b.min_spend)), Math.max(0, int(b.max_uses)), exp, b.active ? 1 : 0);
  res.json({ ok: true });
}));
router.delete('/coupons/:code', ah(async (req, res) => { await run('DELETE FROM coupons WHERE code=?', str(req.params.code, 30)); res.json({ ok: true }); }));

/* ---------- reviews ---------- */
router.get('/reviews', ah(async (req, res) => res.json({ reviews: await all('SELECT r.id, r.rating, r.title, r.body, r.name, r.approved, r.created, p.name product FROM reviews r JOIN products p ON p.id=r.product_id ORDER BY r.id DESC LIMIT 200') })));
router.put('/reviews/:id', ah(async (req, res) => { await run('UPDATE reviews SET approved=? WHERE id=?', req.body.approved ? 1 : 0, int(req.params.id)); res.json({ ok: true }); }));
router.delete('/reviews/:id', ah(async (req, res) => { await run('DELETE FROM reviews WHERE id=?', int(req.params.id)); res.json({ ok: true }); }));

/* ---------- messages ---------- */
router.get('/messages', ah(async (req, res) => res.json({ messages: await all('SELECT * FROM messages ORDER BY id DESC LIMIT 200') })));
router.put('/messages/:id', ah(async (req, res) => { await run('UPDATE messages SET read=? WHERE id=?', req.body.read ? 1 : 0, int(req.params.id)); res.json({ ok: true }); }));
router.delete('/messages/:id', ah(async (req, res) => { await run('DELETE FROM messages WHERE id=?', int(req.params.id)); res.json({ ok: true }); }));

/* ---------- marketing ---------- */
router.get('/newsletter', ah(async (req, res) => res.json({ subscribers: await all('SELECT email, created FROM newsletter ORDER BY created DESC LIMIT 2000') })));
router.get('/abandoned', ah(async (req, res) => res.json({ carts: (await all('SELECT email, cart, created, reminded FROM abandoned ORDER BY created DESC LIMIT 200')).map((c) => { let cart = []; try { cart = JSON.parse(c.cart); } catch { /* empty */ } return { ...c, cart }; }) })));
router.post('/abandoned/remind', ah(async (req, res) => res.json({ sent: await jobs.remindAbandoned() })));
router.get('/jobs', ah(async (req, res) => res.json({
  counts: await queue.counts(),
  failed: await all("SELECT id, kind, payload, attempts, last_error, finished FROM jobs WHERE state='failed' ORDER BY finished DESC LIMIT 100"),
  waiting: await all("SELECT id, kind, attempts, last_error, run_at FROM jobs WHERE state='queued' AND attempts>0 ORDER BY run_at LIMIT 50"),
})));
/* ---------- status and backups ---------- */
router.get('/status', ah(async (req, res) => {
  const t0 = Date.now(); await get('SELECT 1 x'); const dbMs = Date.now() - t0;
  const oldest = await get("SELECT MIN(run_at) t FROM jobs WHERE state='queued' AND run_at<=?", now());
  const { pool } = require('../lib/db');
  res.json({
    ok: true, version: process.env.RENDER_GIT_COMMIT ? String(process.env.RENDER_GIT_COMMIT).slice(0, 7) : '', node: process.version, uptimeSeconds: Math.round(process.uptime()),
    database: { ms: dbMs, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } },
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    queue: { ...(await queue.counts()), oldestDueSeconds: oldest && oldest.t ? Math.max(0, now() - Number(oldest.t)) : 0 },
    workerLooksStuck: !!(oldest && oldest.t && now() - Number(oldest.t) > 600),
    backups: await require('../lib/backup').status(),
    warnings: [
      process.env.NODE_ENV === 'production' && !process.env.BACKUP_PASSPHRASE ? 'Backups are not encrypted. Set BACKUP_PASSPHRASE.' : '',
      process.env.NODE_ENV === 'production' && !process.env.PAYSTACK_SECRET_KEY ? 'Online payment is off (no PAYSTACK_SECRET_KEY).' : '',
      storage.DRIVER === 'local' && process.env.NODE_ENV === 'production' ? 'Photos and backups are on the server disk, which is wiped on restart.' : '',
    ].filter(Boolean),
  });
}));
router.get('/errors', ah(async (req, res) => res.json({ errors: await require('../lib/errors').list(), alerts: { email: !!process.env.ALERT_EMAIL && !!process.env.RESEND_API_KEY, webhook: !!process.env.ALERT_WEBHOOK_URL } })));
router.post('/errors/:id/resolve', ah(async (req, res) => { if (!(await require('../lib/errors').resolve(int(req.params.id)))) fail(404, 'That error is already marked fixed.'); res.json({ ok: true }); }));
router.get('/backups', ah(async (req, res) => res.json({ ...(await require('../lib/backup').status()), files: await storage.backups.list() })));
router.post('/backups', ah(async (req, res) => {
  const snap = await require('../lib/backup').create('admin');
  res.json({ ok: true, name: snap.name, bytes: snap.buffer.length, rows: snap.rows });
}));
// Downloading is recorded in the activity log (reads are not logged by default, but this one is sensitive).
router.get('/backups/:name', ah(async (req, res) => {
  let buf; try { buf = await storage.backups.get(String(req.params.name)); } catch { fail(404, 'That backup was not found.'); }
  await run('INSERT INTO audit_log (user_id,user_name,method,path,status,detail,ip,created) VALUES (?,?,?,?,?,?,?,?)', req.user.id, String(req.user.name || req.user.email).slice(0, 80), 'GET', req.originalUrl.slice(0, 200), 200, 'backup downloaded', String(req.clientIp || '').slice(0, 60), now());
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${String(req.params.name).replace(/[^A-Za-z0-9._-]/g, '')}"`, 'Cache-Control': 'no-store' }).send(buf);
}));

router.post('/jobs/:id/retry', ah(async (req, res) => { if (!(await queue.retry(int(req.params.id)))) fail(404, 'That job is not in the failed list.'); res.json({ ok: true }); }));
router.delete('/jobs/:id', ah(async (req, res) => { if (!(await queue.remove(int(req.params.id)))) fail(404, 'That job is not in the failed list.'); res.json({ ok: true }); }));
router.get('/outbox', ah(async (req, res) => res.json({ emails: await all('SELECT id, to_email, subject, sent, created FROM outbox ORDER BY id DESC LIMIT 100'), live: !!process.env.RESEND_API_KEY })));

/* ---------- settings ---------- */
const TEXT_KEYS = ['store_name', 'tagline', 'announcement', 'contact_phone', 'address', 'pickup_address', 'tax_note', 'ga_id', 'meta_pixel_id'];
const URL_KEYS = ['logo_url', 'instagram', 'facebook', 'x_twitter', 'tiktok'];
router.get('/settings', ah(async (req, res) => {
  const settings = await getSettings(); delete settings.demo_seeded;
  res.json({ settings, zones: await all('SELECT state, fee, eta, pod FROM zones ORDER BY sort, state'), paystack: { live: S.paystackLive() } });
}));
router.put('/settings', ah(async (req, res) => {
  const b = req.body || {}, s = b.settings || {}, out = {};
  for (const k of TEXT_KEYS) if (k in s) out[k] = str(s[k], 300);
  if (!out.store_name && 'store_name' in s) fail(400, 'The store name cannot be empty.');
  for (const k of ['ga_id', 'meta_pixel_id']) if (out[k] && !/^[A-Za-z0-9_-]{1,40}$/.test(out[k])) fail(400, `${k === 'ga_id' ? 'The Google Analytics ID' : 'The Meta Pixel ID'} should only contain letters, numbers and dashes.`);
  for (const k of URL_KEYS) if (k in s) { const v = str(s[k], 300); if (v && !/^https:\/\/[^\s"'<>]+$/.test(v)) fail(400, `${k.replace('_', ' ')} must be a link starting with https://`); out[k] = v; }
  if ('contact_email' in s) { const v = str(s.contact_email, 120); if (v && !isEmail(v)) fail(400, 'Please enter a valid contact email.'); out.contact_email = v; }
  if ('whatsapp' in s) out.whatsapp = str(s.whatsapp, 20).replace(/\D/g, '');
  if ('free_shipping_threshold' in s) out.free_shipping_threshold = String(Math.max(0, int(s.free_shipping_threshold)));
  if ('pod_confirm_hours' in s) out.pod_confirm_hours = String(Math.min(168, Math.max(1, int(s.pod_confirm_hours, 24))));
  for (const [k, lo, hi, d] of [['max_distance_km', 1, 500, 60], ['per_km_fee', 0, 5000, 0], ['free_km', 0, 500, 0], ['prep_minutes', 0, 600, 20], ['open_hour', 0, 23, 8], ['cutoff_hour', 1, 24, 20]]) if (k in s) out[k] = String(Math.min(hi, Math.max(lo, int(s[k], d))));
  if ('return_days' in s) out.return_days = String(Math.min(365, Math.max(0, int(s.return_days))));
  if ('express_multiplier' in s) { const m = Number(s.express_multiplier); out.express_multiplier = String(Number.isFinite(m) ? Math.min(5, Math.max(1, m)) : 1.5); }
  for (const k of ['pod_enabled', 'paystack_enabled', 'pod_confirm_required']) if (k in s) out[k] = s[k] === '1' || s[k] === true ? '1' : '0';
  await tx(async () => {
    for (const [k, v] of Object.entries(out)) await run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
    for (const z of (Array.isArray(b.zones) ? b.zones : []).slice(0, 60)) await run('UPDATE zones SET fee=?, eta=?, pod=? WHERE state=?', Math.max(0, int(z.fee)), str(z.eta, 30), z.pod ? 1 : 0, str(z.state, 60));
  });
  res.json({ ok: true });
}));


/* ================= partners (pickup points), riders, deliveries ================= */
const partnerFields = (b) => {
  const lat = Number(b.lat), lng = Number(b.lng), name = str(b.name, 80);
  if (!name) fail(400, 'Give the pickup point a name.');
  if (!geo.inNigeria(lat, lng)) fail(400, 'Set the pickup point on the map inside Nigeria (latitude and longitude).');
  return [name, str(b.address, 200), str(b.state, 60), str(b.phone, 30), lat, lng, Math.min(500, Math.max(1, Number(b.radius_km) || 15)), b.is_default ? 1 : 0, b.active === false || b.active === 0 ? 0 : 1];
};
router.get('/partners', ah(async (req, res) => res.json({ partners: await all('SELECT * FROM partners ORDER BY id') })));
router.post('/partners', ah(async (req, res) => {
  const f = partnerFields(req.body || {});
  const r = await run('INSERT INTO partners (name,address,state,phone,lat,lng,radius_km,is_default,active,created) VALUES (?,?,?,?,?,?,?,?,?,?)', ...f, now());
  res.json({ ok: true, id: r.lastInsertRowid });
}));
router.put('/partners/:id', ah(async (req, res) => {
  const f = partnerFields(req.body || {});
  const r = await run('UPDATE partners SET name=?,address=?,state=?,phone=?,lat=?,lng=?,radius_km=?,is_default=?,active=? WHERE id=?', ...f, int(req.params.id));
  if (!r.changes) fail(404, 'Pickup point not found.');
  res.json({ ok: true });
}));
router.delete('/partners/:id', ah(async (req, res) => {
  if (await get("SELECT 1 x FROM order_pickups op JOIN orders o ON o.id=op.order_id WHERE op.partner_id=? AND o.status NOT IN ('delivered','cancelled','refunded') LIMIT 1", int(req.params.id))) fail(409, 'This pickup point has orders in progress. Switch it off instead.');
  await run('UPDATE partners SET active=0 WHERE id=?', int(req.params.id)); // kept for order history; just switched off
  res.json({ ok: true });
}));

router.put('/products/:id/partner', ah(async (req, res) => {
  const pid = req.body.partnerId ? int(req.body.partnerId) : null;
  if (pid && !(await get('SELECT 1 x FROM partners WHERE id=?', pid))) fail(400, 'Pickup point not found.');
  const r = await run('UPDATE products SET partner_id=? WHERE id=?', pid, int(req.params.id));
  if (!r.changes) fail(404, 'Product not found.');
  await run("UPDATE products SET pharm_status='pending', pharm_approved_by='', pharm_approved_at=NULL WHERE id=? AND is_pharmacy=1 AND pharm_status='approved'", int(req.params.id));
  res.json({ ok: true });
}));
router.get('/riders', ah(async (req, res) => res.json({ riders: await all("SELECT id, name, email, phone, coverage, active, gdp FROM users WHERE role='rider' ORDER BY id") })));
router.post('/riders', ah(async (req, res) => {
  const b = req.body || {}, name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 30);
  if (!name || !isEmail(email) || phone.replace(/\D/g, '').length < 10) fail(400, 'A rider needs a name, a valid email and a phone number.');
  { const bad = PW.check(b.password, { email, name, min: PW.STAFF_MIN }); if (bad) fail(400, bad); }
  if (await get('SELECT 1 x FROM users WHERE email=?', email)) fail(409, 'That email already has an account.');
  const r = await run("INSERT INTO users (name,email,phone,password,role,coverage,gdp,created) VALUES (?,?,?,?, 'rider', ?, ?, ?)", name, email, phone, await A.hashPassword(b.password), str(b.coverage, 300), b.gdp ? 1 : 0, now());
  res.json({ ok: true, id: r.lastInsertRowid });
}));
router.put('/riders/:id', ah(async (req, res) => {
  const b = req.body || {}, id = int(req.params.id);
  const r = await run("UPDATE users SET gdp=COALESCE(?::int, gdp), coverage=?, active=?, phone=COALESCE(NULLIF(?, ''), phone) WHERE id=? AND role='rider'", 'gdp' in b ? (b.gdp ? 1 : 0) : null, str(b.coverage, 300), b.active === false || b.active === 0 ? 0 : 1, str(b.phone, 30), id);
  if (!r.changes) fail(404, 'Rider not found.');
  if (b.active === false || b.active === 0) await A.dropUserSessions(id);
  res.json({ ok: true });
}));

router.put('/orders/:id/rider', ah(async (req, res) => {
  const o = await S.loadOrder('id=?', int(req.params.id));
  if (!o) fail(404, 'Order not found.');
  if (['delivered', 'cancelled', 'refunded', 'pending'].includes(o.status)) fail(400, o.status === 'pending' ? 'Wait until the order is paid or confirmed before assigning a rider.' : `This order is ${o.status}.`);
  if (o.delivery === 'pickup') fail(400, 'Store pickup orders do not need a rider.');
  const riderId = req.body.riderId ? int(req.body.riderId) : null;
  if (riderId) {
    const rd = await get("SELECT name FROM users WHERE id=? AND role='rider' AND active=1", riderId);
    if (!rd) fail(400, 'Choose an active rider.');
    if (o.is_pharmacy) await require('../lib/pharmacy').checkRider(o, riderId);
    await run('UPDATE orders SET rider_id=?, accepted_at=NULL WHERE id=?', riderId, o.id);
    await D.issueCode(o.id);
    await S.addEvent(o.id, o.status, `Assigned to rider ${rd.name}`);
  } else { await run('UPDATE orders SET rider_id=NULL, accepted_at=NULL WHERE id=? AND status<>\'shipped\'', o.id); await S.addEvent(o.id, o.status, 'Rider removed'); }
  res.json({ ok: true });
}));
router.post('/orders/:id/handover', ah(async (req, res) => {
  const r = await D.override(int(req.params.id), req.user, str(req.body.action, 10), req.body.reason, !!req.body.cash);
  if (!r.ok) fail(r.status || 400, r.message);
  if (r.order) await S.mailOrderStatus(r.order, 'delivered', '');
  res.json({ ok: true });
}));
// Deliveries in progress, with the promised time, so late ones are easy to see.
router.get('/deliveries', ah(async (req, res) => {
  const rows = await all(`SELECT o.id, o.ref, o.status, o.name, o.phone, o.state, o.city, o.total, o.payment_method, o.created, o.promised_at, o.accepted_at, o.picked_up_at, o.on_way_at, o.handover_locked, o.rider_id, u.name rider
    FROM orders o LEFT JOIN users u ON u.id=o.rider_id WHERE o.delivery<>'pickup' AND o.status IN ('paid','confirmed','processing','shipped') ORDER BY o.promised_at NULLS LAST, o.id LIMIT 300`);
  const t = now();
  res.json({ deliveries: rows.map((r) => ({ ...r, late: !!(r.promised_at && Number(r.promised_at) < t), unassigned: !r.rider_id })) });
}));

module.exports = router;
