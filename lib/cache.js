'use strict';
// Short-lived in-memory cache (no Redis). Each instance keeps its own copy of hot, public data.
//
//  - memo(key, ttlMs, loader): returns the cached value, or runs loader once even if 500 requests ask at the same moment
//    (so a cache miss on a busy page costs ONE database query, not hundreds).
//  - invalidate(): drops everything on this instance immediately and bumps a counter in the database. Every other instance
//    checks that counter every CACHE_POLL_MS (default 2 s) and drops its cache too. So an admin edit reaches all instances in
//    about 2 seconds, and the TTLs are only the safety net if that ever fails.
//  - Errors are never cached. A load that started before an invalidation never stores its (possibly old) result.
const { get, run } = require('./db');

const DISABLED = process.env.CACHE_DISABLED === '1';
const MAX = Math.max(10, Number(process.env.CACHE_MAX_ENTRIES) || 3000);
const POLL_MS = Math.max(200, Number(process.env.CACHE_POLL_MS) || 2000);

const store = new Map();     // key -> { v, exp }   (Map order = least recently used first)
const inflight = new Map();  // key -> promise
const stats = { hits: 0, misses: 0, coalesced: 0, evictions: 0, invalidations: 0, polls: 0, remoteInvalidations: 0 };
const SKIP = Symbol('skip');
const skip = (v) => ({ [SKIP]: v }); // a loader returns skip(value) to hand back an answer that must not be kept
let generation = 0, localEpoch = null, timer = null;

function put(key, v, ttlMs) {
  store.delete(key); store.set(key, { v, exp: Date.now() + ttlMs });
  while (store.size > MAX) { store.delete(store.keys().next().value); stats.evictions++; }
}

async function memo(key, ttlMs, loader) {
  if (DISABLED) { const v = await loader(); return v && v[SKIP] !== undefined ? v[SKIP] : v; }
  const e = store.get(key);
  if (e) {
    if (e.exp > Date.now()) { store.delete(key); store.set(key, e); stats.hits++; return e.v; }
    store.delete(key);
  }
  const pending = inflight.get(key);
  if (pending) { stats.coalesced++; return pending; }
  stats.misses++;
  const g = generation;
  const p = (async () => {
    try { let v = await loader(); if (v && v[SKIP] !== undefined) return v[SKIP]; if (g === generation) put(key, v, ttlMs); return v; }
    finally { if (inflight.get(key) === p) inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

function clearLocal() { generation++; store.clear(); inflight.clear(); }

// Call after anything that changes what shoppers see (products, categories, departments, settings, delivery fees, reviews).
function invalidate() {
  stats.invalidations++; clearLocal();
  if (DISABLED) return Promise.resolve();
  return run('UPDATE cache_epoch SET epoch = epoch + 1 WHERE id = 1').then(async () => {
    const r = await get('SELECT epoch FROM cache_epoch WHERE id = 1'); if (r) localEpoch = Number(r.epoch);
  }).catch((e) => { console.error('Cache: could not tell other instances to refresh (they will catch up when the TTL ends):', e.message); });
}

async function poll() {
  stats.polls++;
  try {
    const r = await get('SELECT epoch FROM cache_epoch WHERE id = 1'); if (!r) return;
    const epoch = Number(r.epoch);
    if (localEpoch === null) localEpoch = epoch;
    else if (epoch !== localEpoch) { localEpoch = epoch; clearLocal(); stats.remoteInvalidations++; }
  } catch { /* database busy: try again next time */ }
}

function start() {
  if (DISABLED || timer) return;
  poll(); timer = setInterval(poll, POLL_MS); timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

// Send a cached JSON string as the response.
async function sendJson(res, key, ttlMs, loader, cacheControl) {
  const body = await memo(key, ttlMs, async () => JSON.stringify(await loader()));
  if (cacheControl) res.set('Cache-Control', cacheControl);
  res.type('application/json; charset=utf-8').send(body);
}

const snapshot = () => ({ entries: store.size, max: MAX, ...stats, hitRate: stats.hits + stats.misses + stats.coalesced ? Math.round((100 * (stats.hits + stats.coalesced)) / (stats.hits + stats.misses + stats.coalesced)) : null });
function reset() { clearLocal(); localEpoch = null; for (const k of Object.keys(stats)) stats[k] = 0; }

module.exports = { memo, skip, sendJson, invalidate, clearLocal, start, stop, snapshot, reset, poll, DISABLED };
