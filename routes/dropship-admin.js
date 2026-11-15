'use strict';
// Admin: dropshipping. Mounted inside routes/admin.js AFTER the audit-log middleware, so every change is written to the activity log.
const express = require('express');
const { run, now } = require('../lib/db');
const S = require('../lib/shop');
const A = require('../lib/auth');
const SUP = require('../lib/suppliers');
const C = require('../lib/countries');
const { fail, str, int } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const who = (req) => String(req.user.name || req.user.email).slice(0, 80);
// Reading a private document is not a change, so the activity log would miss it. Record it here.
const auditRead = (req, what) => run('INSERT INTO audit_log (user_id,user_name,method,path,status,detail,ip,created) VALUES (?,?,?,?,?,?,?,?)', req.user.id, who(req), 'GET', req.originalUrl.slice(0, 200), 200, what, String(req.clientIp || '').slice(0, 60), now());

router.get('/meta', ah(async (req, res) => res.json({ countries: C.countries(), currencies: C.currencies(), shipping_methods: SUP.METHODS })));

/* ---------- suppliers ---------- */
router.get('/suppliers', ah(async (req, res) => res.json({ suppliers: await SUP.list({ status: req.query.status, q: req.query.q }) })));
router.post('/suppliers', ah(async (req, res) => res.json({ ok: true, id: await SUP.create(req.user, req.body || {}) })));
router.get('/suppliers/:id', ah(async (req, res) => {
  const s = await SUP.load(req.params.id);
  res.json({ supplier: s, performance: await SUP.performance(s.id), events: await SUP.events(s.id), documents: await SUP.documents(s.id) });
}));
router.put('/suppliers/:id', ah(async (req, res) => { await SUP.update(req.params.id, req.body || {}); res.json({ ok: true }); }));

router.post('/suppliers/:id/events', ah(async (req, res) => { await SUP.addEvent(req.user, req.params.id, req.body || {}); res.json({ ok: true, performance: await SUP.performance(int(req.params.id)) }); }));

// The larger body is only read after the admin check (see the exception in server.js).
router.post('/suppliers/:id/documents', A.limiter('supdoc', 30, 3600000), express.json({ limit: '12mb' }), ah(async (req, res) => {
  const m = /^data:[a-z0-9/+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.data) || ''));
  if (!m) fail(400, 'Please choose a file.');
  res.json({ ok: true, id: await SUP.addDocument(req.user, int(req.params.id), str(req.body.kind, 15), Buffer.from(m[1], 'base64'), req.body.name) });
}));
router.get('/suppliers/:id/documents/:doc', ah(async (req, res) => {
  const f = await SUP.openDocument(req.params.id, req.params.doc);
  await auditRead(req, 'supplier document opened: ' + f.name);
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${f.name.replace(/"/g, '')}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }).send(f.buf);
}));
router.delete('/suppliers/:id/documents/:doc', ah(async (req, res) => { await SUP.removeDocument(req.params.id, req.params.doc); res.json({ ok: true }); }));

module.exports = router;
