'use strict';
// Logging with a request id on every line.
//  - Production (or LOG_FORMAT=json): one JSON object per line, easy to search in Render's log view.
//  - Development: short readable lines.
// LOG_LEVEL = debug | info | warn | error (default info; tests set it to warn so output stays quiet).
const crypto = require('crypto');
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;
const json = (process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'text')) === 'json';
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS) || 1500;

function write(level, msg, fields) {
  if (LEVELS[level] < min) return;
  const f = { ...(fields || {}) };
  if (f.err) { f.error = String(f.err && f.err.message || f.err); if (f.err.stack && level === 'error') f.stack = String(f.err.stack).split('\n').slice(0, 6).join(' | '); delete f.err; }
  const line = json
    ? JSON.stringify({ time: new Date().toISOString(), level, msg, ...f })
    : `${new Date().toISOString().slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${msg}${Object.keys(f).length ? ' ' + Object.entries(f).map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`).join(' ') : ''}`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}
const log = { debug: (m, f) => write('debug', m, f), info: (m, f) => write('info', m, f), warn: (m, f) => write('warn', m, f), error: (m, f) => write('error', m, f) };

// Gives every request an id (taken from the platform's X-Request-Id if it looks sane), echoes it back, and logs one line when the response is sent.
// Only the path is logged, never the query string: order links carry private tokens in it.
function requestLogger(req, res, next) {
  const given = String(req.headers['x-request-id'] || '');
  req.id = /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    const path = (req.originalUrl || req.url || '').split('?')[0].slice(0, 200);
    if (path === '/health' && res.statusCode < 400) return; // uptime checks would drown everything else
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 || ms >= SLOW_MS ? 'warn' : 'info';
    write(level, ms >= SLOW_MS && res.statusCode < 400 ? 'slow request' : 'request', { id: req.id, method: req.method, path, status: res.statusCode, ms, ip: req.clientIp || req.ip, user: req.user ? req.user.id : undefined });
  });
  next();
}

module.exports = { ...log, requestLogger };
