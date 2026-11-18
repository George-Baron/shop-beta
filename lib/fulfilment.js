'use strict';
// Wholesale order documents and warehouse fulfilment.
//  * When a quote is PAID it becomes an order: it gets an order number (ORD-2026-000001) and a final invoice (INV-2026-000001),
//    both issued in the same transaction as the payment, so a paid quote always has them and numbers are never skipped or reused.
//  * The invoice is a frozen copy (wholesale_invoices.snapshot). It is never edited.
//  * The warehouse then works the order: to_pick -> picking -> picked -> packed -> dispatched -> delivered.
//    Shipping is refused until the order is packed, and every step records who did it and when.
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const WH = require('./warehouse');
const { fail, str, int } = S;

const STAGES = ['to_pick', 'picking', 'picked', 'packed', 'dispatched', 'delivered'];
const STAGE_LABEL = { to_pick: 'Waiting to be picked', picking: 'Being picked', picked: 'Picked: ready to pack', packed: 'Packed: ready to dispatch', dispatched: 'On its way', delivered: 'Delivered' };
const W = () => require('./wholesale');
const fevent = (fid, stage, note, by) => run('INSERT INTO wholesale_fulfilment_events (fulfilment_id,stage,note,by,created) VALUES (?,?,?,?,?)', fid, stage, str(note, 400), str(by, 80), now());

/* ---------- order number + final invoice ---------- */
async function snapshotOf(q, orderNo, invoiceNo, issuedAt) {
  const set = await S.getSettings();
  const a = await get('SELECT * FROM wholesale_accounts WHERE id=?', q.account_id);
  const items = await all('SELECT i.name, i.qty, i.list_price, i.unit_price, p.sku FROM wholesale_quote_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.quote_id=? ORDER BY i.id', q.id);
  return {
    invoice_no: invoiceNo, order_no: orderNo, quote_ref: q.ref, issued: issuedAt,
    seller: { name: set.store_name || 'VELTO-MART', address: set.address || '', email: set.contact_email || '', phone: set.contact_phone || '' },
    buyer: { business: a.business_name, contact: a.contact_name, phone: a.phone, email: a.email, address: [a.address, a.city, a.state].filter(Boolean).join(', '), reg_no: a.reg_no || '' },
    deliver_to: { name: q.ship_name, phone: q.ship_phone, address: [q.ship_address, q.ship_city, q.ship_state].filter(Boolean).join(', ') },
    lines: items.map((i) => ({ name: i.name, sku: i.sku || '', qty: Number(i.qty), unit_price: Number(i.unit_price), line_total: Number(i.unit_price) * Number(i.qty) })),
    goods_total: Number(q.goods_total), logistics_fee: Number(q.logistics_fee), service_pct: Number(q.service_pct), service_fee: Number(q.service_fee), total: Number(q.total),
    payment: { method: q.payment_method, ref: q.payment_ref, paid_at: q.paid_at == null ? issuedAt : Number(q.paid_at), status: 'PAID' },
  };
}
/**
 * Issue the order number, the final invoice and the fulfilment record for a paid quote. Call inside the transaction that marked it paid.
 * Safe to call again (does nothing if the quote already has an order number). `stage` is only used when catching up old orders.
 */
