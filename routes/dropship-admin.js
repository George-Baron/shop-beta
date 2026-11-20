'use strict';
// Admin: dropshipping. Mounted inside routes/admin.js AFTER the audit-log middleware, so every change is written to the activity log.
const express = require('express');
const { run, now } = require('../lib/db');
const S = require('../lib/shop');
const A = require('../lib/auth');
const SUP = require('../lib/suppliers');
const C = require('../lib/countries');
const D = require('../lib/dropship');
const IMP = require('../lib/dropship-import');
const { all } = require('../lib/db');
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

/* ---------- settings, exchange rates, category margins ---------- */
router.get('/settings', ah(async (req, res) => res.json({ settings: await D.settings(), rates: await D.listRates(), category_margins: await D.categoryMargins(),
  categories: await all('SELECT id, store, name FROM categories ORDER BY store, sort, name') })));
router.put('/settings', ah(async (req, res) => res.json({ ok: true, settings: await D.saveSettings(req.body || {}) })));
router.put('/rates/:currency', ah(async (req, res) => { await D.setRate(req.user, req.params.currency, req.body && req.body.ngn_per_unit); res.json({ ok: true, ...(await D.listRates()) }); }));
router.put('/category-margins/:id', ah(async (req, res) => { await D.setCategoryMargin(req.params.id, str(req.body && req.body.margin_type, 10), req.body && req.body.margin_value); res.json({ ok: true }); }));

/* ---------- dropship products ---------- */
router.get('/products', ah(async (req, res) => res.json({ products: await D.list({ listing: req.query.listing, supplier_id: req.query.supplier_id, q: req.query.q }) })));
router.post('/products', ah(async (req, res) => res.json({ ok: true, id: await D.create(req.user, req.body || {}) })));
// Works out the price for what is on the form without saving anything, so the admin sees cost, fees, break-even and profit while typing.
router.post('/price-preview', ah(async (req, res) => {
  const { d, sup } = await D.parse({ name: 'preview', store: (await all('SELECT slug FROM stores WHERE slug <> ? LIMIT 1', 'pharmacy'))[0].slug, supplier_sku: 'x', ...(req.body || {}) });
  const ctx = await D.context(), manual = d.price_mode === 'manual' && d.price > 0;
  res.json({ pricing: D.calcFor(ctx, d, sup, d.category_id, manual ? d.price : null) });
}));
router.get('/products/:id', ah(async (req, res) => res.json(await D.detail(req.params.id))));
router.put('/products/:id', ah(async (req, res) => { await D.update(req.user, req.params.id, req.body || {}); res.json({ ok: true, ...(await D.detail(req.params.id)) }); }));
router.post('/products/:id/reprice', ah(async (req, res) => { await D.reprice(req.params.id); res.json({ ok: true, ...(await D.detail(req.params.id)) }); }));
router.post('/products/:id/review', ah(async (req, res) => { await D.review(req.user, req.params.id, req.body && req.body.decision, req.body && req.body.note); res.json({ ok: true, ...(await D.detail(req.params.id)) }); }));

/* ---------- catalogue import (the larger body is only read after the admin check; see server.js) ---------- */
router.post('/import/preview', A.limiter('dsimport', 40, 3600000), express.json({ limit: '6mb' }), ah(async (req, res) => res.json(await IMP.preview(req.body || {}))));
router.post('/import/commit', A.limiter('dscommit', 20, 3600000), express.json({ limit: '6mb' }), ah(async (req, res) => res.json({ ok: true, ...(await IMP.commit(req.user, req.body || {})) })));

router.use('/supplier-orders', require('./supplier-orders-admin')); // purchase orders, supplier order numbers, tracking, problems and refunds
router.use('/money', require('./dropship-money-admin')); // payables, extra costs, refunds, returns to the supplier, profit reports
router.use('/trade', require('./trade-admin')); // shipments, trade documents, landed cost, compliance reminders and restricted items
router.use('/regions', require('./regions-admin')); // countries, shipping zones, currencies, tax and restricted products

module.exports = router;
