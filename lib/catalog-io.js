'use strict';
// Bulk product import and export (Excel .xlsx and CSV), for the admin (our own products, or a partner's on their behalf) and for a partner store (its own products only).
//   template(scope)  -> the import template        check(scope, opts, rows) -> what WOULD happen, no writes
//   apply(scope, opts, rows) -> does it             exportRows(scope, filters) -> a file
// A scope is { vendor: null } for us, or { vendor: <vendors row> } for a partner store. Admin rows can name a partner in the Partner column.
// Rules: nothing is overwritten silently (updates are shown first, blank cells never erase anything), the database is the judge of duplicates,
// and every row is checked again when it is applied.
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const PC = require('./pharmacy-core');
const CAT = require('./catalog');
const X = require('./xlsx');
const cache = require('./cache');
const { fail, str } = S;

const MAX_ROWS_PER_CALL = 200;
const FIELDS = [
  { key: 'name', label: 'Product Name', req: 1, alias: ['name', 'product', 'product name', 'title', 'item', 'item name', 'product title'], help: 'Required. Up to 140 characters.' },
  { key: 'sku', label: 'Internal Reference', alias: ['sku', 'reference', 'ref', 'internal reference', 'internal ref', 'code', 'product code', 'item code'], help: 'Your own unique code. Used to find the product when you update.' },
  { key: 'barcode', label: 'Barcode', alias: ['barcode', 'ean', 'upc', 'gtin', 'bar code'], help: 'Letters or digits. One barcode can belong to only one product.' },
  { key: 'department', label: 'Department', alias: ['department', 'store', 'section', 'shop', 'dept'], help: 'Required for new products (not needed if you have only one department). Must match a department listed on the Departments sheet.' },
  { key: 'category', label: 'Category', alias: ['category', 'cat', 'product category'], help: 'Must match a category of that department (see the Departments sheet). Leave empty for none.' },
  { key: 'subcategory', label: 'Subcategory', alias: ['subcategory', 'sub category', 'sub-category', 'sub cat'], help: 'Free text, shown in exports.' },
  { key: 'brand', label: 'Brand', alias: ['brand', 'manufacturer', 'make'], help: '' },
  { key: 'description', label: 'Description', alias: ['description', 'details', 'about', 'desc'], help: 'Up to 4,000 characters.' },
  { key: 'cost_price', label: 'Cost Price', alias: ['cost price', 'cost', 'purchase price', 'buying price'], help: 'What you pay. Private: customers never see it. Whole naira.' },
  { key: 'price', label: 'Selling Price', req: 1, alias: ['price', 'selling price', 'retail price', 'sale price', 'unit price'], help: 'Required for new products. Whole naira, for example 5000.' },
  { key: 'wholesale_price', label: 'Wholesale Price', admin: 1, alias: ['wholesale price', 'wholesale'], help: 'Our own products only, without sizes or colours. Below the selling price. 0 removes it.' },
  { key: 'wholesale_min_qty', label: 'Wholesale Min Qty', admin: 1, alias: ['wholesale min qty', 'wholesale minimum', 'min wholesale qty', 'moq'], help: 'Smallest wholesale order, 1 or more.' },
  { key: 'stock', label: 'Quantity', alias: ['quantity', 'qty', 'stock', 'opening stock', 'on hand', 'stock quantity'], help: 'Units in stock, whole number.' },
  { key: 'min_stock', label: 'Minimum Stock', alias: ['minimum stock', 'min stock', 'reorder level', 'reorder', 'low stock level'], help: 'Reorder alert level.' },
  { key: 'unit', label: 'Unit of Measure', alias: ['unit', 'uom', 'unit of measure', 'units'], help: 'For example pcs, kg, carton.' },
  { key: 'status', label: 'Product Status', alias: ['status', 'product status', 'active'], help: 'Active or Inactive.' },
  { key: 'tax', label: 'Tax', alias: ['tax', 'vat', 'tax rate'], help: 'A note only, for example 7.5%. It is not added to checkout totals.' },
  { key: 'weight', label: 'Weight', alias: ['weight', 'weight kg', 'weight (kg)'], help: 'In kilograms, for example 0.5.' },
  { key: 'partner', label: 'Partner', admin: 1, alias: ['partner', 'partner store', 'vendor', 'seller'], help: 'Leave empty for our own products. Otherwise the name of an approved partner store.' },
];
const fieldsFor = (scope) => FIELDS.filter((f) => !f.admin || !scope.vendor);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function autoMap(headers, scope) {
  const map = {}, used = new Set();
  for (const f of fieldsFor(scope)) {
    const names = [norm(f.label), ...f.alias.map(norm)];
    const i = headers.findIndex((h, ix) => !used.has(ix) && names.includes(norm(h)));
    if (i >= 0) { map[f.key] = i; used.add(i); }
  }
  return map;
}

