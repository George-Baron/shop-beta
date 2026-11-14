'use strict';
// Handover code: a random 6-digit code the customer reads out at the door.
// The code is never stored. The database keeps a random nonce and a keyed hash (HMAC with HANDOVER_SECRET), so a copy of the database
// alone cannot be turned back into codes (a plain hash of 6 digits could be guessed in a second). The server can re-derive the code from
// the nonce to show it to the order's owner on their order page and in the confirmation email. No rider endpoint ever returns it.
const crypto = require('crypto');

const MAX_ATTEMPTS = 5;
const DEV_SECRET = 'dev-only-handover-secret-change-me';
const secret = () => process.env.HANDOVER_SECRET || DEV_SECRET;
const hmac = (label, ref, extra) => crypto.createHmac('sha256', secret()).update(`${label}|${ref}|${extra}`).digest();

function newCode(ref) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const code = codeFor(ref, nonce);
  return { nonce, hash: hashCode(ref, code), code };
}
function codeFor(ref, nonce) { return String(hmac('code', ref, nonce).readUInt32BE(0) % 1000000).padStart(6, '0'); }
function hashCode(ref, code) { return hmac('hash', ref, code).toString('hex'); }
function matches(ref, entered, storedHash) {
  if (!storedHash || !/^\d{6}$/.test(String(entered || '').trim())) return false;
  const a = Buffer.from(hashCode(ref, String(entered).trim()), 'hex'), b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// In production the secret must be set (checked at start-up).
const secretProblem = () => (process.env.NODE_ENV === 'production' && (process.env.HANDOVER_SECRET || '').length < 32 ? 'HANDOVER_SECRET must be set to a random value of at least 32 characters.' : '');

module.exports = { MAX_ATTEMPTS, newCode, codeFor, hashCode, matches, secretProblem };
