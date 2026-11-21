'use strict';
// VELTO WALLET API. Mounted at /api/wallet and /api/mobile/v1/wallet (same handlers for the website and the apps).
// Customers only ever see their own wallet: the owner is always req.user, never an id from the request.
const express = require('express');
const A = require('../lib/auth');
const W = require('../lib/wallet');
const S = require('../lib/shop');
const { get, all } = require('../lib/db');
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const customer = express.Router();
customer.use(A.requireUser);
customer.get('/', ah(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await W.overview(req.user)); }));
customer.get('/transactions', ah(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await W.history(req.user, req.query)); }));
customer.get('/statement.csv', ah(async (req, res) => { res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="velto-wallet-statement.csv"', 'Cache-Control': 'no-store' }); res.send(await W.statement(req.user, req.query)); }));
// Shows what the wallet would cover before the customer confirms. Display only; nothing is held or charged.
customer.post('/preview', A.limiter('wallet-preview', 60, 600000), ah(async (req, res) => res.json(await W.preview(req.user, req.body || {}))));
customer.post('/fund', A.limiter('wallet-fund', 10, 3600000), ah(async (req, res) => res.json(await W.initFunding(req.user, req.body))));
// The customer coming back from the payment page. We still ask the gateway; the browser's word is never enough.
customer.get('/fund/:ref', A.limiter('wallet-verify', 40, 600000), ah(async (req, res) => {
  const ref = S.str(req.params.ref, 20).toUpperCase();
  const f = await get('SELECT user_id FROM wallet_funding WHERE ref=?', ref);
  if (!f || Number(f.user_id) !== Number(req.user.id)) S.fail(404, 'Not found.');
  const r = await W.settleFunding(ref);
  res.json({ ref, status: r.status });
}));

const admin = express.Router();
admin.use(A.requireAdmin);
admin.get('/reconcile', ah(async (req, res) => res.json(await W.reconcile())));
admin.get('/customers/:id', ah(async (req, res) => {
  const id = S.int(req.params.id), u = await get('SELECT id,name,email FROM users WHERE id=?', id); if (!u) S.fail(404, 'Not found.');
  res.json({ customer: u, wallet: await W.overview(u), transactions: (await W.history(u, req.query)).transactions, audit: await all('SELECT action,actor_name,detail,created FROM wallet_audit WHERE user_id=? ORDER BY id DESC LIMIT 50', id) });
}));
admin.post('/customers/:id/freeze', ah(async (req, res) => { await W.setFrozen(S.int(req.params.id), true, req.body && req.body.reason, req.user); res.json({ ok: true }); }));
admin.post('/customers/:id/unfreeze', ah(async (req, res) => { await W.setFrozen(S.int(req.params.id), false, '', req.user); res.json({ ok: true }); }));
admin.post('/customers/:id/adjust', ah(async (req, res) => res.json(await W.adjust(S.int(req.params.id), req.body || {}, req.user))));

module.exports = { customer, admin };
