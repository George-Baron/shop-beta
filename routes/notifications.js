'use strict';
// A signed-in person's own notifications (any role).
const express = require('express');
const A = require('../lib/auth');
const N = require('../lib/notify');
const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(A.requireUser);
router.get('/', ah(async (req, res) => res.json(await N.list(req.user, req.query))));
router.get('/count', ah(async (req, res) => res.json({ unread: await N.count(req.user) })));
router.post('/read', ah(async (req, res) => { await N.markRead(req.user, req.body || {}); res.json({ ok: true, unread: await N.count(req.user) }); }));
module.exports = router;
