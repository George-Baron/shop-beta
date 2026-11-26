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
router.get('/me', ah(async (req, res) => { const ap = await AP.approverOf(req.user); const cfg = await St.getConfig(); res.json({ approver: ap, assistant: { enabled: As.enabled(), model: As.enabled() ? As.MODEL : null }, mode: cfg.mode, owner: req.user.role === 'admin' }); }));

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
  res.json({ config: cfg, modes: P.MODES.map((m) => ({ key: m, label: P.MODE_LABEL[m] })), departments: Object.entries(P.DEPARTMENTS).map(([key, label]) => ({ key, label })), categories: P.CATEGORIES, agents: Ag.list(cfg),
    effective: Object.fromEntries(P.DEPT_KEYS.map((d) => [d, P.effectiveMode(d, cfg)])), level1_actions: Object.entries(P.ACTIONS).filter(([, v]) => v.level === 1).map(([k, v]) => ({ type: k, label: v.label, dept: v.dept })) });
}));
router.put('/settings', ah(async (req, res) => { owner(req); res.json({ config: await St.saveConfig(req.body || {}, who(req)) }); }));

/* ---- assistant ---- */
router.get('/chats', ah(async (req, res) => res.json({ chats: await As.chats(req.user) })));
router.get('/chats/:id', ah(async (req, res) => res.json({ messages: await As.history(req.user, req.params.id) })));
router.post('/chat', ah(async (req, res) => { const b = req.body || {}; res.json(await As.chat(req.user, b.chat_id, b.message)); }));

/* ---- integrations: honest status. Nothing is claimed as connected unless the store itself shows it is. ---- */
router.get('/integrations', ah(async (req, res) => {
  const env = (k) => !!process.env[k];
  res.json({ integrations: [
    { key: 'database', name: 'VELTO-MART database', status: 'connected', detail: 'Orders, stock, riders, suppliers and trade records are read directly.' },
    { key: 'llm', name: 'AI model (assistant)', status: As.enabled() ? 'configured' : 'not_configured', detail: As.enabled() ? 'API key present. Not live-tested here.' : 'Set ANTHROPIC_API_KEY to switch on natural-language instructions.' },
    { key: 'riders', name: 'Rider dispatch and GPS', status: 'connected', detail: 'Existing rider engine; its own manual/recommend/auto setting is respected.' },
    { key: 'fx', name: 'Exchange rates', status: env('FX_FEED_URL') || env('FX_API_KEY') ? 'configured' : 'manual', detail: 'Foreign amounts without a recorded rate are treated as unknown value (highest approval level).' },
    { key: 'dhl', name: 'DHL', status: 'not_connected', detail: 'No API credentials or test yet (planned: logistics phase).' },
    { key: 'ups', name: 'UPS', status: 'not_connected', detail: 'Planned: logistics phase.' },
    { key: 'fedex', name: 'FedEx', status: 'not_connected', detail: 'Planned: logistics phase.' },
    { key: 'email', name: 'Supplier email', status: 'not_connected', detail: 'AI does not email suppliers yet (planned: procurement phase).' },
  ] });
}));

module.exports = router;
