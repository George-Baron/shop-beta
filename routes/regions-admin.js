'use strict';
// Admin: countries, shipping zones and fees, currencies and rates, tax rules, restricted products. Mounted inside the dropshipping admin router,
// so the admin sign-in check, the activity log and the cache clearing already apply. Nothing here is shown to customers except through the public config.
const express = require('express');
const { get, all, run, tx, now } = require('../lib/db');
const S = require('../lib/shop');
const C = require('../lib/countries');
const CUR = require('../lib/currency');
const R = require('../lib/regions');
const FEED = require('../lib/fx-feed');
const STRIPE = require('../lib/stripe');
const { fail, str, int } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';

async function overview() {
  const zones = await all('SELECT * FROM shipping_zones ORDER BY name');
  for (const z of zones) { z.id = Number(z.id); z.rates = (await all('SELECT up_to_kg, fee FROM shipping_rates WHERE zone_id = ? ORDER BY up_to_kg', z.id)).map((r) => ({ up_to_kg: Number(r.up_to_kg), fee: Number(r.fee) })); }
  const countries = (await all('SELECT * FROM countries ORDER BY (code = \'NG\') DESC, name')).map((c) => ({ ...c, zone_id: c.zone_id == null ? null : Number(c.zone_id), tax_pct: Number(c.tax_pct) }));
  const avail = await CUR.available();
  const currencies = (await all('SELECT c.code, c.enabled, c.markup_pct, f.ngn_per_unit, f.source, f.locked, f.updated, f.checked_at FROM currencies c LEFT JOIN fx_rates f ON f.currency = c.code ORDER BY (c.code = \'NGN\') DESC, c.code'))
    .map((c) => ({ code: c.code, enabled: !!c.enabled, markup_pct: Number(c.markup_pct), ngn_per_unit: c.ngn_per_unit == null ? null : Number(c.ngn_per_unit), source: c.source, locked: c.locked == null ? null : !!c.locked, updated: c.updated == null ? null : Number(c.updated), checked_at: c.checked_at == null ? null : Number(c.checked_at), usable: !!avail[c.code], charge_rate: avail[c.code] ? avail[c.code].rate : null, decimals: CUR.decimals(c.code) }));
  const restrictions = await all(`SELECT r.*, p.name AS product_name, c.name AS category_name, s.name AS store_name FROM restricted_products r
    LEFT JOIN products p ON p.id = r.product_id LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN stores s ON s.slug = r.store ORDER BY r.country, r.id`);
  const dflt = await get("SELECT value FROM dropship_settings WHERE key = 'default_item_kg'");
  return {
    countries, zones, currencies, restrictions: restrictions.map((r) => ({ ...r, id: Number(r.id), product_id: r.product_id == null ? null : Number(r.product_id), category_id: r.category_id == null ? null : Number(r.category_id) })),
    default_item_kg: Number(dflt && dflt.value) > 0 ? Number(dflt.value) : 0.5,
    feed: { enabled: FEED.enabled(), max_age_hours: CUR.maxAgeSeconds() / 3600 },
    gateways: { paystack_currencies: S.paystackCurrencies(), stripe_enabled: STRIPE.enabled(), stripe_currencies: STRIPE.currencies(), stripe_flag_on: process.env.STRIPE_ENABLED === '1', stripe_key_set: !!process.env.STRIPE_SECRET_KEY, stripe_webhook_set: !!process.env.STRIPE_WEBHOOK_SECRET },
    stores: await all('SELECT slug, name FROM stores ORDER BY sort, slug'), categories: await all('SELECT id, store, name FROM categories ORDER BY store, name'),
  };
}
router.get('/', ah(async (req, res) => res.json(await overview())));

router.put('/settings', ah(async (req, res) => {
  const kg = num(req.body && req.body.default_item_kg);
  if (kg == null || kg <= 0 || kg > 100) fail(400, 'Enter the usual weight of one item in kg, for example 0.5.');
  await run("INSERT INTO dropship_settings (key,value) VALUES ('default_item_kg',?) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", String(kg));
  res.json({ ok: true });
}));

