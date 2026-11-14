'use strict';
// Admin: partner stores. Mounted inside routes/admin.js, so the admin sign-in check, audit log and cache clearing already apply.
const express = require('express');
const { get, all, run, tx, now } = require('../lib/db');
const S = require('../lib/shop');
const V = require('../lib/vendors');
const geo = require('../lib/geo');
const cache = require('../lib/cache');
const { fail, str, int } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const mail = async (v, subject, html) => { try { await S.queueMail(v.email, subject, S.mailWrap(await S.getSettings(), html)); } catch (e) { console.error('Partner email failed:', e.message); } };

async function load(id) {
  const v = await get('SELECT * FROM vendors WHERE id=?', int(id));
  if (!v) fail(404, 'Partner store not found.');
  return v;
}
const row = async (v) => ({ ...v, id: Number(v.id), created: Number(v.created), lat: v.lat, lng: v.lng, departments: await V.departmentsOf(v.id), ...(await V.balanceOf(v.id)) });

router.get('/', ah(async (req, res) => {
  const where = [], args = [];
  if (['pending', 'approved', 'rejected', 'suspended'].includes(req.query.status)) { where.push('v.status=?'); args.push(req.query.status); }
  if (req.query.q) { where.push("lower(v.name) LIKE ? ESCAPE '\\'"); args.push('%' + String(req.query.q).toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c).slice(0, 60) + '%'); }
  const rows = await all(`SELECT v.*, (SELECT COUNT(*) FROM products p WHERE p.vendor_id=v.id) AS products, (SELECT COUNT(*) FROM products p WHERE p.vendor_id=v.id AND p.listing='pending') AS to_review
    FROM vendors v ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE v.status WHEN 'pending' THEN 0 ELSE 1 END, v.id DESC LIMIT 300`, ...args);
  const out = [];
  for (const v of rows) out.push({ ...(await row(v)), products: Number(v.products), to_review: Number(v.to_review) });
  res.json({ vendors: out, max_departments: V.MAX_DEPARTMENTS });
}));

router.get('/payables', ah(async (req, res) => {
  const list = [];
  for (const v of await all("SELECT id, name, status FROM vendors ORDER BY name")) list.push({ id: Number(v.id), name: v.name, status: v.status, ...(await V.balanceOf(v.id)) });
  res.json({ vendors: list.filter((x) => x.gross || x.paid || x.in_progress), owed: list.reduce((s, x) => s + Math.max(0, x.balance), 0) });
}));

// Partner products waiting for our review (every new partner product, and any edit to what the product is).
router.get('/review/products', ah(async (req, res) => res.json({ products: await all(`SELECT p.id, p.name, p.brand, p.description, p.price, p.stock, p.images, p.emoji, p.store, p.listing, p.listing_note, v.id AS vendor_id, v.name AS vendor_name, v.status AS vendor_status, c.name AS category
  FROM products p JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.listing='pending' ORDER BY p.id LIMIT 200`).then((rs) => rs.map((r) => ({ ...r, images: S.parseImages(r.images) }))) })));
router.post('/review/products/:pid', ah(async (req, res) => {
  const decision = req.body && req.body.decision, note = str(req.body && req.body.note, 300);
  if (!['approved', 'rejected'].includes(decision)) fail(400, 'Choose approve or reject.');
  if (decision === 'rejected' && !note) fail(400, 'Please tell the store why, so they can fix it.');
  const r = await run("UPDATE products SET listing=?, listing_note=? WHERE id=? AND vendor_id IS NOT NULL", decision, decision === 'rejected' ? note : '', int(req.params.pid));
  if (!r.changes) fail(404, 'Product not found.');
  res.json({ ok: true });
}));

router.get('/:id', ah(async (req, res) => {
  const v = await load(req.params.id);
  const users = await all("SELECT id, name, email, phone, active FROM users WHERE vendor_id=? AND role='vendor'", v.id);
  res.json({
    vendor: await row(v), users, partner: v.partner_id ? await get('SELECT id, name, address, lat, lng, radius_km, active FROM partners WHERE id=?', v.partner_id) : null,
    payouts: await all('SELECT id, amount, method, reference, note, created, created_by FROM vendor_payouts WHERE vendor_id=? ORDER BY id DESC LIMIT 100', v.id),
    orders: await V.ordersFor(v.id, 50), all_departments: await all('SELECT slug, name, icon FROM stores ORDER BY sort, slug'),
  });
}));

router.put('/:id', ah(async (req, res) => {
  const v = await load(req.params.id), b = req.body || {};
  const lat = num(b.lat), lng = num(b.lng);
  if ((lat != null && (lat < -90 || lat > 90)) || (lng != null && (lng < -180 || lng > 180))) fail(400, 'The map position is not valid.');
  await tx(async () => {
    await run('UPDATE vendors SET name=?, tagline=?, about=?, contact_name=?, phone=?, email=?, address=?, state=?, city=?, opening_hours=?, reg_no=?, commission_pct=?, lat=?, lng=?, status_note=? WHERE id=?',
      str(b.name, 80) || v.name, str(b.tagline, 120), str(b.about, 1500), str(b.contact_name, 80), str(b.phone, 30), str(b.email, 120).toLowerCase() || v.email, str(b.address, 200), str(b.state, 60), str(b.city, 60), str(b.opening_hours, 120), str(b.reg_no, 40),
      V.pct(b.commission_pct, Number(v.commission_pct)), lat, lng, str(b.status_note, 300), v.id);
    if (Array.isArray(b.departments)) await V.setDepartments(v.id, b.departments, true);
    // keep the rider pickup point in step with the store
    if (v.partner_id) await run('UPDATE partners SET name=?, phone=?, address=?, state=?, lat=COALESCE(?,lat), lng=COALESCE(?,lng) WHERE id=?', str(b.name, 80) || v.name, str(b.phone, 30), str(b.address, 200), str(b.state, 60), lat, lng, v.partner_id);
  });
  res.json({ ok: true, vendor: await row(await load(v.id)) });
}));

