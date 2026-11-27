'use strict';
// AI Operations Manager: the rules. Pure functions only (no database), so every rule can be tested exhaustively.
//   decide()            -> what may happen to an action right now: do it, ask a human, only recommend it, or refuse it
//   approverMayDecide() -> may this person decide this approval (level, own request, emergency, repeat decision)
//   sodConflict()       -> segregation of duties: one actor may not hold two conflicting steps of the same purchase or payment
// The database side lives in approvals.js and gateway.js. Nothing here talks to the network or the clock unless it is handed the time.
const crypto = require('crypto');

const MODES = ['monitor', 'assisted', 'controlled'];
const MODE_LABEL = { monitor: 'Monitor (observe and recommend only)', assisted: 'Assisted (prepare, then a person approves)', controlled: 'Controlled autonomous (routine tasks inside the limits)' };
const MODE_RANK = { monitor: 0, assisted: 1, controlled: 2 };

const DEPARTMENTS = [
  ['procurement', 'Procurement'], ['suppliers', 'Suppliers'], ['retail', 'Retail orders'], ['wholesale', 'Wholesale orders'], ['partners', 'Partners'],
  ['dropshipping', 'Dropshipping'], ['import_export', 'Import / export'], ['warehouse', 'Warehouse'], ['riders', 'Riders'], ['couriers', 'Courier providers'],
  ['refunds', 'Refunds'], ['compensation', 'Customer compensation'], ['financial', 'Financial transactions'],
];
const DEPT_KEYS = DEPARTMENTS.map(([k]) => k);
// Money leaves the company only through a person: this department can never run in controlled mode, whatever is configured.
const HUMAN_ONLY_DEPARTMENTS = ['financial'];

// Threshold categories (section 14.2). Each has three upper limits in Naira: up to a = level 1, up to b = level 2, up to c = level 3, above c = level 4.
const CATEGORIES = ['procurement', 'logistics', 'refunds', 'compensation', 'emergency', 'international_trade', 'supplier_deposit', 'other'];
const DEFAULT_THRESHOLDS = Object.fromEntries(CATEGORIES.map((c) => [c, [100000, 500000, 2000000]]));

