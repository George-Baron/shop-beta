'use strict';
// Small in-memory cache for catalogue reads, with no Redis.
//  - cached(key, ttlMs, fn, keepIf?): returns a fresh copy from memory, or runs fn once (many simultaneous misses share one run) and keeps the result for ttlMs.
//  - clear(): empties this instance's cache at once.
//  - bump(): clears this instance AND tells the other instances through the database (a "cache_version" row); each instance checks that row
//    every few seconds, so a product edited on one instance shows on all of them within about 5 seconds.
// Never cache anything that depends on who is asking (cart, account, orders, admin screens).
const { get, run } = require('./db');

const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES) || 1000;
const POLL_MS = Number(process.env.CACHE_POLL_MS) || 5000;
const enabled = process.env.CACHE_DISABLED !== '1';
const store = new Map();     // key -> { v, exp }
const inflight = new Map();  // key -> Promise
let epoch = 0;               // bumped by clear() so a read that started before a clear cannot put stale data back
const stats = { hit: 0, miss: 0, coalesced: 0 };

async function cached(key, ttlMs, fn, keepIf) {
  if (!enabled) return fn();
  const t = Date.now(), e = store.get(key);
  if (e && e.exp > t) { stats.hit++; return e.v; }
  if (inflight.has(key)) { stats.coalesced++; return inflight.get(key); }
  stats.miss++;
  const startEpoch = epoch;
  const p = (async () => {
    try {
      const v = await fn();
      if (epoch === startEpoch && (!keepIf || keepIf(v))) {
        if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value); // drop the oldest
        store.set(key, { v, exp: Date.now() + ttlMs });
      }
      return v;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

// Remove one entry on this instance (other instances catch up when it expires).
function drop(key) { store.delete(key); inflight.delete(key); epoch++; }

function clear() { epoch++; store.clear(); inflight.clear(); }

async function bump() {
  clear();
  const v = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  seen = v; ready = true;
  await run("INSERT INTO settings (key, value) VALUES ('cache_version', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", v);
}

let seen = null, ready = false, timer = null; // seen = the version row as last read; ready = we have read it at least once
function watch() {
  if (timer || !enabled) return;
  timer = setInterval(async () => {
    try {
      const r = await get("SELECT value FROM settings WHERE key='cache_version'");
      const v = r ? r.value : null;
      if (ready && v !== seen) clear(); // an empty-to-something change counts too
      seen = v; ready = true;
    } catch { /* database hiccup: try again next tick */ }
  }, POLL_MS);
  timer.unref();
  timer._onTimeout(); // read the starting version right away
}

module.exports = { cached, drop, clear, bump, watch, stats, size: () => store.size, enabled };
