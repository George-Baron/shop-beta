'use strict';
// Wholesale buyers (signed in). Prices are never put in public or cached responses.
const express = require('express');
const A = require('../lib/auth');
const W = require('../lib/wholesale');
const S = require('../lib/shop');

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(A.requireUser, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/me', ah(async (req, res) => res.json({ account: await W.me(req.user), terms: await W.cfg().then((c) => ({ eval_days: c.eval_days, valid_days: c.valid_days, pay_days: c.pay_days, service_pct: c.service_pct })) })));
router.post('/apply', A.limiter('wholesale-apply', 5, 3600000), ah(async (req, res) => { await W.apply(req.user, req.body || {}); res.json({ ok: true, account: await W.me(req.user) }); }));
router.get('/catalog', ah(async (req, res) => res.json({ products: await W.catalog(req.user, req.query) })));
router.post('/quotes', A.limiter('wholesale-quote', 20, 3600000), ah(async (req, res) => res.json({ ok: true, ref: await W.createRequest(req.user, req.body || {}) })));
router.get('/quotes', ah(async (req, res) => res.json({ quotes: await W.myQuotes(req.user) })));
router.get('/quotes/:ref', ah(async (req, res) => res.json({ quote: await W.myQuote(req.user, req.params.ref) })));
router.post('/quotes/:ref/accept', ah(async (req, res) => { await W.accept(req.user, req.params.ref); res.json({ ok: true }); }));
router.post('/quotes/:ref/decline', ah(async (req, res) => { await W.decline(req.user, req.params.ref); res.json({ ok: true }); }));
router.post('/quotes/:ref/pay', A.limiter('wholesale-pay', 20, 600000), ah(async (req, res) => res.json(await W.startPayment(req.user, req.params.ref))));
router.post('/quotes/:ref/pay/demo', A.limiter('wholesale-demo', 20, 600000), ah(async (req, res) => { await W.demoPay(req.user, req.params.ref); res.json({ ok: true }); }));

module.exports = router;
