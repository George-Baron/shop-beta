'use strict';
// Wholesale warehouse (staff side). Mounted at /api/admin/warehouse, so sign-in, the role gate (the "warehouse" module: view / edit)
// and the activity log all apply before any of these run. Reading needs warehouse:view; every change needs warehouse:edit.
const express = require('express');
const W = require('../lib/warehouse');
const St = require('../lib/staff');
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

module.exports = router;
