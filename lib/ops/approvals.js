'use strict';
// The approval engine. An action that needs a person becomes an approval request tied to the exact terms that were reviewed (a hash of them).
// People approve, reject or send it back. At the end, an approved action is executed ONCE (or, for money and signatures, a person does it and records it).
// The AI can ask; it can never approve (there is no code path from an AI request to a decision without a signed-in person).
const { get, all, run, tx, now } = require('../db');
const S = require('../shop');
const P = require('./policy');
const St = require('./store');
const { HANDLERS } = require('./handlers');
const { fail, str, int } = S;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const termsOf = (r) => ({ type: r.action_type, payload: r.payload || {}, amount: round2(r.amount), currency: r.currency, counterparty: r.counterparty || '', related_type: r.related_type || '', related_id: r.related_id || '' });
const hashOf = (r) => P.hashPayload(termsOf(r));

// Naira value of an amount at the verified rate. { ngn, unknown }: with no rate we do not guess, the caller treats the value as unknown (highest level).
async function toNgn(amount, currency) {
  const a = round2(amount), cur = String(currency || 'NGN').toUpperCase();
  if (a <= 0) return { ngn: 0, unknown: false };
  if (cur === 'NGN') return { ngn: a, unknown: false };
  try { return { ngn: round2(require('../fx').toNaira(a, cur, await require('../dropship').rates())), unknown: false }; } catch { return { ngn: 0, unknown: true }; }
}

// Money already committed to the same counterparty in the same category inside the window: approvals that are still alive plus what the AI did on its own.
async function cumulativeNgn(category, counterparty, windowSec) {
  const since = now() - windowSec;
  const a = await get("SELECT COALESCE(SUM(amount_ngn),0) n FROM ops_approvals WHERE category=? AND counterparty=? AND created>=? AND status IN ('pending','approved','executing','completed')", category, counterparty || '', since);
  const b = await get("SELECT COALESCE(SUM((result->>'amount_ngn')::numeric),0) n FROM ops_actions WHERE status='done' AND actor_kind='ai_autonomous' AND result->>'category'=? AND COALESCE(result->>'counterparty','')=? AND created>=?", category, counterparty || '', since);
  return Number(a.n) + Number(b.n);
}
async function autonomousSpentNgn(category) {
  const r = await get("SELECT COALESCE(SUM((result->>'amount_ngn')::numeric),0) n FROM ops_actions WHERE status='done' AND actor_kind='ai_autonomous' AND result->>'category'=? AND created>=?", category, now() - 86400);
  return Number(r.n);
}

async function approverOf(user) {
  if (!user) return null;
  if (user.role === 'admin') return { id: Number(user.id), role: 'admin', max_level: 4, emergency: 1 };
  if (user.role !== 'staff') return null;
  const r = await get('SELECT max_level, emergency FROM ops_approvers WHERE user_id=?', user.id);
  return { id: Number(user.id), role: 'staff', max_level: r ? Number(r.max_level) : 0, emergency: r ? Number(r.emergency) : 0 };
}

const actorOf = (kind, userId) => (kind === 'ai' ? 'ai' : 'user:' + userId);
async function recordStep(relatedType, relatedId, step, actor, approvalId) {
  if (!relatedType || !relatedId) return;
  await run('INSERT INTO ops_sod_steps (related_type,related_id,step,actor,approval_id,created) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING', relatedType, String(relatedId), step, actor, approvalId || null, now());
}
const stepsFor = (relatedType, relatedId) => all('SELECT step, actor FROM ops_sod_steps WHERE related_type=? AND related_id=?', relatedType, String(relatedId));

