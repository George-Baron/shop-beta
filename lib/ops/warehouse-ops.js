'use strict';
// Warehouse checks and stock-transfer requests. READ-ONLY on stock: this module never writes a balance, a movement or a product quantity.
// A transfer is a REQUEST (ops_stock_transfers) that a person carries out with a real stock movement in the wholesale module and then marks done.
//   check()    stock records that do not add up, wholesale lines below reorder level, dead stock, damaged/expired, retail negative stock
//   suggest()  where one place is short and another has real surplus (wholesale<->wholesale, and wholesale->retail which always needs an explicit transfer)
//   plan()     split/multi-location advice for a wholesale quote
const { all, get, run, now } = require('../db');
const { fail, str, int } = require('../shop');
const St = require('./store');
const D = require('./data');
const FP = require('./fulfilment-plan');

const DEAD_DAYS = 90, OPEN_TRANSFER_HOURS = 48;
const n = (x) => Number(x) || 0;

async function check() {
  const out = { discrepancies: [], below_reorder: [], dead_stock: [], damaged: [], retail_negative: [] };
  // the balance must equal the result of the last movement; if not, stock changed outside the ledger
  for (const r of await all(`SELECT b.id, b.product_id, b.warehouse_id, b.on_hand, b.reserved, p.name, w.name warehouse, m.new_on_hand, m.new_reserved
      FROM wholesale_stock_balances b JOIN products p ON p.id=b.product_id JOIN wholesale_warehouses w ON w.id=b.warehouse_id
      JOIN LATERAL (SELECT new_on_hand, new_reserved FROM wholesale_stock_movements WHERE product_id=b.product_id AND warehouse_id=b.warehouse_id ORDER BY id DESC LIMIT 1) m ON TRUE
      WHERE m.new_on_hand<>b.on_hand OR m.new_reserved<>b.reserved LIMIT 100`))
    out.discrepancies.push({ product_id: n(r.product_id), product: r.name, warehouse_id: n(r.warehouse_id), warehouse: r.warehouse, balance_on_hand: n(r.on_hand), ledger_on_hand: n(r.new_on_hand), balance_reserved: n(r.reserved), ledger_reserved: n(r.new_reserved) });
  for (const r of await all(`SELECT b.product_id, b.warehouse_id, p.name, w.name warehouse, b.on_hand, b.reserved, b.reorder_level FROM wholesale_stock_balances b JOIN products p ON p.id=b.product_id JOIN wholesale_warehouses w ON w.id=b.warehouse_id WHERE b.reorder_level>0 AND b.on_hand-b.reserved<=b.reorder_level ORDER BY b.on_hand-b.reserved LIMIT 100`))
    out.below_reorder.push({ product_id: n(r.product_id), product: r.name, warehouse_id: n(r.warehouse_id), warehouse: r.warehouse, available: n(r.on_hand) - n(r.reserved), reorder_level: n(r.reorder_level) });
  for (const r of await all(`SELECT b.product_id, b.warehouse_id, p.name, w.name warehouse, b.on_hand FROM wholesale_stock_balances b JOIN products p ON p.id=b.product_id JOIN wholesale_warehouses w ON w.id=b.warehouse_id
      WHERE b.on_hand>0 AND NOT EXISTS (SELECT 1 FROM wholesale_stock_movements m WHERE m.product_id=b.product_id AND m.warehouse_id=b.warehouse_id AND m.created>? AND m.type IN ('dispatch','reserve','transfer_out','release')) ORDER BY b.on_hand DESC LIMIT 50`, now() - DEAD_DAYS * 86400))
    out.dead_stock.push({ product_id: n(r.product_id), product: r.name, warehouse: r.warehouse, on_hand: n(r.on_hand), days: DEAD_DAYS });
  for (const r of await all('SELECT b.product_id, p.name, w.name warehouse, b.damaged_qty, b.expired_qty FROM wholesale_stock_balances b JOIN products p ON p.id=b.product_id JOIN wholesale_warehouses w ON w.id=b.warehouse_id WHERE b.damaged_qty>0 OR b.expired_qty>0 ORDER BY b.damaged_qty+b.expired_qty DESC LIMIT 50'))
    out.damaged.push({ product_id: n(r.product_id), product: r.name, warehouse: r.warehouse, damaged: n(r.damaged_qty), expired: n(r.expired_qty) });
  for (const r of await all("SELECT id, name, stock FROM products WHERE stock<0 AND fulfilment='own' LIMIT 50")) out.retail_negative.push({ product_id: n(r.id), product: r.name, stock: n(r.stock) });
  out.note = 'Checks only. The AI changes no stock; corrections are made by people with a recorded movement.';
  return out;
}

