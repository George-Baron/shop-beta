'use strict';
// API of the AI Operations Manager: /api/admin/ops-ai/...  Staff need the "ops" permission (lib/staff.js). Deciding on an approval additionally needs
// to be a registered approver at the right level (lib/ops/approvals.js); only the owner changes settings and approvers.
const express = require('express');
const { all, get, run, now } = require('../lib/db');
const S = require('../lib/shop');
const A = require('../lib/auth');
const D = require('../lib/ops/data');
const St = require('../lib/ops/store');
const AP = require('../lib/ops/approvals');
const P = require('../lib/ops/policy');
const Ag = require('../lib/ops/agents');
const As = require('../lib/ops/assistant');
const { fail, int, str } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(A.requireBackoffice, require('../lib/staff').gate);
const owner = (req) => { if (req.user.role !== 'admin') fail(403, 'Only the owner can change this.'); };
const who = (req) => req.user.name || req.user.email;

router.get('/overview', ah(async (req, res) => res.json(await D.overview(req.query))));
router.get('/me', ah(async (req, res) => { const ap = await AP.approverOf(req.user); const cfg = await St.getConfig(); res.json({ approver: ap, assistant: { enabled: As.enabled(), model: As.enabled() ? (cfg.assistant_model || As.MODEL) : null }, mode: cfg.mode, owner: req.user.role === 'admin' }); }));

/* ---- every order, followed until it ends ---- */
const OR = require('../lib/ops/orders');
router.get('/orders', ah(async (req, res) => res.json(await OR.board({ channel: String(req.query.channel || ''), stage: String(req.query.stage || ''), late: req.query.late === '1' }))));
router.post('/orders/sweep', ah(async (req, res) => res.json(await OR.sweep())));
router.get('/orders/:kind/:id', ah(async (req, res) => { if (!['order', 'wholesale'].includes(req.params.kind)) return res.status(404).json({ error: 'Unknown order type.' }); const t = await OR.timeline(req.params.kind, req.params.id); if (!t) return res.status(404).json({ error: 'That order is not being watched yet.' }); res.json(t); }));

/* ---- logistics: providers, recorded rates, comparison, shipments ---- */
const LG = require('../lib/ops/logistics');
const ownerOnly = (req, res) => { if (req.user.role !== 'admin') { res.status(403).json({ error: 'Only the owner can approve or suspend a delivery provider.' }); return true; } return false; };
router.get('/logistics/providers', ah(async (req, res) => res.json({ providers: await LG.listProviders(), kinds: LG.KINDS })));
router.post('/logistics/providers', ah(async (req, res) => res.json({ id: await LG.createProvider(req.user, req.body || {}) })));
router.post('/logistics/providers/:id/status', ah(async (req, res) => { if (ownerOnly(req, res)) return; const b = req.body || {}; res.json(await LG.setProviderStatus(req.user, req.params.id, str(b.status, 20), b.reason)); }));
router.post('/logistics/providers/:id/rates', ah(async (req, res) => res.json({ id: await LG.addRate(req.user, req.params.id, req.body || {}) })));
router.get('/logistics/compare', ah(async (req, res) => res.json(await LG.compareForOrder(req.query.order_id, { weight_kg: req.query.weight_kg }))));
router.post('/logistics/shipments', ah(async (req, res) => { const b = req.body || {}; res.json(await LG.requestBooking({ agent: 'logistics', user: req.user, requestedByUser: true }, { order_id: b.order_id, rate_id: b.rate_id, weight_kg: b.weight_kg, justification: b.justification })); }));
router.get('/logistics/shipments', ah(async (req, res) => res.json({ shipments: await LG.listShipments({ status: String(req.query.status || ''), open: req.query.open === '1' }) })));
router.get('/logistics/shipments/:id', ah(async (req, res) => { const s = await LG.getShipment(req.params.id); if (!s) return res.status(404).json({ error: 'Shipment not found.' }); res.json(s); }));
router.post('/logistics/shipments/:id/booking', ah(async (req, res) => res.json(await LG.recordBooking(req.user, req.params.id, req.body || {}))));
router.post('/logistics/shipments/:id/events', ah(async (req, res) => res.json(await LG.addEvent(req.user, req.params.id, req.body || {}))));
router.post('/logistics/shipments/:id/cancel', ah(async (req, res) => res.json(await LG.cancelShipment(req.user, req.params.id, str((req.body || {}).reason, 300)))));
router.get('/logistics/scorecards', ah(async (req, res) => res.json({ scorecards: await LG.scorecards() })));

