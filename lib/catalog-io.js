'use strict';
// Bulk product import and export (Excel .xlsx and CSV).
//   template()                 -> the Shop-Beta Excel template
//   parseFile(buf, filename)   -> { headers, rows, mapping }   (reads .xlsx or .csv, nothing is saved)
//   validate(rows, mode)       -> one result per row: ok / warn / error, with every problem listed (nothing is saved)
//   commit(rows, mode, ...)    -> saves the rows that are valid, in chunks, and records the result in catalog_imports
//   exportBuffer(filters, fmt) -> the catalogue as .xlsx or .csv
// Photos are never needed: an imported product shows the department emoji placeholder until a photo is uploaded on its edit page.
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const PC = require('./pharmacy-core');
const { slugify } = require('./seed');
const { fail } = S;

const MAX_ROWS = 20000, MAX_MONEY = 100000000, MAX_QTY = 10000000;

// key = internal name, header = column title in the template, aliases = other titles we recognise when mapping automatically.
const FIELDS = [
  { key: 'name', header: 'Product Name', need: 'create', width: 34, help: 'Product title shown to customers (max 140 characters).', aliases: ['name', 'title', 'product', 'item', 'itemname', 'productname'] },
  { key: 'sku', header: 'Internal Reference', need: 'match', width: 18, help: 'Your unique product code (SKU). Used to find the product when updating. Max 40 characters.', aliases: ['sku', 'reference', 'ref', 'code', 'productcode', 'internalref', 'internalreference', 'itemcode'] },
  { key: 'barcode', header: 'Barcode', need: 'match', width: 18, help: 'Product barcode (EAN/UPC). Must be different for every product.', aliases: ['barcode', 'ean', 'upc', 'gtin'] },
  { key: 'department', header: 'Department', width: 16, help: 'Fashion, Supermarket, Beauty, Electronics or Food & Kitchen (see the Departments sheet). Needed only if the category name exists in more than one department.', aliases: ['department', 'store', 'shop', 'section'] },
  { key: 'category', header: 'Category', need: 'create', width: 20, help: 'Must match a category in the Departments sheet.', aliases: ['category', 'cat', 'productcategory'] },
  { key: 'subcategory', header: 'Subcategory', width: 20, help: 'Optional sub-group, free text.', aliases: ['subcategory', 'subcat', 'subgroup'] },
  { key: 'brand', header: 'Brand', width: 18, help: 'Manufacturer or brand name.', aliases: ['brand', 'manufacturer', 'maker'] },
  { key: 'description', header: 'Description', width: 40, help: 'Product description (max 4000 characters).', aliases: ['description', 'details', 'desc'] },
  { key: 'cost_price', header: 'Cost Price', width: 12, help: 'What you pay for it, in Naira. Never shown to customers.', aliases: ['costprice', 'cost', 'purchaseprice', 'buyingprice'] },
  { key: 'price', header: 'Selling Price', need: 'create', width: 14, help: 'Retail price in Naira (whole number).', aliases: ['sellingprice', 'price', 'retailprice', 'saleprice', 'unitprice'] },
  { key: 'wholesale_price', header: 'Wholesale Price', width: 15, help: 'Price for approved wholesale buyers. Must not be higher than the selling price. Leave blank for none.', aliases: ['wholesaleprice', 'wholesale', 'bulkprice', 'tradeprice'] },
  { key: 'stock', header: 'Quantity', width: 11, help: 'Stock on hand now (whole number, 0 or more).', aliases: ['quantity', 'qty', 'stock', 'openingstock', 'onhand', 'stockonhand'] },
  { key: 'min_stock', header: 'Minimum Stock', width: 14, help: 'Reorder alert level (whole number).', aliases: ['minimumstock', 'minstock', 'reorderlevel', 'reorderpoint', 'minqty'] },
  { key: 'unit', header: 'Unit of Measure', width: 15, help: 'For example pcs, kg, carton, bottle.', aliases: ['unitofmeasure', 'unit', 'uom', 'measure'] },
  { key: 'status', header: 'Product Status', width: 14, help: 'Active (shown in the shop) or Inactive (hidden). Blank means Active for new products.', aliases: ['productstatus', 'status', 'active', 'state'] },
  { key: 'tax', header: 'Tax', width: 8, help: 'Tax percent, for example 7.5. Leave blank for none.', aliases: ['tax', 'vat', 'taxrate', 'taxpercent'] },
  { key: 'weight', header: 'Weight', width: 10, help: 'Weight in kg, for example 0.5.', aliases: ['weight', 'weightkg', 'kg'] },
  { key: 'partner', header: 'Partner', width: 20, help: 'Pickup point or partner shop where this product is collected. Must match a name in the Partners sheet. Blank = Shop-Beta main store.', aliases: ['partner', 'pickuppoint', 'partnerstore', 'vendor', 'supplier'] },
];
const KEYS = FIELDS.map((f) => f.key);
// A partner store never sets wholesale prices (wholesale is sold from our own stock) or a pickup point (theirs is fixed).
// An Excel file is a zip. Our biggest legitimate import (20,000 rows) expands to well under this; anything larger is refused unread.
const MAX_UNZIPPED = 40 * 1024 * 1024;
const PARTNER_HIDDEN = ['wholesale_price', 'partner'];
const fieldsFor = (scope) => (scope ? FIELDS.filter((f) => !PARTNER_HIDDEN.includes(f.key)) : FIELDS);
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const text = (v) => (v == null ? '' : String(v).trim());