/* ---------- ask ---------- */
// t: { type, d (the policy decision), params, amountNgn, valueUnknown, agent, user, cfg }. Idempotent: asking again for the same open action returns the same request.
async function create(t) {
  const info = P.actionInfo(t.type), p = t.params || {}, cfg = t.cfg;
  const currency = String(p.currency || 'NGN').toUpperCase();
  const row = { action_type: t.type, payload: p.payload || {}, amount: round2(p.amount), currency, counterparty: str(p.counterparty, 120), related_type: str(p.related_type, 40), related_id: str(p.related_id, 60) };
  const hash = hashOf(row), idem = str(p.idem_key, 120) || `${t.type}:${hash.slice(0, 32)}`;
  const dup = await get("SELECT id, ref, status FROM ops_approvals WHERE idem_key=? AND status IN ('pending','approved','executing')", idem);
  if (dup) return { id: Number(dup.id), ref: dup.ref, status: dup.status, existing: true };
  // 'user' = a signed-in person made the request by hand; 'ai' = the AI Operations Manager did (a person may still have been the one chatting with it)
  const byUser = t.requestedByUser && t.user ? Number(t.user.id) : null;
  const kind = t.requestedByUser ? 'user' : 'ai', n = now();
  try {
    const r = await run(`INSERT INTO ops_approvals (action_type,category,department,level_required,required_approvals,amount,currency,amount_ngn,effective_ngn,value_unknown,summary,justification,risk,payload,payload_hash,related_type,related_id,counterparty,
        requested_by_kind,requested_by_agent,requested_by_user,status,emergency,emergency_reason,executor,deadline,idem_key,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)`,
    t.type, info.category, info.dept, t.d.level, t.d.required_approvals, row.amount, currency, t.amountNgn, t.d.effective_amount_ngn, t.valueUnknown ? 1 : 0, str(p.summary, 300) || info.label, str(p.justification, 800), t.d.risk, JSON.stringify(row.payload), hash, row.related_type, row.related_id, row.counterparty,
    kind, str(t.agent, 60), byUser, t.d.emergency ? 1 : 0, str(p.emergency_reason, 300), info.human ? 'human' : 'system', n + cfg.approval_hours * 3600, idem, n, n);
    const id = Number(r.lastInsertRowid), ref = (await get('SELECT ref FROM ops_approvals WHERE id=?', id)).ref;
    await recordStep(row.related_type, row.related_id, 'request_create', actorOf(kind, byUser), id);
    await require('../notify').toStaff('ops', true, { type: 'ops_approval', title: `Approval needed (level ${t.d.level}): ${str(p.summary || info.label, 100)}`, body: `${ref}${t.amountNgn ? ' · ₦' + Math.round(t.amountNgn).toLocaleString('en-NG') : ''}`, link: '/admin#/opsai' });
    return { id, ref, status: 'pending', existing: false };
  } catch (e) { if (e && e.code === '23505') { const again = await get("SELECT id, ref, status FROM ops_approvals WHERE idem_key=? AND status IN ('pending','approved','executing')", idem); if (again) return { id: Number(again.id), ref: again.ref, status: again.status, existing: true }; } throw e; }
}

/* ---------- decide ---------- */
async function decide(user, id, decision, note) {
  if (!['approve', 'reject', 'return'].includes(decision)) fail(400, 'Choose approve, reject or return.');
  if (decision !== 'approve' && !str(note, 400)) fail(400, 'Please write why, so the AI and your team can act on it.');
  const out = await tx(async () => {
    const a = await get('SELECT * FROM ops_approvals WHERE id=? FOR UPDATE', int(id)); if (!a) fail(404, 'Approval request not found.');
    const who = await approverOf(user);
    const decided = (await all('SELECT user_id FROM ops_approval_decisions WHERE approval_id=?', a.id)).map((r) => r.user_id);
    const ok = P.approverMayDecide({ approver: who, approval: a, decided });
    if (!ok.ok) fail(403, ok.reason);
    if (hashOf(a) !== a.payload_hash) fail(409, 'These terms were changed after the request was made. Cancel it and ask again.');
    const info = P.actionInfo(a.action_type);
    if (decision === 'approve' && info && info.sod && a.related_id) {
      const problem = P.sodConflict(await stepsFor(a.related_type, a.related_id), info.sod, actorOf('user', user.id));
      if (problem) fail(403, problem);
    }
    await run('INSERT INTO ops_approval_decisions (approval_id,user_id,user_name,decision,note,payload_hash,created) VALUES (?,?,?,?,?,?,?)', a.id, user.id, str(user.name || user.email, 80), decision, str(note, 400), a.payload_hash, now());
    const all2 = await all('SELECT user_id, decision FROM ops_approval_decisions WHERE approval_id=?', a.id);
    const status = P.tally(a, all2);
    await run('UPDATE ops_approvals SET status=?, approved_hash=?, updated=? WHERE id=?', status, status === 'approved' ? a.payload_hash : null, now(), a.id);
    if (decision === 'approve' && info && info.sod && a.related_id) await recordStep(a.related_type, a.related_id, info.sod, actorOf('user', user.id), a.id);
    return { a, status, level: ok.level };
  });
  await St.logAction({ agent: 'risk_compliance', actor_kind: 'human', actor_user: user.id, actor_name: user.name, action_type: 'approval.' + decision, description: `${out.a.ref} ${decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'returned for revision'}${out.status === 'pending' ? ' (more approvals needed)' : ''}`, related_type: 'approval', related_id: out.a.ref, level: out.a.level_required, status: 'done', approval_id: out.a.id, approver: str(user.name || user.email, 80), result: { status: out.status, note: str(note, 200) } });
  let executed = null;
  if (out.status === 'approved' && out.a.executor === 'system') executed = await execute(out.a.id, user);
  return { ok: true, status: executed ? executed.status || out.status : out.status, executed };
}

