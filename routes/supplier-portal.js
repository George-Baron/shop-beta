'use strict';
// The supplier's own portal (/supplier). Every call is scoped to the signed-in supplier's id inside the library: another supplier's data looks like it does not exist.
// Off unless SUPPLIER_PORTAL_ENABLED=1. Changes are written to the activity log.
const express = require('express');
const A = require('../lib/auth');
const P = require('../lib/supplier-portal');
const S = require('../lib/shop');
const { str, int } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(A.requireSupplier, A.limiter('supplier-portal', 240, 600000), require('../lib/audit').activity('supplier'));

router.get('/me', ah(async (req, res) => res.json({ supplier: await P.profile(req.user), reject_reasons: P.REJECT_KINDS })));
router.get('/orders', ah(async (req, res) => res.json(await P.orders(req.user, { all: str(req.query.all, 1) }))));
router.get('/orders/:id', ah(async (req, res) => res.json({ order: await P.order(req.user, req.params.id) })));
router.post('/lines/:id/confirm', ah(async (req, res) => res.json({ ok: true, ...(await P.confirm(req.user, req.params.id, req.body || {})) })));
router.post('/lines/:id/tracking', ah(async (req, res) => res.json({ ok: true, ...(await P.track(req.user, req.params.id, req.body || {})) })));
router.post('/lines/:id/reject', ah(async (req, res) => res.json({ ok: true, ...(await P.reject(req.user, req.params.id, req.body || {})) })));
router.get('/products', ah(async (req, res) => res.json(await P.products(req.user))));
router.get('/requests', ah(async (req, res) => res.json(await P.myRequests(req.user))));
router.post('/requests', ah(async (req, res) => res.json({ ok: true, id: await P.request(req.user, { ...(req.body || {}), product_id: int(req.body && req.body.product_id) }) })));

module.exports = router;
