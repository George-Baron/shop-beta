'use strict';
// Partner stores ("vendors"). Customers see a store only when we have approved it; its products only when we have approved each one.
// Money: the customer pays us. For every order line we record the store's share and our commission; the payout ledger records what we paid out.
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const A = require('./auth');
const PC = require('./pharmacy-core');
const CAT = require('./catalog');
const cache = require('./cache');
const { slugify } = require('./seed');
const { fail, str, int, isEmail } = S;

const MAX_DEPARTMENTS = 3;
const DELIVERED_BALANCE_STATES = ['delivered'];
const IN_PROGRESS = ['paid', 'confirmed', 'processing', 'shipped'];

// SQL condition: "this product is ours, or its store is approved and we approved the product". Added to PC.visibleSql so every customer-facing query gets it.
const visibleSql = (a = 'p') => `(${a}.vendor_id IS NULL OR (${a}.listing = 'approved' AND EXISTS (SELECT 1 FROM vendors vv WHERE vv.id = ${a}.vendor_id AND vv.status = 'approved')))`;

const uniqueSlug = async (name) => {
  const base = slugify(name) || 'store'; let s = base, n = 2;
  while (await get('SELECT 1 x FROM vendors WHERE slug=?', s)) s = `${base}-${n++}`;
  return s;
};
const pct = (v, d = 10) => { const n = Number(v); return Number.isFinite(n) ? Math.min(60, Math.max(0, Math.round(n * 100) / 100)) : d; };
const okImage = (u) => !u || CAT.okImage(u);

/* ---------- departments ---------- */
async function departmentsOf(vendorId) {
  return all('SELECT vd.store, vd.commission_pct, s.name, s.icon FROM vendor_departments vd JOIN stores s ON s.slug = vd.store WHERE vd.vendor_id=? ORDER BY s.sort, s.slug', vendorId);
}
// Replaces a store's departments. At most 3; the pharmacy department can only be given by us (admin = true).
async function setDepartments(vendorId, list, admin) {
  const rows = [], seen = new Set();
  for (const d of Array.isArray(list) ? list : []) {
    const slug = str(d && typeof d === 'object' ? d.store : d, 40);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    if (!(await get('SELECT 1 x FROM stores WHERE slug=?', slug))) fail(400, 'One of the departments does not exist.');
    if (slug === PC.PHARMACY_STORE && !admin) fail(400, 'Medicines are listed by our pharmacy team. Choose other departments.');
    rows.push({ slug, pct: admin && d && typeof d === 'object' && d.commission_pct !== '' && d.commission_pct != null ? pct(d.commission_pct) : null });
  }
  if (!rows.length) fail(400, 'Please choose at least one department.');
  if (rows.length > MAX_DEPARTMENTS) fail(400, `A partner store can have at most ${MAX_DEPARTMENTS} departments.`);
  await tx(async () => {
    const keep = new Set(rows.map((r) => r.slug));
    for (const cur of await all('SELECT store FROM vendor_departments WHERE vendor_id=?', vendorId)) {
      if (keep.has(cur.store)) continue;
      if (await get("SELECT 1 x FROM products WHERE vendor_id=? AND store=? AND active=1 LIMIT 1", vendorId, cur.store)) fail(409, 'Switch off or move the active products in a department before removing it.');
      await run('DELETE FROM vendor_departments WHERE vendor_id=? AND store=?', vendorId, cur.store);
    }
    for (const r of rows) {
      if (await get('SELECT 1 x FROM vendor_departments WHERE vendor_id=? AND store=?', vendorId, r.slug)) { if (admin) await run('UPDATE vendor_departments SET commission_pct=? WHERE vendor_id=? AND store=?', r.pct, vendorId, r.slug); }
      else await run('INSERT INTO vendor_departments (vendor_id, store, commission_pct) VALUES (?,?,?)', vendorId, r.slug, r.pct);
    }
  });
}