/* ---------- reference data ---------- */
async function reference(scope) {
  const stores = (await all('SELECT slug, name FROM stores WHERE active=1 ORDER BY sort, slug')).filter((s) => !PC.storeHidden(s.slug) && s.slug !== PC.PHARMACY_STORE);
  const cats = await all('SELECT id, store, slug, name FROM categories ORDER BY sort, id');
  let allowed = stores;
  if (scope.vendor) { const d = new Set((await all('SELECT store FROM vendor_departments WHERE vendor_id=?', scope.vendor.id)).map((r) => r.store)); allowed = stores.filter((s) => d.has(s.slug)); }
  const vendors = scope.vendor ? [] : await all("SELECT id, slug, name, partner_id FROM vendors WHERE status='approved'");
  return { stores, allowed, cats, vendors };
}

function template(scope, ref, format) {
  const F = fieldsFor(scope);
  const head = F.map((f) => f.label);
  if (format === 'csv') return X.writeCsv([head]);
  const help = [['Column', 'Required', 'What to put there']].concat(F.map((f) => [f.label, f.req ? 'Yes' : (f.key === 'department' ? 'For new products' : 'No'), f.help]));
  const notes = [[''], ['How importing works'],
    ['1. Fill the Products sheet, one product per row. Keep the first row (the column names). Delete nothing else.'],
    ['2. On the Import page choose "Create new products" or "Update existing products", then upload this file.'],
    ['3. You see a preview with every problem listed before anything is saved. Fix the file or correct the rows on screen.'],
    ['4. Update mode finds products by Internal Reference first, then by Barcode. Empty cells never erase existing data. Every change is shown before you confirm it.'],
    ['5. Photos are not part of the import. Add them later on the product page. Products without photos show a placeholder.'],
    scope.vendor ? ['6. New and changed products go to our team for review before customers see them (price and stock changes do not need review).'] : ['6. A Partner name creates or updates that partner store\'s products. Leave Partner empty for our own products.']];
  const deptRows = [['Department', 'Category']];
  for (const s of (scope.vendor ? ref.allowed : ref.stores)) { deptRows.push([s.name, '']); for (const c of ref.cats.filter((c) => c.store === s.slug)) deptRows.push(['', c.name]); }
  return X.writeXlsx([
    { name: 'Products', rows: [head], widths: F.map((f) => Math.max(14, f.label.length + 4)) },
    { name: 'Instructions', rows: help.concat(notes), widths: [26, 18, 90] },
    { name: 'Departments', rows: deptRows, widths: [28, 34] },
  ]);
}

/* ---------- reading one row ---------- */
const money = (s, what, errors, { min = 0 } = {}) => {
  const t = String(s).replace(/[₦\s,]|^NGN|^N(?=\d)/gi, '');
  if (!/^\d+(\.0+)?$/.test(t)) { errors.push(`${what} must be a whole number of naira (like 5000), not "${s}".`); return undefined; }
  const n = Math.round(Number(t)); if (n < min || n > 2_000_000_000) { errors.push(`${what} is out of range.`); return undefined; }
  return n;
};
const whole = (s, what, errors, max = 1_000_000_000) => {
  const t = String(s).replace(/[\s,]/g, '');
  if (!/^\d+(\.0+)?$/.test(t)) { errors.push(`${what} must be a whole number, not "${s}".`); return undefined; }
  const n = Math.round(Number(t)); if (n > max) { errors.push(`${what} is too large.`); return undefined; } return n;
};
const statusOf = (s, errors) => {
  const t = norm(s);
  if (['active', 'yes', 'y', '1', 'true', 'enabled', 'live', 'on'].includes(t)) return 1;
  if (['inactive', 'no', 'n', '0', 'false', 'disabled', 'hidden', 'off'].includes(t)) return 0;
  errors.push(`Product Status must be Active or Inactive, not "${s}".`); return undefined;
};

