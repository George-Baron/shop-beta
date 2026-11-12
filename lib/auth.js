'use strict';
// Passwords (scrypt), cookie sessions, rate limiting. No third-party packages.
const crypto = require('crypto');
const { get, run, now } = require('./db');
const { HttpError } = require('./shop');

const COOKIE = 'sb_sid';
const SESSION_DAYS = 30, STAFF_SESSION_DAYS = 3;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function scrypt(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))));
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + (await scrypt(pw, salt)).toString('hex');
}
async function checkPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const k = await scrypt(pw, Buffer.from(salt, 'hex'));
  const h = Buffer.from(hash, 'hex');
  return k.length === h.length && crypto.timingSafeEqual(k, h);
}
// Used to spend the same time when an email does not exist, so login does not reveal which emails are registered.
const DUMMY = 'scrypt$' + '00'.repeat(16) + '$' + '00'.repeat(64);
const burn = (pw) => checkPassword(pw, DUMMY).catch(() => false);

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip */ }
  }
  return out;
}

async function startSession(req, res, userId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const days = role === 'admin' || role === 'rider' ? STAFF_SESSION_DAYS : SESSION_DAYS; // staff sign in again sooner
  await run('INSERT INTO sessions (id,user_id,expires) VALUES (?,?,?)', sha(token), userId, now() + days * 86400);
  const secure = req.secure || String(process.env.BASE_URL || '').startsWith('https://');
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure ? '; Secure' : ''}`);
}
async function endSession(req, res) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (t) await run('DELETE FROM sessions WHERE id=?', sha(t));
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
async function dropUserSessions(userId, exceptToken) {
  if (exceptToken) await run('DELETE FROM sessions WHERE user_id=? AND id<>?', userId, sha(exceptToken));
  else await run('DELETE FROM sessions WHERE user_id=?', userId);
}

async function loadUser(req, res, next) {
  try {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    req.sessionToken = t || '';
    if (t && /^[0-9a-f]{64}$/.test(t)) {
      const u = await get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id=? AND s.expires>?', sha(t), now());
      if (u && u.active !== 0) req.user = u; // switched-off staff are signed out everywhere
    }
    next();
  } catch (err) { next(err); }
}
const requireUser = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in.')));
const requireRider = (req, res, next) => (req.user && req.user.role === 'rider' ? next() : next(new HttpError(401, 'Please sign in as a rider.')));
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : next(new HttpError(401, 'Please sign in as an administrator.')));

/* ---- rate limiting: counted in Postgres, so every instance shares the same counters ---- */
// If the database cannot be reached the limiter falls back to this process's memory rather than blocking the shop.
const mem = new Map();
function memHit(key, max, windowMs) {
  const t = Date.now(); let b = mem.get(key);
  if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; mem.set(key, b); }
  return ++b.n <= max;
}
const LIMIT_X = Number(process.env.RATE_LIMIT_MULTIPLIER) || 1; // tests raise it; leave unset in production
// Count one event and say whether it is still within the limit.
async function hit(key, max, windowMs) {
  max *= LIMIT_X;
  try {
    const t = now(), r = await get(
      `INSERT INTO rate_limits (key, n, reset_at) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET n = CASE WHEN rate_limits.reset_at < ? THEN 1 ELSE rate_limits.n + 1 END,
                                       reset_at = CASE WHEN rate_limits.reset_at < ? THEN ? ELSE rate_limits.reset_at END
       RETURNING n`, key, t + Math.ceil(windowMs / 1000), t, t, t + Math.ceil(windowMs / 1000));
    return Number(r.n) <= max;
  } catch (e) { console.error('Rate limiter fell back to memory:', e.message); return memHit(key, max, windowMs); }
}
// Look without counting (used for failed-login counters, which only count failures).
async function over(key, max) {
  try { const r = await get('SELECT n FROM rate_limits WHERE key=? AND reset_at>=?', key, now()); return !!r && Number(r.n) >= max * LIMIT_X; }
  catch { return false; }
}
const limiter = (name, max, windowMs, msg) => async (req, res, next) => {
  try { return (await hit(`${name}:${req.clientIp || req.ip}`, max, windowMs)) ? next() : next(new HttpError(429, msg || 'Too many requests. Please wait a few minutes and try again.')); } catch (e) { return next(e); }
};
const prune = () => run('DELETE FROM rate_limits WHERE reset_at<?', now());
setInterval(() => { const t = Date.now(); for (const [k, b] of mem) if (b.reset < t) mem.delete(k); }, 60000).unref();

// A cheap per-instance limit for busy read endpoints (search). It never touches the database, so it costs nothing per request.
// Each instance counts separately, which is fine for protecting against one visitor hammering the search box.
const quick = new Map();
const quickLimiter = (name, max, windowMs, msg) => (req, res, next) => {
  const t = Date.now(), key = name + ':' + (req.clientIp || req.ip);
  if (quick.size > 50000) for (const [k, b] of quick) if (b.reset < t) quick.delete(k);
  let b = quick.get(key); if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; quick.set(key, b); }
  if (++b.n * 1 <= max * LIMIT_X) return next();
  res.set('Retry-After', String(Math.ceil((b.reset - t) / 1000)));
  return next(new HttpError(429, msg || 'Too many searches. Please wait a moment.'));
};

module.exports = { quickLimiter, hashPassword, checkPassword, burn, publicUser, parseCookies, startSession, endSession, dropUserSessions, loadUser, requireUser, requireAdmin, requireRider, limiter, hit, over, prune, sha, COOKIE };