/* ---------- applying to become a partner store ---------- */
async function apply(b) {
  const name = str(b.name, 80), contact = str(b.contactName, 80), email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 30);
  const address = str(b.address, 200), state = str(b.state, 60), city = str(b.city, 60), about = str(b.about, 1500), regNo = str(b.regNo, 40);
  if (name.length < 2) fail(400, 'Please enter your store name.');
  if (contact.length < 2) fail(400, 'Please enter the contact person\'s name.');
  if (!isEmail(email)) fail(400, 'Please enter a valid email address.');
  if (phone.replace(/\D/g, '').length < 10) fail(400, 'Please enter a phone number we can call.');
  if (address.length < 6 || !state) fail(400, 'Please enter your store address and state.');
  if (!regNo) fail(400, 'Please enter your business registration number (CAC). We check it before approving you.');
  const pw = String(b.password || '');
  const problem = require('./passwords').check(pw, { email, name: contact, min: require('./passwords').STAFF_MIN });
  if (problem) fail(400, problem);
  if (await get('SELECT 1 x FROM users WHERE email=?', email)) fail(409, 'That email already has an account. Sign in, or use another email for the store.');
  const depts = Array.isArray(b.departments) ? b.departments : [];
  return tx(async () => {
    const r = await run('INSERT INTO vendors (slug,name,about,contact_name,phone,email,address,state,city,reg_no,status,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      await uniqueSlug(name), name, about, contact, phone, email, address, state, city, regNo, 'pending', now());
    const vid = Number(r.lastInsertRowid);
    await setDepartments(vid, depts, false);
    await run("INSERT INTO users (name,email,phone,password,role,created,vendor_id) VALUES (?,?,?,?,'vendor',?,?)", contact, email, phone, await A.hashPassword(pw), now(), vid);
    return vid;
  });
}

/* ---------- a store's own view ---------- */
async function mine(user) {
  if (!user || user.role !== 'vendor' || !user.vendor_id) fail(401, 'Please sign in as a partner store.');
  const v = await get('SELECT * FROM vendors WHERE id=?', user.vendor_id);
  if (!v) fail(401, 'Your store was not found.');
  return v;
}
const privateVendor = (v, depts) => ({
  id: Number(v.id), slug: v.slug, name: v.name, tagline: v.tagline, about: v.about, logo: v.logo, banner: v.banner, emoji: v.emoji,
  contact_name: v.contact_name, phone: v.phone, email: v.email, address: v.address, state: v.state, city: v.city, opening_hours: v.opening_hours,
  reg_no: v.reg_no, status: v.status, status_note: v.status_note, created: Number(v.created), departments: depts,
});
async function profile(user) { const v = await mine(user); return privateVendor(v, await departmentsOf(v.id)); }
async function saveProfile(user, b) {
  const v = await mine(user);
  const logo = str(b.logo, 500), banner = str(b.banner, 500);
  if (!okImage(logo) || !okImage(banner)) fail(400, 'One of the image links is not allowed. Upload a photo or use an https link.');
  const name = str(b.name, 80) || v.name;
  await run('UPDATE vendors SET name=?, tagline=?, about=?, logo=?, banner=?, emoji=?, contact_name=?, phone=?, address=?, state=?, city=?, opening_hours=? WHERE id=?',
    name, str(b.tagline, 120), str(b.about, 1500), logo, banner, str(b.emoji, 8) || '🏪', str(b.contact_name, 80) || v.contact_name, str(b.phone, 30) || v.phone,
    str(b.address, 200) || v.address, str(b.state, 60) || v.state, str(b.city, 60), str(b.opening_hours, 120), v.id);
  // The pickup point riders use carries the store's name and phone. The map position is ours to set, so an address change is shown to us for a re-check.
  if (v.partner_id) await run('UPDATE partners SET name=?, phone=?, address=?, state=? WHERE id=?', name, str(b.phone, 30) || v.phone, str(b.address, 200) || v.address, str(b.state, 60) || v.state, v.partner_id);
  if (v.partner_id && str(b.address, 200) && str(b.address, 200) !== v.address) await run("UPDATE vendors SET status_note=? WHERE id=?", 'Address changed: please re-check the map position.', v.id);
  cache.clear();
  return profile(user);
}
async function saveDepartments(user, list) { const v = await mine(user); await setDepartments(v.id, list, false); cache.clear(); return departmentsOf(v.id); }

