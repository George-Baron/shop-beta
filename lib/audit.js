'use strict';
// The activity log. Every change (not reads) made through a router is written down: who, what, from where, and the result.
// Passwords, tokens, bank and card details and file contents are never recorded; long lists are replaced by their length.
const { run, now } = require('./db');

const SECRET = /pass|token|secret|data$|bank|account_?n|iban|card|cvv|otp|pin$|authorization/i;
function clean(v, depth = 0) {
  if (Array.isArray(v)) return v.length > 5 ? `[${v.length} items]` : v.map((x) => clean(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 2) return '[…]';
    const o = {}; for (const k of Object.keys(v)) o[k] = SECRET.test(k) ? '[hidden]' : clean(v[k], depth + 1); return o;
  }
  return typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
}
const detailOf = (body) => { try { return JSON.stringify(clean(body || {})).slice(0, 600); } catch { return ''; } };

// actor: 'staff' | 'partner' | 'buyer'. Use as router middleware (after the sign-in check, so req.user is known).
const activity = (actor) => (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  res.on('finish', () => {
    const u = req.user;
    run('INSERT INTO audit_log (user_id,user_name,method,path,status,detail,ip,created,actor) VALUES (?,?,?,?,?,?,?,?,?)', u ? u.id : null, u ? String(u.name || u.email || '').slice(0, 80) : '', req.method, req.originalUrl.split('?')[0].slice(0, 200), res.statusCode, detailOf(req.body), String(req.clientIp || '').slice(0, 60), now(), actor).catch((e) => console.error('Audit log failed:', e.message));
  });
  next();
};
module.exports = { activity, clean, detailOf };
