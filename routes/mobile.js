'use strict';
// /api/mobile/v1/auth and the account summary, for the Android and iOS apps (the website can use the summary too).
const express = require('express');
const A = require('../lib/auth');
const M = require('../lib/mobile-auth');
const S = require('../lib/shop');
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const auth = express.Router();
auth.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
auth.post('/login', ah(async (req, res) => res.json(await M.login(req))));
auth.post('/refresh', A.limiter('mobile-refresh', 60, 600000), ah(async (req, res) => res.json(await M.refresh(req))));
auth.post('/logout', A.requireUser, ah(async (req, res) => { if (req.deviceSessionId) await M.revoke(req.user, req.deviceSessionId); res.json({ ok: true }); }));
auth.post('/logout-all', A.requireUser, ah(async (req, res) => { await M.revokeAll(req.user.id); res.json({ ok: true }); }));
auth.get('/devices', A.requireUser, ah(async (req, res) => res.json({ devices: await M.devices(req.user, req.deviceSessionId || 0) })));
auth.delete('/devices/:id', A.requireUser, ah(async (req, res) => { if (!(await M.revoke(req.user, S.int(req.params.id), 'removed by owner'))) S.fail(404, 'Device not found.'); res.json({ ok: true }); }));

const account = express.Router();
account.use(A.requireUser);
account.get('/', ah(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await require('../lib/account').summary(req.user)); }));
module.exports = { auth, account };