async function issueDocs(qid, by, stage = 'to_pick') {
  let q = await get('SELECT * FROM wholesale_quotes WHERE id=? FOR UPDATE', qid);
  if (q.order_no) return { order_no: q.order_no, invoice_no: q.invoice_no };
  if (!['paid', 'shipped', 'delivered'].includes(q.status)) fail(409, 'Only a paid quote becomes an order.');
  const orderNo = await WH.nextRef('ORD', 'ORD'), invoiceNo = await WH.nextRef('INV', 'INV'), at = now();
  q = { ...q, order_no: orderNo, invoice_no: invoiceNo };
  const snap = await snapshotOf(q, orderNo, invoiceNo, at);
  await run('UPDATE wholesale_quotes SET order_no=?, invoice_no=? WHERE id=?', orderNo, invoiceNo, qid);
  await run('INSERT INTO wholesale_invoices (invoice_no, quote_id, order_no, account_id, snapshot, total, issued, issued_by) VALUES (?,?,?,?,?,?,?,?)', invoiceNo, qid, orderNo, q.account_id, JSON.stringify(snap), q.total, at, str(by, 80));
  const wh = await WH.mainWarehouseId();
  const f = Number((await run('INSERT INTO wholesale_fulfilments (quote_id, warehouse_id, stage, created, updated) VALUES (?,?,?,?,?)', qid, wh, 'to_pick', at, at)).lastInsertRowid);
  const items = await all('SELECT i.product_id, i.name, i.qty, p.sku FROM wholesale_quote_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.quote_id=? ORDER BY i.id', qid);
  const caughtUp = stage !== 'to_pick';
  for (const i of items) await run('INSERT INTO wholesale_pick_lines (fulfilment_id, product_id, name, sku, qty, qty_picked) VALUES (?,?,?,?,?,?)', f, i.product_id, i.name, i.sku || '', i.qty, caughtUp ? i.qty : 0);
  if (caughtUp) await run('UPDATE wholesale_fulfilments SET stage=?, dispatched_at=?, delivered_at=? WHERE id=?', stage, q.shipped_at || at, stage === 'delivered' ? (q.delivered_at || at) : null, f);
  await fevent(f, caughtUp ? stage : 'to_pick', caughtUp ? 'Order created from an earlier shipment' : `Order ${orderNo} created from paid quotation ${q.ref}`, by || 'system');
  return { order_no: orderNo, invoice_no: invoiceNo, fulfilment_id: f };
}
// Orders paid before this feature existed get their numbers the first time they are looked at.
async function ensureDocs(q) {
  if (!q || q.order_no || !['paid', 'shipped', 'delivered'].includes(q.status)) return q;
  await tx(async () => { await issueDocs(q.id, 'system', q.status === 'paid' ? 'to_pick' : q.status === 'shipped' ? 'dispatched' : 'delivered'); });
  return get('SELECT * FROM wholesale_quotes WHERE id=?', q.id);
}

async function invoiceFor(q) {
  q = await ensureDocs(q);
  const inv = q && q.invoice_no ? await get('SELECT snapshot FROM wholesale_invoices WHERE quote_id=?', q.id) : null;
  return inv ? JSON.parse(inv.snapshot) : null;
}

/* ---------- fulfilment ---------- */
async function row(ref) {
  const q = await get('SELECT * FROM wholesale_quotes WHERE ref=?', str(ref, 20).toUpperCase());
  if (!q || !['paid', 'shipped', 'delivered'].includes(q.status)) fail(404, 'Order not found.');
  await ensureDocs(q);
  return q;
}
const forQuote = (qid) => get('SELECT * FROM wholesale_fulfilments WHERE quote_id=?', qid);
// Lock the order and check it is at the expected stage; every change goes through here so two people cannot move one order at once.
async function locked(ref, expect, msg) {
  const q = await row(ref);
  const f = await get('SELECT * FROM wholesale_fulfilments WHERE quote_id=? FOR UPDATE', q.id);
  const cur = await get('SELECT status FROM wholesale_quotes WHERE id=?', q.id);
  if (cur.status === 'cancelled') fail(409, 'This order was cancelled.');
  if (!f || !expect.includes(f.stage)) fail(409, msg + ` (it is now: ${STAGE_LABEL[f ? f.stage : 'to_pick']}).`);
  return { q, f };
}
const setStage = (fid, stage, sets = '', ...vals) => run(`UPDATE wholesale_fulfilments SET stage=?, updated=?${sets} WHERE id=?`, stage, now(), ...vals, fid);

