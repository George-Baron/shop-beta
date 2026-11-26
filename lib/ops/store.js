'use strict';
// AI Operations Manager: what it stores about itself. Settings, its append-only action log, exceptions, tasks.
const { get, all, run, now } = require('../db');
const S = require('../shop');
const P = require('./policy');
const { fail, str, int } = S;

const AI_NAME = 'Velto AI Operations Manager';

/* ---------- settings ---------- */
async function getConfig() {
  const raw = {};
  for (const r of await all('SELECT key, value FROM ops_config')) raw[r.key] = r.value;
  return P.normalizeConfig(raw);
}
// patch: any of the config keys. Thresholds merge by category; department_modes replaces the whole map. Returns the stored configuration.
async function saveConfig(patch, by) {
  const cur = await getConfig(), p = patch && typeof patch === 'object' ? patch : {};
  const merged = { ...cur, ...p, thresholds: { ...cur.thresholds, ...(p.thresholds || {}) }, department_modes: 'department_modes' in p ? p.department_modes : cur.department_modes };
  const next = P.normalizeConfig(merged), t = now();
  for (const [k, v] of Object.entries(next)) {
    if (JSON.stringify(v) === JSON.stringify(cur[k])) continue;
    await run('INSERT INTO ops_config (key,value,updated,updated_by) VALUES (?,?::jsonb,?,?) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated=EXCLUDED.updated, updated_by=EXCLUDED.updated_by', k, JSON.stringify(v), t, str(by, 80));
    await logAction({ agent: 'settings', actor_kind: 'human', actor_name: by, action_type: 'config.change', description: `Setting "${k}" changed`, status: 'done', result: { key: k, from: cur[k], to: v } });
  }
  return next;
}

/* ---------- the action log (append only: the database refuses edits and deletes) ---------- */
const clip = (v, max = 4000) => { if (v === undefined || v === null) return null; let s; try { s = JSON.stringify(v); } catch { return null; } return s.length > max ? JSON.stringify({ truncated: true, preview: s.slice(0, max - 40) }) : s; };
// a: { agent, actor_kind, actor_user, actor_name, action_type, description, related_type, related_id, mode, level, status, data_used, recommendation, result, approval_id, approver, external_ref, error, reversal_of }
async function logAction(a) {
  try {
    const r = await get(`INSERT INTO ops_actions (agent,actor_kind,actor_user,actor_name,action_type,description,related_type,related_id,mode,level,status,data_used,recommendation,result,approval_id,approver,external_ref,error,reversal_of,created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?::jsonb,?,?,?,?,?,?) RETURNING id, ref`,
    str(a.agent, 60) || 'system', a.actor_kind || 'system', a.actor_user || null, str(a.actor_name, 80), str(a.action_type, 60), str(a.description, 400), str(a.related_type, 40), str(a.related_id, 60), str(a.mode, 20),
    a.level == null ? null : Number(a.level), a.status || 'done', clip(a.data_used), str(a.recommendation, 800), clip(a.result), a.approval_id || null, str(a.approver, 200), str(a.external_ref, 120), str(a.error, 400), a.reversal_of || null, now());
    return r;
  } catch (e) { console.error('AI action log failed:', e.message); return null; }
}
async function listActions(q = {}) {
  const w = [], a = [];
  if (q.agent) { w.push('agent=?'); a.push(str(q.agent, 60)); }
  if (['ai_autonomous', 'ai_approved', 'human', 'integration', 'system'].includes(q.actor_kind)) { w.push('actor_kind=?'); a.push(q.actor_kind); }
  if (['done', 'recommended', 'pending_approval', 'blocked', 'failed', 'read'].includes(q.status)) { w.push('status=?'); a.push(q.status); }
  else if (!q.status) w.push("status<>'read'");   // the quiet read-only lookups stay out of the way unless asked for
  if (q.related_type && q.related_id) { w.push('related_type=? AND related_id=?'); a.push(str(q.related_type, 40), str(q.related_id, 60)); }
  if (q.q) { w.push("(lower(description) LIKE ? OR lower(action_type) LIKE ? OR lower(agent) LIKE ?)"); const t = '%' + str(q.q, 60).toLowerCase().replace(/[\\%_]/g, '') + '%'; a.push(t, t, t); }
  const lim = Math.min(200, Math.max(1, int(q.limit, 60))), before = int(q.before, 0);
  if (before) { w.push('id<?'); a.push(before); }
  return all(`SELECT * FROM ops_actions ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ${lim}`, ...a);
}

