'use strict';
// Phase 7 rules without a database: the safeguard test, the pause switch, the daily limit and the rollout gate.
// Run with: npm run test:ops-autonomy:unit
const assert = require('assert');
const P = require('../lib/ops/policy'), SG = require('../lib/ops/safeguards'), AU = require('../lib/ops/autonomy');
let passed = 0, failed = 0;
const test = (n, f) => { try { f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); } };
const ctl = (o = {}) => P.normalizeConfig({ mode: 'controlled', ...o });
const lvl1 = Object.keys(P.ACTIONS).find((t) => P.ACTIONS[t].level === 1 && !P.ACTIONS[t].money);

test('the safeguard test passes on the real rules', () => { const r = SG.run(); assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => !c.ok))); assert.ok(r.total >= 18 && r.cases > 5000); });
test('the safeguard test CATCHES a broken rule (it is not a rubber stamp)', () => {
  const real = P.decide;
  try {
    P.decide = (a) => ({ ...real(a), route: 'execute' });                        // a faulty policy that lets everything run
    const r = SG.run(); assert.ok(!r.ok); const bad = r.checks.filter((c) => !c.ok).map((c) => c.key);
    for (const k of ['human_never_executes', 'money_over_limit', 'monitor_no_action', 'assisted_no_action', 'level2_plus_human', 'paused_stops', 'daily_limit', 'l1_switch']) assert.ok(bad.includes(k), k + ' not caught');
  } finally { P.decide = real; }
});
test('a policy that lets the financial department go autonomous is caught', () => {
  const real = P.decide; try { P.decide = (a) => { const d = real(a); return d.department === 'financial' ? { ...d, mode: 'controlled', route: 'execute' } : d; }; const r = SG.run(); assert.ok(!r.ok); assert.ok(!r.checks.find((c) => c.key === 'financial_capped').ok); } finally { P.decide = real; }
});
test('a policy that lets one person approve their own request is caught', () => {
  const real = P.approverMayDecide; try { P.approverMayDecide = () => ({ ok: true }); assert.ok(!SG.run().checks.find((c) => c.key === 'no_self_approval').ok); } finally { P.approverMayDecide = real; }
});
test('pause switch: level-1 actions ask a person, level-0 still run', () => {
  assert.strictEqual(P.decide({ type: lvl1, config: ctl() }).route, 'execute');
  assert.strictEqual(P.decide({ type: lvl1, config: ctl({ autonomy_paused: true }) }).route, 'approval');
  const l0 = Object.keys(P.ACTIONS).find((t) => P.ACTIONS[t].level === 0 && !P.ACTIONS[t].human);
  assert.strictEqual(P.decide({ type: l0, config: ctl({ autonomy_paused: true }) }).route, 'execute');
});
test('daily autonomous limit', () => {
  const c = ctl({ autonomy_daily_limit: 5 });
  assert.strictEqual(P.decide({ type: lvl1, config: c, autonomousToday: 4 }).route, 'execute');
  assert.strictEqual(P.decide({ type: lvl1, config: c, autonomousToday: 5 }).route, 'approval');
});
test('config: new keys are validated and defaulted', () => {
  const c = P.normalizeConfig({ autonomy_paused: 'yes', breaker_failures: -3, breaker_window_min: 'x', autonomy_daily_limit: 1e9 });
  assert.strictEqual(c.autonomy_paused, false); assert.strictEqual(c.breaker_failures, 1); assert.strictEqual(c.breaker_window_min, 30); assert.strictEqual(c.autonomy_daily_limit, 100000);
  assert.strictEqual(P.normalizeConfig({}).autonomy_paused, false);
});

const base = () => ({ approvers: 3, senior_approvers: 1, monitor_enabled: true, monitor_age_min: 5, critical_open: 0, providers_ready: 1, riders_verified: 4, riders_fresh_gps: 2,
  safeguard: { ok: true, age_h: 1 }, evidence: Object.fromEntries(P.DEPT_KEYS.map((d) => [d, { decided: 12, approved_pct: 90 }])), ack: Object.fromEntries(P.DEPT_KEYS.map((d) => [d, { by: 'o' }])) });
const failing = (f, d, t) => AU.gate(f, d, t).checks.filter((c) => !c.ok).map((c) => c.key);
test('gate: everything met -> open', () => assert.ok(AU.gate(base(), 'riders').ok));
test('gate: needs two approvers, one senior', () => {
  assert.deepStrictEqual(failing({ ...base(), approvers: 1 }, 'riders'), ['approvers']);
  assert.deepStrictEqual(failing({ ...base(), senior_approvers: 0 }, 'riders'), ['approvers']);
});
test('gate: assisted only needs approvers', () => { assert.ok(AU.gate({ ...base(), safeguard: null, evidence: {}, ack: {} }, 'riders', 'assisted').ok); assert.ok(!AU.gate({ ...base(), approvers: 0 }, 'riders', 'assisted').ok); });
test('gate: monitor must be recent and on', () => {
  assert.deepStrictEqual(failing({ ...base(), monitor_age_min: 45 }, 'riders'), ['monitor']);
  assert.deepStrictEqual(failing({ ...base(), monitor_age_min: null }, 'riders'), ['monitor']);
  assert.deepStrictEqual(failing({ ...base(), monitor_enabled: false }, 'riders'), ['monitor']);
});
test('gate: a critical exception blocks', () => assert.deepStrictEqual(failing({ ...base(), critical_open: 1 }, 'riders'), ['critical']));
test('gate: the safeguard test must exist, pass and be fresh', () => {
  assert.deepStrictEqual(failing({ ...base(), safeguard: null }, 'riders'), ['safeguards']);
  assert.deepStrictEqual(failing({ ...base(), safeguard: { ok: false, age_h: 1 } }, 'riders'), ['safeguards']);
  assert.deepStrictEqual(failing({ ...base(), safeguard: { ok: true, age_h: 30 } }, 'riders'), ['safeguards']);
});
test('gate: evidence needs 10 decisions and 80% approved', () => {
  const ev = (o) => ({ ...base(), evidence: { ...base().evidence, riders: o } });
  assert.deepStrictEqual(failing(ev({ decided: 9, approved_pct: 100 }), 'riders'), ['evidence']);
  assert.deepStrictEqual(failing(ev({ decided: 40, approved_pct: 79 }), 'riders'), ['evidence']);
  assert.deepStrictEqual(failing(ev({ decided: 0, approved_pct: null }), 'riders'), ['evidence']);
  assert.ok(AU.gate(ev({ decided: 10, approved_pct: 80 }), 'riders').ok);
});
test('gate: the owner must acknowledge each department', () => assert.deepStrictEqual(failing({ ...base(), ack: { retail: {} } }, 'riders'), ['acknowledged']));
test('gate: riders need verified riders with live GPS; couriers need a rated provider', () => {
  assert.deepStrictEqual(failing({ ...base(), riders_fresh_gps: 0 }, 'riders'), ['riders']);
  assert.deepStrictEqual(failing({ ...base(), riders_verified: 0 }, 'riders'), ['riders']);
  assert.deepStrictEqual(failing({ ...base(), providers_ready: 0 }, 'couriers'), ['providers']);
  assert.ok(AU.gate({ ...base(), providers_ready: 0 }, 'retail').ok);
});
test('gate: financial can never open, even with everything else met', () => assert.deepStrictEqual(failing(base(), 'financial'), ['human_only']));
test('gate: failures carry a readable detail', () => assert.ok(AU.gate({ ...base(), critical_open: 2 }, 'riders').checks.find((c) => c.key === 'critical').detail.includes('2')));
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
