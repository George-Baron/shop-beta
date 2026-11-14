'use strict';
// Passwords (scrypt), cookie sessions, rate limiting. No third-party packages.
const log = require('./log');
const crypto = require('crypto');
const { get, run, now } = require('./db');
const { HttpError } = require('./shop');

const SESSION_DAYS = 30, ADMIN_SESSION_HOURS = 12;
// On https the cookie is "__Host-sb_sid": the browser then guarantees it is Secure, has no Domain and cannot be planted by a sibling subdomain.
const isSecure = (req) => !!req.secure || String(process.env.BASE_URL || '').startsWith('https://');
const cookieName = (req) => (isSecure(req) ? '__Host-sb_sid' : 'sb_sid');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Password hashing: scrypt with N=65536, r=8, p=2 (about 64 MB and 100+ ms per hash; above the OWASP minimum).
// Stored as scrypt$N$r$p$salt$hash so the cost can be raised later. Older hashes (N=16384) still work and are upgraded when the user signs in.
const COST = { N: 65536, r: 8, p: 2 };
let hashing = 0; const waiting = [];
async function slot() { // at most 2 hashes at once: a burst of sign-ins queues instead of using all the memory
  if (hashing >= 2) await new Promise((r) => waiting.push(r)); hashing++;
}
const release = () => { hashing--; const next = waiting.shift(); if (next) next(); };
async function scrypt(password, salt, c) {
  await slot();
  try { return await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: c.N, r: c.r, p: c.p, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k)))); }
  finally { release(); }
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('hex')}$${(await scrypt(pw, salt, COST)).toString('hex')}`;
}
function parseHash(stored) {
  const parts = String(stored).split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts.length === 3) return { c: { N: 16384, r: 8, p: 1 }, salt: parts[1], hash: parts[2], legacy: true }; // pre-rebuild format
  if (parts.length === 6) { const c = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) }; if (c.N > 0 && c.N <= 1 << 17 && c.r === 8 && c.p >= 1 && c.p <= 4) return { c, salt: parts[4], hash: parts[5] }; }
  return null;
}
async function checkPassword(pw, stored) {
  const p = parseHash(stored); if (!p || !p.salt || !p.hash) return false;
  const k = await scrypt(pw, Buffer.from(p.salt, 'hex'), p.c);
  const h = Buffer.from(p.hash, 'hex');
  return k.length === h.length && crypto.timingSafeEqual(k, h);
}
const needsRehash = (stored) => { const p = parseHash(stored); return !p || p.c.N < COST.N || p.c.p < COST.p; };
// Used to spend the same time when an email does not exist, so login does not reveal which emails are registered.
const DUMMY = `scrypt$${COST.N}$${COST.r}$${COST.p}$` + '00'.repeat(16) + '$' + '00'.repeat(64);
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
  const u = await get('SELECT role FROM users WHERE id=?', userId);
  const seconds = u && (u.role === 'admin' || u.role === 'rider') ? ADMIN_SESSION_HOURS * 3600 : SESSION_DAYS * 86400; // staff sign in again every 12 hours
  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions (id,user_id,expires) VALUES (?,?,?)', sha(token), userId, now() + seconds);
  res.append('Set-Cookie', `${cookieName(req)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${isSecure(req) ? '; Secure' : ''}`);
}
async function endSession(req, res) {
  const t = parseCookies(req.headers.cookie)[cookieName(req)];
  if (t) await run('DELETE FROM sessions WHERE id=?', sha(t));
  res.append('Set-Cookie', `${cookieName(req)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? '; Secure' : ''}`);
}
async function dropUserSessions(userId, exceptToken) {
  if (exceptToken) await run('DELETE FROM sessions WHERE user_id=? AND id<>?', userId, sha(exceptToken));
  else await run('DELETE FROM sessions WHERE user_id=?', userId);
}

async function loadUser(req, res, next) {
  const t = parseCookies(req.headers.cookie)[cookieName(req)];
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
const requireRider = (req, res, next) => (req.user && req.user.role === 'rider' ? next() : next(new HttpError(401, 'Please sign in as a rider.')));
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : next(new HttpError(401, 'Please sign in as an administrator.')));

/* ---- rate limiting, shared by every instance through the database ---- */
// One row per key, counted in a fixed window. A single atomic statement, so two instances cannot both
// let the last request through. If the database fails we let the request through (and log): shoppers must
// not be blocked by the limiter itself.
async function hit(key, max, windowMs) {
  if (process.env.RATE_LIMITS === 'off' && process.env.NODE_ENV !== 'production') return true; // tests only; ignored in production
  const t = Date.now();
  try {
    const r = await get(`INSERT INTO rate_limits (key, n, reset_at) VALUES (?, 1, ?)
      ON CONFLICT (key) DO UPDATE SET n = CASE WHEN rate_limits.reset_at < ? THEN 1 ELSE rate_limits.n + 1 END,
        reset_at = CASE WHEN rate_limits.reset_at < ? THEN ? ELSE rate_limits.reset_at END RETURNING n`, key, t + windowMs, t, t, t + windowMs);
    return r.n <= max;
  } catch (e) { log.error('Rate limiter error (request allowed):', e.message); return true; }
}
const num = (name, d) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : d);
const tooMany = (msg) => new HttpError(429, msg || 'Too many requests. Please wait a few minutes and try again.');

// Mobile networks put thousands of people behind one IP address, so the real limit is per person (email or phone number).
// The per-IP ceiling is only a loose safety net against one machine hammering the site. Ceiling can be changed with RATE_IP_<NAME>.
const emailKey = (v) => { const s = String(v || '').trim().toLowerCase().slice(0, 120); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ''; };
const phoneKey = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }; // 0803... and +234803... are the same person
const textKey = (v, n = 40) => String(v || '').trim().toLowerCase().slice(0, n).replace(/[^a-z0-9_.-]/g, '');
function limitBy(name, { ids, max, windowMs, ipMax, msg }) {
  const ceiling = num('RATE_IP_' + name.toUpperCase(), ipMax);
  return async (req, res, next) => {
    try {
      for (const id of [...new Set((ids ? ids(req) : []).filter(Boolean))]) if (!(await hit(`${name}:${id}`, max, windowMs))) return next(tooMany(msg));
      if (!(await hit(`${name}-ip:${req.ip}`, ceiling, windowMs))) return next(tooMany(msg));
      next();
    } catch (e) { next(e); }
  };
}
// Old-style per-IP limit; only for routes with no person to key on.
const limiter = (name, max, windowMs, msg) => limitBy(name, { max, windowMs, ipMax: max, msg });

module.exports = { requireRider, hashPassword, checkPassword, needsRehash, emailKey, phoneKey, textKey, limitBy, isSecure, cookieName, burn, publicUser, parseCookies, startSession, endSession, dropUserSessions, loadUser, requireUser, requireAdmin, limiter, hit, sha };
