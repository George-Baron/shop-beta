'use strict';
// Countries, shipping zones and fees by weight, tax rules, phone and postcode formats, and products that may not be sold in a country.
// Nigeria keeps its own state-by-state fees (the "zones" table); every other country uses a shipping zone with weight bands.
const { get, all } = require('./db');

const HOME = 'NG';
const normCode = (c) => String(c == null ? '' : c).trim().toUpperCase();

/* ---------- pure rules (unit-tested) ---------- */
// Delivery fee in Naira for a parcel weight: the first band that is big enough; beyond the last band, its fee plus extra_per_kg for each extra kg (rounded up).
function feeFor(bands, extraPerKg, weightKg) {
  const list = (bands || []).map((b) => ({ up: Number(b.up_to_kg), fee: Number(b.fee) })).filter((b) => b.up > 0).sort((a, b) => a.up - b.up);
  if (!list.length) return null;
  const w = Math.max(0.01, Number(weightKg) || 0);
  const hit = list.find((b) => w <= b.up + 1e-9);
  if (hit) return hit.fee;
  const last = list[list.length - 1];
  return last.fee + Math.ceil(w - last.up - 1e-9) * Math.max(0, Number(extraPerKg) || 0);
}

// Tax in Naira. 'added' goes on top of the total; 'included' is the part of the amount that is already tax (shown, not added).
function taxOn(mode, pct, amount) {
  const p = Number(pct) || 0, a = Number(amount) || 0;
  if (mode === 'added' && p > 0) return { tax: Math.round((a * p) / 100), added: true };
  if (mode === 'included' && p > 0) return { tax: Math.round(a - a / (1 + p / 100)), added: false };
  return { tax: 0, added: false };
}

// Checks a phone number against the country's format. Accepts +234 803 123 4567, 0803 123 4567, 803-123-4567. Returns "+<dial><national digits>" or null.
function normalisePhone(country, raw) {
  const dial = String(country.dial_code || '').replace(/\D/g, '');
  let d = String(raw || '').replace(/[^\d+]/g, '');
  const plus = d.startsWith('+');
  d = d.replace(/\D/g, '');
  if (d.startsWith('00') && !plus) { d = d.slice(2); if (dial && d.startsWith(dial)) d = d.slice(dial.length); else return null; }
  else if (plus || (dial && d.startsWith(dial) && d.length > Number(country.phone_max))) { if (dial && d.startsWith(dial)) d = d.slice(dial.length); else return null; }
  d = d.replace(/^0+/, '');                                    // the local "0" in front is not part of the number abroad
  if (d.length < Number(country.phone_min) || d.length > Number(country.phone_max)) return null;
  return '+' + dial + d;
}
function checkPostcode(country, raw) {
  const p = String(raw || '').trim().toUpperCase();
  if (!p) return country.postcode_required ? { ok: false, message: 'Please enter your postcode.' } : { ok: true, value: '' };
  if (p.length > 12) return { ok: false, message: 'That postcode is not valid.' };
  if (country.postcode_regex) { let re = null; try { re = new RegExp(country.postcode_regex, 'i'); } catch { /* a broken pattern must not block every order */ } if (re && !re.test(p)) return { ok: false, message: `That postcode does not look right for ${country.name}.` }; }
  return { ok: true, value: p };
}

/* ---------- data ---------- */
const parseCountry = (c) => c && ({ ...c, zone_id: c.zone_id == null ? null : Number(c.zone_id), tax_pct: Number(c.tax_pct), phone_min: Number(c.phone_min), phone_max: Number(c.phone_max) });
async function country(code) { return parseCountry(await get('SELECT * FROM countries WHERE code = ?', normCode(code))); }

// A country customers can order to now: enabled, and (apart from Nigeria) with a switched-on zone that has rates. Returns { country, zone, bands } or { error }.
async function shippable(code) {
  const c = await country(code);
  if (!c || !c.enabled) return { error: 'We do not deliver to that country yet.' };
  if (c.code === HOME) return { country: c };
  if (!c.zone_id) return { error: `We do not deliver to ${c.name} yet.` };
  const zone = await get('SELECT * FROM shipping_zones WHERE id = ?', c.zone_id);
  if (!zone || !zone.active) return { error: `We do not deliver to ${c.name} yet.` };
  const bands = await all('SELECT up_to_kg, fee FROM shipping_rates WHERE zone_id = ? ORDER BY up_to_kg', zone.id);
  if (!bands.length) return { error: `We do not deliver to ${c.name} yet.` };
  return { country: c, zone: { ...zone, id: Number(zone.id), extra_per_kg: Number(zone.extra_per_kg) }, bands };
}

// Public list for the storefront: only what a customer needs to fill in the form. No fees, no internal notes.
async function publicCountries() {
  const rows = await all(`SELECT c.* FROM countries c LEFT JOIN shipping_zones z ON z.id = c.zone_id
    WHERE c.enabled = TRUE AND (c.code = 'NG' OR (z.active = TRUE AND EXISTS (SELECT 1 FROM shipping_rates r WHERE r.zone_id = z.id))) ORDER BY (c.code = 'NG') DESC, c.name`);
  return rows.map((c) => ({ code: c.code, name: c.name, currency: c.currency, dial_code: c.dial_code, phone_min: Number(c.phone_min), phone_max: Number(c.phone_max), postcode_required: !!c.postcode_required, region_label: c.region_label, tax_mode: c.tax_mode, tax_pct: Number(c.tax_pct), tax_label: c.tax_label, paystack_ok: !!c.paystack_ok }));
}

// Parcel weight of a cart: the product's own weight (dropship items) or the shop's default weight for items without one.
async function cartWeight(lines) {
  const row = await get("SELECT value FROM dropship_settings WHERE key = 'default_item_kg'");
  const dflt = Number(row && row.value) > 0 ? Number(row.value) : 0.5;
  let total = 0;
  for (const l of lines) {
    const d = await get('SELECT weight_kg FROM dropship_products WHERE product_id = ?', l.productId);
    total += (d && Number(d.weight_kg) > 0 ? Number(d.weight_kg) : dflt) * l.qty;
  }
  return Math.round(total * 1000) / 1000;
}

// Products that cannot be sold in this country (by product, category or whole department). Returns messages that stop the checkout.
async function restrictions(code, lines) {
  const rules = await all('SELECT * FROM restricted_products WHERE country = ?', normCode(code));
  if (!rules.length) return [];
  const out = [];
  for (const l of lines) {
    const p = await get('SELECT category_id, store FROM products WHERE id = ?', l.productId);
    if (!p) continue;
    const hit = rules.filter((r) => (r.product_id != null && Number(r.product_id) === l.productId) || (r.category_id != null && p.category_id != null && Number(r.category_id) === Number(p.category_id)) || (r.store && r.store === p.store));
    if (!hit.length) continue;
    const banned = hit.some((r) => r.kind === 'banned');
    out.push({ productId: l.productId, kind: banned ? 'banned' : 'restricted', message: banned ? `${l.name} cannot be delivered to this country.` : `${l.name} needs special approval for this country and cannot be ordered online. Please contact us.` });
  }
  return out;
}

module.exports = { HOME, normCode, feeFor, taxOn, normalisePhone, checkPostcode, country, shippable, publicCountries, cartWeight, restrictions };