/* ---- import / export consignments ---- */
const TO = require('../lib/ops/trade-ops');
router.get('/trade/consignments', ah(async (req, res) => res.json(await TO.board({ direction: String(req.query.direction || ''), status: String(req.query.status || '') }))));
router.get('/trade/consignments/:id', ah(async (req, res) => res.json(await TO.detail(req.params.id))));
router.post('/trade/consignments/:id/links', ah(async (req, res) => { const b = req.body || {}; res.json(await TO.link(req.user, req.params.id, str(b.kind, 20), b.ref_id, b.note)); }));
router.delete('/trade/consignments/:id/links/:kind/:ref', ah(async (req, res) => res.json(await TO.unlink(req.user, req.params.id, req.params.kind, req.params.ref))));
router.post('/trade/draft-from-po', ah(async (req, res) => res.json(await require('../lib/ops/gateway').perform({ agent: 'trade', user: req.user, requestedByUser: true }, 'consignment.draft', { summary: 'Draft an import consignment from a purchase order', related_type: 'purchase_order', related_id: String((req.body || {}).po_id), payload: { po_id: int((req.body || {}).po_id) } }))));

/* ---- advanced intelligence and reports ---- */
const IN = require('../lib/ops/intel'), RP = require('../lib/ops/reports');
router.get('/intel/forecast', ah(async (req, res) => res.json(await IN.demandForecast({ limit: int(req.query.limit) || 40 }))));
router.get('/intel/suppliers', ah(async (req, res) => res.json(await IN.supplierScorecards({ days: Math.min(365, int(req.query.days) || 90) }))));
router.get('/intel/profitability', ah(async (req, res) => res.json(await IN.profitability({ from: req.query.from, to: req.query.to }))));
router.get('/intel/at-risk', ah(async (req, res) => res.json(await IN.atRisk())));
router.get('/intel/performance', ah(async (req, res) => res.json(await IN.performance({ days: Math.min(365, int(req.query.days) || 30) }))));
router.get('/reports', ah(async (req, res) => res.json({ reports: await RP.list(String(req.query.kind || '')) })));
router.post('/reports/generate', ah(async (req, res) => { const k = str((req.body || {}).kind, 10); if (!['daily', 'weekly', 'monthly'].includes(k)) return res.status(400).json({ error: 'Choose daily, weekly or monthly.' }); res.json(await RP.ensure(k)); }));
router.get('/reports/:id', ah(async (req, res) => { const r = await RP.getOne(req.params.id); if (!r) return res.status(404).json({ error: 'Report not found.' }); res.json(r); }));

