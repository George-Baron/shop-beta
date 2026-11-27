'use strict';
// VELTO REWARDS API. Mounted at /api/loyalty and /api/mobile/v1/loyalty. Customers only ever reach their own account (the owner is req.user).
const express = require('express');
const A = require('../lib/auth');
const ST = require('../lib/staff');
const L = require('../lib/loyalty');
const S = require('../lib/shop');
const { get, all } = require('../lib/db');
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const customer = express.Router();
customer.use(A.requireUser);
customer.get('/', ah(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await L.overview(req.user)); }));
customer.get('/history', ah(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await L.history(req.user, req.query)); }));
customer.get('/referrals', ah(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await L.myReferrals(req.user)); }));
customer.post('/redeem', A.limiter('loyalty-redeem', 20, 3600000), ah(async (req, res) => res.json(await L.redeemToWallet(req.user, req.body || {}, req.get('Idempotency-Key') || (req.body && req.body.idempotencyKey)))));

const admin = express.Router();
admin.use(A.requireBackoffice);
admin.get('/config', ST.walletGate('view'), ah(async (req, res) => res.json({ config: await L.config(), tiers: await all('SELECT * FROM loyalty_tiers ORDER BY min_lifetime') })));
admin.put('/config', ST.walletGate('owner'), ah(async (req, res) => res.json({ config: await L.setConfig(req.body || {}) })));
admin.put('/tiers/:name', ST.walletGate('owner'), ah(async (req, res) => res.json({ tiers: await L.setTier(req.params.name, req.body || {}) })));
admin.get('/report', ST.walletGate('view'), ah(async (req, res) => res.json(await L.report())));
admin.post('/sweep', ST.walletGate('owner'), ah(async (req, res) => res.json(await L.sweep())));
admin.get('/customers/:id', ST.walletGate('view'), ah(async (req, res) => {
  const id = S.int(req.params.id), u = await get('SELECT id,name,email FROM users WHERE id=?', id); if (!u) S.fail(404, 'Not found.');
  res.json({ customer: u, rewards: await L.overview(u), history: (await L.history(u, req.query)).entries });
}));
admin.post('/customers/:id/adjust', ST.walletGate('owner'), ah(async (req, res) => { const r = await L.adminAdjust(S.int(req.params.id), req.body || {}, req.user); res.json({ ok: true, replayed: r.replayed }); }));

admin.get('/referrals', ST.walletGate('view'), ah(async (req, res) => res.json({ referrals: await L.adminReferrals(S.str(req.query.status, 12)) })));
admin.post('/referrals/:id/reject', ST.walletGate('edit'), ah(async (req, res) => { await L.rejectReferral(S.int(req.params.id), req.body && req.body.reason); res.json({ ok: true }); }));
admin.get('/campaigns', ST.walletGate('view'), ah(async (req, res) => res.json({ campaigns: await L.listCampaigns() })));
admin.post('/campaigns', ST.walletGate('owner'), ah(async (req, res) => res.json({ campaign: await L.saveCampaign(0, req.body) })));
admin.put('/campaigns/:id', ST.walletGate('owner'), ah(async (req, res) => res.json({ campaign: await L.saveCampaign(S.int(req.params.id), req.body) })));

module.exports = { customer, admin };
