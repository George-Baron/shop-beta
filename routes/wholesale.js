'use strict';
// Wholesale buyers (signed in). Prices are never put in public or cached responses.
const express = require('express');
const A = require('../lib/auth');
const W = require('../lib/wholesale');
const S = require('../lib/shop');
const R = require('../lib/rfq');

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

/* ---------- requests for quotation ---------- */
const rjson = express.json({ limit: '8mb' }), rraw = express.raw({ type: () => true, limit: '9mb' });
const sendBuf = (res, buf, name, type) => { res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${String(name).replace(/[^\w.\- ()]/g, '_')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.send(Buffer.from(buf)); };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
router.get('/rfq', ah(async (req, res) => res.json(await R.mine(req.user))));
router.get('/rfq/template.xlsx', (req, res) => sendBuf(res, R.template(), 'shop-beta-rfq-template.xlsx', XLSX));
router.post('/rfq/parse', A.limiter('rfq-parse', 60, 3600000), rraw, ah(async (req, res) => { await W.approvedAccount(req.user); if (!Buffer.isBuffer(req.body) || !req.body.length) S.fail(400, 'Please choose a file.'); res.json(R.parseSheet(req.body, String(req.query.filename || ''))); }));
router.post('/rfq', A.limiter('rfq-save', 120, 3600000), ah(async (req, res) => res.json({ ok: true, ref: await R.save(req.user, null, req.body || {}) })));
router.get('/rfq/:ref', ah(async (req, res) => res.json({ request: await R.mineOne(req.user, req.params.ref) })));
router.put('/rfq/:ref', ah(async (req, res) => res.json({ ok: true, ref: await R.save(req.user, req.params.ref, req.body || {}) })));
router.delete('/rfq/:ref', ah(async (req, res) => { await R.removeDraft(req.user, req.params.ref); res.json({ ok: true }); }));
router.post('/rfq/:ref/submit', A.limiter('rfq-submit', 30, 3600000), ah(async (req, res) => { await R.submit(req.user, req.params.ref); res.json({ ok: true }); }));
router.post('/rfq/:ref/accept', ah(async (req, res) => { await R.respond(req.user, req.params.ref, true); res.json({ ok: true }); }));
router.post('/rfq/:ref/decline', ah(async (req, res) => { await R.respond(req.user, req.params.ref, false, (req.body || {}).reason); res.json({ ok: true }); }));
router.get('/rfq/:ref/download.xlsx', ah(async (req, res) => { const v = await R.mineOne(req.user, req.params.ref); sendBuf(res, R.exportFile(v), v.ref + '.xlsx', XLSX); }));
router.post('/rfq/:ref/files', A.limiter('rfq-file', 60, 3600000), rjson, ah(async (req, res) => res.json({ ok: true, ...(await R.addFile(req.user, req.params.ref, req.body || {}, false)) })));
router.get('/rfq/:ref/files/:id', ah(async (req, res) => { const f = await R.readFile(req.user, req.params.ref, req.params.id, false); sendBuf(res, f.buf, f.name, f.mime); }));
router.delete('/rfq/:ref/files/:id', ah(async (req, res) => { await R.removeFile(req.user, req.params.ref, req.params.id); res.json({ ok: true }); }));

module.exports = router;
