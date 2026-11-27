'use strict';
// Choosing a delivery provider. Pure: plain rows in, a ranked, explained comparison out. No database, no clock, no network.
// Only recorded rates are compared. A provider with no current rate for the destination is listed with the reason, never given a made-up price.
// A factor with no data scores nothing and is left out of the weighting (coverage shows how much was known), exactly as supplier scoring does.
const FACTORS = ['reliability', 'speed', 'cost', 'safety'];
const DEFAULT_WEIGHTS = { reliability: 35, speed: 25, cost: 30, safety: 10 };
const MIN_SAMPLE = 5;                     // fewer finished shipments than this and the track record is "not enough data", not a score
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp = (n) => Math.max(0, Math.min(100, n));
const r1 = (n) => Math.round(n * 10) / 10;

function normalizeWeights(raw) {
  const w = {}; let sum = 0;
  for (const k of FACTORS) { const v = raw && num(raw[k]); w[k] = v != null && v >= 0 && v <= 1000 ? v : DEFAULT_WEIGHTS[k]; sum += w[k]; }
  return sum > 0 ? w : { ...DEFAULT_WEIGHTS };
}

// shipments: that provider's rows [{ status, eta, closed_at, created, last_event_at, lost_or_damaged }]. Only finished ones count.
function trackRecord(shipments) {
  const done = shipments.filter((s) => ['delivered', 'delivered_claimed', 'failed', 'returned'].includes(s.status));
  const delivered = done.filter((s) => s.status === 'delivered'), bad = done.filter((s) => s.status === 'failed' || s.status === 'returned');
  const withEta = delivered.filter((s) => num(s.eta) && num(s.closed_at)), onTime = withEta.filter((s) => Number(s.closed_at) <= Number(s.eta));
  const dmg = shipments.filter((s) => s.lost_or_damaged).length;
  return { finished: done.length, delivered: delivered.length, failed: bad.length, lost_or_damaged: dmg, on_time_pct: withEta.length ? r1((onTime.length / withEta.length) * 100) : null,
    success_pct: done.length ? r1((delivered.length / done.length) * 100) : null, enough: done.length >= MIN_SAMPLE };
}

// Does this rate card apply to this shipment? Returns [] if so, or the reasons it does not.
function whyNot(card, ship, now) {
  const why = [], d = String(card.destination || '*').trim().toLowerCase(), st = String(ship.state || '').trim().toLowerCase(), cc = String(ship.country || 'NG').trim().toLowerCase();
  if (card.valid_until && Number(card.valid_until) < now) why.push('The recorded rate has expired');
  if (d !== '*' && d !== st && d !== cc) why.push(`Rate is for ${card.destination}, not ${ship.state || ship.country || 'this destination'}`);
  const w = num(ship.weight_kg);
  if (w != null) { if (num(card.min_kg) != null && w < Number(card.min_kg)) why.push(`Below the ${card.min_kg} kg minimum`); if (num(card.max_kg) != null && w > Number(card.max_kg)) why.push(`Above the ${card.max_kg} kg limit`); }
  return why;
}