/* ---------- a store's products (always reviewed by us before customers see them) ---------- */
const REVIEWED = ['name', 'brand', 'description', 'store', 'category_id'];
async function myProducts(user, q = {}) {
  const v = await mine(user);
  const where = ['p.vendor_id=?'], args = [v.id];
  if (q.listing && ['pending', 'approved', 'rejected'].includes(q.listing)) { where.push('p.listing=?'); args.push(q.listing); }
  if (q.q) { where.push("lower(p.name) LIKE ? ESCAPE '\\'"); args.push('%' + String(q.q).toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c).slice(0, 60) + '%'); }
  return all(`SELECT p.id, p.slug, p.name, p.store, p.price, p.stock, p.active, p.listing, p.listing_note, p.images, p.emoji, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 300`, ...args);
}
async function myProduct(user, id) {
  const v = await mine(user);
  const p = await get('SELECT * FROM products WHERE id=? AND vendor_id=?', int(id), v.id);
  if (!p) fail(404, 'Product not found.');
  return { ...p, images: S.parseImages(p.images), variants: await all('SELECT id, size, color, stock FROM variants WHERE product_id=? ORDER BY id', p.id) };
}
async function readMine(v, b) {
  const p = await CAT.readProduct({ ...b, featured: 0, bestseller: 0 });
  if (p.store === PC.PHARMACY_STORE) fail(400, 'Medicines are listed by our pharmacy team.');
  if (!(await get('SELECT 1 x FROM vendor_departments WHERE vendor_id=? AND store=?', v.id, p.store))) fail(400, 'Choose one of your store\'s departments.');
  return p;
}
async function createProduct(user, b) {
  const v = await mine(user), p = await readMine(v, b || {});
  const id = await tx(async () => {
    const r = await run("INSERT INTO products (slug,store,category_id,name,brand,description,price,compare_price,stock,sku,emoji,images,size_label,featured,bestseller,new_arrival,active,created,vendor_id,partner_id,listing) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,'pending')",
      await CAT.uniqueSlug(p.name), p.store, p.category_id, p.name, p.brand, p.description, p.price, p.compare, p.variants.length ? 0 : p.stock, p.sku, p.emoji, JSON.stringify(p.images), p.size_label, p.new_arrival, p.active, now(), v.id, v.partner_id);
    const pid = Number(r.lastInsertRowid);
    await CAT.saveVariants(pid, p.variants);
    return pid;
  });
  return id;
}
async function updateProduct(user, id, b) {
  const v = await mine(user), cur = await get('SELECT * FROM products WHERE id=? AND vendor_id=?', int(id), v.id);
  if (!cur) fail(404, 'Product not found.');
  const p = await readMine(v, b || {});
  // Changing what the product IS (name, description, photos, department) sends it back for our review. Price and stock changes do not.
  const changed = p.name !== cur.name || p.brand !== cur.brand || p.description !== cur.description || p.store !== cur.store || (p.category_id || null) !== (cur.category_id == null ? null : Number(cur.category_id)) || JSON.stringify(p.images) !== (cur.images || '[]');
  await tx(async () => {
    await run('UPDATE products SET store=?,category_id=?,name=?,brand=?,description=?,price=?,compare_price=?,stock=?,sku=?,emoji=?,images=?,size_label=?,new_arrival=?,active=? WHERE id=? AND vendor_id=?',
      p.store, p.category_id, p.name, p.brand, p.description, p.price, p.compare, p.variants.length ? 0 : p.stock, p.sku, p.emoji, JSON.stringify(p.images), p.size_label, p.new_arrival, p.active, cur.id, v.id);
    if (changed && cur.listing !== 'pending') await run("UPDATE products SET listing='pending', listing_note='' WHERE id=?", cur.id);
    await CAT.saveVariants(cur.id, p.variants);
  });
  cache.clear();
  return { resubmitted: changed && cur.listing !== 'pending' };
}
async function setStock(user, id, stock) {
  const v = await mine(user), cur = await get('SELECT id FROM products WHERE id=? AND vendor_id=?', int(id), v.id);
  if (!cur) fail(404, 'Product not found.');
  if (await get('SELECT 1 x FROM variants WHERE product_id=? LIMIT 1', cur.id)) fail(400, 'This product has sizes or colours. Edit the product to change each one\'s stock.');
  await run('UPDATE products SET stock=? WHERE id=?', Math.max(0, int(stock)), cur.id);
  cache.drop('stock:' + cur.id); cache.clear();
}
async function deleteProduct(user, id) {
  const v = await mine(user), cur = await get('SELECT id FROM products WHERE id=? AND vendor_id=?', int(id), v.id);
  if (!cur) fail(404, 'Product not found.');
  if (await get('SELECT 1 x FROM order_items WHERE product_id=? LIMIT 1', cur.id)) { await run('UPDATE products SET active=0 WHERE id=?', cur.id); cache.clear(); return { archived: true }; }
  await run('DELETE FROM products WHERE id=?', cur.id); cache.clear();
  return { archived: false };
}