/* ---------------- template ---------------- */
async function lookups(scope) {
  let stores = await all('SELECT slug, name FROM stores ORDER BY sort, slug');
  if (scope) { const mine = new Set((await all('SELECT store FROM vendor_departments WHERE vendor_id=?', scope.id)).map((r) => r.store)); stores = stores.filter((x) => mine.has(x.slug)); }
  const cats = await all('SELECT c.id, c.store, c.name, c.icon FROM categories c ORDER BY c.store, c.sort, c.id');
  const partners = scope ? [] : await all('SELECT id, name FROM partners WHERE active=1 ORDER BY name');
  return { stores: stores.filter((s) => s.slug !== PC.PHARMACY_STORE && !PC.storeHidden(s.slug)), cats, partners };
}
async function template(scope) {
  const { stores, cats: allCats, partners } = await lookups(scope);
  const cats = scope ? allCats.filter((c) => stores.some((x) => x.slug === c.store)) : allCats;
  const FIELDS = fieldsFor(scope);
  const wb = new ExcelJS.Workbook(); wb.creator = 'Shop-Beta';
  const ws = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = FIELDS.map((f) => ({ header: f.header, key: f.key, width: f.width }));
  const head = ws.getRow(1); head.font = { bold: true, color: { argb: 'FFFFFFFF' } }; head.height = 22;
  FIELDS.forEach((f, i) => { const c = head.getCell(i + 1); c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: f.need === 'create' ? 'FFE8730C' : 'FF1F5C3A' } }; c.alignment = { vertical: 'middle' }; });
  const col = (k) => FIELDS.findIndex((f) => f.key === k) + 1;
  for (let r = 2; r <= 1001; r++) {
    ws.getCell(r, col('status')).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Active,Inactive"'] };
    ws.getCell(r, col('department')).dataValidation = { type: 'list', allowBlank: true, formulae: ['"' + stores.map((s) => s.name).join(',').replace(/"/g, '') + '"'] };
  }
  const ins = wb.addWorksheet('Instructions', { properties: { tabColor: { argb: 'FFE8730C' } } });
  ins.columns = [{ width: 24 }, { width: 14 }, { width: 100 }];
  ins.addRow(['Shop-Beta product import template']).font = { bold: true, size: 14 };
  ins.addRow([]);
  [
    'Fill in the "Products" sheet, one product per row, starting on row 2. Do not rename or delete the header row, and do not add new sheets before it.',
    'Orange headers are needed to create a new product. Green headers are optional.',
    'To change products that already exist, use "Update existing products" on the Import page: rows are matched by Internal Reference or Barcode, and only the columns you fill in are changed.',
    'Photos are not part of this file. Upload them later on each product\'s edit page. Products without a photo show a placeholder.',
    'You can import .xlsx or .csv. Up to ' + MAX_ROWS.toLocaleString('en') + ' rows in one file. You will see a preview and can fix problems before anything is saved.',
    'The "Example" sheet shows two filled-in rows. It is never imported.',
  ].forEach((t) => ins.addRow(['', '', t]).getCell(3).alignment = { wrapText: true });
  ins.addRow([]);
  const h = ins.addRow(['Column', 'Needed for', 'What to enter']); h.font = { bold: true };
  FIELDS.forEach((f) => ins.addRow([f.header, f.need === 'create' ? 'New products' : f.need === 'match' ? 'Updating (one of the two)' : 'Optional', f.help]).getCell(3).alignment = { wrapText: true });
  const ex = wb.addWorksheet('Example');
  ex.columns = FIELDS.map((f) => ({ header: f.header, key: f.key, width: f.width }));
  ex.getRow(1).font = { bold: true };
  const c0 = cats[0] || { name: 'Category', store: stores[0] ? stores[0].slug : '' }, d0 = stores.find((s) => s.slug === c0.store) || { name: '' };
  ex.addRow({ name: 'Sample Product One', sku: 'SKU-0001', barcode: '6001234567890', department: d0.name, category: c0.name, subcategory: 'Everyday', brand: 'Sample Brand', description: 'Short description of the product.', cost_price: 1200, price: 1800, wholesale_price: 1500, stock: 50, min_stock: 10, unit: 'pcs', status: 'Active', tax: 7.5, weight: 0.5, partner: '' });
  ex.addRow({ name: 'Sample Product Two', sku: 'SKU-0002', department: d0.name, category: c0.name, price: 2500, stock: 20, status: 'Inactive' });
  const ds = wb.addWorksheet('Departments');
  ds.columns = [{ header: 'Department', width: 22 }, { header: 'Category', width: 30 }]; ds.getRow(1).font = { bold: true };
  for (const c of cats) { const s = stores.find((x) => x.slug === c.store); if (s) ds.addRow([s.name, c.name]); }
  if (!scope) {
    const ps = wb.addWorksheet('Partners');
    ps.columns = [{ header: 'Partner (pickup point) names', width: 40 }]; ps.getRow(1).font = { bold: true };
    partners.forEach((p) => ps.addRow([p.name]));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ---------------- reading a file ---------------- */
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return cellText(v.result);          // a formula: use its value
    if ('text' in v) return cellText(v.text);              // a link
    if ('error' in v) return '';
    return '';
  }
  return String(v).trim();
}
async function parseFile(buf, filename, scope) {
  const name = String(filename || '').toLowerCase();
  const isCsv = name.endsWith('.csv') || name.endsWith('.txt');
  if (!isCsv && !name.endsWith('.xlsx')) fail(400, 'Please upload an .xlsx or .csv file.');
  if (!isCsv) { try { require('./xlsx').assertZipSafe(buf, MAX_UNZIPPED); } catch (e) { fail(400, e.message); } }   // refuse zip bombs before expanding anything
  const wb = new ExcelJS.Workbook();
  let ws;
  try {
    if (isCsv) {
      let t = buf.toString('utf8').replace(/^﻿/, '');
      const first = t.split(/\r?\n/, 1)[0] || '';
      const delimiter = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
      ws = await wb.csv.read(Readable.from([t]), { parserOptions: { delimiter } });
    } else {
      await wb.xlsx.load(buf);
      ws = wb.getWorksheet('Products') || wb.worksheets.find((w) => !['Instructions', 'Example', 'Departments', 'Partners'].includes(w.name));
    }
  } catch (e) { fail(400, 'We could not read that file. Make sure it is a real ' + (isCsv ? 'CSV' : 'Excel (.xlsx)') + ' file and not password protected.'); }
  if (!ws || ws.rowCount < 1) fail(400, 'The file has no data. Use the Shop-Beta template and fill in the "Products" sheet.');
  const width = Math.min(ws.columnCount, 60);
  const headers = [];
  for (let c = 1; c <= width; c++) headers.push(cellText(ws.getRow(1).getCell(c).value));
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  if (!headers.some(Boolean)) fail(400, 'The first row must contain column titles. Use the Shop-Beta template.');
  const seen = new Map();
  const uniq = headers.map((h, i) => { let t = h || 'Column ' + (i + 1); const k = t.toLowerCase(); const n = (seen.get(k) || 0) + 1; seen.set(k, n); return n > 1 ? `${t} (${n})` : t; });
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r), o = { __line: r }; let any = false;
    uniq.forEach((h, i) => { const t = cellText(row.getCell(i + 1).value); if (t) any = true; o[h] = t; });
    if (!any) continue;
    rows.push(o);
    if (rows.length > MAX_ROWS) fail(400, `This file has more than ${MAX_ROWS.toLocaleString('en')} products. Split it into smaller files.`);
  }
  if (!rows.length) fail(400, 'The file has a header row but no products.');
  return { headers: uniq, rows, mapping: suggestMapping(uniq, scope), sheet: ws.name };
}
function suggestMapping(headers, scope) {
  const mapping = {}, used = new Set();
  for (const f of fieldsFor(scope)) {
    const wanted = [norm(f.header), ...f.aliases];
    const h = headers.find((x) => !used.has(x) && wanted.includes(norm(x)));
    mapping[f.key] = h || ''; if (h) used.add(h);
  }
  return mapping;
}

