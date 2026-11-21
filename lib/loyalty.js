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

// Campaigns that apply to an order right now (Lagos time) for a customer of this tier.
async function activeCampaigns(list, tierName, at = now()) {
  const rows = await all('SELECT * FROM loyalty_campaigns WHERE active=1 AND starts<=? AND ends>?', at, at);
  const day = new Date((at + 3600) * 1000).getUTCDay(); // Lagos is UTC+1 all year
  const rank = (n) => list.findIndex((t) => t.name === n);
  return rows.filter((c) => (!c.weekdays || c.weekdays.split(',').map(Number).includes(day)) && (!c.min_tier || (rank(c.min_tier) >= 0 && rank(tierName) >= rank(c.min_tier))));
}
// Points for one delivered order: net goods value (after discounts, no delivery unless switched on), times the tier's rate, plus campaign bonuses.
async function awardOrder(o, cfg, list) {
  const base = Math.max(0, o.subtotal - o.discount + (cfg.includeDelivery ? o.delivery_fee : 0));
  const acc = await ensureAccount(o.user_id); if (!acc) return null;
  const tier = tierFor(list, acc.lifetime);
  const basePts = Math.floor((Math.floor((base * cfg.perThousand) / 1000) * tier.multiplier_pct) / 100);
  let extra = 0; const notes = [];
  const camps = await activeCampaigns(list, tier.name, Number((await get("SELECT COALESCE(MAX(created),0) t FROM order_events WHERE order_id=? AND status='delivered'", o.id)).t) || now());
  const best = {}; // the single best multiplier for the whole order and for each category, so campaigns never stack on each other
  for (const c of camps.filter((x) => x.kind === 'multiplier')) { const k = c.category_id || 0; if (!best[k] || c.multiplier_pct > best[k].multiplier_pct) best[k] = c; }
  for (const c of Object.values(best)) {
    let lineBase = base;
    if (c.category_id) lineBase = Number((await get('SELECT COALESCE(SUM(i.price*i.qty),0) n FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=? AND p.category_id=?', o.id, c.category_id)).n);
    const add = Math.floor((Math.floor((lineBase * cfg.perThousand) / 1000) * tier.multiplier_pct * (c.multiplier_pct - 100)) / 10000);
    if (add > 0) { extra += add; notes.push(`${c.name} +${add}`); }
  }
  const first = !(await get("SELECT 1 x FROM loyalty_ledger WHERE user_id=? AND kind='earn' LIMIT 1", o.user_id));
  if (first) for (const c of camps.filter((x) => x.kind === 'first_purchase')) { if (c.bonus_points > 0) { extra += c.bonus_points; notes.push(`${c.name} +${c.bonus_points}`); } }
  const points = basePts + extra;
  if (points <= 0) return null;
  const r = await post({ userId: o.user_id, kind: 'earn', points, idemKey: 'earn:' + o.ref, orderRef: o.ref, note: `Order ${o.ref} (${tier.name} rate)` + (notes.length ? ' · ' + notes.join(', ') : '') });
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
  const referrals = await sweepReferrals().catch((e) => { console.error('Referral sweep failed', e.message); return 0; });
  return { awarded, reversed, referrals };
}