// Turns the cells of one row into checked values. Does NOT touch the database except through the lookup tables in `look`.
function readRow(raw, scope, mode, ref, look) {
  const errors = [], warnings = [], v = {}, provided = (k) => raw[k] !== undefined && raw[k] !== '';
  const create = mode === 'create';
  if (provided('name')) v.name = str(raw.name, 140); else if (create) errors.push('Product Name is required.');
  if (raw.name && String(raw.name).length > 140) warnings.push('Product Name was cut to 140 characters.');
  for (const [k, n] of [['sku', 40], ['barcode', 40], ['brand', 60], ['unit', 20], ['tax', 30], ['subcategory', 60]]) if (provided(k)) { v[k] = str(raw[k], n); if (String(raw[k]).trim().length > n) errors.push(`${FIELDS.find((f) => f.key === k).label} is longer than ${n} characters.`); }
  if (v.barcode && !/^[A-Za-z0-9._\-/ ]{1,40}$/.test(v.barcode)) errors.push('Barcode may contain only letters, digits and - . _ /');
  if (provided('description')) { v.description = str(raw.description, 4000); if (String(raw.description).length > 4000) warnings.push('Description was cut to 4,000 characters.'); }
  if (provided('price')) { const n = money(raw.price, 'Selling Price', errors); if (n !== undefined) v.price = n; } else if (create) errors.push('Selling Price is required.');
  if (provided('cost_price')) { const n = money(raw.cost_price, 'Cost Price', errors); if (n !== undefined) v.cost_price = n; }
  if (provided('stock')) { const n = whole(raw.stock, 'Quantity', errors); if (n !== undefined) v.stock = n; }
  if (provided('min_stock')) { const n = whole(raw.min_stock, 'Minimum Stock', errors); if (n !== undefined) v.min_stock = n; }
  if (provided('weight')) { const t = String(raw.weight).replace(/[\s,]|kg$/gi, ''); if (!/^\d+(\.\d{1,3})?$/.test(t) || Number(t) > 1000) errors.push('Weight must be a number of kilograms, like 0.5.'); else v.weight_kg = Number(t); }
  if (provided('status')) { const s = statusOf(raw.status, errors); if (s !== undefined) v.active = s; }
  if (provided('wholesale_price') || provided('wholesale_min_qty')) {
    if (scope.vendor) warnings.push('Wholesale columns are ignored for partner stores.');
    else {
      if (provided('wholesale_price')) { const n = money(raw.wholesale_price, 'Wholesale Price', errors); if (n !== undefined) v.wholesale_price = n; }
      if (provided('wholesale_min_qty')) { const n = whole(raw.wholesale_min_qty, 'Wholesale Min Qty', errors, 100000); if (n !== undefined) { if (n < 1) errors.push('Wholesale Min Qty must be 1 or more.'); else v.wholesale_min_qty = n; } }
    }
  }
  // partner (admin only)
  let vendor = scope.vendor;
  if (!scope.vendor && provided('partner')) {
    const t = norm(raw.partner); vendor = ref.vendors.find((x) => norm(x.name) === t || norm(x.slug) === t) || null;
    if (!vendor) errors.push(`Partner "${raw.partner}" was not found among approved partner stores.`);
  }
  v._vendor = vendor || null;
  // department and category
  if (provided('department')) {
    const t = norm(raw.department), pool = scope.vendor ? ref.allowed : ref.stores, st = pool.find((s) => norm(s.name) === t || norm(s.slug) === t);
    if (st) v.store = st.slug; else if (norm(raw.department) === 'pharmacy') errors.push('Medicines cannot be imported here. Pharmacy products are managed by the pharmacy team.'); else errors.push(`Department "${raw.department}" ${scope.vendor ? 'is not one of your departments' : 'was not found'}. See the Departments sheet.`);
  } else if (create) {
    if (scope.vendor && ref.allowed.length === 1) v.store = ref.allowed[0].slug; else errors.push('Department is required for new products.');
  }
  if (provided('category')) v._categoryName = String(raw.category).trim();
  return { v, errors, warnings, create, vendor };
}

