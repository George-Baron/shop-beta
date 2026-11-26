'use strict';
// Global order management. Every order from every channel (retail, partner, dropshipping, international, wholesale) is registered the first time it is seen,
// then followed stage by stage until it ends. A person-facing problem is raised when a stage runs late; routine nudges go through the gateway so they are
// logged and obey the mode and permission rules. This file reads the store's own tables and never edits an order, stock or money.
// An order is only closed as delivered after the store itself recorded the delivery; whether the handover was PROVEN (OTP, signature, photo) is kept
// separately, and a delivery with no proof is flagged for a person instead of being quietly accepted.
const { get, all, run, now } = require('../db');
const St = require('./store');
const G = require('./gateway');
const ST = require('./order-stage');
const D = require('./data');
const { readySql } = require('../dispatch');

const num = (v) => Number(v) || 0;
const BACKOFF_MIN = 15, MAX_ATTEMPTS = 5;
const DEPT = { customer: 'retail', orders: 'retail', procurement: 'procurement', supplier: 'dropshipping', forwarder: 'import_export', dispatch: 'riders', rider: 'riders', wholesale: 'wholesale' };
const sevOrder = ['none', 'low', 'medium', 'high', 'critical'];

async function slaOf() { return ST.normalizeSla((await St.getConfig()).order_sla); }

/* ---------- facts ---------- */
async function orderFacts() {
  const rows = await all(`SELECT o.*, ${D.CHANNEL_SQL} AS channel, (${readySql}) AS is_ready,
      (SELECT assignment_status FROM rider_assignments a WHERE a.order_id=o.id ORDER BY a.id DESC LIMIT 1) AS ra_status,
      (SELECT COALESCE(a.assigned_at,0) FROM rider_assignments a WHERE a.order_id=o.id ORDER BY a.id DESC LIMIT 1) AS ra_at,
      (SELECT COUNT(*) FROM delivery_proofs d WHERE d.order_id=o.id AND (d.otp_verified=1 OR COALESCE(d.proof_image_url,'')<>'' OR COALESCE(d.recipient_confirmation,'')<>'')) AS proof_rows,
      (SELECT t.status FROM ops_trade_links tl JOIN trade_shipments t ON t.id=tl.shipment_id WHERE tl.kind='order' AND tl.ref_id=o.id AND t.status<>'cancelled' ORDER BY t.id DESC LIMIT 1) AS trade_status,
      (SELECT t.ref FROM ops_trade_links tl JOIN trade_shipments t ON t.id=tl.shipment_id WHERE tl.kind='order' AND tl.ref_id=o.id AND t.status<>'cancelled' ORDER BY t.id DESC LIMIT 1) AS trade_ref,
      (SELECT t.updated FROM ops_trade_links tl JOIN trade_shipments t ON t.id=tl.shipment_id WHERE tl.kind='order' AND tl.ref_id=o.id AND t.status<>'cancelled' ORDER BY t.id DESC LIMIT 1) AS trade_since,
      (SELECT COUNT(*) FROM dropship_lines l WHERE l.order_id=o.id AND l.status='issue') AS ds_issue_n,
      (SELECT COUNT(*) FROM dropship_lines l WHERE l.order_id=o.id AND l.status NOT IN ('delivered','cancelled','refunded','returned') AND l.status<>'shipped') AS ds_waiting,
      (SELECT COUNT(*) FROM dropship_lines l WHERE l.order_id=o.id AND l.status='shipped') AS ds_shipping,
      (SELECT MIN(l.created) FROM dropship_lines l WHERE l.order_id=o.id AND l.status NOT IN ('delivered','cancelled','refunded','returned')) AS ds_since
    FROM orders o
    WHERE o.status NOT IN ('delivered','cancelled','refunded')
       OR EXISTS (SELECT 1 FROM ops_order_watch w WHERE w.kind='order' AND w.ref_id=o.id AND w.closed_at IS NULL)
    ORDER BY o.id DESC LIMIT 2000`);
  return rows.map((o) => ({ kind: 'order', id: num(o.id), ref: o.ref, channel: o.channel, name: o.name, total: num(o.total), country: o.country || 'NG', facts: {
    kind: 'order', status: o.status, payment_method: o.payment_method, payment_status: o.payment_status, created: num(o.created), confirmed_at: num(o.confirmed_at) || null, delivered_at: num(o.delivered_at) || null,
    handover_locked: num(o.handover_locked) === 1, rider_id: o.rider_id, accepted_at: num(o.accepted_at) || null, picked_up_at: num(o.picked_up_at) || null, on_way_at: num(o.on_way_at) || null, promised_at: num(o.promised_at) || null,
    ra_status: o.ra_status || '', ra_at: num(o.ra_at) || null, own_lines: num(o.own_lines), ds_lines: num(o.ds_lines), ds_open: num(o.ds_open), ds_issue: num(o.ds_issue_n) > 0, ds_waiting: num(o.ds_waiting), ds_shipping: num(o.ds_shipping), ds_since: num(o.ds_since) || null,
    international: (o.country || 'NG') !== 'NG', trade_status: o.trade_status || '', trade_ref: o.trade_ref || '', trade_since: num(o.trade_since) || null, ready: !!o.is_ready, delivery: o.delivery, proof_rows: num(o.proof_rows) } }));
}
async function wholesaleFacts() {
  const rows = await all(`SELECT q.*, a.business_name, f.stage AS f_stage, f.picking_started, f.packed_at, f.dispatched_at, f.delivered_by, f.delivered_at AS f_delivered, f.failed_attempts
    FROM wholesale_quotes q JOIN wholesale_accounts a ON a.id=q.account_id LEFT JOIN wholesale_fulfilments f ON f.quote_id=q.id
    WHERE q.status NOT IN ('delivered','declined','cancelled','expired')
       OR EXISTS (SELECT 1 FROM ops_order_watch w WHERE w.kind='wholesale' AND w.ref_id=q.id AND w.closed_at IS NULL)
    ORDER BY q.id DESC LIMIT 1000`);
  return rows.map((q) => ({ kind: 'wholesale', id: num(q.id), ref: q.order_no || q.ref, channel: 'wholesale', name: q.business_name, total: num(q.total), country: 'NG', facts: {
    kind: 'wholesale', status: q.status, stage: q.f_stage || '', created: num(q.created), quoted_at: num(q.quoted_at) || null, accepted_at: num(q.accepted_at) || null, paid_at: num(q.paid_at) || null, shipped_at: num(q.shipped_at) || null,
    delivered_at: num(q.delivered_at) || num(q.f_delivered) || null, picking_started: num(q.picking_started) || null, packed_at: num(q.packed_at) || null, dispatched_at: num(q.dispatched_at) || null,
    failed_attempts: num(q.failed_attempts), delivered_by: q.delivered_by || '' } }));
}