// The catalogue of everything the AI may ever do or ask to do. level = the lowest approval level the action itself needs.
//   money  : the action commits or moves money, so the amount also sets the level
//   human  : a person performs it (a payment, a signature, a banking change). The AI can only ask for the authorisation.
//   sod    : the segregation-of-duties step this approval stands for
const A = (dept, category, level, label, extra = {}) => ({ dept, category, level, label, money: false, human: false, ...extra });
const ACTIONS = {
  // ---- level 0: look, think, draft, tell (always logged) ----
  'report.generate': A('retail', 'other', 0, 'Generate a report'),
  'supplier.research': A('suppliers', 'other', 0, 'Research suppliers'),
  'quote.compare': A('procurement', 'other', 0, 'Compare supplier quotations'),
  'consignment.draft': A('import_export', 'other', 1, 'Draft an import consignment from an approved purchase order'),
  'landed.calculate': A('import_export', 'other', 0, 'Calculate landed cost'),
  'procurement.recommend': A('procurement', 'procurement', 0, 'Recommend a purchase'),
  'po.draft': A('procurement', 'procurement', 0, 'Draft a purchase order'),
  'provider.compare': A('couriers', 'logistics', 0, 'Compare delivery providers'),
  'rider.recommend': A('riders', 'logistics', 0, 'Recommend a rider'),
  'shipment.track': A('couriers', 'logistics', 0, 'Track shipments'),
  'notify.staff': A('retail', 'other', 0, 'Send an internal notification'),
  'exception.raise': A('retail', 'other', 0, 'Raise an operational exception'),
  'task.create': A('retail', 'other', 0, 'Create an internal task'),
  'customer.draft': A('retail', 'other', 0, 'Draft a customer message'),
  'refund.recommend': A('refunds', 'refunds', 0, 'Recommend a refund decision', { money: true }),
  // ---- level 1: routine, low risk, inside budget (a person may switch each one off) ----
  'rider.assign': A('riders', 'logistics', 1, 'Assign an available rider'),
  'courier.book_local': A('couriers', 'logistics', 1, 'Book an approved local delivery', { money: true }),
  'courier.book_intl': A('couriers', 'logistics', 3, 'Book an international courier shipment', { money: true }),
  'courier.reassign': A('couriers', 'logistics', 1, 'Move a delivery to another approved provider', { money: true }),
  'reservation.release': A('warehouse', 'other', 1, 'Release the stock held for a cancelled order'),
  'order.status_verified': A('retail', 'other', 1, 'Move an order on a step backed by a verified event'),
  'supplier.enquiry': A('suppliers', 'other', 1, 'Send a supplier enquiry'),
  'supplier.followup': A('suppliers', 'other', 1, 'Send a routine supplier follow-up'),
  'stock.transfer_request': A('warehouse', 'other', 1, 'Create a stock transfer request'),
  'reorder.execute': A('procurement', 'procurement', 1, 'Execute an approved reorder rule', { money: true }),
  // ---- level 2: supervisor ----
  'supplier.onboard': A('suppliers', 'other', 2, 'Onboard a new supplier'),
  'supplier.status_change': A('suppliers', 'other', 2, 'Change a supplier status'),
  'po.create': A('procurement', 'procurement', 2, 'Create a purchase order', { money: true, sod: 'po_approve' }),
  'procurement.off_rule': A('procurement', 'procurement', 2, 'Buy outside the normal reorder rules', { money: true }),
  'stock.transfer_special': A('warehouse', 'other', 2, 'Non-routine stock transfer'),
  'courier.change_cost': A('couriers', 'logistics', 2, 'Change delivery provider at extra cost', { money: true }),
  'order.reassign_disputed': A('retail', 'other', 2, 'Reassign a delayed or disputed order'),
  'compensation.standard': A('compensation', 'compensation', 2, 'Customer compensation', { money: true }),
  'return.exception': A('refunds', 'refunds', 2, 'Return or replacement outside the standard policy', { money: true }),
  'schedule.change': A('retail', 'other', 2, 'Change a delivery schedule that affects a customer'),
  'quote.off_target': A('procurement', 'procurement', 2, 'Accept a quotation outside the target price', { money: true }),
  // ---- level 3: senior operations manager ----
  'po.high_value': A('procurement', 'procurement', 3, 'High-value purchase order', { money: true, sod: 'po_approve' }),
  'supplier.contract': A('suppliers', 'other', 3, 'New supplier contract'),
  'logistics.contract': A('couriers', 'logistics', 3, 'Major logistics contract', { money: true }),
  'freight.commit': A('import_export', 'international_trade', 3, 'International freight commitment', { money: true }),
  'trade.commit': A('import_export', 'international_trade', 3, 'Import or export shipment commitment', { money: true }),
  'price.variation': A('procurement', 'procurement', 3, 'Significant procurement price variation', { money: true }),
  'compensation.high': A('compensation', 'compensation', 3, 'High-value customer compensation', { money: true }),
  'refund.large': A('refunds', 'refunds', 3, 'Large refund', { money: true }),
  'warehouse.reallocate': A('warehouse', 'other', 3, 'Significant warehouse reallocation'),
  'payment_terms.unusual': A('suppliers', 'other', 3, 'Unusual supplier payment terms'),
  'procurement.emergency': A('procurement', 'emergency', 3, 'Emergency procurement', { money: true }),
  'policy.exception': A('retail', 'other', 3, 'Major operational policy exception'),
  // ---- level 4: executive / finance. A person does the money part; the AI only asks. ----
  'supplier.payment': A('financial', 'procurement', 4, 'Supplier payment', { money: true, human: true, sod: 'payment_authorize' }),
  'bank.transfer': A('financial', 'other', 4, 'Bank transfer', { money: true, human: true, sod: 'payment_authorize' }),
  'invoice.pay': A('financial', 'procurement', 4, 'Pay a purchase order invoice', { money: true, human: true, sod: 'payment_authorize' }),
  'supplier.deposit': A('financial', 'supplier_deposit', 4, 'Deposit or advance to a supplier', { money: true, human: true, sod: 'payment_authorize' }),
  'banking.change': A('financial', 'other', 4, 'Change company or supplier banking details', { human: true }),
  'refund.high_value': A('financial', 'refunds', 4, 'High-value refund', { money: true, human: true }),
  'financial.adjust': A('financial', 'other', 4, 'Large financial adjustment', { money: true, human: true }),
  'budget.exceed': A('financial', 'other', 4, 'Commitment beyond the approved budget', { money: true, human: true }),
  'credit.new': A('financial', 'other', 4, 'New credit arrangement', { money: true, human: true }),
  'fx.payment': A('financial', 'international_trade', 4, 'Foreign currency payment commitment', { money: true, human: true }),
  'customs.payment': A('financial', 'international_trade', 4, 'Customs or international trade payment', { money: true, human: true }),
  'integration.financial': A('financial', 'other', 4, 'Connect a new financial service', { human: true }),
  'legal.regulatory': A('import_export', 'other', 4, 'Action with legal or regulatory consequences', { human: true }),
};
const actionInfo = (type) => ACTIONS[type] || null;

