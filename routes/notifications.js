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
// Phone / browser alerts (Web Push).
const PUSH = require('../lib/push');
router.get('/push', ah(async (req, res) => res.json({ enabled: PUSH.enabled(), key: PUSH.publicKey(), devices: await PUSH.mine(req.user) })));
router.post('/push/subscribe', A.limiter('push-sub', 30, 3600000), ah(async (req, res) => res.json(await PUSH.subscribe(req.user, req.body || {}, req.headers['user-agent']))));
router.post('/push/unsubscribe', ah(async (req, res) => res.json(await PUSH.unsubscribe(req.user, req.body || {}))));
module.exports = router;
