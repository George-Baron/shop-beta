'use strict';
// Phase 7: controlled autonomy. Nothing becomes autonomous because someone flipped a switch: a department earns Controlled mode with evidence.
//   facts()      what is true right now (approvers, monitor, exceptions, providers, riders, safeguard test, assisted-mode record)
//   gate()       PURE: facts + department -> which requirements are met (this is what the tests exercise)
//   evidence()   per department: how many AI proposals people decided, and what share they approved
//   guard()      used by the settings route: refuses an upward mode change unless the gate passes or the owner gives a written override
//   checkBreaker() pauses autonomy by itself when autonomous actions keep failing
const { all, get, run, now } = require('../db');
const { fail, str } = require('../shop');
const P = require('./policy');
const St = require('./store');
const SG = require('./safeguards');

const REQ = { min_decided: 10, min_approved_pct: 80, safeguard_max_age_h: 24, monitor_max_age_min: 30, gps_fresh_min: 15 };

/* ---------- small stored values (kept in ops_config under keys the settings form never touches) ---------- */
async function kvGet(key) { const r = await get('SELECT value FROM ops_config WHERE key=?', key); return r ? r.value : null; }
async function kvSet(key, value, by) { await run('INSERT INTO ops_config (key,value,updated,updated_by) VALUES (?,?::jsonb,?,?) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated=EXCLUDED.updated, updated_by=EXCLUDED.updated_by', key, JSON.stringify(value), now(), str(by, 80)); }

/* ---------- the safeguard test ---------- */
async function runSafeguards(by) {
  const r = SG.run();
  await kvSet('safeguard_last', { ran_at: r.ran_at, ok: r.ok, total: r.total, passed: r.passed, failed: r.failed, cases: r.cases, failing: r.checks.filter((c) => !c.ok).map((c) => c.key) }, by);
  await St.logAction({ agent: 'settings', actor_kind: 'human', actor_name: by, action_type: 'safeguards.test', description: r.ok ? `Safeguard test passed (${r.passed}/${r.total} rules, ${r.cases} cases)` : `Safeguard test FAILED: ${r.failed} of ${r.total} rules broken`, status: r.ok ? 'done' : 'failed', result: { total: r.total, passed: r.passed, failed: r.failed }, error: r.ok ? '' : r.checks.filter((c) => !c.ok).map((c) => c.key).join(', ') });
  return r;
}

/* ---------- evidence from Assisted mode ---------- */
async function evidence() {
  const rows = await all("SELECT department d, status s, COUNT(*) n FROM ops_approvals WHERE requested_by_kind='ai' AND executor='system' GROUP BY department, status");
  const out = Object.fromEntries(P.DEPT_KEYS.map((d) => [d, { approved: 0, rejected: 0, decided: 0, approved_pct: null, failed: 0 }]));
  for (const r of rows) {
    const e = out[r.d]; if (!e) continue; const n = Number(r.n);
    if (['approved', 'executing', 'completed'].includes(r.s)) e.approved += n; else if (['rejected', 'returned'].includes(r.s)) e.rejected += n; else if (r.s === 'failed') { e.approved += n; e.failed += n; }
  }
  for (const e of Object.values(out)) { e.decided = e.approved + e.rejected; e.approved_pct = e.decided ? Math.round((100 * e.approved) / e.decided) : null; }
  return out;
}

/* ---------- facts ---------- */
async function facts() {
  const t = now(), cfg = await St.getConfig();
  const ap = await all("SELECT u.id, 4 lvl FROM users u WHERE u.role='admin' UNION SELECT a.user_id, a.max_level FROM ops_approvers a");
  const best = new Map(); for (const r of ap) best.set(Number(r.id), Math.max(best.get(Number(r.id)) || 0, Number(r.lvl)));
  const last = await kvGet('monitor_last_run'), sg = await kvGet('safeguard_last');
  const crit = Number((await get("SELECT COUNT(*) n FROM ops_exceptions WHERE severity='critical' AND status IN ('open','acknowledged')")).n);
  const prov = Number((await get("SELECT COUNT(DISTINCT p.id) n FROM ops_providers p JOIN ops_rate_cards r ON r.provider_id=p.id WHERE p.status='approved' AND (r.valid_until IS NULL OR r.valid_until>?)", t)).n);
  const riders = await get("SELECT COUNT(*) n FROM riders WHERE suspended=0 AND verification_status='verified'");
  const fresh = await get("SELECT COUNT(*) n FROM riders r JOIN rider_latest_location l ON l.rider_id=r.id WHERE r.suspended=0 AND r.verification_status='verified' AND l.received_at>?", t - REQ.gps_fresh_min * 60).catch(() => ({ n: 0 }));
  return {
    now: t, config: cfg, approvers: best.size, senior_approvers: [...best.values()].filter((l) => l >= 3).length,
    monitor_enabled: cfg.monitor_enabled, monitor_age_min: last && last.at ? Math.round((t - last.at) / 60) : null,
    critical_open: crit, providers_ready: prov, riders_verified: Number(riders.n), riders_fresh_gps: Number(fresh.n),
    safeguard: sg ? { ...sg, age_h: Math.round(((t - sg.ran_at) / 3600) * 10) / 10 } : null,
    paused: cfg.autonomy_paused, evidence: await evidence(), ack: (await kvGet('autonomy_ack')) || {},
  };
}

