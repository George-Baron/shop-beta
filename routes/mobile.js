'use strict';
// VELTO-MART mobile API, version 1: /api/mobile/v1
// Same business rules as the website (they call the same lib functions); different sign-in (bearer tokens) and a documented, versioned shape.
// Documentation: docs/MOBILE_API.md. Customers only: staff, rider, partner, supplier and pharmacist accounts cannot sign in here.
const crypto = require('crypto');
const express = require('express');
const { get, all, run, tx, now } = require('../lib/db');
const S = require('../lib/shop');
const A = require('../lib/auth');
const PW = require('../lib/passwords');
const M = require('../lib/mobile-auth');
const { str, isEmail, esc } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ip = (req) => req.clientIp || req.ip;
router.use((req, res, next) => { req.user = undefined; res.set('Cache-Control', 'no-store'); next(); });   // a website cookie never signs anyone in here

/* ================= sign-in ================= */
const bodyDevice = (req) => (req.body && req.body.device && req.body.device.id) || '';
router.post('/auth/register', M.limit('m-register-ip', 30, 3600000, ip), M.limit('m-register-dev', 5, 3600000, bodyDevice), ah(async (req, res) => {
  const b = req.body || {}, name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 30);
  M.cleanDevice(b.device);
  if (!name) M.fail(400, 'invalid_name', 'Please enter your name.');
  if (!isEmail(email)) M.fail(400, 'invalid_email', 'Please enter a valid email address.');
  const bad = PW.check(b.password, { email, name }); if (bad) M.fail(400, 'weak_password', bad);
  // Same answer and same work whether or not the email is taken, so this cannot be used to find out who has an account.
  const hash = await A.hashPassword(b.password);
  const CANT = 'We could not create that account. If you already have one, sign in or use "Forgot password".';
  if (await get('SELECT 1 x FROM users WHERE email=?', email)) M.fail(400, 'cannot_register', CANT);
  let id;
  try { id = Number((await run("INSERT INTO users (name,email,phone,password,role,created) VALUES (?,?,?,?,'customer', ?)", name, email, phone, hash, now())).lastInsertRowid); }
  catch (err) { if (err && err.code === '23505') M.fail(400, 'cannot_register', CANT); throw err; }
  const user = await get('SELECT * FROM users WHERE id=?', id);
  res.json({ user: M.publicUser(user), ...(await M.issue(user, b.device, req)) });
}));

router.post('/auth/login', ah(async (req, res) => {
  const b = req.body || {}, email = str(b.email, 120).toLowerCase(), pw = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  M.cleanDevice(b.device);
  // Only failed attempts count (same counters as the website): a stranger guessing your email can lock out only himself.
  const kIp = 'login-fail-ip:' + ip(req), kAcc = `login-fail:${email}:${ip(req)}`, kDev = 'login-fail-dev:' + b.device.id;
  if ((await A.over(kIp, 40)) || (await A.over(kAcc, 8)) || (await A.over(kDev, 15))) M.fail(429, 'rate_limited', 'Too many sign-in attempts. Please wait 15 minutes and try again.');
  const u = await get('SELECT * FROM users WHERE email=?', email);
  const good = u ? await A.checkPassword(pw, u.password) : await A.burn(pw);
  if (!u || !good) { for (const k of [kIp, kAcc, kDev]) await A.hit(k, 1e9, 900000); M.fail(401, 'bad_credentials', 'That email and password do not match.'); }
  if (u.active === 0) M.fail(403, 'account_off', 'This account has been switched off. Please contact the store.');
  if (u.role !== 'customer') M.fail(403, 'use_website', 'This account cannot be used in the app. Please sign in on the website.');
  res.json({ user: M.publicUser(u), ...(await M.issue(u, b.device, req)) });
}));

router.post('/auth/refresh', M.limit('m-refresh', 60, 600000, (req) => ip(req)), ah(async (req, res) => {
  const r = await M.refresh(req.body && req.body.refreshToken, req);
  res.json({ user: M.publicUser(r.user), ...r.tokens });
}));

router.post('/auth/logout', M.requireAuth, ah(async (req, res) => { await M.revoke(req.mobileSession.id, 'logout'); res.json({ ok: true }); }));

