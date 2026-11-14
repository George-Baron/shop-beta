'use strict';
// Customer and pharmacist endpoints for the pharmacy department. Every route answers 404 while PHARMACY_ENABLED is off.
const express = require('express');
const PC = require('../lib/pharmacy-core');
const P = require('../lib/pharmacy');
const S = require('../lib/shop');
const A = require('../lib/auth');
const { fail, int, str } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use((req, res, next) => (PC.enabled() ? next() : res.status(404).json({ error: 'Not found.' })));

/* ----- customer ----- */
router.get('/me', A.requireUser, ah(async (req, res) => {
  const s = await S.getSettings();
  res.json({ identity: P.publicIdentity(await P.identityOf(req.user.id)), prescriptions: await P.myPrescriptions(req.user), settings: { return_days: Number(s.pharm_return_days || 7) } });
}));
router.post('/phone/start', A.requireUser, A.limiter('rx-otp', 10, 3600000), ah(async (req, res) => res.json(await P.startPhoneVerification(req.user, req.body && req.body.phone))));
router.post('/phone/confirm', A.requireUser, A.limiter('rx-otp-confirm', 20, 3600000), ah(async (req, res) => res.json({ identity: await P.confirmPhone(req.user, req.body && req.body.code) })));
router.post('/identity', A.requireUser, A.limiter('rx-id', 10, 3600000), ah(async (req, res) => res.json({ identity: await P.submitIdentity(req.user, req.body || {}) })));
// The larger body is only read here, after the sign-in check.
router.post('/prescriptions', A.requireUser, A.limiter('rx-upload', 12, 3600000), express.json({ limit: '6mb' }), ah(async (req, res) => res.json(await P.createPrescription(req.user, req.clientIp, req.body || {}))));
router.get('/prescriptions/:id/file', A.requireUser, ah(async (req, res) => {
  const f = await P.openFile(req.user, req.clientIp, int(req.params.id));
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline; filename="prescription"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" }).send(f.buf);
}));
router.post('/orders/:ref/prescription', A.requireUser, A.limiter('rx-add', 20, 3600000), ah(async (req, res) => { await P.addPrescriptionToOrder(req.user, req.clientIp, req.params.ref, req.body && req.body.prescriptionId); res.json({ ok: true }); }));
router.post('/orders/:ref/pay', A.requireUser, A.limiter('rx-pay', 20, 3600000), ah(async (req, res) => {
  const o = await S.loadOrder('ref=? AND user_id=?', str(req.params.ref, 20), req.user.id);
  if (!o || !o.is_pharmacy) fail(404, 'Order not found.');
  res.json(await P.payAfterApproval(o));
}));
router.post('/returns', A.requireUser, A.limiter('rx-return', 10, 3600000), ah(async (req, res) => res.json(await P.requestReturn(req.user, req.body || {}))));

/* ----- pharmacist (partner pharmacy) and our superintendent pharmacist ----- */
const staff = express.Router();
staff.use(A.requirePharmacist);
staff.get('/queue', ah(async (req, res) => res.json({ orders: await P.myQueue(req.user), superintendent: P.isSuper(req.user) })));
staff.get('/orders/:id', ah(async (req, res) => res.json(await P.reviewOrder(req.user, req.clientIp, int(req.params.id)))));
staff.post('/orders/:id/decision', A.limiter('rx-decide', 120, 3600000), ah(async (req, res) => res.json(await P.decide(req.user, req.clientIp, int(req.params.id), req.body || {}))));
staff.get('/prescriptions/:id/file', ah(async (req, res) => {
  const f = await P.openFile(req.user, req.clientIp, int(req.params.id));
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline; filename="prescription"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" }).send(f.buf);
}));
staff.get('/products', ah(async (req, res) => res.json({ products: await P.productsToApprove(req.user) })));
staff.put('/products/:id/details', ah(async (req, res) => { await P.saveMedFields(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
staff.post('/products/:id/decision', ah(async (req, res) => { await P.decideProduct(req.user, req.clientIp, req.params.id, req.body || {}); res.json({ ok: true }); }));
staff.get('/flags', ah(async (req, res) => { if (!P.isSuper(req.user)) fail(403, 'Only the superintendent pharmacist reviews flags.'); res.json({ flags: await P.listFlags(str(req.query.status, 10) || 'open') }); }));
staff.post('/flags/:id', ah(async (req, res) => { await P.resolveFlag(req.user, req.clientIp, int(req.params.id), req.body && req.body.status, req.body && req.body.note); res.json({ ok: true }); }));
staff.get('/returns', ah(async (req, res) => res.json({ returns: await P.listReturns(req.user) })));
staff.put('/returns/:id', ah(async (req, res) => { await P.updateReturn(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
router.use('/staff', staff);

module.exports = router;
