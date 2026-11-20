'use strict';
// Import procurement: purchase orders to international suppliers, and the import shipment that follows each approved order.
// Phase 4 covers ordering, shipment status, tracking notes and costs entered by staff. Receiving goods into stock and landed-cost
// allocation are in lib/trade/receiving.js: "stock received" is set by receiving, "completed" is a manual close.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const FX = require('./fx');
const SUP = require('./suppliers');
const { fail, str } = S;

const num = (v, label, o) => T.dec(v, label, { places: 4, ...o });
const date = (v, label) => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v))) fail(400, `${label}: use the form 2026-12-31.`); return String(v); };
const day = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- purchase orders ---------- */
const poShape = (r) => ({ id: Number(r.id), po_number: r.po_number, supplier_id: Number(r.supplier_id), supplier: r.supplier || undefined, destination_country: r.destination_country, currency: r.currency, incoterm: r.incoterm, status: r.status,
  expected_dispatch: day(r.expected_dispatch), expected_arrival: day(r.expected_arrival), total: Number(r.total), notes: r.notes, approved_at: r.approved_at == null ? null : Number(r.approved_at), created: Number(r.created), updated: Number(r.updated),
  shipment_ref: r.shipment_ref || undefined, shipment_status: r.shipment_status || undefined });
async function loadPO(id) { const r = await get('SELECT * FROM import_purchase_orders WHERE id=?', Number(id) || 0); if (!r) fail(404, 'Purchase order not found.'); return r; }