/* ---------- referrals ---------- */
const refCfg = async () => { const m = Object.fromEntries((await all("SELECT key,value FROM settings WHERE key LIKE 'referral_%'")).map((r) => [r.key, r.value])); const n = (k, d) => (Number(m[k]) >= 0 && m[k] !== undefined ? Number(m[k]) : d); return { enabled: m.referral_enabled !== '0', reward: n('referral_reward_points', 500), welcome: n('referral_welcome_points', 200), minOrder: n('referral_min_order', 5000), monthlyCap: n('referral_monthly_cap', 20) }; };
// Called when someone signs up with a code. Bad or self codes are ignored quietly (the sign-up itself must never fail because of a code).
async function recordReferral(newUserId, rawCode) {
  const code = str(rawCode, 20).toUpperCase(); if (!code || !(await refCfg()).enabled) return null;
  const owner = await get('SELECT a.user_id, u.phone FROM loyalty_accounts a JOIN users u ON u.id=a.user_id WHERE a.referral_code=?', code);
  const me = await get('SELECT id, phone FROM users WHERE id=?', newUserId);
  if (!owner || !me || Number(owner.user_id) === Number(me.id)) return null;
  const phone = String(me.phone || '').replace(/\D/g, '').slice(-10);
  let status = 'registered', reason = '';
  if (phone.length >= 7) {
    const dup = await get("SELECT 1 x FROM users WHERE id<>? AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10)=? LIMIT 1", me.id, phone);
    if (dup) { status = 'rejected'; reason = 'This phone number is already used by another account.'; }
  }
  await run('INSERT INTO loyalty_referrals (referrer_id,referred_id,code,status,reason,created) VALUES (?,?,?,?,?,?) ON CONFLICT (referred_id) DO NOTHING', owner.user_id, me.id, code, status, reason, now());
  return status;
}
// The referred customer's first delivered and paid order of at least the minimum value rewards both people, once.
async function sweepReferrals() {
  const cfg = await refCfg(), lc = await config(); if (!cfg.enabled || !lc.enabled) return 0;
  const pending = await all("SELECT * FROM loyalty_referrals WHERE status='registered' ORDER BY id LIMIT 200");
  let n = 0;
  for (const r of pending) {
    const o = await get(`SELECT * FROM orders o WHERE o.user_id=? AND o.status='delivered' AND o.payment_status='paid' AND (o.subtotal-o.discount)>=?
        AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id=o.id AND e.status='delivered' AND e.created>=?) ORDER BY o.id LIMIT 1`, r.referred_id, cfg.minOrder, lc.start);
    if (!o) continue;
    const refPhone = String((await get('SELECT phone FROM users WHERE id=?', r.referrer_id)).phone || '').replace(/\D/g, '').slice(-10), shipPhone = String(o.phone || '').replace(/\D/g, '').slice(-10);
    if (refPhone.length >= 7 && refPhone === shipPhone) { await run("UPDATE loyalty_referrals SET status='rejected', reason=? WHERE id=? AND status='registered'", 'The order was delivered to the referrer\'s own phone number.', r.id); continue; }
    const month = Number((await get("SELECT COUNT(*) n FROM loyalty_referrals WHERE referrer_id=? AND status='rewarded' AND rewarded_at>=?", r.referrer_id, now() - 30 * 86400)).n);
    if (month >= cfg.monthlyCap) { await run("UPDATE loyalty_referrals SET status='rejected', reason=? WHERE id=? AND status='registered'", 'The referrer reached the monthly referral limit.', r.id); continue; }
    await tx(async () => {
      const lock = await get("SELECT status FROM loyalty_referrals WHERE id=? FOR UPDATE", r.id);
      if (!lock || lock.status !== 'registered') return;
      if (cfg.reward > 0) await post({ userId: r.referrer_id, kind: 'bonus', points: cfg.reward, idemKey: 'referral:' + r.referred_id + ':referrer', orderRef: o.ref, note: 'Referral reward' });
      if (cfg.welcome > 0) await post({ userId: r.referred_id, kind: 'bonus', points: cfg.welcome, idemKey: 'referral:' + r.referred_id + ':welcome', orderRef: o.ref, note: 'Welcome bonus (referred by a friend)' });
      await run("UPDATE loyalty_referrals SET status='rewarded', order_ref=?, referrer_points=?, referred_points=?, rewarded_at=? WHERE id=?", o.ref, cfg.reward, cfg.welcome, now(), r.id);
      n++;
    });
    const N = require('./notify');
    N.notify([r.referrer_id], { type: 'loyalty', title: `You earned ${cfg.reward} referral points`, body: 'A friend you invited completed their first order.', link: '/account' }).catch(() => {});
  }
  return n;
}
async function myReferrals(user) {
  const a = await ensureAccount(user.id); if (!a) fail(404, 'No rewards account for this account.');
  const rows = await all('SELECT r.id, r.status, r.reason, r.referrer_points, r.created, r.rewarded_at, u.name FROM loyalty_referrals r JOIN users u ON u.id=r.referred_id WHERE r.referrer_id=? ORDER BY r.id DESC LIMIT 100', user.id);
  const cfg = await refCfg();
  return { code: a.referral_code, link: `${S.BASE_URL}/?ref=${a.referral_code}`, reward_points: cfg.reward, friend_bonus_points: cfg.welcome, minimum_first_order: cfg.minOrder,
    totals: { registered: rows.filter((r) => r.status === 'registered').length, rewarded: rows.filter((r) => r.status === 'rewarded').length, points_earned: rows.reduce((x, r) => x + Number(r.referrer_points), 0) },
    referrals: rows.map((r) => ({ name: String(r.name).split(' ')[0].slice(0, 1) + '***', status: r.status === 'registered' ? 'waiting for their first order' : r.status, points: Number(r.referrer_points), joined: Number(r.created) })) };
}
async function adminReferrals(status) {
  return all(`SELECT r.*, a.name referrer, b.name referred FROM loyalty_referrals r JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.referred_id ${status ? 'WHERE r.status=?' : ''} ORDER BY r.id DESC LIMIT 200`, ...(status ? [status] : []));
}
async function rejectReferral(id, reason) {
  if (!str(reason, 200)) fail(400, 'Please give a reason.');
  const r = await run("UPDATE loyalty_referrals SET status='rejected', reason=? WHERE id=? AND status='registered'", str(reason, 200), id);
  if (!r.changes && !r.rowCount) fail(400, 'Only a referral that is still waiting can be rejected.');
}

