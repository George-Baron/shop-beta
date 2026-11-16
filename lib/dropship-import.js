'use strict';
// Importing a supplier's catalogue: CSV, Excel (.xlsx) or text pasted from a spreadsheet. Two steps, so nothing is written until the admin has seen it:
//   preview(payload)  -> columns found, how they were matched, every row's verdict (new / duplicate / possible duplicate / error). Writes nothing.
//   commit(payload)   -> creates the products (all or nothing), and queues the photo downloads.
// The commit repeats the preview's work on the same data, so what was approved on screen is exactly what gets imported.
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const CSV = require('./csv');
const C = require('./countries');
const D = require('./dropship');
const queue = require('./queue');
const { fail, str, int } = S;

const MAX_ROWS = 2000, MAX_COLS = 80;
// field -> how a supplier's column heading might be written
const FIELDS = {
  sku: /^(supplier\s*)?(sku|item\s*(no|number|code|id)|product\s*(code|id|no)|part\s*(no|number)|model|code|ref(erence)?|id)$/i,
  name: /^(product\s*)?(name|title|item(\s*name)?|description\s*short)$/i,
  cost: /^((unit|supplier|wholesale|factory|cost|dropship)\s*)?(price|cost)(\s*\(?(usd|cny|rmb|ngn|eur|gbp|aed|try|inr)\)?)?$/i,
  ship_cost: /^(unit\s*)?(shipping|freight|delivery)(\s*(cost|fee|price))?$/i,
  stock: /^(stock|qty|quantity|inventory|available|in\s*stock)$/i,
  processing_days: /^(processing|handling|lead)(\s*time)?(\s*\(?days\)?)?$/i,
  weight: /^(net\s*|gross\s*)?weight(\s*\(?(kg|g|grams?|kgs)\)?)?$/i,
  length: /^length(\s*\(?cm\)?)?$/i, width: /^width(\s*\(?cm\)?)?$/i, height: /^height(\s*\(?cm\)?)?$/i,
  hs_code: /^(hs|hts|tariff)(\s*code)?$/i,
  origin: /^(country\s*of\s*origin|origin(\s*country)?|made\s*in)$/i,
  description: /^(long\s*)?(description|details|desc)$/i,
  brand: /^(brand|manufacturer|make)$/i,
  category: /^(category|product\s*type|type|department)$/i,
  images: /^(image|images|photo|photos|picture|pictures|image\s*urls?|photo\s*urls?|main\s*image|image\s*link)$/i,
  url: /^(url|link|product\s*(url|link)|supplier\s*(url|link))$/i,
};
const REQUIRED = ['sku', 'name', 'cost'];
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function guessMapping(headers) {
  const map = {}, used = new Set();
  for (const [field, re] of Object.entries(FIELDS)) {
    const i = headers.findIndex((h, n) => !used.has(n) && re.test(String(h).trim()));
    if (i >= 0) { map[field] = i; used.add(i); }
  }
  return map;
}
function weightUnitGuess(header) { return /\b(g|grams?)\b/i.test(String(header || '')) && !/kg/i.test(header) ? 'g' : 'kg'; }

// payload: { text } for pasted text / CSV, or { data: "data:...;base64,...", filename } for an uploaded file
function readTable(payload) {
  let rows;
  if (payload.data) {
    const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/.exec(String(payload.data));
    if (!m) fail(400, 'Please choose a CSV or Excel file.');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 4_500_000) fail(400, 'That file is over 4 MB. Split it into smaller files.');
    if (buf.length > 4 && buf.readUInt32BE(0) === 0x504b0304) { try { rows = CSV.parseXlsx(buf); } catch (e) { fail(400, e.message); } }
    else if (buf.length > 4 && buf.readUInt32BE(0) === 0xd0cf11e0) fail(400, 'That is an old Excel (.xls) file. In Excel choose Save As > .xlsx or CSV, then upload that.');
    else rows = CSV.parseCsv(buf.toString('utf8'));
  } else {
    const text = String(payload.text || '');
    if (text.length > 4_500_000) fail(400, 'That is too much text. Import in smaller batches.');
    rows = CSV.parseCsv(text);
  }
  if (rows.length < 2) fail(400, 'I could not find a heading row and at least one product. Make sure the first row has the column names.');
  if (rows.length - 1 > MAX_ROWS) fail(400, `That file has ${rows.length - 1} products. Import at most ${MAX_ROWS} at a time.`);
  const headers = rows[0].slice(0, MAX_COLS).map((h) => String(h));
  return { headers, rows: rows.slice(1).map((r) => r.slice(0, MAX_COLS)) };
}
const colOf = (mapping, field) => { const v = mapping && mapping[field]; return v === '' || v == null || !Number.isInteger(Number(v)) || Number(v) < 0 ? -1 : Number(v); };