/* ---------- execute ---------- */
// Runs an approved action exactly once. The status change to 'executing' is the lock: a second call finds nothing to claim.
async function execute(id, user) {
  const claimed = await run("UPDATE ops_approvals SET status='executing', updated=? WHERE id=? AND status='approved' AND executor='system'", now(), int(id));
  if (!claimed.changes) return { skipped: true, status: (await get('SELECT status FROM ops_approvals WHERE id=?', int(id)) || {}).status };
  const a = await get('SELECT * FROM ops_approvals WHERE id=?', int(id));
  const finish = async (status, result, err) => {
    await run('UPDATE ops_approvals SET status=?, execution_result=?::jsonb, executed_at=?, updated=? WHERE id=?', status, JSON.stringify(result || {}), now(), now(), a.id);
    const approvers = (await all('SELECT user_name FROM ops_approval_decisions WHERE approval_id=? AND decision=?', a.id, 'approve')).map((r) => r.user_name).join(', ');
    await St.logAction({ agent: a.requested_by_agent || 'orchestrator', actor_kind: 'ai_approved', action_type: a.action_type, description: `${a.ref}: ${a.summary}`, related_type: a.related_type, related_id: a.related_id, level: a.level_required, status: status === 'completed' ? 'done' : 'failed', approval_id: a.id, approver: approvers, result: { ...(result || {}), amount_ngn: Number(a.amount_ngn), category: a.category, counterparty: a.counterparty }, error: err || '' });
    return { status, result };
  };
  try {
    if (hashOf(a) !== a.approved_hash) return await finish('failed', {}, 'The terms no longer match what was approved. Nothing was done.');
    const h = HANDLERS[a.action_type];
    if (!h) return await finish('failed', {}, 'This action is not connected to a system yet, so it was not carried out.');
    const r = await h(a.payload || {}, { agentName: St.AI_NAME, approval: a, user });
    return await finish('completed', { summary: r.summary, ...r.result, outcome: r.status }, '');
  } catch (e) { return finish('failed', {}, str(e.message, 300)); }
}

// Money and signatures: the AI never does them. After approval a person does it elsewhere and records it here with their reference.
async function complete(user, id, b) {
  const a = await get('SELECT * FROM ops_approvals WHERE id=?', int(id)); if (!a) fail(404, 'Approval request not found.');
  if (a.executor !== 'human') fail(400, 'This one is carried out by the system, not by a person.');
  if (a.status !== 'approved') fail(409, `This request is ${a.status}.`);
  const who = await approverOf(user);
  if (!who || who.max_level < Number(a.level_required)) fail(403, 'Only someone at the approval level can record this.');
  if (hashOf(a) !== a.approved_hash) fail(409, 'The terms no longer match what was approved.');
  const ref = str(b && b.reference, 120); if (!ref) fail(400, 'Please enter the payment or document reference.');
  const r = await run("UPDATE ops_approvals SET status='completed', execution_result=?::jsonb, executed_at=?, updated=? WHERE id=? AND status='approved'", JSON.stringify({ reference: ref, by: str(user.name || user.email, 80), note: str(b && b.note, 300) }), now(), now(), a.id);
  if (!r.changes) fail(409, 'Someone else just recorded this.');
  await St.logAction({ agent: 'operations_finance', actor_kind: 'human', actor_user: user.id, actor_name: user.name, action_type: a.action_type, description: `${a.ref}: ${a.summary} carried out by a person`, related_type: a.related_type, related_id: a.related_id, level: a.level_required, status: 'done', approval_id: a.id, external_ref: ref, result: { amount_ngn: Number(a.amount_ngn), category: a.category, counterparty: a.counterparty } });
  return { ok: true };
}

