'use strict';
// International settings for each product: export / import switches, customs data, size and weight, and per-country bans.
// A product is offered abroad only when it is switched on, signed off, has complete customs data, and the destination is not on its ban list.
const { get, all, run, tx, now } = require('../db');
const S = require('../shop');
const PC = require('../pharmacy-core');
const X = require('../xlsx');
const T = require('./core');
const FX = require('./fx');
const { fail, str } = S;

const SHIPPING_CATEGORIES = ['general', 'clothing', 'footwear', 'electronics', 'cosmetics', 'food', 'household', 'books', 'accessories', 'bulky', 'other'];

/* ---------- reading ---------- */
const shape = (r) => r && ({
  product_id: Number(r.product_id), export_enabled: !!Number(r.export_enabled), import_enabled: !!Number(r.import_enabled), intl_eligible: !!Number(r.intl_eligible),
  origin_country: r.origin_country || '', hs_code: r.hs_code || '', customs_description: r.customs_description || '', export_declared_value: r.export_declared_value == null ? null : Number(r.export_declared_value),
  declared_currency: r.declared_currency || 'NGN', weight_kg: r.weight_kg == null ? null : Number(r.weight_kg), length_cm: r.length_cm == null ? null : Number(r.length_cm),
  width_cm: r.width_cm == null ? null : Number(r.width_cm), height_cm: r.height_cm == null ? null : Number(r.height_cm), shipping_category: r.shipping_category || 'general',
  fragile: !!Number(r.fragile), dangerous_goods: !!Number(r.dangerous_goods), dangerous_class: r.dangerous_class || '', temperature_controlled: !!Number(r.temperature_controlled),
  export_restrictions: r.export_restrictions || '', import_restrictions: r.import_restrictions || '', updated: Number(r.updated) || 0,
});
const EMPTY = { export_enabled: false, import_enabled: false, intl_eligible: false, origin_country: '', hs_code: '', customs_description: '', export_declared_value: null, declared_currency: 'NGN', weight_kg: null, length_cm: null, width_cm: null, height_cm: null, shipping_category: 'general', fragile: false, dangerous_goods: false, dangerous_class: '', temperature_controlled: false, export_restrictions: '', import_restrictions: '' };

// What is still missing before a product may be exported. Empty list = ready.
function missingForExport(t) {
  const m = [];
  if (!t.origin_country) m.push('country of origin');
  if (!t.hs_code || t.hs_code.replace(/\D/g, '').length < 6) m.push('HS code (at least 6 digits)');
  if (!t.customs_description || t.customs_description.length < 5) m.push('customs description');
  if (!(t.weight_kg > 0)) m.push('weight');
  if (!(t.length_cm > 0 && t.width_cm > 0 && t.height_cm > 0)) m.push('length, width and height');
  if (t.dangerous_goods && !t.dangerous_class) m.push('dangerous goods class');
  return m;
}

async function restrictionsOf(id) {
  return (await all('SELECT country_code, direction, reason FROM product_trade_restrictions WHERE product_id=? ORDER BY direction, country_code', id)).map((r) => ({ country: r.country_code, direction: r.direction, reason: r.reason }));
}
async function getOne(id) {
  const p = await get('SELECT id, name, slug, sku, brand, price, store, active, is_pharmacy FROM products WHERE id=?', id); if (!p) fail(404, 'Product not found.');
  const t = shape(await get('SELECT * FROM product_trade_settings WHERE product_id=?', id)) || { ...EMPTY, product_id: id };
  return { product: { id: Number(p.id), name: p.name, slug: p.slug, sku: p.sku, brand: p.brand, price: Number(p.price), store: p.store, active: !!Number(p.active), pharmacy: !!Number(p.is_pharmacy) }, trade: t, restrictions: await restrictionsOf(id), missing: missingForExport(t) };
}

