'use strict';
// Admin: dropshipping money (payables, extra costs, supplier refunds, returns, profit reports). Mounted at /api/admin/dropship/money, so the sign-in check,
// owner-only gate and activity log apply. Everything here shows our cost and margin and is never reachable by customers or suppliers.
const express = require('express');
const S = require('../lib/shop');
const M = require('../lib/dropship-money');
const A = require('../lib/auth');
const { fail, str, int } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const who = (req) => str(req.user.name || req.user.email, 80);
const { run } = require('../lib/db');
const auditRead = (req, what) => run('INSERT INTO audit_log (user_id,user_name,method,path,status,detail,ip,created) VALUES (?,?,?,?,?,?,?,?)', req.user.id, who(req), 'GET', req.originalUrl.slice(0, 200), 200, what, req.ip || '', Math.floor(Date.now() / 1000));
router.use(A.limiter('dropship-money', 120, 600000));
const exportLimit = A.limiter('dropship-money-export', 20, 600000);

router.get('/meta', ah(async (req, res) => res.json({ cost_kinds: M.COST_KINDS, return_labels: M.RETURN_LABEL, groups: Object.fromEntries(Object.entries(M.GROUPS).map(([k, v]) => [k, v.label])) })));

router.get('/payables', ah(async (req, res) => res.json(await M.payables({ status: str(req.query.status, 8), supplier_id: req.query.supplier_id }))));
router.post('/payables/:id/pay', ah(async (req, res) => res.json({ ok: true, ...(await M.payPayable(req.params.id, req.body || {}, who(req))) })));

router.get('/lines/:id', ah(async (req, res) => res.json(await M.lineMoney(req.params.id))));
router.post('/lines/:id/costs', ah(async (req, res) => res.json({ ok: true, id: await M.addCost(req.params.id, req.body || {}, who(req)) })));
router.delete('/costs/:id', ah(async (req, res) => { await M.removeCost(req.params.id); res.json({ ok: true }); }));
router.post('/lines/:id/supplier-refund', ah(async (req, res) => res.json({ ok: true, id: await M.recordSupplierRefund(req.params.id, req.body || {}, who(req)) })));
router.post('/lines/:id/return', ah(async (req, res) => res.json({ ok: true, id: await M.startReturn(req.params.id, req.body || {}, who(req)) })));
router.get('/returns', ah(async (req, res) => res.json({ returns: await M.returns({ all: req.query.all === '1' }) })));
router.put('/returns/:id', ah(async (req, res) => res.json({ ok: true, ...(await M.updateReturn(req.params.id, req.body || {}, who(req))) })));

router.get('/report', ah(async (req, res) => res.json(await M.report(req.query))));
router.get('/report.xlsx', exportLimit, ah(async (req, res) => {
  const buf = await M.exportXlsx(req.query); await auditRead(req, 'dropship profit report downloaded');
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="dropship-profit-${str(req.query.group, 10) || 'order'}.xlsx"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(buf);
}));

module.exports = router;