// Same reset email as the website. The link opens the website's "choose a new password" page, which works on any phone.
router.post('/auth/forgot', M.limit('m-forgot-ip', 30, 3600000, ip), M.limit('m-forgot', 4, 3600000, (req) => str(req.body && req.body.email, 120).toLowerCase()), ah(async (req, res) => {
  const email = str(req.body && req.body.email, 120).toLowerCase();
  const u = isEmail(email) ? await get("SELECT * FROM users WHERE email=? AND role='customer' AND active<>0", email) : null;
  if (u) {
    const t = crypto.randomBytes(32).toString('hex');
    await run('DELETE FROM resets WHERE user_id=?', u.id);
    await run('INSERT INTO resets (token,user_id,expires) VALUES (?,?,?)', A.sha(t), u.id, now() + 3600);
    const set = await S.getSettings();
    await S.queueMail(u.email, `Reset your ${set.store_name} password`, S.mailWrap(set, `<p>Hi ${esc(u.name.split(' ')[0])}, use the link below to choose a new password. It works for one hour.</p><p><a href="${S.BASE_URL}/forgot?token=${t}">Choose a new password</a></p><p>If you did not ask for this, you can ignore this email.</p>`));
  }
  res.json({ ok: true });   // the same answer whether or not the email exists
}));
router.post('/auth/reset', M.limit('m-reset', 15, 3600000, ip), ah(async (req, res) => {
  const raw = String(req.body && req.body.token || '');
  const r = /^[0-9a-f]{64}$/.test(raw) ? await get("SELECT r.user_id, u.email, u.name FROM resets r JOIN users u ON u.id=r.user_id WHERE r.token=? AND r.expires>? AND u.role='customer'", A.sha(raw), now()) : null;
  if (!r) M.fail(400, 'reset_expired', 'This reset link has expired. Please ask for a new one.');
  const bad = PW.check(req.body.password, { email: r.email, name: r.name }); if (bad) M.fail(400, 'weak_password', bad);
  await run('UPDATE users SET password=? WHERE id=?', await A.hashPassword(req.body.password), r.user_id);
  await run('DELETE FROM resets WHERE user_id=?', r.user_id);
  await A.dropUserSessions(r.user_id); await M.revokeAll(r.user_id, 'password_reset');
  res.json({ ok: true });   // no automatic sign-in: the customer signs in with the new password
}));

/* ================= profile and devices ================= */
router.get('/me', M.requireAuth, ah(async (req, res) => res.json({ user: M.publicUser(req.user) })));
router.put('/me', M.requireAuth, M.limit('m-me', 30, 3600000, (req) => req.user.id), ah(async (req, res) => {
  const b = req.body || {}, name = str(b.name, 80), phone = str(b.phone, 30);
  if (!name) M.fail(400, 'invalid_name', 'Please enter your name.');
  if (b.newPassword) {
    const bad = PW.check(b.newPassword, { email: req.user.email, name: req.user.name }); if (bad) M.fail(400, 'weak_password', bad);
    if (!(await A.checkPassword(String(b.password || ''), req.user.password))) M.fail(400, 'wrong_password', 'Your current password is not correct.');
    await run('UPDATE users SET password=? WHERE id=?', await A.hashPassword(b.newPassword), req.user.id);
    await A.dropUserSessions(req.user.id); await M.revokeAll(req.user.id, 'password_changed', req.mobileSession.id);   // every other phone and browser is signed out
  }
  await run('UPDATE users SET name=?, phone=? WHERE id=?', name, phone, req.user.id);
  res.json({ user: M.publicUser(await get('SELECT * FROM users WHERE id=?', req.user.id)) });
}));
router.get('/me/devices', M.requireAuth, ah(async (req, res) => {
  const rows = await all('SELECT id, device_name, platform, app_version, created, last_used FROM mobile_sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY last_used DESC', req.user.id);
  res.json({ devices: rows.map((d) => ({ id: Number(d.id), name: d.device_name, platform: d.platform, app_version: d.app_version, created: Number(d.created), last_used: Number(d.last_used), current: Number(d.id) === req.mobileSession.id })) });
}));
router.delete('/me/devices/:id', M.requireAuth, ah(async (req, res) => {
  const r = await run("UPDATE mobile_sessions SET revoked_at=?, revoke_reason='device_removed' WHERE id=? AND user_id=? AND revoked_at IS NULL", now(), S.int(req.params.id), req.user.id);
  if (!r.changes) M.fail(404, 'not_found', 'That device is not signed in.');
  res.json({ ok: true });
}));
router.post('/me/delete-account', M.requireAuth, M.limit('m-delete', 5, 3600000, (req) => req.user.id), ah(async (req, res) => res.json({ ok: true, ...(await M.requestDeletion(req.user, req.body && req.body.password)) })));

router.use(require('./mobile-shop'));   // catalogue, cart, checkout, orders, addresses, wishlist, notifications
router.use('/wholesale', require('./mobile-wholesale'));   // approved wholesale buyers: quotations and payment

/* ================= errors: always { error, code, requestId } ================= */
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  const DEFAULT = { 400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 410: 'gone', 422: 'unprocessable', 429: 'rate_limited', 502: 'upstream_error' };
  if (err instanceof S.HttpError) return res.status(err.status).json({ error: err.message, code: err.code || DEFAULT[err.status] || 'error', requestId: req.id });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request was not understood.', code: 'bad_request', requestId: req.id });
  return next(err);   // anything unexpected goes to the server's own handler, which logs it and answers 500
});
router.use((req, res) => res.status(404).json({ error: 'Not found.', code: 'not_found', requestId: req.id }));

module.exports = router;
