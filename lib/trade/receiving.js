'use strict';
// Receiving imported goods into stock and working out the final landed cost per product.
//  received  = units physically counted      damaged = part of received that cannot be sold      shortage = ordered - received (computed)
//  sellable  = received - damaged  (these go into stock)
// Landed cost (NGN) per item = its own purchase cost + its share of freight, insurance, duties, taxes, clearing, port, inland and other costs.
// Shares follow the basis staff choose (value, weight or quantity). The cost of damaged and missing units stays in the total, so it is carried by the units that were sold.
// Everything uses the exchange rate saved with the shipment. Posting happens once; a repeat is refused (and stock movements are idempotent).
const crypto = require('crypto');
const { get, all, run, tx, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const WH = require('../warehouse');
const CUS = require('./customs');
const { fail, int } = S;

const COST_KEYS = [['freight', 'freight'], ['insurance', 'insurance'], ['customs_duties', 'duties'], ['import_taxes', 'taxes'], ['clearing_fees', 'clearing'], ['port_charges', 'port'], ['inland_transport', 'inland'], ['other_charges', 'other']];
const BASES = ['value', 'weight', 'quantity'];

// Split `total` (NGN, 2 dp) over weights so the pieces add up to exactly the total (largest remainder).
function split(total, weights) {
  const cents = Math.round(total * 100), sum = weights.reduce((a, b) => a + b, 0); if (!weights.length) return [];
  if (!(sum > 0)) { const base = Math.floor(cents / weights.length); const out = weights.map(() => base); out[0] += cents - base * weights.length; return out.map((c) => c / 100); }
  const raw = weights.map((w) => cents * w / sum), fl = raw.map(Math.floor); let left = cents - fl.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - fl[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { fl[i]++; left--; } });
  return fl.map((c) => c / 100);
}
async function rateOf(h) {
  if (h.currency === 'NGN') return 1;
  if (h.fx_rate_to_ngn == null) fail(409, 'Enter the shipment costs first. The exchange rate is saved when the first cost is recorded.');
  return Number(h.fx_rate_to_ngn);
}
function cleanCounts(items, list) {
  if (!Array.isArray(list) || !list.length) fail(400, 'Enter what was received for every item.');
  const by = new Map(list.map((l) => [Number(l.id), l])), out = [];
  for (const it of items) {
    const l = by.get(Number(it.id)); if (!l) fail(400, `Enter the received count for "${it.description}".`);
    const rec = Number(l.qty_received), dmg = Number(l.qty_damaged || 0);
    if (!Number.isInteger(rec) || rec < 0) fail(400, `"${it.description}": received must be a whole number of 0 or more.`);
    if (!Number.isInteger(dmg) || dmg < 0) fail(400, `"${it.description}": damaged must be a whole number of 0 or more.`);
    if (rec > Number(it.qty_ordered)) fail(400, `"${it.description}": received (${rec}) is more than ordered (${it.qty_ordered}). Record any over-supply in the notes and receive up to the ordered amount.`);
    if (dmg > rec) fail(400, `"${it.description}": damaged (${dmg}) cannot be more than received (${rec}).`);
    out.push({ ...it, rec, dmg, sellable: rec - dmg, short: Number(it.qty_ordered) - rec });
  }
  return out;
}
// Pure calculation, shared by the preview and the posting.
async function compute(h, items, b) {
  const rate = await rateOf(h), counts = cleanCounts(items, b.items), bases = {};
  for (const [, ct] of COST_KEYS) { const v = (b.bases && b.bases[ct]) || b.basis || 'value'; if (!BASES.includes(v)) fail(400, 'Share costs by value, weight or quantity.'); bases[ct] = v; }
  if (Object.values(bases).includes('weight') && counts.some((c) => !(Number(c.weight_kg) > 0))) fail(400, 'Sharing by weight needs a weight on every item. Add the weights or share by value or quantity.');
  const dec = (x) => T.roundTo(x, 2), lines = counts.map((c) => ({ id: Number(c.id), description: c.description, product_id: c.product_id == null ? null : Number(c.product_id), qty_ordered: Number(c.qty_ordered), qty_received: c.rec, qty_damaged: c.dmg, qty_sellable: c.sellable, shortage: c.short, purchase_ngn: dec(Number(c.qty_ordered) * Number(c.unit_cost) * rate), shares: {} }));
  const wOf = { value: (c) => Number(c.qty_ordered) * Number(c.unit_cost), weight: (c) => Number(c.weight_kg) * Number(c.qty_ordered), quantity: (c) => Number(c.qty_ordered) };
  for (const [col, ct] of COST_KEYS) {
    const total = dec(Number(h[col]) * rate); if (!total) continue;
    split(total, counts.map(wOf[bases[ct]])).forEach((v, i) => { lines[i].shares[ct] = v; });
  }
  for (const l of lines) { l.extra_ngn = dec(Object.values(l.shares).reduce((a, b) => a + b, 0)); l.landed_ngn = dec(l.purchase_ngn + l.extra_ngn); l.unit_cost_ngn = l.qty_sellable > 0 ? T.roundTo(l.landed_ngn / l.qty_sellable, 4) : null; }
  const total = dec(lines.reduce((a, l) => a + l.landed_ngn, 0));
  return { rate_to_ngn: rate, bases, lines, total_ngn: total, check_ngn: dec(Number(h.landed_cost) * rate), unlinked: lines.filter((l) => l.qty_sellable > 0 && !l.product_id).map((l) => l.description) };
}
async function loadReady(ref) {
  const h = await get('SELECT * FROM import_shipments WHERE import_ref=?', String(ref || '').toUpperCase()); if (!h) fail(404, 'Import shipment not found.');
  return h;
}
async function preview(ref, b) {
  const h = await loadReady(ref), items = await all('SELECT * FROM import_shipment_items WHERE shipment_id=? ORDER BY id', h.id);
  const r = await compute(h, items, b || {});
  return { ...r, shipment_status: h.status, can_post: h.status === 'delivered_warehouse' && !Number(h.stock_posted) && !r.unlinked.length, blockers: [h.status !== 'delivered_warehouse' ? 'The shipment must be "delivered to warehouse" before stock is received.' : '', Number(h.stock_posted) ? 'Stock was already received.' : '', r.unlinked.length ? 'Link these items to products first: ' + r.unlinked.join(', ') : ''].filter(Boolean) };
}
async function receive(ref, b, user, ip) {
  const h = await loadReady(ref);
  if (Number(h.stock_posted)) fail(409, 'Stock for this shipment was already received. See the saved goods received note.');
  if (h.status !== 'delivered_warehouse') fail(409, 'Mark the shipment "delivered to warehouse" before receiving stock.');
  const to = String(b.to || ''); if (!['retail', 'warehouse'].includes(to)) fail(400, 'Choose where the stock goes: the retail store or the wholesale warehouse.');
  const items = await all('SELECT * FROM import_shipment_items WHERE shipment_id=? ORDER BY id', h.id), r = await compute(h, items, b);
  if (r.unlinked.length) fail(409, 'Link these items to products before receiving them: ' + r.unlinked.join(', '));
  const stock = r.lines.filter((l) => l.qty_sellable > 0);
  for (const l of stock) { const p = await get('SELECT vendor_id, is_pharmacy FROM products WHERE id=?', l.product_id); if (!p) fail(409, `"${l.description}" is linked to a product that no longer exists.`); if (p.vendor_id) fail(409, `"${l.description}" is a vendor product. Imported stock can only be added to our own products.`); }
  const runId = 'LC-' + crypto.randomBytes(5).toString('hex').toUpperCase(), key = 'imp-recv-' + h.id;
  let grn = h.grn_ref;
  if (to === 'warehouse' && stock.length) {   // idempotent by key: if a retry follows a failure below, the same receipt is returned and stock is not added twice
    const rc = await WH.receive(stock.map((l) => ({ productId: l.product_id, qty: l.qty_sellable })), { reference: h.import_ref, note: 'Import ' + h.import_ref, by: (user && (user.name || user.email)) || 'trade', userId: user ? user.id : null, key });
    grn = rc.grn;
  } else if (!grn) grn = 'GRN-' + h.import_ref;
  const t = now();
  await tx(async () => {
    const claim = await run("UPDATE import_shipments SET stock_posted=1, status='stock_received', grn_ref=?, landed_run_id=?, landed_total_ngn=?, received_at=?, updated=? WHERE id=? AND stock_posted=0 AND status='delivered_warehouse'", grn, runId, r.total_ngn, t, t, h.id);
    if (claim.changes !== 1) fail(409, 'This shipment was just received by someone else.');
    for (const l of r.lines) {
      await run('UPDATE import_shipment_items SET qty_received=?, qty_damaged=?, qty_sellable=?, landed_unit_cost_ngn=? WHERE id=?', l.qty_received, l.qty_damaged, l.qty_sellable, l.unit_cost_ngn, l.id);
      await run("INSERT INTO landed_cost_allocations (shipment_id,shipment_item_id,cost_type,basis,amount_ngn,fx_rate_to_ngn,run_id,created) VALUES (?,?,'purchase','direct',?,?,?,?)", h.id, l.id, l.purchase_ngn, r.rate_to_ngn, runId, t);
      for (const [ct, v] of Object.entries(l.shares)) await run('INSERT INTO landed_cost_allocations (shipment_id,shipment_item_id,cost_type,basis,amount_ngn,fx_rate_to_ngn,run_id,created) VALUES (?,?,?,?,?,?,?,?)', h.id, l.id, ct, r.bases[ct], v, r.rate_to_ngn, runId, t);
      if (l.qty_sellable > 0) {
        let prevQty;
        if (to === 'retail') { const p = await get('UPDATE products SET stock = stock + ? WHERE id=? RETURNING stock', l.qty_sellable, l.product_id); prevQty = Number(p.stock) - l.qty_sellable; }
        else { const m = await get("SELECT prev_on_hand FROM wholesale_stock_movements WHERE related_ref=? AND product_id=? AND type='receipt' ORDER BY id LIMIT 1", grn, l.product_id); prevQty = m ? Number(m.prev_on_hand) : 0; }
        // weighted-average valuation across what was already held and what just arrived
        const old = await get('SELECT avg_cost_ngn, qty_basis FROM trade_product_costs WHERE product_id=?', l.product_id), oq = Math.max(0, prevQty);
        const avg = old && oq > 0 ? T.roundTo((oq * Number(old.avg_cost_ngn) + l.qty_sellable * l.unit_cost_ngn) / (oq + l.qty_sellable), 4) : l.unit_cost_ngn;
        await run('INSERT INTO trade_product_costs (product_id,avg_cost_ngn,last_landed_ngn,qty_basis,last_shipment_id,updated) VALUES (?,?,?,?,?,?) ON CONFLICT (product_id) DO UPDATE SET avg_cost_ngn=EXCLUDED.avg_cost_ngn, last_landed_ngn=EXCLUDED.last_landed_ngn, qty_basis=EXCLUDED.qty_basis, last_shipment_id=EXCLUDED.last_shipment_id, updated=EXCLUDED.updated', l.product_id, avg, l.unit_cost_ngn, oq + l.qty_sellable, h.id, t);
      }
    }
    const short = r.lines.reduce((a, l) => a + l.shortage, 0), dmg = r.lines.reduce((a, l) => a + l.qty_damaged, 0);
    await run("INSERT INTO shipment_tracking_events (import_shipment_id,stage,description,location,occurred_at,source,event_hash,created_by,created) VALUES (?,?,?,?,?,'manual',?,?,?) ON CONFLICT (event_hash) DO NOTHING", h.id, 'delivered', `Stock received (${grn}): ${stock.reduce((a, l) => a + l.qty_sellable, 0)} units to stock, ${dmg} damaged, ${short} short.`, '', t, crypto.createHash('sha256').update('imp:' + h.id + ':received').digest('hex'), user ? user.id : null, t);
  });
  await T.audit(user, 'import.receive', 'import_shipments', h.import_ref, { grn, to, total_ngn: r.total_ngn, run: runId }, ip);
  let doc = null; try { doc = (await CUS.generate('goods_received_note', { import_ref: h.import_ref }, user, ip)).document; } catch (e) { console.error('[receive] GRN pdf:', e.message); }
  return { ok: true, grn, run_id: runId, total_ngn: r.total_ngn, lines: r.lines, document: doc };
}
async function landed(ref) {
  const h = await loadReady(ref), items = await all('SELECT i.*, p.sku FROM import_shipment_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.shipment_id=? ORDER BY i.id', h.id);
  const al = await all('SELECT * FROM landed_cost_allocations WHERE shipment_id=? AND run_id=? ORDER BY shipment_item_id, id', h.id, h.landed_run_id || '');
  return { posted: !!Number(h.stock_posted), grn: h.grn_ref, run_id: h.landed_run_id, total_ngn: h.landed_total_ngn == null ? null : Number(h.landed_total_ngn),
    items: items.map((i) => ({ id: Number(i.id), description: i.description, sku: i.sku || '', qty_ordered: Number(i.qty_ordered), qty_received: Number(i.qty_received), qty_damaged: Number(i.qty_damaged), qty_sellable: i.qty_sellable == null ? null : Number(i.qty_sellable), shortage: Math.max(0, Number(i.qty_ordered) - Number(i.qty_received)), landed_unit_cost_ngn: i.landed_unit_cost_ngn == null ? null : Number(i.landed_unit_cost_ngn),
      allocations: al.filter((a) => Number(a.shipment_item_id) === Number(i.id)).map((a) => ({ cost_type: a.cost_type, basis: a.basis, amount_ngn: Number(a.amount_ngn) })) })) };
}
// Landed cost and valuation per product across all received shipments (report).
async function valuation() {
  const rows = await all(`SELECT c.product_id, p.name, p.sku, p.stock, c.avg_cost_ngn, c.last_landed_ngn, c.updated, s.import_ref FROM trade_product_costs c JOIN products p ON p.id=c.product_id LEFT JOIN import_shipments s ON s.id=c.last_shipment_id ORDER BY c.updated DESC LIMIT 500`);
  return { products: rows.map((r) => ({ product_id: Number(r.product_id), name: r.name, sku: r.sku || '', retail_stock: Number(r.stock), avg_cost_ngn: Number(r.avg_cost_ngn), last_landed_ngn: Number(r.last_landed_ngn), last_import: r.import_ref || '', updated: Number(r.updated) })) };
}
async function updateItem(ref, itemId, b, user, ip) {
  const h = await loadReady(ref); if (Number(h.stock_posted) || ['stock_received', 'completed'].includes(h.status)) fail(409, 'This shipment is closed.');
  const it = await get('SELECT * FROM import_shipment_items WHERE id=? AND shipment_id=?', Number(itemId) || 0, h.id); if (!it) fail(404, 'Item not found.');
  const set = [], a = [], ch = {};
  if (b.product_id !== undefined) { const pid = b.product_id === '' || b.product_id === null ? null : Number(b.product_id); if (pid !== null) { const p = await get('SELECT id, vendor_id FROM products WHERE id=?', pid); if (!p) fail(404, 'Product not found.'); if (p.vendor_id) fail(409, 'Imported stock can only be added to our own products.'); } set.push('product_id=?'); a.push(pid); ch.product_id = pid; }
  if (b.weight_kg !== undefined) { const w = b.weight_kg === '' || b.weight_kg === null ? null : Number(b.weight_kg); if (w !== null && (!Number.isFinite(w) || w <= 0 || w > 100000)) fail(400, 'Weight per unit: enter a number above 0.'); set.push('weight_kg=?'); a.push(w); ch.weight_kg = w; }
  if (!set.length) return { ok: true };
  await run(`UPDATE import_shipment_items SET ${set.join(', ')} WHERE id=?`, ...a, it.id);
  await T.audit(user, 'import.item', 'import_shipments', h.import_ref, { item: Number(it.id), ...ch }, ip);
  return { ok: true };
}
module.exports = { updateItem, split, compute, preview, receive, landed, valuation };
