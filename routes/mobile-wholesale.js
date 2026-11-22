'use strict';
// Mobile API v1: wholesale buyers. Mounted at /api/mobile/v1/wholesale. The same functions as the website's /api/wholesale (lib/wholesale.js, lib/rfq.js),
// so approval checks, wholesale-only prices, the SEPARATE wholesale warehouse stock, reservations and payment checks are exactly the same.
// Not here yet: spreadsheet import and file attachments on a request for quotation (use the website for those).
const express = require('express');
const W = require('../lib/wholesale');
const R = require('../lib/rfq');
const S = require('../lib/shop');
const M = require('../lib/mobile-auth');
const log = require('../lib/log');

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const user = (req) => req.user.id;
router.use(M.requireAuth, require('../lib/audit').activity('buyer'));

// Where this customer stands: no application yet (account null), under evaluation, approved or rejected. Prices are only ever sent to an approved account.
router.get('/me', ah(async (req, res) => {
  const c = await W.cfg();
  res.json({ account: await W.me(req.user), terms: { eval_days: c.eval_days, valid_days: c.valid_days, pay_days: c.pay_days, service_pct: c.service_pct } });
}));
router.post('/apply', M.limit('m-ws-apply', 5, 3600000, user), ah(async (req, res) => { await W.apply(req.user, req.body || {}); res.json({ ok: true, account: await W.me(req.user) }); }));
router.get('/catalog', ah(async (req, res) => res.json({ products: await W.catalog(req.user, req.query) })));

/* ---------- quotations: request, proforma, accept, pay ---------- */
router.post('/quotes', M.limit('m-ws-quote', 20, 3600000, user), ah(async (req, res) => res.json({ ok: true, ref: await W.createRequest(req.user, req.body || {}) })));
router.get('/quotes', ah(async (req, res) => res.json({ quotes: await W.myQuotes(req.user) })));
router.get('/quotes/:ref', ah(async (req, res) => res.json({ quote: await W.myQuote(req.user, req.params.ref) })));
router.get('/quotes/:ref/invoice', ah(async (req, res) => res.json({ invoice: await W.myInvoice(req.user, req.params.ref) })));
router.post('/quotes/:ref/accept', M.limit('m-ws-act', 30, 600000, user), ah(async (req, res) => { await W.accept(req.user, req.params.ref); res.json({ ok: true }); }));
router.post('/quotes/:ref/decline', M.limit('m-ws-act', 30, 600000, user), ah(async (req, res) => { await W.decline(req.user, req.params.ref); res.json({ ok: true }); }));
router.post('/quotes/:ref/pay', M.limit('m-ws-pay', 20, 600000, user), ah(async (req, res) => res.json(await W.startPayment(req.user, req.params.ref))));
// The app never says "I paid": the server asks Paystack and checks reference, currency and amount before the quotation is marked paid (once).
router.get('/quotes/:ref/payment-status', M.limit('m-ws-paystatus', 60, 600000, user), ah(async (req, res) => {
  let q = await W.myQuote(req.user, req.params.ref), checking = false;   // 404 unless it is this buyer's own quotation
  if (q.status === 'accepted' && S.paystackLive()) {
    try { await S.settleWithPaystack(q.ref); } catch (e) { checking = true; log.warn('mobile.wholesale_payment_check_failed', { ref: q.ref, message: String(e.message).slice(0, 200) }); }
    q = await W.myQuote(req.user, req.params.ref);
  }
  res.json({ ref: q.ref, status: q.status, paid: ['paid', 'shipped', 'delivered'].includes(q.status), checking });
}));

/* ---------- requests for quotation (RFQ): lines the buyer types in; our team prices them ---------- */
router.get('/rfq', ah(async (req, res) => res.json(await R.mine(req.user))));
router.post('/rfq', M.limit('m-rfq-save', 120, 3600000, user), ah(async (req, res) => res.json({ ok: true, ref: await R.save(req.user, null, req.body || {}) })));
router.get('/rfq/:ref', ah(async (req, res) => res.json({ request: await R.mineOne(req.user, req.params.ref) })));
router.put('/rfq/:ref', M.limit('m-rfq-save', 120, 3600000, user), ah(async (req, res) => res.json({ ok: true, ref: await R.save(req.user, req.params.ref, req.body || {}) })));
router.delete('/rfq/:ref', ah(async (req, res) => { await R.removeDraft(req.user, req.params.ref); res.json({ ok: true }); }));
router.post('/rfq/:ref/submit', M.limit('m-rfq-submit', 30, 3600000, user), ah(async (req, res) => { await R.submit(req.user, req.params.ref); res.json({ ok: true }); }));
router.post('/rfq/:ref/accept', M.limit('m-ws-act', 30, 600000, user), ah(async (req, res) => { await R.respond(req.user, req.params.ref, true); res.json({ ok: true }); }));
router.post('/rfq/:ref/decline', M.limit('m-ws-act', 30, 600000, user), ah(async (req, res) => { await R.respond(req.user, req.params.ref, false, (req.body || {}).reason); res.json({ ok: true }); }));

module.exports = router;
