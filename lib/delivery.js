'use strict';
// Delivery rules: where we can deliver, the fee and promised time, and the handover code.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const geo = require('./geo');
const S_ = require('./shop');

const LAGOS = 3600; // Nigeria is UTC+1 all year
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/* ---------- where, how far, how long, how much ---------- */
const hasPartners = async () => !!(await get('SELECT 1 x FROM partners WHERE active=1'));

// The promised time: preparation + the longest leg, counted from now, or from opening time when we are closed.
function promiseFrom(nowS, etaMin, S) {
  const open = num(S.open_hour, 8), cutoff = num(S.cutoff_hour, 20);
  const local = nowS + LAGOS, dayStart = local - (((local % 86400) + 86400) % 86400), hour = (local - dayStart) / 3600;
  let start = nowS;
  if (hour >= cutoff) start = dayStart + 86400 + open * 3600 - LAGOS;
  else if (hour < open) start = dayStart + open * 3600 - LAGOS;
  return Math.round(start + etaMin * 60);
}

const fail = (reason, message, extra = {}) => ({ ok: false, mapped: true, reason, message, alternatives: ['pickup'], ...extra });

async function quote({ lat, lng, state, items }) {
  if (!(await hasPartners())) return { ok: true, mapped: false }; // delivery mapping not set up: the old state-based fee applies
  lat = Number(lat); lng = Number(lng);
  if (!geo.inNigeria(lat, lng)) return fail('outside_nigeria', 'That pin is outside Nigeria. Please move it to your delivery address.');
  const S = await S_.getSettings();
  // Which partner(s) must we collect from?
  const ids = [...new Set((Array.isArray(items) ? items : []).map((i) => Number(i && i.productId)).filter(Boolean))];
  const prods = ids.length ? await all('SELECT id, partner_id FROM products WHERE id = ANY(?::bigint[])', ids) : [];
  const partners = await all('SELECT * FROM partners WHERE active=1 ORDER BY id');
  const byId = new Map(partners.map((p) => [Number(p.id), p]));
  const mains = partners.filter((p) => p.is_default);
  const nearest = (list) => list.slice().sort((a, b) => geo.haversineKm({ lat, lng }, a) - geo.haversineKm({ lat, lng }, b))[0];
  const needed = new Map();
  for (const pr of prods) {
    let p = pr.partner_id ? byId.get(Number(pr.partner_id)) : null;
    if (!p && pr.partner_id) return fail('partner_closed', 'One of the items is from a partner that is not delivering right now.');
    if (!p) p = nearest(mains.length ? mains : partners);
    needed.set(Number(p.id), p);
  }
  if (!needed.size) { const p = nearest(mains.length ? mains : partners); needed.set(Number(p.id), p); }

  // Rider cover for the state
  const riders = await all("SELECT coverage FROM users WHERE role='rider' AND active=1");
  const st = String(state || '').trim().toLowerCase();
  if (!riders.some((r) => !r.coverage.trim() || r.coverage.toLowerCase().split(',').map((x) => x.trim()).includes(st))) {
    return fail('no_rider', `We do not have a rider covering ${state || 'that area'} yet. You can collect your order from our store instead.`);
  }
  const maxKm = num(S.max_distance_km, 60);
  const legs = [];
  for (const p of needed.values()) {
    const r = await geo.route({ lat: Number(p.lat), lng: Number(p.lng) }, { lat, lng });
    const limit = Math.min(num(p.radius_km, 15), maxKm);
    if (r.km > limit) return fail('out_of_range', `That address is ${r.km} km from ${p.name}. We deliver up to ${limit} km from there. Choose store pickup or a closer address.`, { km: r.km, partner: p.name, limit });
    legs.push({ partnerId: Number(p.id), name: p.name, address: p.address, phone: p.phone, lat: Number(p.lat), lng: Number(p.lng), km: r.km, minutes: r.minutes, line: r.line, approx: r.approx });
  }
  const far = Math.max(...legs.map((l) => l.km)), slow = Math.max(...legs.map((l) => l.minutes));
  const perKm = num(S.per_km_fee, 0), freeKm = num(S.free_km, 0);
  const extraFee = perKm > 0 ? Math.round((perKm * Math.max(0, far - freeKm)) / 10) * 10 : 0;
  const etaMin = Math.round(num(S.prep_minutes, 20) + slow + 10 * (legs.length - 1));
  return { ok: true, mapped: true, legs, km: far, etaMin, promisedAt: promiseFrom(now(), etaMin, S), extraFee, approx: legs.some((l) => l.approx), tooLate: promiseFrom(now(), 0, S) > now() + 60 };
}

/* ---------- handover code ---------- */
// The 6-digit code is HMAC(server secret, order ref + a random nonce kept on the order). The code itself is never stored, so a copy of the
// database alone does not reveal any code, yet the customer can always be shown theirs on the order page.
async function secret() {
  if (process.env.HANDOVER_SECRET) return process.env.HANDOVER_SECRET;
  let r = await get("SELECT value FROM settings WHERE key='handover_secret'");
  if (!r) { await run("INSERT INTO settings (key,value) VALUES ('handover_secret', ?) ON CONFLICT DO NOTHING", crypto.randomBytes(32).toString('hex')); r = await get("SELECT value FROM settings WHERE key='handover_secret'"); }
  return r.value;
}
async function codeFor(order) {
  if (!order.handover_nonce) return '';
  const h = crypto.createHmac('sha256', await secret()).update(order.ref + ':' + order.handover_nonce).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}
