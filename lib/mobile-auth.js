'use strict';
// Sign-in for the Android and iOS apps (and any non-browser client). Bearer tokens instead of cookies.
//  - access token: random, valid 1 hour, sent as "Authorization: Bearer <token>"
//  - refresh token: random, valid 30 days, used once: every refresh issues a new pair. Using an old refresh token again means it was copied,
//    so that whole device session is revoked.
// Only SHA-256 hashes are stored. Customers only (staff sign in on the website). Failed sign-ins share the website's lockout counters.
const crypto = require('crypto');
const { get, all, run, now } = require('./db');
const A = require('./auth');
const S = require('./shop');
const { fail, str, int } = S;

const ACCESS_SECONDS = Number(process.env.MOBILE_ACCESS_SECONDS) || 3600, REFRESH_DAYS = Number(process.env.MOBILE_REFRESH_DAYS) || 30, MAX_DEVICES = 10, GRACE_SECONDS = 10;
const token = () => crypto.randomBytes(32).toString('hex');
const pair = () => { const a = token(), r = token(); return { access: a, refresh: r, accessHash: A.sha(a), refreshHash: A.sha(r) }; };
const out = (p, user) => ({ token_type: 'Bearer', access_token: p.access, expires_in: ACCESS_SECONDS, refresh_token: p.refresh, refresh_expires_in: REFRESH_DAYS * 86400, ...(user ? { user: A.publicUser(user) } : {}) });
const deviceInfo = (b) => { const d = (b && b.device) || {}; return [str(d.name, 80), str(d.platform, 12).toLowerCase(), str(d.appVersion || d.app_version, 20)]; };

async function login(req) {
  const b = req.body || {}, email = str(b.email, 120).toLowerCase(), pw = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  const ip = req.clientIp, kIp = 'login-fail-ip:' + ip, kAcc = `login-fail:${email}:${ip}`;
  if ((await A.over(kIp, 40)) || (await A.over(kAcc, 8))) fail(429, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
  const u = await get('SELECT * FROM users WHERE email=?', email);
  const good = u ? await A.checkPassword(pw, u.password) : await A.burn(pw);
  if (!u || !good || u.role !== 'customer') { await A.hit(kIp, 1e9, 900000); await A.hit(kAcc, 1e9, 900000); fail(401, 'That email and password do not match.'); }
  if (u.active === 0) fail(403, 'This account has been switched off. Please contact the store.');
  const p = pair(), t = now(), [name, platform, ver] = deviceInfo(b);
  // keep the newest MAX_DEVICES sign-ins; the oldest are signed out
  const live = await all('SELECT id FROM device_sessions WHERE user_id=? AND revoked_at IS NULL AND refresh_expires>? ORDER BY id DESC', u.id, t);
  for (const old of live.slice(MAX_DEVICES - 1)) await run("UPDATE device_sessions SET revoked_at=?, revoked_reason='too many devices' WHERE id=?", t, old.id);
  await run('INSERT INTO device_sessions (user_id,access_hash,refresh_hash,device_name,platform,app_version,access_expires,refresh_expires,created,last_seen,last_ip) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    u.id, p.accessHash, p.refreshHash, name, platform, ver, t + ACCESS_SECONDS, t + REFRESH_DAYS * 86400, t, t, str(ip, 60));
  return out(p, u);
}

async function refresh(req) {
  const rt = str(req.body && req.body.refresh_token, 80); if (!/^[0-9a-f]{64}$/.test(rt)) fail(401, 'Please sign in again.');
  const h = A.sha(rt), t = now();
  const reused = await get("SELECT id, rotated_at FROM device_sessions WHERE prev_refresh_hash=? AND revoked_at IS NULL", h);
  if (reused) {
    // Two requests carrying the same token within a few seconds is an app retrying (a double tap, a slow network): the loser is refused, the session lives on.
    // The same old token coming back later means a copy exists somewhere: the whole device session is revoked.
    if (t - Number(reused.rotated_at) > GRACE_SECONDS) await run("UPDATE device_sessions SET revoked_at=?, revoked_reason='refresh token reused' WHERE id=?", t, reused.id);
    fail(401, 'Please sign in again.');
  }
  const p = pair();
  // one atomic swap: only the first caller holding this refresh token wins
  const r = await get('UPDATE device_sessions SET access_hash=?, refresh_hash=?, prev_refresh_hash=?, rotated_at=?, access_expires=?, refresh_expires=?, last_seen=?, last_ip=? WHERE refresh_hash=? AND revoked_at IS NULL AND refresh_expires>? RETURNING user_id',
    p.accessHash, p.refreshHash, h, t, t + ACCESS_SECONDS, t + REFRESH_DAYS * 86400, t, str(req.clientIp, 60), h, t);
  if (!r) fail(401, 'Please sign in again.');
  const u = await get('SELECT * FROM users WHERE id=?', r.user_id);
  if (!u || u.active === 0) { await run("UPDATE device_sessions SET revoked_at=?, revoked_reason='account off' WHERE user_id=?", t, r.user_id); fail(401, 'Please sign in again.'); }
  return out(p, u);
}

// Used by A.loadUser for "Authorization: Bearer ...". Returns the user row or null.
async function userForBearer(req) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(String(req.headers.authorization || '')); if (!m) return null;
  const h = A.sha(m[1]), t = now();
  const row = await get('SELECT s.id AS dsid, u.* FROM device_sessions s JOIN users u ON u.id=s.user_id WHERE s.access_hash=? AND s.revoked_at IS NULL AND s.access_expires>? AND u.active<>0', h, t);
  if (!row) return null;
  req.deviceSessionId = Number(row.dsid);
  if (Math.random() < 0.1) run('UPDATE device_sessions SET last_seen=? WHERE id=?', t, row.dsid).catch(() => {}); // cheap "last used" without a write on every call
  const { dsid, ...user } = row; return user;
}
const devices = async (user, currentId) => (await all('SELECT id,device_name,platform,app_version,created,last_seen,last_ip FROM device_sessions WHERE user_id=? AND revoked_at IS NULL AND refresh_expires>? ORDER BY last_seen DESC', user.id, now()))
  .map((d) => ({ id: Number(d.id), device: d.device_name, platform: d.platform, app_version: d.app_version, signed_in: Number(d.created), last_used: Number(d.last_seen), current: Number(d.id) === currentId }));
async function revoke(user, id, reason = 'signed out') { const r = await run('UPDATE device_sessions SET revoked_at=?, revoked_reason=? WHERE id=? AND user_id=? AND revoked_at IS NULL', now(), reason, id, user.id); return r.changes > 0; }
async function revokeAll(userId, reason = 'signed out everywhere') { await run('UPDATE device_sessions SET revoked_at=?, revoked_reason=? WHERE user_id=? AND revoked_at IS NULL', now(), reason, userId); }
const purge = () => run('DELETE FROM device_sessions WHERE refresh_expires<? OR revoked_at<?', now() - 7 * 86400, now() - 30 * 86400);
module.exports = { login, refresh, userForBearer, devices, revoke, revokeAll, purge };