let nameToCode = null;
function countryCode(s) {
  s = str(s, 60); if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s) && C.isCountry(s.toUpperCase())) return s.toUpperCase();
  if (!nameToCode) { nameToCode = new Map(C.countries().map((c) => [c.name.toLowerCase(), c.code])); for (const [a, b] of [['uk', 'GB'], ['usa', 'US'], ['u.s.a.', 'US'], ['uae', 'AE'], ['prc', 'CN'], ['korea', 'KR']]) nameToCode.set(a, b); }
  return nameToCode.get(s.toLowerCase()) || null;
}

// Turns each row into a checked product input (or a list of problems). `opts.weight_unit` is 'kg' or 'g'.
function normalize(table, mapping, opts = {}) {
  const get1 = (row, f) => { const i = colOf(mapping, f); return i < 0 ? '' : String(row[i] == null ? '' : row[i]).trim(); };
  const unit = opts.weight_unit === 'g' ? 'g' : 'kg';
  return table.rows.map((row, n) => {
    const errors = [], v = { row: n + 2 };
    v.supplier_sku = str(get1(row, 'sku'), 60); if (!v.supplier_sku) errors.push('No supplier SKU');
    v.name = str(get1(row, 'name'), 140); if (!v.name) errors.push('No product name');
    v.cost = CSV.parseNumber(get1(row, 'cost')); if (v.cost == null || v.cost <= 0) errors.push('Cost is missing or not a positive number');
    const ship = get1(row, 'ship_cost'); v.ship_cost = ship ? CSV.parseNumber(ship) : (opts.default_ship_cost == null ? 0 : Number(opts.default_ship_cost)); if (v.ship_cost == null || v.ship_cost < 0) { errors.push('Shipping cost is not a number'); v.ship_cost = 0; }
    const stock = get1(row, 'stock'); v.supplier_stock = null; if (stock !== '') { const s = CSV.parseNumber(stock); if (s == null || s < 0) errors.push('Stock is not a number'); else v.supplier_stock = Math.floor(s); }
    const pd = get1(row, 'processing_days'); v.processing_days = null; if (pd !== '') { const s = CSV.parseNumber(pd); if (s == null || s < 0 || s > 120) errors.push('Processing days must be 0 to 120'); else v.processing_days = Math.floor(s); }
    for (const [f, key, div] of [['weight', 'weight_kg', unit === 'g' ? 1000 : 1], ['length', 'length_cm', 1], ['width', 'width_cm', 1], ['height', 'height_cm', 1]]) {
      const raw = get1(row, f); v[key] = null; if (raw !== '') { const s = CSV.parseNumber(raw); if (s == null || s < 0) errors.push(`${f[0].toUpperCase() + f.slice(1)} is not a number`); else v[key] = Math.round((s / div) * 1000) / 1000; }
    }
    v.hs_code = str(get1(row, 'hs_code'), 20).replace(/\s+/g, ''); if (v.hs_code && !/^\d{4}(\.?\d{2}){0,3}$/.test(v.hs_code)) { errors.push('HS code should be 4 to 10 digits'); v.hs_code = ''; }
    const og = get1(row, 'origin'); v.origin_country = null; if (og) { v.origin_country = countryCode(og); if (!v.origin_country) errors.push(`Country of origin "${og.slice(0, 30)}" not recognised`); }
    v.description = str(get1(row, 'description'), 4000); v.brand = str(get1(row, 'brand'), 60); v.category_name = str(get1(row, 'category'), 60);
    v.supplier_url = str(get1(row, 'url'), 500); if (v.supplier_url && !/^https?:\/\/[^\s"'<>]+$/.test(v.supplier_url)) v.supplier_url = '';
    v.source_images = [...new Set(get1(row, 'images').split(/[|;\s]+/).map((u) => u.trim()).filter((u) => /^https?:\/\/[^\s"'<>]+$/.test(u) && u.length <= 500))].slice(0, 6);
    return { ...v, errors };
  });
}

// Marks each row: new | duplicate (same supplier SKU already imported) | possible_duplicate (same product name already in the shop) | in_file_duplicate | error
async function classify(items, supplierId) {
  const skus = items.filter((i) => i.supplier_sku).map((i) => i.supplier_sku.toLowerCase());
  const bySku = new Map((await all('SELECT product_id, lower(btrim(supplier_sku)) AS k FROM dropship_products WHERE supplier_id=? AND lower(btrim(supplier_sku)) = ANY(?::text[])', supplierId, skus)).map((r) => [r.k, Number(r.product_id)]));
  const names = [...new Set(items.map((i) => normName(i.name)).filter(Boolean))];
  const byName = new Map((await all("SELECT id, lower(regexp_replace(name, '[^a-zA-Z0-9]+', '', 'g')) AS k FROM products WHERE lower(regexp_replace(name, '[^a-zA-Z0-9]+', '', 'g')) = ANY(?::text[])", names)).map((r) => [r.k, Number(r.id)]));
  const seenSku = new Set(), seenName = new Set();
  return items.map((i) => {
    const k = (i.supplier_sku || '').toLowerCase(), nk = normName(i.name);
    let status = 'new', matched = null;
    if (i.errors.length) status = 'error';
    else if (seenSku.has(k)) status = 'in_file_duplicate';
    else if (bySku.has(k)) { status = 'duplicate'; matched = bySku.get(k); }
    else if (seenName.has(nk)) { status = 'in_file_duplicate'; }
    else if (byName.has(nk)) { status = 'possible_duplicate'; matched = byName.get(nk); }
    // A repeated SKU is always flagged, but a name is only reserved by a row that will really be created (a skipped duplicate must not shadow a later row).
    if (k && !i.errors.length) seenSku.add(k);
    if (nk && (status === 'new' || status === 'possible_duplicate')) seenName.add(nk);
    return { ...i, status, matched_product_id: matched };
  });
}

async function prepare(payload) {
  const table = readTable(payload);
  const supplier = await get('SELECT * FROM suppliers WHERE id=?', int(payload.supplier_id));
  if (!supplier) fail(400, 'Please choose the supplier these products come from.');
  const mapping = payload.mapping && typeof payload.mapping === 'object' ? payload.mapping : guessMapping(table.headers);
  const missing = REQUIRED.filter((f) => colOf(mapping, f) < 0);
  const opts = { weight_unit: payload.weight_unit || (colOf(mapping, 'weight') >= 0 ? weightUnitGuess(table.headers[colOf(mapping, 'weight')]) : 'kg'), default_ship_cost: payload.default_ship_cost };
  return { table, supplier, mapping, missing, opts };
}

async function preview(payload) {
  const { table, supplier, mapping, missing, opts } = await prepare(payload);
  const out = { headers: table.headers, mapping, missing_fields: missing, weight_unit: opts.weight_unit, supplier: { id: Number(supplier.id), name: supplier.name, currency: supplier.currency } };
  if (missing.length) return { ...out, summary: null, rows: [], note: 'Tell me which columns hold the ' + missing.map((m) => ({ sku: 'supplier SKU', name: 'product name', cost: 'cost' }[m])).join(', ') + '.' };
  const rows = await classify(normalize(table, mapping, opts), Number(supplier.id));
  const summary = { total: rows.length };
  for (const r of rows) summary[r.status] = (summary[r.status] || 0) + 1;
  const rate = supplier.currency === 'NGN' || (await D.rates())[supplier.currency];
  return { ...out, summary, no_rate: rate ? '' : supplier.currency, rows: rows.slice(0, 300).map(({ description, source_images, ...r }) => ({ ...r, images: source_images.length })), shown: Math.min(300, rows.length) };
}

// options: store (department, required), category_id, on_duplicate ('skip' | 'update'), import_possible (true = also import "possible duplicates", or a list of row numbers),
//          ship_min / ship_max / ship_region (default delivery days for the new products)
async function commit(user, payload) {
  const { table, supplier, mapping, missing, opts } = await prepare(payload);
  if (missing.length) fail(400, 'Match the supplier SKU, product name and cost columns first.');
  const store = str(payload.store, 40);
  if (!(await get('SELECT 1 x FROM stores WHERE slug=?', store))) fail(400, 'Choose the department these products belong in.');
  const ctx = await D.context(), sup = { id: Number(supplier.id), currency: supplier.currency, margin_type: supplier.margin_type, margin_value: supplier.margin_value == null ? null : Number(supplier.margin_value), processing_days: supplier.processing_days };
  if (supplier.currency !== 'NGN' && !ctx.rates[supplier.currency]) fail(400, `There is no exchange rate for ${supplier.currency} yet. Add it in Dropshipping > Settings, then import again.`);
  const defCat = int(payload.category_id) || null;
  if (defCat && !(await get('SELECT 1 x FROM categories WHERE id=? AND store=?', defCat, store))) fail(400, 'That category is not in the chosen department.');
  const cats = new Map((await all('SELECT id, lower(name) AS n FROM categories WHERE store=?', store)).map((c) => [c.n, Number(c.id)]));
  const update = payload.on_duplicate === 'update';
  const possible = payload.import_possible === true ? true : new Set((Array.isArray(payload.import_possible) ? payload.import_possible : []).map(Number));
  let ship_times = {};
  if (payload.ship_min !== undefined || payload.ship_max !== undefined) { const region = str(payload.ship_region, 3).toUpperCase() || 'NG'; ship_times = D.readTimes({ [region]: { min: payload.ship_min, max: payload.ship_max } }); }

  const rows = await classify(normalize(table, mapping, opts), Number(supplier.id));
  const result = { created: 0, updated: 0, skipped: 0, errors: rows.filter((r) => r.status === 'error').length, needs_reprice: 0, created_ids: [], problems: [] };
  await tx(async () => {
    for (const r of rows) {
      if (r.status === 'error') { if (result.problems.length < 50) result.problems.push({ row: r.row, message: r.errors.join('; ') }); continue; }
      if (r.status === 'in_file_duplicate') { result.skipped++; continue; }
      if (r.status === 'duplicate') {
        if (!update) { result.skipped++; continue; }
        // Supplier facts change; the live price and listing status do not. The admin reprices on purpose.
        const cur = await D.loadRow(r.matched_product_id);
        await run(`UPDATE dropship_products SET cost=?, ship_cost=?, supplier_stock=?, processing_days=COALESCE(?, processing_days), weight_kg=COALESCE(?, weight_kg), length_cm=COALESCE(?, length_cm), width_cm=COALESCE(?, width_cm), height_cm=COALESCE(?, height_cm),
          hs_code=CASE WHEN ?<>'' THEN ? ELSE hs_code END, origin_country=COALESCE(?, origin_country), updated=? WHERE product_id=?`, r.cost, r.ship_cost, r.supplier_stock, r.processing_days, r.weight_kg, r.length_cm, r.width_cm, r.height_cm, r.hs_code, r.hs_code, r.origin_country, now(), cur.id);
        await run('UPDATE products SET stock=? WHERE id=?', r.supplier_stock == null ? D.UNKNOWN_STOCK : r.supplier_stock, cur.id);
        result.updated++;
        if (Number(cur.cost) !== r.cost || Number(cur.ship_cost) !== r.ship_cost) result.needs_reprice++;
        continue;
      }
      if (r.status === 'possible_duplicate' && !(possible === true || possible.has(r.row))) { result.skipped++; continue; }
      const category_id = (r.category_name && cats.get(r.category_name.toLowerCase())) || defCat;
      const { d } = await D.parse({ ...r, supplier_id: sup.id, store, category_id, images: [], ship_times, active: 1, price_mode: 'auto' });
      d.source_images = r.source_images;
      const pid = await D.createChecked(d, supplier, ctx);
      result.created++; result.created_ids.push(pid);
    }
  });
  // Photos are copied after the products exist, one background job each, so a big import never makes the page wait on other people's servers.
  let queued = 0;
  for (const id of result.created_ids) { if (await get("SELECT 1 x FROM dropship_products WHERE product_id=? AND source_images <> '[]'", id)) { if (await queue.enqueue('dropship.images', { productId: id }, { key: 'dsimg:' + id, maxAttempts: 3 })) queued++; } }
  result.images_queued = queued; result.no_ship_times = Object.keys(ship_times).length ? 0 : result.created;
  return result;
}

module.exports = { FIELDS, guessMapping, readTable, normalize, classify, preview, commit, countryCode };