/* ---------- countries ---------- */
router.post('/countries', ah(async (req, res) => {
  const code = R.normCode(req.body && req.body.code);
  if (!C.isCountry(code)) fail(400, 'Choose a country from the list.');
  if (await get('SELECT 1 x FROM countries WHERE code = ?', code)) fail(409, 'That country is already in the list.');
  await run("INSERT INTO countries (code, name, enabled) VALUES (?,?,FALSE)", code, C.countryName(code));
  res.json({ ok: true });
}));
router.put('/countries/:code', ah(async (req, res) => {
  const c = await R.country(req.params.code), b = req.body || {};
  if (!c) fail(404, 'Country not found.');
  const cur = String(b.currency || c.currency).toUpperCase();
  if (!C.isCurrency(cur)) fail(400, 'Unknown currency.');
  const taxMode = ['none', 'added', 'included'].includes(b.tax_mode) ? b.tax_mode : c.tax_mode;
  const pct = b.tax_pct === undefined ? c.tax_pct : num(b.tax_pct);
  if (pct == null || pct < 0 || pct > 40) fail(400, 'The tax rate must be between 0 and 40.');
  const pmin = int(b.phone_min, c.phone_min), pmax = int(b.phone_max, c.phone_max);
  if (pmin < 4 || pmax > 15 || pmin > pmax) fail(400, 'Phone lengths must be between 4 and 15 digits, shortest first.');
  const rx = str(b.postcode_regex === undefined ? c.postcode_regex : b.postcode_regex, 120);
  if (rx) { try { new RegExp(rx); } catch { fail(400, 'The postcode pattern is not valid.'); } }
  const zone = b.zone_id === undefined ? c.zone_id : (b.zone_id ? int(b.zone_id) : null);
  if (zone && !(await get('SELECT 1 x FROM shipping_zones WHERE id = ?', zone))) fail(400, 'Choose a shipping zone from the list.');
  const enabled = b.enabled === undefined ? c.enabled : bool(b.enabled);
  if (c.code === R.HOME && !enabled) fail(400, 'Nigeria cannot be switched off: it is where the shop is.');
  if (enabled && c.code !== R.HOME) {
    const z = zone && await get('SELECT active, (SELECT COUNT(*) FROM shipping_rates r WHERE r.zone_id = z.id) AS n FROM shipping_zones z WHERE id = ?', zone);
    if (!z || !z.active || !Number(z.n)) fail(400, 'Choose a shipping zone that is switched on and has delivery fees before enabling this country.');
  }
  await run(`UPDATE countries SET enabled=?, zone_id=?, currency=?, dial_code=?, phone_min=?, phone_max=?, postcode_required=?, postcode_regex=?, region_label=?, tax_mode=?, tax_pct=?, tax_label=?, paystack_ok=?, notes=? WHERE code=?`,
    enabled, zone, cur, str(b.dial_code === undefined ? c.dial_code : b.dial_code, 5).replace(/\D/g, ''), pmin, pmax, b.postcode_required === undefined ? c.postcode_required : bool(b.postcode_required), rx,
    str(b.region_label === undefined ? c.region_label : b.region_label, 30) || 'State / region', taxMode, pct, str(b.tax_label === undefined ? c.tax_label : b.tax_label, 20) || 'VAT', b.paystack_ok === undefined ? c.paystack_ok : bool(b.paystack_ok), str(b.notes === undefined ? c.notes : b.notes, 300), c.code);
  res.json({ ok: true });
}));

/* ---------- zones and weight bands ---------- */
const readZone = (b) => {
  const name = str(b.name, 60);
  if (!name) fail(400, 'Please name the zone.');
  const lo = int(b.eta_min, 5), hi = int(b.eta_max, 14);
  if (lo < 0 || hi < lo || hi > 120) fail(400, 'Delivery days must run from the shortest to the longest, for example 7 to 14.');
  const extra = int(b.extra_per_kg, 0);
  if (extra < 0 || extra > 1e7) fail(400, 'The fee per extra kg is not valid.');
  return { name, lo, hi, extra, active: bool(b.active) };
};
const readBands = (list) => {
  const bands = (Array.isArray(list) ? list : []).slice(0, 20).map((r) => ({ up_to_kg: num(r && r.up_to_kg), fee: num(r && r.fee) }));
  if (bands.some((r) => r.up_to_kg == null || r.up_to_kg <= 0 || r.up_to_kg > 1000 || r.fee == null || r.fee < 0 || r.fee > 1e8 || !Number.isInteger(r.fee))) fail(400, 'Each weight band needs a weight above 0 kg and a fee in whole Naira.');
  const seen = new Set(bands.map((r) => r.up_to_kg));
  if (seen.size !== bands.length) fail(400, 'Two weight bands have the same weight.');
  return bands.sort((a, b) => a.up_to_kg - b.up_to_kg);
};
async function saveZone(id, b) {
  const z = readZone(b), bands = b.rates === undefined ? null : readBands(b.rates);
  await tx(async () => {
    if (id) await run('UPDATE shipping_zones SET name=?, active=?, extra_per_kg=?, eta_min=?, eta_max=? WHERE id=?', z.name, z.active, z.extra, z.lo, z.hi, id);
    else id = Number((await run('INSERT INTO shipping_zones (name, active, extra_per_kg, eta_min, eta_max) VALUES (?,?,?,?,?)', z.name, z.active, z.extra, z.lo, z.hi)).lastInsertRowid);
    if (bands) { await run('DELETE FROM shipping_rates WHERE zone_id=?', id); for (const r of bands) await run('INSERT INTO shipping_rates (zone_id, up_to_kg, fee) VALUES (?,?,?)', id, r.up_to_kg, r.fee); }
    if (z.active && !(await get('SELECT 1 x FROM shipping_rates WHERE zone_id=?', id))) fail(400, 'Add at least one weight band before switching the zone on.');
  });
  return id;
}
router.post('/zones', ah(async (req, res) => {
  try { res.json({ ok: true, id: await saveZone(0, req.body || {}) }); } catch (e) { if (e && e.code === '23505') fail(409, 'A zone with that name already exists.'); throw e; }
}));
router.put('/zones/:id', ah(async (req, res) => {
  const id = int(req.params.id);
  if (!(await get('SELECT 1 x FROM shipping_zones WHERE id=?', id))) fail(404, 'Zone not found.');
  try { await saveZone(id, req.body || {}); } catch (e) { if (e && e.code === '23505') fail(409, 'A zone with that name already exists.'); throw e; }
  res.json({ ok: true });
}));

