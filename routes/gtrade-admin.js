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
const SUP = require('../lib/trade/suppliers');
const IM = require('../lib/trade/imports');
const PAY = require('../lib/trade/payments');
const TR = require('../lib/trade/tracking');
const NT = require('../lib/trade/notify');
const RP = require('../lib/trade/reports');
const AD = require('../lib/trade/advisor');
const ST = require('../lib/staff');
const S = require('../lib/shop');
const { fail } = S;
const A_LIM = require('../lib/auth').limiter('trade-ai', 30, 600000);

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


/* ---------- phase 4: international suppliers, purchase orders, import shipments ---------- */
const sendBuf = (res, f) => { res.setHeader('Content-Type', f.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', `attachment; filename="${String(f.name).replace(/[^\w.\- ]/g, '_')}"`); res.send(f.buf); };
const canMoney = async (req) => ST.allows(await ST.permsOf(req.user), 'finance', false);
router.get('/suppliers', ah(async (req, res) => res.json(await SUP.list(req.query))));
router.post('/suppliers', ah(async (req, res) => res.json({ supplier: await SUP.save(0, req.body || {}, req.user, ip(req)) })));
router.get('/suppliers/compare', ah(async (req, res) => res.json(await SUP.compare(req.query))));
router.get('/suppliers/catalogue-template', ah(async (req, res) => { const t = SUP.template(req.query.format === 'csv' ? 'csv' : 'xlsx'); res.setHeader('Content-Type', t.type); res.setHeader('Content-Disposition', `attachment; filename="supplier-catalogue-template.${t.ext}"`); res.send(t.buffer); }));
router.get('/suppliers/:id', ah(async (req, res) => { const d = await SUP.get(req.params.id); if (!(await canMoney(req))) { d.payments = []; d.balances = []; d.money_hidden = true; } res.json(d); }));
router.put('/suppliers/:id', ah(async (req, res) => res.json({ supplier: await SUP.save(Number(req.params.id), req.body || {}, req.user, ip(req)) })));
router.delete('/suppliers/:id', ah(async (req, res) => res.json(await SUP.remove(Number(req.params.id), req.user, ip(req)))));
router.get('/suppliers/:id/bank', ah(async (req, res) => { if (!ST.allows(await ST.permsOf(req.user), 'finance', true)) fail(403, 'Only people who can edit Finance may view supplier bank details.'); res.json(await SUP.getBank(Number(req.params.id), req.user, ip(req))); }));
router.put('/suppliers/:id/bank', ah(async (req, res) => res.json(await SUP.setBank(Number(req.params.id), (req.body || {}).details, req.user, ip(req)))));
router.post('/suppliers/:id/products', ah(async (req, res) => res.json({ item: await SUP.saveProduct(Number(req.params.id), 0, req.body || {}) })));
router.put('/suppliers/:id/products/:pid', ah(async (req, res) => res.json({ item: await SUP.saveProduct(Number(req.params.id), Number(req.params.pid), req.body || {}) })));
router.delete('/suppliers/:id/products/:pid', ah(async (req, res) => res.json(await SUP.deleteProduct(req.params.id, req.params.pid))));
router.post('/suppliers/:id/catalogue/preview', big, ah(async (req, res) => res.json(await SUP.previewCatalogue(Number(req.params.id), fileOf(req.body), req.body.filename))));
router.post('/suppliers/:id/catalogue/commit', big, ah(async (req, res) => res.json(await SUP.commitCatalogue(Number(req.params.id), fileOf(req.body), req.body.filename, req.user, ip(req)))));
router.post('/suppliers/:id/documents', big, ah(async (req, res) => { await SUP.load(req.params.id); res.json({ document: await SUP.addDocument({ supplier_id: Number(req.params.id) }, req.body || {}, fileOf(req.body), req.user, ip(req)) }); }));
router.get('/documents/:id', ah(async (req, res) => sendBuf(res, await SUP.fetchDocument(req.params.id))));
router.delete('/documents/:id', ah(async (req, res) => res.json(await SUP.removeDocument(req.params.id, req.user, ip(req)))));
/* money: the Finance permission is required by the route gate (lib/staff.js) */
router.get('/payments/suppliers', ah(async (req, res) => res.json(await SUP.listPayments(req.query))));
router.get('/payments/payables', ah(async (req, res) => res.json(await SUP.payables())));
router.post('/payments/suppliers/:id', ah(async (req, res) => res.json(await SUP.recordPayment(Number(req.params.id), req.body || {}, req.user, ip(req)))));
router.delete('/payments/suppliers/payment/:id', ah(async (req, res) => res.json(await SUP.deletePayment(req.params.id, req.user, ip(req)))));

router.get('/payments/providers', ah(async (req, res) => res.json(PAY.providers())));
router.get('/payments/reconciliation', ah(async (req, res) => res.json(await PAY.reconciliation(req.query))));
router.get('/payments', ah(async (req, res) => res.json(await PAY.list(req.query))));
router.post('/payments/:id/refund', ah(async (req, res) => res.json(await PAY.refund(Number(req.params.id), req.body || {}, req.user, ip(req)))));
router.post('/payments/:id/refresh', ah(async (req, res) => res.json(await PAY.refresh(Number(req.params.id), req.user, ip(req)))));
router.get('/reports', ah(async (req, res) => res.json({ reports: RP.list() })));
router.get('/reports/:key', ah(async (req, res) => res.json(await RP.run(req.params.key, req.query))));
router.get('/reports/:key/export', ah(async (req, res) => { const f = await RP.file(req.params.key, req.query, String(req.query.format || 'xlsx')); res.set({ 'Content-Type': f.type, 'Content-Disposition': `attachment; filename="${f.name}"`, 'Cache-Control': 'no-store' }); res.send(f.buf); }));
router.get('/assistant', ah(async (req, res) => res.json({ status: await AD.status(), ...(await AD.insights()) })));
router.get('/assistant/quotes/:ref', ah(async (req, res) => res.json(await AD.compareQuotes(req.params.ref))));
router.post('/assistant/chat', A_LIM, ah(async (req, res) => res.json(await AD.chat((req.body || {}).messages, req.user))));
router.get('/notifications', ah(async (req, res) => res.json(await NT.list(req.query))));
router.post('/notifications/sweep', ah(async (req, res) => res.json(await NT.sweep())));
router.get('/tracking', ah(async (req, res) => res.json(await TR.overview(req.query))));

router.get('/purchase-orders', ah(async (req, res) => res.json(await IM.listPOs(req.query))));
router.post('/purchase-orders', ah(async (req, res) => res.json(await IM.savePO(0, req.body || {}, req.user, ip(req)))));
router.get('/purchase-orders/:id', ah(async (req, res) => res.json(await IM.getPO(req.params.id))));
router.put('/purchase-orders/:id', ah(async (req, res) => res.json(await IM.savePO(Number(req.params.id), req.body || {}, req.user, ip(req)))));
router.post('/purchase-orders/:id/request-quotation', ah(async (req, res) => res.json(await IM.requestQuotation(req.params.id, req.body || {}, req.user, ip(req)))));
router.post('/purchase-orders/:id/approve', ah(async (req, res) => res.json(await IM.approvePO(req.params.id, req.user, ip(req)))));
router.post('/purchase-orders/:id/cancel', ah(async (req, res) => res.json(await IM.cancelPO(req.params.id, req.user, ip(req)))));
router.post('/purchase-orders/:id/documents', big, ah(async (req, res) => { await IM.getPO(req.params.id); res.json({ document: await SUP.addDocument({ po_id: Number(req.params.id) }, req.body || {}, fileOf(req.body), req.user, ip(req)) }); }));

router.get('/imports', ah(async (req, res) => res.json(await IM.listShips(req.query))));
router.get('/imports/:ref', ah(async (req, res) => res.json(await IM.getShip(req.params.ref))));
router.put('/imports/:ref', ah(async (req, res) => res.json(await IM.updateShip(req.params.ref, req.body || {}, req.user, ip(req)))));
router.post('/imports/:ref/status', ah(async (req, res) => res.json(await IM.setShipStatus(req.params.ref, (req.body || {}).status, req.body || {}, req.user, ip(req)))));
router.post('/imports/:ref/event', ah(async (req, res) => res.json(await IM.addShipEvent(req.params.ref, req.body || {}, req.user, ip(req)))));
router.post('/imports/:ref/documents', big, ah(async (req, res) => { const g = await IM.getShip(req.params.ref); res.json({ document: await SUP.addDocument({ import_shipment_id: g.shipment.id }, req.body || {}, fileOf(req.body), req.user, ip(req)) }); }));

const CAR = require('../lib/trade/carriers'), BK = require('../lib/trade/booking');
router.get('/providers', ah(async (req, res) => res.json(await CAR.list())));
router.put('/providers/:code', ah(async (req, res) => res.json(await CAR.update(req.params.code, req.body || {}, req.user, ip(req)))));
router.post('/providers/:code/test', ah(async (req, res) => res.json(await CAR.test(req.params.code))));
router.get('/orders/:ref/bookings', ah(async (req, res) => res.json(await BK.listBookings(req.params.ref))));
router.post('/orders/:ref/rates', ah(async (req, res) => res.json(await BK.getRates(req.params.ref, req.body || {}, req.user, ip(req)))));
router.post('/orders/:ref/book', ah(async (req, res) => res.json(await BK.book(req.params.ref, req.body || {}, req.user, ip(req)))));
router.post('/bookings/:id/cancel', ah(async (req, res) => res.json(await BK.cancel(req.params.id, req.user, ip(req)))));
router.post('/bookings/:id/refresh', ah(async (req, res) => res.json(await BK.refresh(req.params.id, req.user, ip(req)))));
const CUS = require('../lib/trade/customs'), RCV = require('../lib/trade/receiving');
router.get('/customs', ah(async (req, res) => res.json(await CUS.list(req.query))));
router.post('/customs/calc', ah(async (req, res) => res.json(await CUS.calc(req.body || {}))));
router.post('/customs/from-order/:ref', ah(async (req, res) => res.json(await CUS.fromExport(req.params.ref, req.user, ip(req)))));
router.post('/customs/from-import/:ref', ah(async (req, res) => res.json(await CUS.fromImport(req.params.ref, req.user, ip(req)))));
router.get('/customs/:id', ah(async (req, res) => res.json(await CUS.detail(req.params.id))));
router.put('/customs/:id', ah(async (req, res) => res.json(await CUS.save(req.params.id, req.body || {}, req.user, ip(req)))));
router.post('/customs/:id/status', ah(async (req, res) => res.json(await CUS.setStatus(req.params.id, (req.body || {}).status, req.body || {}, req.user, ip(req)))));
router.get('/orders/:ref/documents', ah(async (req, res) => res.json(await CUS.docList('export', req.params.ref))));
router.post('/orders/:ref/documents/generate', ah(async (req, res) => res.json(await CUS.generate((req.body || {}).doc_type, { export_ref: String(req.params.ref).toUpperCase() }, req.user, ip(req)))));
router.post('/orders/:ref/documents', big, ah(async (req, res) => { const eo = await require('../lib/db').get('SELECT id FROM export_orders WHERE ref=?', String(req.params.ref).toUpperCase()); if (!eo) fail(404, 'International order not found.'); res.json({ document: await SUP.addDocument({ export_order_id: Number(eo.id) }, req.body || {}, fileOf(req.body), req.user, ip(req)) }); }));
router.get('/imports/:ref/documents', ah(async (req, res) => res.json(await CUS.docList('import', req.params.ref))));
router.post('/imports/:ref/documents/generate', ah(async (req, res) => res.json(await CUS.generate((req.body || {}).doc_type, { import_ref: String(req.params.ref).toUpperCase() }, req.user, ip(req)))));
router.post('/imports/:ref/receive-preview', ah(async (req, res) => res.json(await RCV.preview(req.params.ref, req.body || {}))));
router.post('/imports/:ref/receive', ah(async (req, res) => res.json(await RCV.receive(req.params.ref, req.body || {}, req.user, ip(req)))));
router.get('/imports/:ref/landed', ah(async (req, res) => res.json(await RCV.landed(req.params.ref))));
router.put('/imports/:ref/items/:id', ah(async (req, res) => res.json(await RCV.updateItem(req.params.ref, req.params.id, req.body || {}, req.user, ip(req)))));
router.get('/valuation', ah(async (req, res) => res.json(await RCV.valuation())));
router.get('/audit', ah(async (req, res) => res.json(await A.auditLog(req.query))));

module.exports = router;