// Surplus = available above twice the reorder level (never the last units). Shortage = at or under the reorder level.
async function suggest() {
  const wh = await all('SELECT b.product_id, b.warehouse_id, p.name, w.name warehouse, b.on_hand-b.reserved avail, b.reorder_level FROM wholesale_stock_balances b JOIN products p ON p.id=b.product_id JOIN wholesale_warehouses w ON w.id=b.warehouse_id');
  const by = new Map(); for (const r of wh) { const a = by.get(n(r.product_id)) || []; a.push({ ...r, avail: n(r.avail), reorder: n(r.reorder_level), pid: n(r.product_id), wid: n(r.warehouse_id) }); by.set(n(r.product_id), a); }
  const out = [], open = new Set((await all("SELECT product_id, kind, COALESCE(from_warehouse_id,0) f, COALESCE(to_warehouse_id,0) t FROM ops_stock_transfers WHERE status='requested'")).map((r) => `${r.product_id}|${r.kind}|${r.f}|${r.t}`));
  for (const [pid, rows] of by) {
    for (const short of rows.filter((r) => r.reorder > 0 && r.avail <= r.reorder)) {
      const give = rows.filter((r) => r.wid !== short.wid && r.reorder > 0 && r.avail > r.reorder * 2).sort((a, b) => b.avail - a.avail)[0]; if (!give) continue;
      const qty = Math.min(give.avail - give.reorder * 2, short.reorder * 2 - short.avail); if (qty <= 0) continue;
      out.push({ kind: 'wholesale_to_wholesale', product_id: pid, product: short.name, from_warehouse_id: give.wid, from: give.warehouse, to_warehouse_id: short.wid, to: short.warehouse, qty, already_requested: open.has(`${pid}|wholesale_to_wholesale|${give.wid}|${short.wid}`), why: `${short.warehouse} has ${short.avail} available (reorder level ${short.reorder}); ${give.warehouse} has ${give.avail}, well above its own level.` });
    }
  }
  // retail is short and the wholesale warehouse has real surplus: the two stocks are separate, so this is only ever a REQUEST for an explicit transfer
  const retail = await D.retailStock();
  for (const it of [...retail.critical_items, ...retail.reorder_candidates]) {
    const rows = by.get(it.id) || []; const give = rows.filter((r) => r.reorder > 0 ? r.avail > r.reorder * 2 : r.avail > 0).sort((a, b) => b.avail - a.avail)[0]; if (!give) continue;
    const spare = give.reorder > 0 ? give.avail - give.reorder * 2 : give.avail, want = Math.max(it.recommended_qty || 0, it.sold_30d > 0 ? Math.ceil(it.avg_daily_demand * 14) : 0); const qty = Math.min(spare, want); if (qty <= 0) continue;
    if (out.some((o) => o.kind === 'wholesale_to_retail' && o.product_id === it.id)) continue;
    out.push({ kind: 'wholesale_to_retail', product_id: it.id, product: it.name, from_warehouse_id: give.wid, from: give.warehouse, to_warehouse_id: null, to: 'Retail', qty, already_requested: open.has(`${it.id}|wholesale_to_retail|${give.wid}|0`), why: `Retail has ${it.stock} (${it.days_of_cover == null ? 'no recent sales' : it.days_of_cover + ' days of cover'}); the wholesale warehouse holds ${give.avail} with surplus. Needs an explicit, approved transfer: the stocks are separate.` });
  }
  return { suggestions: out, note: 'Suggestions only. A request is created through the gateway; a person moves the stock and records the movement.' };
}

