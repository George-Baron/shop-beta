'use strict';
// Admin: import and export. Shipments, documents (PDF), landed-cost calculator, compliance reminders and restricted items.
// Mounted inside the dropshipping admin router (admin sign-in, activity log, cache clearing). Owner only through the staff role gate.
const express = require('express');
const S = require('../lib/shop');
const A = require('../lib/auth');
const C = require('../lib/countries');
const T = require('../lib/trade');
const TD = require('../lib/trade-docs');
const TC = require('../lib/trade-compliance');
const L = require('../lib/trade-landed');
const { run, now } = require('../lib/db');
const { fail, str, int } = S;

const who = (req) => String(req.user.name || req.user.email).slice(0, 80);
// Opening a private document is not a change, so the activity log would miss it. Record it here.
const auditRead = (req, what) => run('INSERT INTO audit_log (user_id,user_name,method,path,status,detail,ip,created) VALUES (?,?,?,?,?,?,?,?)', req.user.id, who(req), 'GET', req.originalUrl.slice(0, 200), 200, what, String(req.clientIp || '').slice(0, 60), now());

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(A.limiter('trade-admin', 240, 600000));

router.get('/meta', ah(async (req, res) => res.json({ incoterms: L.INCOTERMS.map((c) => ({ code: c, name: L.INCOTERM_NAMES[c], seller_pays: L.SELLER_PAYS[c] })), statuses: T.STATUSES, customs: T.CUSTOMS, transport: T.TRANSPORT, file_kinds: T.FILE_KINDS,
  docs: T.DOCS, categories: TC.CATS, countries: C.countries(), currencies: C.currencies().map((c) => c.code), company: await T.company() })));
router.put('/company', ah(async (req, res) => res.json({ ok: true, company: await T.saveCompany(req.body || {}) })));

/* ---------- landed cost ---------- */
router.post('/landed', ah(async (req, res) => {
  let rates = {}; try { rates = await require('../lib/dropship').rates(); } catch { /* shown below if needed */ }
  try { res.json(L.landed(req.body || {}, rates)); } catch (e) { fail(400, e.message); }
}));

/* ---------- shipments ---------- */
router.get('/shipments', ah(async (req, res) => res.json({ shipments: await T.list({ status: str(req.query.status, 20), direction: str(req.query.direction, 10), q: str(req.query.q, 60) }) })));
router.post('/shipments', ah(async (req, res) => res.json({ ok: true, id: await T.create(req.user, req.body || {}) })));
router.get('/shipments/:id', ah(async (req, res) => res.json(await T.detail(req.params.id))));
router.put('/shipments/:id', ah(async (req, res) => { await T.update(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
router.delete('/shipments/:id', ah(async (req, res) => { await T.remove(req.user, req.params.id); res.json({ ok: true }); }));
router.post('/shipments/:id/status', ah(async (req, res) => res.json({ ok: true, ...(await T.setStatus(req.user, req.params.id, str(req.body && req.body.to, 20), req.body && req.body.note)) })));
router.get('/shipments/:id/landed', ah(async (req, res) => res.json(await T.landedFor(await T.load(req.params.id), await T.items(req.params.id), str(req.query.show_in, 3).toUpperCase() || 'NGN'))));

router.post('/shipments/:id/items', ah(async (req, res) => res.json({ ok: true, id: await T.addItem(req.user, req.params.id, req.body || {}) })));
router.post('/shipments/:id/items/from-product', ah(async (req, res) => res.json({ ok: true, id: await T.addFromProduct(req.user, req.params.id, req.body || {}) })));
router.put('/shipments/:id/items/:item', ah(async (req, res) => { await T.updateItem(req.user, req.params.id, req.params.item, req.body || {}); res.json({ ok: true }); }));
router.delete('/shipments/:id/items/:item', ah(async (req, res) => { await T.removeItem(req.user, req.params.id, req.params.item); res.json({ ok: true }); }));

// Opening a document gives it its number the first time (and records it), so it is a read with a record, not a plain read.
router.get('/shipments/:id/documents/:kind/pdf', ah(async (req, res) => {
  const d = await TD.build(req.user, req.params.id, req.params.kind);
  await auditRead(req, `trade document ${d.number} opened`);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${d.filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(d.buf);
}));

// Attached files. The larger body is only read after the admin check (see the exception in server.js).
router.post('/shipments/:id/files', A.limiter('tradefile', 40, 3600000), express.json({ limit: '12mb' }), ah(async (req, res) => {
  const m = /^data:[a-z0-9/+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.data) || ''));
  if (!m) fail(400, 'Please choose a file.');
  res.json({ ok: true, id: await T.addFile(req.user, int(req.params.id), str(req.body.kind, 20), Buffer.from(m[1], 'base64'), req.body.name) });
}));
router.get('/shipments/:id/files/:file', ah(async (req, res) => {
  const f = await T.openFile(req.params.id, req.params.file); await auditRead(req, 'trade file opened: ' + f.name);
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${f.name.replace(/"/g, '')}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }).send(f.buf);
}));
router.delete('/shipments/:id/files/:file', ah(async (req, res) => { await T.removeFile(req.user, req.params.id, req.params.file); res.json({ ok: true }); }));

/* ---------- compliance reminders (editable data) and restricted items ---------- */
router.put('/shipments/:id/checklist/:rule', ah(async (req, res) => { await TC.setCheck(req.user, req.params.id, req.params.rule, req.body || {}); res.json({ ok: true }); }));
router.get('/rules', ah(async (req, res) => res.json({ rules: await TC.rules(), classes: await TC.classes(), note: 'Reminders to verify with the official source. Not legal advice.' })));
router.post('/rules', ah(async (req, res) => res.json({ ok: true, id: await TC.createRule(req.body || {}) })));
router.put('/rules/:id', ah(async (req, res) => { await TC.updateRule(req.params.id, req.body || {}); res.json({ ok: true }); }));
router.delete('/rules/:id', ah(async (req, res) => { await TC.removeRule(req.params.id); res.json({ ok: true }); }));
router.put('/classes/:slug', ah(async (req, res) => res.json({ ok: true, slug: await TC.saveClass(req.user, req.params.slug, req.body || {}) })));
router.delete('/classes/:slug', ah(async (req, res) => { await TC.removeClass(req.params.slug); res.json({ ok: true }); }));
router.post('/classify', ah(async (req, res) => { const r = await TC.classify(req.body || {}); res.json({ action: r.action, hits: r.hits }); }));

module.exports = router;