/* ---------------- validation ---------------- */
const num = (s) => Number(String(s).replace(/^(?:₦|ngn|n(?=\s*\d))\s*/i, '').replace(/[,\s]/g, ''));
function whole(raw, label, max, out, { money = false } = {}) {
  const s = text(raw); if (s === '') return undefined;
  const n = num(s);
  if (!Number.isFinite(n)) { out.errors.push(`${label}: "${s}" is not a number.`); return undefined; }
  if (n < 0) { out.errors.push(`${label}: cannot be negative.`); return undefined; }
  if (n > max) { out.errors.push(`${label}: ${n.toLocaleString('en')} is too large (maximum ${max.toLocaleString('en')}).`); return undefined; }
  if (!Number.isInteger(n)) {
    if (!money) { out.errors.push(`${label}: must be a whole number (got ${s}).`); return undefined; }
    out.warnings.push(`${label}: ${s} was rounded to ${Math.round(n)}.`);
  }
  return Math.round(n);
}
const limit = (raw, label, max, out) => { const s = text(raw); if (s.length > max) { out.errors.push(`${label}: too long (${s.length} characters, maximum ${max}).`); return s.slice(0, max); } return s; };

async function validateCore(rows, mode, scope) {
  if (!['create', 'update'].includes(mode)) fail(400, 'Choose an import mode.');
  if (!Array.isArray(rows) || !rows.length) fail(400, 'There are no rows to check.');
  if (rows.length > MAX_ROWS) fail(400, 'Too many rows.');
  const { stores, cats: allCats, partners } = await lookups(scope);
  const cats = scope ? allCats.filter((c) => stores.some((x) => x.slug === c.store)) : allCats;
  const storeBy = new Map(); stores.forEach((s) => { storeBy.set(norm(s.slug), s.slug); storeBy.set(norm(s.name), s.slug); });
  const catsByName = new Map(); cats.forEach((c) => { const k = norm(c.name); if (!catsByName.has(k)) catsByName.set(k, []); catsByName.get(k).push(c); });
  const partnerBy = new Map(partners.map((p) => [norm(p.name), p]));
  const skus = [...new Set(rows.map((r) => text(r.sku)).filter(Boolean))], codes = [...new Set(rows.map((r) => text(r.barcode)).filter(Boolean))];
  const names = [...new Set(rows.map((r) => text(r.name).toLowerCase()).filter(Boolean))];
  const dbBySku = new Map(), dbByCode = new Map(), dbByName = new Set();
  if (skus.length || codes.length) {
    for (const p of await all('SELECT id, name, sku, barcode, store, vendor_id FROM products WHERE (sku <> \'\' AND sku = ANY(?)) OR (barcode <> \'\' AND barcode = ANY(?))', skus, codes)) {
      // a partner only ever sees its own references; a barcode is unique across the whole shop
      if (p.sku && (!scope || Number(p.vendor_id) === Number(scope.id))) { if (!dbBySku.has(p.sku)) dbBySku.set(p.sku, []); dbBySku.get(p.sku).push(p); }
      if (p.barcode) dbByCode.set(p.barcode, p);
    }
  }
  if (mode === 'create' && names.length) for (const p of await all(`SELECT LOWER(name) n, LOWER(brand) b, store FROM products WHERE LOWER(name) = ANY(?)${scope ? ' AND vendor_id=' + Number(scope.id) : ''}`, names)) dbByName.add(p.n + '|' + p.b + '|' + p.store);
  // duplicates inside the file itself
  const inFile = { sku: new Map(), barcode: new Map(), name: new Map() };
  rows.forEach((r) => {
    const l = r.line;
    for (const [k, v] of [['sku', text(r.sku)], ['barcode', text(r.barcode)]]) if (v) { const m = inFile[k]; if (!m.has(v)) m.set(v, []); m.get(v).push(l); }
    const nm = text(r.name).toLowerCase(); if (nm) { const k = nm + '|' + text(r.brand).toLowerCase() + '|' + text(r.department || r.category).toLowerCase(); if (!inFile.name.has(k)) inFile.name.set(k, []); inFile.name.get(k).push(l); }
  });
  const results = [];
  for (const r0 of rows) {
    const r = scope ? { ...r0, wholesale_price: '', partner: '' } : r0;
    const out = { line: r.line, name: text(r.name), sku: text(r.sku), errors: [], warnings: [], action: mode, matchId: null, changes: [], data: {} };
    const d = out.data;
    d.name = limit(r.name, 'Product Name', 140, out); d.sku = limit(r.sku, 'Internal Reference', 40, out);
    d.barcode = limit(r.barcode, 'Barcode', 64, out);
    if (d.barcode && !/^[A-Za-z0-9._-]+$/.test(d.barcode)) out.errors.push('Barcode: use letters, numbers, dot, dash or underscore only (no spaces).');
    d.brand = limit(r.brand, 'Brand', 60, out); d.description = limit(r.description, 'Description', 4000, out);
    d.subcategory = limit(r.subcategory, 'Subcategory', 60, out); d.unit = limit(r.unit, 'Unit of Measure', 20, out);
    d.cost_price = whole(r.cost_price, 'Cost Price', MAX_MONEY, out, { money: true });
    d.price = whole(r.price, 'Selling Price', MAX_MONEY, out, { money: true });
    d.wholesale_price = whole(r.wholesale_price, 'Wholesale Price', MAX_MONEY, out, { money: true });
    d.stock = whole(r.stock, 'Quantity', MAX_QTY, out); d.min_stock = whole(r.min_stock, 'Minimum Stock', MAX_QTY, out);
    if (d.wholesale_price === 0) { out.errors.push('Wholesale Price: must be more than 0 (leave blank for none).'); d.wholesale_price = undefined; }
    if (d.wholesale_price != null && d.price != null && d.wholesale_price > d.price) out.errors.push('Wholesale Price: cannot be higher than the Selling Price.');
    if (d.cost_price != null && d.price != null && d.cost_price > d.price) out.warnings.push('Cost Price is higher than the Selling Price (selling at a loss).');
    // tax and weight
    const tx_ = text(r.tax).replace('%', '');
    if (tx_ !== '') { const n = num(tx_); if (!Number.isFinite(n) || n < 0 || n > 100) out.errors.push(`Tax: "${text(r.tax)}" must be a percent between 0 and 100.`); else d.tax = Math.round(n * 100) / 100; }
    const wt = text(r.weight).toLowerCase();
    if (wt !== '') { const g = /g$/.test(wt) && !/kg$/.test(wt); const n = num(wt.replace(/kg$|g$/, '')); if (!Number.isFinite(n) || n < 0 || n > 100000) out.errors.push(`Weight: "${text(r.weight)}" is not a valid weight in kg.`); else d.weight = Math.round((g ? n / 1000 : n) * 1000) / 1000; }
    // status
    const st = text(r.status).toLowerCase();
    if (st !== '') { if (['active', 'yes', 'y', 'live', 'true', '1', 'enabled'].includes(st)) d.active = 1; else if (['inactive', 'no', 'n', 'hidden', 'false', '0', 'disabled', 'draft'].includes(st)) d.active = 0; else out.errors.push(`Product Status: "${text(r.status)}" must be Active or Inactive.`); }
    // department and category
    const dep = text(r.department), cat = text(r.category);
    let store = '';
    if (dep) { store = storeBy.get(norm(dep)) || ''; if (!store) out.errors.push(`Department: "${dep}" is not one of: ${stores.map((s) => s.name).join(', ')}.`); }
    if (cat) {
      const list = catsByName.get(norm(cat)) || [];
      const pick = store ? list.filter((c) => c.store === store) : list;
      if (!list.length) out.errors.push(`Category: "${cat}" does not exist. Add it under Departments first, or correct the name.`);
      else if (!pick.length) out.errors.push(`Category: "${cat}" is not in the ${dep} department.`);
      else if (pick.length > 1) out.errors.push(`Category: "${cat}" exists in several departments (${pick.map((c) => stores.find((s) => s.slug === c.store).name).join(', ')}). Fill in the Department column.`);
      else if (!stores.find((s) => s.slug === pick[0].store)) out.errors.push('Category: pharmacy products cannot be imported. Add medicines one by one.');
      else { d.category_id = pick[0].id; d.store = pick[0].store; d.icon = pick[0].icon; }
    } else if (store) d.store = store;
    const pn = text(r.partner);
    if (pn) { const p = partnerBy.get(norm(pn)); if (!p) out.errors.push(`Partner: "${pn}" is not an active pickup point. See the Partners sheet.`); else d.partner_id = p.id; }
    // duplicates inside the file
    for (const [k, label] of [['sku', 'Internal Reference'], ['barcode', 'Barcode']]) { const v = text(r[k]); const ls = v ? inFile[k].get(v) : null; if (ls && ls.length > 1) out.errors.push(`${label} "${v}" appears more than once in this file (lines ${ls.join(', ')}).`); }
    // matching against the catalogue
    if (mode === 'create') {
      if (!d.name) out.errors.push('Product Name is required.');
      if (d.price == null && !text(r.price)) out.errors.push('Selling Price is required.');
      if (!cat && !out.errors.some((e) => e.startsWith('Category'))) out.errors.push('Category is required.');
      if (d.sku && dbBySku.has(d.sku)) out.errors.push(`Internal Reference "${d.sku}" already exists (${dbBySku.get(d.sku)[0].name}). Use "Update existing products" to change it.`);
      if (d.barcode && dbByCode.has(d.barcode)) out.errors.push(scope && Number(dbByCode.get(d.barcode).vendor_id) !== Number(scope.id) ? `Barcode "${d.barcode}" is already used by another product.` : `Barcode "${d.barcode}" already belongs to "${dbByCode.get(d.barcode).name}".`);
      const nk = d.name.toLowerCase() + '|' + d.brand.toLowerCase() + '|' + (d.store || '');
      if (d.name && d.store && dbByName.has(nk)) out.warnings.push('A product with the same name and brand already exists in this department (possible duplicate).');
      const fk = d.name.toLowerCase() + '|' + text(r.brand).toLowerCase() + '|' + text(r.department || r.category).toLowerCase();
      const fl = inFile.name.get(fk); if (d.name && fl && fl.length > 1) out.warnings.push(`Same name and brand also on lines ${fl.filter((x) => x !== r.line).join(', ')} (possible duplicate).`);
      out.action = 'create';
    } else {
      let cur = null;
      if (!d.sku && !d.barcode) out.errors.push('To update a product, fill in its Internal Reference or Barcode.');
      else {
        const bySku = d.sku ? dbBySku.get(d.sku) || [] : [], byCode = d.barcode ? dbByCode.get(d.barcode) : null;
        if (bySku.length > 1) out.errors.push(`${bySku.length} products share the Internal Reference "${d.sku}". Match by Barcode instead.`);
        else if (bySku.length === 1 && byCode && byCode.id !== bySku[0].id) out.errors.push('The Internal Reference and the Barcode belong to two different products.');
        else cur = bySku[0] || (byCode && (!scope || Number(byCode.vendor_id) === Number(scope.id)) ? byCode : null);
        if (!cur && !out.errors.length) out.errors.push(`No existing product matches ${d.sku ? 'Internal Reference "' + d.sku + '"' : 'Barcode "' + d.barcode + '"'}. Nothing was changed. Use "Create new products" to add it.`);
        else if (cur && !out.errors.length) { out.matchId = Number(cur.id); out.name = out.name || cur.name; }
      }
      out.action = 'update';
    }
    if (out.errors.length) out.action = 'none';
    results.push(out);
  }
  if (mode === 'update') await diffUpdates(results, rows);
  const summary = { total: results.length, ok: results.filter((x) => !x.errors.length && !x.warnings.length).length, warn: results.filter((x) => !x.errors.length && x.warnings.length).length, error: results.filter((x) => x.errors.length).length, create: results.filter((x) => x.action === 'create').length, update: results.filter((x) => x.action === 'update' && x.changes.length).length, unchanged: results.filter((x) => x.action === 'update' && !x.changes.length && !x.errors.length).length };
  return { results, summary };
}
const publicResult = ({ line, name, sku, errors, warnings, action, matchId, changes }) => ({ line, name, sku, errors, warnings, action, matchId, changes });

