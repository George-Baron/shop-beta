'use strict';
// Import and export of products. One router, mounted for the admin (/api/admin/catalog) and for partner stores (/api/partner/catalog).
// The client reads the file once, then sends rows in small groups, so large files never hit a request size limit.
const express = require('express');
const A = require('../lib/auth');
const IO = require('../lib/catalog-io');
const X = require('../lib/xlsx');
const S = require('../lib/shop');
const V = require('../lib/vendors');
const { fail } = S;

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = (kind) => {
  const router = express.Router();
  const scopeOf = async (req) => ({ vendor: kind === 'partner' ? await V.mine(req.user) : null });
  const json = express.json({ limit: '2mb' });
  const raw = express.raw({ type: () => true, limit: '9mb' });
  const send = (res, buf, name, type) => { res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' }); res.send(Buffer.from(buf)); };
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  router.get('/fields', ah(async (req, res) => { const sc = await scopeOf(req); res.json({ fields: IO.fieldsFor(sc).map((f) => ({ key: f.key, label: f.label, req: !!f.req })), per_call: IO.MAX_ROWS_PER_CALL }); }));
  router.get('/template.:ext(xlsx|csv)', ah(async (req, res) => {
    const sc = await scopeOf(req), ref = await IO.reference(sc), csv = req.params.ext === 'csv';
    send(res, IO.template(sc, ref, req.params.ext), `shop-beta-product-template.${req.params.ext}`, csv ? 'text/csv; charset=utf-8' : XLSX);
  }));
  // Reads the uploaded file and hands back the cells; nothing is saved.
  router.post('/parse', A.limiter('catalog-parse', 60, 3600000), raw, ah(async (req, res) => {
    await scopeOf(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, 'Please choose a file.');
    let rows;
    try { rows = X.readSheet(req.body, String(req.query.filename || '')); } catch (e) { if (e instanceof X.SheetError) fail(400, e.message); throw e; }
    if (rows.length < 2) fail(400, 'The file has no product rows. The first row must be the column names, with products below it.');
    const sc = await scopeOf(req), headers = rows[0];
    res.json({ headers, rows: rows.slice(1), mapping: IO.autoMap(headers, sc), total: rows.length - 1 });
  }));
  router.post('/check', A.limiter('catalog-check', 600, 3600000), json, ah(async (req, res) => {
    const b = req.body || {}; res.json(await IO.check(await scopeOf(req), b, b.rows));
  }));
  router.post('/apply', A.limiter('catalog-apply', 600, 3600000), json, ah(async (req, res) => {
    const b = req.body || {}; res.json(await IO.apply(await scopeOf(req), b, b.rows));
  }));
  router.post('/log', json, ah(async (req, res) => { const b = req.body || {}; await IO.logRun(await scopeOf(req), req.user, b.kind === 'export' ? 'export' : 'import', b); res.json({ ok: true }); }));
  router.get('/history', ah(async (req, res) => res.json({ history: await IO.history(await scopeOf(req)) })));
  router.get('/export.:ext(xlsx|csv)', A.limiter('catalog-export', 60, 3600000), ah(async (req, res) => {
    const sc = await scopeOf(req), r = await IO.exportRows(sc, req.query), csv = req.params.ext === 'csv';
    await IO.logRun(sc, req.user, 'export', { mode: '', filename: `products.${req.params.ext}`, total: r.count });
    send(res, IO.exportFile(r, req.params.ext), `shop-beta-products-${new Date().toISOString().slice(0, 10)}.${req.params.ext}`, csv ? 'text/csv; charset=utf-8' : XLSX);
  }));
  return router;
};
