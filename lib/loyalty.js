'use strict';
// VELTO REWARDS: points are earned when an order is delivered and paid, reversed when it is refunded, and every change is an immutable ledger row.
// One award per order and one reversal per order are guaranteed by unique idempotency keys, so points can never be given twice.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const { fail, str, int } = S;

const KEYS = ['loyalty_enabled', 'loyalty_points_per_1000', 'loyalty_include_delivery', 'loyalty_redeem_points', 'loyalty_redeem_value', 'loyalty_min_redeem', 'loyalty_wallet_redeem', 'loyalty_start'];
// Read straight from the table (not the shared cache) so an administrator's change applies at once.
async function config() {
  const m = Object.fromEntries((await all('SELECT key, value FROM settings WHERE key = ANY(?)', KEYS)).map((r) => [r.key, r.value]));
  const n = (k, d) => { const v = Number(m[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
  return { enabled: m.loyalty_enabled !== '0', perThousand: n('loyalty_points_per_1000', 10), includeDelivery: m.loyalty_include_delivery === '1', redeemPoints: n('loyalty_redeem_points', 1000) || 1000, redeemValue: n('loyalty_redeem_value', 100), minRedeem: n('loyalty_min_redeem', 1000), walletRedeem: m.loyalty_wallet_redeem === '1', start: n('loyalty_start', 0) };
}
const tiers = () => all('SELECT * FROM loyalty_tiers ORDER BY min_lifetime');
const tierFor = (list, lifetime) => list.reduce((t, x) => (Number(lifetime) >= Number(x.min_lifetime) ? x : t), list[0]);
const newCode = () => crypto.randomBytes(5).toString('hex').toUpperCase();

async function ensureAccount(userId) {
  let a = await get('SELECT * FROM loyalty_accounts WHERE user_id=?', userId);
  if (!a) {
    const u = await get('SELECT id, role FROM users WHERE id=?', userId);
    if (!u || u.role !== 'customer') return null;
    await run('INSERT INTO loyalty_accounts (user_id, created) VALUES (?,?) ON CONFLICT DO NOTHING', userId, now());
    a = await get('SELECT * FROM loyalty_accounts WHERE user_id=?', userId);
  }
  if (!a.referral_code) {
    for (let i = 0; i < 5 && !a.referral_code; i++) { try { await run('UPDATE loyalty_accounts SET referral_code=? WHERE user_id=? AND referral_code IS NULL', newCode(), userId); } catch (e) { if (e.code !== '23505') throw e; } a = await get('SELECT * FROM loyalty_accounts WHERE user_id=?', userId); }
  }
  return a;
}

// The one way points move. Same idemKey twice does nothing the second time.
async function post({ userId, kind, points, idemKey, orderRef = '', note = '', actor = '', countLifetime = null }) {
  return tx(async () => {
    const acc = await ensureAccount(userId); if (!acc) fail(400, 'This account is not in the rewards programme.');
    const a = await get('SELECT * FROM loyalty_accounts WHERE user_id=? FOR UPDATE', userId);   // the lock makes twin requests take turns
    const prior = await get('SELECT * FROM loyalty_ledger WHERE idem_key=?', idemKey);
    if (prior) return { entry: prior, replayed: true };
    const p = Number(points);
    if (!Number.isSafeInteger(p) || (p === 0 && kind !== 'reverse')) fail(400, 'Enter a valid number of points.');
    if (a.points + p < 0) fail(402, 'Not enough points.');
    const bal = Number(a.points) + p, life = Number(a.lifetime) + (countLifetime === null ? (p > 0 && (kind === 'earn' || kind === 'bonus') ? p : 0) : countLifetime);
    const entry = await get('INSERT INTO loyalty_ledger (user_id,kind,points,balance_after,order_ref,idem_key,note,actor,created) VALUES (?,?,?,?,?,?,?,?,?) RETURNING *', userId, kind, p, bal, str(orderRef, 40), idemKey, str(note, 300), str(actor, 80), now());
    const list = await tiers(), before = a.tier, after = tierFor(list, Math.max(0, life)).name;
    // Tiers go up as lifetime points grow. A reversal can lower lifetime points; the tier only drops when it falls below the tier's own threshold.
    await run('UPDATE loyalty_accounts SET points=?, lifetime=?, redeemed=redeemed+?, tier=? WHERE user_id=?', bal, Math.max(0, life), kind === 'redeem' ? -p : 0, after, userId);
    return { entry, replayed: false, tierChanged: before !== after ? after : null };
  });
}

// Points for one delivered order: net goods value (after discounts, no delivery unless switched on), times the tier's rate.
async function awardOrder(o, cfg, list) {
  const base = Math.max(0, o.subtotal - o.discount + (cfg.includeDelivery ? o.delivery_fee : 0));
  const acc = await ensureAccount(o.user_id); if (!acc) return null;
  const tier = tierFor(list, acc.lifetime);
  const points = Math.floor((Math.floor((base * cfg.perThousand) / 1000) * tier.multiplier_pct) / 100);
  if (points <= 0) return null;
  const r = await post({ userId: o.user_id, kind: 'earn', points, idemKey: 'earn:' + o.ref, orderRef: o.ref, note: `Order ${o.ref} (${tier.name} rate)` });
  if (!r.replayed) {
    const N = require('./notify');
    N.notify([o.user_id], { type: 'loyalty', title: `You earned ${points} VELTO points`, body: `For order ${o.ref}.`, link: '/account' }).catch(() => {});
    if (r.tierChanged) N.notify([o.user_id], { type: 'loyalty', title: `Welcome to ${r.tierChanged}!`, body: 'You have moved up a VELTO Rewards tier.', link: '/account' }).catch(() => {});
  }
  return r;
}
// Reverse the points of an order that was refunded (once). Only what is still available can be taken back; the rest is recorded in the note.
async function reverseOrder(o) {
  const earn = await get('SELECT * FROM loyalty_ledger WHERE idem_key=?', 'earn:' + o.ref);
  if (!earn) return null;
  const a = await ensureAccount(o.user_id), take = Math.min(Number(earn.points), Number(a.points));
  return post({ userId: o.user_id, kind: 'reverse', points: -take, idemKey: 'reverse:' + o.ref, orderRef: o.ref, note: `Order ${o.ref} refunded` + (take < earn.points ? ` (${earn.points - take} points already spent)` : ''), countLifetime: -Number(earn.points) });
}

// Finds delivered+paid orders that have not earned yet, and refunded orders that have not been reversed. Safe to run any time, by any instance.
async function sweep(userId = 0) {
  const cfg = await config(); if (!cfg.enabled) return { awarded: 0, reversed: 0 };
  const list = await tiers(), who = userId ? 'AND o.user_id=?' : '', args = userId ? [userId] : [];
  const due = await all(`SELECT o.* FROM orders o WHERE o.user_id IS NOT NULL ${who} AND o.status='delivered' AND o.payment_status='paid'
      AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id=o.id AND e.status='delivered' AND e.created>=?)
      AND NOT EXISTS (SELECT 1 FROM loyalty_ledger l WHERE l.idem_key='earn:'||o.ref) ORDER BY o.id LIMIT 200`, ...args, cfg.start);
  let awarded = 0, reversed = 0;
  for (const o of due) { const r = await awardOrder(o, cfg, list).catch((e) => { console.error('Loyalty award failed', o.ref, e.message); return null; }); if (r && !r.replayed) awarded++; }
  const refunded = await all(`SELECT o.* FROM orders o JOIN loyalty_ledger l ON l.idem_key='earn:'||o.ref WHERE o.status='refunded' ${who} AND NOT EXISTS (SELECT 1 FROM loyalty_ledger r WHERE r.idem_key='reverse:'||o.ref) LIMIT 200`, ...args);
  for (const o of refunded) { const r = await reverseOrder(o).catch((e) => { console.error('Loyalty reversal failed', o.ref, e.message); return null; }); if (r && !r.replayed) reversed++; }
  return { awarded, reversed };
}

/* ---------- what the customer sees ---------- */
async function overview(user) {
  await sweep(user.id).catch(() => {});
  const a = await ensureAccount(user.id); if (!a) fail(404, 'No rewards account for this account.');
  const cfg = await config(), list = await tiers(), cur = tierFor(list, a.lifetime), next = list.find((t) => Number(t.min_lifetime) > Number(a.lifetime));
  const pend = await get(`SELECT COALESCE(SUM(subtotal-discount),0) base FROM orders WHERE user_id=? AND payment_status='paid' AND status IN ('paid','confirmed','processing','shipped') AND NOT EXISTS (SELECT 1 FROM loyalty_ledger l WHERE l.idem_key='earn:'||orders.ref)`, user.id);
  return {
    points: Number(a.points), lifetime_points: Number(a.lifetime), points_redeemed: Number(a.redeemed),
    pending_points: Math.floor((Number(pend.base) * cfg.perThousand) / 1000), expiring_points: 0,
    tier: { name: cur.name, earning_multiplier: cur.multiplier_pct / 100, benefits: cur.benefits },
    next_tier: next ? { name: next.name, points_needed: Number(next.min_lifetime) - Number(a.lifetime), at: Number(next.min_lifetime) } : null,
    redemption: { points: cfg.redeemPoints, value: cfg.redeemValue, minimum: cfg.minRedeem, to_wallet: cfg.walletRedeem, available_value: Math.floor(Number(a.points) / cfg.redeemPoints) * cfg.redeemValue },
    earning: { points_per_1000: cfg.perThousand }, referral_code: a.referral_code,
    tiers: list.map((t) => ({ name: t.name, from: Number(t.min_lifetime), earning_multiplier: t.multiplier_pct / 100, benefits: t.benefits })),
  };
}
async function history(user, q = {}) {
  const lim = Math.min(100, Math.max(1, int(q.limit, 30))), before = int(q.before, 0);
  const rows = await all(`SELECT id,kind,points,balance_after,order_ref,note,created FROM loyalty_ledger WHERE user_id=? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ${lim + 1}`, user.id, ...(before ? [before] : []));
  return { entries: rows.slice(0, lim).map((r) => ({ id: Number(r.id), kind: r.kind, points: Number(r.points), balance_after: Number(r.balance_after), order_ref: r.order_ref, note: r.note, created: Number(r.created) })), more: rows.length > lim };
}
// Turn points into wallet credit. Off unless an administrator switches it on. The points debit and the wallet credit happen in one transaction.
async function redeemToWallet(user, body, key) {
  const cfg = await config();
  if (!cfg.enabled) fail(503, 'Rewards are switched off right now.');
  if (!cfg.walletRedeem) fail(400, 'Turning points into wallet credit is not available.');
  const points = int(body && body.points);
  if (!points || points < cfg.minRedeem || points % cfg.redeemPoints !== 0) fail(400, `Redeem at least ${cfg.minRedeem} points, in steps of ${cfg.redeemPoints}.`);
  const value = (points / cfg.redeemPoints) * cfg.redeemValue, idem = key && /^[A-Za-z0-9_-]{8,80}$/.test(key) ? 'redeem:' + user.id + ':' + key : 'redeem:' + user.id + ':' + crypto.randomUUID();
  return tx(async () => {
    const r = await post({ userId: user.id, kind: 'redeem', points: -points, idemKey: idem, note: `Redeemed for ₦${value} wallet credit`, countLifetime: 0 });
    if (!r.replayed) await require('./wallet').post({ userId: user.id, type: 'reward', amount: value * 100, idemKey: 'reward:' + idem, description: `VELTO points redeemed (${points} points)` });
    return { redeemed_points: points, wallet_credit: value, points: Number((await get('SELECT points FROM loyalty_accounts WHERE user_id=?', user.id)).points), replayed: r.replayed };
  });
}

/* ---------- administrator ---------- */
async function adminAdjust(userId, b, actor) {
  const points = int(b && b.points), reason = str(b && b.reason, 300), ref = str(b && b.reference, 60);
  if (!points || !reason || !ref) fail(400, 'An adjustment needs points, a reason and a reference.');
  return post({ userId, kind: 'adjust', points, idemKey: 'adj:' + userId + ':' + ref, note: reason, actor: actor.name || actor.email, countLifetime: 0 });
}
async function setConfig(b) {
  const allowed = { loyalty_enabled: (v) => (v ? '1' : '0'), loyalty_include_delivery: (v) => (v ? '1' : '0'), loyalty_wallet_redeem: (v) => (v ? '1' : '0'), loyalty_points_per_1000: (v) => String(Math.max(0, int(v))), loyalty_redeem_points: (v) => String(Math.max(1, int(v))), loyalty_redeem_value: (v) => String(Math.max(0, int(v))), loyalty_min_redeem: (v) => String(Math.max(0, int(v))) };
  for (const [k, f] of Object.entries(allowed)) if (b && b[k] !== undefined) await run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value', k, f(b[k]));
  return config();
}
async function setTier(name, b) {
  const n = str(name, 30); if (!n) fail(400, 'Tier name?');
  await run(`INSERT INTO loyalty_tiers (name,min_lifetime,multiplier_pct,discount_pct,benefits,sort) VALUES (?,?,?,?,?,0)
    ON CONFLICT (name) DO UPDATE SET min_lifetime=excluded.min_lifetime, multiplier_pct=excluded.multiplier_pct, discount_pct=excluded.discount_pct, benefits=excluded.benefits`, n, Math.max(0, int(b.min_lifetime)), Math.max(0, int(b.multiplier_pct, 100)), Math.min(100, Math.max(0, int(b.discount_pct))), str(b.benefits, 200));
  return tiers();
}
async function report() {
  const t = await get("SELECT COALESCE(SUM(points),0) outstanding, COALESCE(SUM(redeemed),0) redeemed, COUNT(*) members FROM loyalty_accounts");
  const dist = await all('SELECT tier, COUNT(*) n FROM loyalty_accounts GROUP BY tier ORDER BY n DESC');
  const cfg = await config();
  return { members: Number(t.members), points_outstanding: Number(t.outstanding), points_redeemed: Number(t.redeemed), liability_value: Math.floor(Number(t.outstanding) / cfg.redeemPoints) * cfg.redeemValue, tier_distribution: dist.map((d) => ({ tier: d.tier, members: Number(d.n) })) };
}
module.exports = { config, ensureAccount, post, sweep, overview, history, redeemToWallet, adminAdjust, setConfig, setTier, report, awardOrder, reverseOrder };
