'use strict';
// Customs duty and tax ESTIMATE from the rules staff entered in "customs_duty_rules". Nothing is pre-filled and nothing is assumed:
// a line with no rule is reported as "not estimated", and a rule that nobody has verified only ever produces an estimate.
//
// Per line:  value base = customs value (FOB)  or  customs value + freight + insurance share (CIF / CIP)
//            duty = base x duty%      levy = base x other%      VAT = (base + duty [+ levy if the rule says so]) x VAT%   (VAT on duty only if the rule says so)
// A rule can have a de-minimis limit: when the whole shipment's customs value is at or below it, nothing is payable.
// Rule choice: destination, origin (a rule for that origin beats an "any origin" rule), then the LONGEST matching HS prefix, within its dates.
const { all, get } = require('../db');
const FX = require('./fx');

const digits = (s) => String(s || '').replace(/\D/g, '');
async function ruleFor(dest, origin, hs, today) {
  const rows = await all(`SELECT * FROM customs_duty_rules WHERE active=1 AND destination_country=? AND (origin_country IS NULL OR origin_country=?)
    AND (valid_from IS NULL OR valid_from<=?::date) AND (valid_to IS NULL OR valid_to>=?::date)`, dest, origin || '', today, today);
  const h = digits(hs);
  return rows.filter((r) => h.startsWith(r.hs_prefix)).sort((a, b) => (b.hs_prefix.length - a.hs_prefix.length) || ((b.origin_country ? 1 : 0) - (a.origin_country ? 1 : 0)))[0] || null;
}

// lines: [{ product_id, hs_code, origin_country, value_ngn }]  (value_ngn = total customs value of the line, in NGN)
async function estimate({ dest, lines, freightNgn, insuranceNgn }) {
  const today = new Date().toISOString().slice(0, 10), total = lines.reduce((a, l) => a + l.value_ngn, 0) || 1;
  const out = { lines: [], duty_ngn: 0, vat_ngn: 0, levy_ngn: 0, missing: [], unverified: false, de_minimis: false, status: 'not_available', labels: [] };
  for (const l of lines) {
    const rule = await ruleFor(dest, l.origin_country, l.hs_code, today);
    if (!rule) { out.missing.push(l.product_id); continue; }
    if (!Number(rule.verified)) out.unverified = true;
    const share = l.value_ngn / total, cif = ['CIF', 'CIP'].includes(rule.valuation);
    const base = l.value_ngn + (cif ? (freightNgn + insuranceNgn) * share : 0);
    const duty = base * Number(rule.duty_pct) / 100, levy = base * Number(rule.other_levy_pct) / 100;
    const vat = (base + (Number(rule.vat_on_duty) ? duty + levy : 0)) * Number(rule.vat_pct) / 100;
    out.lines.push({ product_id: l.product_id, rule_id: Number(rule.id), valuation: rule.valuation, base_ngn: Math.round(base), duty_ngn: Math.round(duty), levy_ngn: Math.round(levy), vat_ngn: Math.round(vat), verified: !!Number(rule.verified), de_minimis: rule.de_minimis == null ? null : Number(rule.de_minimis), de_minimis_currency: rule.de_minimis_currency });
    out.duty_ngn += duty; out.levy_ngn += levy; out.vat_ngn += vat;
    if (rule.other_levy_label && Number(rule.other_levy_pct) > 0) out.labels.push(rule.other_levy_label);
  }
  // de minimis: the strictest (lowest) limit among the rules used, compared with the whole shipment's customs value
  const limits = [];
  for (const l of out.lines) if (l.de_minimis != null) limits.push(l.de_minimis_currency && l.de_minimis_currency !== 'NGN' ? l.de_minimis * (await FX.rate(l.de_minimis_currency, 'NGN')).rate : l.de_minimis);
  if (limits.length && total <= Math.min(...limits)) { out.de_minimis = true; out.duty_ngn = out.vat_ngn = out.levy_ngn = 0; }
  out.duty_ngn = Math.round(out.duty_ngn); out.vat_ngn = Math.round(out.vat_ngn); out.levy_ngn = Math.round(out.levy_ngn);
  out.status = !out.lines.length ? 'not_available' : out.missing.length ? 'partial' : out.unverified ? 'estimated' : 'verified';
  out.total_ngn = out.duty_ngn + out.vat_ngn + out.levy_ngn;
  return out;
}
module.exports = { estimate, ruleFor };
