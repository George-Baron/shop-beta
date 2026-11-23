'use strict';
// Back office: the returns queue. Mounted at /api/admin/returns. Reviewing needs Orders: Edit; paying the refund out needs Finance: Edit (see lib/staff.js).
const express = require('express');
const R = require('../lib/returns');
const S = require('../lib/shop');
const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', ah(async (req, res) => res.json(await R.list(req.query))));
router.get('/count', ah(async (req, res) => res.json(await R.summary())));
router.get('/:id', ah(async (req, res) => res.json(await R.detail(S.int(req.params.id)))));
router.post('/:id/approve', ah(async (req, res) => { await R.approve(S.int(req.params.id), req.user, req.body || {}); res.json({ ok: true }); }));
router.post('/:id/reject', ah(async (req, res) => { await R.reject(S.int(req.params.id), req.user, req.body || {}); res.json({ ok: true }); }));
router.post('/:id/settle', ah(async (req, res) => res.json(await R.settle(S.int(req.params.id), req.user, req.body || {}))));
module.exports = router;
