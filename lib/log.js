'use strict';
// Structured logs. One JSON object per line (what Render's log search and any log drain understand):
//   {"ts":"2026-11-12T09:00:00.000Z","level":"error","msg":"...","instance":"srv-abc", ...fields}
// In a terminal during development the same lines are printed as plain text. Force either with LOG_FORMAT=json|text.
// Secrets are never logged: any field named like a password, token, key, cookie or authorization is replaced by "[redacted]".
const INSTANCE = process.env.INSTANCE_ID || process.env.RENDER_INSTANCE_ID || require('os').hostname();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;
const json = () => (process.env.LOG_FORMAT ? process.env.LOG_FORMAT === 'json' : process.env.NODE_ENV === 'production' || !process.stdout.isTTY);
const SECRET = /pass|secret|token|authorization|cookie|api[_-]?key|service_role|dsn|signature/i;

function clean(v, depth = 0) {
  if (v instanceof Error) return { name: v.name, message: String(v.message).slice(0, 500), code: v.code, stack: String(v.stack || '').split('\n').slice(0, 8).join('\n') };
  if (v === null || typeof v !== 'object') return typeof v === 'string' && v.length > 1000 ? v.slice(0, 1000) + '…' : v;
  if (depth > 3) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clean(x, depth + 1));
  const o = {}; for (const [k, x] of Object.entries(v)) o[k] = SECRET.test(k) ? '[redacted]' : clean(x, depth + 1);
  return o;
}

function write(level, args) {
  if (LEVELS[level] < MIN) return;
  const parts = [], fields = {};
  for (const a of args) {
    if (a instanceof Error) fields.err = clean(a);
    else if (a && typeof a === 'object') Object.assign(fields, clean(a));
    else parts.push(String(a));
  }
  const msg = parts.join(' ');
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (json()) out.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, instance: INSTANCE, ...fields }) + '\n');
  else out.write((level === 'info' ? '' : level.toUpperCase() + ': ') + msg + (fields.err ? ' ' + (fields.err.stack || fields.err.message) : Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '') + '\n');
}

module.exports = { debug: (...a) => write('debug', a), info: (...a) => write('info', a), log: (...a) => write('info', a), warn: (...a) => write('warn', a), error: (...a) => write('error', a), clean, INSTANCE };
