'use strict';
// Pure delivery rules: distances, "is this point in Nigeria", range, fee, ETA, cut-off. No database, no network, so they are easy to test.

const R_EARTH_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Coarse outline of Nigeria as [lng, lat], a few km generous at the borders. It only has to keep out pins in Ghana, Benin, Niger, Chad,
// Cameroon or the sea; the delivery range then does the fine work. Checked against known cities in test/delivery.js.
const NIGERIA = [
  [2.65, 6.30], [2.78, 7.60], [3.15, 8.60], [3.65, 9.70], [3.90, 10.60], [3.60, 11.75], [3.85, 12.70], [4.30, 13.55], [5.20, 13.88], [6.00, 13.80],
  [7.00, 13.45], [8.50, 13.30], [10.00, 13.40], [11.50, 13.45], [12.60, 13.60], [13.70, 13.75], [14.75, 13.20], [14.70, 12.40], [14.25, 12.10],
  [13.95, 11.30], [13.80, 10.50], [13.60, 9.60], [12.95, 8.80], [12.10, 7.90], [11.70, 7.00], [11.30, 6.50], [10.10, 6.30], [9.40, 6.15], [9.00, 5.40],
  [8.70, 4.80], [8.45, 4.40], [8.20, 4.20], [7.00, 4.20], [5.50, 4.20], [4.50, 5.00], [3.60, 6.15],
];
function inNigeria(lat, lng) {
  if (!validCoord(lat, lng)) return false;
  let inside = false;
  for (let i = 0, j = NIGERIA.length - 1; i < NIGERIA.length; j = i++) {
    const [xi, yi] = NIGERIA[i], [xj, yj] = NIGERIA[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
function rules(S) {
  return {
    radius: Math.max(0, num(S.delivery_radius_km, 15)), max: Math.max(0, num(S.delivery_max_km, 40)), perKm: Math.max(0, num(S.delivery_per_km, 0)),
    road: Math.min(3, Math.max(1, num(S.delivery_road_factor, 1.3))), prepMin: Math.max(0, num(S.delivery_prep_min, 30)),
    speed: Math.max(5, num(S.delivery_speed_kmh, 25)), promiseMin: Math.max(10, num(S.delivery_promise_min, 90)),
    open: S.delivery_open || '08:00', cutoff: S.delivery_cutoff || '18:00',
  };
}

// Distance when no routing provider answered: straight line times a road factor.
const estimateRoadKm = (a, b, road) => Math.round(haversineKm(a, b) * road * 10) / 10;

// legs: [{ partnerId, name, radius_km, km }]. Every pickup must be within its own radius AND the shop-wide maximum.
function checkRange(legs, S) {
  const r = rules(S), problems = [];
  for (const l of legs) {
    const own = num(l.radius_km, 0) > 0 ? num(l.radius_km, 0) : r.radius;
    const limit = r.max > 0 ? Math.min(own, r.max) : own;
    if (limit > 0 && l.km > limit) problems.push({ partnerId: l.partnerId, name: l.name, km: l.km, limit });
  }
  return { ok: problems.length === 0, problems };
}

// The per-kilometre fee is charged on the longest pickup leg, on top of the state fee.
function deliveryFee(stateFee, legs, S, { free = false } = {}) {
  const r = rules(S), longest = legs.reduce((m, l) => Math.max(m, l.km), 0);
  const perKm = r.perKm > 0 ? Math.round((r.perKm * Math.ceil(longest)) / 10) * 10 : 0;
  return { stateFee: free ? 0 : stateFee, perKmFee: free ? 0 : perKm, fee: free ? 0 : stateFee + perKm };
}

// Minutes: preparation + the longest driving leg + 10 for each extra partner to visit.
function etaMinutes(legs, S) {
  const r = rules(S);
  const drive = legs.reduce((m, l) => Math.max(m, l.minutes != null ? l.minutes : (l.km / r.speed) * 60), 0);
  return Math.ceil(r.prepMin + drive + Math.max(0, legs.length - 1) * 10);
}

/* ---- Africa/Lagos clock (UTC+1, no daylight saving) ---- */
const LAGOS = 3600;
const minutesOfDay = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); return m ? Math.min(1439, +m[1] * 60 + +m[2]) : null; };
function lagosMinute(t) { return Math.floor((((t + LAGOS) % 86400) + 86400) % 86400 / 60); }
function lagosDayStart(t) { return Math.floor((t + LAGOS) / 86400) * 86400 - LAGOS; }

// Orders arriving after the cut-off (or before opening time) start counting at the next opening time.
function startFor(t, S) {
  const r = rules(S), open = minutesOfDay(r.open) ?? 480, cut = minutesOfDay(r.cutoff) ?? 1080, m = lagosMinute(t), day = lagosDayStart(t);
  if (m >= open && m < cut) return { startAt: t, deferred: false, opensAt: null };
  const opensAt = (m < open ? day : day + 86400) + open * 60;
  return { startAt: opensAt, deferred: true, opensAt };
}
const promisedAt = (startAt, legs, S) => startAt + etaMinutes(legs, S) * 60;

// Late = still open and past the promised time.
const isLate = (o, t) => !!o.promised_at && ['paid', 'confirmed', 'dispatched'].includes(o.status) && t > o.promised_at;

/* ---- deep links for turn-by-turn (no paid navigation) ---- */
const googleDirections = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
const osmDirections = (lat, lng) => `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=%3B${lat}%2C${lng}`;

module.exports = { haversineKm, inNigeria, validCoord, rules, estimateRoadKm, checkRange, deliveryFee, etaMinutes, startFor, promisedAt, isLate, lagosMinute, lagosDayStart, googleDirections, osmDirections, NIGERIA };
