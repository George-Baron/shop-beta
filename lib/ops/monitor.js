'use strict';
// The scheduled watch. It only OBSERVES: it reads real data, raises an exception for each problem found (one open row per problem),
// and closes the ones that have cleared. It changes no orders, stock or money. Runs every few minutes from the worker.
const { all, now } = require('../db');
const D = require('./data');
const St = require('./store');
const AP = require('./approvals');
const { enabled } = require('./agents');

const hours = (m) => Math.round(m / 6) / 10;
async function run() {
  const cfg = await St.getConfig();
  if (!cfg.monitor_enabled) return { skipped: 'monitor switched off' };
  const seen = new Set(), found = [];
  const raise = async (agent, x) => { if (!enabled(cfg, agent)) return; seen.add(x.dedupe_key); found.push(x.kind); await St.raiseException({ ...x, detected_by: agent }); };

  // Late and waiting orders are now followed stage by stage by lib/ops/orders.js (kind order_late); the old kinds stay in the list below only so leftovers close.
  for (const l of await D.stuckDropship(50)) await raise('partner_dropship', { kind: 'dropship_stuck', severity: l.waiting_hours > 96 ? 'high' : 'medium', dedupe_key: 'dropship_stuck:' + l.line_id, title: `Supplier ${l.supplier} is slow on ${l.order_ref}`, detail: `Status "${l.status}" for ${l.waiting_hours}h, longer than the supplier's processing time.`, impact: 'The customer is waiting on a supplier item.', recommended_action: 'Chase the supplier or reassign the item.', department: 'dropshipping', related_type: 'dropship_line', related_id: String(l.line_id) });
  for (const m of await D.negativeMargin(50)) await raise('finance', { kind: 'negative_margin', severity: 'medium', dedupe_key: 'negative_margin:' + m.line_id, title: `Order ${m.order_ref} sells below cost`, detail: `Revenue ₦${m.revenue} against recorded cost ₦${m.cost_ngn}.`, impact: `Loss of ₦${m.loss}.`, recommended_action: 'Review the supplier price or the selling price (a person must change prices).', department: 'financial', related_type: 'dropship_line', related_id: String(m.line_id) });

  const rs = await D.retailStock();
  for (const p of rs.critical_items) await raise('inventory', { kind: 'stock_critical', severity: 'high', dedupe_key: 'stock_critical:' + p.id, title: `${p.name} is out of stock and still selling`, detail: `${p.sold_30d} sold in 30 days, ${p.incoming} incoming.`, impact: 'Lost sales until restocked.', recommended_action: 'Reorder now (procurement approval applies).', department: 'procurement', related_type: 'product', related_id: String(p.id) });

  const tr = await D.trade();
  for (const h of tr.customs_holds) await raise('international_trade', { kind: 'customs_hold', severity: 'high', dedupe_key: 'customs_hold:' + h.id, title: `${h.direction} ${h.ref} is ${h.customs_status} at customs`, detail: `Customs status "${h.customs_status}".`, impact: 'Goods are not moving; storage or demurrage may build up.', recommended_action: 'Contact the clearing agent and supply any missing documents.', department: 'import_export', related_type: 'trade_shipment', related_id: String(h.id) });
  for (const h of tr.past_eta) await raise('international_trade', { kind: 'trade_past_eta', severity: 'medium', dedupe_key: 'trade_past_eta:' + h.id, title: `${h.direction} ${h.ref} is past its ETA`, detail: `Expected date has passed and it has not arrived.`, impact: 'Stock or delivery dates may slip.', recommended_action: 'Ask the forwarder for the latest tracking.', department: 'import_export', related_type: 'trade_shipment', related_id: String(h.id) });

  const sp = await D.suppliers();
  for (const p of sp.payables) if (p.overdue_count > 0) await raise('finance', { kind: 'payable_overdue', severity: 'medium', dedupe_key: 'payable_overdue:' + p.currency, title: `${p.overdue_count} supplier payable(s) overdue (${p.currency})`, detail: `${p.currency} ${p.overdue} is past due.`, impact: 'Supplier relationships and supply may suffer.', recommended_action: 'A finance approver should review and pay (the AI cannot pay).', department: 'financial' });
  const rd = await D.riders();
  if (rd.stale_gps > 0) await raise('logistics', { kind: 'gps_stale', severity: 'low', dedupe_key: 'gps_stale', title: `${rd.stale_gps} active rider(s) have an old GPS position`, detail: 'No location in the last 5 minutes.', impact: 'Tracking and dispatch may be wrong.', recommended_action: 'Ask the riders to reopen the app.', department: 'riders' });
  for (const j of (await D.opsSummary()).failed_jobs) await raise('risk', { kind: 'job_failed', severity: 'medium', dedupe_key: 'job_failed:' + j.kind, title: `Background job "${j.kind}" failed ${j.count}x in 24h`, detail: String(j.last_error || ''), impact: 'Some automatic work is not happening.', recommended_action: 'Check the error and the integration behind it.', department: 'retail' });

  const stale = await all("SELECT id, ref, action_type FROM ops_approvals WHERE status='pending' AND created<?", now() - 24 * 3600);
  for (const a of stale) await raise('risk', { kind: 'approval_waiting', severity: 'low', dedupe_key: 'approval_waiting:' + a.id, title: `Approval ${a.ref} has waited over 24h`, detail: `Action ${a.action_type} is waiting for a decision.`, impact: 'The work it covers is on hold.', recommended_action: 'An approver should decide, or reject it.', department: 'retail', related_type: 'approval', related_id: String(a.id) });

  const kinds = ['order_delayed', 'awaiting_dispatch', 'dropship_stuck', 'negative_margin', 'stock_critical', 'customs_hold', 'trade_past_eta', 'payable_overdue', 'gps_stale', 'job_failed', 'approval_waiting'];
  const closed = await St.resolveAbsent(kinds, [...seen]);
  const expired = await AP.expireDue();
  return { raised_or_refreshed: found.length, closed, expired };
}
module.exports = { run };
