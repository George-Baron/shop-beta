'use strict';
const crypto = require('crypto');
const express = require('express');
const { get, all, run, insert, tx, now } = require('../lib/db');
const storage = require('../lib/storage');
const S = require('../lib/shop');
const A = require('../lib/auth');
const jobs = require('../lib/jobs');
const cache = require('../lib/cache');
const boot = require('../lib/bootstrap-admin');
const queue = require('../lib/queue');
const backup = require('../lib/backup');
const errors = require('../lib/errors');
const log = require('../lib/log');
const { slugify } = require('../lib/seed');
const { fail, str, int, isEmail, parseImages, getSettings, dayStart } = S;

const router = require('../lib/async-router').Router();
// Anything the admin changes that shoppers can see clears the catalogue cache on every instance, before the admin gets their answer.
// (Orders, messages and customers are not cached, so they do not count: busy order handling must not flush the cache.)
const SHOPPER_VISIBLE = /^\/(products|categories|stores|reviews|settings)(\/|$)/;
router.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && SHOPPER_VISIBLE.test(req.path)) {
    const json = res.json.bind(res);
    res.json = (body) => { if (res.statusCode < 400) cache.invalidate(); return json(body); };
  }
  next();
});
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const STATUSES = S.ORDER_STATUSES;
// "Sales" = orders that are not cancelled and are either paid online or pay-on-delivery.
const SALE = "o.status NOT IN ('cancelled','refunded') AND (o.payment_method = 'pod' OR o.payment_status = 'paid')";

/* ---------- first-run admin account ---------- */
// Normally the administrator is created from ADMIN_EMAIL / ADMIN_PASSWORD when the server starts. This page route exists only when
// ADMIN_SETUP_CODE is set, and then only works for someone who knows the code and only while no administrator exists.
router.get('/setup', async (req, res) => res.json({ needed: Boolean(boot.setupEnabled() && !await get("SELECT 1 x FROM users WHERE role='admin'")) }));
router.post('/setup', A.limiter('setup', 10, 3600000), ah(async (req, res) => {
  if (!boot.setupEnabled()) fail(403, 'Setup is switched off. The administrator is created from the server settings.');
  const b = req.body || {};
  if (!boot.setupCodeOk(b.code)) fail(403, 'That setup code is not right.');
  if (await get("SELECT 1 x FROM users WHERE role='admin'")) fail(403, 'An administrator already exists. Please sign in.');
  const email = str(b.email, 120).toLowerCase(), name = str(b.name, 80) || 'Store owner';
  if (!isEmail(email)) fail(400, 'Please enter a valid email address.');
  if (typeof b.password !== 'string' || b.password.length < boot.MIN_ADMIN_PASSWORD || b.password.length > 200) fail(400, `The administrator password must be at least ${boot.MIN_ADMIN_PASSWORD} characters.`);
  if (await get('SELECT 1 x FROM users WHERE lower(email)=?', email)) fail(409, 'That email is already registered as a customer. Use a different email.');
  let uid;
  try { uid = await insert("INSERT INTO users (name,email,phone,password,role,created) VALUES (?,?,'',?, 'admin', ?)", name, email, await A.hashPassword(b.password), now()); }
  catch (e) { if (e && e.code === '23505') fail(403, 'An administrator already exists. Please sign in.'); throw e; } // two setups at the same moment: only one wins
  await A.startSession(req, res, uid);
  res.json({ user: A.publicUser(await get('SELECT * FROM users WHERE id=?', uid)) });
}));

router.use(A.requireAdmin);

/* ---------- dashboard ---------- */
router.get('/dashboard', async (req, res) => {
  const t = now(), ds = dayStart(t), first = ds - 13 * 86400;
  const sales = (from, to = t + 86400) => get(`SELECT COALESCE(SUM(o.total),0) rev, COUNT(*) n FROM orders o WHERE o.created >= ? AND o.created < ? AND ${SALE}`, from, to);
  const [today, week, month, allTime, perDay, customers, byStatus, recent, top, low, unread] = await Promise.all([
    sales(ds), sales(ds - 6 * 86400), sales(ds - 29 * 86400), sales(0),
    all(`SELECT ((o.created - ?) / 86400) AS d, SUM(o.total) rev FROM orders o WHERE o.created >= ? AND o.created < ? AND ${SALE} GROUP BY d`, first, first, ds + 86400),
    get("SELECT COUNT(*) n FROM users WHERE role='customer'"),
    all('SELECT status, COUNT(*) n FROM orders GROUP BY status'),
    all('SELECT id, ref, name, total, status, created FROM orders ORDER BY id DESC LIMIT 8'),
    all(`SELECT MIN(oi.name) AS name, SUM(oi.qty) qty, SUM(oi.price*oi.qty) rev FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE ${SALE} GROUP BY oi.product_id ORDER BY qty DESC LIMIT 5`),
    all('SELECT id, name, stock FROM products WHERE active=1 AND stock<=5 ORDER BY stock, id LIMIT 8'),
    get('SELECT COUNT(*) n FROM messages WHERE read=0'),
  ]);
  const byDay = new Map(perDay.map((r) => [Number(r.d), r.rev]));
  const days = [];
  for (let i = 0; i < 14; i++) days.push({ t: first + i * 86400, rev: byDay.get(i) || 0 });
  res.json({ today, week, month, all: allTime, customers: customers.n, byStatus, days, recent, top, low, unread: unread.n });
});