async function list(q) {
  const { per, offset, page } = T.page(q, 25), where = ['1=1'], args = [];
  if (q.q) { where.push("(p.name ILIKE ? OR p.sku ILIKE ? OR p.brand ILIKE ?)"); const s = '%' + String(q.q).slice(0, 60).replace(/[%_]/g, '') + '%'; args.push(s, s, s); }
  if (q.filter === 'export') where.push('t.export_enabled=1');
  else if (q.filter === 'import') where.push('t.import_enabled=1');
  else if (q.filter === 'incomplete') where.push('(t.product_id IS NOT NULL AND t.export_enabled=1 AND (t.hs_code=\'\' OR t.weight_kg IS NULL OR t.origin_country IS NULL))');
  else if (q.filter === 'unset') where.push('t.product_id IS NULL');
  const base = `FROM products p LEFT JOIN product_trade_settings t ON t.product_id=p.id WHERE ${where.join(' AND ')}`;
  const total = (await get(`SELECT COUNT(*) n ${base}`, ...args)).n;
  const rows = await all(`SELECT p.id, p.name, p.sku, p.brand, p.price, p.is_pharmacy, t.export_enabled, t.import_enabled, t.intl_eligible, t.origin_country, t.hs_code, t.weight_kg, t.length_cm, t.width_cm, t.height_cm, t.customs_description, t.dangerous_goods, t.dangerous_class
    ${base} ORDER BY p.id DESC LIMIT ? OFFSET ?`, ...args, per, offset);
  return { total, page, per, products: rows.map((r) => {
    const t = { ...EMPTY, origin_country: r.origin_country || '', hs_code: r.hs_code || '', customs_description: r.customs_description || '', weight_kg: r.weight_kg == null ? null : Number(r.weight_kg), length_cm: r.length_cm == null ? null : Number(r.length_cm), width_cm: r.width_cm == null ? null : Number(r.width_cm), height_cm: r.height_cm == null ? null : Number(r.height_cm), dangerous_goods: !!Number(r.dangerous_goods), dangerous_class: r.dangerous_class || '' };
    return { id: Number(r.id), name: r.name, sku: r.sku, brand: r.brand, price: Number(r.price), pharmacy: !!Number(r.is_pharmacy), configured: r.export_enabled != null, export_enabled: !!Number(r.export_enabled), import_enabled: !!Number(r.import_enabled), intl_eligible: !!Number(r.intl_eligible), origin_country: t.origin_country, hs_code: t.hs_code, missing: missingForExport(t) };
  }) };
}

