'use strict';
// Sign-in for the VELTO-MART mobile apps.
//   access token  : random, 15 minutes, sent as "Authorization: Bearer ..."; only its hash is stored, so revoking a device works at once
//   refresh token : random, 60 days, rotated on every use; replaying an old one after the short grace window revokes the whole device session
// Website cookie sessions (lib/auth.js) are untouched. Bearer tokens are read ONLY inside /api/mobile/v1, and only customers can have them.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const A = require('./auth');

const ACCESS_TTL = 15 * 60, REFRESH_TTL = 60 * 86400, GRACE = 60, MAX_SESSIONS = 10, DELETE_WAIT_DAYS = Number(process.env.ACCOUNT_DELETE_WAIT_DAYS) || 14;
const sha = A.sha;
const token = (prefix) => prefix + crypto.randomBytes(32).toString('base64url');
const ACCESS_RE = /^at_[A-Za-z0-9_-]{43}$/, REFRESH_RE = /^rt_[A-Za-z0-9_-]{43}$/;

// An error with a machine-readable code, so the app can decide what to do (refresh, sign in again, show a message).
function fail(status, code, message) { const e = new S.HttpError(status, message); e.code = code; throw e; }

function cleanDevice(d) {
  d = d && typeof d === 'object' ? d : {};
  const id = S.str(d.id, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) fail(400, 'invalid_device', 'The app did not identify this device. Please update the app and try again.');
  return { id, name: S.str(d.name, 60), platform: ['ios', 'android'].includes(d.platform) ? d.platform : 'other', appVersion: S.str(d.appVersion, 20) };
}