/* ---------- orders ---------- */
router.get('/orders', async (req, res) => {
  const where = ['1=1'], args = [];
  const status = str(req.query.status, 20);
  if (STATUSES.includes(status)) { where.push('status=?'); args.push(status); }
  const q = str(req.query.q, 80).toLowerCase();
  if (q) { const l = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; where.push("(LOWER(ref) LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')"); args.push(l, l, l, l); }
  const total = (await get(`SELECT COUNT(*) n FROM orders WHERE ${where.join(' AND ')}`, ...args)).n;
  const per = 20, pages = Math.max(1, Math.ceil(total / per)), page = Math.min(pages, Math.max(1, int(req.query.page, 1)));
  res.json({ orders: await all(`SELECT id, ref, name, email, phone, total, status, payment_method, payment_status, created FROM orders WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, ...args), total, page, pages });
});
router.get('/orders/:id', async (req, res) => {
  const o = await S.loadOrder('id=?', int(req.params.id));
  if (!o) fail(404, 'Order not found.');
  res.json({ order: o, allowed: S.allowedNext(o) });
});
router.put('/orders/:id', async (req, res) => {
  const o = await S.loadOrder('id=?', int(req.params.id));
  if (!o) fail(404, 'Order not found.');
  await S.changeStatus(o, str(req.body.status, 20), str(req.body.note, 300), req.user.name);
  res.json({ ok: true });
});
// Pay on delivery: record that staff phoned the customer. Needed before the order can be confirmed and dispatched.
router.post('/orders/:id/confirm-phone', async (req, res) => {
  const o = await S.loadOrder('id=?', int(req.params.id));
  if (!o) fail(404, 'Order not found.');
  const note = str(req.body.note, 300);
  if (note.length < 3) fail(400, 'Please write who you spoke to and what they said (for example "Spoke to Mrs Obi, address confirmed").');
  await S.confirmByPhone(o, req.user.name, note);
  res.json({ ok: true });
});

/* ---------- products ---------- */
router.get('/products', async (req, res) => {
  const where = ['1=1'], args = [];
  const store = str(req.query.store, 40);
  if (store) { where.push('p.store=?'); args.push(store); }
  const q = str(req.query.q, 80).toLowerCase();
  if (q) { const l = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; where.push("(LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(p.sku) LIKE ? ESCAPE '\\' OR LOWER(p.brand) LIKE ? ESCAPE '\\')"); args.push(l, l, l); }
  res.json({ products: await all(`SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 300`, ...args) });
});
router.get('/products/:id', async (req, res) => {
  const p = await get('SELECT * FROM products WHERE id=?', int(req.params.id));
  if (!p) fail(404, 'Product not found.');
  res.json({ product: { ...p, images: parseImages(p.images), variants: await all('SELECT id, size, color, stock FROM variants WHERE product_id=? ORDER BY id', p.id) } });
});

const okImage = (u) => typeof u === 'string' && u.length <= 500 && (/^\/uploads\/[a-f0-9]{16,}\.(png|jpg|webp|gif)$/.test(u) || /^https:\/\/[^\s"'<>]+$/.test(u) || (storage.DRIVER === 'supabase' && u.startsWith(storage.publicUrl(''))));
async function readProduct(b) {
  const name = str(b.name, 140);
  if (!name) fail(400, 'Please enter a product name.');
  const store = str(b.store, 40);
  if (!await get('SELECT 1 x FROM stores WHERE slug=?', store)) fail(400, 'Please choose a department.');
  let category_id = b.category_id ? int(b.category_id) : null;
  if (category_id && !await get('SELECT 1 x FROM categories WHERE id=? AND store=?', category_id, store)) category_id = null;
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
router.post('/products', async (req, res) => {
  const p = await readProduct(req.body || {});
  const id = await tx(async () => {
    const r = await insert('INSERT INTO products (slug,store,category_id,name,brand,description,price,compare_price,stock,sku,emoji,images,size_label,featured,bestseller,new_arrival,active,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      await uniqueSlug(p.name), p.store, p.category_id, p.name, p.brand, p.description, p.price, p.compare, p.variants.length ? 0 : p.stock, p.sku, p.emoji, JSON.stringify(p.images), p.size_label, p.featured, p.bestseller, p.new_arrival, p.active, now());
    const pid = r;
    await saveVariants(pid, p.variants);
    return pid;
  });
  res.json({ ok: true, id });
});
router.put('/products/:id', async (req, res) => {
  const id = int(req.params.id);
  if (!await get('SELECT 1 x FROM products WHERE id=?', id)) fail(404, 'Product not found.');
  const p = await readProduct(req.body || {});
  await tx(async () => {
    await run('UPDATE products SET store=?,category_id=?,name=?,brand=?,description=?,price=?,compare_price=?,stock=?,sku=?,emoji=?,images=?,size_label=?,featured=?,bestseller=?,new_arrival=?,active=? WHERE id=?',
      p.store, p.category_id, p.name, p.brand, p.description, p.price, p.compare, p.variants.length ? 0 : p.stock, p.sku, p.emoji, JSON.stringify(p.images), p.size_label, p.featured, p.bestseller, p.new_arrival, p.active, id);
    await saveVariants(id, p.variants);
  });
  res.json({ ok: true });
});
router.delete('/products/:id', async (req, res) => {
  const id = int(req.params.id);
  if (await get('SELECT 1 x FROM order_items WHERE product_id=? LIMIT 1', id)) { await run('UPDATE products SET active=0 WHERE id=?', id); return res.json({ ok: true, archived: true }); }
  await run('DELETE FROM products WHERE id=?', id);
  res.json({ ok: true });
});

/* ---------- photo upload (Supabase Storage in production, see lib/storage.js) ---------- */
const MAGIC = [
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];
router.post('/upload', async (req, res) => {
  const m = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.data) || ''));
  if (!m) fail(400, 'Please choose a PNG, JPG, WEBP or GIF image.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 2_000_000) fail(400, 'That image is over 2 MB.');
  const kind = MAGIC.find((k) => k.test(buf));
  if (!kind) fail(400, 'That file is not a valid image.');
  const name = crypto.randomBytes(12).toString('hex') + '.' + kind.ext;
  try { res.json({ url: await storage.put(name, buf, kind.mime) }); }
  catch (e) { if (e instanceof storage.StorageError) fail(e.status, e.message); throw e; }
});

/* ---------- departments & categories ---------- */
router.get('/categories', async (req, res) => res.json({
  stores: await all('SELECT * FROM stores ORDER BY sort, slug'),
  categories: await all('SELECT c.id, c.store, c.slug, c.name, c.icon, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id) n FROM categories c ORDER BY c.sort, c.id'),
}));
const uniqueCatSlug = async (store, name, ignoreId) => {
  const base = `${store}-${slugify(name)}`; let s = base, n = 2;
  while (await get('SELECT 1 x FROM categories WHERE slug=? AND id<>?', s, ignoreId || 0)) s = `${base}-${n++}`;
  return s;
};
router.post('/categories', async (req, res) => {
  const store = str(req.body.store, 40), name = str(req.body.name, 40);
  if (!await get('SELECT 1 x FROM stores WHERE slug=?', store)) fail(400, 'Unknown department.');
  if (!name) fail(400, 'Please enter a category name.');
  const sort = (await get('SELECT COALESCE(MAX(sort),0)+1 n FROM categories WHERE store=?', store)).n;
  await run('INSERT INTO categories (store,slug,name,icon,sort) VALUES (?,?,?,?,?)', store, await uniqueCatSlug(store, name), name, str(req.body.icon, 8) || '🛍', sort);
  res.json({ ok: true });
});
router.put('/categories/:id', async (req, res) => {
  const id = int(req.params.id), c = await get('SELECT * FROM categories WHERE id=?', id), name = str(req.body.name, 40);
  if (!c) fail(404, 'Category not found.');
  if (!name) fail(400, 'Please enter a category name.');
  await run('UPDATE categories SET name=?, icon=? WHERE id=?', name, str(req.body.icon, 8) || '🛍', id);
  res.json({ ok: true });
});
router.delete('/categories/:id', async (req, res) => { await run('DELETE FROM categories WHERE id=?', int(req.params.id)); res.json({ ok: true }); });
const STORE_FIELDS = ['name', 'tab_label', 'icon', 'tagline', 'hero_title', 'hero_sub', 'hero_cta', 'promo1_title', 'promo1_sub', 'promo2_title', 'promo2_sub', 'banner_title', 'banner_sub'];
router.put('/stores/:slug', async (req, res) => {
  const slug = str(req.params.slug, 40);
  if (!await get('SELECT 1 x FROM stores WHERE slug=?', slug)) fail(404, 'Department not found.');
  const b = req.body || {};
  if (!str(b.name, 100) || !str(b.tab_label, 40)) fail(400, 'The name and tab label cannot be empty.');
  if (!b.active && (await get('SELECT COUNT(*) n FROM stores WHERE active=1 AND slug<>?', slug)).n === 0) fail(400, 'At least one department must stay visible.');
  await run(`UPDATE stores SET ${STORE_FIELDS.map((f) => f + '=?').join(', ')}, active=? WHERE slug=?`, ...STORE_FIELDS.map((f) => str(b[f], 200)), b.active ? 1 : 0, slug);
  res.json({ ok: true });
});

/* ---------- customers ---------- */
router.get('/customers', async (req, res) => res.json({
  customers: await all(`SELECT u.id, u.name, u.email, u.phone, u.created, (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) orders,
    (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.user_id=u.id AND ${SALE}) spent FROM users u WHERE u.role='customer' ORDER BY u.id DESC LIMIT 500`),
}));

/* ---------- coupons ---------- */
router.get('/coupons', async (req, res) => res.json({ coupons: await all('SELECT * FROM coupons ORDER BY seq DESC') }));
router.post('/coupons', async (req, res) => {
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
});
router.delete('/coupons/:code', async (req, res) => { await run('DELETE FROM coupons WHERE code=?', str(req.params.code, 30)); res.json({ ok: true }); });

/* ---------- reviews ---------- */
router.get('/reviews', async (req, res) => res.json({ reviews: await all('SELECT r.id, r.rating, r.title, r.body, r.name, r.approved, r.created, p.name product FROM reviews r JOIN products p ON p.id=r.product_id ORDER BY r.id DESC LIMIT 200') }));
router.put('/reviews/:id', async (req, res) => { await run('UPDATE reviews SET approved=? WHERE id=?', req.body.approved ? 1 : 0, int(req.params.id)); res.json({ ok: true }); });
router.delete('/reviews/:id', async (req, res) => { await run('DELETE FROM reviews WHERE id=?', int(req.params.id)); res.json({ ok: true }); });

/* ---------- messages ---------- */
router.get('/messages', async (req, res) => res.json({ messages: await all('SELECT * FROM messages ORDER BY id DESC LIMIT 200') }));
router.put('/messages/:id', async (req, res) => { await run('UPDATE messages SET read=? WHERE id=?', req.body.read ? 1 : 0, int(req.params.id)); res.json({ ok: true }); });
router.delete('/messages/:id', async (req, res) => { await run('DELETE FROM messages WHERE id=?', int(req.params.id)); res.json({ ok: true }); });

/* ---------- marketing ---------- */
router.get('/newsletter', async (req, res) => res.json({ subscribers: await all('SELECT email, created FROM newsletter ORDER BY created DESC LIMIT 2000') }));
router.get('/abandoned', async (req, res) => res.json({ carts: (await all('SELECT email, cart, created, reminded FROM abandoned ORDER BY created DESC LIMIT 200')).map((c) => { let cart = []; try { cart = JSON.parse(c.cart); } catch { /* empty */ } return { ...c, cart }; }) }));
router.post('/abandoned/remind', async (req, res) => res.json({ sent: await jobs.remindAbandoned() }));
router.get('/outbox', async (req, res) => res.json({ emails: await all('SELECT id, to_email, subject, sent, created FROM outbox ORDER BY id DESC LIMIT 100'), live: !!process.env.RESEND_API_KEY }));

/* ---------- background jobs ---------- */
router.get('/jobs', async (req, res) => res.json({ overview: await queue.overview(), failed: await queue.failedList(100), worker: process.env.WORKER !== '0' }));
router.post('/jobs/:id/retry', async (req, res) => { if (!await queue.retry(int(req.params.id))) fail(404, 'That job is not in the failed list.'); res.json({ ok: true }); });
router.post('/jobs/retry-all', async (req, res) => res.json({ retried: (await run("UPDATE jobs SET state='queued', attempts=0, run_at=?, locked_until=0, last_error='', finished=NULL WHERE state='failed'", now())).changes }));
router.delete('/jobs/:id', async (req, res) => { if (!await queue.discard(int(req.params.id))) fail(404, 'That job is not in the failed list.'); res.json({ ok: true }); });

/* ---------- errors and backups (docs/OPERATIONS.md) ---------- */
router.get('/ops', async (req, res) => res.json({
  errors: await errors.list(), backups: await backup.list(), backupStatus: await backup.status(), keep: backup.KEEP,
  storage: storage.DRIVER, backupsOn: process.env.BACKUPS !== '0',
  alerts: { email: !!process.env.ALERT_EMAIL && !!process.env.RESEND_API_KEY, webhook: !!process.env.ALERT_WEBHOOK_URL },
}));
router.post('/errors/:id/resolve', async (req, res) => { if (!await errors.resolve(int(req.params.id))) fail(404, 'That error is already marked fixed.'); res.json({ ok: true }); });
router.post('/backups', async (req, res) => {
  const id = await queue.enqueue('backup', { kind: 'manual' }, { singletonKey: 'backup-now', maxAttempts: 2 });
  res.status(202).json({ queued: !!id, message: id ? 'Backup started. It appears in the list in a minute or two.' : 'A backup is already waiting to run.' });
});
// Download a fresh copy of the whole database right now (no storage needed). Contains customer data and password hashes: keep it private.
router.get('/backups/download', A.limitBy('backup-download', { ids: (req) => [req.user.id], max: 4, windowMs: 3600e3, ipMax: 30, msg: 'You can download at most 4 backups an hour.' }), async (req, res) => {
  const name = `shop-beta-${backup.stamp()}.ndjson.gz`;
  res.setHeader('Content-Type', 'application/gzip'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.setHeader('Cache-Control', 'no-store');
  await run("INSERT INTO backups (started,finished,state,kind,location,instance) VALUES (?,?,'ok','download',?,?)", now(), now(), 'downloaded by ' + req.user.email, log.INSTANCE);
  log.warn('Database backup downloaded', { by: req.user.email, ip: req.ip, file: name });
  try { await backup.dumpToStream(res); } catch (e) { log.error('Backup download failed:', e); errors.record(e, { source: 'backup', route: 'download' }); }
});
router.get('/backups/:id/download', A.limitBy('backup-download', { ids: (req) => [req.user.id], max: 4, windowMs: 3600e3, ipMax: 30, msg: 'You can download at most 4 backups an hour.' }), async (req, res) => {
  const b = await get("SELECT * FROM backups WHERE id=? AND state='ok' AND kind IN ('scheduled','manual')", int(req.params.id));
  if (!b || !b.location) fail(404, 'That backup was not found.');
  const buf = await storage.backupGet(b.location);
  log.warn('Stored backup downloaded', { by: req.user.email, ip: req.ip, file: b.location });
  res.setHeader('Content-Type', 'application/gzip'); res.setHeader('Content-Disposition', `attachment; filename="${b.location}"`); res.setHeader('Cache-Control', 'no-store'); res.send(buf);
});

/* ---------- settings ---------- */
const TEXT_KEYS = ['store_name', 'tagline', 'announcement', 'contact_phone', 'address', 'pickup_address', 'tax_note', 'ga_id', 'meta_pixel_id'];
const URL_KEYS = ['logo_url', 'instagram', 'facebook', 'x_twitter', 'tiktok'];
router.get('/settings', async (req, res) => {
  const settings = await getSettings(); delete settings.demo_seeded;
  res.json({ settings, zones: await all('SELECT state, fee, eta, pod FROM zones ORDER BY sort, state'), paystack: { live: S.paystackLive() } });
});
router.put('/settings', async (req, res) => {
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
  await tx(async () => {
    for (const [k, v] of Object.entries(out)) await run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
    for (const z of (Array.isArray(b.zones) ? b.zones : []).slice(0, 60)) await run('UPDATE zones SET fee=?, eta=?, pod=? WHERE state=?', Math.max(0, int(z.fee)), str(z.eta, 30), z.pod ? 1 : 0, str(z.state, 60));
  });
  res.json({ ok: true });
});

module.exports = router;
