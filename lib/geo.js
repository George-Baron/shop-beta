'use strict';
// Map provider access: routes (distance + driving time + line) and address search, with a database cache and a safe fallback.
//   GEO_PROVIDER   geoapify (default when GEOAPIFY_API_KEY is set) or none
//   GEOAPIFY_API_KEY   free plan: 3,000 requests/day, commercial use allowed, needs a visible "Powered by Geoapify" link. Restrict the key to your domain in the Geoapify dashboard.
// The public OpenStreetMap servers are NOT used in production: their policies do not allow heavy commercial traffic.
const { get, run, now } = require('./db');

const KEY = process.env.GEOAPIFY_API_KEY || '';
const API = (process.env.GEO_API_URL || 'https://api.geoapify.com').replace(/\/+$/, '');
const PROVIDER = (process.env.GEO_PROVIDER || (KEY ? 'geoapify' : 'none')).toLowerCase();
const TILE_URL = PROVIDER === 'geoapify' && KEY ? `https://maps.geoapify.com/v1/tile/osm-bright/{z}/{x}/{y}.png?apiKey=${KEY}` : '';
const ROUTE_TTL = 30 * 86400, SEARCH_TTL = 30 * 86400;

const inNigeria = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= 4.2 && lat <= 13.95 && lng >= 2.65 && lng <= 14.7;
const rad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const r3 = (n) => Math.round(n * 1000) / 1000; // about 110 m: nearby points share one cached answer
const round1 = (n) => Math.round(n * 10) / 10;

const PAUSE_MS = Number(process.env.GEO_DOWN_PAUSE_MS) || 60000;
let downUntil = 0; // after a provider failure, skip it for a minute instead of making every customer wait
async function cacheGet(key) { const r = await get('SELECT value FROM geo_cache WHERE key=? AND created>?', key, now() - ROUTE_TTL); return r ? r.value : null; }
const cachePut = (key, value) => run('INSERT INTO geo_cache (key,value,created) VALUES (?,?::jsonb,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value, created=excluded.created', key, JSON.stringify(value), now());

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error('map provider answered ' + res.status);
  return res.json();
}
const thin = (pts) => { if (pts.length <= 120) return pts; const step = Math.ceil(pts.length / 120); return pts.filter((_, i) => i % step === 0 || i === pts.length - 1); };

// Driving route from a to b. Always returns { km, minutes, line, approx }: when the provider is missing or down it falls back to a straight-line estimate (approx = true).
async function route(a, b) {
  const key = `route:${r3(a.lat)},${r3(a.lng)}>${r3(b.lat)},${r3(b.lng)}`;
  const hit = await cacheGet(key).catch(() => null);
  if (hit) return hit;
  if (PROVIDER === 'geoapify' && KEY && Date.now() > downUntil) {
    try {
      const d = await fetchJson(`${API}/v1/routing?waypoints=${a.lat},${a.lng}|${b.lat},${b.lng}&mode=drive&apiKey=${encodeURIComponent(KEY)}`);
      const f = d.features && d.features[0], p = f && f.properties;
      if (p && p.distance && p.time) {
        const coords = [].concat(...(f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]));
        const out = { km: round1(p.distance / 1000), minutes: Math.max(1, Math.round(p.time / 60)), line: thin(coords.map(([lng, lat]) => [lat, lng])), approx: false };
        await cachePut(key, out).catch(() => {});
        return out;
      }
    } catch (e) { downUntil = Date.now() + PAUSE_MS; console.error('Route lookup failed, using straight-line estimate:', e.message); }
  }
  // Fallback: straight line x 1.35 for roads, at about 25 km/h through city traffic. Not cached, so it corrects itself when the provider is back.
  const km = round1(haversineKm(a, b) * 1.35);
  return { km, minutes: Math.max(5, Math.round((km / 25) * 60)), line: [[a.lat, a.lng], [b.lat, b.lng]], approx: true };
}

// Address search limited to Nigeria. Returns [] when no provider is set.
async function search(text) {
  const q = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
  if (q.length < 3 || PROVIDER !== 'geoapify' || !KEY) return [];
  const key = 'search:' + q;
  const hit = await cacheGet(key).catch(() => null);
  if (hit) return hit;
  if (Date.now() < downUntil) return [];
  try {
    const d = await fetchJson(`${API}/v1/geocode/search?text=${encodeURIComponent(q)}&filter=countrycode:ng&limit=5&format=json&apiKey=${encodeURIComponent(KEY)}`);
    const out = (d.results || []).map((r) => ({ label: String(r.formatted || '').slice(0, 200), lat: Number(r.lat), lng: Number(r.lon) })).filter((r) => inNigeria(r.lat, r.lng));
    await cachePut(key, out).catch(() => {});
    return out;
  } catch (e) { downUntil = Date.now() + PAUSE_MS; console.error('Address search failed:', e.message); return []; }
}
const prune = () => run('DELETE FROM geo_cache WHERE created<?', now() - 45 * 86400);

module.exports = { inNigeria, haversineKm, route, search, prune, TILE_URL, PROVIDER, hasProvider: () => PROVIDER === 'geoapify' && !!KEY };