/* ---------- campaigns ---------- */
const campaignInput = (b) => {
  const kind = b.kind === 'first_purchase' ? 'first_purchase' : 'multiplier', starts = int(b.starts), ends = int(b.ends);
  if (!str(b.name, 80)) fail(400, 'Give the campaign a name.'); if (!starts || !ends || ends <= starts) fail(400, 'Set a start time that is before the end time.');
  const days = String(b.weekdays || '').split(',').map((x) => x.trim()).filter(Boolean); if (days.some((d) => !/^[0-6]$/.test(d))) fail(400, 'Weekdays are numbers 0 (Sunday) to 6.');
  return [str(b.name, 80), str(b.description, 200), kind, Math.min(1000, Math.max(100, int(b.multiplier_pct, 100))), Math.max(0, int(b.bonus_points)), starts, ends, days.join(','), str(b.min_tier, 30), int(b.category_id) || null, b.active === false || b.active === 0 ? 0 : 1];
};
const listCampaigns = () => all('SELECT * FROM loyalty_campaigns ORDER BY id DESC LIMIT 200');
async function saveCampaign(id, b) {
  const v = campaignInput(b || {});
  if (id) { const r = await run('UPDATE loyalty_campaigns SET name=?,description=?,kind=?,multiplier_pct=?,bonus_points=?,starts=?,ends=?,weekdays=?,min_tier=?,category_id=?,active=? WHERE id=?', ...v, id); if (!r.changes && !r.rowCount) fail(404, 'Campaign not found.'); return get('SELECT * FROM loyalty_campaigns WHERE id=?', id); }
  return get('INSERT INTO loyalty_campaigns (name,description,kind,multiplier_pct,bonus_points,starts,ends,weekdays,min_tier,category_id,active,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *', ...v, now());
}
async function offersFor(user) {
  const a = await ensureAccount(user.id), list = await tiers(); if (!a) return [];
  const camps = await activeCampaigns(list, tierFor(list, a.lifetime).name);
  const first = !(await get("SELECT 1 x FROM loyalty_ledger WHERE user_id=? AND kind='earn' LIMIT 1", user.id));
  return camps.filter((c) => c.kind === 'multiplier' || first).map((c) => ({ id: Number(c.id), name: c.name, description: c.description, kind: c.kind, multiplier: c.multiplier_pct / 100, bonus_points: c.bonus_points, ends: Number(c.ends) }));
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
    earning: { points_per_1000: cfg.perThousand }, referral_code: a.referral_code, offers: await offersFor(user),
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
module.exports = { recordReferral, sweepReferrals, myReferrals, adminReferrals, rejectReferral, listCampaigns, saveCampaign, offersFor, config, ensureAccount, post, sweep, overview, history, redeemToWallet, adminAdjust, setConfig, setTier, report, awardOrder, reverseOrder };
