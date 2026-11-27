'use strict';
// Safeguard self-test (spec section 28: "the AI must never ..."). Pure: it drives the real decide() / approverMayDecide() / sodConflict()
// across every action, every mode and many amounts, and reports any case where a rule that must always hold does not.
// Nothing here writes anything; autonomy.js stores the result and the rollout gate reads it.
const P = require('./policy');

const AMOUNTS = [0, 1, 99999, 100000, 100001, 500000, 500001, 2000000, 2000001, 5e7, 1e13];
const configs = () => {
  const base = P.normalizeConfig({});
  const out = [];
  for (const mode of P.MODES) {
    out.push({ name: `global ${mode}`, cfg: { ...base, mode } });
    out.push({ name: `global ${mode}, every department controlled`, cfg: { ...base, mode, department_modes: Object.fromEntries(P.DEPT_KEYS.map((d) => [d, 'controlled'])) } });
  }
  out.push({ name: 'controlled, autonomy paused', cfg: { ...base, mode: 'controlled', autonomy_paused: true } });
  out.push({ name: 'controlled, daily limit 0', cfg: { ...base, mode: 'controlled', autonomy_daily_limit: 0 } });
  out.push({ name: 'controlled, huge thresholds', cfg: { ...base, mode: 'controlled', thresholds: Object.fromEntries(P.CATEGORIES.map((c) => [c, [1e12, 1e12, 1e12]])) } });
  return out;
};