const needsCode = (o) => o.delivery !== 'pickup';
// Called when an order becomes paid (online) or confirmed (pay on delivery).
async function issueCode(orderId) { await run("UPDATE orders SET handover_nonce=?, handover_attempts=0, handover_locked=0 WHERE id=? AND handover_nonce='' AND delivery<>'pickup' AND status<>'cancelled'", crypto.randomBytes(12).toString('hex'), orderId); }
// What the customer may see: only while the order can still be delivered.
async function visibleCode(o) { return needsCode(o) && o.handover_nonce && !['cancelled', 'refunded', 'delivered'].includes(o.status) ? codeFor(o) : ''; }

const MAX_ATTEMPTS = 5;
// The rider enters the code at the door. Returns { ok } or { ok:false, message, locked }.
async function completeWithCode(orderId, riderId, code, where, recipientName) {
  const out = await tx(async () => {
    const o = await get('SELECT * FROM orders WHERE id=? FOR UPDATE', orderId);
    if (!o || Number(o.rider_id) !== Number(riderId)) return { ok: false, status: 404, message: 'That order is not assigned to you.' };
    if (o.status !== 'shipped') return { ok: false, status: 409, message: o.status === 'delivered' ? 'This order is already delivered.' : o.status === 'cancelled' ? 'This order was cancelled. Do not hand over the parcel.' : 'Tap "On the way" first.' };
    if (o.is_pharmacy) { const rc = await require('./pharmacy').checkRecipient(o, recipientName); if (!rc.ok) return { ok: false, status: 400, message: rc.message }; o.recipient_name = rc.name; }
    if (o.handover_locked) return { ok: false, status: 423, locked: true, message: 'Too many wrong codes. Call the shop: an admin must unlock this delivery.' };
    const want = await codeFor(o), got = String(code || '').replace(/\D/g, '');
    const same = want && got.length === 6 && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
    if (!same) {
      const attempts = o.handover_attempts + 1, lock = attempts >= MAX_ATTEMPTS ? 1 : 0;
      await run('UPDATE orders SET handover_attempts=?, handover_locked=? WHERE id=?', attempts, lock, o.id);
      await S_.addEvent(o.id, o.status, lock ? `Wrong handover code ${attempts} times. Delivery locked until an admin overrides it.` : `Wrong handover code entered (${attempts} of ${MAX_ATTEMPTS})`);
      return { ok: false, status: lock ? 423 : 400, locked: !!lock, message: lock ? 'Too many wrong codes. This delivery is locked. Call the shop: an admin must unlock it.' : `That code is not right. ${MAX_ATTEMPTS - attempts} ${MAX_ATTEMPTS - attempts === 1 ? 'try' : 'tries'} left.` };
    }
    // The update is conditional on "shipped", so the code can only ever work once.
    const r = await run("UPDATE orders SET status='delivered', delivered_at=?, delivered_lat=?, delivered_lng=?, handover_nonce='', handover_attempts=0, payment_status=CASE WHEN payment_method='pod' THEN 'paid' ELSE payment_status END, cash_collected=CASE WHEN payment_method='pod' THEN total ELSE cash_collected END WHERE id=? AND status='shipped'",
      now(), where && Number.isFinite(where.lat) ? where.lat : null, where && Number.isFinite(where.lng) ? where.lng : null, o.id);
    if (!r.changes) return { ok: false, status: 409, message: 'This order was just changed. Reload.' };
    if (o.is_pharmacy) { await run('UPDATE orders SET recipient_name=? WHERE id=?', o.recipient_name, o.id); await require('./pharmacy-core').consumeFill(o.id); }
    await S_.addEvent(o.id, 'delivered', o.payment_method === 'pod' ? `Delivered. Code confirmed. Cash collected: ${S_.naira(o.total)}` : 'Delivered. Code confirmed by the customer.');
    return { ok: true, order: o };
  });
  if (out.ok) await S_.mailOrderStatus(out.order, 'delivered', '');
  return out;
}

// Admin: finish or unlock a delivery without the code. A written reason is required and goes on the order history.
async function override(orderId, admin, action, reason, cash) {
  reason = String(reason || '').trim();
  if (reason.length < 10) return { ok: false, status: 400, message: 'Please write the reason (at least 10 characters). It is saved on the order.' };
  const who = admin.name || admin.email;
  return tx(async () => {
    const o = await get('SELECT * FROM orders WHERE id=? FOR UPDATE', orderId);
    if (!o) return { ok: false, status: 404, message: 'Order not found.' };
    if (['delivered', 'cancelled', 'refunded'].includes(o.status)) return { ok: false, status: 400, message: `This order is already ${o.status}.` };
    if (action === 'reset') {
      await run("UPDATE orders SET handover_attempts=0, handover_locked=0, handover_nonce=? WHERE id=?", crypto.randomBytes(12).toString('hex'), o.id);
      await S_.addEvent(o.id, o.status, `Handover unlocked and a new code issued by ${who}: ${reason}`);
      return { ok: true };
    }
    if (action !== 'complete') return { ok: false, status: 400, message: 'Unknown action.' };
    if (o.is_pharmacy) return { ok: false, status: 400, message: 'Medicines cannot be marked delivered without the buyer\'s code and name. If they cannot be delivered, cancel the order and arrange the return.' };
    const isPod = o.payment_method === 'pod', got = isPod && cash ? o.total : null;
    await run("UPDATE orders SET status='delivered', delivered_at=?, handover_nonce='', handover_locked=0, payment_status=CASE WHEN ? THEN 'paid' ELSE payment_status END, cash_collected=? WHERE id=?", now(), !!got, got, o.id);
    await S_.addEvent(o.id, 'delivered', `Delivery completed by admin override (${who}): ${reason}${isPod ? (got ? ' Cash collected recorded.' : ' Cash NOT recorded.') : ''}`);
    return { ok: true, order: o };
  });
}

module.exports = { quote, hasPartners, promiseFrom, issueCode, visibleCode, codeFor, completeWithCode, override, needsCode, MAX_ATTEMPTS };
