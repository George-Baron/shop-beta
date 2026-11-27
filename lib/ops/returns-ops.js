'use strict';
// AI side of returns and refunds. Reads the store's own returns module (lib/returns.js) and never changes a return or moves money:
//   board()      open returns with age, SLA and the assessment
//   detail(id)   one return with the facts the assessment used
//   recommend()  records the assessment through the gateway (refund.recommend, level 0) once per distinct result
//   sweep()      recommends for every open return that has none yet
//   watch()      exceptions for returns nobody reviewed, refunds stuck waiting, and failed settlements
const { all, get, now } = require('../db');
const { fail, str, int } = require('../shop');
const R = require('../returns');
const P = require('./policy');
const St = require('./store');
const G = require('./gateway');
const { assess } = require('./returns-assess');

const SLA = { review_h: 24, review_high_h: 72, settle_h: 72, settling_min: 15 };
const money = (n) => Math.round(Number(n) || 0);

async function facts(id) {
  const d = await R.detail(int(id)), raw = await get('SELECT * FROM order_returns WHERE id=?', int(id)); if (!raw) fail(404, 'Return not found.');
  const prior = raw.user_id ? Number((await get("SELECT COUNT(*) n FROM order_returns WHERE user_id=? AND status='settled' AND id<>? AND settled_at>=?", raw.user_id, raw.id, now() - 90 * 86400)).n) : 0;
  const cfg = await St.getConfig();
  return { raw, d, input: { reason: raw.reason, condition: raw.item_condition, packaging: raw.packaging, requested_ngn: money(raw.requested_amount), max_refund_ngn: money(d.max_refund), photos: (d.photos || []).length, vendors: (d.vendor_shares || []).map((v) => ({ name: v.name, amount: v.amount })), prior_settled_90d: prior, thresholds: cfg.thresholds, past_window: !!Number(raw.past_window || 0) } };
}
const ageH = (t) => Math.round(((now() - Number(t)) / 3600) * 10) / 10;

async function detail(id) {
  const f = await facts(id), a = assess(f.input), r = f.raw;
  return { return: f.d.return, order: f.d.order, assessment: a, facts: f.input, age_hours: ageH(r.created), recommended_before: await lastRec(r.id), note: 'This is a recommendation. Approving, rejecting and settling are done by people in Returns.' };
}
async function lastRec(id) { const r = await get("SELECT ref, created, result FROM ops_actions WHERE action_type='refund.recommend' AND related_type='return' AND related_id=? ORDER BY id DESC LIMIT 1", String(id)); return r ? { ref: r.ref, created: Number(r.created), hash: r.result && r.result.payload && r.result.payload.hash } : null; }