const DEFAULT_CONFIG = {
  mode: 'monitor',                       // the safe starting point: the AI watches and recommends, nothing more
  department_modes: {},                  // { riders: 'controlled', ... } a department can only be set at or below the global mode
  thresholds: DEFAULT_THRESHOLDS,
  l1_disabled: [],                       // level-1 action types a person has switched off
  l1_daily_budget_ngn: 500000,           // most the AI may commit on its own per day and category
  split_window_hours: 24,                // amounts to the same counterparty inside this window are added together (no splitting to dodge a limit)
  two_person_level: 4,                   // from this level on, two different people must approve
  approval_hours: 48,                    // how long an approval request stays open
  agents_disabled: [],
  monitor_enabled: true,
  chat_daily_cap: 200,
  autonomy_paused: false,                // the stop switch: while true the AI does nothing on its own except look, draft and tell
  breaker_failures: 5,                   // this many failed autonomous actions inside the window pauses autonomy by itself
  breaker_window_min: 30,
  autonomy_daily_limit: 200,             // most autonomous (level 1) actions in 24 hours; past it, every action asks a person
};

const num = (v, d, lo = 0, hi = 1e12) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
// Takes what is stored (or typed in a form) and returns a complete, valid configuration. Unknown keys are dropped; bad values fall back to safe ones.
function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const c = { ...DEFAULT_CONFIG, thresholds: JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)), department_modes: {} };
  if (MODES.includes(r.mode)) c.mode = r.mode;
  for (const d of DEPT_KEYS) if (r.department_modes && MODES.includes(r.department_modes[d])) c.department_modes[d] = r.department_modes[d];
  for (const cat of CATEGORIES) {
    const t = r.thresholds && r.thresholds[cat];
    if (Array.isArray(t) && t.length === 3) { const [a, b, x] = t.map((v) => num(v, NaN, 0, 1e13)); if (a >= 0 && a <= b && b <= x) c.thresholds[cat] = [a, b, x]; }
  }
  if (Array.isArray(r.l1_disabled)) c.l1_disabled = [...new Set(r.l1_disabled.filter((t) => ACTIONS[t] && ACTIONS[t].level === 1))];
  c.l1_daily_budget_ngn = num(r.l1_daily_budget_ngn, DEFAULT_CONFIG.l1_daily_budget_ngn, 0, 1e10);
  c.split_window_hours = num(r.split_window_hours, DEFAULT_CONFIG.split_window_hours, 1, 24 * 30);
  c.two_person_level = Math.round(num(r.two_person_level, DEFAULT_CONFIG.two_person_level, 2, 4));
  c.approval_hours = Math.round(num(r.approval_hours, DEFAULT_CONFIG.approval_hours, 1, 24 * 30));
  if (Array.isArray(r.agents_disabled)) c.agents_disabled = [...new Set(r.agents_disabled.map(String))].slice(0, 20);
  if (r.supplier_weights && typeof r.supplier_weights === 'object') c.supplier_weights = require('./procure').normalizeWeights(r.supplier_weights);
  c.assistant_model = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].includes(r.assistant_model) ? r.assistant_model : '';
  if (r.order_sla && typeof r.order_sla === 'object') c.order_sla = require('./order-stage').normalizeSla(r.order_sla);
  if (r.delivery_weights && typeof r.delivery_weights === 'object') c.delivery_weights = require('./courier-select').normalizeWeights(r.delivery_weights);
  c.orders_follow_up = r.orders_follow_up !== false;
  c.monitor_enabled = r.monitor_enabled !== false;
  c.autonomy_paused = r.autonomy_paused === true;
  c.breaker_failures = Math.round(num(r.breaker_failures, DEFAULT_CONFIG.breaker_failures, 1, 100));
  c.breaker_window_min = Math.round(num(r.breaker_window_min, DEFAULT_CONFIG.breaker_window_min, 1, 1440));
  c.autonomy_daily_limit = Math.round(num(r.autonomy_daily_limit, DEFAULT_CONFIG.autonomy_daily_limit, 0, 100000));
  c.chat_daily_cap = Math.round(num(r.chat_daily_cap, DEFAULT_CONFIG.chat_daily_cap, 1, 5000));
  return c;
}