async function list(q = {}) {
  const stages = q.stage && STAGES.includes(q.stage) ? [q.stage] : (q.stage === 'open' || !q.stage ? ['to_pick', 'picking', 'picked', 'packed', 'dispatched'] : STAGES);
  // catch up any old paid order that has no number yet, so it appears in the list
  for (const old of await all("SELECT * FROM wholesale_quotes WHERE order_no IS NULL AND status IN ('paid','shipped','delivered') LIMIT 50")) await ensureDocs(old);
  const where = ['f.stage = ANY(?::text[])', "q.status IN ('paid','shipped','delivered')"], args = [stages];
  const s = str(q.q, 60).toLowerCase(); if (s) { where.push("(lower(q.order_no) LIKE ? OR lower(q.ref) LIKE ? OR lower(a.business_name) LIKE ?)"); const l = '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; args.push(l, l, l); }
  const rows = await all(`SELECT q.ref, q.order_no, q.invoice_no, q.total, q.paid_at, q.ship_state, q.ship_city, a.business_name, f.stage, f.packages, f.picker, f.packer, f.updated, f.dispatched_at, f.delivered_at,
      (SELECT COUNT(*) FROM wholesale_pick_lines l WHERE l.fulfilment_id=f.id) AS lines, (SELECT COALESCE(SUM(l.qty),0) FROM wholesale_pick_lines l WHERE l.fulfilment_id=f.id) AS units
    FROM wholesale_fulfilments f JOIN wholesale_quotes q ON q.id=f.quote_id JOIN wholesale_accounts a ON a.id=q.account_id WHERE ${where.join(' AND ')} ORDER BY q.paid_at ASC LIMIT 300`, ...args);
  const counts = await all("SELECT f.stage, COUNT(*) AS n FROM wholesale_fulfilments f JOIN wholesale_quotes q ON q.id=f.quote_id WHERE q.status IN ('paid','shipped','delivered') GROUP BY f.stage");
  return { orders: rows.map((r) => ({ ...r, total: Number(r.total), paid_at: r.paid_at && Number(r.paid_at), lines: Number(r.lines), units: Number(r.units), packages: Number(r.packages), stage_label: STAGE_LABEL[r.stage], updated: Number(r.updated) })), counts: Object.fromEntries(counts.map((c) => [c.stage, Number(c.n)])) };
}
async function detail(ref) {
  const q = await row(ref), f = await forQuote(q.id);
  const a = await get('SELECT business_name, contact_name, phone, email FROM wholesale_accounts WHERE id=?', q.account_id);
  const lines = await all('SELECT id, product_id, name, sku, qty, qty_picked, short_note FROM wholesale_pick_lines WHERE fulfilment_id=? ORDER BY id', f.id);
  const events = await all('SELECT stage, note, by, created FROM wholesale_fulfilment_events WHERE fulfilment_id=? ORDER BY id', f.id);
  return {
    ref: q.ref, order_no: q.order_no, invoice_no: q.invoice_no, status: q.status, total: Number(q.total), paid_at: q.paid_at && Number(q.paid_at),
    buyer: a, ship: { name: q.ship_name, phone: q.ship_phone, address: [q.ship_address, q.ship_city, q.ship_state].filter(Boolean).join(', ') }, shipment_plan: q.shipment_plan,
    stage: f.stage, stage_label: STAGE_LABEL[f.stage], picker: f.picker, packer: f.packer, packages: Number(f.packages), package_note: f.package_note,
    carrier: q.carrier, tracking: q.tracking, driver_name: f.driver_name, driver_phone: f.driver_phone, vehicle_no: f.vehicle_no, expected_note: f.expected_note,
    dispatched_at: f.dispatched_at && Number(f.dispatched_at), received_by: f.received_by, delivery_note: f.delivery_note, delivered_at: f.delivered_at && Number(f.delivered_at), failed_attempts: Number(f.failed_attempts),
    lines: lines.map((l) => ({ ...l, id: Number(l.id), product_id: Number(l.product_id), qty: Number(l.qty), qty_picked: Number(l.qty_picked) })),
    events: events.map((e) => ({ ...e, created: Number(e.created) })),
  };
}

async function startPicking(ref, by) {
  await tx(async () => { const { f } = await locked(ref, ['to_pick'], 'Picking can only start on a new order'); await setStage(f.id, 'picking', ', picker=?, picking_started=?', str(by, 80), now()); await fevent(f.id, 'picking', 'Picking started', by); });
}
// Save how many of each line have been taken off the shelf (can be done in several goes). Nothing is moved in stock yet: stock is deducted when the order is dispatched.
async function savePick(ref, lines, by) {
  if (!Array.isArray(lines) || !lines.length) fail(400, 'Nothing to save.');
  await tx(async () => {
    const { f } = await locked(ref, ['picking'], 'Quantities can only be saved while the order is being picked');
    for (const l of lines) {
      const row_ = await get('SELECT * FROM wholesale_pick_lines WHERE id=? AND fulfilment_id=?', int(l.id), f.id);
      if (!row_) fail(400, 'One of the lines is not part of this order.');
      const n = int(l.qty_picked); if (!Number.isInteger(n) || n < 0 || n > Number(row_.qty)) fail(400, `${row_.name}: picked quantity must be from 0 to ${row_.qty}.`);
      await run('UPDATE wholesale_pick_lines SET qty_picked=?, short_note=? WHERE id=?', n, n < Number(row_.qty) ? str(l.short_note, 200) : '', row_.id);
    }
    await run('UPDATE wholesale_fulfilments SET updated=? WHERE id=?', now(), f.id);
  });
}
async function finishPicking(ref, by) {
  await tx(async () => {
    const { q, f } = await locked(ref, ['picking'], 'Only an order being picked can be marked picked');
    const short = await all('SELECT name, qty, qty_picked FROM wholesale_pick_lines WHERE fulfilment_id=? AND qty_picked<qty ORDER BY id', f.id);
    if (short.length) fail(409, 'Not everything is picked yet: ' + short.map((s) => `${s.name} (${s.qty_picked} of ${s.qty})`).join(', ') + '. If goods are missing, tell the manager: the stock count or the order needs fixing first.');
    await setStage(f.id, 'picked', ', picked_at=?', now()); await fevent(f.id, 'picked', 'All lines picked', by);
  });
}
async function pack(ref, b, by) {
  const n = int(b.packages);
  if (!Number.isInteger(n) || n < 1 || n > 10000) fail(400, 'Enter how many packages (cartons, bags, pallets) were made.');
  await tx(async () => {
    const { f } = await locked(ref, ['picked'], 'Only a picked order can be packed');
    await setStage(f.id, 'packed', ', packer=?, packed_at=?, packages=?, package_note=?', str(by, 80), now(), n, str(b.note, 300)); await fevent(f.id, 'packed', `${n} package${n === 1 ? '' : 's'}${b.note ? ': ' + str(b.note, 300) : ''}`, by);
  });
}
// Step back one stage when something was done by mistake (not allowed once dispatched).
async function undo(ref, by) {
  await tx(async () => {
    const { f } = await locked(ref, ['picked', 'packed'], 'Only a picked or packed order can be taken back a step');
    const to = f.stage === 'packed' ? 'picked' : 'picking';
    await setStage(f.id, to, f.stage === 'packed' ? ', packed_at=NULL, packages=0' : ', picked_at=NULL'); await fevent(f.id, to, `Taken back from ${f.stage}`, by);
  });
}

/* hooks called by lib/wholesale.js inside its own transactions */
async function requirePacked(qid) {
  const f = await get('SELECT * FROM wholesale_fulfilments WHERE quote_id=? FOR UPDATE', qid);
  if (!f) fail(409, 'This order has not been set up for the warehouse yet. Open it under Warehouse > Orders.');
  if (f.stage !== 'packed') fail(409, `Pick and pack the order before dispatching it (it is now: ${STAGE_LABEL[f.stage]}).`);
  return f;
}
async function markDispatched(f, b, by) {
  await setStage(f.id, 'dispatched', ', driver_name=?, driver_phone=?, vehicle_no=?, expected_note=?, dispatched_by=?, dispatched_at=?', str(b.driver_name, 80), str(b.driver_phone, 30), str(b.vehicle_no, 30), str(b.expected_note, 200), str(by, 80), now());
  await fevent(f.id, 'dispatched', `Dispatched with ${str(b.carrier, 80)}${b.driver_name ? ', driver ' + str(b.driver_name, 80) : ''}${b.vehicle_no ? ', vehicle ' + str(b.vehicle_no, 30) : ''}`, by);
}
async function markDelivered(qid, b, by) {
  const receivedBy = str(b.received_by, 80);
  if (!receivedBy) fail(400, 'Enter the name of the person who received the goods.');
  const f = await get('SELECT * FROM wholesale_fulfilments WHERE quote_id=? FOR UPDATE', qid);
  if (!f || f.stage !== 'dispatched') fail(409, 'Only a dispatched order can be marked delivered.');
  await setStage(f.id, 'delivered', ', received_by=?, delivery_note=?, delivered_by=?, delivered_at=?', receivedBy, str(b.note, 300), str(by, 80), now());
  await fevent(f.id, 'delivered', `Received by ${receivedBy}${b.note ? ': ' + str(b.note, 300) : ''}`, by);
}
async function deliveryFailed(ref, reason, by) {
  const why = str(reason, 300); if (!why) fail(400, 'Write why the delivery did not happen (nobody to receive, wrong address, road closed...).');
  const q = await row(ref); let acct;
  await tx(async () => {
    const f = await get('SELECT * FROM wholesale_fulfilments WHERE quote_id=? FOR UPDATE', q.id);
    if (!f || f.stage !== 'dispatched') fail(409, 'Only a dispatched order can have a failed delivery.');
    await run('UPDATE wholesale_fulfilments SET failed_attempts=failed_attempts+1, updated=? WHERE id=?', now(), f.id);
    await fevent(f.id, 'dispatched', 'Delivery attempt failed: ' + why, by);
    await run('INSERT INTO wholesale_events (quote_id,status,note,by,created) VALUES (?,?,?,?,?)', q.id, 'shipped', 'A delivery attempt did not succeed: ' + why + '. We will contact you to arrange another.', str(by, 80), now());
    acct = q.account_id;
  });
  await require('./notify').toAccount(acct, { type: 'order', title: `Delivery attempt for ${q.order_no} did not succeed`, body: why + '. We will contact you.', link: '/wholesale/quote/' + q.ref, email: true });
}

module.exports = { STAGES, STAGE_LABEL, issueDocs, ensureDocs, invoiceFor, forQuote, list, detail, startPicking, savePick, finishPicking, pack, undo, requirePacked, markDispatched, markDelivered, deliveryFailed };
