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
  const rep = await C.report(req.params.name, req.query), f = await C.fileAs(rep, req.query.format);
  res.set({ 'Content-Type': f.type, 'Content-Disposition': `attachment; filename="${rep.name}-${new Date().toISOString().slice(0, 10)}.${f.ext}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }).send(f.buf);
}));

// Reports emailed on a schedule (to employees only). Needs Reports: Edit to change; see lib/report-schedule.js.
const RS = require('../lib/report-schedule');
router.get('/schedules', ah(async (req, res) => {
  const { all } = require('../lib/db');
  const people = (await all("SELECT id, name, email, role FROM users WHERE role IN ('staff','admin') AND COALESCE(active,1)=1 ORDER BY name")).map((u) => ({ id: Number(u.id), name: u.name, email: u.email, owner: u.role === 'admin' }));
  res.json({ schedules: await RS.list(), people, frequencies: RS.FREQ, reports: [...C.LIST.map((r) => ({ ...r, source: 'commercial' })), ...require('../lib/wh-reports').LIST.map((r) => ({ ...r, source: 'warehouse' }))] });
}));
router.post('/schedules', ah(async (req, res) => res.json({ ok: true, id: await RS.create(req.body || {}, req.user) })));
router.put('/schedules/:id', ah(async (req, res) => { await RS.update(S.int(req.params.id), req.body || {}); res.json({ ok: true }); }));
router.delete('/schedules/:id', ah(async (req, res) => { await RS.remove(S.int(req.params.id)); res.json({ ok: true }); }));
router.post('/schedules/:id/send', ah(async (req, res) => res.json({ ok: true, note: await RS.sendNow(S.int(req.params.id)) })));
module.exports = router;