/* ---------- looking at the database for a batch of rows ---------- */
const scopeId = (vendor) => (vendor ? Number(vendor.id) : 0);
const COLS = 'id, name, sku, barcode, brand, description, store, category_id, subcategory, price, cost_price, stock, min_stock, unit, tax, weight_kg, active, wholesale_price, wholesale_min_qty, vendor_id, listing, images';

async function lookups(items) { // items: [{ vendor, v }]  -> Maps keyed by scope
  const by = new Map();
  for (const it of items) { const k = scopeId(it.vendor); if (!by.has(k)) by.set(k, { skus: new Set(), codes: new Set(), names: new Set() }); const b = by.get(k); if (it.v.sku) b.skus.add(it.v.sku.toLowerCase()); if (it.v.barcode) b.codes.add(it.v.barcode); if (it.v.name) b.names.add(it.v.name.toLowerCase()); }
  const out = new Map();
  for (const [k, b] of by) {
    const bySku = new Map(), byCode = new Map(), byName = new Map();
    if (b.skus.size) for (const p of await all(`SELECT ${COLS} FROM products WHERE COALESCE(vendor_id,0)=? AND lower(sku) = ANY(?)`, k, [...b.skus])) bySku.set(p.sku.toLowerCase(), p);
    if (b.codes.size) for (const p of await all(`SELECT ${COLS} FROM products WHERE COALESCE(vendor_id,0)=? AND barcode = ANY(?)`, k, [...b.codes])) byCode.set(p.barcode, p);
    if (b.names.size) for (const p of await all(`SELECT id, name, brand, store FROM products WHERE COALESCE(vendor_id,0)=? AND lower(name) = ANY(?)`, k, [...b.names])) { const key = p.name.toLowerCase() + '|' + String(p.brand || '').toLowerCase(); if (!byName.has(key)) byName.set(key, p); }
    out.set(k, { bySku, byCode, byName });
  }
  return out;
}

const LABEL = { name: 'Product Name', brand: 'Brand', description: 'Description', store: 'Department', category_id: 'Category', subcategory: 'Subcategory', price: 'Selling Price', cost_price: 'Cost Price', stock: 'Quantity', min_stock: 'Minimum Stock', unit: 'Unit', tax: 'Tax', weight_kg: 'Weight', active: 'Status', sku: 'Internal Reference', barcode: 'Barcode', wholesale_price: 'Wholesale Price', wholesale_min_qty: 'Wholesale Min Qty' };
const showVal = (k, x) => (k === 'active' ? (Number(x) ? 'Active' : 'Inactive') : k === 'weight_kg' ? String(Number(x)) : x == null ? '' : String(x).length > 60 ? String(x).slice(0, 57) + '…' : String(x));

