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

/* ---- rate limiting (in memory, per process) ---- */
const buckets = new Map();
function hit(key, max, windowMs) {
  const t = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
const LIMIT_X = Number(process.env.RATE_LIMIT_MULTIPLIER) || 1; // tests raise it; leave unset in production
const limiter = (name, max, windowMs, msg) => (req, res, next) => (hit(`${name}:${req.ip}`, max * LIMIT_X, windowMs) ? next() : next(new HttpError(429, msg || 'Too many requests. Please wait a few minutes and try again.')));
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

module.exports = { hashPassword, checkPassword, burn, publicUser, parseCookies, startSession, endSession, dropUserSessions, loadUser, requireUser, requireAdmin, requireRider, limiter, hit, sha, COOKIE };