// The mode a department actually runs in. The global mode is a ceiling (set it to Monitor and everything stops acting); a department may go lower, never higher.
// The financial department can never go above Assisted.
function effectiveMode(dept, config) {
  const c = config || DEFAULT_CONFIG, global = MODES.includes(c.mode) ? c.mode : 'monitor';
  const own = c.department_modes && c.department_modes[dept];
  let m = own && MODE_RANK[own] < MODE_RANK[global] ? own : global;
  if (HUMAN_ONLY_DEPARTMENTS.includes(dept) && MODE_RANK[m] > MODE_RANK.assisted) m = 'assisted';
  return m;
}

// Level that an amount alone calls for, 0 when there is no money involved.
function levelForAmount(category, amountNgn, thresholds) {
  const a = Number(amountNgn) || 0; if (a <= 0) return 0;
  const [t1, t2, t3] = (thresholds && thresholds[category]) || DEFAULT_THRESHOLDS[category] || DEFAULT_THRESHOLDS.other;
  return a <= t1 ? 1 : a <= t2 ? 2 : a <= t3 ? 3 : 4;
}

// What may happen to this action now? Returns { route, level, reason, ... } where route is one of
//   'execute'   the AI may do it itself
//   'approval'  a person must approve first
//   'recommend' the AI may only suggest it (monitor mode)
//   'blocked'   not allowed at all
function decide({ type, amountNgn = 0, cumulativeNgn = 0, config, emergency = false, l1SpentNgn = 0, autonomousToday = 0 }) {
  const info = actionInfo(type);
  if (!info) return { route: 'blocked', level: null, reason: `"${type}" is not an action the AI is allowed to take.` };
  const cfg = config || DEFAULT_CONFIG, mode = effectiveMode(info.dept, cfg);
  const single = Math.max(0, Number(amountNgn) || 0), effective = single + Math.max(0, Number(cumulativeNgn) || 0);
  const amountLevel = info.money ? levelForAmount(info.category, effective, cfg.thresholds) : 0;
  const singleLevel = info.money ? levelForAmount(info.category, single, cfg.thresholds) : 0;
  let level = Math.max(info.level, amountLevel);
  const splitSuspected = amountLevel > Math.max(info.level, singleLevel) && Number(cumulativeNgn) > 0;
  if (emergency && level < 3) level = 3;   // an emergency request is always seen at senior level, by a designated executive
  const out = { level, mode, department: info.dept, category: info.category, effective_amount_ngn: effective, split_suspected: splitSuspected, human_executes: !!info.human, sod: info.sod || null, emergency: !!emergency };
  out.required_approvals = level >= cfg.two_person_level ? 2 : 1;
  out.risk = level >= 3 ? 'high' : level === 2 ? 'medium' : 'low';

  if (level === 0 && !info.human) return { ...out, route: 'execute', reason: 'Level 0: looks, drafts or tells, commits nothing.' };
  if (mode === 'monitor') return { ...out, route: 'recommend', reason: `${info.dept} is in Monitor mode: the AI only recommends.` };
  if (mode === 'assisted' || level >= 2 || info.human) return { ...out, route: 'approval', reason: level >= 2 || info.human ? `Level ${level} needs a person's approval in every mode.` : `${info.dept} is in Assisted mode: a person approves first.` };
  // controlled mode, level 1
  if (cfg.autonomy_paused) return { ...out, route: 'approval', reason: 'Autonomy is paused: a person must approve until it is resumed.' };
  if ((Number(autonomousToday) || 0) >= cfg.autonomy_daily_limit) return { ...out, route: 'approval', reason: `The daily limit of ${cfg.autonomy_daily_limit} autonomous actions is used up, so a person approves.` };
  if ((cfg.l1_disabled || []).includes(type)) return { ...out, route: 'approval', reason: 'A person switched this routine action off, so it needs approval.' };
  if (info.money && (Number(l1SpentNgn) || 0) + effective > cfg.l1_daily_budget_ngn) return { ...out, route: 'approval', reason: `It would pass today's autonomous limit of ${cfg.l1_daily_budget_ngn} NGN for this action.` };
  return { ...out, route: 'execute', reason: 'Level 1 routine action inside the approved limits.' };
}

