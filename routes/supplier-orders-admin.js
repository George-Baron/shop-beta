'use strict';
// Admin: the dropship order flow. Mounted inside the dropshipping admin router, so the admin sign-in check, activity log and cache clearing apply.
const express = require('express');
const S = require('../lib/shop');
const DO = require('../lib/dropship-orders');
const A = require('../lib/auth');
const { fail, str, int } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const who = (req) => str(req.user.name || req.user.email, 80);
const limit = A.limiter('supplier-orders', 120, 600000);
router.use(limit);

router.get('/queue', ah(async (req, res) => res.json({ ...(await DO.queue()), orders_open: DO.flagOn() })));
router.get('/lines/:id', ah(async (req, res) => res.json(await DO.lineDetail(req.params.id))));

// One purchase order per customer order and supplier: a supplier only ever sees the parcels it ships.
router.post('/po', ah(async (req, res) => {
  const b = req.body || {};
  const id = await DO.buildPO(int(b.order_id), int(b.supplier_id), who(req));
  const d = await DO.poData(id);
  res.json({ ok: true, id, ref: d.po.ref });
}));
router.get('/po/:id', ah(async (req, res) => {
  const d = await DO.poData(req.params.id);
  const text = d.po.body || DO.poText(d);
  res.json({ po: { id: Number(d.po.id), ref: d.po.ref, status: d.po.status, sent_via: d.po.sent_via, currency: d.po.currency, total_cost: Number(d.po.total_cost), created: Number(d.po.created), sent_at: d.po.sent_at == null ? null : Number(d.po.sent_at) },
    supplier: { id: Number(d.sup.id), name: d.sup.name, email: d.sup.email, whatsapp: d.sup.whatsapp }, order_ref: d.o.ref, lines: d.lines.map((l) => ({ id: Number(l.id), name: l.name, qty: l.qty, status: l.status })), text, whatsapp_url: DO.waLink(d.sup, text) });
}));
router.get('/po/:id/pdf', ah(async (req, res) => {
  const d = await DO.poData(req.params.id);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${d.po.ref}.pdf"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(DO.poPdf(d));
}));
router.post('/po/:id/send', ah(async (req, res) => res.json({ ok: true, ...(await DO.sendPO(req.params.id, str(req.body && req.body.via, 12), who(req))) })));
router.post('/po/:id/cancel', ah(async (req, res) => { await DO.cancelPO(req.params.id, who(req)); res.json({ ok: true }); }));

// Move an item along. { to, expected_from?, key?, note?, supplier_order_no?, carrier?, tracking_no?, tracking_url?, issue_kind?, issue_note? }
router.post('/lines/:id/transition', ah(async (req, res) => {
  const b = req.body || {};
  const r = await DO.transition(req.params.id, str(b.to, 20), {
    actor: who(req), key: str(b.key, 80), note: b.note, expectedFrom: str(b.expected_from, 20) || undefined,
    fields: { supplier_order_no: b.supplier_order_no, carrier: b.carrier, tracking_no: b.tracking_no, tracking_url: b.tracking_url, issue_kind: b.issue_kind, issue_note: b.issue_note },
  });
  const warn = !r.unchanged && b.to === 'cancelled' && ['sent', 'confirmed'].includes(b.expected_from || '') ? 'Remember to tell the supplier this item is cancelled.' : '';
  res.json({ ok: true, unchanged: r.unchanged, status: r.line.status, warning: warn });
}));
router.post('/lines/:id/alternative', ah(async (req, res) => res.json({ ok: true, ...(await DO.proposeAlternative(req.params.id, int(req.body && req.body.product_id), who(req))) })));
router.post('/lines/:id/refund', ah(async (req, res) => { await DO.recordRefund(req.params.id, { reference: req.body && req.body.reference, note: req.body && req.body.note, actor: who(req) }); res.json({ ok: true }); }));
router.post('/watch', ah(async (req, res) => res.json({ ok: true, ...(await DO.watch()) })));

module.exports = router;