// Creates a signed-in device session and returns the tokens (the only time they are ever shown).
async function issue(user, device, req) {
  const dev = cleanDevice(device), access = token('at_'), refresh = token('rt_'), t = now();
  await tx(async () => {
    await run("UPDATE mobile_sessions SET revoked_at=?, revoke_reason='replaced' WHERE user_id=? AND device_id=? AND revoked_at IS NULL", t, user.id, dev.id);
    const open = await all('SELECT id FROM mobile_sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY last_used DESC, id DESC', user.id);
    for (const s of open.slice(MAX_SESSIONS - 1)) await run("UPDATE mobile_sessions SET revoked_at=?, revoke_reason='too_many_devices' WHERE id=?", t, s.id);
    await run('INSERT INTO mobile_sessions (user_id,device_id,device_name,platform,app_version,access_hash,access_expires,refresh_hash,refresh_expires,created,last_used,ip) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      user.id, dev.id, dev.name, dev.platform, dev.appVersion, sha(access), t + ACCESS_TTL, sha(refresh), t + REFRESH_TTL, t, t, String(req && req.clientIp || '').slice(0, 64));
  });
  return { accessToken: access, accessExpiresIn: ACCESS_TTL, refreshToken: refresh, refreshExpiresAt: t + REFRESH_TTL };
}

const revoke = (sessionId, reason) => run('UPDATE mobile_sessions SET revoked_at=?, revoke_reason=? WHERE id=? AND revoked_at IS NULL', now(), reason, sessionId);
const revokeAll = (userId, reason, exceptId) => run('UPDATE mobile_sessions SET revoked_at=?, revoke_reason=? WHERE user_id=? AND revoked_at IS NULL AND id<>?', now(), reason, userId, exceptId || 0);

// Trades a refresh token for a new pair. The old refresh token stops working (except for a 60-second grace for a reply that never arrived).
async function refresh(raw, req) {
  if (typeof raw !== 'string' || !REFRESH_RE.test(raw)) fail(401, 'invalid_token', 'Please sign in again.');
  const h = sha(raw), t = now();
  const out = await tx(async () => {
    let s = await get('SELECT * FROM mobile_sessions WHERE refresh_hash=? FOR UPDATE', h), grace = false;
    if (!s) {
      s = await get('SELECT * FROM mobile_sessions WHERE prev_refresh_hash=? FOR UPDATE', h);
      if (!s || s.revoked_at != null) return { err: 'invalid' };
      if (t - Number(s.rotated_at) > GRACE) return { err: 'reuse', id: Number(s.id) };   // an old token used again: someone copied it
      grace = true;
    }
    if (s.revoked_at != null) return { err: 'invalid' };
    if (Number(s.refresh_expires) < t) return { err: 'expired' };
    const u = await get('SELECT * FROM users WHERE id=?', s.user_id);
    if (!u || u.active === 0 || u.role !== 'customer') return { err: 'blocked', id: Number(s.id) };
    const access = token('at_'), next = token('rt_');
    // In the grace case the old token stays the "previous" one and rotated_at is not moved, so the window cannot be stretched.
    await run('UPDATE mobile_sessions SET access_hash=?, access_expires=?, refresh_hash=?, refresh_expires=?, prev_refresh_hash=?, rotated_at=?, last_used=?, ip=? WHERE id=?',
      sha(access), t + ACCESS_TTL, sha(next), t + REFRESH_TTL, grace ? h : s.refresh_hash, grace ? s.rotated_at : t, t, String(req && req.clientIp || '').slice(0, 64), s.id);
    return { user: u, tokens: { accessToken: access, accessExpiresIn: ACCESS_TTL, refreshToken: next, refreshExpiresAt: t + REFRESH_TTL } };
  });
  if (out.err === 'reuse') { await revoke(out.id, 'refresh_reuse'); fail(401, 'session_revoked', 'For your security you have been signed out. Please sign in again.'); }
  if (out.err === 'blocked') { await revoke(out.id, 'account_blocked'); fail(401, 'session_revoked', 'Please sign in again.'); }
  if (out.err === 'expired') fail(401, 'session_expired', 'Your session has expired. Please sign in again.');
  if (out.err) fail(401, 'invalid_token', 'Please sign in again.');
  return out;
}

// Express middleware for protected mobile routes. Cookies are never consulted here.
async function requireAuth(req, res, next) {
  try {
    req.user = undefined; req.mobileSession = undefined;
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    if (!m || !ACCESS_RE.test(m[1])) return fail(401, 'missing_token', 'Please sign in.');
    const r = await get('SELECT s.id AS session_id, s.access_expires, s.last_used, u.* FROM mobile_sessions s JOIN users u ON u.id = s.user_id WHERE s.access_hash=? AND s.revoked_at IS NULL', sha(m[1]));
    if (!r) return fail(401, 'invalid_token', 'Please sign in again.');
    if (Number(r.access_expires) < now()) return fail(401, 'token_expired', 'Your session needs refreshing.');
    if (r.active === 0 || r.role !== 'customer') { await revoke(r.session_id, 'account_blocked'); return fail(401, 'session_revoked', 'Please sign in again.'); }
    if (now() - Number(r.last_used) > 300) await run('UPDATE mobile_sessions SET last_used=? WHERE id=?', now(), r.session_id);   // not on every request
    const { session_id, access_expires, last_used, ...user } = r;
    req.user = user; req.mobileSession = { id: Number(session_id) };
    return next();
  } catch (e) { return next(e); }
}

// Rate limiter keyed by whatever the caller chooses (account, device, address), not only the IP: many customers share one mobile network address.
const limit = (name, max, windowMs, keyOf, message) => async (req, res, next) => {
  try { return (await A.hit(`${name}:${keyOf(req)}`, max, windowMs)) ? next() : fail(429, 'rate_limited', message || 'Too many attempts. Please wait a few minutes and try again.'); } catch (e) { return next(e); }
};

const publicUser = (u) => ({ id: Number(u.id), name: u.name, email: u.email, phone: u.phone, role: 'customer' });

/* ---------- account deletion ---------- */
async function requestDeletion(user, password) {
  if (!(await A.checkPassword(String(password || ''), user.password))) fail(400, 'wrong_password', 'Your password is not correct.');
  const open = await get("SELECT 1 x FROM orders WHERE user_id=? AND status NOT IN ('delivered','cancelled','refunded') LIMIT 1", user.id)
    || await get("SELECT 1 x FROM wholesale_quotes q JOIN wholesale_accounts a ON a.id=q.account_id WHERE a.user_id=? AND q.status IN ('requested','quoted','accepted','paid','shipped') LIMIT 1", user.id);
  if (open) fail(409, 'orders_in_progress', 'You have an order or quotation in progress. Please wait until it is finished or cancelled, then request deletion again.');
  const t = now(), due = t + DELETE_WAIT_DAYS * 86400;
  await tx(async () => {
    await run('INSERT INTO account_deletions (user_id,status,requested_at,scheduled_for) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', user.id, 'pending', t, due);
    await run('UPDATE users SET active=0 WHERE id=?', user.id);
    await run('DELETE FROM sessions WHERE user_id=?', user.id);
    await revokeAll(user.id, 'account_deletion');
  });
  return { scheduled_for: due, wait_days: DELETE_WAIT_DAYS };
}
// Run by the worker. Personal details go; order and payment records stay (they are accounting records), still linked to the now-anonymous account.
async function processDeletions() {
  let n = 0;
  for (const d of await all("SELECT id, user_id FROM account_deletions WHERE status='pending' AND scheduled_for<=? ORDER BY id LIMIT 50", now())) {
    await tx(async () => {
      const u = await get('SELECT id, role FROM users WHERE id=? FOR UPDATE', d.user_id);
      if (u && u.role === 'customer') {
        await run("UPDATE users SET name='Deleted customer', email=?, phone='', password='!', active=0 WHERE id=?", `deleted-${u.id}@deleted.invalid`, u.id);
        for (const sql of ['DELETE FROM addresses WHERE user_id=?', 'DELETE FROM wishlist WHERE user_id=?', 'DELETE FROM notifications WHERE user_id=?', 'DELETE FROM resets WHERE user_id=?', 'DELETE FROM sessions WHERE user_id=?', 'DELETE FROM mobile_sessions WHERE user_id=?']) await run(sql, u.id);
        await run("UPDATE reviews SET name='Deleted customer', user_id=NULL WHERE user_id=?", u.id);
      }
      await run("UPDATE account_deletions SET status='done', done_at=? WHERE id=?", now(), d.id);
    });
    n++;
  }
  return n;
}
const purgeOld = () => run('DELETE FROM mobile_sessions WHERE refresh_expires<? OR revoked_at<?', now(), now() - 30 * 86400);

module.exports = { fail, cleanDevice, issue, refresh, revoke, revokeAll, requireAuth, limit, publicUser, requestDeletion, processDeletions, purgeOld, ACCESS_TTL, REFRESH_TTL, DELETE_WAIT_DAYS };
