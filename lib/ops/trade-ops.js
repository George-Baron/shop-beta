'use strict';
// Import and export consignments, seen through the AI Operations layer. The consignments themselves, their documents, permit reminders and events live in the
// store's existing trade module (trade_shipments and friends); this file reads them, links them to orders and purchase orders, works out what is missing
// (trade-readiness.js) and raises problems. It never ticks a permit, never classifies goods, never moves a shipment forward and never invents a charge.
const { get, all, run, now } = require('../db');
const S = require('../shop');
const T = require('../trade');
const TC = require('../trade-compliance');
const C = require('../countries');
const St = require('./store');
const R = require('./trade-readiness');
const { fail, str, int } = S;
const num = (v) => Number(v) || 0;
const who = (u) => (u && (u.name || u.email)) || 'staff';
const AI_USER = { name: St.AI_NAME || 'VELTO AI' };

async function facts(id) {
  const ship = await T.load(id), items = await T.items(ship.id), t = now();
  const classes = await TC.classes(), flags = [], slugs = new Set();
  for (const it of items) { const cl = await TC.classify({ name: it.description, hs_code: it.hs_code }, classes); for (const h of cl.hits) { slugs.add(h.slug); flags.push({ ...h, item: it.description }); } }
  const checklist = await TC.checklist(ship, [...slugs]);
  const issued = (await all('SELECT kind FROM trade_issued WHERE shipment_id=?', ship.id)).map((r) => r.kind), files = (await all('SELECT DISTINCT kind FROM trade_files WHERE shipment_id=?', ship.id)).map((r) => r.kind);
  const links = await all('SELECT kind, ref_id FROM ops_trade_links WHERE shipment_id=?', ship.id);
  let vendor = null; const po = links.find((l) => l.kind === 'purchase_order');
  if (po) { const v = await get('SELECT v.verification FROM ops_purchase_orders p JOIN ops_vendors v ON v.id=p.vendor_id WHERE p.id=?', po.ref_id); if (v) { const x = v.verification || {}; vendor = { verified: !!(x.registration && x.registration.state === 'verified' && x.contact && x.contact.state === 'verified') }; } }
  let stock = [];
  if (ship.direction === 'export') for (const it of items.filter((i) => i.product_id)) { const p = await get('SELECT name, stock FROM products WHERE id=?', it.product_id); if (p) stock.push({ description: it.description, need: it.qty, have: num(p.stock) }); }
  return { shipment: ship, items, issued, files, checklist, flags, stock, linked: { orders: links.filter((l) => l.kind !== 'purchase_order').length, purchase_orders: links.filter((l) => l.kind === 'purchase_order').length }, vendor, now: t };
}
const check = async (id) => { const f = await facts(id); return { f, r: R.readiness(f, f.now) }; };

async function board({ direction = '', status = '' } = {}) {
  const w = ["s.status NOT IN ('delivered','cancelled')"], a = []; if (['import', 'export'].includes(direction)) { w.push('s.direction=?'); a.push(direction); } if (status) { w.push('s.status=?'); a.push(status); }
  const rows = await all(`SELECT s.id FROM trade_shipments s WHERE ${w.join(' AND ')} ORDER BY s.eta NULLS LAST, s.id DESC LIMIT 200`, ...a), list = [];
  for (const r of rows) { const { f, r: v } = await check(r.id), s = f.shipment;
    list.push({ id: s.id, ref: s.ref, direction: s.direction, status: s.status, customs_status: s.customs_status, origin: s.origin_country, dest: s.dest_country, party: s.party_name, forwarder: s.forwarder, eta: s.eta, transport: s.transport, items: f.items.length,
      links: f.linked, ready: v.ready, next_step: v.next_step, blockers: v.blockers.length, warnings: v.warnings.length, needs_compliance: v.needs_compliance, cost_gaps: v.cost_gaps }); }
  return { consignments: list, open: list.length, imports: list.filter((x) => x.direction === 'import').length, exports: list.filter((x) => x.direction === 'export').length, blocked: list.filter((x) => x.blockers > 0).length, needs_compliance: list.filter((x) => x.needs_compliance).length };
}
async function detail(id) {
  const { f, r } = await check(id), links = await all('SELECT l.*, CASE l.kind WHEN \'order\' THEN (SELECT ref FROM orders WHERE id=l.ref_id) WHEN \'purchase_order\' THEN (SELECT ref FROM ops_purchase_orders WHERE id=l.ref_id) ELSE (SELECT COALESCE(order_no, ref) FROM wholesale_quotes WHERE id=l.ref_id) END AS label FROM ops_trade_links l WHERE shipment_id=? ORDER BY id', f.shipment.id);
  const events = await all('SELECT kind, note, actor, created FROM trade_events WHERE shipment_id=? ORDER BY id DESC LIMIT 40', f.shipment.id);
  const landed = await T.landedFor(f.shipment, f.items).catch(() => null);
  return { shipment: f.shipment, items: f.items, readiness: r, links: links.map((l) => ({ ...l, id: Number(l.id), ref_id: Number(l.ref_id) })), events, landed_cost: landed && !landed.error ? { ...landed, basis: 'ESTIMATE from the figures entered on the shipment, not recorded actual costs.', gaps: r.cost_gaps } : null, docs: { issued: f.issued, files: f.files } };
}

