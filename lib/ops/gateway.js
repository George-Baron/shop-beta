'use strict';
// The one door every AI action goes through. perform() looks up the rules (policy.js), then does exactly one of:
//   execute  -> runs the handler, records the real outcome
//   approval -> creates an approval request for a person
//   recommend-> only records the suggestion (Monitor mode)
//   blocked  -> refuses and says why
// and always writes the result to the append-only action log. The returned object is what the backend knows to be true:
// the assistant shows it to the user as it is, whatever words the language model adds around it.
const P = require('./policy');
const St = require('./store');
const AP = require('./approvals');
const { HANDLERS, RECORD_ONLY } = require('./handlers');
const { str } = require('../shop');
const AU = () => require('./autonomy');

// ctx: { agent (key of the agent doing it), user (the signed-in person directing it, if any), requestedByUser (true when the person made the request by hand) }
async function perform(ctx, type, params = {}) {
  const info = P.actionInfo(type), agent = ctx.agent || 'orchestrator', p = params || {};
  const base = { agent, action_type: type, description: str(p.summary || (info && info.label) || type, 300), related_type: p.related_type, related_id: p.related_id, actor_user: ctx.user && ctx.user.id, actor_name: ctx.user && ctx.user.name };
  if (!info) { await St.logAction({ ...base, actor_kind: 'system', status: 'blocked', error: 'Not an allowed action.' }); return { status: 'blocked', action: type, reason: `"${type}" is not an action the AI is allowed to take.` }; }

  const cfg = await St.getConfig();
  // value in Naira at a verified rate; if there is no rate the value is unknown and the action is treated as the highest level
  const money = info.money && Number(p.amount) > 0, conv = money ? await AP.toNgn(p.amount, p.currency) : { ngn: 0, unknown: false };
  const category = info.category, counterparty = str(p.counterparty, 120);
  const cumulative = info.money ? await AP.cumulativeNgn(category, counterparty, cfg.split_window_hours * 3600) : 0;
  const l1Spent = info.money && info.level === 1 ? await AP.autonomousSpentNgn(category) : 0;
  const today = info.level >= 1 && P.effectiveMode(info.dept, cfg) === 'controlled' ? await AU().autonomousToday() : 0;
  const d = P.decide({ type, amountNgn: conv.unknown ? 1e13 : conv.ngn, cumulativeNgn: cumulative, config: cfg, emergency: !!p.emergency, l1SpentNgn: l1Spent, autonomousToday: today });
  const common = { ...base, mode: d.mode, level: d.level, data_used: p.data_used };
  const facts = { level: d.level, mode: d.mode, reason: d.reason, split_suspected: d.split_suspected, value_unknown: conv.unknown };

  if (d.route === 'blocked') { await St.logAction({ ...common, actor_kind: 'system', status: 'blocked', error: d.reason }); return { status: 'blocked', action: type, reason: d.reason }; }

  if (d.route === 'recommend') {
    await St.logAction({ ...common, actor_kind: 'system', status: 'recommended', recommendation: str(p.summary || info.label, 400), result: { payload: p.payload, ...facts } });
    return { status: 'recommended', action: type, summary: str(p.summary || info.label, 300), reason: d.reason, ...facts };
  }

  if (d.route === 'approval') {
    // an action nothing in the system can carry out yet is refused instead of being approved and then failing
    if (!info.human && !HANDLERS[type]) { const why = 'This action is not connected to a system yet (planned for a later phase), so no approval request was made.'; await St.logAction({ ...common, actor_kind: 'system', status: 'blocked', error: why }); return { status: 'blocked', action: type, reason: why }; }
    const a = await AP.create({ type, d, params: p, amountNgn: conv.ngn, valueUnknown: conv.unknown, agent, user: ctx.user, requestedByUser: !!ctx.requestedByUser, cfg });
    await St.logAction({ ...common, actor_kind: ctx.requestedByUser ? 'human' : 'system', status: 'pending_approval', approval_id: a.id, recommendation: str(p.justification, 400), result: { approval: a.ref, existing: a.existing, ...facts, amount_ngn: conv.ngn } });
    return { status: 'pending_approval', action: type, approval: a.ref, existing: !!a.existing, level_required: d.level, approvals_needed: d.required_approvals, amount_ngn: conv.ngn, summary: str(p.summary || info.label, 300), ...facts };
  }

  // route === 'execute'
  const h = HANDLERS[type];
  if (!h) {
    if (RECORD_ONLY.has(type)) { await St.logAction({ ...common, actor_kind: 'system', status: 'recommended', recommendation: str(p.summary || info.label, 400), result: { payload: p.payload, ...facts } }); return { status: 'recommended', action: type, summary: str(p.summary || info.label, 300), ...facts }; }
    const why = 'This action is not connected to a system yet (planned for a later phase).'; await St.logAction({ ...common, actor_kind: 'system', status: 'blocked', error: why }); return { status: 'blocked', action: type, reason: why };
  }
  try {
    const r = await h(p.payload || {}, { agentName: St.AI_NAME, user: ctx.user });
    const result = { ...r.result, ...facts, ...(money ? { amount_ngn: conv.ngn, category, counterparty } : {}) };
    await St.logAction({ ...common, actor_kind: 'ai_autonomous', status: r.status === 'done' ? 'done' : 'recommended', recommendation: r.status === 'done' ? '' : str(r.summary, 400), result, external_ref: str(r.result && (r.result.assignment_id || r.result.task_id), 60) });
    return { status: r.status === 'done' ? 'done' : 'recommended', action: type, summary: r.summary, ...facts, result: r.result };
  } catch (e) {
    await St.logAction({ ...common, actor_kind: 'ai_autonomous', status: 'failed', error: str(e.message, 300) });
    await AU().checkBreaker().catch(() => {});   // repeated failures pause autonomy by themselves
    return { status: 'failed', action: type, error: str(e.message, 300), ...facts };
  }
}

module.exports = { perform };