// Creates the REQUEST. Called by the gateway handlers for stock.transfer_request (routine, wholesale to wholesale) and stock.transfer_special (anything touching retail).
async function requestTransfer(p, by) {
  const kind = ['wholesale_to_wholesale', 'wholesale_to_retail', 'retail_to_wholesale'].includes(p.kind) ? p.kind : fail(400, 'Unknown transfer kind.');
  const pid = int(p.product_id), qty = int(p.qty); if (!pid || qty <= 0) fail(400, 'Product and a positive quantity are needed.');
  const from = int(p.from_warehouse_id) || null, to = int(p.to_warehouse_id) || null;
  if (kind === 'wholesale_to_wholesale' && (!from || !to || from === to)) fail(400, 'Pick two different warehouses.');
  if (kind === 'wholesale_to_retail' && !from) fail(400, 'Say which warehouse the stock leaves.');
  if (kind === 'retail_to_wholesale' && !to) fail(400, 'Say which warehouse receives it.');
  if (from) { const b = await get('SELECT on_hand-reserved avail FROM wholesale_stock_balances WHERE product_id=? AND warehouse_id=?', pid, from); if (!b || n(b.avail) < qty) fail(409, `Only ${b ? n(b.avail) : 0} available at the source warehouse.`); }
  if (kind === 'retail_to_wholesale') { const r = await get('SELECT stock FROM products WHERE id=?', pid); if (!r || n(r.stock) < qty) fail(409, `Only ${r ? n(r.stock) : 0} in retail stock.`); }
  const dup = await get("SELECT ref FROM ops_stock_transfers WHERE status='requested' AND product_id=? AND kind=? AND COALESCE(from_warehouse_id,0)=? AND COALESCE(to_warehouse_id,0)=?", pid, kind, from || 0, to || 0); if (dup) return { ref: dup.ref, existing: true };
  const t = now(), r = await get("INSERT INTO ops_stock_transfers (kind,product_id,from_warehouse_id,to_warehouse_id,qty,reason,basis,requested_by_kind,requested_by,created,updated) VALUES (?,?,?,?,?,?,?::jsonb,?,?,?,?) RETURNING id, ref", kind, pid, from, to, qty, str(p.reason, 400), JSON.stringify(p.basis || {}), p.by_user ? 'user' : 'ai', str(by, 80), t, t);
  await St.createTask({ title: `Carry out stock transfer ${r.ref}`, detail: `Move ${qty} of product ${pid} (${kind.replace(/_/g, ' ')}) using a stock movement in the wholesale module, then mark ${r.ref} done with the movement reference. The AI has not moved any stock.`, department: 'warehouse', priority: 'normal', related_type: 'transfer', related_id: String(r.id) }, by);
  return { ref: r.ref, id: n(r.id), existing: false };
}
async function listTransfers(status) { const rows = await all(`SELECT t.*, p.name product, fw.name from_name, tw.name to_name FROM ops_stock_transfers t JOIN products p ON p.id=t.product_id LEFT JOIN wholesale_warehouses fw ON fw.id=t.from_warehouse_id LEFT JOIN wholesale_warehouses tw ON tw.id=t.to_warehouse_id ${status ? 'WHERE t.status=?' : ''} ORDER BY t.id DESC LIMIT 100`, ...(status ? [status] : [])); return rows.map((r) => ({ ...r, id: n(r.id) })); }
async function completeTransfer(user, id, b) {
  const t = await get('SELECT * FROM ops_stock_transfers WHERE id=?', int(id)); if (!t) fail(404, 'Transfer not found.'); if (t.status !== 'requested') fail(409, 'Already ' + t.status + '.');
  const to = ['done', 'rejected', 'cancelled'].includes(b.status) ? b.status : fail(400, 'Choose done, rejected or cancelled.');
  const mv = str(b.movement_ref, 60).trim();
  if (to === 'done') { if (!mv) fail(400, 'Enter the stock movement reference, so the transfer is traceable.'); if (t.from_warehouse_id) { const m = await get('SELECT id FROM wholesale_stock_movements WHERE ref=? AND product_id=?', mv, t.product_id); if (!m) fail(400, 'No wholesale stock movement with that reference for this product.'); } }
  await run('UPDATE ops_stock_transfers SET status=?, movement_ref=?, done_by=?, done_at=?, updated=? WHERE id=?', to, mv, user ? user.name || user.email : '', now(), now(), t.id);
  return get('SELECT * FROM ops_stock_transfers WHERE id=?', t.id);
}