// Looks the address up on the map provider (when a key is set) so we do not have to type coordinates.
router.post('/:id/locate', ah(async (req, res) => {
  const v = await load(req.params.id);
  let results = [];
  try { results = await geo.search([v.address, v.city, v.state, 'Nigeria'].filter(Boolean).join(', ')); } catch { /* no provider */ }
  res.json({ results: (results || []).slice(0, 5) });
}));

router.post('/:id/approve', ah(async (req, res) => {
  const v = await load(req.params.id);
  if (v.lat == null || v.lng == null) fail(400, 'Set the store\'s map position (latitude and longitude) first, so riders can find it.');
  if (!(await get('SELECT 1 x FROM vendor_departments WHERE vendor_id=?', v.id))) fail(400, 'The store needs at least one department.');
  if (!v.reg_no) fail(400, 'Enter and check the business registration number first.');
  await tx(async () => {
    let pid = v.partner_id ? Number(v.partner_id) : null;
    if (pid) await run('UPDATE partners SET name=?, address=?, state=?, phone=?, lat=?, lng=?, active=1 WHERE id=?', v.name, v.address, v.state, v.phone, v.lat, v.lng, pid);
    else pid = Number((await run('INSERT INTO partners (name,address,state,phone,lat,lng,radius_km,is_default,active,created) VALUES (?,?,?,?,?,?,?,0,1,?)', v.name, v.address, v.state, v.phone, v.lat, v.lng, 15, now())).lastInsertRowid);
    await run("UPDATE vendors SET status='approved', status_note='', partner_id=?, approved_at=? WHERE id=?", pid, now(), v.id);
    await run('UPDATE products SET partner_id=? WHERE vendor_id=?', pid, v.id);
  });
  cache.clear();
  await mail(v, 'Your Shop-Beta partner store is approved', `<p>Hi ${S.esc(v.contact_name)}, <b>${S.esc(v.name)}</b> is approved as a Shop-Beta partner store. Products you add are shown to customers once our team has reviewed each one. Sign in at ${S.BASE_URL}/partner.</p>`);
  res.json({ ok: true, vendor: await row(await load(v.id)) });
}));
const setStatus = (status, subject) => ah(async (req, res) => {
  const v = await load(req.params.id), note = str(req.body && req.body.note, 300);
  if (status === 'rejected' && !note) fail(400, 'Please give the applicant a reason.');
  await run('UPDATE vendors SET status=?, status_note=? WHERE id=?', status, note, v.id);
  if (v.partner_id && status !== 'approved') await run('UPDATE partners SET active=0 WHERE id=?', v.partner_id); // no new pickups from a store that is switched off
  cache.clear();
  if (subject) await mail(v, subject, `<p>Hi ${S.esc(v.contact_name)}, ${S.esc(note || 'please contact us for details.')}</p>`);
  res.json({ ok: true, vendor: await row(await load(v.id)) });
});
router.post('/:id/reject', setStatus('rejected', 'About your Shop-Beta partner application'));
router.post('/:id/suspend', setStatus('suspended', 'Your Shop-Beta partner store is paused'));
router.post('/:id/reinstate', ah(async (req, res) => {
  const v = await load(req.params.id);
  if (v.status !== 'suspended') fail(400, 'Only a paused store can be reinstated.');
  await run("UPDATE vendors SET status='approved', status_note='' WHERE id=?", v.id);
  if (v.partner_id) await run('UPDATE partners SET active=1 WHERE id=?', v.partner_id);
  cache.clear();
  res.json({ ok: true, vendor: await row(await load(v.id)) });
}));

router.post('/:id/payouts', ah(async (req, res) => {
  const v = await load(req.params.id), amount = int(req.body && req.body.amount);
  if (amount < 1) fail(400, 'Enter the amount you paid.');
  // Serialise payouts per store so two admins cannot both pay out the same balance.
  await tx(async () => {
    await get('SELECT id FROM vendors WHERE id=? FOR UPDATE', v.id);
    const b = await V.balanceOf(v.id);
    if (amount > b.balance) fail(409, `That is more than the ${S.naira(Math.max(0, b.balance))} we owe this store.`);
    await run('INSERT INTO vendor_payouts (vendor_id,amount,method,reference,note,created,created_by) VALUES (?,?,?,?,?,?,?)', v.id, amount, str(req.body.method, 30) || 'transfer', str(req.body.reference, 80), str(req.body.note, 200), now(), String(req.user.name || req.user.email).slice(0, 80));
  });
  res.json({ ok: true, ...(await V.balanceOf(v.id)) });
}));

module.exports = router;
