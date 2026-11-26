'use strict';
// Procurement maths with no database: supplier scoring, landed cost per quotation, comparison and the purchase-order totals.
// Rule of this file: a number that is not known is left out and said so. It is never filled in with a guess. A score is worked out only
// from the factors that have real data, and it reports how much of the total weight that covers.
const LANDED = require('../trade-landed');
const FX = require('../fx');

const FACTORS = ['quality', 'landed_cost', 'delivery', 'reputation', 'availability', 'payment_terms', 'returns_warranty', 'responsiveness'];
const FACTOR_LABEL = { quality: 'Product quality', landed_cost: 'Total landed cost', delivery: 'Delivery reliability', reputation: 'Reputation and verification', availability: 'Availability', payment_terms: 'Payment terms', returns_warranty: 'Return and warranty', responsiveness: 'Responsiveness' };
const DEFAULT_WEIGHTS = { quality: 20, landed_cost: 20, delivery: 15, reputation: 15, availability: 10, payment_terms: 10, returns_warranty: 5, responsiveness: 5 };
const STATUSES = ['preferred', 'approved', 'conditional', 'under_review', 'suspended', 'rejected'];
const QUALIFIED = ['preferred', 'approved', 'conditional'];            // only these may be recommended; under review, suspended and rejected never are
const CHECKS = ['registration', 'contact', 'location', 'references', 'certifications'];   // what "verified" is made of
const CHECK_LABEL = { registration: 'Business registration', contact: 'Contact details', location: 'Address / premises', references: 'Trade references', certifications: 'Certifications / approvals' };
const STATES = ['verified', 'vendor_supplied', 'unverified'];

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp = (x) => Math.max(0, Math.min(100, x));
const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;

function normalizeWeights(raw) {
  const w = {}; let sum = 0;
  for (const k of FACTORS) { const v = raw && num(raw[k]); w[k] = v != null && v >= 0 && v <= 1000 ? v : DEFAULT_WEIGHTS[k]; sum += w[k]; }
  return sum > 0 ? w : { ...DEFAULT_WEIGHTS };
}

// 0..1 from the verification record. "verified" = a person checked it; "vendor_supplied" = the vendor said so; anything else counts for nothing.
function verifiedShare(verification) {
  const v = verification && typeof verification === 'object' ? verification : {};
  let t = 0; for (const k of CHECKS) { const s = v[k] && v[k].state; t += s === 'verified' ? 1 : s === 'vendor_supplied' ? 0.3 : 0; }
  return t / CHECKS.length;
}
// A vendor may only be "preferred" or "approved" once identity is verified by a person: registration AND contact.
function canBeApproved(verification) {
  const v = verification || {};
  const miss = ['registration', 'contact'].filter((k) => !(v[k] && v[k].state === 'verified'));
  return miss.length ? { ok: false, reason: `A person must verify ${miss.map((k) => CHECK_LABEL[k].toLowerCase()).join(' and ')} first. An unverified vendor is never approved automatically.` } : { ok: true };
}

/* ---------- landed cost of one quotation, in Naira ---------- */
// vendor: { country }. quote: a quotation row. qty: how many we would buy. rates: Naira per 1 unit of each currency (null when no verified rate exists).
// Returns { ngn, per_unit_ngn, currency, estimated, lines, warnings } or { ngn: null, error } when it cannot be worked out. Duty and VAT are estimates.
function quoteLanded(vendor, quote, qty, rates) {
  const cur = String(quote.currency || 'NGN').toUpperCase(), unit = num(quote.unit_price), n = Math.max(1, Math.floor(Number(qty) || 0));
  if (unit == null) return { ngn: null, error: 'The quotation has no price.' };
  const goods = unit * n, foreign = vendor && vendor.country && vendor.country !== 'NG';
  try {
    if (foreign) {
      const l = LANDED.landed({ direction: 'import', incoterm: quote.incoterm || 'FOB', currency: cur, goods, freight: num(quote.freight) || 0, insurance: num(quote.insurance) || 0, duty_pct: num(quote.duty_pct) || 0, vat_pct: num(quote.vat_pct) || 0, agent_fee: num(quote.clearing_fee) || 0, other_fees: num(quote.other_fees) || 0, show_in: 'NGN' }, rates || {});
      if (l.convert_error || !l.converted) return { ngn: null, error: l.convert_error || `No verified exchange rate for ${cur}, so the Naira cost is unknown.` };
      const ngn = r2(l.converted.totals.landed_total);
      return { ngn, per_unit_ngn: r2(ngn / n), currency: cur, estimated: true, lines: l.lines.map((x) => ({ key: x.key, label: x.label, amount: x.amount, included_in_price: x.included_in_price })), warnings: [...l.warnings, 'Duty, VAT and clearing are estimates from the rates entered; the real figures come from customs and your agent.'] };
    }
    const extras = (num(quote.freight) || 0) + (num(quote.insurance) || 0) + (num(quote.other_fees) || 0), vat = (goods + (num(quote.freight) || 0)) * ((num(quote.vat_pct) || 0) / 100);
    const total = goods + extras + vat;
    const ngn = cur === 'NGN' ? total : FX.toNaira(total, cur, rates || {});
    return { ngn: r2(ngn), per_unit_ngn: r2(ngn / n), currency: cur, estimated: false, lines: [{ key: 'goods', label: 'Goods', amount: r2(goods) }, { key: 'delivery', label: 'Freight, insurance and other charges', amount: r2(extras) }, { key: 'vat', label: 'VAT', amount: r2(vat) }], warnings: [] };
  } catch (e) { return { ngn: null, error: /rate/i.test(e.message) ? `No verified exchange rate for ${cur}, so the Naira cost is unknown.` : e.message }; }
}