/* ---------- writing ---------- */
async function cleanCountry(code, label) {
  const c = String(code || '').trim().toUpperCase(); if (!c) return null;
  if (!(await get('SELECT 1 x FROM trade_countries WHERE code=?', c))) fail(400, `${label}: "${String(code).slice(0, 10)}" is not a known country code.`);
  return c;
}
// Merge `b` (what the user sent) over `cur` (what is stored), validate, and return the clean record. Fields not sent keep their stored value.
async function clean(b, cur, { pharmacy } = {}) {
  const n = { ...cur }, has = (k) => b[k] !== undefined;
  for (const k of ['export_enabled', 'import_enabled', 'intl_eligible', 'fragile', 'dangerous_goods', 'temperature_controlled']) if (has(k)) { const v = T.yesNo(b[k] === true ? 'yes' : b[k] === false ? 'no' : b[k], undefined); if (v !== 0 && v !== 1) fail(400, `${k.replace(/_/g, ' ')}: use Yes or No.`); n[k] = !!v; }
  if (has('origin_country')) n.origin_country = (await cleanCountry(b.origin_country, 'Country of origin')) || '';
  if (has('hs_code')) { const h = T.hsClean(b.hs_code); if (h && !T.HS_OK.test(h)) fail(400, 'HS code: use digits only, for example 6109.10 or 610910 (4 to 10 digits).'); n.hs_code = h; }
  if (has('customs_description')) n.customs_description = str(b.customs_description, 300);
  if (has('export_declared_value')) n.export_declared_value = T.dec(b.export_declared_value, 'Export declared value', { min: 0, max: 1e9, blank: null });
  if (has('declared_currency')) { const c = String(b.declared_currency || 'NGN').toUpperCase(); if (!(await get('SELECT 1 x FROM trade_currencies WHERE code=?', c))) fail(400, 'Declared currency: unknown currency code.'); n.declared_currency = c; }
  for (const [k, l, max] of [['weight_kg', 'Weight (kg)', 5000], ['length_cm', 'Length (cm)', 1000], ['width_cm', 'Width (cm)', 1000], ['height_cm', 'Height (cm)', 1000]]) if (has(k)) n[k] = T.dec(b[k], l, { min: 0, max, places: 3, blank: null });
  if (has('shipping_category')) { const c = String(b.shipping_category || 'general').toLowerCase(); if (!SHIPPING_CATEGORIES.includes(c)) fail(400, 'Shipping category: choose one of ' + SHIPPING_CATEGORIES.join(', ') + '.'); n.shipping_category = c; }
  if (has('dangerous_class')) n.dangerous_class = str(b.dangerous_class, 40);
  if (has('export_restrictions')) n.export_restrictions = str(b.export_restrictions, 500);
  if (has('import_restrictions')) n.import_restrictions = str(b.import_restrictions, 500);
  if (n.export_enabled || n.intl_eligible) {
    if (pharmacy) fail(400, 'Medicines and pharmacy products cannot be switched on for export. They need separate regulatory approval.');
    const m = missingForExport(n);
    if (m.length) fail(400, 'Before this product can be exported, please add: ' + m.join(', ') + '.');
  }
  return n;
}
const COLS = ['export_enabled', 'import_enabled', 'intl_eligible', 'origin_country', 'hs_code', 'customs_description', 'export_declared_value', 'declared_currency', 'weight_kg', 'length_cm', 'width_cm', 'height_cm', 'shipping_category', 'fragile', 'dangerous_goods', 'dangerous_class', 'temperature_controlled', 'export_restrictions', 'import_restrictions'];
const BOOLS = new Set(['export_enabled', 'import_enabled', 'intl_eligible', 'fragile', 'dangerous_goods', 'temperature_controlled']);

async function writeRecord(id, n) {
  const vals = COLS.map((k) => (BOOLS.has(k) ? (n[k] ? 1 : 0) : (k === 'origin_country' ? (n[k] || null) : n[k])));
  await run(`INSERT INTO product_trade_settings (product_id,${COLS.join(',')},updated) VALUES (?,${COLS.map(() => '?').join(',')},?)
    ON CONFLICT (product_id) DO UPDATE SET ${COLS.map((k) => `${k}=EXCLUDED.${k}`).join(',')}, updated=EXCLUDED.updated`, id, ...vals, now());
}
async function writeRestrictions(id, list) {
  await run('DELETE FROM product_trade_restrictions WHERE product_id=?', id);
  const seen = new Set();
  for (const r of list) {
    const c = await cleanCountry(r.country, 'Restricted country'), d = r.direction === 'import' ? 'import' : r.direction === 'export' ? 'export' : '';
    if (!c || !d) fail(400, 'Each restriction needs a country and a direction (export or import).');
    if (seen.has(c + d)) continue; seen.add(c + d);
    await run('INSERT INTO product_trade_restrictions (product_id,country_code,direction,reason) VALUES (?,?,?,?)', id, c, d, str(r.reason, 200));
  }
}
async function save(id, b, user, ip) {
  id = Number(id); const p = await get('SELECT id, is_pharmacy FROM products WHERE id=?', id); if (!p) fail(404, 'Product not found.');
  b = b || {};
  const result = await tx(async () => {
    const before = shape(await get('SELECT * FROM product_trade_settings WHERE product_id=? FOR UPDATE', id)) || { ...EMPTY, product_id: id };
    const next = await clean(b, before, { pharmacy: Number(p.is_pharmacy) === 1 });
    await writeRecord(id, next);
    if (Array.isArray(b.restrictions)) await writeRestrictions(id, b.restrictions);
    return { before, next };
  });
  await T.audit(user, 'product.update', 'product_trade_settings', id, { export_enabled: result.next.export_enabled, intl_eligible: result.next.intl_eligible, hs_code: result.next.hs_code, origin: result.next.origin_country }, ip);
  return getOne(id);
}

