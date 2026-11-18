'use strict';
// Commercial operations workspace and reports. Mounted at /api/admin/commercial (permissions are set in lib/staff.js RULES).
const express = require('express');
const C = require('../lib/commercial');
const S = require('../lib/shop');
const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/overview', ah(async (req, res) => res.json(await C.overview(req.user, req.query))));
router.get('/officers', ah(async (req, res) => res.json({ officers: await C.partnerOfficers() })));
router.post('/partners/:id/officer', ah(async (req, res) => { await C.assignOfficer(req.params.id, (req.body || {}).user_id, req.user); res.json({ ok: true }); }));
router.get('/reports', ah(async (req, res) => res.json({ reports: C.LIST })));
// Employee activity is sensitive: the owner, or someone whose role has Edit on Reports (a manager), not every reader of reports.
const staffOnly = ah(async (req, res, next) => { if (req.params.name === 'employee-performance' && !(await C.canSeeEmployees(req.user))) throw new S.HttpError(403, 'Employee performance is for the store owner and managers.'); next(); });
router.get('/reports/:name', staffOnly, ah(async (req, res) => res.json({ report: await C.report(req.params.name, req.query) })));
router.get('/reports/:name/download', staffOnly, ah(async (req, res) => {
  const rep = await C.report(req.params.name, req.query), f = C.file(rep, req.query.format === 'csv' ? 'csv' : 'xlsx');
  res.set({ 'Content-Type': f.type, 'Content-Disposition': `attachment; filename="${rep.name}-${new Date().toISOString().slice(0, 10)}.${f.ext}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }).send(f.buf);
}));
module.exports = router;
