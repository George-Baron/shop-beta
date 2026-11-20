'use strict';
// Landed cost for an import or an export: goods + freight + insurance + duty + VAT + clearing agent fees, in any currency.
// Pure arithmetic (no database): everything is worked out in whole minor units (kobo, cents) of the shipment currency and rounded half up per line,
// so the lines always add up to the total. The Incoterm decides which costs are already inside the goods price and who pays the rest.
// Duty and tax are estimates for planning, never legal or tax advice: the real figures come from customs and your clearing agent.
const FX = require('./fx');
const CUR = require('./currency');

const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];
const INCOTERM_NAMES = { EXW: 'Ex Works', FCA: 'Free Carrier', FOB: 'Free On Board', CFR: 'Cost and Freight', CIF: 'Cost, Insurance and Freight', CPT: 'Carriage Paid To', CIP: 'Carriage and Insurance Paid To', DAP: 'Delivered At Place', DPU: 'Delivered at Place Unloaded', DDP: 'Delivered Duty Paid' };
// Costs the SELLER pays and has already put into the goods price under each rule.
const SELLER_PAYS = { EXW: [], FCA: [], FOB: [], CFR: ['freight'], CIF: ['freight', 'insurance'], CPT: ['freight'], CIP: ['freight', 'insurance'], DAP: ['freight', 'insurance'], DPU: ['freight', 'insurance'], DDP: ['freight', 'insurance', 'duty', 'vat'] };
const LABEL = { goods: 'Goods', freight: 'Freight', insurance: 'Insurance', duty: 'Import duty', vat: 'VAT', agent_fee: 'Clearing agent fees', other_fees: 'Other charges' };

const money = (v, name) => { const n = Number(v == null || v === '' ? 0 : v); if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new Error(`${name} must be a number of zero or more.`); return n; };
const pct = (v, name, max) => { const n = Number(v == null || v === '' ? 0 : v); if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${name} must be between 0 and ${max}.`); return n; };
const half = (x) => Math.round(x + Number.EPSILON * Math.sign(x));

// in: { direction: 'import'|'export', incoterm, currency, goods, freight, insurance, duty_pct, vat_pct, agent_fee, agent_pct, other_fees, show_in }
// rates: { USD: 1500, ... } Naira per 1 unit (only needed when show_in differs from the currency)
function landed(i, rates) {
  const direction = i.direction === 'export' ? 'export' : 'import';
  const incoterm = String(i.incoterm || 'FOB').toUpperCase(); if (!INCOTERMS.includes(incoterm)) throw new Error('Choose an Incoterm from the list.');
  const currency = String(i.currency || 'NGN').toUpperCase(); if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Choose a currency.');
  const d = CUR.decimals(currency), up = (v) => half(v * 10 ** d), major = (m) => m / 10 ** d;
  const goods = up(money(i.goods, 'The goods value')), freight = up(money(i.freight, 'Freight')), insurance = up(money(i.insurance, 'Insurance')), other = up(money(i.other_fees, 'Other charges'));
  const dutyPct = pct(i.duty_pct, 'Duty', 500), vatPct = pct(i.vat_pct, 'VAT', 100), agentPct = pct(i.agent_pct, 'The agent percentage', 100);
  const inPrice = new Set(SELLER_PAYS[incoterm]);
  const customs = goods + (inPrice.has('freight') ? 0 : freight) + (inPrice.has('insurance') ? 0 : insurance);       // the value duty is charged on
  const duty = half(customs * dutyPct / 100), vat = half((customs + duty) * vatPct / 100);
  const agent = up(money(i.agent_fee, 'The clearing agent fee')) + half(customs * agentPct / 100);
  const raw = { freight, insurance, duty, vat, agent_fee: agent, other_fees: other };
  const weAreBuyer = direction === 'import';
  const lines = [{ key: 'goods', label: LABEL.goods + (weAreBuyer ? '' : ' (sale value)'), minor: goods, included_in_price: false, paid_by: weAreBuyer ? 'us' : 'other' }];
  const warnings = [];
  for (const k of ['freight', 'insurance', 'duty', 'vat', 'agent_fee', 'other_fees']) {
    const own = k === 'agent_fee' || k === 'other_fees';                                    // our own agent and charges: always ours
    const sellerPays = !own && inPrice.has(k);
    const ours = own || (weAreBuyer ? !sellerPays : sellerPays);
    lines.push({ key: k, label: LABEL[k], minor: raw[k], included_in_price: sellerPays, paid_by: ours ? 'us' : 'other' });
    if (sellerPays && raw[k] > 0) warnings.push(`${LABEL[k]} is already inside the goods price under ${incoterm}, so it is not added again.`);
  }
  if (incoterm === 'DDP' && (dutyPct > 0 || vatPct > 0)) warnings.push('Under DDP the seller pays duty and VAT. They are shown for information.');
  if (dutyPct === 0 && vatPct === 0 && weAreBuyer) warnings.push('Duty and VAT are 0%. Check the real rates for the HS code with your clearing agent.');
  const extra = (f) => lines.filter((l) => l.key !== 'goods' && !l.included_in_price && f(l)).reduce((x, l) => x + l.minor, 0);   // costs on top of the goods price
  const own = (l) => l.key === 'agent_fee' || l.key === 'other_fees';
  const totals = {
    customs_value: customs,
    landed_total: goods + extra(() => true),                                                     // goods plus every cost that is not already in the price
    buyer_pays: goods + extra((l) => !own(l)) + (weAreBuyer ? extra(own) : 0),                    // what the buyer pays in all (our own fees only count when we are the buyer)
    our_cost: weAreBuyer ? goods + extra((l) => l.paid_by === 'us') : lines.filter((l) => l.key !== 'goods' && l.paid_by === 'us').reduce((x, l) => x + l.minor, 0),   // import: all we pay. export: what the sale costs us
  };
  const out = { direction, incoterm, incoterm_name: INCOTERM_NAMES[incoterm], currency, decimals: d, lines: lines.map((l) => ({ ...l, amount: major(l.minor) })), totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v])), warnings,
    totals_major: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, major(v)])) };
  const to = i.show_in ? String(i.show_in).toUpperCase() : '';
  if (to && to !== currency) {
    try {
    const dd = CUR.decimals(to), cv = (m) => Math.round(FX.convert(major(m), currency, to, rates) * 10 ** dd) / 10 ** dd;
    out.converted = { currency: to, rate: FX.convert(1, currency, to, rates), lines: Object.fromEntries(lines.map((l) => [l.key, cv(l.minor)])), totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, cv(v)])) };
    } catch (err) { out.convert_error = err.message; }
  }
  return out;
}

module.exports = { landed, INCOTERMS, INCOTERM_NAMES, SELLER_PAYS, LABEL };
