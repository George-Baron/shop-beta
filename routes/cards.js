'use strict';
// VELTO-MART CARD API: /api/cards and /api/mobile/v1/cards. The webhook is called by the issuer, not by customers.
const express = require('express');
const A = require('../lib/auth');
const ST = require('../lib/staff');
const C = require('../lib/cards');
const S = require('../lib/shop');
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const webhook = express.Router();
webhook.post('/', ah(async (req, res) => {
  const p = C.provider(); if (!p) return res.status(503).json({ error: 'Not enabled' });
  if (!p.verifyWebhook(req.rawBody, req.headers)) return res.status(401).json({ error: 'Bad signature' });
  res.json(await C.handleEvent(p.name, p.parseWebhook(req.body || {})));
}));

const customer = express.Router();
customer.use(A.requireUser);
customer.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
customer.get('/', ah(async (req, res) => res.json(await C.overview(req.user))));
customer.post('/apply', A.limiter('card-apply', 5, 3600000), ah(async (req, res) => res.json({ application: await C.apply(req.user, req.body) })));
customer.get('/:id/transactions', ah(async (req, res) => res.json(await C.transactions(req.user, req.params.id, req.query))));
customer.get('/:id/reveal', A.limiter('card-reveal', 10, 600000), ah(async (req, res) => res.json(await C.reveal(req.user, req.params.id))));
for (const a of ['activate', 'freeze', 'unfreeze', 'block']) customer.post(`/:id/${a}`, A.limiter('card-control', 30, 3600000), ah(async (req, res) => res.json({ card: await C.control(req.user, req.params.id, a, req.body) })));
customer.post('/:id/replace', A.limiter('card-replace', 5, 3600000), ah(async (req, res) => res.json({ application: await C.replace(req.user, req.params.id, req.body) })));

const admin = express.Router();
admin.use(A.requireBackoffice);
admin.get('/applications', ST.walletGate('view'), ah(async (req, res) => res.json({ applications: await C.adminList(S.str(req.query.status, 20)) })));
admin.get('/applications/:id', ST.walletGate('view'), ah(async (req, res) => res.json(await C.adminDetail(req.params.id))));
admin.post('/:id/block', ST.walletGate('edit'), ah(async (req, res) => { await C.adminBlock(req.params.id, req.body && req.body.reason, req.user); res.json({ ok: true }); }));
admin.get('/report', ST.walletGate('view'), ah(async (req, res) => res.json(await C.adminReport())));

module.exports = { customer, admin, webhook };
