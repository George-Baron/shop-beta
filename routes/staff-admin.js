'use strict';
// Owner only: employees, roles and permissions, login history, activity and performance. Mounted at /api/admin/staff.
const express = require('express');
const St = require('../lib/staff');
const S = require('../lib/shop');
const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', ah(async (req, res) => res.json({ staff: await St.listStaff(), roles: await St.listRoles(), modules: St.MODULES.map(([key, label, about]) => ({ key, label, about })) })));
router.post('/', ah(async (req, res) => res.json({ ok: true, ...(await St.createStaff(req.body || {}, req.user.name)) })));
router.get('/performance', ah(async (req, res) => res.json({ performance: await St.performance(req.query.days) })));
router.post('/roles', ah(async (req, res) => res.json({ ok: true, id: await St.saveRole(0, req.body || {}) })));
router.put('/roles/:id', ah(async (req, res) => res.json({ ok: true, id: await St.saveRole(S.int(req.params.id), req.body || {}) })));
router.delete('/roles/:id', ah(async (req, res) => { await St.deleteRole(S.int(req.params.id)); res.json({ ok: true }); }));
router.put('/:id', ah(async (req, res) => { await St.updateStaff(S.int(req.params.id), req.body || {}, req.user); res.json({ ok: true }); }));
router.post('/:id/reset-password', ah(async (req, res) => res.json({ ok: true, ...(await St.resetPassword(S.int(req.params.id), req.user)) })));
router.get('/:id/logins', ah(async (req, res) => res.json({ logins: await St.loginHistory(S.int(req.params.id)) })));
router.get('/:id/activity', ah(async (req, res) => res.json({ activity: await St.activity(S.int(req.params.id)) })));

module.exports = router;
