'use strict';
// A partner store's bulk product import and export (/api/partner/catalog). Uses the same engine as the admin import (lib/catalog-io.js),
// limited to this store: its own departments, its own products. Imported products wait for our review before customers can see them.
const express = require('express');
const A = require('../lib/auth');
const V = require('../lib/vendors');
const IO = require('../lib/catalog-io');
const cache = require('../lib/cache');
const S = require('../lib/shop');
const { fail } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const big = express.json({ limit: '8mb' });
const MAX_ROWS = 5000;
const scoped = (fn) => ah(async (req, res, next) => fn(req, res, await V.mine(req.user), next));   // the store is read from the signed-in account, never from the request
const lim = A.limiter('partner-import', 60, 3600000);

router.get('/template.xlsx', scoped(async (req, res, v) => {
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="my-products-import-template.xlsx"' }).send(await IO.template(v));
}));
router.get('/fields', scoped(async (req, res, v) => {
  const l = await IO.lookups(v);
  res.json({ fields: IO.fieldsFor(v).map((f) => ({ key: f.key, header: f.header, need: f.need || '', help: f.help })), lookups: { departments: l.stores.map((s) => s.name), categories: l.cats.filter((c) => l.stores.some((s) => s.slug === c.store)).map((c) => ({ id: c.id, store: c.store, name: c.name })), partners: [] } });
}));
router.post('/parse', lim, big, scoped(async (req, res, v) => {
  const b = req.body || {}, m = /^(?:data:[^;]*;base64,)?([A-Za-z0-9+/=\s]+)$/.exec(String(b.data || ''));
  if (!m) fail(400, 'Please choose a file.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 5 * 1024 * 1024) fail(400, 'That file is over 5 MB. Split it into smaller files.');
  const out = await IO.parseFile(buf, b.filename, v);
  if (out.rows.length > MAX_ROWS) fail(400, `This file has more than ${MAX_ROWS.toLocaleString('en')} products. Split it into smaller files.`);
  res.json(out);
}));
router.post('/validate', lim, big, scoped(async (req, res, v) => {
  if (Array.isArray(req.body && req.body.rows) && req.body.rows.length > MAX_ROWS) fail(400, 'Too many rows in one file.');
  res.json(await IO.validate(req.body && req.body.rows, req.body && req.body.mode, v));
}));
router.post('/commit', lim, big, scoped(async (req, res, v) => {
  const b = req.body || {};
  if (b.mode === 'update' && b.confirmUpdate !== true) fail(400, 'Please confirm that you want to change the existing products shown in the preview.');
  if (Number(b.total) > MAX_ROWS) fail(400, 'Too many rows in one file.');
  cache.clear();
  try {
    const r = await IO.commit(b.rows, b.mode, { importId: b.importId, filename: b.filename, total: b.total }, req.user, v);
    if (r.created || r.updated) await require('../lib/notify').toStaff('catalog', true, { type: 'product', title: `${v.name} imported products`, body: `${r.created} new and ${r.updated} changed. They are waiting for your review.`, link: '/admin#/vendors' });
    res.json(r);
  } finally { cache.bump().catch((e) => console.error('Cache bump failed:', e.message)); }
}));
router.get('/export', scoped(async (req, res, v) => {
  const fmt = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const filters = { filter: ['all', 'active', 'inactive', 'missing_images', 'low_stock', 'selected'].includes(req.query.filter) ? req.query.filter : 'all', ids: String(req.query.ids || '').split(',').filter(Boolean) };
  const out = await IO.exportBuffer(filters, fmt, v);
  await IO.logExport(req.user, fmt, { filter: filters.filter }, out.count, v);
  res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="my-products-${new Date().toISOString().slice(0, 10)}.${out.ext}"`, 'X-Content-Type-Options': 'nosniff' }).send(out.buffer);
}));
router.get('/history', scoped(async (req, res, v) => res.json({ history: await IO.history(v) })));
router.get('/history/:id/errors.csv', scoped(async (req, res, v) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="import-${Number(req.params.id)}-errors.csv"` }).send(await IO.errorReportCsv(req.params.id, v));
}));
module.exports = router;
