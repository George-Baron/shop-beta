'use strict';
// Admin side of the pharmacy department. Administrators manage pharmacies, accounts, settings and flags; they cannot open prescriptions.
const express = require('express');
const PC = require('../lib/pharmacy-core');
const P = require('../lib/pharmacy');
const S = require('../lib/shop');
const A = require('../lib/auth');
const PW = require('../lib/passwords');
const { all } = require('../lib/db');
const { fail, int, str } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(A.requireAdmin);
// The readiness checklist and settings work while the department is off, so everything can be prepared before it is switched on.
router.get('/readiness', ah(async (req, res) => res.json(await P.readiness())));
router.get('/settings', ah(async (req, res) => { const s = await S.getSettings(); res.json({ enabled: PC.enabled(), settings: Object.fromEntries(P.SETTING_KEYS.map((k) => [k, s[k] || ''])) }); }));
router.put('/settings', ah(async (req, res) => { await P.saveSettings(req.body || {}); res.json({ ok: true }); }));

router.get('/pharmacies', ah(async (req, res) => res.json({ pharmacies: await P.listPharmacies(), partners: await all('SELECT id, name FROM partners ORDER BY name') })));
router.post('/pharmacies', ah(async (req, res) => res.json({ ok: true, id: await P.savePharmacy(req.user, 0, req.body || {}) })));
router.put('/pharmacies/:id', ah(async (req, res) => res.json({ ok: true, id: await P.savePharmacy(req.user, int(req.params.id), req.body || {}) })));
router.put('/pharmacies/:id/agreement', express.json({ limit: '12mb' }), ah(async (req, res) => {
  const m = /^data:[a-z/+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.data) || ''));
  if (!m) fail(400, 'Please choose the signed agreement file.');
  await P.saveAgreement(int(req.params.id), Buffer.from(m[1], 'base64'), '', req.body.name); res.json({ ok: true });
}));
router.get('/pharmacies/:id/agreement', ah(async (req, res) => {
  const f = await P.openAgreement(req.user, req.clientIp, int(req.params.id));
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(f.buf);
}));
router.post('/pharmacies/:id/:action(submit|approve|suspend)', ah(async (req, res) => { await P.setPharmacyStatus(req.user, req.clientIp, int(req.params.id), req.params.action, req.body && req.body.note); res.json({ ok: true }); }));

router.get('/pharmacists', ah(async (req, res) => res.json({ pharmacists: await P.listPharmacists() })));
router.post('/pharmacists', ah(async (req, res) => res.json({ ok: true, id: await P.savePharmacist(0, req.body || {}, A, PW) })));
router.put('/pharmacists/:id', ah(async (req, res) => { const id = int(req.params.id); await P.savePharmacist(id, req.body || {}, A, PW); if (req.body && req.body.active === false) await A.dropUserSessions(id); res.json({ ok: true }); }));

router.get('/flags', ah(async (req, res) => res.json({ flags: await P.listFlags(str(req.query.status, 10) || 'open') })));
router.post('/flags/:id', ah(async (req, res) => { await P.resolveFlag(req.user, req.clientIp, int(req.params.id), req.body && req.body.status, req.body && req.body.note); res.json({ ok: true }); }));
router.get('/returns', ah(async (req, res) => res.json({ returns: await P.listReturns(req.user) })));
router.put('/returns/:id', ah(async (req, res) => { await P.updateReturn(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
router.get('/audit', ah(async (req, res) => res.json({ audit: await P.auditLog(int(req.query.limit, 200)) })));

module.exports = router;
