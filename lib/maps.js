'use strict';
// Address search and driving routes from a map provider with a free tier (Geoapify by default), with three protections:
//  1. every answer is cached in the database (addresses 30 days, routes 7 days), so the provider is never called per page view;
//  2. a daily call cap (MAP_DAILY_CALL_CAP) stops us before the free quota runs out;
//  3. if the provider is down, slow, or over the cap, routes fall back to a straight-line estimate and address search says it is unavailable.
// Without MAP_API_KEY nothing is called at all: the map still works (pin, my location) with estimated distances.
const { get, run, now } = require('./db');
const geo = require('./geo');
const log = require('./log');

const PROVIDER = (process.env.MAP_PROVIDER || 'geoapify').toLowerCase();
const KEY = process.env.MAP_API_KEY || '';
const API = (process.env.MAP_API_URL || 'https://api.geoapify.com').replace(/\/+$/, ''); // overridden only by tests
const CAP = Math.max(0, Number(process.env.MAP_DAILY_CALL_CAP ?? 2000));
const TIMEOUT = 4000, GEO_TTL = 30 * 86400, ROUTE_TTL = 7 * 86400;
const enabled = () => PROVIDER === 'geoapify' && !!KEY;

// What the browser needs to draw the map. The key is meant to be public: restrict it to your domain in the provider dashboard.
function clientConfig() {
  const tile = process.env.MAP_TILE_URL || (enabled() ? `https://maps.geoapify.com/v1/tile/osm-bright/{z}/{x}/{y}.png?apiKey=${KEY}` : '');
  const dev = process.env.NODE_ENV !== 'production';
  return {
    enabled: enabled(),
    // The public OpenStreetMap tile server forbids heavy production use, so it is only a development fallback.
    tileUrl: tile || (dev ? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' : ''),
    attribution: tile ? '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · <a href="https://www.geoapify.com/">Powered by Geoapify</a>' : '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    searchAvailable: enabled(),
  };
}

let downUntil = 0; // after a failure, leave the provider alone for a minute
const inflight = new Map();
async function cached(key, ttl, load) {
  const row = await get('SELECT value, created FROM geo_cache WHERE key=?', key);
  if (row && row.created > now() - ttl) return JSON.parse(row.value);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => { const v = await load(); if (v) await run('INSERT INTO geo_cache (key,value,created) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value, created=excluded.created', key, JSON.stringify(v), now()); return v; })()
    .finally(() => inflight.delete(key));
  inflight.set(key, p); return p;
}
// Counts calls we really make today (shared by all instances through the database).
async function spend() {
  if (!CAP) return false;
  const day = 'usage:' + new Date().toISOString().slice(0, 10);
  const r = await get(`INSERT INTO geo_cache (key,value,created) VALUES (?,'1',?) ON CONFLICT (key) DO UPDATE SET value = (geo_cache.value::int + 1)::text RETURNING value`, day, now());
  return Number(r.value) <= CAP;
}
async function call(path) {
  if (!enabled() || Date.now() < downUntil) return null;
  if (!await spend()) { log.warn('Map provider daily call cap reached; using estimates'); return null; }
  try {
    const res = await fetch(API + path + (path.includes('?') ? '&' : '?') + 'apiKey=' + encodeURIComponent(KEY), { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error('Map provider answered ' + res.status);
    return await res.json();
  } catch (e) { downUntil = Date.now() + 60000; log.warn('Map provider unavailable, using estimates:', e.message); return null; }
}

const r4 = (n) => Math.round(n * 1e4) / 1e4;
// Address search (Nigeria only). Returns { available, results: [{label, lat, lng}] }.
async function geocode(text) {
  const q = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 150);
  if (q.length < 3) return { available: enabled(), results: [] };
  if (!enabled()) return { available: false, results: [] };
  const results = await cached('g:' + q.toLowerCase(), GEO_TTL, async () => {
    const j = await call(`/v1/geocode/search?text=${encodeURIComponent(q)}&filter=countrycode:ng&limit=5&format=json`);
    if (!j) return null;
    return (j.results || []).map((r) => ({ label: String(r.formatted || '').slice(0, 200), lat: Number(r.lat), lng: Number(r.lon) })).filter((r) => r.label && geo.inNigeria(r.lat, r.lng));
  });
  return results ? { available: true, results } : { available: false, results: [] };
}

// Driving route from -> to: { km, minutes, line: [[lat,lng],...], source: 'provider' | 'estimate' }.
async function route(from, to, S) {
  const road = geo.rules(S || {}).road, speed = geo.rules(S || {}).speed;
  const key = `r:${r4(from.lat)},${r4(from.lng)}>${r4(to.lat)},${r4(to.lng)}`;
  const j = enabled() ? await cached(key, ROUTE_TTL, async () => {
    const d = await call(`/v1/routing?waypoints=${from.lat},${from.lng}|${to.lat},${to.lng}&mode=drive`);
    const f = d && d.features && d.features[0];
    if (!f || !f.properties || !Number.isFinite(f.properties.distance)) return null;
    const lines = f.geometry && f.geometry.coordinates ? (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates) : [];
    return { km: Math.round(f.properties.distance / 100) / 10, minutes: Math.max(1, Math.round((f.properties.time || 0) / 60)), line: lines.filter((c) => c.length >= 2).map((c) => [c[1], c[0]]).filter((_, i, a) => a.length <= 400 || i % Math.ceil(a.length / 400) === 0) };
  }).catch(() => null) : null;
  if (j) return { ...j, source: 'provider' };
  const km = geo.estimateRoadKm(from, to, road);
  return { km, minutes: Math.max(1, Math.round((km / speed) * 60)), line: [[from.lat, from.lng], [to.lat, to.lng]], source: 'estimate' };
}
async function purgeCache() { return (await run("DELETE FROM geo_cache WHERE created < ? AND key NOT LIKE 'usage:%'", now() - 30 * 86400)).changes + (await run("DELETE FROM geo_cache WHERE created < ? AND key LIKE 'usage:%'", now() - 3 * 86400)).changes; }

module.exports = { enabled, clientConfig, geocode, route, purgeCache };