/* ---------- exceptions ---------- */
const SEV = ['informational', 'low', 'medium', 'high', 'critical'];
const sevRank = (s) => SEV.indexOf(s);
// One open row per dedupe_key. Raising it again only refreshes it. High and critical ones tell the right people once, and again if they get worse.
async function raiseException(x) {
  const sev = SEV.includes(x.severity) ? x.severity : 'medium', t = now();
  const r = await get(`INSERT INTO ops_exceptions (kind,severity,title,detail,impact,recommended_action,department,related_type,related_id,dedupe_key,auto,status,detected_by,created,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)
    ON CONFLICT (dedupe_key) WHERE status IN ('open','acknowledged') DO UPDATE SET detail=EXCLUDED.detail, title=EXCLUDED.title, severity=EXCLUDED.severity, impact=EXCLUDED.impact, recommended_action=EXCLUDED.recommended_action, updated=EXCLUDED.updated
    RETURNING id, ref, severity, notified_severity, (xmax = 0) AS inserted`,
  str(x.kind, 60), sev, str(x.title, 200), str(x.detail, 800), str(x.impact, 400), str(x.recommended_action, 400), str(x.department, 40), str(x.related_type, 40), str(x.related_id, 60), str(x.dedupe_key, 160), x.auto === false ? 0 : 1, str(x.detected_by, 60) || AI_NAME, t, t);
  if (r.inserted) await logAction({ agent: x.detected_by || 'risk_compliance', actor_kind: 'system', action_type: 'exception.raise', description: `${r.ref} ${sev}: ${x.title}`, related_type: x.related_type, related_id: x.related_id, status: 'done', result: { exception: r.ref, severity: sev } });
  // sevRank('') is -1, so a first notification always goes; after that only a worse severity tells people again
  if (sevRank(sev) >= sevRank('high') && sevRank(sev) > sevRank(r.notified_severity)) {
    await require('../notify').toStaff('ops', true, { type: 'ops_exception', title: `${sev === 'critical' ? 'CRITICAL: ' : ''}${str(x.title, 120)}`, body: str(x.recommended_action || x.detail, 300), link: '/admin#/opsai', email: sev === 'critical' });
    await run('UPDATE ops_exceptions SET notified_severity=? WHERE id=?', sev, r.id);
  }
  return { id: Number(r.id), ref: r.ref, created: !!r.inserted };
}
// The monitor tells us which problems still exist. Automatic ones of these kinds that no longer do are closed.
async function resolveAbsent(kinds, seenKeys) {
  const open = await all("SELECT id, dedupe_key FROM ops_exceptions WHERE auto=1 AND status IN ('open','acknowledged') AND kind = ANY(?)", kinds);
  const seen = new Set(seenKeys); let n = 0;
  for (const o of open) if (!seen.has(o.dedupe_key)) { await run("UPDATE ops_exceptions SET status='resolved', resolved_at=?, resolved_by=?, resolution='The condition cleared.', updated=? WHERE id=? AND status IN ('open','acknowledged')", now(), AI_NAME, now(), o.id); n++; }
  return n;
}
async function listExceptions(q = {}) {
  const w = [], a = [];
  const st = q.status || 'active';
  if (st === 'active') w.push("status IN ('open','acknowledged')"); else if (['open', 'acknowledged', 'resolved', 'dismissed'].includes(st)) { w.push('status=?'); a.push(st); }
  if (SEV.includes(q.severity)) { w.push('severity=?'); a.push(q.severity); }
  const rows = await all(`SELECT * FROM ops_exceptions ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, updated DESC LIMIT 200`, ...a);
  return rows;
}
async function updateException(user, id, b) {
  const x = await get('SELECT * FROM ops_exceptions WHERE id=?', int(id)); if (!x) fail(404, 'Exception not found.');
  const to = str(b.status, 20); if (!['acknowledged', 'resolved', 'dismissed', 'open'].includes(to)) fail(400, 'Choose acknowledged, resolved, dismissed or open.');
  if (['resolved', 'dismissed'].includes(to) && !str(b.resolution, 400)) fail(400, 'Write what was done, so the record is useful later.');
  await run('UPDATE ops_exceptions SET status=?, resolution=?, resolved_at=?, resolved_by=?, updated=? WHERE id=?', to, str(b.resolution, 400), ['resolved', 'dismissed'].includes(to) ? now() : null, ['resolved', 'dismissed'].includes(to) ? str(user.name || user.email, 80) : '', now(), x.id);
  await logAction({ agent: 'risk_compliance', actor_kind: 'human', actor_user: user.id, actor_name: user.name, action_type: 'exception.update', description: `${x.ref} set to ${to}`, related_type: 'exception', related_id: x.ref, status: 'done', result: { to, resolution: str(b.resolution, 200) } });
}

/* ---------- tasks ---------- */
async function createTask(t, by) {
  const title = str(t.title, 160); if (!title) fail(400, 'A task needs a title.');
  const prio = ['low', 'normal', 'high', 'urgent'].includes(t.priority) ? t.priority : 'normal', n = now();
  const r = await run('INSERT INTO ops_tasks (title,detail,department,priority,due,related_type,related_id,created_by_kind,created_by,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)', title, str(t.detail, 800), P.DEPT_KEYS.includes(t.department) ? t.department : '', prio, int(t.due) || null, str(t.related_type, 40), str(t.related_id, 60), by && by.kind === 'user' ? 'user' : 'ai', str(by && by.name, 80) || AI_NAME, n, n);
  return Number(r.lastInsertRowid);
}
async function listTasks(status) { return all(`SELECT * FROM ops_tasks ${['open', 'in_progress', 'done', 'cancelled'].includes(status) ? 'WHERE status=?' : "WHERE status IN ('open','in_progress')"} ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, id DESC LIMIT 200`, ...(['open', 'in_progress', 'done', 'cancelled'].includes(status) ? [status] : [])); }
async function updateTask(user, id, b) {
  const to = str(b.status, 20); if (!['open', 'in_progress', 'done', 'cancelled'].includes(to)) fail(400, 'Choose open, in progress, done or cancelled.');
  const r = await run('UPDATE ops_tasks SET status=?, updated=? WHERE id=?', to, now(), int(id)); if (!r.changes) fail(404, 'Task not found.');
  await logAction({ agent: 'order_management', actor_kind: 'human', actor_user: user.id, actor_name: user.name, action_type: 'task.update', description: `Task ${id} set to ${to}`, related_type: 'task', related_id: String(id), status: 'done' });
}

const dayStartUtc = () => { const t = now(); return t - (t % 86400); };
module.exports = { AI_NAME, getConfig, saveConfig, logAction, listActions, SEV, sevRank, raiseException, resolveAbsent, listExceptions, updateException, createTask, listTasks, updateTask, dayStartUtc };
