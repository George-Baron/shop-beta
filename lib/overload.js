'use strict';
// Keeps the server alive when far more people arrive than it can serve at once.
//  1. Connection settings that suit Render's proxy (the Node defaults close idle connections after 5 s, which caused dropped requests under load).
//  2. Load shedding: when the server is overloaded (too many requests in flight, the event loop is falling behind, or memory is nearly full) it answers
//     NEW browsing requests with a quick "we are busy, retry in a few seconds" (503 + Retry-After) instead of taking on work that would run it out of memory.
//     Checkout and payment requests have their own, separate limit, so a crowd of browsers can never push out a customer who is paying. Payment webhooks
//     and /health are never refused.
//  3. A health check that does not queue behind customer traffic (the database is probed in the background), so Render never restarts a healthy but busy instance.
// Everything is tunable with environment variables; OVERLOAD_DISABLED=1 switches shedding off.
const fs = require('fs');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');
const log = require('./log');

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const E = process.env;
const cfg = {
  off: E.OVERLOAD_DISABLED === '1',
  maxBrowse: num(E.MAX_INFLIGHT_BROWSE, 1500),   // browsing requests being worked on at the same moment, per instance
  maxPay: num(E.MAX_INFLIGHT_PAY, 400),         // checkout and payment requests being worked on at the same moment, per instance
  lagMs: num(E.SHED_LAG_MS, 1000),              // event loop falling this far behind (99th percentile over one second) counts as overloaded
  memPct: num(E.SHED_MEMORY_PCT, 85),           // % of the memory limit at which browsing is refused (payments are only refused at 95%)
  keepAliveMs: num(E.KEEP_ALIVE_MS, 120000),
  requestTimeoutMs: num(E.REQUEST_TIMEOUT_MS, 60000),
};

// The memory limit: MEMORY_LIMIT_MB if set, else the container's own limit (cgroup), else the machine's memory.
function memoryLimitBytes() {
  if (num(E.MEMORY_LIMIT_MB, 0) > 0) return num(E.MEMORY_LIMIT_MB, 0) * 1048576;
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try { const v = Number(fs.readFileSync(f, 'utf8').trim()); if (Number.isFinite(v) && v > 0 && v < os.totalmem() * 2) return v; } catch { /* not in a container */ }
  }
  return os.totalmem();
}
const LIMIT = memoryLimitBytes();

const inflight = { browse: 0, pay: 0 };
const stats = { shed: 0, shedPay: 0, peakBrowse: 0, peakPay: 0, lagMs: 0, rssMb: 0 };
const state = { browseBlocked: '', payBlocked: '' };

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
let lastLogged = 0;
function sample() {
  const lag = histogram.percentile(99) / 1e6; histogram.reset();
  const rss = process.memoryUsage().rss, pct = (rss / LIMIT) * 100;
  stats.lagMs = Math.round(lag); stats.rssMb = Math.round(rss / 1048576);
  state.browseBlocked = pct >= cfg.memPct ? 'memory' : lag >= cfg.lagMs ? 'slow' : '';
  state.payBlocked = pct >= 95 ? 'memory' : '';
  if (state.browseBlocked || state.payBlocked) {
    const t = Date.now(); if (t - lastLogged > 10000) { lastLogged = t; log.warn('overloaded: refusing new requests for a moment', { reason: state.browseBlocked || state.payBlocked, lagMs: stats.lagMs, rssMb: stats.rssMb, memoryLimitMb: Math.round(LIMIT / 1048576), inflight: { ...inflight }, shed: stats.shed }); }
  }
}
const timer = setInterval(sample, 1000); timer.unref();

const PAY = /^\/api\/(checkout|paystack|stripe|pay)(\/|$)/;
const NEVER = /^\/(health|assets\/|px\/)|webhook/;

function middleware(req, res, next) {
  if (cfg.off) return next();
  const p = req.path;
  if (NEVER.test(p)) return next();
  const group = PAY.test(p) ? 'pay' : 'browse';
  const reason = group === 'pay' ? (state.payBlocked || (inflight.pay >= cfg.maxPay ? 'busy' : '')) : (state.browseBlocked || (inflight.browse >= cfg.maxBrowse ? 'busy' : ''));
  if (reason) {
    stats.shed++; if (group === 'pay') stats.shedPay++;
    res.set({ 'Retry-After': String(2 + Math.floor(Math.random() * 4)), 'Cache-Control': 'no-store' });
    if (!p.startsWith('/api/') && req.method === 'GET' && req.accepts(['json', 'html']) === 'html') {
      return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>One moment</title><body style="font-family:system-ui;text-align:center;padding:15vh 16px"><h1>We are very busy right now</h1><p>Lots of people are shopping at the same moment. This page will try again in a few seconds.</p></body>');
    }
    return res.status(503).json({ error: 'We are very busy right now. Please try again in a few seconds.', code: 'busy' });
  }
  inflight[group]++;
  if (inflight[group] > (group === 'pay' ? stats.peakPay : stats.peakBrowse)) { if (group === 'pay') stats.peakPay = inflight.pay; else stats.peakBrowse = inflight.browse; }
  let done = false; const finish = () => { if (!done) { done = true; inflight[group]--; } };
  res.on('finish', finish); res.on('close', finish);
  return next();
}

// Connection settings for the HTTP server (call once after app.listen).
function configureServer(server) {
  server.keepAliveTimeout = cfg.keepAliveMs;            // longer than the proxy's idle time, so the proxy never reuses a connection we already closed
  server.headersTimeout = cfg.keepAliveMs + 5000;       // must be larger than keepAliveTimeout
  server.requestTimeout = cfg.requestTimeoutMs;         // a client that takes longer than this to send its request is dropped
  if (num(E.MAX_CONNECTIONS, 0) > 0) server.maxConnections = num(E.MAX_CONNECTIONS, 0);
}

// Health that never waits in line behind customers: the database is probed in the background every 5 s.
function healthProbe(check) {
  const h = { ok: true, failingSince: 0, lastOkAt: Date.now() };
  const probe = async () => {
    try { await Promise.race([check(), new Promise((_, rej) => setTimeout(() => rej(new Error('database timeout')), 8000))]); h.ok = true; h.failingSince = 0; h.lastOkAt = Date.now(); }
    catch (e) { if (h.ok) h.failingSince = Date.now(); h.ok = false; log.error('health check failed', { err: e }); }
  };
  const t = setInterval(probe, 5000); t.unref(); probe();
  // unhealthy only when the database has been failing for 15 s or more (one slow moment does not get an instance restarted)
  return () => h.ok || Date.now() - h.failingSince < 15000;
}

module.exports = { middleware, configureServer, healthProbe, stats, inflight, state, cfg };
