'use strict';
// Multi-location fulfilment advice for WHOLESALE orders (the only stock held in several places). PURE.
// Retail stock is one pool, so there is nothing to split. The plan only advises: stock is reserved and dispatched by the wholesale module, and
// moving stock between warehouses needs a transfer request and approval. It never takes from retail.
// lines: [{ product_id, name, qty }]   warehouses: [{ id, name, available: { [product_id]: qty } }]
function plan(lines, warehouses) {
  const merged = new Map();   // the same product on two lines is one need
  for (const l of lines) { const q = Math.max(0, Number(l.qty) || 0); if (q > 0) merged.set(l.product_id, { ...l, qty: (merged.has(l.product_id) ? merged.get(l.product_id).qty : 0) + q }); }
  const need = [...merged.values()];
  const avail = (w, pid) => Math.max(0, Number((w.available || {})[pid]) || 0);
  const whole = warehouses.filter((w) => need.every((l) => avail(w, l.product_id) >= l.qty));
  if (need.length && whole.length) {
    const w = [...whole].sort((a, b) => need.reduce((s, l) => s + avail(b, l.product_id) - avail(a, l.product_id), 0) || a.id - b.id)[0];   // the one left with most spare stock
    return { mode: 'single', complete: true, shipments: [{ warehouse_id: w.id, warehouse: w.name, lines: need.map((l) => ({ product_id: l.product_id, name: l.name, qty: l.qty })) }], shortfalls: [], note: `${w.name} can fill the whole order, so it ships as one parcel from one place.` };
  }
  const left = new Map(need.map((l) => [l.product_id, l.qty])), by = new Map(), pool = warehouses.map((w) => ({ ...w, take: {} }));
  // greedy: repeatedly pick the warehouse that covers the most still-needed units, so the order uses as few locations as possible
  for (;;) {
    let best = null, bestN = 0;
    for (const w of pool) { let n = 0; for (const [pid, q] of left) n += Math.min(q, avail(w, pid) - (w.take[pid] || 0)); if (n > bestN || (n === bestN && best && n > 0 && w.id < best.id)) { best = w; bestN = n; } }
    if (!best || bestN <= 0) break;
    for (const [pid, q] of [...left]) { const t = Math.min(q, avail(best, pid) - (best.take[pid] || 0)); if (t > 0) { best.take[pid] = (best.take[pid] || 0) + t; left.set(pid, q - t); const arr = by.get(best.id) || []; arr.push({ product_id: pid, name: (need.find((l) => l.product_id === pid) || {}).name, qty: t }); by.set(best.id, arr); } if (left.get(pid) === 0) left.delete(pid); }
  }
  const shipments = [...by.entries()].map(([id, ls]) => ({ warehouse_id: id, warehouse: pool.find((w) => w.id === id).name, lines: ls }));
  const shortfalls = [...left.entries()].map(([pid, q]) => ({ product_id: pid, name: (need.find((l) => l.product_id === pid) || {}).name, short_by: q }));
  return { mode: shipments.length > 1 ? 'split' : shipments.length === 1 ? 'single' : 'none', complete: shortfalls.length === 0 && need.length > 0, shipments, shortfalls,
    note: shortfalls.length ? 'Not enough stock across all warehouses: the shortfall needs procurement (or a smaller order).' : `No single warehouse has everything, so it ships in ${shipments.length} parcels. The customer should see separate shipment information for each.` };
}
module.exports = { plan };
