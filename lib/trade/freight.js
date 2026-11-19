'use strict';
// Shipping price calculator for the rates YOU enter (zones, services, weight brackets). Every price from here is a "manual_estimate".
// Nothing is invented: no zone, service or bracket for a destination means no option is offered for it.
//
// How a price is built (all steps shown to the customer in the breakdown):
//   weight      actual kg = sum of weight x qty;  volumetric kg = sum of (L x W x H / divisor) x qty;  chargeable = larger of the two,
//               rounded UP to the rule's weight step (default 0.5 kg)
//   carrier     base + per-kg x chargeable kg
//   + fuel      fuel surcharge % of the carrier amount
//   + remote    flat remote-area surcharge when the postal code starts with a remote prefix of the zone
//   + margin    our margin % (the rule's own, or the global one when the rule has none)
//   + handling  the rule's handling fee, then the global handling fee (NGN)
// Rule money is in the rule's currency and is converted to NGN with the stored exchange rate.
const { all } = require('../db');
const T = require('./core');
const FX = require('./fx');

const jsonList = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
const ceilStep = (v, step) => Math.ceil(Math.round(v / step * 1e6) / 1e6) * step;
const r3 = (n) => Math.round(n * 1000) / 1000;

// lines: [{ qty, weight_kg, length_cm, width_cm, height_cm }]
function weights(lines, divisor) {
  let actual = 0, vol = 0;
  for (const l of lines) { actual += Number(l.weight_kg) * l.qty; vol += (Number(l.length_cm) * Number(l.width_cm) * Number(l.height_cm) / divisor) * l.qty; }
  return { actual: r3(actual), volumetric: r3(vol) };
}

// All shipping options for a destination. Returns [{ service, rule, zone, weights, parts (NGN), shipping_ngn, insurance_ngn, days }].
async function options({ country, postal, lines, goodsNgn, wantInsurance, st }) {
  const zones = (await all('SELECT * FROM shipping_zones WHERE active=1 AND origin_country=?', st.origin_country)).filter((z) => jsonList(z.countries).includes(country));
  if (!zones.length) return [];
  const out = [];
  for (const z of zones) {
    const services = await all("SELECT s.*, p.name AS provider_name, p.code AS provider_code FROM shipping_services s JOIN shipping_providers p ON p.id=s.provider_id WHERE s.active=1 AND p.enabled=1 AND p.kind='manual' ORDER BY s.est_days_min NULLS LAST, s.id");
    const rules = await all('SELECT * FROM shipping_rate_rules WHERE zone_id=? AND active=1 ORDER BY min_kg', z.id);
    for (const s of services) {
      const mine = rules.filter((r) => r.service_id == null || Number(r.service_id) === Number(s.id));
      const specific = mine.filter((r) => Number(r.service_id) === Number(s.id));
      const pool = specific.length ? specific : mine;       // rules written for this service win over zone-wide ones
      if (!pool.length) continue;
      const w0 = weights(lines, Number(pool[0].volumetric_divisor));
      const step = Number(pool[0].weight_step) || 0.5;
      const chargeable = r3(ceilStep(Math.max(w0.actual, w0.volumetric), step));
      if (!(chargeable > 0)) continue;
      const rule = pool.filter((r) => Number(r.min_kg) < chargeable + 1e-9 && (r.max_kg == null || chargeable <= Number(r.max_kg) + 1e-9)).sort((a, b) => Number(b.min_kg) - Number(a.min_kg))[0];
      if (!rule) continue;                                   // heavier than every bracket: this method cannot take the parcel
      const ruleRate = await FX.rate(rule.currency, 'NGN');   // 503 when there is no usable rate
      const base = Number(rule.base_amount), perKg = Number(rule.per_kg) * chargeable, carrier = base + perKg;
      const fuel = carrier * Number(rule.fuel_surcharge_pct) / 100;
      const remote = jsonList(z.remote_area_postcodes).some((p) => p && String(postal || '').replace(/\s+/g, '').toUpperCase().startsWith(p.replace(/\s+/g, '').toUpperCase())) ? Number(rule.remote_surcharge) : 0;
      const marginPct = Number(rule.margin_pct) > 0 ? Number(rule.margin_pct) : Number(st.shipping_margin_pct);
      const margin = (carrier + fuel + remote) * marginPct / 100;
      const handling = Number(rule.handling_fee);
      const toNgn = (x) => x * ruleRate.rate;
      const parts = { carrier: toNgn(carrier), fuel: toNgn(fuel), remote: toNgn(remote), margin: toNgn(margin), handling: toNgn(handling) + Number(st.handling_fee_ngn) };
      const shipping = Math.ceil(Object.values(parts).reduce((a, b) => a + b, 0) - 1e-9);
      const insurance = wantInsurance && Number(s.supports_insurance) && Number(st.insurance_pct) > 0 ? Math.ceil(goodsNgn * Number(st.insurance_pct) / 100) : 0;
      out.push({ service: s, rule, zone: z, weights: { actual_kg: w0.actual, volumetric_kg: w0.volumetric, chargeable_kg: chargeable, divisor: Number(pool[0].volumetric_divisor), step }, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100) / 100])), shipping_ngn: shipping, insurance_ngn: insurance, rate_stale: ruleRate.stale, rate_source: ruleRate.source });
    }
  }
  return out;
}

module.exports = { options, weights, ceilStep };