/* ---------- one vendor's score for one quotation ---------- */
// stats: { receipts, on_time_pct (0-100), fill_pct (0-100) } from goods received. rating: { quality, responsiveness } given by a person.
function score({ vendor, quote, qty, landedNgn, cheapestNgn, stats, rating, weights }) {
  const w = normalizeWeights(weights), f = {};
  f.quality = rating && num(rating.quality) != null ? { score: clamp(rating.quality), basis: 'Rating given by staff' } : { score: null, basis: 'No rating yet' };
  f.landed_cost = landedNgn != null && cheapestNgn != null && landedNgn > 0 ? { score: clamp((cheapestNgn / landedNgn) * 100), basis: 'Cheapest compared quotation ÷ this one' } : { score: null, basis: 'Landed cost unknown' };
  f.delivery = stats && stats.receipts > 0 ? { score: clamp(0.6 * stats.on_time_pct + 0.4 * stats.fill_pct), basis: `${stats.receipts} delivery record(s): ${r1(stats.on_time_pct)}% on time, ${r1(stats.fill_pct)}% of quantity` } : { score: null, basis: 'No delivery history with us yet' };
  const vs = verifiedShare(vendor.verification); f.reputation = { score: clamp(vs * 100), basis: `${Math.round(vs * CHECKS.length * 10) / 10} of ${CHECKS.length} checks verified` };
  f.availability = num(quote.qty_available) != null && qty > 0 ? { score: clamp((quote.qty_available / qty) * 100), basis: `${quote.qty_available} available for ${qty} needed` } : { score: null, basis: 'Availability not stated' };
  const pd = num(quote.payment_days) != null ? num(quote.payment_days) : num(vendor.payment_days); f.payment_terms = pd != null ? { score: clamp((pd / 60) * 100), basis: pd === 0 ? 'Prepaid' : `${pd} days to pay` } : { score: null, basis: 'Not stated' };
  const rp = vendor.return_policy && String(vendor.return_policy).trim() ? 50 : 0, wr = vendor.warranty && String(vendor.warranty).trim() ? 50 : 0; f.returns_warranty = { score: rp + wr, basis: `${rp ? 'return policy' : 'no return policy'}, ${wr ? 'warranty' : 'no warranty'}` };
  f.responsiveness = rating && num(rating.responsiveness) != null ? { score: clamp(rating.responsiveness), basis: 'Rating given by staff' } : { score: null, basis: 'No rating yet' };
  let got = 0, known = 0, total = 0;
  for (const k of FACTORS) { total += w[k]; if (f[k].score != null) { known += w[k]; got += w[k] * f[k].score; } }
  return { score: known > 0 ? r1(got / known) : null, coverage: total > 0 ? r1((known / total) * 100) : 0, low_data: total > 0 && known / total < 0.6, factors: Object.fromEntries(FACTORS.map((k) => [k, { label: FACTOR_LABEL[k], weight: w[k], ...f[k], score: f[k].score == null ? null : r1(f[k].score) }])) };
}

