'use strict';
// Dropship pricing maths. Pure functions, no database: everything is passed in, so it can be tested exactly.
//
//   goods     = supplier cost x rate                   (rate = Naira per 1 unit of the supplier's currency)
//   shipping  = supplier shipping x rate
//   duty      = (goods + shipping) x duty %            (customs value is taken as goods + freight)
//   tax       = (goods + shipping + duty) x tax %      (VAT or similar on the dutiable value)
//   landed    = goods + shipping + duty + tax
//   margin    = landed x % (markup), or a fixed Naira amount
//   price     = the smallest price whose proceeds after the payment fee still cover landed + margin
// Duty and tax are ESTIMATES the admin must verify with a clearing agent (see docs/DROPSHIPPING.md).

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const DEFAULTS = Object.freeze({
  margin_type: 'percent', margin_value: 30,   // markup on landed cost
  duty_pct: 20, tax_pct: 7.5,                  // placeholders to verify per product
  fee_pct: 1.5, fee_flat: 100, fee_flat_from: 2500, fee_cap: 2000, // Paystack local cards: 1.5% + 100 (flat only from 2,500), capped at 2,000
  round_to: 50,                                // retail price is rounded UP to this many Naira
  eta_buffer_days: 2,                          // added to the longest delivery estimate so promises are safe
});

// What the payment provider keeps from a payment of `price`.
function paymentFee(price, f = DEFAULTS) {
  if (!(price > 0)) return 0;
  return Math.min(f.fee_cap, (price * f.fee_pct) / 100 + (price >= f.fee_flat_from ? f.fee_flat : 0));
}
const proceeds = (price, f) => price - paymentFee(price, f);

// Smallest whole-Naira price whose proceeds are at least `target`. The fee is not smooth (a flat part switches on at fee_flat_from and a cap
// stops it growing), so each regime is solved on its own and the best valid answer wins.
function priceForProceeds(target, f = DEFAULTS) {
  if (!(target > 0)) return 0;
  const r = f.fee_pct / 100;
  const cands = [Math.ceil(target / (1 - r)), Math.ceil((target + f.fee_flat) / (1 - r)), Math.ceil(target + f.fee_cap), f.fee_flat_from];
  const ok = cands.filter((p) => p > 0 && proceeds(p, f) >= target - 1e-9);
  return ok.length ? Math.min(...ok) : Math.ceil(target + f.fee_cap);
}

// Which margin rule applies: the product's own, else its category's, else the supplier's, else the shop default.
function resolveMargin({ product, category, supplier, shop }) {
  for (const [source, m] of [['product', product], ['category', category], ['supplier', supplier], ['shop', shop]]) {
    if (m && m.margin_type && m.margin_value != null && Number.isFinite(Number(m.margin_value))) return { type: m.margin_type, value: Number(m.margin_value), source };
  }
  return { type: DEFAULTS.margin_type, value: DEFAULTS.margin_value, source: 'built-in' };
}

// All the numbers for one product. `price` (optional) is the price actually charged, to show its profit; without it the calculated price is used.
function calculate(i) {
  const f = { ...DEFAULTS, ...(i.fees || {}) };
  const rate = Number(i.rate);
  if (!(rate > 0)) throw new Error('There is no exchange rate for this currency. Add one in Dropshipping > Settings.');
  const cost = Number(i.cost), ship = Number(i.ship_cost || 0);
  if (!(cost >= 0) || !(ship >= 0)) throw new Error('Cost and shipping must be zero or more.');
  const dutyPct = i.duty_pct == null ? f.duty_pct : Number(i.duty_pct), taxPct = i.tax_pct == null ? f.tax_pct : Number(i.tax_pct);
  const goods = round2(cost * rate), shipping = round2(ship * rate);
  const duty = round2(((goods + shipping) * dutyPct) / 100), tax = round2(((goods + shipping + duty) * taxPct) / 100);
  const landed = round2(goods + shipping + duty + tax);
  const m = i.margin || resolveMargin({});
  const margin_amount = m.type === 'fixed' ? round2(m.value) : round2((landed * m.value) / 100);
  const target = landed + margin_amount;
  // Rounding up to a "nice" price can cross the fee step and lose money, so the price is checked and nudged up until it really covers the target.
  const step = Math.max(1, Math.floor(f.round_to) || 1);
  let calc = Math.ceil(priceForProceeds(target, f) / step) * step;
  for (let n = 0; n < 200 && proceeds(calc, f) < target - 1e-9; n++) calc += step;
  const break_even = priceForProceeds(landed, f);
  const price = i.price != null && Number(i.price) > 0 ? Math.round(Number(i.price)) : calc;
  const fee = round2(paymentFee(price, f)), profit = round2(price - fee - landed);
  return {
    goods, shipping, duty, tax, landed, margin_rule: m, margin_amount, calculated_price: calc, break_even, price, fee, profit,
    markup_pct: landed > 0 ? round2((profit / landed) * 100) : null, margin_pct: price > 0 ? round2((profit / price) * 100) : null,
    below_break_even: price < break_even || profit < 0, rate,
  };
}

// Honest delivery window: our processing time (or the supplier's) + shipping to that region, and a safety buffer on the long end.
function deliveryEstimate({ processing_days, ship_times, region, buffer }) {
  const t = ship_times && (ship_times[region] || ship_times.ALL);
  if (!t) return null;
  const p = Math.max(0, Number(processing_days) || 0), b = Math.max(0, Number(buffer) || 0);
  return { min: p + t.min, max: p + t.max + b };
}

module.exports = { DEFAULTS, round2, paymentFee, proceeds, priceForProceeds, resolveMargin, calculate, deliveryEstimate };