/* ---------- money ---------- */
async function balanceOf(vendorId) {
  const done = await get(`SELECT COALESCE(SUM(oi.price*oi.qty),0) gross, COALESCE(SUM(oi.commission),0) commission FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.vendor_id=? AND o.status = ANY(?)`, vendorId, DELIVERED_BALANCE_STATES);
  const prog = await get(`SELECT COALESCE(SUM(oi.price*oi.qty - oi.commission),0) net FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.vendor_id=? AND o.status = ANY(?)`, vendorId, IN_PROGRESS);
  const paid = await get('SELECT COALESCE(SUM(amount),0) n FROM vendor_payouts WHERE vendor_id=?', vendorId);
  const gross = Number(done.gross), commission = Number(done.commission), net = gross - commission, paidOut = Number(paid.n);
  return { gross, commission, net, paid: paidOut, balance: net - paidOut, in_progress: Number(prog.net) };
}
async function myEarnings(user) {
  const v = await mine(user);
  return { ...(await balanceOf(v.id)), payouts: await all('SELECT amount, method, reference, note, created FROM vendor_payouts WHERE vendor_id=? ORDER BY id DESC LIMIT 100', v.id) };
}
// What a store needs to prepare an order. No customer address or phone: our rider collects and delivers.
async function ordersFor(vendorId, limit = 100) {
  const rows = await all(`SELECT oi.order_id, oi.name, oi.variant_label, oi.price, oi.qty, oi.commission, o.ref, o.status, o.created, o.delivery, o.payment_method, o.payment_status
    FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.vendor_id=? AND o.status <> 'cancelled' AND (o.payment_method='pod' OR o.payment_status='paid' OR o.status IN ('refunded'))
    ORDER BY o.id DESC, oi.id LIMIT ${Math.min(500, limit * 5)}`, vendorId);
  const map = new Map();
  for (const r of rows) {
    let o = map.get(r.order_id);
    if (!o) { if (map.size >= limit) continue; o = { ref: r.ref, status: r.status, created: Number(r.created), delivery: r.delivery, items: [], gross: 0, commission: 0 }; map.set(r.order_id, o); }
    o.items.push({ name: r.name, variant: r.variant_label, qty: r.qty, price: r.price }); o.gross += r.price * r.qty; o.commission += r.commission;
  }
  return [...map.values()].map((o) => ({ ...o, net: o.gross - o.commission }));
}
const myOrders = async (user) => ordersFor((await mine(user)).id);

/* ---------- commission recorded at checkout ---------- */
// The rate for a store's department: the department's own rate when we set one, otherwise the store's rate.
const commissionFor = (line) => Math.floor((line.price * line.qty * (Number(line.commissionPct) || 0)) / 100);

/* ---------- public pages ---------- */
const publicVendor = (v) => ({ slug: v.slug, name: v.name, tagline: v.tagline, about: v.about, logo: v.logo, banner: v.banner, emoji: v.emoji, city: v.city, state: v.state, opening_hours: v.opening_hours });
async function listPublic({ store, q, page = 1 } = {}) {
  const where = ["v.status='approved'"], args = [];
  if (store) { where.push('EXISTS (SELECT 1 FROM vendor_departments vd WHERE vd.vendor_id=v.id AND vd.store=?)'); args.push(store); }
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4);
  for (const w of words) { where.push("lower(v.name) LIKE ? ESCAPE '\\'"); args.push('%' + w.replace(/[\\%_]/g, (c) => '\\' + c) + '%'); }
  const rows = await all(`SELECT v.*, (SELECT COUNT(*) FROM products p WHERE p.vendor_id=v.id AND p.active=1 AND p.listing='approved' AND ${PC.visibleSql('p')}) AS n FROM vendors v WHERE ${where.join(' AND ')} ORDER BY lower(v.name) LIMIT 60`, ...args);
  const depts = rows.length ? await all(`SELECT vd.vendor_id, s.slug, s.name, s.icon FROM vendor_departments vd JOIN stores s ON s.slug=vd.store WHERE vd.vendor_id = ANY(?) AND ${PC.storeVisibleSql('s')} ORDER BY s.sort`, rows.map((r) => r.id)) : [];
  return rows.filter((r) => Number(r.n) > 0 || !words.length || true).map((r) => ({ ...publicVendor(r), products: Number(r.n), departments: depts.filter((d) => String(d.vendor_id) === String(r.id)).map((d) => ({ slug: d.slug, name: d.name, icon: d.icon })) }));
}
async function pagePublic(slug) {
  const v = await get("SELECT * FROM vendors WHERE slug=? AND status='approved'", str(slug, 80));
  if (!v) fail(404, 'We could not find that store.');
  const depts = (await departmentsOf(v.id)).filter((d) => !PC.storeHidden(d.store));
  const cats = await all('SELECT DISTINCT c.id, c.slug, c.name, c.icon, c.store FROM categories c JOIN products p ON p.category_id=c.id WHERE p.vendor_id=? AND p.active=1 AND p.listing=\'approved\' ORDER BY c.name', v.id);
  return { vendor: publicVendor(v), departments: depts.map((d) => ({ slug: d.store, name: d.name, icon: d.icon })), categories: cats };
}

module.exports = {
  MAX_DEPARTMENTS, visibleSql, uniqueSlug, pct, apply, mine, profile, saveProfile, saveDepartments, departmentsOf, setDepartments, privateVendor,
  myProducts, myProduct, createProduct, updateProduct, setStock, deleteProduct, balanceOf, myEarnings, ordersFor, myOrders, commissionFor, listPublic, pagePublic, publicVendor,
};
