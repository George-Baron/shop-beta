'use strict';
// Dropship products: what we sell but do not hold. The supplier ships it; we keep the margin.
// Everything here is admin-only except publicInfo(), which returns only what a customer may see (never supplier, SKU, cost or margin).
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const PC = require('./pharmacy-core');
const CAT = require('./catalog');
const C = require('./countries');
const P = require('./pricing');
const cache = require('./cache');
const { fail, str, int, parseImages } = S;

const UNKNOWN_STOCK = 99; // products.stock for a dropship item whose supplier stock is unknown, so the existing cart/stock code keeps working
const DS_KEYS = ['margin_type', 'margin_value', 'duty_pct', 'tax_pct', 'fee_pct', 'fee_flat', 'fee_flat_from', 'fee_cap', 'round_to', 'eta_buffer_days'];
const nn = (x) => (x === '' || x == null || !Number.isFinite(Number(x)) ? null : Number(x));
// Until step 4 (the order flow) is built, customers cannot order a dropship item: nobody would place it with the supplier.
const ordersOpen = () => process.env.DROPSHIP_ORDERS_ENABLED === '1';

/* ---------- settings, rates, margin rules ---------- */
async function settings() {
  const rows = await all('SELECT key, value FROM dropship_settings'), out = { ...P.DEFAULTS };
  for (const r of rows) if (DS_KEYS.includes(r.key)) out[r.key] = r.key === 'margin_type' ? r.value : Number(r.value);
  return out;
}
async function saveSettings(b) {
  const clean = {};
  const num = (k, lo, hi, label) => { if (b[k] === undefined) return; const v = nn(b[k]); if (v == null || v < lo || v > hi) fail(400, `${label} must be a number from ${lo} to ${hi}.`); clean[k] = String(v); };
  if (b.margin_type !== undefined) { if (!['percent', 'fixed'].includes(b.margin_type)) fail(400, 'The default margin must be a percentage or a fixed amount.'); clean.margin_type = b.margin_type; }
  num('margin_value', 0, 1000000, 'Default margin'); num('duty_pct', 0, 500, 'Default duty'); num('tax_pct', 0, 100, 'Default tax');
  num('fee_pct', 0, 20, 'Payment fee %'); num('fee_flat', 0, 10000, 'Flat payment fee'); num('fee_flat_from', 0, 1000000, 'Flat fee applies from'); num('fee_cap', 0, 1000000, 'Fee cap');
  num('round_to', 1, 10000, 'Round prices up to'); num('eta_buffer_days', 0, 60, 'Delivery safety buffer');
  for (const [k, v] of Object.entries(clean)) await run('INSERT INTO dropship_settings (key,value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', k, v);
  return settings();
}
async function rates() { return Object.fromEntries((await all('SELECT currency, ngn_per_unit FROM fx_rates')).map((r) => [r.currency, Number(r.ngn_per_unit)])); }
async function listRates() {
  const rows = await all('SELECT currency, ngn_per_unit, source, updated, updated_by FROM fx_rates ORDER BY currency');
  const have = new Set(rows.map((r) => r.currency));
  const missing = (await all("SELECT DISTINCT currency FROM suppliers WHERE currency <> 'NGN'")).map((r) => r.currency).filter((c) => !have.has(c));
  return { rates: rows.map((r) => ({ ...r, ngn_per_unit: Number(r.ngn_per_unit), updated: Number(r.updated), name: (C.currencies().find((c) => c.code === r.currency) || {}).name || r.currency })), missing };
}
async function setRate(user, currency, value) {
  currency = str(currency, 3).toUpperCase();
  if (currency === 'NGN') fail(400, 'Naira is the base currency, so it has no rate.');
  if (!C.isCurrency(currency)) fail(400, 'Unknown currency.');
  const v = nn(value);
  if (v == null || v <= 0 || v > 1e9) fail(400, 'Enter how many Naira one ' + currency + ' is worth, for example 1500.');
  await run("INSERT INTO fx_rates (currency,ngn_per_unit,source,updated,updated_by) VALUES (?,?,'manual',?,?) ON CONFLICT (currency) DO UPDATE SET ngn_per_unit=EXCLUDED.ngn_per_unit, source='manual', updated=EXCLUDED.updated, updated_by=EXCLUDED.updated_by", currency, v, now(), String(user.name || user.email).slice(0, 80));
}
async function categoryMargins() { return all('SELECT m.category_id, m.margin_type, m.margin_value, c.name, c.store FROM dropship_category_margins m JOIN categories c ON c.id=m.category_id ORDER BY c.store, c.name'); }
async function setCategoryMargin(categoryId, type, value) {
  const id = int(categoryId);
  if (!(await get('SELECT 1 x FROM categories WHERE id=?', id))) fail(404, 'Category not found.');
  if (!type) { await run('DELETE FROM dropship_category_margins WHERE category_id=?', id); return; }
  const v = nn(value);
  if (!['percent', 'fixed'].includes(type) || v == null || v < 0 || (type === 'percent' && v > 1000)) fail(400, 'That margin is not valid.');
  await run('INSERT INTO dropship_category_margins (category_id,margin_type,margin_value) VALUES (?,?,?) ON CONFLICT (category_id) DO UPDATE SET margin_type=EXCLUDED.margin_type, margin_value=EXCLUDED.margin_value', id, type, v);
}