/* ---------- what customers may see ---------- */
// Is this product allowed to go to this country? Returns { ok, reason }.
async function offerable(productId, country) {
  country = String(country || '').toUpperCase();
  const c = await get('SELECT export_to, active FROM trade_countries WHERE code=?', country);
  if (!c || !Number(c.export_to) || !Number(c.active)) return { ok: false, reason: 'We do not ship to that country yet.' };
  const r = await get(`SELECT 1 x FROM products p JOIN product_trade_settings t ON t.product_id=p.id JOIN stores s ON s.slug=p.store
    WHERE p.id=? AND p.active=1 AND s.active=1 AND p.is_pharmacy=0 AND t.export_enabled=1 AND t.intl_eligible=1 AND t.hs_code<>'' AND t.weight_kg > 0`, productId);
  if (!r) return { ok: false, reason: 'This product is not available for international shipping.' };
  if (await get("SELECT 1 x FROM product_trade_restrictions WHERE product_id=? AND country_code=? AND direction='export'", productId, country)) return { ok: false, reason: 'This product cannot be shipped to that country.' };
  return { ok: true, reason: '' };
}

async function publicList(q) {
  const country = String(q.country || '').toUpperCase(), currency = String(q.currency || 'NGN').toUpperCase();
  const c = await get('SELECT code, name FROM trade_countries WHERE code=? AND export_to=1 AND active=1', country);
  if (!c) fail(404, 'We do not ship to that country yet.');
  const cur = await get('SELECT code, symbol, decimals FROM trade_currencies WHERE code=? AND active=1', currency); if (!cur) fail(400, 'That currency is not available.');
  const { per, offset, page } = T.page(q, 24), args = [country], where = [];
  if (q.q) { where.push('(p.name ILIKE ? OR p.brand ILIKE ?)'); const s = '%' + String(q.q).slice(0, 60).replace(/[%_]/g, '') + '%'; args.push(s, s); }
  const base = `FROM products p JOIN product_trade_settings t ON t.product_id=p.id JOIN stores s ON s.slug=p.store
    WHERE p.active=1 AND s.active=1 AND p.is_pharmacy=0 AND ${PC.visibleSql('p')} AND ${PC.storeVisibleSql('s')} AND t.export_enabled=1 AND t.intl_eligible=1 AND t.hs_code<>'' AND t.weight_kg > 0
      AND NOT EXISTS (SELECT 1 FROM product_trade_restrictions r WHERE r.product_id=p.id AND r.country_code=? AND r.direction='export') ${where.length ? 'AND ' + where.join(' AND ') : ''}`;
  const total = (await get(`SELECT COUNT(*) n ${base}`, ...args)).n;
  const rows = await all(`SELECT p.id, p.slug, p.name, p.brand, p.price, p.images, p.emoji, p.stock, t.weight_kg, t.shipping_category, t.fragile ${base} ORDER BY p.featured DESC, p.id DESC LIMIT ? OFFSET ?`, ...args, per, offset);
  let rate = null; if (currency !== 'NGN') rate = await FX.rate('NGN', currency);   // 503 if no usable rate: prices are never guessed
  const st = await T.settings(), m = currency === 'NGN' ? 1 : 1 + Number(st.fx_markup_pct) / 100;
  return { country: c, currency: { code: cur.code, symbol: cur.symbol, decimals: Number(cur.decimals) }, rate_source: rate ? rate.source : 'base', rate_stale: rate ? rate.stale : false, total, page, per,
    products: rows.map((r) => ({ id: Number(r.id), slug: r.slug, name: r.name, brand: r.brand, emoji: r.emoji, images: S.parseImages(r.images), in_stock: Number(r.stock) > 0, price_ngn: Number(r.price), price: T.roundTo(Number(r.price) * (rate ? rate.rate : 1) * m, Number(cur.decimals)), weight_kg: Number(r.weight_kg), shipping_category: r.shipping_category, fragile: !!Number(r.fragile) })) };
}