async function planForQuote(quoteId) {
  const q = await get('SELECT id, ref, status FROM wholesale_quotes WHERE id=?', int(quoteId)); if (!q) fail(404, 'Wholesale order not found.');
  const lines = (await all('SELECT product_id, name, qty FROM wholesale_quote_items WHERE quote_id=?', q.id)).map((l) => ({ product_id: n(l.product_id), name: l.name, qty: n(l.qty) }));
  const bal = await all('SELECT b.warehouse_id, w.name, b.product_id, b.on_hand-b.reserved avail FROM wholesale_stock_balances b JOIN wholesale_warehouses w ON w.id=b.warehouse_id WHERE b.product_id = ANY(?::bigint[])', lines.map((l) => l.product_id));
  const whs = new Map(); for (const b of bal) { const w = whs.get(n(b.warehouse_id)) || { id: n(b.warehouse_id), name: b.name, available: {} }; w.available[n(b.product_id)] = n(b.avail); whs.set(n(b.warehouse_id), w); }
  // stock already held for THIS order counts as available to it
  for (const r of await all("SELECT warehouse_id, product_id, SUM(qty) q FROM wholesale_stock_reservations WHERE quote_id=? AND status='active' GROUP BY warehouse_id, product_id", q.id)) { const w = whs.get(n(r.warehouse_id)); if (w) w.available[n(r.product_id)] = (w.available[n(r.product_id)] || 0) + n(r.q); }
  return { order: q.ref, ...FP.plan(lines, [...whs.values()]), uses: 'wholesale stock only', note2: 'Advice only. Stock is reserved and dispatched in the wholesale module; moving stock between warehouses needs a transfer request.' };
}

async function watch(raise) {
  const c = await check();
  for (const d of c.discrepancies) await raise({ kind: 'stock_discrepancy', severity: 'high', dedupe_key: `stock_discrepancy:${d.product_id}:${d.warehouse_id}`, title: `${d.product} at ${d.warehouse}: the balance (${d.balance_on_hand}) does not match the stock ledger (${d.ledger_on_hand})`, detail: `Reserved ${d.balance_reserved} vs ledger ${d.ledger_reserved}.`, impact: 'Stock may have changed outside the ledger, so availability may be wrong.', recommended_action: 'Count the shelf and correct it with a recorded adjustment.', department: 'warehouse', related_type: 'product', related_id: String(d.product_id), auto: true });
  for (const r of c.retail_negative) await raise({ kind: 'stock_negative', severity: 'high', dedupe_key: 'stock_negative:' + r.product_id, title: `${r.product} has negative retail stock (${r.stock})`, detail: 'Retail stock should never be below zero.', impact: 'The product may be oversold.', recommended_action: 'Count it and correct the stock.', department: 'warehouse', related_type: 'product', related_id: String(r.product_id), auto: true });
  for (const t of await all("SELECT t.id, t.ref, t.created, p.name FROM ops_stock_transfers t JOIN products p ON p.id=t.product_id WHERE t.status='requested'")) { const h = (now() - n(t.created)) / 3600; if (h > OPEN_TRANSFER_HOURS) await raise({ kind: 'transfer_open', severity: 'medium', dedupe_key: 'transfer_open:' + t.id, title: `Transfer ${t.ref} (${t.name}) has waited ${Math.round(h)} h`, detail: 'Nobody has moved the stock or closed the request.', impact: 'The shortage it was meant to fix remains.', recommended_action: 'Carry it out in the wholesale module and mark it done, or reject it.', department: 'warehouse', related_type: 'transfer', related_id: String(t.id), auto: true }); }
}
module.exports = { DEAD_DAYS, check, suggest, requestTransfer, listTransfers, completeTransfer, planForQuote, watch };