/* ---------- links ---------- */
async function link(user, shipmentId, kind, refId, note) {
  if (!['order', 'wholesale', 'purchase_order'].includes(kind)) fail(400, 'Link an order, a wholesale order or a purchase order.');
  const ship = await T.load(shipmentId), ref = int(refId); if (['cancelled', 'delivered'].includes(ship.status)) fail(409, `This consignment is ${ship.status}.`);
  const exists = kind === 'order' ? await get('SELECT id FROM orders WHERE id=?', ref) : kind === 'wholesale' ? await get('SELECT id FROM wholesale_quotes WHERE id=?', ref) : await get('SELECT id FROM ops_purchase_orders WHERE id=?', ref);
  if (!exists) fail(404, 'That order or purchase order does not exist.');
  const other = await get("SELECT s.ref FROM ops_trade_links l JOIN trade_shipments s ON s.id=l.shipment_id WHERE l.kind=? AND l.ref_id=? AND l.shipment_id<>? AND s.status NOT IN ('cancelled','delivered')", kind, ref, ship.id);
  if (other && kind !== 'order') fail(409, `Already linked to open consignment ${other.ref}.`);
  const id = await get('INSERT INTO ops_trade_links (shipment_id,kind,ref_id,note,linked_by,created) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id', ship.id, kind, ref, str(note, 200), who(user), now());
  if (id) await St.logAction({ agent: 'trade', actor_kind: 'human', actor_user: user && user.id, actor_name: who(user), action_type: 'trade.link', description: `${kind.replace('_', ' ')} ${ref} linked to consignment ${ship.ref}`, related_type: 'trade_shipment', related_id: String(ship.id), status: 'done' });
  return { linked: !!id };
}
async function unlink(user, shipmentId, kind, refId) {
  const r = await run('DELETE FROM ops_trade_links WHERE shipment_id=? AND kind=? AND ref_id=?', int(shipmentId), kind, int(refId));
  await St.logAction({ agent: 'trade', actor_kind: 'human', actor_user: user && user.id, actor_name: who(user), action_type: 'trade.unlink', description: `${kind} ${refId} unlinked from consignment ${shipmentId}`, related_type: 'trade_shipment', related_id: String(shipmentId), status: 'done' });
  return { removed: !!(r && (r.changes || r.rowCount)) };
}

