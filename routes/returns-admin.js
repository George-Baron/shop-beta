'use strict';
// Back office: the returns queue. Mounted at /api/admin/returns. Reviewing needs Orders: Edit; paying the refund out needs Finance: Edit (see lib/staff.js).
const express = require('express');
const R = require('../lib/returns');
const S = require('../lib/shop');
const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', ah(async (req, res) => res.json(await R.list(req.query))));
router.get('/count', ah(async (req, res) => res.json(await R.summary())));
// Open a return for a customer (phone call, shop visit, WhatsApp). Needs Orders: Edit. Staff may open one after the window closed; it is flagged for the approver.
router.get('/lookup', ah(async (req, res) => {
  const o = await S.loadOrder('ref=?', S.str(req.query.ref, 40).trim()); if (!o) S.fail(404, 'Order not found. Check the order number.');
  const el = await R.eligibility(o, { staff: true });
  res.json({ order: { ref: o.ref, name: o.name, email: o.email, status: o.status, total: o.total }, can: el.can, reason: el.reason, past_window: !!el.past_window, days: el.days, lines: el.lines, reasons: R.REASONS, conditions: R.CONDITIONS });
}));
router.post('/open', ah(async (req, res) => {
  const b = req.body || {}, ref = S.str(b.order_ref, 40).trim();
  const o = ref ? await S.loadOrder('ref=?', ref) : null; if (!o) S.fail(404, 'Order not found. Check the order number.');
  res.json({ ok: true, ...(await R.request(o, b, req.user)) });
}));
router.get('/:id', ah(async (req, res) => res.json(await R.detail(S.int(req.params.id)))));
router.get('/:id/photos/:pid', ah(async (req, res) => {
  const f = await R.readPhoto(S.int(req.params.id), S.int(req.params.pid));
  res.set({ 'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(f.buf);
}));
router.post('/:id/approve', ah(async (req, res) => res.json({ ok: true, ...(await R.approve(S.int(req.params.id), req.user, req.body || {})) })));
router.post('/:id/reject', ah(async (req, res) => { await R.reject(S.int(req.params.id), req.user, req.body || {}); res.json({ ok: true }); }));
router.post('/:id/settle', ah(async (req, res) => res.json(await R.settle(S.int(req.params.id), req.user, req.body || {}))));
module.exports = router;
