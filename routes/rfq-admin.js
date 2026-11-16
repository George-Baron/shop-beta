'use strict';
// Our commercial team's side of requests for quotation. Mounted at /api/admin/rfq (permission "rfq").
const express = require('express');
const R = require('../lib/rfq');
const S = require('../lib/shop');
const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const send = (res, buf, name, type) => { res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${String(name).replace(/[^\w.\- ()]/g, '_')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.send(Buffer.from(buf)); };

router.get('/', ah(async (req, res) => res.json(await R.adminList(req.query))));
router.get('/officers', ah(async (req, res) => res.json({ officers: await R.officers() })));
router.get('/match', ah(async (req, res) => res.json({ products: await R.match(req.query.q) })));
router.get('/:ref', ah(async (req, res) => res.json({ request: await R.adminOne(req.params.ref) })));
router.get('/:ref/download.xlsx', ah(async (req, res) => { const v = await R.adminOne(req.params.ref); send(res, R.exportFile({ ...v, quote: v.quote }), v.ref + '.xlsx', XLSX); }));
router.post('/:ref/assign', ah(async (req, res) => { await R.assign(req.params.ref, (req.body || {}).user_id, req.user); res.json({ ok: true }); }));
router.post('/:ref/status', ah(async (req, res) => { const b = req.body || {}; await R.setStatus(req.params.ref, String(b.status || ''), b.note || '', req.user); res.json({ ok: true }); }));
router.put('/:ref/quote', ah(async (req, res) => { await R.saveQuote(req.params.ref, req.body || {}, req.user); res.json({ ok: true }); }));
router.post('/:ref/send', ah(async (req, res) => { await R.sendQuote(req.params.ref, req.user); res.json({ ok: true }); }));
router.post('/:ref/convert', ah(async (req, res) => res.json({ ok: true, sales_ref: await R.convert(req.params.ref, req.user) })));
router.post('/:ref/files', express.json({ limit: '8mb' }), ah(async (req, res) => res.json({ ok: true, ...(await R.addFile(req.user, req.params.ref, req.body || {}, true)) })));
router.get('/:ref/files/:id', ah(async (req, res) => { const f = await R.readFile(req.user, req.params.ref, req.params.id, true); send(res, f.buf, f.name, f.mime); }));
module.exports = router;
