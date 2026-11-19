'use strict';
// Product reading/saving and photo upload, shared by the admin and partner (vendor) routes.
const crypto = require('crypto');
const { get, all, run } = require('./db');
const storage = require('./storage');
const S = require('./shop');
const PC = require('./pharmacy-core');
const { slugify } = require('./seed');
const { fail, str, int, parseImages } = S;

const okImage = (u) => typeof u === 'string' && u.length <= 500 && (storage.isOwnUrl(u) || /^\/uploads\/[a-f0-9]{16,}\.(png|jpg|webp|gif)$/.test(u) || /^https:\/\/[^\s"'<>]+$/.test(u));
async function readProduct(b) {
  const name = str(b.name, 140);
  if (!name) fail(400, 'Please enter a product name.');
  const store = str(b.store, 40);
  if (!(await get('SELECT 1 x FROM stores WHERE slug=?', store))) fail(400, 'Please choose a department.');
  if (PC.storeHidden(store)) fail(400, 'The pharmacy department is switched off. Medicines cannot be listed until it is enabled.');
  let category_id = b.category_id ? int(b.category_id) : null;
  if (category_id && !(await get('SELECT 1 x FROM categories WHERE id=? AND store=?', category_id, store))) category_id = null;
  const price = int(b.price, -1);
  if (price < 0 || b.price === '' || b.price == null) fail(400, 'Please enter a price.');
  let compare = Math.max(0, int(b.compare_price));
  if (compare <= price) compare = 0;
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 8);
  if (images.some((u) => !okImage(u))) fail(400, 'One of the photo links is not allowed. Use an upload or an https link.');
  const variants = (Array.isArray(b.variants) ? b.variants : []).slice(0, 80).map((v) => ({ id: int(v && v.id) || null, size: str(v && v.size, 30), color: str(v && v.color, 30), stock: Math.max(0, int(v && v.stock)) }));
  if (variants.some((v) => !v.size && !v.color)) fail(400, 'Each variant needs a size or a colour. Remove the empty rows.');
  // optional extra fields: only changed when the form sends them, so older callers never blank them
  const x = {}, has = (k) => b[k] !== undefined;
  const money = (k, label) => { const v = b[k]; if (v === '' || v === null) return null; const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100000000 || !Number.isInteger(n)) fail(400, label + ' must be a whole number of naira, 0 or more.'); return n; };
  if (has('barcode')) {
    x.barcode = str(b.barcode, 40);
    if (x.barcode && !/^[A-Za-z0-9._\-\/ ]+$/.test(x.barcode)) fail(400, 'Barcode can only contain letters, numbers and - . _ /');
    if (x.barcode) { const t = await get('SELECT id, name FROM products WHERE barcode=?', x.barcode); if (t && Number(t.id) !== Number(b.id || 0)) fail(409, `Barcode "${x.barcode}" already belongs to "${t.name}".`); }
  }
  if (has('subcategory')) x.subcategory = str(b.subcategory, 60);
  if (has('cost_price')) x.cost_price = money('cost_price', 'Cost price');
  if (has('min_stock')) x.min_stock = Math.max(0, Math.min(10000000, int(b.min_stock)));
  if (has('unit')) x.unit = str(b.unit, 20);
  if (has('tax_pct')) { const t = b.tax_pct === '' || b.tax_pct === null ? 0 : Number(b.tax_pct); if (!Number.isFinite(t) || t < 0 || t > 100) fail(400, 'Tax must be between 0 and 100.'); x.tax_pct = t; }
  if (has('weight_kg')) { const w = b.weight_kg === '' || b.weight_kg === null ? null : Number(b.weight_kg); if (w !== null && (!Number.isFinite(w) || w < 0 || w > 100000)) fail(400, 'Weight must be 0 or more.'); x.weight_kg = w; }
  return {
    ext: x, name, store, category_id, price, compare, brand: str(b.brand, 60), description: str(b.description, 4000), sku: str(b.sku, 40), emoji: str(b.emoji, 8) || '📦',
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
const MAGIC = [
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];

// Checks image bytes (by file signature, never by name) and stores them. Returns the public URL.
async function storeImage(buf, { max = 2_000_000 } = {}) {
  if (buf.length > max) fail(400, `That image is over ${Math.round(max / 1_000_000)} MB.`);
  const kind = MAGIC.find((k) => k.test(buf));
  if (!kind) fail(400, 'That file is not a valid image.');
  const name = crypto.randomBytes(12).toString('hex') + '.' + kind.ext;
  try { return await storage.put(buf, name, kind.mime); }
  catch (e) { if (e && e.storage) fail(502, e.message); throw e; }
}
// Validates a base64 image from the browser and stores it. Returns the public URL.
async function putImage(dataUrl) {
  const m = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) fail(400, 'Please choose a PNG, JPG, WEBP or GIF image.');
  return storeImage(Buffer.from(m[1], 'base64'));
}
module.exports = { okImage, readProduct, saveVariants, uniqueSlug, putImage, storeImage };
