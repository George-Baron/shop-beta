'use strict';
// MY VELTO ACCOUNT: one call that fills the account dashboard (website and apps): wallet, points and tier, card, offers, recent activity.
const { get, all } = require('./db');
const W = require('./wallet');
const L = require('./loyalty');
const C = require('./cards');
const A = require('./auth');

async function summary(user) {
  const [wallet, rewards, cards, orders, pts] = await Promise.all([
    W.overview(user), L.overview(user), C.overview(user),
    all('SELECT ref, status, payment_status, total, created FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 5', user.id),
    L.history(user, { limit: 5 }),
  ]);
  return {
    profile: A.publicUser(user),
    wallet: { status: wallet.status, available_balance: wallet.available_balance, pending_balance: wallet.pending_balance, currency: wallet.currency, recent_transactions: wallet.recent },
    rewards: { points: rewards.points, tiers: rewards.tiers, lifetime_points: rewards.lifetime_points, tier: rewards.tier, next_tier: rewards.next_tier, pending_points: rewards.pending_points, expiring_points: rewards.expiring_points, recent: pts.entries, offers: rewards.offers, referral_code: rewards.referral_code },
    card: { programme_available: cards.programme.available, cards: cards.cards, latest_application: cards.applications[0] || null },
    recent_orders: orders.map((o) => ({ ref: o.ref, status: o.status, payment_status: o.payment_status, total: Number(o.total), created: Number(o.created) })),
  };
}
module.exports = { summary };