/* ---------- the gate (pure) ---------- */
// Requirements every department must meet, plus the ones that belong to its work. Each is { key, label, ok, detail }.
function gate(f, dept, target = 'controlled') {
  const c = (key, label, ok, detail) => ({ key, label, ok: !!ok, detail });
  const g = [
    c('approvers', 'At least two different people can approve, one of them senior (level 3+)', f.approvers >= 2 && f.senior_approvers >= 1, `${f.approvers} approver(s), ${f.senior_approvers} senior`),
  ];
  if (target !== 'controlled') return { ok: g.every((x) => x.ok), checks: g, target };
  const e = f.evidence[dept] || { decided: 0, approved_pct: null };
  g.push(
    c('monitor', 'The monitor is switched on and has run in the last 30 minutes', f.monitor_enabled && f.monitor_age_min !== null && f.monitor_age_min <= REQ.monitor_max_age_min, f.monitor_age_min === null ? 'never run' : `last ran ${f.monitor_age_min} min ago`),
    c('critical', 'No critical exceptions are open', f.critical_open === 0, `${f.critical_open} open`),
    c('safeguards', 'The safeguard test passed in the last 24 hours', f.safeguard && f.safeguard.ok && f.safeguard.age_h <= REQ.safeguard_max_age_h, f.safeguard ? `${f.safeguard.ok ? 'passed' : 'FAILED'} ${f.safeguard.age_h} h ago` : 'not run yet'),
    c('evidence', `At least ${REQ.min_decided} of its Assisted-mode proposals were decided by people, ${REQ.min_approved_pct}% or more approved`, e.decided >= REQ.min_decided && e.approved_pct >= REQ.min_approved_pct, `${e.decided} decided, ${e.approved_pct === null ? 'none' : e.approved_pct + '%'} approved`),
    c('acknowledged', 'The owner has acknowledged the limits for this department', !!(f.ack && f.ack[dept]), f.ack && f.ack[dept] ? 'acknowledged' : 'not yet'),
  );
  if (dept === 'riders') g.push(c('riders', 'Verified riders exist and their GPS is live', f.riders_verified > 0 && f.riders_fresh_gps > 0, `${f.riders_verified} verified, ${f.riders_fresh_gps} with GPS in the last ${REQ.gps_fresh_min} min`));
  if (dept === 'couriers') g.push(c('providers', 'An approved courier provider has a current rate', f.providers_ready > 0, `${f.providers_ready} ready`));
  if (P.HUMAN_ONLY_DEPARTMENTS.includes(dept)) g.push(c('human_only', 'Financial transactions are never autonomous', false, 'Money moves only through a person'));
  return { ok: g.every((x) => x.ok), checks: g, target };
}

async function readiness() {
  const f = await facts();
  const departments = P.DEPARTMENTS.map(([key, label]) => ({ key, label, mode: P.effectiveMode(key, f.config), evidence: f.evidence[key], controlled: gate(f, key, 'controlled'), assisted: gate(f, key, 'assisted'), acknowledged: !!f.ack[key] }));
  return { facts: { approvers: f.approvers, senior_approvers: f.senior_approvers, monitor_age_min: f.monitor_age_min, critical_open: f.critical_open, providers_ready: f.providers_ready, riders_verified: f.riders_verified, riders_fresh_gps: f.riders_fresh_gps, safeguard: f.safeguard, paused: f.paused }, requirements: REQ, departments, limits: { l1_daily_budget_ngn: f.config.l1_daily_budget_ngn, autonomy_daily_limit: f.config.autonomy_daily_limit, breaker_failures: f.config.breaker_failures, breaker_window_min: f.config.breaker_window_min, thresholds: f.config.thresholds.procurement } };
}

async function acknowledge(dept, by) {
  if (!P.DEPT_KEYS.includes(dept)) fail(400, 'Unknown department.');
  if (P.HUMAN_ONLY_DEPARTMENTS.includes(dept)) fail(400, 'Financial transactions can never be autonomous.');
  const cur = (await kvGet('autonomy_ack')) || {}; cur[dept] = { by: str(by, 80), at: now() };
  await kvSet('autonomy_ack', cur, by);
  await St.logAction({ agent: 'settings', actor_kind: 'human', actor_name: by, action_type: 'autonomy.acknowledge', description: `Owner acknowledged the autonomous limits for ${dept}`, status: 'done' });
  return cur;
}

