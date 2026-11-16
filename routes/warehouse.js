'use strict';
// Wholesale warehouse (staff side). Every route checks the person's warehouse role on the server; hiding a menu is never the only protection.
// The shop administrator is the Super Administrator. Other staff get a role from the administrator (Admin > Wholesale > Warehouse staff).
const express = require('express');
const W = require('../lib/warehouse');
const S = require('../lib/shop');
const A = require('../lib/auth');
const { fail, int, str } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const by = (req) => String(req.user.name || req.user.email).slice(0, 80);
router.use(A.limiter('warehouse', 600, 600000));

router.get('/me', ah(async (req, res) => {
  if (!req.user) fail(401, 'Please sign in.');
  const roles = await W.rolesOf(req.user);
  res.json({ roles, labels: W.ROLE_LABEL, permissions: Object.fromEntries(await Promise.all(Object.keys(W.PERMISSIONS).map(async (p) => [p, await W.can(req.user, p)]))) });
}));

router.get('/stock', W.require('stock.view'), ah(async (req, res) => res.json({ stock: await W.stockList(req.query) })));
router.get('/movements', W.require('stock.view'), ah(async (req, res) => res.json({ movements: await W.movements(req.query) })));

router.post('/stock/receipt', W.require('stock.write'), ah(async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, ...(await W.receive(Array.isArray(b.items) ? b.items : [], { reference: b.reference, note: b.note, opening: !!b.opening, by: by(req), userId: req.user.id, key: str(b.key, 80) || null })) });
}));
router.post('/stock/adjust', W.require('stock.write'), ah(async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, movement: await W.adjust({ productId: b.productId, qty: b.qty, kind: b.kind, reason: str(b.reason, 300), by: by(req), userId: req.user.id, key: str(b.key, 80) || null }) });
}));
router.put('/stock/:productId/reorder-level', W.require('stock.write'), ah(async (req, res) => { await W.setReorderLevel(int(req.params.productId), (req.body || {}).level, by(req), req.user.id); res.json({ ok: true }); }));

router.get('/activity', W.require('activity.view'), ah(async (req, res) => res.json({ activity: await W.activity(int(req.query.limit, 100)) })));

// Only the administrator manages staff roles.
const adminOnly = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : next(new S.HttpError(403, 'Only the administrator can manage staff roles.')));
router.get('/staff', adminOnly, ah(async (req, res) => res.json({ staff: await W.listStaff(), roles: W.ROLES, labels: W.ROLE_LABEL })));
router.post('/staff', adminOnly, ah(async (req, res) => { await W.grantRole((req.body || {}).email, (req.body || {}).role, by(req), req.user.id); res.json({ ok: true }); }));
router.delete('/staff/:id', adminOnly, ah(async (req, res) => { await W.revokeRole(req.params.id, by(req), req.user.id); res.json({ ok: true }); }));

module.exports = router;