// Settings, rates and category rules, loaded once and passed to every calculation (so a list of 300 products makes 3 queries, not 900).
async function context() {
  const [st, rs, cm] = await Promise.all([settings(), rates(), all('SELECT category_id, margin_type, margin_value FROM dropship_category_margins')]);
  return { st, rates: rs, cats: new Map(cm.map((m) => [Number(m.category_id), m])) };
}
const feesOf = (st) => ({ fee_pct: st.fee_pct, fee_flat: st.fee_flat, fee_flat_from: st.fee_flat_from, fee_cap: st.fee_cap, round_to: st.round_to });
// d = product input (cost, ship_cost, duty_pct, tax_pct, margin_type/value), sup = supplier row, price = the price charged (optional)
function calcFor(ctx, d, sup, categoryId, price) {
  const rate = sup.currency === 'NGN' ? 1 : ctx.rates[sup.currency];
  if (!rate) fail(400, `There is no exchange rate for ${sup.currency} yet. Add it in Dropshipping > Settings > Exchange rates.`);
  const margin = P.resolveMargin({ product: d, category: ctx.cats.get(Number(categoryId)), supplier: sup, shop: ctx.st });
  try {
    return { ...P.calculate({ cost: d.cost, ship_cost: d.ship_cost, rate, duty_pct: d.duty_pct == null ? ctx.st.duty_pct : d.duty_pct, tax_pct: d.tax_pct == null ? ctx.st.tax_pct : d.tax_pct, margin: { type: margin.type, value: margin.value }, fees: feesOf(ctx.st), price }), margin_source: margin.source, currency: sup.currency };
  } catch (e) { fail(400, e.message); }
}