async function board() {
  const rows = await all("SELECT id, ref, order_id, status, created, decided_at, settling_at, last_error, requested_amount, approved_amount, reason FROM order_returns WHERE status IN ('requested','recommended','awaiting_settlement','settling') ORDER BY created LIMIT 100");
  const out = [];
  for (const r of rows) {
    let a = null; try { a = assess((await facts(r.id)).input); } catch { /* order may be gone */ }
    const o = await get('SELECT ref, name FROM orders WHERE id=?', r.order_id);
    const waiting = r.status === 'requested' ? ageH(r.created) : ['awaiting_settlement', 'settling'].includes(r.status) ? ageH(r.decided_at || r.created) : null;
    const late = (r.status === 'requested' && waiting > SLA.review_h) || (r.status === 'awaiting_settlement' && waiting > SLA.settle_h) || (r.status === 'settling' && !!r.settling_at && (now() - Number(r.settling_at)) / 60 > SLA.settling_min);
    out.push({ id: Number(r.id), ref: r.ref, order_ref: o && o.ref, customer: o && o.name, status: r.status, reason: r.reason, requested_ngn: money(r.requested_amount), approved_ngn: r.approved_amount == null ? null : money(r.approved_amount), waiting_hours: waiting, late, error: r.last_error || '', recommendation: a && { action: a.action, summary: a.summary, amount_ngn: a.amount_ngn, approver: a.approver, flags: a.flags } });
  }
  const cfg = await St.getConfig();
  for (const r of await all("SELECT w.id, w.ref, w.status, w.created, w.decided_at, w.settling_at, w.last_error, w.requested_amount, w.reason, a.business_name FROM wholesale_returns w LEFT JOIN wholesale_accounts a ON a.id=w.account_id WHERE w.status IN ('requested','recommended','awaiting_settlement','settling') ORDER BY w.created LIMIT 100").catch(() => [])) {
    const waiting = r.status === 'requested' ? ageH(r.created) : ['awaiting_settlement', 'settling'].includes(r.status) ? ageH(r.decided_at || r.created) : null;
    const lvl = P.levelForAmount('refunds', money(r.requested_amount), cfg.thresholds);
    out.push({ id: Number(r.id), kind: 'wholesale', ref: r.ref, order_ref: null, customer: r.business_name || '', status: r.status, reason: r.reason, requested_ngn: money(r.requested_amount), approved_ngn: null, waiting_hours: waiting,
      late: (r.status === 'requested' && waiting > SLA.review_h) || (r.status === 'awaiting_settlement' && waiting > SLA.settle_h), error: r.last_error || '', recommendation: { action: 'needs_decision', summary: 'Wholesale return: a person decides', amount_ngn: 0, approver: lvl >= 3 ? 'Senior Operations Manager' : lvl === 2 ? 'Operations Supervisor' : 'Staff within the routine limit', flags: [] } });
  }
  return { sla: SLA, open: out.length, late: out.filter((x) => x.late).length, returns: out };
}

// Records the assessment. Same result for the same return is recorded once; a changed result is recorded again.
async function recommend(id, user) {
  const f = await facts(id), a = assess(f.input), hash = require('./policy').hashPayload({ a: a.action, m: a.amount_ngn, e: a.evidence_missing, fl: a.flags });
  const prev = await lastRec(f.raw.id); if (prev && prev.hash === hash) return { recorded: false, reason: 'Already recorded with the same result.', assessment: a };
  const r = await G.perform({ agent: 'customer_fulfilment', user }, 'refund.recommend', { summary: `${f.raw.ref}: ${a.summary}`, related_type: 'return', related_id: String(f.raw.id), payload: { hash, return: f.raw.ref, assessment: a }, data_used: { requested_ngn: f.input.requested_ngn, max_refund_ngn: f.input.max_refund_ngn, photos: f.input.photos, reason: f.input.reason, condition: f.input.condition } });
  return { recorded: true, status: r.status, assessment: a };
}
async function sweep() {
  const cfg = await St.getConfig(); if (cfg.agents_disabled.includes('customer_fulfilment')) return { skipped: 'agent switched off' };
  let n = 0; for (const r of await all("SELECT id FROM order_returns WHERE status IN ('requested','recommended') ORDER BY created LIMIT 50")) { try { if ((await recommend(r.id)).recorded) n++; } catch { /* one bad return must not stop the rest */ } }
  return { recorded: n };
}