// Each check returns a list of failures (empty = holds).
function run() {
  const checks = [], add = (key, label, fails) => checks.push({ key, label, ok: fails.length === 0, failures: fails.slice(0, 5), failed_count: fails.length });
  const cfgs = configs(), types = Object.keys(P.ACTIONS), exec = (r) => r.route === 'execute';
  const each = (fn) => { const f = []; for (const { name, cfg } of cfgs) for (const type of types) for (const amountNgn of AMOUNTS) { const d = P.decide({ type, amountNgn, config: cfg }); const m = fn(type, P.ACTIONS[type], d, cfg, amountNgn); if (m) f.push(`${type} @ ${amountNgn} (${name}): ${m}`); } return f; };

  add('human_never_executes', 'Payments, signatures and banking changes are never carried out by the AI', each((t, i, d) => (i.human && exec(d) ? 'routed to execute' : null)));
  add('money_over_limit', 'Any money action above the level-1 limit always needs a person', each((t, i, d, c, a) => (i.money && P.levelForAmount(i.category, a, c.thresholds) >= 2 && exec(d) ? 'routed to execute' : null)));
  add('financial_capped', 'The financial department can never run autonomously', each((t, i, d) => (i.dept === 'financial' && d.mode !== 'monitor' && d.mode !== 'assisted' ? `mode ${d.mode}` : null)));
  add('monitor_no_action', 'In Monitor mode nothing commits anything (only level-0 looks and drafts run)', each((t, i, d, c) => (d.mode === 'monitor' && exec(d) && d.level !== 0 ? 'executed above level 0' : null)));
  add('assisted_no_action', 'In Assisted mode nothing above level 0 runs without approval', each((t, i, d) => (d.mode === 'assisted' && exec(d) && d.level !== 0 ? 'executed above level 0' : null)));
  add('level2_plus_human', 'Level 2 and above is never executed by the AI on its own', each((t, i, d) => (d.level >= 2 && exec(d) ? `level ${d.level} executed` : null)));
  add('paused_stops', 'While autonomy is paused, only level-0 actions run', each((t, i, d, c) => (c.autonomy_paused && exec(d) && d.level !== 0 ? 'executed while paused' : null)));
  add('daily_limit', 'At the daily limit, level-1 actions ask a person', (() => { const f = []; const cfg = P.normalizeConfig({ mode: 'controlled', autonomy_daily_limit: 3 }); for (const t of types) { const d = P.decide({ type: t, amountNgn: 1000, config: cfg, autonomousToday: 3 }); if (exec(d) && d.level !== 0) f.push(`${t}: executed past the limit`); } return f; })());
  add('l1_switch', 'A level-1 action a person switched off needs approval', (() => { const f = []; for (const t of types.filter((x) => P.ACTIONS[x].level === 1)) { const cfg = P.normalizeConfig({ mode: 'controlled', l1_disabled: [t] }); const d = P.decide({ type: t, amountNgn: 1000, config: cfg }); if (exec(d)) f.push(`${t}: executed though switched off`); } return f; })());
  add('l1_budget', 'The daily autonomous budget cannot be passed', (() => { const f = []; for (const t of types.filter((x) => P.ACTIONS[x].level === 1 && P.ACTIONS[x].money)) { const cfg = P.normalizeConfig({ mode: 'controlled', l1_daily_budget_ngn: 50000 }); const d = P.decide({ type: t, amountNgn: 40000, l1SpentNgn: 20000, config: cfg }); if (exec(d)) f.push(`${t}: passed the budget`); } return f; })());
  add('split_detected', 'Splitting one purchase into small ones does not avoid approval', (() => { const f = []; for (const t of types.filter((x) => P.ACTIONS[x].money)) { const cfg = P.normalizeConfig({ mode: 'controlled' }); const i = P.ACTIONS[t]; const d = P.decide({ type: t, amountNgn: 90000, cumulativeNgn: 90000 * 6, config: cfg }); if (d.level < 2 || exec(d)) f.push(`${t}: 6 x 90,000 stayed at level ${d.level}`); void i; } return f; })());
  add('unknown_value', 'A value that cannot be converted at a verified rate is treated as the highest level', (() => { const f = []; for (const t of types.filter((x) => P.ACTIONS[x].money)) { const d = P.decide({ type: t, amountNgn: 1e13, config: P.normalizeConfig({ mode: 'controlled' }) }); if (d.level !== 4 || exec(d)) f.push(`${t}: level ${d.level}`); } return f; })());
  add('unknown_action', 'An action that is not in the catalogue is refused', (() => { const d = P.decide({ type: 'payment.release_all', amountNgn: 1, config: P.normalizeConfig({ mode: 'controlled' }) }); return d.route === 'blocked' ? [] : ['routed to ' + d.route]; })());
  add('emergency_senior', 'An emergency request is always seen at level 3 or above', (() => { const f = []; for (const t of types) { const d = P.decide({ type: t, amountNgn: 0, emergency: true, config: P.normalizeConfig({ mode: 'controlled' }) }); if (d.level < 3 || (exec(d) && P.ACTIONS[t].level >= 1)) f.push(`${t}: level ${d.level}, ${d.route}`); } return f; })());
  add('global_ceiling', 'A department can never run above the global mode', (() => { const f = []; for (const g of P.MODES) for (const m of P.MODES) for (const dept of P.DEPT_KEYS) { const e = P.effectiveMode(dept, P.normalizeConfig({ mode: g, department_modes: { [dept]: m } })); if (P.MODE_RANK[e] > P.MODE_RANK[g]) f.push(`${dept}: global ${g}, own ${m}, runs ${e}`); } return f; })());
  add('two_person', 'Level 4 needs two different approvers', (() => { const f = []; for (const t of types.filter((x) => P.ACTIONS[x].money)) { const d = P.decide({ type: t, amountNgn: 5e7, config: P.normalizeConfig({ mode: 'controlled' }) }); if (d.required_approvals < 2) f.push(`${t}: ${d.required_approvals} approval`); } return f; })());
  add('no_self_approval', 'Nobody approves their own request, and nobody decides twice', (() => { const f = []; const ap = { id: 5, role: 'admin' }; const a = { status: 'pending', deadline: 9e12, requested_by_kind: 'user', requested_by_user: 5, level_required: 2 }; if (P.approverMayDecide({ approver: ap, approval: a }).ok) f.push('requester approved own request'); if (P.approverMayDecide({ approver: { id: 6, role: 'admin' }, approval: a, decided: [6] }).ok) f.push('approved twice'); if (P.approverMayDecide({ approver: { id: 7, role: 'staff', max_level: 2 }, approval: { ...a, level_required: 3 } }).ok) f.push('level 2 approved a level 3 request'); if (P.approverMayDecide({ approver: { id: 8, role: 'admin' }, approval: { ...a, deadline: 1 } }).ok) f.push('approved an expired request'); return f; })());
  add('payload_binding', 'An approval is bound to the exact terms reviewed (changing any term changes the hash)', (() => { const a = { supplier: 'X', qty: 10, price: 5 }; return P.hashPayload(a) !== P.hashPayload({ ...a, price: 6 }) && P.hashPayload(a) === P.hashPayload({ price: 5, qty: 10, supplier: 'X' }) ? [] : ['hash does not track terms']; })());
  add('sod', 'One person may not hold two conflicting steps, and the AI never approves or pays', (() => { const f = []; for (const [a, b] of [['request_create', 'po_approve'], ['supplier_approve', 'po_approve'], ['po_approve', 'payment_authorize'], ['goods_receipt', 'payment_authorize'], ['invoice_verify', 'payment_authorize'], ['request_create', 'payment_authorize']]) { if (!P.sodConflict([{ step: a, actor: 'u1' }], b, 'u1')) f.push(`${a} + ${b} by one person allowed`); if (P.sodConflict([{ step: a, actor: 'u1' }], b, 'u2')) f.push(`${a} + ${b} by two people refused`); } for (const st of ['po_approve', 'payment_authorize', 'supplier_approve', 'invoice_verify', 'goods_receipt']) if (!P.sodConflict([], st, 'ai')) f.push(`the AI may perform ${st}`); return f; })());

  const failed = checks.filter((c) => !c.ok);
  return { ran_at: Math.floor(Date.now() / 1000), total: checks.length, passed: checks.length - failed.length, failed: failed.length, ok: failed.length === 0, cases: cfgs.length * types.length * AMOUNTS.length, checks };
}
module.exports = { run, AMOUNTS };