/* ---------- currencies ---------- */
router.put('/currencies/:code', ah(async (req, res) => {
  const code = String(req.params.code).toUpperCase(), b = req.body || {};
  const c = await get('SELECT * FROM currencies WHERE code = ?', code);
  if (!c) fail(404, 'Currency not found.');
  if (code === CUR.BASE) fail(400, 'Naira is the base currency and is always on.');
  const markup = b.markup_pct === undefined ? Number(c.markup_pct) : num(b.markup_pct);
  if (markup == null || markup < 0 || markup > 20) fail(400, 'The markup must be between 0% and 20%.');
  const enabled = b.enabled === undefined ? !!c.enabled : bool(b.enabled);
  const fx = await get('SELECT ngn_per_unit FROM fx_rates WHERE currency = ?', code);
  if (enabled && !(fx && Number(fx.ngn_per_unit) > 0)) fail(400, `Enter a rate for ${code} first (how many Naira one ${code} is worth), then switch it on.`);
  await run('UPDATE currencies SET enabled=?, markup_pct=? WHERE code=?', enabled, markup, code);
  if (b.locked !== undefined && fx) await run('UPDATE fx_rates SET locked=? WHERE currency=?', bool(b.locked), code);
  res.json({ ok: true });
}));
router.post('/currencies', ah(async (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase();
  if (!C.isCurrency(code)) fail(400, 'Choose a currency from the list.');
  await run('INSERT INTO currencies (code, enabled, markup_pct) VALUES (?,FALSE,2) ON CONFLICT (code) DO NOTHING', code);
  res.json({ ok: true });
}));
router.post('/fx/refresh', A_limit(), ah(async (req, res) => {
  try { res.json({ ok: true, ...(await FEED.refresh()) }); } catch (e) { fail(502, 'Could not update the rates: ' + e.message); }
}));
function A_limit() { return require('../lib/auth').limiter('fxrefresh', 20, 3600000); }

/* ---------- restricted products ---------- */
router.post('/restrictions', ah(async (req, res) => {
  const b = req.body || {}, code = R.normCode(b.country);
  if (!(await R.country(code))) fail(400, 'Choose a country from the list.');
  const kind = b.kind === 'restricted' ? 'restricted' : 'banned';
  const pid = b.product_id ? int(b.product_id) : null, cid = b.category_id ? int(b.category_id) : null, store = b.store ? str(b.store, 40) : null;
  if ([pid, cid, store].filter(Boolean).length !== 1) fail(400, 'Choose one product, one category or one department.');
  if (pid && !(await get('SELECT 1 x FROM products WHERE id=?', pid))) fail(400, 'Product not found.');
  if (cid && !(await get('SELECT 1 x FROM categories WHERE id=?', cid))) fail(400, 'Category not found.');
  if (store && !(await get('SELECT 1 x FROM stores WHERE slug=?', store))) fail(400, 'Department not found.');
  await run('INSERT INTO restricted_products (country, product_id, category_id, store, kind, note, created) VALUES (?,?,?,?,?,?,?)', code, pid, cid, store, kind, str(b.note, 200), now());
  res.json({ ok: true });
}));
router.delete('/restrictions/:id', ah(async (req, res) => { await run('DELETE FROM restricted_products WHERE id=?', int(req.params.id)); res.json({ ok: true }); }));

module.exports = router;
