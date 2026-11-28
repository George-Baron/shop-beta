'use strict';
// Financial reports for the wallet, rewards and card programmes (administrators only).
// Accounting treatment: a wallet top-up is NOT sales. It is money held for the customer (a liability) until they spend it on an order.
// Sales are recognised on the order. Points outstanding are a liability valued at the redemption rate. Points used at checkout are a discount.
const { get, all } = require('./db');
const W = require('./wallet');
const L = require('./loyalty');
const C = require('./cards');
const S = require('./shop');
const { int, str } = S;
const N = (k) => Number(k) / 100;
const range = (q) => { const from = int(q && q.from, 0), to = int(q && q.to, 0) || 4102444800; return [from, to]; };

async function wallet(q) {
  const [from, to] = range(q);
  const liab = await get("SELECT COALESCE(SUM(balance),0) bal, COALESCE(SUM(pending),0) pend, COUNT(*) n, COUNT(*) FILTER (WHERE status='frozen') frozen, COUNT(*) FILTER (WHERE balance>0) funded FROM ledger_accounts WHERE kind='customer_wallet'");
  const t = await all("SELECT type, direction, COUNT(*) n, COALESCE(SUM(amount),0) s FROM wallet_txns WHERE status='completed' AND created>=? AND created<=? GROUP BY type, direction", from, to);
  const sum = (type) => N(t.filter((r) => r.type === type).reduce((a, r) => a + Number(r.s), 0)), cnt = (type) => t.filter((r) => r.type === type).reduce((a, r) => a + Number(r.n), 0);
  const adj = t.filter((r) => r.type === 'adjustment');
  const rec = await W.reconcile();
  return {
    period: { from, to: to === 4102444800 ? null : to },
    liability: { total_wallet_balances: N(liab.bal), of_which_held_for_unpaid_orders: N(liab.pend), wallets: Number(liab.n), wallets_with_balance: Number(liab.funded), frozen_wallets: Number(liab.frozen) },
    funding: { total: sum('deposit'), count: cnt('deposit') }, spending: { total: sum('purchase'), count: cnt('purchase') },
    refunds_to_wallet: { total: sum('refund'), count: cnt('refund') }, rewards_converted_to_wallet: { total: sum('reward'), count: cnt('reward') },
    adjustments: { credits: N(adj.filter((r) => r.direction === 'credit').reduce((a, r) => a + Number(r.s), 0)), debits: N(adj.filter((r) => r.direction === 'debit').reduce((a, r) => a + Number(r.s), 0)) },
    reconciliation: { ok: rec.ok, drift: rec.drift.length, unbalanced_transactions: rec.unbalanced.length, ledger_liability: rec.wallet_liability },
    accounting_note: 'Wallet funding is not sales revenue. It is a customer liability until spent on an order.',
  };
}
async function loyalty(q) {
  const [from, to] = range(q);
  const base = await L.report();
  const k = await all("SELECT kind, COUNT(*) n, COALESCE(SUM(points),0) s FROM loyalty_ledger WHERE created>=? AND created<=? GROUP BY kind", from, to);
  const by = (kind) => k.find((r) => r.kind === kind) || { n: 0, s: 0 };
  const camp = await all("SELECT l.note FROM loyalty_ledger l WHERE l.kind='earn' AND l.note LIKE '% · %' AND l.created>=? AND l.created<=?", from, to);
  const campaigns = {}; for (const r of camp) for (const part of String(r.note).split(' · ')[1].split(', ')) { const m = /^(.*) \+(\d+)$/.exec(part); if (m) { campaigns[m[1]] = campaigns[m[1]] || { orders: 0, extra_points: 0 }; campaigns[m[1]].orders++; campaigns[m[1]].extra_points += Number(m[2]); } }
  const ref = await all('SELECT status, COUNT(*) n, COALESCE(SUM(referrer_points+referred_points),0) pts FROM loyalty_referrals WHERE created>=? AND created<=? GROUP BY status', from, to);
  const disc = await get("SELECT COALESCE(SUM(points_discount),0) d, COALESCE(SUM(points_used),0) p, COUNT(*) FILTER (WHERE points_used>0) n FROM orders WHERE created>=? AND created<=? AND payment_status='paid' AND status NOT IN ('refunded','cancelled')", from, to);
  return {
    ...base, period: { from, to: to === 4102444800 ? null : to },
    in_period: { points_earned: Number(by('earn').s), points_reversed: -Number(by('reverse').s), points_redeemed_net: -Number(by('redeem').s), bonus_points: Number(by('bonus').s), adjustments: Number(by('adjust').s) },
    checkout_discounts: { orders: Number(disc.n), points_used: Number(disc.p), naira_discounted: Number(disc.d) },
    campaigns, referrals: Object.fromEntries(ref.map((r) => [r.status, { count: Number(r.n), points: Number(r.pts) }])),
    accounting_note: 'Points outstanding are a liability valued at the redemption rate. Discounts given with points are a cost of the programme, not extra revenue.',
  };
}
// Sales split by how each paid order was settled. Wallet top-ups never appear here.
async function sales(q) {
  const [from, to] = range(q);
  const o = await get(`SELECT COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(wallet_amount),0) wallet, COALESCE(SUM(points_discount),0) points_disc,
      COALESCE(SUM(total) FILTER (WHERE payment_method='pod'),0) pod, COALESCE(SUM(total) FILTER (WHERE payment_method<>'pod' AND wallet_amount=0),0) gateway_only
      FROM orders WHERE payment_status='paid' AND status NOT IN ('refunded','cancelled') AND created>=? AND created<=?`, from, to);
  const total = Number(o.total), wal = N(o.wallet), pod = Number(o.pod);
  return { orders: Number(o.n), sales_recognised: total, paid_from_wallet: wal, paid_by_gateway_or_card: Math.max(0, total - wal - pod), paid_on_delivery: pod, discount_given_with_points: Number(o.points_disc),
    note: 'Sales are recognised on the order. The wallet part of an order is wallet money being spent (the liability goes down); it is not a second sale.' };
}
async function gateways(q) {
  const [from, to] = range(q);
  const f = await all("SELECT gateway, status, COUNT(*) n, COALESCE(SUM(amount),0) s FROM wallet_funding WHERE created>=? AND created<=? GROUP BY gateway, status", from, to);
  const wf = {}; for (const r of f) { const g = (wf[r.gateway] = wf[r.gateway] || { attempts: 0, success: 0, failed: 0, mismatch: 0, initiated: 0, amount_succeeded: 0 }); g.attempts += Number(r.n); g[r.status] = Number(r.n); if (r.status === 'success') g.amount_succeeded = N(r.s); }
  for (const g of Object.values(wf)) g.success_rate = g.attempts ? Math.round((g.success / g.attempts) * 1000) / 10 : 0;
  const o = await all("SELECT gateway, payment_status, COUNT(*) n FROM orders WHERE payment_method<>'pod' AND created>=? AND created<=? GROUP BY gateway, payment_status", from, to);
  const orders = {}; for (const r of o) { const g = (orders[r.gateway] = orders[r.gateway] || { paid: 0, unpaid: 0 }); g[r.payment_status === 'paid' ? 'paid' : 'unpaid'] += Number(r.n); }
  for (const g of Object.values(orders)) g.success_rate = g.paid + g.unpaid ? Math.round((g.paid / (g.paid + g.unpaid)) * 1000) / 10 : 0;
  return { wallet_funding_by_gateway: wf, order_payments_by_gateway: orders };
}
// Things worth a human look. Simple rules, shown to staff; nothing is blocked automatically.
async function suspicious() {
  const day = Math.floor(Date.now() / 1000) - 86400, big = Number((await get("SELECT value FROM settings WHERE key='wallet_alert_amount'") || {}).value) || 500000;
  const failing = await all("SELECT f.user_id, u.email, COUNT(*) n FROM wallet_funding f JOIN users u ON u.id=f.user_id WHERE f.created>=? AND f.status IN ('failed','mismatch') GROUP BY f.user_id, u.email HAVING COUNT(*)>=5 ORDER BY n DESC LIMIT 50", day);
  const mismatches = await all("SELECT f.ref, f.user_id, u.email, f.amount, f.note FROM wallet_funding f JOIN users u ON u.id=f.user_id WHERE f.status='mismatch' ORDER BY f.id DESC LIMIT 50");
  const large = await all("SELECT t.ref, t.user_id, u.email, t.amount, t.created FROM wallet_txns t JOIN users u ON u.id=t.user_id WHERE t.type='deposit' AND t.amount>=? AND t.created>=? ORDER BY t.id DESC LIMIT 50", big * 100, day);
  const fast = await all("SELECT t.user_id, u.email, COUNT(*) n FROM wallet_txns t JOIN users u ON u.id=t.user_id WHERE t.type IN ('deposit','purchase','refund') AND t.created>=? GROUP BY t.user_id, u.email HAVING COUNT(*)>=20 ORDER BY n DESC LIMIT 50", day);
  const pending = await all("SELECT r.order_ref, r.user_id, r.amount, r.created FROM wallet_reservations r WHERE r.status='held' AND r.created<? LIMIT 50", day);
  return { repeated_failed_fundings_24h: failing.map((r) => ({ ...r, n: Number(r.n) })), amount_mismatches: mismatches.map((r) => ({ ...r, amount: N(r.amount) })), large_deposits_24h: large.map((r) => ({ ...r, amount: N(r.amount) })), very_busy_wallets_24h: fast.map((r) => ({ ...r, n: Number(r.n) })), old_held_reservations: pending.map((r) => ({ ...r, amount: N(r.amount) })), thresholds: { large_deposit: big, failed_fundings: 5, busy_wallet_transactions: 20 } };
}
async function fundingList(q) {
  const st = str(q && q.status, 12), rows = await all(`SELECT f.ref, f.user_id, u.email, f.amount, f.gateway, f.status, f.note, f.created FROM wallet_funding f JOIN users u ON u.id=f.user_id ${st ? 'WHERE f.status=?' : ''} ORDER BY f.id DESC LIMIT 200`, ...(st ? [st] : []));
  return rows.map((r) => ({ ...r, amount: N(r.amount) }));
}
async function summary(q) { return { wallet: await wallet(q), sales: await sales(q), rewards: await loyalty(q), cards: await C.adminReport(), gateways: await gateways(q) }; }
// Every wallet transaction in the period, for the accountants (CSV).
async function walletCsv(q) {
  const [from, to] = range(q), rows = await all('SELECT t.*, u.email FROM wallet_txns t JOIN users u ON u.id=t.user_id WHERE t.created>=? AND t.created<=? ORDER BY t.id', from, to);
  const esc = (v) => '"' + String(v).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"';
  return ['reference,date,customer,type,direction,amount,currency,balance_before,balance_after,order_ref,gateway_ref,status,description', ...rows.map((r) => [r.ref, new Date(Number(r.created) * 1000).toISOString(), esc(r.email), r.type, r.direction, N(r.amount), r.currency, N(r.balance_before), N(r.balance_after), r.order_ref, r.gateway_ref, r.status, esc(r.description)].join(','))].join('\n');
}
module.exports = { wallet, loyalty, sales, gateways, suspicious, fundingList, summary, walletCsv };
