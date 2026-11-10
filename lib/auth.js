'use strict';
// Passwords (scrypt), cookie sessions, rate limiting. No third-party packages.
const crypto = require('crypto');
const { get, run, now } = require('./db');
const { HttpError } = require('./shop');

const COOKIE = 'sb_sid';
const SESSION_DAYS = 30;
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

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions (id,user_id,expires) VALUES (?,?,?)', sha(token), userId, now() + SESSION_DAYS * 86400);
  const secure = req.secure || String(process.env.BASE_URL || '').startsWith('https://');
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
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
  const t = parseCookies(req.headers.cookie)[COOKIE];
  req.sessionToken = t || '';
  if (t && /^[0-9a-f]{64}$/.test(t)) {
    try {
      const u = await get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id=? AND s.expires>?', sha(t), now());
      if (u) req.user = u;
    } catch (e) { return next(e); }
  }
  next();
}
const requireUser = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in.')));
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : next(new HttpError(401, 'Please sign in as an administrator.')));

/* ---- rate limiting, shared by every instance through the database ---- */
// One row per key, counted in a fixed window. A single atomic statement, so two instances cannot both
// let the last request through. If the database fails we let the request through (and log): shoppers must
// not be blocked by the limiter itself.
async function hit(key, max, windowMs) {
  const t = Date.now();
  try {
    const r = await get(`INSERT INTO rate_limits (key, n, reset_at) VALUES (?, 1, ?)
      ON CONFLICT (key) DO UPDATE SET n = CASE WHEN rate_limits.reset_at < ? THEN 1 ELSE rate_limits.n + 1 END,
        reset_at = CASE WHEN rate_limits.reset_at < ? THEN ? ELSE rate_limits.reset_at END RETURNING n`, key, t + windowMs, t, t, t + windowMs);
    return r.n <= max;
  } catch (e) { console.error('Rate limiter error (request allowed):', e.message); return true; }
}
const limiter = (name, max, windowMs, msg) => async (req, res, next) => ((await hit(`${name}:${req.ip}`, max, windowMs)) ? next() : next(new HttpError(429, msg || 'Too many requests. Please wait a few minutes and try again.')));

module.exports = { hashPassword, checkPassword, burn, publicUser, parseCookies, startSession, endSession, dropUserSessions, loadUser, requireUser, requireAdmin, limiter, hit, sha, COOKIE };