/* ---- audit log, exceptions, tasks ---- */
router.get('/actions', ah(async (req, res) => res.json({ actions: await St.listActions(req.query) })));
router.get('/exceptions', ah(async (req, res) => res.json({ exceptions: await St.listExceptions(req.query) })));
router.patch('/exceptions/:id', ah(async (req, res) => { await St.updateException(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
router.get('/tasks', ah(async (req, res) => res.json({ tasks: await St.listTasks(req.query.status) })));
router.patch('/tasks/:id', ah(async (req, res) => { await St.updateTask(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));

/* ---- approvals ---- */
router.get('/approvals', ah(async (req, res) => res.json({ approvals: await AP.list(req.query) })));
router.post('/approvals/:id/decision', ah(async (req, res) => { const b = req.body || {}; res.json(await AP.decide(req.user, req.params.id, str(b.decision, 10), str(b.note, 400))); }));
router.post('/approvals/:id/complete', ah(async (req, res) => { const b = req.body || {}; res.json(await AP.complete(req.user, req.params.id, { reference: str(b.reference, 120), note: str(b.note, 400) })); }));
router.post('/approvals/:id/cancel', ah(async (req, res) => res.json(await AP.cancel(req.user, req.params.id))));

/* ---- approvers (owner only) ---- */
router.get('/approvers', ah(async (req, res) => {
  const rows = await all("SELECT a.user_id, a.max_level, a.emergency, u.name, u.email FROM ops_approvers a JOIN users u ON u.id=a.user_id ORDER BY u.name");
  const staff = await all("SELECT id, name, email FROM users WHERE role='staff' AND active<>0 ORDER BY name");
  res.json({ approvers: rows, staff });
}));
router.put('/approvers/:userId', ah(async (req, res) => {
  owner(req); const uid = int(req.params.userId), b = req.body || {}, lvl = int(b.max_level);
  const u = await get("SELECT id, name FROM users WHERE id=? AND role='staff' AND active<>0", uid); if (!u) fail(404, 'That staff member was not found.');
  if (!lvl) { await run('DELETE FROM ops_approvers WHERE user_id=?', uid); await St.logAction({ agent: 'settings', actor_kind: 'human', actor_user: req.user.id, actor_name: who(req), action_type: 'approver.remove', description: `${u.name} is no longer an approver`, status: 'done' }); return res.json({ ok: true }); }
  if (lvl < 2 || lvl > 4) fail(400, 'Approval level must be 2, 3 or 4.');
  await run('INSERT INTO ops_approvers (user_id,max_level,emergency,created,created_by) VALUES (?,?,?,?,?) ON CONFLICT (user_id) DO UPDATE SET max_level=EXCLUDED.max_level, emergency=EXCLUDED.emergency', uid, lvl, b.emergency ? 1 : 0, now(), who(req));
  await St.logAction({ agent: 'settings', actor_kind: 'human', actor_user: req.user.id, actor_name: who(req), action_type: 'approver.set', description: `${u.name} can approve up to level ${lvl}${b.emergency ? ' and emergencies' : ''}`, status: 'done' });
  res.json({ ok: true });
}));

/* ---- settings: mode, thresholds, permission matrix, agents ---- */
router.get('/settings', ah(async (req, res) => {
  const cfg = await St.getConfig();
  res.json({ config: cfg, modes: P.MODES.map((m) => ({ key: m, label: P.MODE_LABEL[m] })), departments: Object.entries(P.DEPARTMENTS).map(([key, label]) => ({ key, label })), categories: P.CATEGORIES, agents: Ag.list(cfg), supplier_weights: require('../lib/ops/procure').normalizeWeights(cfg.supplier_weights), weight_labels: require('../lib/ops/procure').FACTOR_LABEL,
    effective: Object.fromEntries(P.DEPT_KEYS.map((d) => [d, P.effectiveMode(d, cfg)])), level1_actions: Object.entries(P.ACTIONS).filter(([, v]) => v.level === 1).map(([k, v]) => ({ type: k, label: v.label, dept: v.dept })) });
}));
router.put('/settings', ah(async (req, res) => { owner(req); res.json({ config: await St.saveConfig(req.body || {}, who(req)) }); }));

/* ---- assistant ---- */
router.get('/assistant-usage', ah(async (req, res) => res.json(await As.usageReport())));
router.get('/chats', ah(async (req, res) => res.json({ chats: await As.chats(req.user) })));
router.get('/chats/:id', ah(async (req, res) => res.json({ messages: await As.history(req.user, req.params.id) })));
router.post('/chat', ah(async (req, res) => { const b = req.body || {}; res.json(await As.chat(req.user, b.chat_id, b.message)); }));

/* ---- procurement (phase 2) ---- */
const PC = require('../lib/ops/procurement'), PRC = require('../lib/ops/procure'), G = require('../lib/ops/gateway');
router.get('/procurement/vendors', ah(async (req, res) => res.json({ vendors: await PC.listVendors(), kinds: PC.KINDS, statuses: PRC.STATUSES, checks: PRC.CHECKS.map((k) => ({ key: k, label: PRC.CHECK_LABEL[k] })) })));
router.post('/procurement/vendors', ah(async (req, res) => res.json({ vendor: await PC.createVendor(req.user, req.body || {}) })));
router.put('/procurement/vendors/:id', ah(async (req, res) => { await PC.updateVendor(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
router.post('/procurement/vendors/:id/verify', ah(async (req, res) => { const b = req.body || {}; await PC.setVerification(req.user, req.params.id, str(b.check, 20), str(b.state, 20), b.note); res.json({ ok: true }); }));
router.post('/procurement/vendors/:id/rate', ah(async (req, res) => { await PC.rateVendor(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
// An approver (level 2+) changes a status directly; anyone else files a request that an approver must decide.
router.post('/procurement/vendors/:id/status', ah(async (req, res) => {
  const b = req.body || {}, a = await AP.approverOf(req.user);
  if (a && a.max_level >= 2) return res.json({ result: await PC.changeStatusByPerson(req.user, req.params.id, str(b.status, 20), str(b.reason, 300)) });
  const v = await PC.vendorById(req.params.id);
  res.json({ request: await G.perform({ agent: 'procurement', user: req.user, requestedByUser: true }, 'supplier.status_change', { summary: `Set ${v.ref} ${v.name} to ${b.status}`, justification: str(b.reason, 300), related_type: 'vendor', related_id: v.ref, payload: { vendor_id: Number(v.id), status: str(b.status, 20), reason: str(b.reason, 300) } }) });
}));
router.get('/procurement/requests', ah(async (req, res) => res.json({ requests: await PC.listRequests(req.query.status) })));
router.post('/procurement/requests', ah(async (req, res) => res.json({ request: await PC.createRequest(req.user, req.body || {}) })));
router.post('/procurement/requests/recommend', ah(async (req, res) => res.json(await PC.recommendFromStock(req.user))));
router.post('/procurement/requests/:id/cancel', ah(async (req, res) => { await PC.cancelRequest(req.user, req.params.id, str((req.body || {}).reason, 200)); res.json({ ok: true }); }));
router.get('/procurement/requests/:id/compare', ah(async (req, res) => res.json(await PC.compare(req.params.id))));
router.post('/procurement/requests/:id/quotations', ah(async (req, res) => res.json({ quotation: await PC.addQuotation(req.user, req.params.id, req.body || {}) })));
router.post('/procurement/requests/:id/draft', ah(async (req, res) => { const b = req.body || {}; res.json({ po: await PC.draftPO(req.user, req.params.id, b.quotation_id, { qty: b.qty }) }); }));
router.get('/procurement/purchase-orders', ah(async (req, res) => res.json({ purchase_orders: await PC.listPOs(req.query.status) })));
router.post('/procurement/purchase-orders/:id/approval', ah(async (req, res) => res.json({ result: await PC.requestPOApproval({ agent: 'procurement', user: req.user, requestedByUser: true }, req.params.id, (req.body || {}).justification) })));
router.post('/procurement/purchase-orders/:id/sent', ah(async (req, res) => { await PC.markSent(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
router.post('/procurement/purchase-orders/:id/status', ah(async (req, res) => { const b = req.body || {}; await PC.setPOStatus(req.user, req.params.id, str(b.status, 20), b.note); res.json({ ok: true }); }));
router.post('/procurement/purchase-orders/:id/receipt', ah(async (req, res) => { await PC.recordReceipt(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
router.get('/procurement/purchase-orders/:id/pdf', ah(async (req, res) => { const buf = await PC.poPdf(req.params.id); res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="purchase-order-${int(req.params.id)}.pdf"`, 'Cache-Control': 'private, no-store' }); res.send(buf); }));

/* ---- integrations: honest status. Nothing is claimed as connected unless the store itself shows it is. ---- */
router.get('/integrations', ah(async (req, res) => {
  const env = (k) => !!process.env[k];
  res.json({ integrations: [
    { key: 'database', name: 'VELTO-MART database', status: 'connected', detail: 'Orders, stock, riders, suppliers and trade records are read directly.' },
    { key: 'llm', name: 'AI model (assistant)', status: As.enabled() ? 'configured' : 'not_configured', detail: As.enabled() ? 'API key present. Not live-tested here.' : 'Set ANTHROPIC_API_KEY to switch on natural-language instructions.' },
    { key: 'riders', name: 'Rider dispatch and GPS', status: 'connected', detail: 'Existing rider engine; its own manual/recommend/auto setting is respected.' },
    { key: 'fx', name: 'Exchange rates', status: env('FX_FEED_URL') || env('FX_API_KEY') ? 'configured' : 'manual', detail: 'Foreign amounts without a recorded rate are treated as unknown value (highest approval level).' },
    { key: 'dhl', name: 'DHL', status: 'not_connected', detail: 'No courier API is connected. Rates and tracking updates are recorded by staff (Logistics tab). Not claimed as connected until credentials are tested.' },
    { key: 'ups', name: 'UPS', status: 'not_connected', detail: 'No courier API is connected. Staff record rates and tracking.' },
    { key: 'fedex', name: 'FedEx', status: 'not_connected', detail: 'No courier API is connected. Staff record rates and tracking.' },
    { key: 'email', name: 'Supplier email', status: 'not_connected', detail: 'AI does not email suppliers yet (planned: procurement phase).' },
  ] });
}));

module.exports = router;