// Judges one row against the database.
async function judge(row, scope, mode, ref, look, seen) {
  const r = readRow(row, scope, mode, ref, look);
  const { v, errors, warnings, vendor } = r;
  const L = look.get(scopeId(vendor)) || { bySku: new Map(), byCode: new Map(), byName: new Map() };
  const out = { errors, warnings, v, vendor, action: mode === 'create' ? 'create' : 'update', changes: [], match: null };
  // repeated inside this batch
  for (const [k, label] of [['sku', 'Internal Reference'], ['barcode', 'Barcode']]) if (v[k]) { const key = `${scopeId(vendor)}|${k}|${v[k].toLowerCase()}`; if (seen.has(key)) errors.push(`${label} "${v[k]}" is repeated in this file (row ${seen.get(key)}).`); else seen.set(key, row._n); }
  // category
  const storeFor = v.store || null;
  let cur = null;
  if (mode === 'update') {
    cur = (v.sku && L.bySku.get(v.sku.toLowerCase())) || (v.barcode && L.byCode.get(v.barcode)) || null;
    if (!v.sku && !v.barcode) errors.push('Update needs an Internal Reference or a Barcode to find the product.');
    else if (!cur) errors.push(`No existing product has ${v.sku ? 'Internal Reference "' + v.sku + '"' : ''}${v.sku && v.barcode ? ' or ' : ''}${v.barcode ? 'Barcode "' + v.barcode + '"' : ''}${vendor && !scope.vendor ? ' for this partner' : ''}.`);
    out.match = cur;
  }
  const finalStore = storeFor || (cur && cur.store) || null;
  if (finalStore === PC.PHARMACY_STORE) errors.push('Pharmacy products cannot be imported or changed here.');
  if (v._categoryName !== undefined) {
    const t = norm(v._categoryName);
    const c = finalStore ? ref.cats.find((x) => x.store === finalStore && (norm(x.name) === t || norm(x.slug) === t)) : null;
    if (c) v.category_id = Number(c.id); else if (finalStore) errors.push(`Category "${v._categoryName}" does not exist in the ${finalStore} department. Add it first, or fix the name (see the Departments sheet).`); else errors.push('Category could not be checked because the Department is missing.');
  }
  if (mode === 'create') {
    if (v.sku && L.bySku.has(v.sku.toLowerCase())) errors.push(`Internal Reference "${v.sku}" already exists (${L.bySku.get(v.sku.toLowerCase()).name}). Use Update mode to change it.`);
    if (v.barcode && L.byCode.has(v.barcode)) errors.push(`Barcode "${v.barcode}" already belongs to "${L.byCode.get(v.barcode).name}".`);
    if (v.name) { const d = L.byName.get(v.name.toLowerCase() + '|' + String(v.brand || '').toLowerCase()); if (d) warnings.push({ code: 'dup_name', text: `Looks like an existing product: "${d.name}".` }); }
    if (v.wholesale_price && v.price && v.wholesale_price >= v.price) errors.push('Wholesale Price must be below the Selling Price.');
    if (v.wholesale_price !== undefined && (vendor || finalStore === PC.PHARMACY_STORE)) { warnings.push('Wholesale Price is ignored: wholesale covers our own products only.'); delete v.wholesale_price; delete v.wholesale_min_qty; }
  } else if (cur) {
    // a different product must not already hold the new barcode / reference
    if (v.barcode && v.barcode !== cur.barcode) { const o = L.byCode.get(v.barcode); if (o && Number(o.id) !== Number(cur.id)) errors.push(`Barcode "${v.barcode}" already belongs to "${o.name}".`); }
    if (v.sku && v.sku.toLowerCase() !== String(cur.sku).toLowerCase()) { const o = L.bySku.get(v.sku.toLowerCase()); if (o && Number(o.id) !== Number(cur.id)) errors.push(`Internal Reference "${v.sku}" already belongs to "${o.name}".`); }
    if (v.stock !== undefined && (await get('SELECT 1 x FROM variants WHERE product_id=? LIMIT 1', cur.id))) errors.push('This product has sizes or colours, so its stock is set per size on the product page.');
    if (v.wholesale_price !== undefined || v.wholesale_min_qty !== undefined) {
      if (cur.vendor_id || (await get('SELECT 1 x FROM variants WHERE product_id=? LIMIT 1', cur.id))) errors.push('Wholesale applies to our own products without sizes or colours.');
      else if (v.wholesale_price && v.wholesale_price >= (v.price || cur.price)) errors.push('Wholesale Price must be below the Selling Price.');
    }
    if (!errors.length) {
      for (const k of ['name', 'brand', 'description', 'store', 'category_id', 'subcategory', 'price', 'cost_price', 'stock', 'min_stock', 'unit', 'tax', 'weight_kg', 'active', 'sku', 'barcode', 'wholesale_price', 'wholesale_min_qty']) {
        if (v[k] === undefined) continue;
        let from = cur[k], to = v[k];
        if (k === 'weight_kg') from = Number(from); if (k === 'wholesale_price') { from = from == null ? 0 : Number(from); }
        if (k === 'category_id') { from = from == null ? null : Number(from); }
        if (String(from) !== String(to)) {
          if (k === 'category_id') out.changes.push({ field: 'Category', from: cur.category_id == null ? '' : (ref.cats.find((c) => Number(c.id) === Number(cur.category_id)) || {}).name || '', to: v._categoryName });
          else out.changes.push({ field: LABEL[k], from: showVal(k, from), to: showVal(k, to) });
        }
      }
      if (!out.changes.length) out.action = 'unchanged';
    }
  }
  if (mode === 'create' && vendor && !scope.vendor) { /* admin creating for a partner: fine */ }
  return out;
}

