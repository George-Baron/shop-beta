'use strict';
// Wholesale warehouse (staff side). Mounted at /api/admin/warehouse, so sign-in, the role gate (the "warehouse" module: view / edit)
// and the activity log all apply before any of these run. Reading needs warehouse:view; every change needs warehouse:edit.
const express = require('express');
const W = require('../lib/warehouse');
const St = require('../lib/staff');
const F = require('../lib/fulfilment');
const R = require('../lib/wh-reports');
const S = require('../lib/shop');
const { fail, int, str } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const by = (req) => String(req.user.name || req.user.email).slice(0, 80);

router.get('/stock', ah(async (req, res) => res.json({ stock: await W.stockList(req.query) })));
router.get('/movements', ah(async (req, res) => res.json({ movements: await W.movements(req.query) })));

router.post('/stock/receipt', ah(async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, ...(await W.receive(Array.isArray(b.items) ? b.items : [], { reference: b.reference, note: b.note, opening: !!b.opening, by: by(req), userId: req.user.id, key: str(b.key, 80) || null })) });
}));
router.post('/stock/adjust', ah(async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, movement: await W.adjust({ productId: b.productId, qty: b.qty, kind: b.kind, reason: str(b.reason, 300), by: by(req), userId: req.user.id, key: str(b.key, 80) || null }) });
}));
router.put('/stock/:productId/reorder-level', ah(async (req, res) => { await W.setReorderLevel(int(req.params.productId), (req.body || {}).level, by(req), req.user.id); res.json({ ok: true }); }));

// Who changed what: managers (people who can edit warehouse stock) and the owner.
router.get('/activity', ah(async (req, res) => {
  if (!St.allows(await St.permsOf(req.user), 'warehouse', true)) fail(403, 'Your role does not include this. Ask the administrator if you need access.');
  res.json({ activity: await W.activity(int(req.query.limit, 100)) });
}));

/* ---- orders: pick, pack, dispatch, deliver ---- */
// Reading needs warehouse:view. Picking and packing need warehouse:edit. Dispatch, delivered and failed delivery also work for the dispatch officer (delivery:edit); see lib/staff.js RULES.
router.get('/orders', ah(async (req, res) => res.json(await F.list(req.query))));
router.get('/orders/:ref', ah(async (req, res) => res.json({ order: await F.detail(req.params.ref) })));
const step = (fn) => ah(async (req, res) => { await fn(req.params.ref, req.body || {}, by(req)); res.json({ ok: true, order: await F.detail(req.params.ref) }); });
router.post('/orders/:ref/start', step((ref, b, who) => F.startPicking(ref, who)));
router.post('/orders/:ref/pick', step((ref, b, who) => F.savePick(ref, b.lines, who)));
router.post('/orders/:ref/picked', step((ref, b, who) => F.finishPicking(ref, who)));
router.post('/orders/:ref/pack', step((ref, b, who) => F.pack(ref, b, who)));
router.post('/orders/:ref/undo', step((ref, b, who) => F.undo(ref, who)));
router.post('/orders/:ref/dispatch', step((ref, b, who) => require('../lib/wholesale').ship(ref, b, who)));
router.post('/orders/:ref/delivered', step((ref, b, who) => require('../lib/wholesale').deliver(ref, b, who)));
router.post('/orders/:ref/failed', step((ref, b, who) => F.deliveryFailed(ref, b.reason, who)));
// The frozen final invoice (the page that prints it is built by the screen from this)
router.get('/invoices/:ref', ah(async (req, res) => {
  const q = await require('../lib/db').get('SELECT * FROM wholesale_quotes WHERE ref=?', str(req.params.ref, 20).toUpperCase());
  const inv = q && (await F.invoiceFor(q)); if (!inv) fail(404, 'No invoice for that quotation yet.');
  res.json({ invoice: inv });
}));

/* ---- reports ---- */
router.get('/reports', ah(async (req, res) => res.json({ reports: R.LIST })));
router.get('/reports/:name', ah(async (req, res) => res.json({ report: await R.run(req.params.name, req.query) })));

module.exports = router;