/* ---------- bulk import / export (Excel and CSV) ---------- */
const HEADERS = [
  ['sku', 'SKU'], ['slug', 'Product slug'], ['export_enabled', 'Available for export (Yes/No)'], ['import_enabled', 'Available for import procurement (Yes/No)'], ['intl_eligible', 'International shipping approved (Yes/No)'],
  ['origin_country', 'Country of origin (2-letter code)'], ['hs_code', 'HS code'], ['customs_description', 'Customs description'], ['export_declared_value', 'Export declared value'], ['declared_currency', 'Declared currency'],
  ['weight_kg', 'Weight (kg)'], ['length_cm', 'Length (cm)'], ['width_cm', 'Width (cm)'], ['height_cm', 'Height (cm)'], ['shipping_category', 'Shipping category'], ['fragile', 'Fragile (Yes/No)'],
  ['dangerous_goods', 'Dangerous goods (Yes/No)'], ['dangerous_class', 'Dangerous goods class'], ['temperature_controlled', 'Temperature controlled (Yes/No)'], ['export_restrictions', 'Export restriction notes'],
  ['import_restrictions', 'Import restriction notes'], ['banned_export', 'Never export to (country codes, separated by ;)'], ['banned_import', 'Never import from (country codes, separated by ;)'],
];
const MAX_ROWS = 5000;

function template() {
  const example = ['TSHIRT-001', '', 'Yes', 'No', 'Yes', 'NG', '6109.10', 'Cotton T-shirt, knitted', '4500', 'NGN', '0.25', '30', '25', '3', 'clothing', 'No', 'No', '', 'No', '', '', '', ''];
  return X.writeXlsx([
    { name: 'Products', rows: [HEADERS.map((h) => h[1]), example], widths: HEADERS.map((h) => Math.max(14, h[1].length)) },
    { name: 'Instructions', header: false, widths: [110], rows: [['VELTO-MART Global Trade: product import template'], ['Identify each product by SKU or Product slug (one of them is enough). The SKU must be unique among your products.'], ['Leave a cell empty to keep the value already saved. Yes/No columns accept Yes, No, Y, N, 1, 0.'],
      ['A product can only be set to "Available for export" when country of origin, HS code (6+ digits), customs description, weight and all three dimensions are filled in.'], ['Pharmacy products cannot be exported. Country codes are the 2-letter ISO codes (NG, US, GB ...).'], ['The row in "Products" with TSHIRT-001 is only an example. Delete it before you upload.']] },
  ]);
}

