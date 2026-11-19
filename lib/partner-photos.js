'use strict';
// Bulk photos for a partner store. Each photo is named after the product it belongs to: the product reference (SKU) or barcode,
// for example RICE-001.jpg, and RICE-001_2.jpg or "RICE-001 (2).jpg" for more photos of the same product.
// A store can only attach photos to its own products. Photos are added to the product; nothing is removed or replaced.
const { get, all, run } = require('./db');
const S = require('./shop');
const CAT = require('./catalog');
const V = require('./vendors');
const { fail } = S;
const MAX_IMAGES = 8;

// "RICE-001_2.jpg" -> ["RICE-001_2", "RICE-001"] (the exact name is tried first, because a reference can end in a number)
function candidates(filename) {
  const stem = String(filename || '').replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{2,5}$/, '').trim();
  if (!stem || stem.length > 80) fail(400, 'This photo has no usable name. Name it after the product reference or barcode.');
  const out = [stem], m = /^(.*?)(?:[ _]+\(?\d{1,2}\)?)$/.exec(stem);
  if (m && m[1].trim()) out.push(m[1].trim());
  return out;
}
async function attach(user, filename, dataUrl) {
  const v = await V.mine(user);
  let p = null;
  for (const c of candidates(filename)) {
    const rows = await all('SELECT id, name, sku, images FROM products WHERE vendor_id=? AND (lower(sku)=lower(?) OR barcode=?) ORDER BY id LIMIT 3', v.id, c, c);
    if (rows.length > 1) fail(409, `More than one of your products uses "${c}". Make the references unique, or add this photo from the product page.`);
    if (rows.length) { p = rows[0]; break; }
  }
  if (!p) fail(404, `No product of yours has the reference or barcode "${candidates(filename)[0]}".`);
  const cur = S.parseImages(p.images);
  if (cur.length >= MAX_IMAGES) fail(400, `"${p.name}" already has ${MAX_IMAGES} photos, which is the most a product can have.`);
  const url = await CAT.putImage(dataUrl);
  const next = JSON.stringify([...cur, url]);
  const r = await run('UPDATE products SET images=? WHERE id=? AND vendor_id=? AND images=?', next, p.id, v.id, p.images);
  if (!r.changes) { // another photo landed at the same moment: read again and add ours
    const again = await get('SELECT images FROM products WHERE id=? AND vendor_id=?', p.id, v.id);
    const list = S.parseImages(again && again.images); if (list.length >= MAX_IMAGES) fail(400, `"${p.name}" already has ${MAX_IMAGES} photos.`);
    await run('UPDATE products SET images=? WHERE id=? AND vendor_id=?', JSON.stringify([...list, url]), p.id, v.id);
  }
  return { product_id: Number(p.id), product: p.name, sku: p.sku || '', url, count: cur.length + 1 };
}
module.exports = { attach, candidates, MAX_IMAGES };
