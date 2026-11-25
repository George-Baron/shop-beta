'use strict';
// How a customer return behaves in each sales channel. The customer's refund is always the same flow (lib/returns.js); what differs is what happens behind it:
//  - our own stock:   the goods can go back on the shelf (restock option).
//  - partner store:   the partner's share (after our commission) comes off their balance (vendor_adjustments, in returns.js).
//  - dropshipping:    we hold no stock. The item goes back to the SUPPLIER: a supplier return (RMA) is opened when the owner approves, and when the customer is refunded
//                     the item is marked refunded so the Money & reports figures stay right. Claiming the money back from the supplier stays on the "expecting refunds" list.
//  - imported:        a dropship item whose supplier is abroad. Duties and international shipping are usually not refunded by the supplier, so staff are warned before approving.
// Wholesale quotes are not part of this flow; they have their own returns (lib/wholesale-returns.js).
const { all, get, run, now } = require('./db');
const S = require('./shop');
const { str } = S;

const parseItems = (r) => (Array.isArray(r.items) ? r.items : JSON.parse(r.items || '[]'));

async function lines(orderItemIds) {
  if (!orderItemIds.length) return [];
  return all(`SELECT l.id, l.order_item_id, l.status, l.qty, l.sell_price, l.cost_currency, s.name supplier, s.country, r.status return_status, r.rma_no
    FROM dropship_lines l JOIN suppliers s ON s.id = l.supplier_id LEFT JOIN dropship_returns r ON r.line_id = l.id WHERE l.order_item_id = ANY(?)`, orderItemIds);
}

// One entry per returned item, with the plain-words notes staff should see before they approve.
async function describe(r, o, vendorShares) {
  const items = parseItems(r), ds = await lines(items.map((i) => Number(i.item_id))), out = [];
  for (const i of items) {
    const oi = o.items.find((x) => Number(x.id) === Number(i.item_id)); if (!oi) continue;
    const l = ds.find((x) => Number(x.order_item_id) === Number(oi.id));
    const e = { item_id: Number(oi.id), name: oi.name, qty: Number(i.qty), channel: 'own', notes: [] };
    if (l) {
      const imported = String(l.country).toUpperCase() !== 'NG';
      Object.assign(e, { channel: imported ? 'imported' : 'dropship', supplier: l.supplier, country: l.country, line_id: Number(l.id), line_status: l.status, supplier_return: l.return_status || '', rma_no: l.rma_no || '' });
      e.notes.push(`Dropship item from ${l.supplier}. We hold no stock of it, so it is not put back on our shelf; it goes back to the supplier. A supplier return is opened when this is approved.`);
      if (Number(i.qty) < Number(l.qty)) e.notes.push(`Only ${i.qty} of ${l.qty} are coming back. A supplier return covers a whole line, so claim this part from the supplier by hand.`);
      if (l.status !== 'delivered' && l.status !== 'returned' && l.status !== 'refunded') e.notes.push(`The supplier line is "${l.status}", not delivered, so no supplier return can be opened automatically.`);
      if (imported) e.notes.push(`Imported from ${l.country}. Suppliers abroad rarely refund duties or international shipping, and the parcel may cost more to send back than the item is worth. Check their return terms (RMA) before approving.`);
    } else if (oi.vendor_id) {
      e.channel = 'partner'; e.partner = oi.vendor_name || '';
      const share = (vendorShares(r, o).find((v) => v.vendor_id === Number(oi.vendor_id)) || {}).amount || 0;
      e.notes.push(`Partner store ${oi.vendor_name || ''}: about ₦${share.toLocaleString('en-NG')} (their share after our commission) comes off their balance when the refund is settled.`);
    }
    out.push(e);
  }
  return out;
}

// Owner approved: start the supplier return for every dropship line that is coming back in full. Never blocks the customer's approval.
async function onApproved(r, o, actor) {
  const DM = require('./dropship-money'), DO = require('./dropship-orders'), done = [];
  for (const i of parseItems(r)) {
    const l = await get('SELECT id, status, qty FROM dropship_lines WHERE order_item_id = ?', Number(i.item_id)); if (!l) continue;
    try {
      if (Number(i.qty) < Number(l.qty) || l.status !== 'delivered') {
        await run('INSERT INTO dropship_events (line_id, from_status, to_status, note, actor, created) VALUES (?,?,?,?,?,?)', l.id, l.status, l.status, `Customer return ${r.ref} approved for ${i.qty} of ${l.qty}${l.status !== 'delivered' ? ` while the item is "${l.status}"` : ''}. Claim from the supplier by hand.`, str(actor.name || 'system', 80), now());
        await DO.alertAdmin(`Dropship return needs a manual step: order ${o.ref}`, `<p>Return ${S.esc(r.ref)} was approved for ${i.qty} of ${l.qty} units (line status: ${S.esc(l.status)}). Open Dropshipping to handle the supplier side by hand.</p>`);
        continue;
      }
      done.push(await DM.startReturn(l.id, { reason: `Customer return ${r.ref}` }, str(actor.name || 'owner', 80)));
    } catch (e) { console.error('Supplier return not opened:', e.message); }
  }
  return done;
}

// Customer refunded: the dropship lines that went back are now refunded too (amount = what the customer got for that item).
async function onSettled(r, o, actor) {
  const DO = require('./dropship-orders'), ratio = Number(r.requested_amount) > 0 ? Math.min(1, Number(r.approved_amount) / Number(r.requested_amount)) : 1;
  for (const i of parseItems(r)) {
    const l = await get('SELECT id, status, qty, sell_price FROM dropship_lines WHERE order_item_id = ?', Number(i.item_id));
    if (!l || l.status !== 'returned') continue;
    try { await DO.recordRefund(l.id, { reference: r.ref, note: `Customer refund for return ${r.ref}`, actor: str(actor.name || 'owner', 80), amount: Math.min(Number(l.sell_price) * Number(l.qty), Math.round(Number(l.sell_price) * Number(i.qty) * ratio)) }); }
    catch (e) { console.error('Dropship refund not recorded:', e.message); }
  }
}
module.exports = { describe, onApproved, onSettled };