async function watch(raise) {
  const t = now();
  for (const r of await all("SELECT r.id, r.ref, r.status, r.created, r.decided_at, r.settling_at, r.last_error, o.ref order_ref FROM order_returns r JOIN orders o ON o.id=r.order_id WHERE r.status IN ('requested','recommended','awaiting_settlement','settling')")) {
    const base = { department: 'refunds', related_type: 'return', related_id: String(r.id), auto: true };
    if (r.status === 'requested') { const h = ageH(r.created); if (h > SLA.review_h) await raise({ ...base, kind: 'return_unreviewed', severity: h > SLA.review_high_h ? 'high' : 'medium', dedupe_key: 'return_unreviewed:' + r.id, title: `Return ${r.ref} (order ${r.order_ref}) has waited ${Math.round(h)} h for review`, detail: 'Nobody has approved or rejected this return.', impact: 'The customer is waiting and the order stays open.', recommended_action: 'Review it in Returns. The AI assessment is on the Returns tab.' }); }
    if (r.status === 'recommended') { const h = ageH(r.created); if (h > SLA.review_h * 2) await raise({ ...base, kind: 'return_owner_wait', severity: 'medium', dedupe_key: 'return_owner_wait:' + r.id, title: `Return ${r.ref} has waited for the owner's decision`, detail: `Reviewed by staff; waiting ${Math.round(h)} h.`, impact: 'The customer is waiting.', recommended_action: 'The owner approves or rejects it in Returns.' }); }
    if (r.status === 'awaiting_settlement') { const h = ageH(r.decided_at || r.created); if (h > SLA.settle_h) await raise({ ...base, kind: 'refund_unsettled', severity: 'high', dedupe_key: 'refund_unsettled:' + r.id, title: `Approved refund for ${r.ref} has not been paid out for ${Math.round(h)} h`, detail: 'The return was approved but settlement has not been done.', impact: 'The customer was promised money back.', recommended_action: 'Settle it in Returns (original payment method, wallet or manual).' }); }
    if (r.last_error && ['awaiting_settlement', 'settling'].includes(r.status)) await raise({ ...base, kind: 'refund_failed', severity: 'high', dedupe_key: 'refund_failed:' + r.id, title: `Refund for ${r.ref} hit an error`, detail: str(r.last_error, 300), impact: 'The refund did not complete.', recommended_action: 'Check the payment gateway, then settle again or pay by hand.' });
    if (r.status === 'settling' && r.settling_at && (t - Number(r.settling_at)) / 60 > SLA.settling_min) await raise({ ...base, kind: 'refund_stuck', severity: 'high', dedupe_key: 'refund_stuck:' + r.id, title: `Refund for ${r.ref} has been "settling" for over ${SLA.settling_min} minutes`, detail: 'The payment gateway did not answer.', impact: 'It may or may not have been sent. Do not pay twice.', recommended_action: 'Check the gateway dashboard for this reference before retrying.' });
  }
}
async function watchWholesale(raise) {
  for (const r of await all("SELECT id, ref, status, created, decided_at, settling_at, last_error FROM wholesale_returns WHERE status IN ('requested','recommended','awaiting_settlement','settling')").catch(() => [])) {
    const base = { department: 'wholesale', related_type: 'wholesale_return', related_id: String(r.id), auto: true };
    if (r.status === 'requested' && ageH(r.created) > SLA.review_h) await raise({ ...base, kind: 'return_unreviewed', severity: ageH(r.created) > SLA.review_high_h ? 'high' : 'medium', dedupe_key: 'wreturn_unreviewed:' + r.id, title: `Wholesale return ${r.ref} has waited ${Math.round(ageH(r.created))} h for review`, detail: 'Nobody has approved or rejected it.', impact: 'A business customer is waiting.', recommended_action: 'Review it in Wholesale returns.' });
    if (r.status === 'awaiting_settlement' && ageH(r.decided_at || r.created) > SLA.settle_h) await raise({ ...base, kind: 'refund_unsettled', severity: 'high', dedupe_key: 'wreturn_unsettled:' + r.id, title: `Approved wholesale refund ${r.ref} has not been paid out`, detail: 'Approved but not settled.', impact: 'The customer was promised money back.', recommended_action: 'Settle it in Wholesale returns.' });
    if (r.last_error && ['awaiting_settlement', 'settling'].includes(r.status)) await raise({ ...base, kind: 'refund_failed', severity: 'high', dedupe_key: 'wreturn_failed:' + r.id, title: `Wholesale refund ${r.ref} hit an error`, detail: str(r.last_error, 300), impact: 'The refund did not complete.', recommended_action: 'Check the payment gateway before settling again.' });
    if (r.status === 'settling' && r.settling_at && (now() - Number(r.settling_at)) / 60 > SLA.settling_min) await raise({ ...base, kind: 'refund_stuck', severity: 'high', dedupe_key: 'wreturn_stuck:' + r.id, title: `Wholesale refund ${r.ref} has been settling for over ${SLA.settling_min} minutes`, detail: 'The gateway did not answer.', impact: 'It may or may not have been sent. Do not pay twice.', recommended_action: 'Check the gateway for this reference before retrying.' });
  }
}
module.exports = { SLA, watchWholesale, facts, detail, board, recommend, sweep, watch };