async function validate(rows, mode, scope) { const v = await validateCore(rows, mode, scope); return { results: v.results.map(publicResult), summary: v.summary }; }

// UPDATE mode: work out exactly which fields would change, so nothing is overwritten without being shown first.
async function diffUpdates(results, rows) {
  const ids = [...new Set(results.map((x) => x.matchId).filter(Boolean))];
  if (!ids.length) return;
  const cur = new Map((await all('SELECT p.*, c.name AS category_name, pt.name AS partner_name, (SELECT COUNT(*) FROM variants v WHERE v.product_id=p.id) AS nvar FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN partners pt ON pt.id=p.partner_id WHERE p.id = ANY(?)', ids)).map((p) => [Number(p.id), p]));
  const rowBy = new Map(rows.map((r) => [r.line, r]));
  for (const out of results) {
    if (out.errors.length || !out.matchId) continue;
    const p = cur.get(out.matchId), d = out.data, raw = rowBy.get(out.line) || {};
    const ch = [];
    const set = (field, label, oldV, newV, col) => { if (newV === undefined) return; if (String(oldV == null ? '' : oldV) === String(newV)) return; ch.push({ field: col || field, label, from: oldV == null ? '' : oldV, to: newV }); };
    if (text(raw.name)) set('name', 'Product Name', p.name, d.name);
    if (text(raw.brand)) set('brand', 'Brand', p.brand, d.brand);
    if (text(raw.description)) set('description', 'Description', p.description, d.description);
    if (text(raw.subcategory)) set('subcategory', 'Subcategory', p.subcategory, d.subcategory);
    if (text(raw.unit)) set('unit', 'Unit of Measure', p.unit, d.unit);
    if (d.sku && d.sku !== p.sku) set('sku', 'Internal Reference', p.sku, d.sku);
    if (d.barcode && d.barcode !== p.barcode) {
      const taken = await get('SELECT id FROM products WHERE barcode=? AND id<>?', d.barcode, p.id);
      if (taken) out.errors.push(`Barcode "${d.barcode}" already belongs to another product.`); else set('barcode', 'Barcode', p.barcode, d.barcode);
    }
    if (d.category_id && Number(d.category_id) !== Number(p.category_id)) { set('category_id', 'Category', p.category_name || '', text(raw.category), 'category_id'); if (d.store !== p.store) set('store', 'Department', p.store, d.store); }
    set('cost_price', 'Cost Price', p.cost_price, d.cost_price); set('price', 'Selling Price', p.price, d.price);
    set('wholesale_price', 'Wholesale Price', p.wholesale_price, d.wholesale_price);
    if (d.stock !== undefined) { if (Number(p.nvar) > 0) out.warnings.push('Quantity was ignored: this product has size/colour variants, so its stock is set per variant.'); else set('stock', 'Quantity', p.stock, d.stock); }
    set('min_stock', 'Minimum Stock', p.min_stock, d.min_stock);
    if (d.active !== undefined) set('active', 'Product Status', p.active ? 'Active' : 'Inactive', d.active ? 'Active' : 'Inactive');
    if (d.tax !== undefined) set('tax_pct', 'Tax', Number(p.tax_pct), d.tax);
    if (d.weight !== undefined) set('weight_kg', 'Weight', p.weight_kg == null ? '' : Number(p.weight_kg), d.weight);
    if (text(raw.partner)) set('partner_id', 'Partner', p.partner_name || '', text(raw.partner));
    if (d.price != null && d.wholesale_price == null && p.wholesale_price != null && d.price < p.wholesale_price) out.errors.push(`Selling Price (${d.price}) would fall below the existing Wholesale Price (${p.wholesale_price}). Lower the wholesale price too.`);
    if (d.wholesale_price != null && d.price == null && d.wholesale_price > p.price) out.errors.push(`Wholesale Price (${d.wholesale_price}) is higher than the current Selling Price (${p.price}).`);
    if (p.is_pharmacy) out.errors.push('Medicines cannot be changed by import.');
    out.changes = ch;
    if (out.errors.length) out.action = 'none'; else if (!ch.length) { out.warnings.push('No changes: the file matches what is already saved.'); }
  }
}

