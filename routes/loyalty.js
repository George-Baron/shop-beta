'use strict';
// VELTO REWARDS API. Mounted at /api/loyalty and /api/mobile/v1/loyalty. Customers only ever reach their own account (the owner is req.user).
const express = require('express');
const A = require('../lib/auth');
const L = require('../lib/loyalty');
const S = require('../lib/shop');
const { get, all } = require('../lib/db');
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const customer = express.Router();
customer.use(A.requireUser);
customer.get('/', ah(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await L.overview(req.user)); }));
customer.get('/history', ah(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await L.history(req.user, req.query)); }));
customer.post('/redeem', A.limiter('loyalty-redeem', 20, 3600000), ah(async (req, res) => res.json(await L.redeemToWallet(req.user, req.body || {}, req.get('Idempotency-Key') || (req.body && req.body.idempotencyKey)))));

const admin = express.Router();
admin.use(A.requireAdmin);
admin.get('/config', ah(async (req, res) => res.json({ config: await L.config(), tiers: await all('SELECT * FROM loyalty_tiers ORDER BY min_lifetime') })));
admin.put('/config', ah(async (req, res) => res.json({ config: await L.setConfig(req.body || {}) })));
admin.put('/tiers/:name', ah(async (req, res) => res.json({ tiers: await L.setTier(req.params.name, req.body || {}) })));
admin.get('/report', ah(async (req, res) => res.json(await L.report())));
admin.post('/sweep', ah(async (req, res) => res.json(await L.sweep())));
admin.get('/customers/:id', ah(async (req, res) => {
  const id = S.int(req.params.id), u = await get('SELECT id,name,email FROM users WHERE id=?', id); if (!u) S.fail(404, 'Not found.');
  res.json({ customer: u, rewards: await L.overview(u), history: (await L.history(u, req.query)).entries });
}));
admin.post('/customers/:id/adjust', ah(async (req, res) => { const r = await L.adminAdjust(S.int(req.params.id), req.body || {}, req.user); res.json({ ok: true, replayed: r.replayed }); }));

module.exports = { customer, admin };