/* ---------- drafting an import consignment from an approved purchase order (gateway action consignment.draft) ---------- */
// Creates a DRAFT only. The Incoterm, transport and every cost are left for a person to confirm; nothing is booked and no money is committed.
async function draftFromPo(p) {
  const po = await get('SELECT p.*, v.name vname, v.country vcountry FROM ops_purchase_orders p JOIN ops_vendors v ON v.id=p.vendor_id WHERE p.id=?', int(p.po_id)); if (!po) throw new Error('Purchase order not found.');
  if (['draft', 'pending_approval', 'rejected', 'cancelled'].includes(po.status)) throw new Error(`Purchase order ${po.ref} is ${po.status.replace('_', ' ')}. A consignment is only drafted for an approved order.`);
  if (!po.vcountry || String(po.vcountry).toUpperCase() === 'NG') throw new Error('This supplier is in Nigeria or has no country recorded, so it is not an import.');
  if (await get("SELECT l.id FROM ops_trade_links l JOIN trade_shipments s ON s.id=l.shipment_id WHERE l.kind='purchase_order' AND l.ref_id=? AND s.status<>'cancelled'", po.id)) throw new Error(`Purchase order ${po.ref} already has a consignment.`);
  const id = await T.create(AI_USER, { direction: 'import', incoterm: 'FOB', currency: po.currency, party_name: po.vname, party_country: String(po.vcountry).toUpperCase(), origin_country: String(po.vcountry).toUpperCase(), dest_country: 'NG', transport: 'air', notes: `Drafted by ${AI_USER.name} from purchase order ${po.ref}. The Incoterm, transport mode and all costs are NOT confirmed; set them from the supplier pro forma and forwarder quotation.` });
  const skipped = []; for (const l of po.lines || []) { try { await T.addItem(AI_USER, id, { product_id: l.product_id || null, description: l.description, qty: l.qty, unit_value: l.unit_price, origin_country: String(po.vcountry).toUpperCase() }); } catch (e) { skipped.push(`${l.description}: ${e.message}`); } }
  await run('INSERT INTO ops_trade_links (shipment_id,kind,ref_id,note,linked_by,created) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING', id, 'purchase_order', po.id, 'Drafted from purchase order', AI_USER.name, now());
  const ship = await T.load(id); return { shipment_id: id, ref: ship.ref, skipped };
}

/* ---------- the watch ---------- */
async function watch(raise) {
  const rows = await all("SELECT id FROM trade_shipments WHERE status NOT IN ('delivered','cancelled')"), t = now(), seen = [];
  const COVERED = /^(eta_passed|customs_)/;           // already reported by the main monitor
  for (const row of rows) {
    const { f, r } = await check(row.id), s = f.shipment, base = { related_type: 'trade_shipment', related_id: String(s.id), auto: true, detected_by: 'trade' };
    const mk = async (kind, severity, title, detail, action, dept) => { const key = `${kind}:${s.id}`; seen.push(key); await raise({ ...base, kind, severity, dedupe_key: key, title, detail, impact: `${s.direction === 'import' ? 'Import' : 'Export'} ${s.ref} (${s.origin_country} to ${s.dest_country}) cannot proceed safely.`, recommended_action: action, department: dept }); };
    const reg = r.blockers.filter((b) => b.code.startsWith('restricted') || b.code === 'checklist_open');
    if (reg.length) await mk('consignment_compliance', reg.some((b) => b.code === 'restricted_blocked') || s.status !== 'draft' ? 'high' : 'medium', `${s.ref} needs compliance review before it can move`, reg.map((b) => b.message).join(' '), 'A qualified compliance person must verify permits with the authority and tick them off. The AI will not authorize regulated goods.', 'import_export');
    const other = r.blockers.filter((b) => !b.code.startsWith('restricted') && b.code !== 'checklist_open' && !COVERED.test(b.code));
    if (other.length && s.status !== 'draft') await mk('consignment_blocked', ['in_transit', 'arrived'].includes(s.status) ? 'high' : 'medium', `${s.ref} is ${s.status.replace('_', ' ')} but ${other.length} requirement(s) are unmet`, other.slice(0, 6).map((b) => `${b.message} (${b.fix})`).join(' '), other[0].fix, 'import_export');
    const last = num((await get('SELECT MAX(created) m FROM trade_events WHERE shipment_id=?', s.id)).m) || num(s.updated);
    if (['booked', 'in_transit', 'arrived'].includes(s.status) && t - last > 7 * 86400) await mk('consignment_stale', 'medium', `${s.ref} has had no update for ${Math.floor((t - last) / 86400)} days`, `Status ${s.status.replace('_', ' ')}, customs ${s.customs_status.replace('_', ' ')}.`, 'Ask the forwarder for the current position and record it.', 'import_export');
    if (['arrived', 'cleared'].includes(s.status) && r.cost_gaps.length) await mk('consignment_costs', 'low', `${s.ref} landed cost is still incomplete`, `Missing: ${r.cost_gaps.join(', ')}. Margins on these goods will be wrong until the real figures are entered.`, 'Enter the real freight, duty and agent charges from the invoices.', 'finance');
  }
  return seen;
}

module.exports = { facts, check, board, detail, link, unlink, draftFromPo, watch };