async function cancel(user, id) {
  const a = await get('SELECT * FROM ops_approvals WHERE id=?', int(id)); if (!a) fail(404, 'Approval request not found.');
  const mine = a.requested_by_kind === 'user' && Number(a.requested_by_user) === Number(user.id);
  if (user.role !== 'admin' && !mine) fail(403, 'Only the owner or the person who asked can cancel it.');
  const r = await run("UPDATE ops_approvals SET status='cancelled', updated=? WHERE id=? AND status IN ('pending','approved','returned')", now(), a.id);
  if (!r.changes) fail(409, `This request is ${a.status} and cannot be cancelled.`);
  await St.logAction({ agent: 'risk_compliance', actor_kind: 'human', actor_user: user.id, actor_name: user.name, action_type: 'approval.cancel', description: `${a.ref} cancelled`, related_type: 'approval', related_id: a.ref, status: 'done', approval_id: a.id });
}

// Requests nobody answered in time stop being valid (an old approval must not be used weeks later).
async function expireDue() {
  const due = await all("SELECT id, ref, summary FROM ops_approvals WHERE status='pending' AND deadline<?", now());
  for (const d of due) {
    const r = await run("UPDATE ops_approvals SET status='expired', updated=? WHERE id=? AND status='pending'", now(), d.id);
    if (r.changes) await St.logAction({ agent: 'risk_compliance', actor_kind: 'system', action_type: 'approval.expire', description: `${d.ref} expired without a decision`, related_type: 'approval', related_id: d.ref, status: 'done', approval_id: d.id });
  }
  return due.length;
}

/* ---------- read ---------- */
const shape = (a, decisions = []) => ({
  id: Number(a.id), ref: a.ref, action_type: a.action_type, label: (P.actionInfo(a.action_type) || {}).label || a.action_type, department: a.department, category: a.category, level: Number(a.level_required), required_approvals: Number(a.required_approvals),
  amount: Number(a.amount), currency: a.currency, amount_ngn: Number(a.amount_ngn), effective_ngn: Number(a.effective_ngn), value_unknown: !!Number(a.value_unknown), summary: a.summary, justification: a.justification, risk: a.risk, payload: a.payload,
  related_type: a.related_type, related_id: a.related_id, counterparty: a.counterparty, requested_by: a.requested_by_kind === 'ai' ? St.AI_NAME + (a.requested_by_agent ? ` (${a.requested_by_agent})` : '') : (a.requester_name || 'Staff'),
  requested_by_kind: a.requested_by_kind, status: a.status, emergency: !!Number(a.emergency), emergency_reason: a.emergency_reason, executor: a.executor, deadline: Number(a.deadline), executed_at: a.executed_at ? Number(a.executed_at) : null,
  execution_result: a.execution_result, created: Number(a.created), decisions: decisions.map((d) => ({ user: d.user_name, decision: d.decision, note: d.note, at: Number(d.created) })),
});
async function list(q = {}) {
  await expireDue();
  const st = ['pending', 'approved', 'rejected', 'returned', 'expired', 'executing', 'completed', 'failed', 'cancelled'].includes(q.status) ? q.status : null;
  const rows = await all(`SELECT a.*, u.name AS requester_name FROM ops_approvals a LEFT JOIN users u ON u.id=a.requested_by_user ${st ? 'WHERE a.status=?' : ''} ORDER BY (a.status='pending') DESC, a.id DESC LIMIT 100`, ...(st ? [st] : []));
  const ids = rows.map((r) => r.id), decs = ids.length ? await all('SELECT * FROM ops_approval_decisions WHERE approval_id = ANY(?) ORDER BY id', ids) : [];
  return rows.map((r) => shape(r, decs.filter((d) => Number(d.approval_id) === Number(r.id))));
}

module.exports = { toNgn, cumulativeNgn, autonomousSpentNgn, approverOf, create, decide, execute, complete, cancel, expireDue, list, hashOf, recordStep, stepsFor, round2 };
