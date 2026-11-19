'use strict';
// Admin: bulk product import and export. Mounted inside routes/admin.js, so admin sign-in, the audit log and CSRF checks already apply.
// The three calls that carry a spreadsheet read a larger body (server.js lets them through the 100 KB default; admin sign-in is checked first).
const express = require('express');
const IO = require('../lib/catalog-io');
const cache = require('../lib/cache');
const S = require('../lib/shop');
const { fail } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const big = express.json({ limit: '14mb' });

router.get('/template.xlsx', ah(async (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="velto-mart-product-import-template.xlsx"');
  res.send(await IO.template());
}));
router.get('/fields', ah(async (req, res) => res.json({ fields: IO.FIELDS.map((f) => ({ key: f.key, header: f.header, need: f.need || '', help: f.help })), lookups: await IO.lookups().then((l) => ({ departments: l.stores.map((s) => s.name), categories: l.cats.map((c) => ({ id: c.id, store: c.store, name: c.name })), partners: l.partners.map((p) => ({ id: p.id, name: p.name })) })) })));

// 1. read the file (nothing is saved)
router.post('/parse', big, ah(async (req, res) => {
  const b = req.body || {};
  const m = /^(?:data:[^;]*;base64,)?([A-Za-z0-9+/=\s]+)$/.exec(String(b.data || ''));
  if (!m) fail(400, 'Please choose a file.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 10 * 1024 * 1024) fail(400, 'That file is over 10 MB. Split it into smaller files.');
  res.json(await IO.parseFile(buf, b.filename));
}));
// 2. check the rows (nothing is saved)
router.post('/validate', big, ah(async (req, res) => res.json(await IO.validate(req.body && req.body.rows, req.body && req.body.mode))));
// 3. save the valid rows, a chunk at a time. Update mode needs the explicit confirmation, so nothing existing is changed silently.
router.post('/commit', big, ah(async (req, res) => {
  const b = req.body || {};
  if (b.mode === 'update' && b.confirmUpdate !== true) fail(400, 'Please confirm that you want to change the existing products shown in the preview.');
  cache.clear();
  try { res.json(await IO.commit(b.rows, b.mode, { importId: b.importId, filename: b.filename, total: b.total }, req.user)); }
  finally { cache.bump().catch((e) => console.error('Cache bump failed:', e.message)); }
}));

// export
router.get('/export', ah(async (req, res) => {
  const fmt = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const filters = { filter: req.query.filter, ids: String(req.query.ids || '').split(',').filter(Boolean), category: req.query.category, brand: req.query.brand, partner: req.query.partner };
  const out = await IO.exportBuffer(filters, fmt);
  await IO.logExport(req.user, fmt, { filter: filters.filter || 'all', category: filters.category, brand: filters.brand, partner: filters.partner, ids: filters.ids.length || undefined }, out.count);
  res.setHeader('Content-Type', out.type);
  res.setHeader('Content-Disposition', `attachment; filename="velto-mart-products-${new Date().toISOString().slice(0, 10)}.${out.ext}"`);
  res.setHeader('X-Row-Count', String(out.count));
  res.send(out.buffer);
}));
router.get('/brands', ah(async (req, res) => res.json({ brands: (await require('../lib/db').all("SELECT DISTINCT brand FROM products WHERE brand <> '' AND is_pharmacy=0 ORDER BY brand LIMIT 1000")).map((r) => r.brand) })));

router.get('/history', ah(async (req, res) => res.json({ history: await IO.history() })));
router.get('/history/:id/errors.csv', ah(async (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import-${Number(req.params.id)}-errors.csv"`);
  res.send(await IO.errorReportCsv(req.params.id));
}));

module.exports = router;
