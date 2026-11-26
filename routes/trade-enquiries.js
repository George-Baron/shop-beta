'use strict';
// Public: POST /api/trade-enquiries (the Import & Export page form).  Admin: /api/admin/trade-enquiries (Requests for quotation module).
const express = require('express');
const A = require('../lib/auth');
const S = require('../lib/shop');
const T = require('../lib/trade-enquiries');
const ah = (f) => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next);

const pub = express.Router();
pub.post('/', A.limiter('trade-enquiry', 5, 3600000), ah(async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true, ref: 'TE-00000000' });   // honeypot: real visitors never fill this in
  res.json({ ok: true, ...(await T.create(b, req.user)) });
}));

const admin = express.Router();
admin.get('/', ah(async (req, res) => res.json(await T.list(req.query))));
admin.put('/:id', ah(async (req, res) => res.json({ ok: true, enquiry: await T.update(S.int(req.params.id), req.user, req.body || {}) })));
module.exports = { pub, admin };