const objectify = (rows, mapping, startRow) => rows.map((cells, i) => {
  const o = { _n: startRow + i + 1 };
  for (const [k, ci] of Object.entries(mapping || {})) { const c = cells[Number(ci)]; o[k] = c == null ? '' : String(c).trim(); }
  return o;
});

function readInput(opts, rows) {
  const mode = opts && opts.mode === 'update' ? 'update' : 'create';
  if (!Array.isArray(rows) || !rows.length) fail(400, 'There are no rows to check.');
  if (rows.length > MAX_ROWS_PER_CALL) fail(400, `Send at most ${MAX_ROWS_PER_CALL} rows at a time.`);
  if (!opts || typeof opts.mapping !== 'object' || !opts.mapping) fail(400, 'Please match the columns first.');
  return { mode, startRow: Math.max(0, Number(opts.startRow) || 0), cells: rows.map((r) => (Array.isArray(r) ? r.slice(0, 40).map((c) => String(c == null ? '' : c)) : [])) };
}

async function check(scope, opts, rows) {
  const { mode, startRow, cells } = readInput(opts, rows);
  const ref = await reference(scope), objs = objectify(cells, opts.mapping, startRow);
  const parsed = objs.map((o) => readRow(o, scope, mode, ref));
  const look = await lookups(parsed.map((p) => ({ vendor: p.vendor, v: p.v })));
  const seen = new Map(), results = [];
  for (const o of objs) {
    const j = await judge(o, scope, mode, ref, look, seen);
    results.push({ n: o._n, name: j.v.name || (j.match && j.match.name) || '', status: j.errors.length ? 'error' : j.action === 'unchanged' ? 'unchanged' : 'ok', action: j.action, errors: j.errors, warnings: j.warnings.map((w) => (typeof w === 'string' ? { text: w } : w)), changes: j.changes });
  }
  return { results };
}

/* ---------- applying ---------- */
async function insertProduct(scope, j) {
  const v = j.v, vendor = j.vendor;
  const sku = v.sku || '', wh = !vendor && v.wholesale_price ? v.wholesale_price : null;
  const r = await run('INSERT INTO products (slug,store,category_id,name,brand,description,price,compare_price,stock,sku,emoji,images,size_label,featured,bestseller,new_arrival,active,created,barcode,subcategory,cost_price,min_stock,unit,tax,weight_kg,vendor_id,partner_id,listing,wholesale_price,wholesale_min_qty) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    await CAT.uniqueSlug(v.name), v.store, v.category_id || null, v.name, v.brand || '', v.description || '', v.price, 0, v.stock || 0, sku, '📦', '[]', 'Size', 0, 0, 0,
    v.active === undefined ? 1 : v.active, now(), v.barcode || '', v.subcategory || '', v.cost_price || 0, v.min_stock || 0, v.unit || '', v.tax || '', v.weight_kg || 0,
    vendor ? vendor.id : null, vendor ? (vendor.partner_id || null) : null, vendor ? (scope.vendor ? 'pending' : 'approved') : 'approved', wh, wh ? (v.wholesale_min_qty || 1) : 1);
  const id = Number(r.lastInsertRowid);
  return id;
}
async function updateProduct(scope, j) {
  const v = j.v, cur = j.match, sets = [], args = [];
  const put = (col, val) => { sets.push(col + '=?'); args.push(val); };
  for (const k of ['name', 'brand', 'description', 'store', 'category_id', 'subcategory', 'price', 'cost_price', 'stock', 'min_stock', 'unit', 'tax', 'weight_kg', 'active', 'sku', 'barcode']) if (v[k] !== undefined) put(k, v[k]);
  if (v.wholesale_price !== undefined) put('wholesale_price', v.wholesale_price === 0 ? null : v.wholesale_price);
  if (v.wholesale_min_qty !== undefined) put('wholesale_min_qty', v.wholesale_min_qty);
  if (v.price !== undefined && cur.compare_price && Number(cur.compare_price) <= v.price) put('compare_price', 0);
  if (!sets.length) return;
  await run(`UPDATE products SET ${sets.join(', ')} WHERE id=?`, ...args, cur.id);
  if (scope.vendor && cur.listing !== 'pending' && ['name', 'brand', 'description', 'store', 'category_id'].some((k) => v[k] !== undefined && String(cur[k] == null ? '' : cur[k]) !== String(v[k]))) await run("UPDATE products SET listing='pending', listing_note='' WHERE id=?", cur.id);
}