/* ---------- compare the quotations for one request ---------- */
// request: { qty, target_price }. entries: [{ quote, vendor, stats, rating }]. rates for the landed cost. now: epoch seconds.
function compare({ request, entries, weights, rates, now = Math.floor(Date.now() / 1000) }) {
  const qty = request.qty, rows = entries.map((e) => {
    const reasons = [], lc = quoteLanded(e.vendor, e.quote, qty, rates);
    if (!QUALIFIED.includes(e.vendor.status)) reasons.push(`Vendor is "${e.vendor.status.replace('_', ' ')}"`);
    if (e.quote.valid_until && Number(e.quote.valid_until) < now) reasons.push('Quotation has expired');
    if (Number(e.quote.moq) > qty) reasons.push(`Minimum order ${e.quote.moq} is above the ${qty} needed`);
    if (num(e.quote.qty_available) != null && e.quote.qty_available < qty) reasons.push(`Only ${e.quote.qty_available} available`);
    if (lc.ngn == null) reasons.push(lc.error || 'Landed cost unknown');
    return { quote: e.quote, vendor: e.vendor, stats: e.stats, rating: e.rating, landed: lc, qualified: reasons.length === 0, disqualified_because: reasons };
  });
  const costed = rows.filter((r) => r.qualified), cheapest = costed.length ? Math.min(...costed.map((r) => r.landed.ngn)) : null;
  const allCosts = rows.filter((r) => r.landed.ngn != null).map((r) => r.landed.ngn), floor = cheapest != null ? cheapest : allCosts.length ? Math.min(...allCosts) : null;
  for (const r of rows) r.evaluation = score({ vendor: r.vendor, quote: r.quote, qty, landedNgn: r.landed.ngn, cheapestNgn: floor, stats: r.stats, rating: r.rating, weights });
  const q = rows.filter((r) => r.qualified);
  const by = (arr, key, dir) => arr.slice().sort((a, b) => dir * (key(a) - key(b)))[0] || null;
  const best = by(q.filter((r) => r.evaluation.score != null), (r) => r.evaluation.score, -1);
  const tied = best ? q.filter((r) => r.evaluation.score != null && best.evaluation.score - r.evaluation.score <= 1) : [];
  const preferredTied = tied.find((r) => r.vendor.status === 'preferred');
  const cheapestRow = by(q, (r) => r.landed.ngn, 1);
  const withLead = q.filter((r) => num(r.quote.lead_days) != null), fastest = by(withLead, (r) => Number(r.quote.lead_days), 1);
  const preferred = by(q.filter((r) => r.vendor.status === 'preferred' && r.evaluation.score != null), (r) => r.evaluation.score, -1);
  const recommended = preferredTied || best;
  const id = (r) => (r ? r.quote.id : null);
  const notes = [];
  if (q.length < 3) notes.push(`Only ${q.length} qualified quotation${q.length === 1 ? '' : 's'} (at least 3 are recommended when enough suppliers exist). Request more quotations before committing.`);
  if (rows.some((r) => r.landed.ngn == null)) notes.push('Some quotations have no Naira cost because an exchange rate is missing. They were not ranked on cost.');
  if (recommended && recommended.evaluation.low_data) notes.push(`The recommendation rests on factors covering only ${recommended.evaluation.coverage}% of the scoring weight. Add ratings and delivery history to make it firmer.`);
  const tp = num(request.target_price);
  if (recommended && tp != null && recommended.landed.per_unit_ngn != null && recommended.quote.currency === 'NGN' && recommended.landed.per_unit_ngn > tp) notes.push(`The recommended landed price per unit is above the target of ${tp}. Approval at supervisor level applies.`);
  let why = '';
  if (recommended) {
    const top = Object.values(recommended.evaluation.factors).filter((x) => x.score != null).sort((a, b) => b.score * b.weight - a.score * a.weight).slice(0, 2).map((x) => x.label.toLowerCase());
    why = `${recommended.vendor.name} scores ${recommended.evaluation.score}/100` + (top.length ? `, strongest on ${top.join(' and ')}` : '') + `; landed cost ${recommended.landed.ngn.toLocaleString('en-NG')} NGN for ${qty}` + (cheapestRow && cheapestRow !== recommended ? ` (the cheapest qualifying offer is ${cheapestRow.vendor.name} at ${cheapestRow.landed.ngn.toLocaleString('en-NG')} NGN)` : '') + (preferredTied === recommended && best !== recommended ? '; chosen over a near-equal score because it is a preferred supplier' : '') + '.';
  }
  rows.sort((a, b) => (b.qualified - a.qualified) || ((b.evaluation.score || 0) - (a.evaluation.score || 0)));
  return { qty, rows, highlights: { cheapest_qualifying: id(cheapestRow), best_overall: id(best), fastest_qualifying: id(fastest), preferred_existing: id(preferred), recommended: id(recommended) }, recommended_reason: why, qualified_count: q.length, notes };
}

/* ---------- purchase order totals ---------- */
// Vendor-invoiced amounts only. For a foreign vendor, duty, VAT and clearing are paid at customs, not on the PO.
function poTotals({ vendor, quote, qty }) {
  const unit = num(quote.unit_price) || 0, n = Math.max(1, Math.floor(Number(qty) || 0)), foreign = vendor.country && vendor.country !== 'NG';
  const subtotal = r2(unit * n), delivery = r2((num(quote.freight) || 0) + (num(quote.insurance) || 0) + (num(quote.other_fees) || 0));
  const tax = foreign ? 0 : r2((subtotal + (num(quote.freight) || 0)) * ((num(quote.vat_pct) || 0) / 100));
  return { subtotal, discount: 0, tax, delivery, total: r2(subtotal + tax + delivery), foreign };
}

module.exports = { FACTORS, FACTOR_LABEL, DEFAULT_WEIGHTS, STATUSES, QUALIFIED, CHECKS, CHECK_LABEL, STATES, normalizeWeights, verifiedShare, canBeApproved, quoteLanded, score, compare, poTotals };