// A request to change modes. Returns { allowed, blocked: [{dept, target, failing}] }. Called with the stored config and the patch about to be applied.
async function guard(patch, by, override) {
  const cur = await St.getConfig(), after = P.normalizeConfig({ ...cur, ...patch, department_modes: 'department_modes' in patch ? patch.department_modes : cur.department_modes });
  const moves = [];
  for (const d of P.DEPT_KEYS) { const b = P.effectiveMode(d, cur), a = P.effectiveMode(d, after); if (P.MODE_RANK[a] > P.MODE_RANK[b]) moves.push({ dept: d, from: b, to: a }); }
  if (!moves.length) return { allowed: true, moves, blocked: [] };
  const f = await facts(), blocked = [];
  for (const m of moves) { const g = gate(f, m.dept, m.to); const failing = g.checks.filter((x) => !x.ok); if (failing.length) blocked.push({ ...m, failing: failing.map((x) => ({ key: x.key, label: x.label, detail: x.detail })) }); }
  if (!blocked.length) return { allowed: true, moves, blocked };
  const why = str(override, 400);
  if (why.length >= 15 && !blocked.some((b) => b.failing.some((x) => x.key === 'human_only'))) {
    await St.logAction({ agent: 'settings', actor_kind: 'human', actor_name: by, action_type: 'autonomy.override', description: `Owner raised autonomy without meeting: ${[...new Set(blocked.flatMap((b) => b.failing.map((x) => x.key)))].join(', ')}`, status: 'done', recommendation: why, result: { moves, blocked } });
    return { allowed: true, overridden: true, moves, blocked };
  }
  return { allowed: false, moves, blocked };
}

/* ---------- the circuit breaker and the pause switch ---------- */
async function failuresInWindow(cfg) { return Number((await get("SELECT COUNT(*) n FROM ops_actions WHERE actor_kind='ai_autonomous' AND status='failed' AND created>=?", now() - cfg.breaker_window_min * 60)).n); }
async function autonomousToday() { return Number((await get("SELECT COUNT(*) n FROM ops_actions WHERE actor_kind='ai_autonomous' AND status='done' AND COALESCE(level,0)>=1 AND created>=?", now() - 86400)).n); }
async function checkBreaker() {
  const cfg = await St.getConfig(); if (cfg.autonomy_paused) return { tripped: false, already: true };
  const n = await failuresInWindow(cfg); if (n < cfg.breaker_failures) return { tripped: false, failures: n };
  await St.saveConfig({ autonomy_paused: true }, 'Circuit breaker');
  await St.raiseException({ kind: 'autonomy_paused', severity: 'critical', title: 'Autonomy paused: the AI\'s own actions kept failing', detail: `${n} autonomous actions failed in ${cfg.breaker_window_min} minutes.`, impact: 'The AI now asks a person before every action. Nothing is lost.', recommended_action: 'Open the Go-live tab, read the failed actions in the audit log, fix the cause, then resume.', department: 'risk_compliance', related_type: 'autonomy', related_id: 'breaker', dedupe_key: 'autonomy:breaker', auto: false, detected_by: 'risk_compliance' });
  await St.logAction({ agent: 'risk_compliance', actor_kind: 'system', action_type: 'autonomy.pause', description: `Autonomy paused automatically after ${n} failed actions`, status: 'done', result: { failures: n } });
  return { tripped: true, failures: n };
}
async function setPaused(paused, by, reason) {
  const cfg = await St.saveConfig({ autonomy_paused: !!paused }, by);
  await St.logAction({ agent: 'settings', actor_kind: 'human', actor_name: by, action_type: paused ? 'autonomy.pause' : 'autonomy.resume', description: paused ? 'Autonomy paused by a person' : 'Autonomy resumed by a person', status: 'done', recommendation: str(reason, 300) });
  if (!paused) await run("UPDATE ops_exceptions SET status='resolved', resolved_at=?, resolved_by=?, resolution='A person resumed autonomy.', updated=? WHERE dedupe_key='autonomy:breaker' AND status IN ('open','acknowledged')", now(), str(by, 80), now());
  return cfg;
}
async function recentAutonomous(limit = 30) {
  return all("SELECT ref, agent, action_type, description, status, level, error, created FROM ops_actions WHERE actor_kind='ai_autonomous' ORDER BY id DESC LIMIT ?", limit);
}

module.exports = { REQ, kvGet, kvSet, runSafeguards, evidence, facts, gate, readiness, acknowledge, guard, checkBreaker, setPaused, autonomousToday, recentAutonomous };
