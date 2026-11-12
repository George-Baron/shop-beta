'use strict';
// The first administrator comes from the environment, never from a default password.
//   ADMIN_EMAIL + ADMIN_PASSWORD (12+ characters): the account is created on start if no administrator exists yet.
//   ADMIN_SETUP_CODE: lets the first administrator be created from the /admin page instead, by someone who knows the code.
// In production the server will not start with no administrator and no way to create one.
const log = require('./log');
const crypto = require('crypto');
const { get, insert, now } = require('./db');
const { hashPassword } = require('./auth');
const { isEmail } = require('./shop');

const MIN_ADMIN_PASSWORD = 12;
const production = () => process.env.NODE_ENV === 'production';

function setupCodeOk(given) {
  const want = String(process.env.ADMIN_SETUP_CODE || '');
  if (want.length < 8 || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}
const setupEnabled = () => String(process.env.ADMIN_SETUP_CODE || '').length >= 8;

async function ensureAdmin() {
  if (await get("SELECT 1 x FROM users WHERE role='admin'")) return 'exists';
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
  if (!email && !pw) {
    if (setupEnabled()) return 'setup-code';
    if (production()) throw new Error('There is no administrator account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) in the environment, or ADMIN_SETUP_CODE (at least 8 characters) to create it from the /admin page, then start again.');
    return 'open-dev'; // local development only: nothing is configured and nothing is reachable from outside
  }
  if (!isEmail(email)) throw new Error('ADMIN_EMAIL is not a valid email address.');
  if (pw.length < MIN_ADMIN_PASSWORD || pw.length > 200) throw new Error(`ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD} characters.`);
  if (await get('SELECT 1 x FROM users WHERE lower(email)=?', email)) throw new Error('ADMIN_EMAIL is already used by a customer account. Use a different email for the administrator.');
  await insert("INSERT INTO users (name,email,phone,password,role,created) VALUES ('Store owner',?,'',?, 'admin', ?)", email, await hashPassword(pw), now());
  log.log(`Administrator account created for ${email}. You can remove ADMIN_PASSWORD from the environment now.`);
  return 'created';
}
module.exports = { ensureAdmin, setupCodeOk, setupEnabled, MIN_ADMIN_PASSWORD };