async function exportFile(format, filter) {
  const rows = await all(`SELECT p.sku, p.slug, t.*, (SELECT string_agg(country_code, ';' ORDER BY country_code) FROM product_trade_restrictions r WHERE r.product_id=p.id AND r.direction='export') be,
      (SELECT string_agg(country_code, ';' ORDER BY country_code) FROM product_trade_restrictions r WHERE r.product_id=p.id AND r.direction='import') bi
    FROM products p JOIN product_trade_settings t ON t.product_id=p.id ${filter === 'export' ? 'WHERE t.export_enabled=1' : filter === 'import' ? 'WHERE t.import_enabled=1' : ''} ORDER BY p.id LIMIT 20000`);
  const yn = (v) => (Number(v) ? 'Yes' : 'No');
  const out = rows.map((r) => HEADERS.map(([k]) => (['export_enabled', 'import_enabled', 'intl_eligible', 'fragile', 'dangerous_goods', 'temperature_controlled'].includes(k) ? yn(r[k]) : k === 'banned_export' ? r.be || '' : k === 'banned_import' ? r.bi || '' : r[k] == null ? '' : r[k])));
  const all2 = [HEADERS.map((h) => h[1]), ...out];
  return format === 'csv' ? { buffer: X.writeCsv(all2), type: 'text/csv; charset=utf-8', ext: 'csv', count: out.length } : { buffer: X.writeXlsx([{ name: 'Products', rows: all2, widths: HEADERS.map((h) => Math.max(14, h[1].length)) }]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', count: out.length };
}

// Read the file and check every row. Nothing is saved. Returns the rows that would be applied and every problem found, row by row.
async function preview(buf, filename) {
  let sheet; try { sheet = X.readSheet(buf, filename); } catch (e) { if (e instanceof X.SheetError) fail(400, e.message); throw e; }
  if (sheet.length < 2) fail(400, 'The file has no product rows.');
  if (sheet.length - 1 > MAX_ROWS) fail(400, `Please upload at most ${MAX_ROWS} products at a time.`);
  const idx = {}; sheet[0].forEach((h, i) => { const k = HEADERS.find(([, label]) => label.toLowerCase() === String(h).trim().toLowerCase()) || HEADERS.find(([key]) => key === String(h).trim().toLowerCase()); if (k && !(k[0] in idx)) idx[k[0]] = i; });
  if (!('sku' in idx) && !('slug' in idx)) fail(400, 'The first row must contain the column titles from the template (at least "SKU" or "Product slug").');
  const out = [], errors = [], seenProduct = new Set();
  for (let r = 1; r < sheet.length; r++) {
    const row = sheet[r], cell = (k) => (k in idx ? String(row[idx[k]] == null ? '' : row[idx[k]]).trim() : undefined), n = r + 1;
    try {
      const sku = cell('sku') || '', slug = cell('slug') || '';
      if (!sku && !slug) fail(400, 'SKU or product slug is required.');
      let prods = slug ? await all('SELECT id, is_pharmacy FROM products WHERE slug=?', slug) : await all('SELECT id, is_pharmacy FROM products WHERE sku=?', sku);
      if (!prods.length) fail(404, `No product found with ${slug ? 'slug' : 'SKU'} "${(slug || sku).slice(0, 40)}".`);
      if (prods.length > 1) fail(409, `More than one product has SKU "${sku.slice(0, 40)}". Use the product slug instead.`);
      const id = Number(prods[0].id); if (seenProduct.has(id)) fail(409, 'This product appears twice in the file.'); seenProduct.add(id);
      const cur = shape(await get('SELECT * FROM product_trade_settings WHERE product_id=?', id)) || { ...EMPTY, product_id: id };
      const body = {};
      for (const k of COLS) { const v = cell(k); if (v === undefined || v === '') continue; body[k] = v; }
      for (const k of BOOLS) if (k in body) { const v = T.yesNo(body[k], undefined); if (v !== 0 && v !== 1) fail(400, `${HEADERS.find((h) => h[0] === k)[1]}: use Yes or No.`); body[k] = !!v; }
      const next = await clean(body, cur, { pharmacy: Number(prods[0].is_pharmacy) === 1 });
      const bans = [];
      for (const [k, dir] of [['banned_export', 'export'], ['banned_import', 'import']]) { const v = cell(k); if (v) for (const c of v.split(/[;,\s]+/).filter(Boolean)) bans.push({ country: await cleanCountry(c, 'Country list'), direction: dir, reason: 'From bulk file' }); }
      out.push({ row: n, id, next, bans: ('banned_export' in idx || 'banned_import' in idx) ? bans : null, label: sku || slug });
    } catch (e) { if (e instanceof S.HttpError) errors.push({ row: n, message: e.message }); else throw e; }
  }
  return { rows: out, errors, total: sheet.length - 1 };
}
// Apply the valid rows. Each row is its own transaction, so one bad row never blocks the others.
async function commit(buf, filename, user, ip) {
  const p = await preview(buf, filename); let saved = 0;
  for (const r of p.rows) {
    try {
      await tx(async () => { await writeRecord(r.id, r.next); if (r.bans) await writeRestrictions(r.id, r.bans); });
      saved++;
    } catch (e) { p.errors.push({ row: r.row, message: e instanceof S.HttpError ? e.message : 'Could not save this row.' }); }
  }
  await T.audit(user, 'product.bulk_import', 'product_trade_settings', '', { file: String(filename || '').slice(0, 80), rows: p.total, saved, errors: p.errors.length }, ip);
  return { total: p.total, saved, errors: p.errors.sort((a, b) => a.row - b.row) };
}

module.exports = { SHIPPING_CATEGORIES, missingForExport, getOne, list, save, offerable, publicList, template, exportFile, preview, commit };