/* ---------- one sweep ---------- */
// Returns counts. Safe to run any number of times: every write is keyed, and an unchanged order only has its last_seen refreshed.
async function sweep({ at } = {}) {
  const cfg = await St.getConfig();
  if (!cfg.monitor_enabled) return { skipped: 'monitor switched off' };
  if ((cfg.agents_disabled || []).includes('orders')) return { skipped: 'Order Management Agent switched off' };
  const t = at || now(), sla = await slaOf(), items = [...await orderFacts(), ...await wholesaleFacts()];
  const out = { seen: items.length, new: 0, moved: 0, late: 0, closed: 0, unproven: 0, nudges: 0 }, seenLate = new Set(), seenProof = new Set();
  for (const it of items) {
    const c = it.kind === 'wholesale' ? ST.classifyWholesale(it.facts, t) : ST.classifyOrder(it.facts, t);
    let w = await get('SELECT * FROM ops_order_watch WHERE kind=? AND ref_id=?', it.kind, it.id);
    if (w && w.closed_at) continue;
    if (!w) {
      await run(`INSERT INTO ops_order_watch (kind,ref_id,ref,channel,stage,owner,stage_since,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, it.kind, it.id, it.ref, it.channel, c.stage, c.owner, c.since, t, t);
      await run('INSERT INTO ops_order_stage_events (kind,ref_id,from_stage,to_stage,detected,note) VALUES (?,?,?,?,?,?)', it.kind, it.id, '', c.stage, t, 'First seen');
      w = await get('SELECT * FROM ops_order_watch WHERE kind=? AND ref_id=?', it.kind, it.id); out.new++;
    } else if (w.stage !== c.stage) {
      await run('INSERT INTO ops_order_stage_events (kind,ref_id,from_stage,to_stage,detected,note) VALUES (?,?,?,?,?,?)', it.kind, it.id, w.stage, c.stage, t, c.next_action.slice(0, 200));
      await run('UPDATE ops_order_watch SET stage=?, owner=?, stage_since=?, attempts=0, last_action_at=NULL, last_seen=?, channel=?, ref=? WHERE kind=? AND ref_id=?', c.stage, c.owner, c.since, t, it.channel, it.ref, it.kind, it.id);
      w.stage = c.stage; w.attempts = 0; w.last_action_at = null; out.moved++;
    } else await run('UPDATE ops_order_watch SET last_seen=?, owner=?, channel=? WHERE kind=? AND ref_id=?', t, c.owner, it.channel, it.kind, it.id);

    if (c.terminal) {                                  // the store says it ended: close it, and say whether delivery was proven
      const proof = c.outcome === 'delivered' ? ST.proofState(it.facts) : 'not_applicable';
      await run('UPDATE ops_order_watch SET closed_at=?, outcome=?, proof=? WHERE kind=? AND ref_id=?', t, c.outcome, proof, it.kind, it.id); out.closed++;
      if (proof === 'unproven') {
        out.unproven++; seenProof.add('order_unproven:' + it.kind + ':' + it.id);
        await St.raiseException({ kind: 'order_unproven', severity: 'medium', dedupe_key: 'order_unproven:' + it.kind + ':' + it.id, title: `${it.ref} was marked delivered with no proof of delivery`, detail: 'The store shows the order as delivered but there is no OTP, signature, photo or recipient confirmation on record.', impact: 'Delivery cannot be defended if the customer disputes it.', recommended_action: 'Confirm with the customer or rider and attach the evidence, or reopen the order.', department: 'riders', related_type: it.kind === 'wholesale' ? 'wholesale_quote' : 'order', related_id: String(it.id), auto: true, detected_by: 'orders' });
      }
      continue;
    }
    const L = ST.lateness(c, it.facts, sla, t);
    if (!L.late) continue;
    out.late++;
    const key = 'order_late:' + it.kind + ':' + it.id; seenLate.add(key);
    const exhausted = num(w.attempts) >= MAX_ATTEMPTS;
    let sev = L.severity; if (exhausted && sevOrder.indexOf(sev) < sevOrder.indexOf('high')) sev = 'high';
    await St.raiseException({ kind: 'order_late', severity: sev, dedupe_key: key, title: `${it.ref} (${it.channel}) is late at "${ST.STAGES[c.stage].label}"`,
      detail: `In this stage ${L.minutes_in_stage} min; allowed ${L.sla_min} min; ${L.overdue_min} min over. Owner: ${c.owner || 'unassigned'}.${exhausted ? ' The AI has tried ' + MAX_ATTEMPTS + ' times and stopped; a person must act.' : ''}`,
      impact: `Order value ${it.total}. The customer is waiting.`, recommended_action: c.next_action, department: DEPT[c.owner] || 'retail', related_type: it.kind === 'wholesale' ? 'wholesale_quote' : 'order', related_id: String(it.id), auto: true, detected_by: it.kind === 'wholesale' ? 'wholesale' : 'orders' });
    if (cfg.orders_follow_up !== false && !exhausted && (!w.last_action_at || t - num(w.last_action_at) >= BACKOFF_MIN * 60 * Math.pow(2, num(w.attempts)))) {
      const r = await nudge(it, c, L); if (r) { out.nudges++; await run('UPDATE ops_order_watch SET attempts=attempts+1, last_action_at=? WHERE kind=? AND ref_id=?', t, it.kind, it.id); }
    }
  }
  await St.resolveAbsent(['order_late'], seenLate);
  await St.resolveAbsent(['order_unproven'], seenProof);
  return out;
}

// The one thing the AI does about a late order, through the gateway (logged, mode- and permission-checked). Returns true if something was attempted.
async function nudge(it, c) {
  const ctx = { agent: it.kind === 'wholesale' ? 'wholesale' : c.stage === 'awaiting_dispatch' ? 'logistics' : 'orders' };
  const rel = { related_type: it.kind === 'wholesale' ? 'wholesale_quote' : 'order', related_id: String(it.id) };
  try {
    if (it.kind === 'order' && c.stage === 'awaiting_dispatch') { await G.perform(ctx, 'rider.assign', { ...rel, order_id: it.id, summary: `Offer ${it.ref} to the best available rider` }); return true; }
    if (c.stage === 'awaiting_payment') return false;
    await G.perform(ctx, 'customer.draft', { ...rel, summary: `Draft an update for ${it.ref}: ${ST.STAGES[c.stage].label}`, payload: { stage: c.stage, next_action: c.next_action } });
    return true;
  } catch (e) { console.error('Order follow-up failed for', it.ref, e.message); return false; }
}

/* ---------- reads for the board ---------- */
async function board({ channel = '', stage = '', late = false, limit = 200 } = {}) {
  const sla = await slaOf(), t = now(), where = ['w.closed_at IS NULL'], args = [];
  if (channel) { where.push('w.channel=?'); args.push(channel); }
  if (stage) { where.push('w.stage=?'); args.push(stage); }
  const rows = await all(`SELECT w.* FROM ops_order_watch w WHERE ${where.join(' AND ')} ORDER BY w.stage_since ASC LIMIT ?`, ...args, Math.min(500, Math.max(1, Number(limit) || 200)));
  const list = rows.map((w) => { const c = { stage: w.stage, since: num(w.stage_since), terminal: false }, L = ST.lateness(c, {}, sla, t);
    return { kind: w.kind, id: num(w.ref_id), ref: w.ref, channel: w.channel, stage: w.stage, stage_label: (ST.STAGES[w.stage] || {}).label || w.stage, owner: w.owner, since: num(w.stage_since), minutes_in_stage: L.minutes_in_stage, sla_min: L.sla_min, overdue_min: L.overdue_min, late: L.late, severity: L.severity, waiting_on_customer: L.customer_wait, attempts: num(w.attempts) }; })
    .filter((x) => !late || x.late);
  const by = {}; for (const x of list) { by[x.stage] = by[x.stage] || { stage: x.stage, label: x.stage_label, count: 0, late: 0 }; by[x.stage].count++; if (x.late) by[x.stage].late++; }
  const closed = await get(`SELECT COUNT(*) FILTER (WHERE outcome='delivered') delivered, COUNT(*) FILTER (WHERE outcome='delivered' AND proof='unproven') unproven, COUNT(*) FILTER (WHERE outcome IN ('cancelled','refunded','declined','expired','abandoned')) ended FROM ops_order_watch WHERE closed_at >= ?`, t - 7 * 86400);
  return { stages: Object.values(by), orders: list, open: list.length, late: list.filter((x) => x.late).length, last7d: { delivered: num(closed.delivered), delivered_unproven: num(closed.unproven), ended_other: num(closed.ended) } };
}
async function timeline(kind, id) {
  const w = await get('SELECT * FROM ops_order_watch WHERE kind=? AND ref_id=?', kind, Number(id)); if (!w) return null;
  const events = await all('SELECT from_stage, to_stage, detected, note FROM ops_order_stage_events WHERE kind=? AND ref_id=? ORDER BY id', kind, Number(id));
  const actions = await all("SELECT id, agent, action_type, description, status, created FROM ops_actions WHERE related_type=? AND related_id=? ORDER BY id DESC LIMIT 30", kind === 'wholesale' ? 'wholesale_quote' : 'order', String(id));
  const ex = await all("SELECT ref, severity, title, status, created FROM ops_exceptions WHERE related_type=? AND related_id=? ORDER BY id DESC LIMIT 20", kind === 'wholesale' ? 'wholesale_quote' : 'order', String(id));
  return { watch: { ...w, stage_label: (ST.STAGES[w.stage] || {}).label || w.stage }, events, actions, exceptions: ex };
}

module.exports = { sweep, board, timeline, orderFacts, wholesaleFacts, nudge, BACKOFF_MIN, MAX_ATTEMPTS };