// options: [{ provider, card, ngn (price in naira or null if no verified rate), record }]. ship: { state, country, weight_kg }.
function compare({ ship, options, weights, now = Math.floor(Date.now() / 1000) }) {
  const w = normalizeWeights(weights), assumptions = [];
  if (num(ship.weight_kg) == null) assumptions.push('Parcel weight is not recorded, so weight limits were not checked. Confirm the weight before booking.');
  const rows = options.map((o) => {
    const reasons = whyNot(o.card, ship, now);
    if (o.provider.status !== 'approved') reasons.push(`Provider is "${o.provider.status.replace('_', ' ')}"`);
    if (o.ngn == null) reasons.push('Price cannot be converted at a verified exchange rate');
    return { provider: o.provider, card: o.card, ngn: o.ngn, record: o.record, qualified: reasons.length === 0, disqualified_because: reasons };
  });
  const q = rows.filter((r) => r.qualified), cheapest = q.length ? Math.min(...q.map((r) => r.ngn)) : null;
  const etas = q.map((r) => num(r.card.eta_days_max)).filter((x) => x != null), fastestEta = etas.length ? Math.min(...etas) : null;
  for (const r of rows) {
    const f = {}, rec = r.record;
    f.reliability = rec && rec.enough ? { score: clamp(rec.success_pct * 0.7 + (rec.on_time_pct != null ? rec.on_time_pct : rec.success_pct) * 0.3), basis: `${rec.finished} finished shipments, ${rec.success_pct}% delivered${rec.on_time_pct != null ? `, ${rec.on_time_pct}% on time` : ''}` } : { score: null, basis: rec && rec.finished ? `Only ${rec.finished} finished shipments (need ${MIN_SAMPLE})` : 'No shipment history yet' };
    f.speed = num(r.card.eta_days_max) != null && fastestEta != null ? { score: clamp((fastestEta / Math.max(1, Number(r.card.eta_days_max))) * 100), basis: `Up to ${r.card.eta_days_max} day(s) quoted` } : { score: null, basis: 'No delivery time recorded' };
    f.cost = r.ngn != null && cheapest ? { score: clamp((cheapest / r.ngn) * 100), basis: 'Cheapest qualifying rate ÷ this rate' } : { score: null, basis: 'No comparable price' };
    f.safety = rec && rec.enough ? { score: clamp(100 - (rec.lost_or_damaged / rec.finished) * 500), basis: `${rec.lost_or_damaged} lost or damaged of ${rec.finished}` } : { score: null, basis: 'Not enough history' };
    let got = 0, known = 0, total = 0; for (const k of FACTORS) { total += w[k]; if (f[k].score != null) { known += w[k]; got += w[k] * f[k].score; } }
    const sc = known > 0 ? got / known : null, cov = total > 0 ? (known / total) * 100 : 0;
    // A provider we know little about must not outrank a proven one just because the few factors we do know look good: the ranking is marked down by the share of the weighting with no data.
    r.evaluation = { score: sc != null ? r1(sc) : null, coverage: r1(cov), rank: sc != null ? r1(sc * (0.7 + 0.3 * cov / 100)) : null, factors: f };
  }
  const by = (arr, key, dir) => arr.slice().sort((a, b) => dir * (key(a) - key(b)))[0] || null, qq = rows.filter((r) => r.qualified);
  const best = by(qq.filter((r) => r.evaluation.score != null), (r) => r.evaluation.rank, -1), cheap = by(qq, (r) => r.ngn, 1), fast = by(qq.filter((r) => num(r.card.eta_days_max) != null), (r) => Number(r.card.eta_days_max), 1);
  const rec = best || cheap;
  let why = '';
  if (!qq.length) why = 'No provider has a current recorded rate that fits. Get a quotation and record it, or use a rider.';
  else {
    const rr = rec.evaluation; why = `${rec.provider.name} (${rec.card.service}) at about ${Math.round(rec.ngn).toLocaleString('en-NG')} NGN`;
    if (best) { why += ` scores ${rr.score}/100 on the weights you set (ranked ${rr.rank} after allowing for missing data)`; if (rr.coverage < 60) why += `, but only ${rr.coverage}% of the weighting had data, so treat it as a rough guide`; }
    else why += ' is the cheapest qualifying rate; there is no delivery history to rank by yet';
    if (cheap && cheap !== rec) why += `. ${cheap.provider.name} is cheaper by ${Math.round(rec.ngn - cheap.ngn).toLocaleString('en-NG')} NGN`;
    why += '.';
  }
  return { rows, cheapest: cheap, fastest: fast, best, recommended: rec, explanation: why, assumptions, weights: w };
}

module.exports = { FACTORS, DEFAULT_WEIGHTS, MIN_SAMPLE, normalizeWeights, trackRecord, whyNot, compare };