async function apply(scope, opts, rows) {
  const { mode, startRow, cells } = readInput(opts, rows);
  const skipDup = !!opts.skipDuplicates;
  const ref = await reference(scope), objs = objectify(cells, opts.mapping, startRow);
  const parsed = objs.map((o) => readRow(o, scope, mode, ref));
  const look = await lookups(parsed.map((p) => ({ vendor: p.vendor, v: p.v })));
  const seen = new Map(), results = [];
  for (const o of objs) {
    const j = await judge(o, scope, mode, ref, look, seen);
    const res = { n: o._n, name: j.v.name || (j.match && j.match.name) || '', action: j.action, errors: j.errors, warnings: j.warnings.map((w) => (typeof w === 'string' ? { text: w } : w)), changes: j.changes, status: 'error' };
    if (j.errors.length) { results.push(res); continue; }
    if (j.action === 'unchanged') { res.status = 'unchanged'; results.push(res); continue; }
    if (skipDup && res.warnings.some((w) => w.code === 'dup_name')) { res.status = 'skipped'; results.push(res); continue; }
    try {
      await tx(async () => { if (j.action === 'create') res.id = await insertProduct(scope, j); else { await updateProduct(scope, j); res.id = Number(j.match.id); } });
      res.status = 'done';
      // keep the lookups honest for later rows in this batch
      const k = look.get(scopeId(j.vendor)); if (k && j.action === 'create') { const added = { id: res.id, name: j.v.name, sku: j.v.sku || '', barcode: j.v.barcode || '', store: j.v.store, brand: j.v.brand || '' }; if (j.v.sku) k.bySku.set(j.v.sku.toLowerCase(), added); if (j.v.barcode) k.byCode.set(j.v.barcode, added); k.byName.set(j.v.name.toLowerCase() + '|' + String(j.v.brand || '').toLowerCase(), added); }
    } catch (e) {
      res.status = 'error';
      res.errors.push(e && e.code === '23505' ? 'The barcode is already used by another product.' : 'Could not save this row. Please try again.');
      if (!(e && e.code === '23505')) console.error(JSON.stringify({ level: 'error', msg: 'catalog import row failed', error: String(e && e.message).slice(0, 200) }));
    }
    results.push(res);
  }
  cache.clear();
  return { results };
}

