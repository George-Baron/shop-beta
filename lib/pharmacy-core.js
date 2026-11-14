'use strict';
// The small, dependency-light part of the pharmacy module: the on/off switch, "which products may customers see", encryption, audit log,
// and the hooks the order code calls. The full rules (prescriptions, identity, queue) are in lib/pharmacy.js.
const crypto = require('crypto');
const { get, all, run, now } = require('./db');

// PHARMACY_ENABLED=1 switches the pharmacy department on. Default: off. Read on every call so a restart is all that is needed to change it.
const enabled = () => process.env.PHARMACY_ENABLED === '1';
const PHARMACY_STORE = 'pharmacy';

// SQL condition for "this product may be shown and sold". Used everywhere customers can see or buy a product.
//   Switch OFF: nothing from the pharmacy department and nothing marked as a medicine is ever visible.
//   Switch ON : such a product is visible only when our superintendent pharmacist approved it, its batch has not expired, and its partner
//               pharmacy is approved with a licence that has not run out (so listings hide themselves when a licence expires).
function visibleSql(a = 'p') {
  if (!enabled()) return `${a}.is_pharmacy = 0`;
  return `(${a}.is_pharmacy = 0 OR (${a}.pharm_status = 'approved'
    AND (${a}.expiry_date = '' OR ${a}.expiry_date >= to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD'))
    AND EXISTS (SELECT 1 FROM pharmacies ph WHERE ph.partner_id = ${a}.partner_id AND ph.status = 'approved' AND ph.licence_expires >= extract(epoch from now())::bigint)))`;
}
const storeHidden = (slug) => !enabled() && slug === PHARMACY_STORE;
// SQL fragment: hide the pharmacy department row from store lists while the flag is off
const storeVisibleSql = (a='s') => enabled() ? '1=1' : `${a}.slug <> '${PHARMACY_STORE}'`;

/* ---------- encryption of identity numbers, patient details and prescription files ---------- */
let warned = false;
function keys() {
  let secret = process.env.PHARMACY_DATA_KEY || '';
  if (secret.length < 24) {
    if (process.env.NODE_ENV === 'production') throw new Error('PHARMACY_DATA_KEY (at least 24 characters) is required when pharmacy features are used.');
    secret = 'development-only-pharmacy-key-do-not-use'; if (!warned) { warned = true; console.warn('PHARMACY_DATA_KEY is not set: using a development key.'); }
  }
  return { enc: crypto.scryptSync(secret, 'shop-beta-pharmacy-enc-v1', 32), mac: crypto.scryptSync(secret, 'shop-beta-pharmacy-mac-v1', 32) };
}
function encryptBuf(buf) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keys().enc, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]); return Buffer.concat([Buffer.from('PX1'), iv, c.getAuthTag(), ct]);
}
function decryptBuf(buf) {
  if (buf.length < 31 || buf.subarray(0, 3).toString() !== 'PX1') throw new Error('Not an encrypted record.');
  const d = crypto.createDecipheriv('aes-256-gcm', keys().enc, buf.subarray(3, 15)); d.setAuthTag(buf.subarray(15, 31));
  try { return Buffer.concat([d.update(buf.subarray(31)), d.final()]); } catch { throw new Error('Could not decrypt this record (wrong PHARMACY_DATA_KEY, or it was changed).'); }
}
const encryptText = (s) => encryptBuf(Buffer.from(String(s), 'utf8')).toString('base64');
const decryptText = (b64) => (b64 ? decryptBuf(Buffer.from(b64, 'base64')).toString('utf8') : '');
const mac = (text) => crypto.createHmac('sha256', keys().mac).update(String(text)).digest('hex');

/* ---------- audit log: every time someone looks at a sensitive record ---------- */
async function audit(user, ip, action, entity, entityId, detail = '') {
  await run('INSERT INTO pharmacy_audit (user_id,user_name,role,action,entity,entity_id,detail,ip,created) VALUES (?,?,?,?,?,?,?,?,?)',
    user ? user.id : null, user ? String(user.name || user.email || '').slice(0, 80) : '', user ? user.role : '', action, entity, String(entityId || ''), String(detail).slice(0, 300), String(ip || '').slice(0, 60), now());
}

/* ---------- prescription fills follow the order ---------- */
// Approval reserves one fill of each prescription used; delivery uses it; cancelling gives it back. So one prescription cannot be filled twice at once.
async function prescriptionsOf(orderId) {
  return all('SELECT DISTINCT pl.prescription_id id FROM order_items oi JOIN prescription_lines pl ON pl.id = oi.rx_line_id WHERE oi.order_id=?', orderId);
}
async function releaseFill(orderId) {
  const o = await get('SELECT rx_fill_reserved FROM orders WHERE id=?', orderId);
  if (!o || !o.rx_fill_reserved) return;
  for (const r of await prescriptionsOf(orderId)) await run('UPDATE prescriptions SET fills_reserved = GREATEST(0, fills_reserved - 1), updated=? WHERE id=?', now(), r.id);
  await run('UPDATE orders SET rx_fill_reserved=0 WHERE id=?', orderId);
}
async function consumeFill(orderId) {
  const o = await get('SELECT rx_fill_reserved FROM orders WHERE id=?', orderId);
  if (!o || !o.rx_fill_reserved) return;
  for (const r of await prescriptionsOf(orderId)) await run('UPDATE prescriptions SET fills_reserved = GREATEST(0, fills_reserved - 1), fills_used = fills_used + 1, last_filled_at=?, updated=? WHERE id=?', now(), now(), r.id);
  await run('UPDATE orders SET rx_fill_reserved=0 WHERE id=?', orderId);
}

/* ---------- small helpers ---------- */
// Nigerian mobile numbers to +234 form. Returns '' when it does not look like one.
function normalizePhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (/^0\d{10}$/.test(d)) return '234' + d.slice(1);
  if (/^234\d{10}$/.test(d)) return d;
  return '';
}
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
// The rider asks the person at the door for their name. It must match the buyer's name: every word of the shorter name appears in the other.
function nameMatches(given, expected) {
  const a = tokens(given), b = tokens(expected); if (!a.length || !b.length) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.every((t) => l.includes(t));
}

module.exports = { enabled, PHARMACY_STORE, visibleSql, storeHidden, storeVisibleSql, encryptBuf, decryptBuf, encryptText, decryptText, mac, audit, releaseFill, consumeFill, normalizePhone, nameMatches };