async function listPOs(q) {
  const { per, offset, page } = T.page(q, 25), w = [], a = [];
  if (q.status) { w.push('p.status=?'); a.push(String(q.status)); }
  if (q.supplier_id) { w.push('p.supplier_id=?'); a.push(Number(q.supplier_id) || 0); }
  if (q.q) { w.push('(p.po_number ILIKE ? OR s.name ILIKE ?)'); const l = `%${String(q.q).slice(0, 60)}%`; a.push(l, l); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const total = Number((await get(`SELECT COUNT(*) n FROM import_purchase_orders p JOIN international_suppliers s ON s.id=p.supplier_id ${where}`, ...a)).n);
  const rows = await all(`SELECT p.*, s.name supplier, h.import_ref shipment_ref, h.status shipment_status FROM import_purchase_orders p JOIN international_suppliers s ON s.id=p.supplier_id LEFT JOIN import_shipments h ON h.po_id=p.id ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`, ...a, per, offset);
  return { total, page, per, orders: rows.map(poShape) };
}
const itemShape = (r) => ({ id: Number(r.id), supplier_product_id: r.supplier_product_id == null ? null : Number(r.supplier_product_id), product_id: r.product_id == null ? null : Number(r.product_id), description: r.description, hs_code: r.hs_code, qty: Number(r.qty), unit_cost: Number(r.unit_cost), line_total: T.roundTo(Number(r.qty) * Number(r.unit_cost), 4) });
async function getPO(id) {
  const po = await loadPO(id);
  const [sup, items, sh, docs, pays] = await Promise.all([SUP.load(po.supplier_id), all('SELECT * FROM import_purchase_order_items WHERE po_id=? ORDER BY id', po.id), get('SELECT import_ref, status FROM import_shipments WHERE po_id=?', po.id), SUP.documents({ po_id: po.id }), all('SELECT * FROM supplier_payments WHERE po_id=? ORDER BY paid_on DESC, id DESC', po.id)]);
  const paid = pays.reduce((a, p) => a + Number(p.amount), 0);
  return { order: { ...poShape({ ...po, supplier: sup.name, shipment_ref: sh && sh.import_ref, shipment_status: sh && sh.status }), supplier_email: sup.email, paid: T.roundTo(paid, 4), balance: po.status === 'approved' ? T.roundTo(Number(po.total) - paid, 4) : 0 },
    items: items.map(itemShape), documents: docs, editable: ['draft', 'quotation_requested'].includes(po.status) };
}

// Turns what the form sent into verified item rows. Catalogue lines must belong to this supplier, be in the order's currency and meet the minimum order quantity.
async function buildItems(list, supplier, currency) {
  if (!Array.isArray(list) || !list.length) fail(400, 'Add at least one product to the order.');
  if (list.length > 200) fail(400, 'An order can have at most 200 lines.');
  const out = [];
  for (const [i, it] of list.entries()) {
    const n = `Line ${i + 1}`, qty = num(it.qty, `${n}: quantity`, { min: 1, max: 1e7, places: 0 }); if (!qty) fail(400, `${n}: enter a quantity.`);
    let desc = str(it.description, 300), hs = T.hsClean(it.hs_code), cost = it.unit_cost === '' || it.unit_cost == null ? null : num(it.unit_cost, `${n}: unit cost`, { min: 0 }), spId = null, productId = null;
    if (it.supplier_product_id) {
      const sp = await get('SELECT * FROM supplier_products WHERE id=? AND supplier_id=?', Number(it.supplier_product_id) || 0, supplier.id);
      if (!sp) fail(400, `${n}: that catalogue item does not belong to ${supplier.name}.`);
      if (!Number(sp.active)) fail(400, `${n}: "${sp.name}" is switched off in the catalogue.`);
      if (sp.currency !== currency) fail(400, `${n}: "${sp.name}" is priced in ${sp.currency}, but this order is in ${currency}.`);
      if (qty < Number(sp.moq)) fail(400, `${n}: "${sp.name}" has a minimum order of ${sp.moq}.`);
      spId = Number(sp.id); productId = sp.product_id == null ? null : Number(sp.product_id); desc = desc || sp.name; hs = hs || sp.hs_code; if (cost == null) cost = Number(sp.unit_cost);
    } else if (it.product_id) { const p = await get('SELECT id, name FROM products WHERE id=?', Number(it.product_id) || 0); if (!p) fail(400, `${n}: product not found.`); productId = Number(p.id); desc = desc || p.name; }
    if (!desc) fail(400, `${n}: describe the product.`);
    if (cost == null) fail(400, `${n}: enter the unit cost.`);
    if (hs && !T.HS_OK.test(hs)) fail(400, `${n}: HS code looks wrong.`);
    out.push({ spId, productId, desc, hs, qty, cost });
  }
  return out;
}
async function savePO(id, b, user, ip) {
  const cur0 = id ? await loadPO(id) : null;
  if (cur0 && !['draft', 'quotation_requested'].includes(cur0.status)) {
    if (cur0.status === 'approved') { // after approval only dates and notes may change
      await run('UPDATE import_purchase_orders SET expected_dispatch=?, expected_arrival=?, notes=?, updated=? WHERE id=?', date(b.expected_dispatch, 'Expected dispatch'), date(b.expected_arrival, 'Expected arrival'), str(b.notes, 2000), now(), cur0.id);
      await T.audit(user, 'po.update_dates', 'import_purchase_orders', cur0.id, {}, ip); return getPO(cur0.id);
    }
    fail(409, 'A cancelled purchase order cannot be changed.');
  }
  const sup = await SUP.load(cur0 ? cur0.supplier_id : b.supplier_id);
  if (sup.status === 'blocked') fail(409, 'This supplier is blocked. Orders cannot be created for it.');
  const dest = String(b.destination_country || 'NG').toUpperCase(), dc = await get('SELECT * FROM trade_countries WHERE code=?', dest);
  if (!dc) fail(400, 'Choose the destination country.'); if (!Number(dc.import_to)) fail(400, `Importing into ${dc.name} is not switched on in Countries.`);
  const sc = await get('SELECT * FROM trade_countries WHERE code=?', sup.country_code); if (!Number(sc.import_from)) fail(400, `Buying from suppliers in ${sc.name} is not switched on in Countries.`);
  const currency = String(b.currency || sup.currency).toUpperCase(); if (!(await get('SELECT 1 x FROM trade_currencies WHERE code=?', currency))) fail(400, 'Unknown currency.');
  const incoterm = String(b.incoterm === undefined ? sup.incoterm : b.incoterm || '').toUpperCase(); if (!SUP.INCOTERMS.includes(incoterm)) fail(400, 'Unknown Incoterm.');
  const items = await buildItems(b.items, sup, currency), total = T.roundTo(items.reduce((a, i) => a + i.qty * i.cost, 0), 4), t = now();
  const dispatch = date(b.expected_dispatch, 'Expected dispatch'), arrival = date(b.expected_arrival, 'Expected arrival');
  if (dispatch && arrival && arrival < dispatch) fail(400, 'Expected arrival cannot be before expected dispatch.');
  const poId = await tx(async () => {
    let pid = id;
    if (pid) { await run('UPDATE import_purchase_orders SET destination_country=?,currency=?,incoterm=?,expected_dispatch=?,expected_arrival=?,total=?,notes=?,updated=? WHERE id=?', dest, currency, incoterm, dispatch, arrival, total, str(b.notes, 2000), t, pid); await run('DELETE FROM import_purchase_order_items WHERE po_id=?', pid); }
    else { const r = await run('INSERT INTO import_purchase_orders (po_number,supplier_id,destination_country,currency,incoterm,status,expected_dispatch,expected_arrival,total,notes,created_by,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', T.ref('PO'), sup.id, dest, currency, incoterm, 'draft', dispatch, arrival, total, str(b.notes, 2000), user ? user.id : null, t, t); pid = Number(r.lastInsertRowid); }
    for (const i of items) await run('INSERT INTO import_purchase_order_items (po_id,supplier_product_id,product_id,description,hs_code,qty,unit_cost) VALUES (?,?,?,?,?,?,?)', pid, i.spId, i.productId, i.desc, i.hs, i.qty, i.cost);
    return pid;
  });
  await T.audit(user, id ? 'po.update' : 'po.create', 'import_purchase_orders', poId, { supplier: sup.name, total, currency, lines: items.length }, ip);
  return getPO(poId);
}

async function requestQuotation(id, b, user, ip) {
  const po = await loadPO(id); if (po.status !== 'draft') fail(409, 'A quotation can only be requested from a draft order.');
  const sup = await SUP.load(po.supplier_id), items = await all('SELECT * FROM import_purchase_order_items WHERE po_id=? ORDER BY id', po.id);
  if (!items.length) fail(400, 'Add products before requesting a quotation.');
  let emailed = false;
  if (b && b.send_email) {
    if (!sup.email) fail(400, 'This supplier has no email address on file.');
    const set = await S.getSettings();
    const body = `<p>Dear ${S.esc(sup.contact_person || sup.name)},</p><p>Please send us your best quotation (unit prices, availability, lead time and shipping terms) for the following. Reference <b>${S.esc(po.po_number)}</b>.</p><table style="border-collapse:collapse;font-size:14px">${items.map((i) => `<tr><td style="padding:4px 12px 4px 0">${S.esc(i.description)}</td><td>× ${i.qty}</td></tr>`).join('')}</table><p>Destination: ${S.esc(po.destination_country)}${po.incoterm ? ' · Incoterm: ' + S.esc(po.incoterm) : ''}</p><p>Please reply to this email.</p>`;
    await S.queueMail(sup.email, `Request for quotation ${po.po_number}`, S.mailWrap(set, body)); emailed = true;
  }
  await run("UPDATE import_purchase_orders SET status='quotation_requested', updated=? WHERE id=? AND status='draft'", now(), po.id);
  await T.audit(user, 'po.request_quotation', 'import_purchase_orders', po.id, { emailed }, ip);
  return { ...(await getPO(po.id)), emailed };
}

async function approvePO(id, user, ip) {
  const po = await loadPO(id); if (!['draft', 'quotation_requested'].includes(po.status)) fail(409, po.status === 'approved' ? 'This order is already approved.' : 'A cancelled order cannot be approved.');
  const sup = await SUP.load(po.supplier_id); if (sup.status !== 'active') fail(409, `This supplier is ${sup.status}. Set it to active before approving an order.`);
  const items = await all('SELECT * FROM import_purchase_order_items WHERE po_id=? ORDER BY id', po.id);
  if (!items.length || Number(po.total) <= 0) fail(400, 'The order needs at least one priced product before it can be approved.');
  const t = now(), ref = await tx(async () => {
    const r = await run("UPDATE import_purchase_orders SET status='approved', approved_by=?, approved_at=?, updated=? WHERE id=? AND status IN ('draft','quotation_requested')", user ? user.id : null, t, t, po.id);
    if (r.changes !== 1) fail(409, 'This order was just changed by someone else. Reload and try again.');
    const ir = T.ref('IMP'), sh = await run("INSERT INTO import_shipments (import_ref,po_id,supplier_id,supplier_country,destination_country,status,incoterm,currency,purchase_value,created_by,created,updated) VALUES (?,?,?,?,?,'po_approved',?,?,?,?,?,?)",
      ir, po.id, sup.id, sup.country_code, po.destination_country, po.incoterm, po.currency, po.total, user ? user.id : null, t, t);
    for (const i of items) await run('INSERT INTO import_shipment_items (shipment_id,po_item_id,product_id,description,hs_code,qty_ordered,unit_cost) VALUES (?,?,?,?,?,?,?)', sh.lastInsertRowid, i.id, i.product_id, i.description, i.hs_code, i.qty, i.unit_cost);
    await trackEvent(Number(sh.lastInsertRowid), 'order_confirmed', `Purchase order ${po.po_number} approved.`, '', user, false);
    return ir;
  });
  await T.audit(user, 'po.approve', 'import_purchase_orders', po.id, { total: Number(po.total), currency: po.currency, shipment: ref }, ip);
  return getPO(po.id);
}
async function cancelPO(id, user, ip) {
  const po = await loadPO(id); if (po.status === 'cancelled') fail(409, 'This order is already cancelled.');
  if (po.status === 'approved') {
    const sh = await get('SELECT * FROM import_shipments WHERE po_id=?', po.id);
    if (sh && sh.status !== 'po_approved') fail(409, 'The supplier has already started on this order, so it cannot be cancelled here.');
    if (await get('SELECT 1 x FROM supplier_payments WHERE po_id=? LIMIT 1', po.id)) fail(409, 'A payment is recorded against this order. Remove the payment record first if it was a mistake.');
    if (sh) await run('DELETE FROM import_shipments WHERE id=?', sh.id);
  }
  await run("UPDATE import_purchase_orders SET status='cancelled', updated=? WHERE id=?", now(), po.id);
  await T.audit(user, 'po.cancel', 'import_purchase_orders', po.id, { was: po.status }, ip);
  return getPO(po.id);
}

/* ---------- import shipments ---------- */
const NEXT = {
  draft: ['quotation_requested', 'po_approved'], quotation_requested: ['po_approved'], po_approved: ['supplier_processing'], supplier_processing: ['ready_for_collection', 'dispatched'], ready_for_collection: ['dispatched'],
  dispatched: ['in_transit', 'arrived_port'], in_transit: ['arrived_port'], arrived_port: ['customs_clearance'], customs_clearance: ['customs_hold', 'released'], customs_hold: ['customs_clearance', 'released'],
  released: ['local_transit', 'delivered_warehouse'], local_transit: ['delivered_warehouse'], delivered_warehouse: [], stock_received: ['completed'], completed: [],
};
const STAGE = { po_approved: 'order_confirmed', supplier_processing: 'processing', ready_for_collection: 'packed', dispatched: 'dispatched', in_transit: 'in_transit', arrived_port: 'arrived_destination', customs_clearance: 'import_customs', customs_hold: 'customs_hold', released: 'customs_released', local_transit: 'in_transit', delivered_warehouse: 'delivered' };
const MANUAL_STAGES = ['delayed', 'exception', 'customs_hold', 'in_transit', 'departed_origin', 'arrived_destination', 'export_customs', 'import_customs', 'customs_released', 'processing'];
const COSTS = ['freight', 'insurance', 'customs_duties', 'import_taxes', 'clearing_fees', 'port_charges', 'inland_transport', 'other_charges'];

const shipShape = (r) => ({ id: Number(r.id), import_ref: r.import_ref, po_id: r.po_id == null ? null : Number(r.po_id), po_number: r.po_number || undefined, supplier_id: Number(r.supplier_id), supplier: r.supplier || undefined, supplier_country: r.supplier_country, destination_country: r.destination_country,
  status: r.status, incoterm: r.incoterm, currency: r.currency, fx_rate_to_ngn: r.fx_rate_to_ngn == null ? null : Number(r.fx_rate_to_ngn), purchase_value: Number(r.purchase_value), costs: Object.fromEntries(COSTS.map((c) => [c, Number(r[c])])), landed_cost: Number(r.landed_cost),
  landed_cost_ngn: r.fx_rate_to_ngn == null ? null : T.roundTo(Number(r.landed_cost) * Number(r.fx_rate_to_ngn), 2), carrier: r.carrier, tracking_number: r.tracking_number, eta: day(r.eta), dispatched_at: r.dispatched_at == null ? null : Number(r.dispatched_at), arrived_at: r.arrived_at == null ? null : Number(r.arrived_at),
  stock_posted: !!Number(r.stock_posted), notes: r.notes, created: Number(r.created), updated: Number(r.updated), delayed: !!r.delayed });
async function loadShip(ref) { const r = await get('SELECT h.*, s.name supplier, p.po_number FROM import_shipments h JOIN international_suppliers s ON s.id=h.supplier_id LEFT JOIN import_purchase_orders p ON p.id=h.po_id WHERE h.import_ref=?', String(ref || '')); if (!r) fail(404, 'Import shipment not found.'); return r; }
async function trackEvent(shipId, stage, description, location, user, unique = true, source = 'manual') {
  const hash = unique ? sha(`imp:${shipId}:${stage}`) : sha(`imp:${shipId}:${stage}:${now()}:${crypto.randomBytes(4).toString('hex')}`);
  await run('INSERT INTO shipment_tracking_events (import_shipment_id,stage,description,location,occurred_at,source,event_hash,created_by,created) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (event_hash) DO NOTHING', shipId, stage, str(description, 300), str(location, 100), now(), source === 'system' ? 'system' : 'manual', hash, user ? user.id : null, now());
}

async function listShips(q) {
  const { per, offset, page } = T.page(q, 25), w = [], a = [];
  if (q.status) { w.push('h.status=?'); a.push(String(q.status)); }
  if (q.supplier_id) { w.push('h.supplier_id=?'); a.push(Number(q.supplier_id) || 0); }
  if (q.q) { w.push('(h.import_ref ILIKE ? OR h.tracking_number ILIKE ? OR s.name ILIKE ? OR p.po_number ILIKE ?)'); const l = `%${String(q.q).slice(0, 60)}%`; a.push(l, l, l, l); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const base = `FROM import_shipments h JOIN international_suppliers s ON s.id=h.supplier_id LEFT JOIN import_purchase_orders p ON p.id=h.po_id ${where}`;
  const total = Number((await get(`SELECT COUNT(*) n ${base}`, ...a)).n);
  const rows = await all(`SELECT h.*, s.name supplier, p.po_number, (h.eta IS NOT NULL AND h.eta < CURRENT_DATE AND h.status NOT IN ('delivered_warehouse','stock_received','completed')) delayed ${base} ORDER BY h.id DESC LIMIT ? OFFSET ?`, ...a, per, offset);
  return { total, page, per, shipments: rows.map(shipShape) };
}
async function getShip(ref) {
  const h = await loadShip(ref);
  const [items, events, docs] = await Promise.all([all('SELECT i.*, p.sku FROM import_shipment_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.shipment_id=? ORDER BY i.id', h.id), all('SELECT * FROM shipment_tracking_events WHERE import_shipment_id=? ORDER BY occurred_at DESC, id DESC', h.id), SUP.documents({ import_shipment_id: h.id })]);
  const delayed = h.eta && day(h.eta) < new Date().toISOString().slice(0, 10) && !['delivered_warehouse', 'stock_received', 'completed'].includes(h.status);
  return { shipment: shipShape({ ...h, delayed }), next: NEXT[h.status].filter((s) => s !== 'stock_received'),
    items: items.map((i) => ({ id: Number(i.id), description: i.description, hs_code: i.hs_code, sku: i.sku || '', qty_ordered: Number(i.qty_ordered), qty_received: Number(i.qty_received), qty_damaged: Number(i.qty_damaged), qty_sellable: i.qty_sellable == null ? null : Number(i.qty_sellable), landed_unit_cost_ngn: i.landed_unit_cost_ngn == null ? null : Number(i.landed_unit_cost_ngn), product_id: i.product_id == null ? null : Number(i.product_id), weight_kg: i.weight_kg == null ? null : Number(i.weight_kg), unit_cost: Number(i.unit_cost), line_total: T.roundTo(Number(i.qty_ordered) * Number(i.unit_cost), 4) })),
    events: events.map((e) => ({ id: Number(e.id), stage: e.stage, description: e.description, location: e.location, occurred_at: Number(e.occurred_at), source: e.source })), documents: docs, receiving_note: h.status === 'delivered_warehouse' ? 'Count the goods and receive them into stock.' : '' };
}
async function updateShip(ref, b, user, ip) {
  const h = await loadShip(ref); if (['stock_received', 'completed'].includes(h.status)) fail(409, 'This shipment is closed.');
  const set = [], a = [], changed = {};
  const put = (col, v) => { set.push(`${col}=?`); a.push(v); changed[col] = v; };
  if (b.carrier !== undefined) put('carrier', str(b.carrier, 80));
  if (b.tracking_number !== undefined) { const t = str(b.tracking_number, 80); if (t && !/^[A-Za-z0-9\-_. /]+$/.test(t)) fail(400, 'The tracking number has characters that are not allowed.'); put('tracking_number', t); }
  if (b.eta !== undefined) put('eta', date(b.eta, 'Expected arrival'));
  if (b.incoterm !== undefined) { const i = String(b.incoterm || '').toUpperCase(); if (!SUP.INCOTERMS.includes(i)) fail(400, 'Unknown Incoterm.'); put('incoterm', i); }
  if (b.notes !== undefined) put('notes', str(b.notes, 2000));
  let anyCost = false;
  for (const c of COSTS) if (b[c] !== undefined) { put(c, num(b[c] === '' ? 0 : b[c], c.replace(/_/g, ' '), { min: 0 })); anyCost = true; }
  if (anyCost || b.fx_rate_to_ngn !== undefined) {
    if (b.fx_rate_to_ngn !== undefined && b.fx_rate_to_ngn !== '') put('fx_rate_to_ngn', T.dec(b.fx_rate_to_ngn, 'Exchange rate', { min: 0.000001, places: 8 }));
    else if (h.fx_rate_to_ngn == null) { if (h.currency === 'NGN') put('fx_rate_to_ngn', 1); else { const s = await FX.snapshot(h.currency); put('fx_rate_to_ngn', s.fx_rate_to_ngn); } }   // frozen when the first cost is recorded
  }
  if (!set.length) return getShip(ref);
  await run(`UPDATE import_shipments SET ${set.join(', ')}, updated=? WHERE id=?`, ...a, now(), h.id);
  await T.audit(user, 'import.update', 'import_shipments', h.import_ref, changed, ip);
  return getShip(ref);
}
async function setShipStatus(ref, to, b, user, ip) {
  const h = await loadShip(ref); to = String(to || '');
  if (to === 'stock_received') fail(409, 'Use "Receive stock" to count the goods in. The status then changes by itself.');
  if (to === 'completed' && h.status !== 'stock_received') fail(409, 'Receive the stock before completing the shipment.');
  if (!NEXT[h.status] || !NEXT[h.status].includes(to)) fail(409, `A shipment that is "${h.status.replace(/_/g, ' ')}" cannot move to "${to.replace(/_/g, ' ')}".`);
  const carrier = b.carrier !== undefined ? str(b.carrier, 80) : h.carrier, tracking = b.tracking_number !== undefined ? str(b.tracking_number, 80) : h.tracking_number;
  if (to === 'dispatched' && !carrier && !tracking) fail(400, 'Enter the carrier or the tracking / bill of lading number before marking the shipment dispatched.');
  const t = now(), eta = b.eta ? date(b.eta, 'Expected arrival') : day(h.eta);
  const r = await run('UPDATE import_shipments SET status=?, carrier=?, tracking_number=?, eta=?, dispatched_at=CASE WHEN ?=\'dispatched\' THEN ? ELSE dispatched_at END, arrived_at=CASE WHEN ?=\'arrived_port\' THEN ? ELSE arrived_at END, updated=? WHERE id=? AND status=?', to, carrier, tracking, eta, to, t, to, t, t, h.id, h.status);
  if (r.changes !== 1) fail(409, 'This shipment was just changed by someone else. Reload and try again.');
  if (STAGE[to]) await trackEvent(h.id, STAGE[to], str(b.note, 300) || `Status: ${to.replace(/_/g, ' ')}.`, b.location, user, false);
  await T.audit(user, 'import.status', 'import_shipments', h.import_ref, { from: h.status, to }, ip);
  return getShip(ref);
}
async function addShipEvent(ref, b, user, ip) {
  const h = await loadShip(ref), stage = String(b.stage || ''); if (!MANUAL_STAGES.includes(stage)) fail(400, 'Choose a valid update type.');
  if (['stock_received', 'completed'].includes(h.status)) fail(409, 'This shipment is closed.');
  if (!str(b.description, 300) && !str(b.location, 100)) fail(400, 'Add a short note or a location.');
  await trackEvent(h.id, stage, b.description, b.location, user, false);
  await T.audit(user, 'import.tracking', 'import_shipments', h.import_ref, { stage }, ip);
  return getShip(ref);
}

module.exports = { NEXT, listPOs, getPO, savePO, requestQuotation, approvePO, cancelPO, listShips, getShip, updateShip, setShipStatus, addShipEvent };
