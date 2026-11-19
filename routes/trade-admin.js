'use strict';
// Global Trade administration API. Mounted at /api/admin/trade (inside routes/admin.js, so sign-in, role checks and the activity log already apply).
// Permission: the "trade" module (view to read, edit to change). See lib/staff.js.
const express = require('express');
const T = require('../lib/trade/core');
const A = require('../lib/trade/admin');
const FX = require('../lib/trade/fx');
const P = require('../lib/trade/products');
const SC = require('../lib/trade/shipping-config');
const EX = require('../lib/trade/export');
const S = require('../lib/shop');
const { fail } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const big = express.json({ limit: '14mb' });
const ip = (req) => req.clientIp || req.ip || '';

router.get('/dashboard', ah(async (req, res) => res.json(await A.dashboard(req.query))));

router.get('/settings', ah(async (req, res) => res.json({ settings: await T.settings(), schema: Object.fromEntries(Object.entries(T.SCHEMA).map(([k, d]) => [k, { type: d.type, label: d.label, options: d.options || null, min: d.min, max: d.max }])) })));
router.put('/settings', ah(async (req, res) => res.json({ settings: await T.saveSettings(req.body, req.user, ip(req)) })));

router.get('/countries', ah(async (req, res) => res.json({ countries: await A.countries(req.query) })));
router.post('/countries/bulk', ah(async (req, res) => res.json(await A.bulkCountries(req.body || {}, req.user, ip(req)))));
router.put('/countries/:code', ah(async (req, res) => res.json({ country: await A.saveCountry(req.params.code, req.body, req.user, ip(req)) })));

router.get('/currencies', ah(async (req, res) => res.json({ currencies: await A.currencies() })));
router.put('/currencies/:code', ah(async (req, res) => res.json({ currencies: await A.saveCurrency(req.params.code, req.body || {}, req.user, ip(req)) })));
router.get('/rates', ah(async (req, res) => res.json({ rates: await FX.table(), auto_refresh: (await T.settings()).fx_refresh_enabled === '1' })));
router.post('/rates/refresh', ah(async (req, res) => {
  try { const r = await FX.refresh(); await T.audit(req.user, 'rates.refresh', 'trade_exchange_rates', '', r, ip(req)); res.json({ ok: true, ...r, rates: await FX.table() }); }
  catch (e) { fail(502, e.message); }
}));
router.post('/rates/manual', ah(async (req, res) => { const b = req.body || {}; await FX.setManual(b.quote, b.rate, req.user, ip(req), b.note); res.json({ ok: true, rates: await FX.table() }); }));

router.get('/products', ah(async (req, res) => res.json(await P.list(req.query))));
router.get('/products/template.xlsx', ah(async (req, res) => {
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="velto-mart-trade-product-template.xlsx"', 'Cache-Control': 'no-store' }).send(P.template());
}));
router.get('/products/export', ah(async (req, res) => {
  const f = await P.exportFile(req.query.format === 'csv' ? 'csv' : 'xlsx', ['export', 'import'].includes(req.query.filter) ? req.query.filter : '');
  res.set({ 'Content-Type': f.type, 'Content-Disposition': `attachment; filename="velto-mart-trade-products-${new Date().toISOString().slice(0, 10)}.${f.ext}"`, 'X-Row-Count': String(f.count), 'Cache-Control': 'no-store' }).send(f.buffer);
}));
const fileOf = (b) => { const m = /^(?:data:[^;]*;base64,)?([A-Za-z0-9+/=\s]+)$/.exec(String((b || {}).data || '')); if (!m) fail(400, 'Please choose a file.'); const buf = Buffer.from(m[1], 'base64'); if (buf.length > 8 * 1024 * 1024) fail(400, 'That file is over 8 MB. Split it into smaller files.'); return buf; };
router.post('/products/import/preview', big, ah(async (req, res) => { const p = await P.preview(fileOf(req.body), req.body.filename); res.json({ total: p.total, ok: p.rows.length, errors: p.errors, sample: p.rows.slice(0, 10).map((r) => ({ row: r.row, product: r.label, export_enabled: r.next.export_enabled, hs_code: r.next.hs_code, origin_country: r.next.origin_country })) }); }));
router.post('/products/import/commit', big, ah(async (req, res) => res.json(await P.commit(fileOf(req.body), req.body.filename, req.user, ip(req)))));
router.get('/products/:id', ah(async (req, res) => res.json(await P.getOne(Number(req.params.id)))));
router.put('/products/:id', ah(async (req, res) => res.json(await P.save(req.params.id, req.body, req.user, ip(req)))));

/* shipping and duty configuration */
const crud = (path, list, save, del) => {
  router.get(path, ah(async (req, res) => res.json({ items: await list(req.query) })));
  router.post(path, ah(async (req, res) => res.json({ item: await save(0, req.body || {}, req.user, ip(req)) })));
  router.put(path + '/:id', ah(async (req, res) => res.json({ item: await save(Number(req.params.id), req.body || {}, req.user, ip(req)) })));
  router.delete(path + '/:id', ah(async (req, res) => res.json(await del(Number(req.params.id), req.user, ip(req)))));
};
crud('/shipping/zones', SC.zones, SC.saveZone, SC.deleteZone); crud('/shipping/services', SC.services, SC.saveService, SC.deleteService);
crud('/shipping/rates', SC.rules, SC.saveRule, SC.deleteRule); crud('/shipping/duty-rules', SC.dutyRules, SC.saveDutyRule, SC.deleteDutyRule);

/* international orders */
router.get('/orders', ah(async (req, res) => res.json(await EX.listOrders(req.query))));
router.get('/orders/:ref', ah(async (req, res) => res.json(await EX.getOrder(req.params.ref))));
router.get('/orders/:ref/list/:kind', ah(async (req, res) => res.json(await EX.pickingList(req.params.ref, req.params.kind))));
router.post('/orders/:ref/status', ah(async (req, res) => res.json(await EX.setStatus(req.params.ref, req.body || {}, req.user, ip(req)))));
router.post('/orders/:ref/pack', ah(async (req, res) => res.json(await EX.pack(req.params.ref, req.body || {}, req.user, ip(req)))));
router.post('/orders/:ref/event', ah(async (req, res) => res.json(await EX.addTrackingEvent(req.params.ref, req.body || {}, req.user, ip(req)))));

router.get('/audit', ah(async (req, res) => res.json(await A.auditLog(req.query))));

module.exports = router;
