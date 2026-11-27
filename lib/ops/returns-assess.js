'use strict';
// Return assessment (spec section 12). PURE: facts about one return in, a recommendation out. It never decides anything:
// approving, rejecting and settling stay with the store's returns module and the people who hold that authority.
// It does not invent policy: where the store has no rule (for example a fee for a change of mind on an opened item) it says a person must decide.
const P = require('./policy');

const SELLER_FAULT = ['faulty', 'wrong_item', 'not_as_described', 'missing_parts'];
const NEEDS_PHOTO = ['faulty', 'wrong_item', 'not_as_described'];   // missing_parts is shown by the packaging, not a photo of the item
const REPEAT_AFTER = 3;                                              // this many earlier refunded returns in 90 days -> look closer

// f: { reason, condition, packaging, requested_ngn, max_refund_ngn, photos, vendors:[{name, amount}], prior_settled_90d, thresholds, details }
function assess(f) {
  const reasons = [], flags = [], missing = [];
  const requested = Math.max(0, Number(f.requested_ngn) || 0), cap = Math.max(0, Number(f.max_refund_ngn) || 0);
  const fault = SELLER_FAULT.includes(f.reason), customerCaused = f.reason === 'changed_mind';
  let action, amount = Math.min(requested, cap);

  if (cap <= 0) { action = 'reject'; amount = 0; reasons.push('Nothing is left to refund on this order.'); }
  else if (requested > cap) { flags.push('Requested amount is above what is left on the order, so it is capped.'); }

  if (action !== 'reject') {
    if (fault) {
      if (NEEDS_PHOTO.includes(f.reason) && !Number(f.photos)) { action = 'ask_evidence'; missing.push('photo of the item and its packaging'); reasons.push('The customer reports a fault but sent no photo.'); }
      else { action = 'approve_full'; reasons.push(`Reason "${f.reason}" is the seller's responsibility${Number(f.photos) ? ' and photos were supplied' : ''}.`); }
    } else if (customerCaused) {
      if (f.condition === 'unopened') { action = 'approve_full'; reasons.push('Change of mind on an unopened item inside the return window.'); }
      else if (f.condition === 'opened_unused') { action = 'needs_decision'; reasons.push('Change of mind on an opened item: the store has no fixed rule, so a person decides the amount.'); }
      else { action = 'reject'; amount = 0; reasons.push(`Change of mind, but the item is ${f.condition}.`); }
    } else { action = 'needs_decision'; reasons.push('The reason does not match a standard rule.'); }
  }
  if (action === 'approve_full' && f.condition === 'damaged' && !fault) { action = 'needs_decision'; reasons.push('Damaged item with a non-fault reason.'); }
  if (f.past_window) flags.push('Opened after the return window by staff: confirm the exception was agreed.');

  if (Number(f.prior_settled_90d) >= REPEAT_AFTER) { flags.push(`This customer has had ${f.prior_settled_90d} refunds in 90 days.`); if (action === 'approve_full') action = 'needs_decision'; reasons.push('Repeat returner: a person should look before approving.'); }
  if (f.condition === 'damaged' && customerCaused) flags.push('Customer says the item is damaged but gives change of mind as the reason.');

  const level = amount > 0 ? Math.max(1, P.levelForAmount('refunds', amount, f.thresholds)) : 0;
  const needs = level >= 3 ? 'Senior Operations Manager' : level === 2 ? 'Operations Supervisor' : level === 1 ? 'Staff within the routine limit' : 'nobody (no money moves)';
  const restock = f.condition === 'unopened' ? 'inspect_then_restock' : 'do_not_restock_until_inspected';   // stock only goes back after a person inspects it
  const vendors = (f.vendors || []).map((v) => ({ name: v.name, amount: v.amount }));
  return {
    action, amount_ngn: Math.round(amount), approval_level: level, approver: needs, reasons, flags, evidence_missing: missing, restock,
    supplier_responsibility: fault && vendors.length ? { charge_vendor: true, vendors } : { charge_vendor: false, vendors },
    summary: ({ approve_full: `Recommend approving ₦${Math.round(amount).toLocaleString('en-NG')}`, reject: 'Recommend rejecting', ask_evidence: 'Ask the customer for evidence first', needs_decision: 'A person must decide' })[action],
  };
}
module.exports = { assess, SELLER_FAULT, REPEAT_AFTER };