async function logRun(scope, user, kind, o) {
  await run('INSERT INTO catalog_log (kind,user_id,vendor_id,mode,filename,total,created_n,updated_n,skipped_n,failed_n,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    kind, user ? user.id : null, scope.vendor ? scope.vendor.id : null, str(o.mode, 20), str(o.filename, 120), Math.max(0, Number(o.total) || 0), Math.max(0, Number(o.created) || 0), Math.max(0, Number(o.updated) || 0), Math.max(0, Number(o.skipped) || 0), Math.max(0, Number(o.failed) || 0), now());
}
async function history(scope) {
  return all(`SELECT l.id, l.kind, l.mode, l.filename, l.total, l.created_n, l.updated_n, l.skipped_n, l.failed_n, l.created, u.name AS by_name, v.name AS partner FROM catalog_log l LEFT JOIN users u ON u.id=l.user_id LEFT JOIN vendors v ON v.id=l.vendor_id ${scope.vendor ? 'WHERE l.vendor_id=?' : ''} ORDER BY l.id DESC LIMIT 60`, ...(scope.vendor ? [scope.vendor.id] : []));
}

/* ---------- export ---------- */
const EXPORT_MAX = 20000;
async function exportRows(scope, q = {}) {
  const where = [], args = [];
  if (scope.vendor) { where.push('p.vendor_id=?'); args.push(scope.vendor.id); }
  else if (q.partner === 'ours') where.push('p.vendor_id IS NULL');
  else if (/^\d+$/.test(String(q.partner || ''))) { where.push('p.vendor_id=?'); args.push(Number(q.partner)); }
  if (q.status === 'active') where.push('p.active=1'); else if (q.status === 'inactive') where.push('p.active=0');
  if (q.missing_images === '1') where.push("(p.images = '[]' OR p.images = '')");
  if (q.low_stock === '1') where.push('p.min_stock > 0 AND p.stock <= p.min_stock');
  if (/^\d+$/.test(String(q.category || ''))) { where.push('p.category_id=?'); args.push(Number(q.category)); }
  if (q.brand) { where.push('lower(p.brand)=?'); args.push(String(q.brand).toLowerCase().slice(0, 60)); }
  if (q.store && /^[a-z0-9-]{1,40}$/.test(String(q.store))) { where.push('p.store=?'); args.push(q.store); }
  if (q.ids) { const ids = String(q.ids).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5000); if (!ids.length) fail(400, 'No products were selected.'); where.push('p.id = ANY(?)'); args.push(ids); }
  const rows = await all(`SELECT p.*, c.name AS category_name, st.name AS store_name, v.name AS partner_name FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN stores st ON st.slug=p.store LEFT JOIN vendors v ON v.id=p.vendor_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id LIMIT ${EXPORT_MAX + 1}`, ...args);
  if (rows.length > EXPORT_MAX) fail(400, `That is more than ${EXPORT_MAX.toLocaleString('en-NG')} products. Narrow it down with a filter.`);
  const F = fieldsFor(scope);
  const head = ['ID', ...F.map((f) => f.label), 'Photos', ...(scope.vendor ? ['Review Status'] : ['Review Status']), 'Created'];
  const get1 = {
    name: (p) => p.name, sku: (p) => p.sku, barcode: (p) => p.barcode, department: (p) => p.store_name || p.store, category: (p) => p.category_name || '', subcategory: (p) => p.subcategory, brand: (p) => p.brand,
    description: (p) => p.description, cost_price: (p) => p.cost_price, price: (p) => p.price, wholesale_price: (p) => (p.wholesale_price == null ? '' : p.wholesale_price), wholesale_min_qty: (p) => (p.wholesale_price == null ? '' : p.wholesale_min_qty),
    stock: (p) => p.stock, min_stock: (p) => p.min_stock, unit: (p) => p.unit, status: (p) => (p.active ? 'Active' : 'Inactive'), tax: (p) => p.tax, weight: (p) => Number(p.weight_kg) || '', partner: (p) => p.partner_name || '',
  };
  const data = rows.map((p) => [Number(p.id), ...F.map((f) => { const x = get1[f.key](p); return typeof x === 'number' || x === '' ? x : String(x == null ? '' : x); }), S.parseImages(p.images).length, p.vendor_id ? p.listing : 'n/a', new Date(Number(p.created) * 1000).toISOString().slice(0, 10)]);
  return { head, data, count: rows.length };
}
const exportFile = (r, format) => (format === 'csv' ? X.writeCsv([r.head, ...r.data]) : X.writeXlsx([{ name: 'Products', rows: [r.head, ...r.data], widths: r.head.map((h) => (h === 'Product Name' || h === 'Description' ? 40 : Math.max(12, h.length + 3))) }]));

module.exports = { FIELDS, fieldsFor, autoMap, reference, template, check, apply, logRun, history, exportRows, exportFile, MAX_ROWS_PER_CALL };