/* ---------------- saving ---------------- */
const PRODUCT_COLS = { name: 'name', brand: 'brand', description: 'description', subcategory: 'subcategory', unit: 'unit', sku: 'sku', barcode: 'barcode', category_id: 'category_id', store: 'store', cost_price: 'cost_price', price: 'price', wholesale_price: 'wholesale_price', stock: 'stock', min_stock: 'min_stock', active: 'active', tax_pct: 'tax_pct', weight_kg: 'weight_kg', partner_id: 'partner_id' };
async function commit(rows, mode, meta, user, scope) {
  if (!Array.isArray(rows) || !rows.length) fail(400, 'There are no rows to import.');
  if (rows.length > 500) fail(400, 'Import in chunks of 500 rows or fewer.');
  let imp = meta.importId ? await get(`SELECT * FROM catalog_imports WHERE id=? AND kind='import'${scope ? ' AND vendor_id=' + Number(scope.id) : ''}`, Number(meta.importId)) : null;
  if (meta.importId && !imp) fail(404, 'That import was not found.');
  if (!imp) {
    const r = await run('INSERT INTO catalog_imports (kind,mode,filename,user_id,user_name,total,created,vendor_id) VALUES (?,?,?,?,?,?,?,?)', 'import', mode, String(meta.filename || '').slice(0, 200), user.id, String(user.name || user.email).slice(0, 80), Math.max(rows.length, Number(meta.total) || 0), now(), scope ? scope.id : null);
    imp = { id: Number(r.lastInsertRowid) };
  }
  const { results } = await validateCore(rows, mode, scope); // every row is checked again here: the browser's preview is never trusted
  let created = 0, updated = 0, failed = 0; const errs = [];
  for (const r of results) {
    if (r.errors.length) { failed++; errs.push({ line: r.line, name: r.name, sku: r.sku, problems: r.errors }); continue; }
    if (r.action === 'update' && !r.changes.length) continue;   // nothing to save, not a failure
    try {
      await tx(async () => { if (r.action === 'create') await insertProduct(r.data, scope); else await updateProduct(r, scope); });
      if (r.action === 'create') created++; else updated++;
    } catch (e) { failed++; errs.push({ line: r.line, name: r.name, sku: r.sku, problems: [e && /unique|duplicate/i.test(e.message) ? 'Another product with the same Barcode was saved at the same moment.' : 'Could not be saved: ' + String(e && e.message).slice(0, 160)] }); }
  }
  const cur = await get('SELECT errors FROM catalog_imports WHERE id=?', imp.id);
  let all_ = []; try { all_ = JSON.parse(cur.errors); } catch { /* fresh */ }
  all_ = all_.concat(errs).slice(0, 20000);
  await run('UPDATE catalog_imports SET created_n=created_n+?, updated_n=updated_n+?, failed_n=failed_n+?, errors=? WHERE id=?', created, updated, failed, JSON.stringify(all_), imp.id);
  return { importId: Number(imp.id), created, updated, failed, errors: errs };
}
async function insertProduct(d, scope) {
  const slug = await require('./catalog').uniqueSlug(d.name);
  const r = await run('INSERT INTO products (slug,store,category_id,name,brand,description,price,compare_price,stock,sku,emoji,images,size_label,featured,bestseller,new_arrival,active,created,barcode,subcategory,cost_price,min_stock,unit,tax_pct,weight_kg,wholesale_price,partner_id,vendor_id,listing) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,0,0,0,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    slug, d.store, d.category_id, d.name, d.brand || '', d.description || '', d.price, d.stock || 0, d.sku || '', d.icon || '📦', '[]', 'Size', d.active === undefined ? 1 : d.active, now(),
    d.barcode || '', d.subcategory || '', d.cost_price == null ? null : d.cost_price, d.min_stock || 0, d.unit || '', d.tax || 0, d.weight == null ? null : d.weight, scope ? null : (d.wholesale_price == null ? null : d.wholesale_price), scope ? (scope.partner_id || null) : (d.partner_id || null), scope ? scope.id : null, scope ? 'pending' : 'approved');   // a partner's product waits for our review
  return Number(r.lastInsertRowid);
}
async function updateProduct(r, scope) {
  const sets = [], args = [];
  for (const c of r.changes) {
    const col = PRODUCT_COLS[c.field]; if (!col) continue;
    let v = r.data[{ tax_pct: 'tax', weight_kg: 'weight' }[c.field] || c.field];
    if (c.field === 'category_id') v = r.data.category_id;
    sets.push(col + '=?'); args.push(v === undefined ? null : v);
  }
  if (!sets.length) return;
  args.push(r.matchId); if (scope) args.push(scope.id);
  await run(`UPDATE products SET ${sets.join(',')} WHERE id=?${scope ? ' AND vendor_id=?' : ''}`, ...args);
  // changing what a partner's product IS sends it back for our review (same rule as editing it by hand)
  if (scope && r.changes.some((c) => ['name', 'brand', 'description', 'category_id', 'store', 'subcategory'].includes(c.field))) await run("UPDATE products SET listing='pending', listing_note='' WHERE id=? AND vendor_id=? AND listing<>'pending'", r.matchId, scope.id);
}