/* ---------- approvals ---------- */
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const canonicalJson = (v) => JSON.stringify(sortKeys(v === undefined ? null : v));
const hashPayload = (v) => crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');

// approver: { id, role ('admin' | 'staff'), max_level, emergency }. approval: a row of ops_approvals. decided: user ids that already decided it.
function approverMayDecide({ approver, approval, decided = [], now = Math.floor(Date.now() / 1000) }) {
  if (!approver) return { ok: false, reason: 'Sign in as an approver.' };
  if (approval.status !== 'pending') return { ok: false, reason: `This request is ${approval.status}, so it cannot be decided now.` };
  if (Number(approval.deadline) < now) return { ok: false, reason: 'This request has expired. The AI must ask again.' };
  const level = approver.role === 'admin' ? 4 : Number(approver.max_level) || 0;
  if (level < 2) return { ok: false, reason: 'You are not set up as an approver. Ask the owner.' };
  if (approval.requested_by_kind === 'user' && Number(approval.requested_by_user) === Number(approver.id)) return { ok: false, reason: 'You cannot approve your own request.' };
  if (decided.map(Number).includes(Number(approver.id))) return { ok: false, reason: 'You already decided this request.' };
  if (approval.emergency) { if (!(approver.role === 'admin' || approver.emergency)) return { ok: false, reason: 'Only a designated executive may decide an emergency request.' }; }
  if (level < Number(approval.level_required)) return { ok: false, reason: `This needs level ${approval.level_required}; you are level ${level}.` };
  return { ok: true, level };
}
// After a decision: how many approvals are in, and what is the new status?
function tally(approval, decisions) {
  const approves = new Set(decisions.filter((d) => d.decision === 'approve').map((d) => Number(d.user_id)));
  if (decisions.some((d) => d.decision === 'reject')) return 'rejected';
  if (decisions.some((d) => d.decision === 'return')) return 'returned';
  const need = approval.emergency ? 1 : Number(approval.required_approvals) || 1;
  return approves.size >= need ? 'approved' : 'pending';
}

/* ---------- segregation of duties ---------- */
// An actor may not hold two steps from the same group on the same purchase or payment.
const SOD_GROUPS = [
  ['request_create', 'po_approve'],
  ['supplier_approve', 'po_approve'],
  ['po_approve', 'payment_authorize'],
  ['goods_receipt', 'payment_authorize'],
  ['invoice_verify', 'payment_authorize'],
  ['request_create', 'payment_authorize'],
];
// existing: [{ step, actor }] already recorded for this object. Returns a problem text, or '' when it is fine.
function sodConflict(existing, step, actor) {
  if (String(actor) === 'ai' && ['po_approve', 'payment_authorize', 'supplier_approve', 'invoice_verify', 'goods_receipt'].includes(step)) return `The AI may never perform the step "${step}".`;
  for (const g of SOD_GROUPS) {
    if (!g.includes(step)) continue;
    const other = g.find((s) => s !== step);
    if (existing.some((e) => e.step === other && e.actor === actor)) return `The same person cannot do both "${other}" and "${step}" on one purchase.`;
  }
  return '';
}

module.exports = { MODES, MODE_LABEL, MODE_RANK, DEPARTMENTS, DEPT_KEYS, HUMAN_ONLY_DEPARTMENTS, CATEGORIES, DEFAULT_THRESHOLDS, DEFAULT_CONFIG, ACTIONS, actionInfo, normalizeConfig, effectiveMode, levelForAmount, decide, canonicalJson, hashPayload, approverMayDecide, tally, SOD_GROUPS, sodConflict };