/* ---------- reading and checking input ---------- */
const HS = /^\d{4}([. ]?\d{2}){0,3}$/;
function readTimes(t) {
  if (t == null || t === '') return {};
  if (typeof t !== 'object' || Array.isArray(t)) fail(400, 'Shipping times are not in the right format.');
  const out = {};
  for (const [k, v] of Object.entries(t).slice(0, 40)) {
    const key = String(k).toUpperCase();
    if (!/^([A-Z]{2}|ALL)$/.test(key) || (key !== 'ALL' && !C.isCountry(key))) fail(400, `"${k}" is not a country code. Use codes like NG, GH, US, or ALL.`);
    const min = int(v && v.min, -1), max = int(v && v.max, -1);
    if (min < 0 || max < min || max > 365) fail(400, `Shipping days for ${key}: enter a minimum and a maximum (the maximum cannot be smaller).`);
    out[key] = { min, max };
  }
  return out;
}
// Merges what the admin sent over the current values and checks the result as a whole.
async function parse(b, cur = {}) {
  const has = (k) => b[k] !== undefined, v = (k) => (has(k) ? b[k] : cur[k]);
  const d = {};
  d.supplier_id = int(v('supplier_id'));
  const sup = await get('SELECT * FROM suppliers WHERE id=?', d.supplier_id);
  if (!sup) fail(400, 'Please choose a supplier.');
  d.supplier_sku = str(v('supplier_sku'), 60); if (!d.supplier_sku) fail(400, 'Please enter the supplier\'s SKU or product code.');
  d.supplier_url = str(v('supplier_url'), 500); if (d.supplier_url && !/^https?:\/\/[^\s"'<>]+$/.test(d.supplier_url)) fail(400, 'The supplier link must start with http:// or https://.');
  d.name = str(v('name'), 140); if (!d.name) fail(400, 'Please enter a product name.');
  d.store = str(v('store'), 40);
  if (!(await get('SELECT 1 x FROM stores WHERE slug=?', d.store))) fail(400, 'Please choose a department.');
  if (d.store === PC.PHARMACY_STORE) fail(400, 'Medicines cannot be dropshipped.');
  d.category_id = nn(v('category_id')) ? int(v('category_id')) : null;
  if (d.category_id && !(await get('SELECT 1 x FROM categories WHERE id=? AND store=?', d.category_id, d.store))) d.category_id = null;
  d.brand = str(v('brand'), 60); d.description = str(v('description'), 4000);
  d.images = (Array.isArray(v('images')) ? v('images') : []).slice(0, 8);
  if (d.images.some((u) => !CAT.okImage(u))) fail(400, 'One of the photo links is not allowed. Use an upload or an https link.');
  d.cost = nn(v('cost')); if (d.cost == null || d.cost <= 0 || d.cost > 1e9) fail(400, `Enter the supplier's price per unit in ${sup.currency}.`);
  d.ship_cost = nn(v('ship_cost')) ?? 0; if (d.ship_cost < 0 || d.ship_cost > 1e9) fail(400, 'Shipping cost must be zero or more.');
  d.supplier_stock = nn(v('supplier_stock')) == null ? null : Math.max(0, int(v('supplier_stock')));
  d.processing_days = nn(v('processing_days')) == null ? null : int(v('processing_days')); if (d.processing_days != null && (d.processing_days < 0 || d.processing_days > 120)) fail(400, 'Processing days must be between 0 and 120.');
  d.ship_times = readTimes(v('ship_times'));
  for (const k of ['weight_kg', 'length_cm', 'width_cm', 'height_cm']) { d[k] = nn(v(k)); if (d[k] != null && (d[k] < 0 || d[k] > 100000)) fail(400, 'Weight and size must be zero or more.'); }
  d.hs_code = str(v('hs_code'), 20); if (d.hs_code && !HS.test(d.hs_code)) fail(400, 'The HS code should be 4 to 10 digits, for example 8517.62 or 85176200.');
  d.origin_country = str(v('origin_country'), 2).toUpperCase() || null; if (d.origin_country && !C.isCountry(d.origin_country)) fail(400, 'Country of origin is not a valid country code.');
  d.ships_from = str(v('ships_from'), 2).toUpperCase() || null; if (d.ships_from && !C.isCountry(d.ships_from)) fail(400, '"Ships from" is not a valid country code.');
  d.duty_pct = nn(v('duty_pct')); if (d.duty_pct != null && (d.duty_pct < 0 || d.duty_pct > 500)) fail(400, 'Duty must be between 0 and 500%.');
  d.tax_pct = nn(v('tax_pct')); if (d.tax_pct != null && (d.tax_pct < 0 || d.tax_pct > 100)) fail(400, 'Tax must be between 0 and 100%.');
  d.margin_type = str(v('margin_type'), 10) || null; d.margin_value = nn(v('margin_value'));
  if (!d.margin_type || d.margin_value == null) { d.margin_type = null; d.margin_value = null; }
  else if (!['percent', 'fixed'].includes(d.margin_type) || d.margin_value < 0 || (d.margin_type === 'percent' && d.margin_value > 1000)) fail(400, 'That margin is not valid.');
  d.price_mode = str(v('price_mode'), 10) || 'auto'; if (!['auto', 'manual'].includes(d.price_mode)) fail(400, 'Price mode must be automatic or manual.');
  d.price = nn(v('price'));
  d.active = has('active') ? (b.active ? 1 : 0) : (cur.active == null ? 1 : cur.active);
  return { d, sup };
}

/* ---------- reading products back ---------- */
const COLS = `p.id, p.slug, p.name, p.store, p.category_id, p.brand, p.description, p.price, p.stock, p.images, p.active, p.listing, p.listing_note, p.created,
  dp.supplier_id, dp.supplier_sku, dp.supplier_url, dp.cost, dp.ship_cost, dp.supplier_stock, dp.processing_days, dp.ship_times, dp.weight_kg, dp.length_cm, dp.width_cm, dp.height_cm,
  dp.hs_code, dp.origin_country, dp.ships_from, dp.duty_pct, dp.tax_pct, dp.margin_type, dp.margin_value, dp.price_mode, dp.priced_rate, dp.priced_at, dp.source_images,
  s.name AS supplier_name, s.country AS supplier_country, s.currency AS supplier_currency, s.status AS supplier_status, s.processing_days AS supplier_processing, s.margin_type AS s_margin_type, s.margin_value AS s_margin_value,
  c.name AS category`;
const FROM = 'FROM products p JOIN dropship_products dp ON dp.product_id = p.id JOIN suppliers s ON s.id = dp.supplier_id LEFT JOIN categories c ON c.id = p.category_id';
const supOf = (r) => ({ id: r.supplier_id, currency: r.supplier_currency, margin_type: r.s_margin_type, margin_value: r.s_margin_value == null ? null : Number(r.s_margin_value), processing_days: r.supplier_processing });
const rowShape = (r) => ({ ...r, id: Number(r.id), supplier_id: Number(r.supplier_id), images: parseImages(r.images), source_images: parseImages(r.source_images), created: Number(r.created), priced_at: r.priced_at == null ? null : Number(r.priced_at),
  effective_processing_days: r.processing_days != null ? r.processing_days : r.supplier_processing, ships_from_effective: r.ships_from || r.supplier_country });

async function loadRow(id) { const r = await get(`SELECT ${COLS} ${FROM} WHERE p.id=?`, int(id)); if (!r) fail(404, 'Dropship product not found.'); return rowShape(r); }

function pricingOf(ctx, r) {
  const calc = calcFor(ctx, r, supOf(r), r.category_id, r.price);
  const rate = calc.rate, drift = r.priced_rate ? Math.round(((rate - Number(r.priced_rate)) / Number(r.priced_rate)) * 1000) / 10 : null;
  return { ...calc, price_differs: r.price !== calc.calculated_price, rate_drift_pct: drift };
}
const etaTable = (r, st) => Object.fromEntries(Object.keys(r.ship_times || {}).map((k) => [k, P.deliveryEstimate({ processing_days: r.effective_processing_days, ship_times: r.ship_times, region: k, buffer: st.eta_buffer_days })]));

async function detail(id) {
  const r = await loadRow(id), ctx = await context();
  let pricing = null, pricing_error = '';
  try { pricing = pricingOf(ctx, r); } catch (e) { pricing_error = e.message; }
  const { source_images, ...p } = r;
  return { product: { ...p, photos_pending: source_images.length }, pricing, pricing_error, eta: etaTable(r, ctx.st), defaults: { duty_pct: ctx.st.duty_pct, tax_pct: ctx.st.tax_pct }, checks: reviewProblems(r, pricing) };
}

async function list({ listing, supplier_id, q } = {}) {
  const where = ["p.fulfilment = 'dropship'"], args = [];
  if (['pending', 'approved', 'rejected'].includes(listing)) { where.push('p.listing=?'); args.push(listing); }
  if (int(supplier_id)) { where.push('dp.supplier_id=?'); args.push(int(supplier_id)); }
  const text = str(q, 80).toLowerCase();
  if (text) { const l = '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; where.push("(lower(p.name) LIKE ? ESCAPE '\\' OR lower(dp.supplier_sku) LIKE ? ESCAPE '\\')"); args.push(l, l); }
  const rows = (await all(`SELECT ${COLS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 300`, ...args)).map(rowShape);
  const ctx = await context();
  return rows.map((r) => {
    let pricing = null; try { pricing = pricingOf(ctx, r); } catch { /* no rate yet: shown as "needs a rate" */ }
    const { description, source_images, ship_times, ...slim } = r;
    return { ...slim, photos_pending: source_images.length, has_ship_times: Object.keys(ship_times || {}).length > 0, break_even: pricing && pricing.break_even, profit: pricing && pricing.profit, margin_pct: pricing && pricing.margin_pct, landed: pricing && pricing.landed, below_break_even: pricing ? pricing.below_break_even : null, calculated_price: pricing && pricing.calculated_price };
  });
}

/* ---------- create, update ---------- */
async function create(user, b) {
  const { d, sup } = await parse(b);
  return createChecked(d, sup, await context());
}
// d and sup already checked. Runs inside the caller's transaction when there is one (the importer uses that).
async function createChecked(d, sup, ctx) {
  const manual = d.price_mode === 'manual';
  if (manual && !(d.price > 0)) fail(400, 'Enter the selling price, or switch the price to automatic.');
  const calc = calcFor(ctx, d, sup, d.category_id, manual ? d.price : null);
  const price = manual ? Math.round(d.price) : calc.calculated_price, t = now();
  if (await get('SELECT 1 x FROM dropship_products WHERE supplier_id=? AND lower(btrim(supplier_sku))=lower(btrim(?))', d.supplier_id, d.supplier_sku)) fail(409, `This supplier already has a product with the code ${d.supplier_sku}.`);
  return tx(async () => {
    const pid = Number((await run("INSERT INTO products (slug,store,category_id,name,brand,description,price,compare_price,stock,sku,emoji,images,size_label,active,created,fulfilment,listing) VALUES (?,?,?,?,?,?,?,0,?,'','📦',?,'Size',?,?,'dropship','pending')",
      await CAT.uniqueSlug(d.name), d.store, d.category_id, d.name, d.brand, d.description, price, d.supplier_stock == null ? UNKNOWN_STOCK : d.supplier_stock, JSON.stringify(d.images), d.active, t)).lastInsertRowid);
    await run('UPDATE products SET sku=? WHERE id=?', 'DS-' + pid, pid); // our own code: the supplier's code is never shown to customers
    await run(`INSERT INTO dropship_products (product_id,supplier_id,supplier_sku,supplier_url,cost,ship_cost,supplier_stock,processing_days,ship_times,weight_kg,length_cm,width_cm,height_cm,hs_code,origin_country,ships_from,duty_pct,tax_pct,margin_type,margin_value,price_mode,priced_rate,priced_at,source_images,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, pid, d.supplier_id, d.supplier_sku, d.supplier_url, d.cost, d.ship_cost, d.supplier_stock, d.processing_days, JSON.stringify(d.ship_times), d.weight_kg, d.length_cm, d.width_cm, d.height_cm,
      d.hs_code, d.origin_country, d.ships_from, d.duty_pct, d.tax_pct, d.margin_type, d.margin_value, d.price_mode, calc.rate, t, JSON.stringify(d.source_images || []), t, t);
    return pid;
  });
}

const inputOf = (r) => ({ supplier_id: r.supplier_id, supplier_sku: r.supplier_sku, supplier_url: r.supplier_url, name: r.name, store: r.store, category_id: r.category_id, brand: r.brand, description: r.description, images: r.images,
  cost: r.cost, ship_cost: r.ship_cost, supplier_stock: r.supplier_stock, processing_days: r.processing_days, ship_times: r.ship_times, weight_kg: r.weight_kg, length_cm: r.length_cm, width_cm: r.width_cm, height_cm: r.height_cm,
  hs_code: r.hs_code, origin_country: r.origin_country, ships_from: r.ships_from, duty_pct: r.duty_pct, tax_pct: r.tax_pct, margin_type: r.margin_type, margin_value: r.margin_value, price_mode: r.price_mode, price: r.price, active: r.active });

async function update(user, id, b) {
  const cur = await loadRow(id), { d, sup } = await parse(b, inputOf(cur));
  const ctx = await context(), manual = d.price_mode === 'manual';
  if (manual && !(d.price > 0)) fail(400, 'Enter the selling price, or switch the price to automatic.');
  const calc = calcFor(ctx, d, sup, d.category_id, manual ? d.price : null);
  const price = manual ? Math.round(d.price) : calc.calculated_price;
  if ((d.supplier_sku.toLowerCase() !== cur.supplier_sku.toLowerCase() || d.supplier_id !== cur.supplier_id) && await get('SELECT 1 x FROM dropship_products WHERE supplier_id=? AND lower(btrim(supplier_sku))=lower(btrim(?)) AND product_id<>?', d.supplier_id, d.supplier_sku, cur.id)) fail(409, `This supplier already has a product with the code ${d.supplier_sku}.`);
  await tx(async () => {
    await run('UPDATE products SET store=?,category_id=?,name=?,brand=?,description=?,price=?,stock=?,images=?,active=? WHERE id=?', d.store, d.category_id, d.name, d.brand, d.description, price, d.supplier_stock == null ? UNKNOWN_STOCK : d.supplier_stock, JSON.stringify(d.images), d.active, cur.id);
    await run(`UPDATE dropship_products SET supplier_id=?,supplier_sku=?,supplier_url=?,cost=?,ship_cost=?,supplier_stock=?,processing_days=?,ship_times=?::jsonb,weight_kg=?,length_cm=?,width_cm=?,height_cm=?,hs_code=?,origin_country=?,ships_from=?,duty_pct=?,tax_pct=?,margin_type=?,margin_value=?,price_mode=?,priced_rate=?,priced_at=?,updated=? WHERE product_id=?`,
      d.supplier_id, d.supplier_sku, d.supplier_url, d.cost, d.ship_cost, d.supplier_stock, d.processing_days, JSON.stringify(d.ship_times), d.weight_kg, d.length_cm, d.width_cm, d.height_cm, d.hs_code, d.origin_country, d.ships_from, d.duty_pct, d.tax_pct, d.margin_type, d.margin_value, d.price_mode, calc.rate, now(), now(), cur.id);
  });
  cache.drop('product:' + cur.slug); cache.drop('stock:' + cur.id);
}

// Price := the calculated price, using today's rates. Never done silently: the admin presses the button.
async function reprice(id) {
  const r = await loadRow(id), ctx = await context(), calc = calcFor(ctx, r, supOf(r), r.category_id, null);
  await run('UPDATE products SET price=? WHERE id=?', calc.calculated_price, r.id);
  await run('UPDATE dropship_products SET price_mode=?, priced_rate=?, priced_at=?, updated=? WHERE product_id=?', 'auto', calc.rate, now(), now(), r.id);
  cache.drop('product:' + r.slug);
}

/* ---------- review: nothing dropshipped is visible to customers until an admin approves it ---------- */
function reviewProblems(r, pricing) {
  const out = [];
  if (r.supplier_status !== 'active') out.push('The supplier is paused. Make the supplier active first.');
  if (!r.images.length) out.push(r.source_images.length ? 'The photos are still being copied. Try again in a minute.' : 'Add at least one photo.');
  if (!Object.keys(r.ship_times || {}).length) out.push('Add shipping times, so customers get an honest delivery estimate.');
  if (!pricing) out.push('There is no exchange rate for ' + r.supplier_currency + '.');
  else if (pricing.below_break_even) out.push(`The price ${S.naira(r.price)} is below break-even (${S.naira(pricing.break_even)}). Raise it, or you lose money on every sale.`);
  if (!(r.price > 0)) out.push('Set a selling price.');
  return out;
}
async function review(user, id, decision, note) {
  const r = await loadRow(id);
  if (!['approved', 'rejected'].includes(decision)) fail(400, 'Choose approve or reject.');
  note = str(note, 300);
  if (decision === 'rejected') { if (!note) fail(400, 'Please write why, so the next person knows what to fix.'); await run("UPDATE products SET listing='rejected', listing_note=? WHERE id=?", note, r.id); }
  else {
    const ctx = await context(); let pricing = null; try { pricing = pricingOf(ctx, r); } catch { /* reported below */ }
    const problems = reviewProblems(r, pricing);
    if (problems.length) fail(400, problems[0]);
    await run("UPDATE products SET listing='approved', listing_note='' WHERE id=?", r.id);
  }
  cache.drop('product:' + r.slug);
}

/* ---------- what a customer may see ---------- */
// Never the supplier, supplier SKU, cost or margin. Only where it ships from and an honest delivery window.
async function publicInfo(productId) {
  const r = await get(`SELECT dp.ship_times, dp.processing_days, dp.ships_from, s.country, s.processing_days AS sp FROM dropship_products dp JOIN suppliers s ON s.id = dp.supplier_id WHERE dp.product_id=?`, productId);
  if (!r) return null;
  const st = await settings(), from = r.ships_from || r.country, proc = r.processing_days != null ? r.processing_days : r.sp;
  const eta = Object.fromEntries(Object.keys(r.ship_times || {}).map((k) => [k, P.deliveryEstimate({ processing_days: proc, ship_times: r.ship_times, region: k, buffer: st.eta_buffer_days })]));
  return { ships_from: from, ships_from_name: C.countryName(from), eta, orderable: ordersOpen() };
}

/* ---------- photos: copied from the supplier's links into our own storage, in the background ---------- */
async function fetchImages(productId) {
  const { fetchBuffer } = require('./safe-fetch');
  const r = await get('SELECT p.id, p.slug, p.images, dp.source_images FROM products p JOIN dropship_products dp ON dp.product_id=p.id WHERE p.id=?', int(productId));
  if (!r) return 0;
  const todo = parseImages(r.source_images);
  if (!todo.length) return 0;
  const have = parseImages(r.images), got = [];
  for (const url of todo) {
    if (have.length + got.length >= 8) break;
    try { const f = await fetchBuffer(url, { maxBytes: 5_000_000 }); got.push(await CAT.storeImage(f.buf, { max: 5_000_000 })); }
    catch (e) { console.error(`Photo for product ${r.id} skipped (${url.slice(0, 80)}):`, e.message); }
  }
  if (!got.length) throw new Error('None of the supplier photos could be copied.'); // the job retries a few times, then stays visible as "photos pending"
  await run("UPDATE products SET images=? WHERE id=?", JSON.stringify([...have, ...got]), r.id);
  await run("UPDATE dropship_products SET source_images='[]' WHERE product_id=?", r.id);
  cache.drop('product:' + r.slug); cache.bump().catch(() => {});
  return got.length;
}

module.exports = { UNKNOWN_STOCK, ordersOpen, settings, saveSettings, rates, listRates, setRate, categoryMargins, setCategoryMargin, context, calcFor, parse, createChecked, create, update, reprice, detail, list, loadRow, review, reviewProblems, publicInfo, fetchImages, readTimes };