/* ---------------- export ---------------- */
const FILTERS = ['all', 'selected', 'category', 'brand', 'partner', 'active', 'inactive', 'missing_images', 'low_stock'];
const LOW_STOCK_DEFAULT = 5; // same level the Products screen marks as low when no Minimum Stock is set
async function exportRows(f, scope) {
  const filter = FILTERS.includes(f.filter) ? f.filter : 'all';
  const where = ['p.is_pharmacy = 0'], args = [];
  if (scope) { where.push('p.vendor_id=?'); args.push(scope.id); }
  if (filter === 'selected') { const ids = (Array.isArray(f.ids) ? f.ids : []).map(Number).filter(Number.isInteger).slice(0, 5000); if (!ids.length) fail(400, 'Select at least one product to export.'); where.push('p.id = ANY(?)'); args.push(ids); }
  if (filter === 'category') { const id = Number(f.category); if (!Number.isInteger(id)) fail(400, 'Choose a category.'); where.push('p.category_id=?'); args.push(id); }
  if (filter === 'brand') { const b = text(f.brand); if (!b) fail(400, 'Choose a brand.'); where.push('LOWER(p.brand)=LOWER(?)'); args.push(b); }
  if (filter === 'partner') { if (f.partner === 'main' || f.partner === '0') where.push('p.partner_id IS NULL'); else { const id = Number(f.partner); if (!Number.isInteger(id)) fail(400, 'Choose a partner.'); where.push('p.partner_id=?'); args.push(id); } }
  if (filter === 'active') where.push('p.active=1');
  if (filter === 'inactive') where.push('p.active=0');
  if (filter === 'missing_images') where.push("(p.images IS NULL OR p.images IN ('', '[]'))");
  if (filter === 'low_stock') where.push(`((p.min_stock > 0 AND p.stock <= p.min_stock) OR (p.min_stock = 0 AND p.stock <= ${LOW_STOCK_DEFAULT}))`);
  return all(`SELECT p.*, c.name AS category_name, s.name AS store_name, pt.name AS partner_name FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN stores s ON s.slug=p.store LEFT JOIN partners pt ON pt.id=p.partner_id WHERE ${where.join(' AND ')} ORDER BY p.id LIMIT 100000`, ...args);
}
// A text cell that starts with = + - @ would be run as a formula by Excel. Prefixing it with ' keeps it plain text.
const safeText = (v) => { const t = v == null ? '' : String(v); return /^[=+\-@\t\r]/.test(t) ? "'" + t : t; };
async function exportBuffer(filters, fmt, scope) {
  const rows = await exportRows(filters || {}, scope);
  const cols = [...fieldsFor(scope).map((f) => ({ header: f.header, key: f.key, width: f.width })), { header: 'Product ID', key: 'id', width: 11 }, { header: 'Photos', key: 'photos', width: 8 }];
  const wb = new ExcelJS.Workbook(); wb.creator = 'Shop-Beta';
  const ws = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols;
  ws.getRow(1).font = { bold: true };
  for (const p of rows) {
    let nph = 0; try { nph = JSON.parse(p.images || '[]').length; } catch { /* none */ }
    ws.addRow({
      name: safeText(p.name), sku: safeText(p.sku), barcode: safeText(p.barcode), department: safeText(p.store_name), category: safeText(p.category_name), subcategory: safeText(p.subcategory), brand: safeText(p.brand),
      description: safeText(p.description), cost_price: p.cost_price, price: p.price, wholesale_price: p.wholesale_price, stock: p.stock, min_stock: p.min_stock, unit: safeText(p.unit),
      status: p.active ? 'Active' : 'Inactive', tax: Number(p.tax_pct) || null, weight: p.weight_kg == null ? null : Number(p.weight_kg), partner: safeText(p.partner_name), id: Number(p.id), photos: nph,
    });
  }
  if (fmt === 'csv') return { buffer: Buffer.concat([Buffer.from('﻿'), Buffer.from(await wb.csv.writeBuffer())]), count: rows.length, type: 'text/csv; charset=utf-8', ext: 'csv' };
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), count: rows.length, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
}
async function logExport(user, fmt, filters, count, scope) {
  await run('INSERT INTO catalog_imports (kind,mode,filename,user_id,user_name,total,detail,created,vendor_id) VALUES (?,?,?,?,?,?,?,?,?)', 'export', fmt, '', user.id, String(user.name || user.email).slice(0, 80), count, JSON.stringify(filters || {}).slice(0, 400), now(), scope ? scope.id : null);
}
async function history(scope) {
  return all(`SELECT id, kind, mode, filename, user_name, total, created_n, updated_n, failed_n, detail, created, (errors <> '[]') AS has_errors, vendor_id FROM catalog_imports ${scope ? 'WHERE vendor_id=' + Number(scope.id) : ''} ORDER BY id DESC LIMIT 100`);
}
// The downloadable error report for one import: one line per failed row, with every problem listed.
async function errorReportCsv(id, scope) {
  const r = await get(`SELECT errors FROM catalog_imports WHERE id=? AND kind='import'${scope ? ' AND vendor_id=' + Number(scope.id) : ''}`, Number(id));
  if (!r) fail(404, 'Import not found.');
  let list = []; try { list = JSON.parse(r.errors); } catch { /* empty */ }
  const q = (v) => '"' + safeText(v).replace(/"/g, '""') + '"';
  return '﻿' + ['Line in your file,Product Name,Internal Reference,What is wrong'].concat(list.map((e) => [e.line, q(e.name), q(e.sku), q((e.problems || []).join(' | '))].join(','))).join('\r\n') + '\r\n';
}

module.exports = { fieldsFor, exportBuffer, logExport, history, errorReportCsv, FILTERS, FIELDS, KEYS, MAX_ROWS, template, parseFile, suggestMapping, validate, commit, lookups, text };
