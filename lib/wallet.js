'use strict';
// VELTO WALLET: a closed-loop shopping wallet. Amounts are kobo (BIGINT). Balances change ONLY through post(), which writes balanced ledger entries
// in one database transaction. Money is credited from a top-up only after the gateway itself confirms it.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const { fail, str, int, HttpError } = S;

const TYPES = ['deposit', 'purchase', 'refund', 'reward', 'adjustment', 'withdrawal'];
const FILTERS = { deposits: 'deposit', purchases: 'purchase', refunds: 'refund', rewards: 'reward', adjustments: 'adjustment', withdrawals: 'withdrawal' };
// The system account that is the other side of each kind of entry.
const COUNTER = { deposit: 'gateway_clearing', purchase: 'order_clearing', refund: 'refund_clearing', reward: 'reward_clearing', adjustment: 'adjustment', withdrawal: 'gateway_clearing' };
const toKobo = (naira) => Math.round(Number(naira) * 100);
const toNaira = (kobo) => Number(kobo) / 100;
const newRef = (prefix) => prefix + '-' + crypto.randomBytes(8).toString('hex').toUpperCase().slice(0, 12); // e.g. WF-1A2B3C4D5E6F (15 chars)

async function limits() {
  const s = await S.getSettings();
  const n = (k, d) => (Number(s[k]) > 0 ? Number(s[k]) : d);
  return { enabled: s.wallet_enabled !== '0', min: n('wallet_min_fund', 100), max: n('wallet_max_fund', 1000000), maxBalance: n('wallet_max_balance', 5000000) * 100 }; // min/max are Naira; maxBalance is kobo, to compare with stored balances
}

/* ---------- accounts ---------- */
async function ensureWallet(userId, currency = 'NGN') {
  let w = await get("SELECT * FROM ledger_accounts WHERE kind='customer_wallet' AND user_id=? AND currency=?", userId, currency);
  if (!w) {
    const u = await get('SELECT id, role FROM users WHERE id=?', userId);
    if (!u || u.role !== 'customer') return null; // staff, riders, vendors etc. do not get shopping wallets
    await run("INSERT INTO ledger_accounts (kind,user_id,currency,created) VALUES ('customer_wallet',?,?,?) ON CONFLICT DO NOTHING", userId, currency, now());
    w = await get("SELECT * FROM ledger_accounts WHERE kind='customer_wallet' AND user_id=? AND currency=?", userId, currency);
  }
  return w;
}
async function systemAccount(kind, currency = 'NGN') {
  await run('INSERT INTO ledger_accounts (kind,currency,created) VALUES (?,?,?) ON CONFLICT DO NOTHING', kind, currency, now());
  return get('SELECT * FROM ledger_accounts WHERE kind=? AND currency=?', kind, currency);
}

/* ---------- the one way money moves ---------- */
// post({ userId, type, amount (kobo), idemKey, ... }) -> { txn, replayed }
// Safe to call twice with the same idemKey: the second call returns the first result and moves nothing.
async function post(o) {
  const amount = Number(o.amount), type = o.type, currency = o.currency || 'NGN';
  if (!Number.isSafeInteger(amount) || amount <= 0) fail(400, 'Enter a valid amount.');
  if (!TYPES.includes(type)) fail(400, 'Unknown wallet transaction type.');
  if (!o.idemKey) throw new Error('wallet.post needs an idemKey');
  const credit = o.direction ? o.direction === 'credit' : ['deposit', 'refund', 'reward'].includes(type) || (type === 'adjustment' && o.direction !== 'debit');
  return tx(async () => {
    const prior = await get('SELECT * FROM wallet_txns WHERE idem_key=?', o.idemKey);
    if (prior) return { txn: shape(prior), replayed: true };
    const w = await ensureWallet(o.userId, currency);
    if (!w) fail(400, 'This account does not have a wallet.');
    // lock both accounts in id order so two postings can never deadlock
    const sys = await systemAccount(COUNTER[type], currency);
    const ids = [w.id, sys.id].sort((a, b) => a - b);
    const locked = {}; for (const id of ids) locked[id] = await get('SELECT * FROM ledger_accounts WHERE id=? FOR UPDATE', id);
    const wal = locked[w.id], cp = locked[sys.id];
    // A twin request may have finished while we waited for the lock: look again, so the loser gets the winner's result instead of a unique-key error.
    const twin = await get('SELECT * FROM wallet_txns WHERE idem_key=?', o.idemKey);
    if (twin) return { txn: shape(twin), replayed: true };
    if (wal.status === 'frozen' && !o.allowFrozen) fail(403, 'This wallet is frozen. Please contact support.');
    const spendable = Number(wal.balance) - Number(wal.pending);
    if (!credit && !o.fromReservation && amount > spendable) fail(402, 'Your wallet balance is not enough for this.');
    if (!credit && o.fromReservation && amount > Number(wal.balance)) fail(402, 'Your wallet balance is not enough for this.');
    if (credit && type === 'deposit') { const L = await limits(); if (Number(wal.balance) + amount > L.maxBalance) fail(400, `A wallet cannot hold more than ₦${toNaira(L.maxBalance).toLocaleString('en-NG')}.`); }
    const signed = credit ? amount : -amount, newBal = Number(wal.balance) + signed, cpBal = Number(cp.balance) - signed, t = now();
    const ref = o.ref || newRef('WT');
    const row = await get(
      `INSERT INTO wallet_txns (ref,idem_key,user_id,type,amount,currency,direction,balance_before,balance_after,description,order_ref,gateway,gateway_ref,actor,reason,created)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
      ref, o.idemKey, o.userId, type, amount, currency, credit ? 'credit' : 'debit', wal.balance, newBal, str(o.description, 200), str(o.orderRef, 40), str(o.gateway, 20), str(o.gatewayRef, 80), str(o.actor, 80), str(o.reason, 300), t);
    await run('UPDATE ledger_accounts SET balance=? WHERE id=?', newBal, wal.id);
    await run('UPDATE ledger_accounts SET balance=? WHERE id=?', cpBal, cp.id);
    await run('INSERT INTO ledger_entries (txn_id,account_id,amount,balance_after,created) VALUES (?,?,?,?,?)', row.id, wal.id, signed, newBal, t);
    await run('INSERT INTO ledger_entries (txn_id,account_id,amount,balance_after,created) VALUES (?,?,?,?,?)', row.id, cp.id, -signed, cpBal, t);
    return { txn: shape(row), replayed: false };
  });
}
const shape = (r) => ({ ref: r.ref, type: r.type, direction: r.direction, amount: toNaira(r.amount), currency: r.currency, previous_balance: toNaira(r.balance_before), new_balance: toNaira(r.balance_after), description: r.description, order_ref: r.order_ref, gateway_ref: r.gateway_ref, status: r.status, created: Number(r.created) });

/* ---------- what the customer sees ---------- */
async function overview(user) {
  const w = await ensureWallet(user.id);
  if (!w) fail(404, 'No wallet for this account.');
  const sums = await get(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type='deposit'),0) funded, COALESCE(SUM(amount) FILTER (WHERE type='purchase'),0) spent,
            COALESCE(SUM(amount) FILTER (WHERE type='refund'),0) refunds, COALESCE(SUM(amount) FILTER (WHERE type='reward'),0) rewards
       FROM wallet_txns WHERE user_id=? AND status='completed'`, user.id);
  const recent = await all('SELECT * FROM wallet_txns WHERE user_id=? ORDER BY id DESC LIMIT 5', user.id);
  const L = await limits();
  return {
    status: w.status, currency: w.currency, available_balance: toNaira(Number(w.balance) - Number(w.pending)), pending_balance: toNaira(w.pending), balance: toNaira(w.balance),
    total_funded: toNaira(sums.funded), total_spent: toNaira(sums.spent), total_refunds: toNaira(sums.refunds), total_rewards_converted: toNaira(sums.rewards),
    limits: { min_fund: L.min, max_fund: L.max }, recent: recent.map(shape),
  };
}
async function history(user, q = {}) {
  const lim = Math.min(100, Math.max(1, int(q.limit, 30))), before = int(q.before, 0), type = FILTERS[String(q.type || '')] || '';
  const rows = await all(`SELECT * FROM wallet_txns WHERE user_id=? ${type ? 'AND type=?' : ''} ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ${lim + 1}`, user.id, ...(type ? [type] : []), ...(before ? [before] : []));
  const page = rows.slice(0, lim);
  return { transactions: page.map((r) => ({ id: Number(r.id), ...shape(r) })), more: rows.length > lim };
}
// A plain-text statement the customer can download.
async function statement(user, q = {}) {
  const from = int(q.from, 0), to = int(q.to, now() + 86400);
  const rows = await all('SELECT * FROM wallet_txns WHERE user_id=? AND created>=? AND created<=? ORDER BY id', user.id, from, to);
  const head = ['reference', 'date', 'type', 'direction', 'amount', 'currency', 'previous_balance', 'new_balance', 'description', 'order_ref', 'status'];
  const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  return [head.join(','), ...rows.map((r) => [r.ref, new Date(Number(r.created) * 1000).toISOString(), r.type, r.direction, toNaira(r.amount), r.currency, toNaira(r.balance_before), toNaira(r.balance_after), esc(r.description), r.order_ref, r.status].join(','))].join('\n');
}

/* ---------- funding (top-up) ---------- */
// Step 1: record the attempt and ask the gateway for a payment page. Nothing is credited here.
async function initFunding(user, body) {
  const L = await limits();
  if (!L.enabled) fail(503, 'Wallet top-ups are switched off right now.');
  const w = await ensureWallet(user.id); if (!w) fail(400, 'This account does not have a wallet.');
  if (w.status === 'frozen') fail(403, 'This wallet is frozen. Please contact support.');
  const naira = Number(body && body.amount);
  if (!Number.isInteger(naira) || naira < L.min || naira > L.max) fail(400, `Enter a whole-naira amount between ₦${L.min.toLocaleString('en-NG')} and ₦${L.max.toLocaleString('en-NG')}.`);
  if (Number(w.balance) + toKobo(naira) > L.maxBalance) fail(400, `A wallet cannot hold more than ₦${toNaira(L.maxBalance).toLocaleString('en-NG')}.`);
  const gateway = 'paystack'; // other gateways plug in here once each one is confirmed and tested (see docs/WALLET.md)
  if (!S.paystackLive()) fail(503, 'Online payment is not available right now.');
  const ref = newRef('WF'), t = now();
  await run('INSERT INTO wallet_funding (ref,user_id,amount,currency,gateway,created,updated) VALUES (?,?,?,?,?,?,?)', ref, user.id, toKobo(naira), 'NGN', gateway, t, t);
  let url;
  try { url = await paystackInitialize({ ref, email: user.email, amount: toKobo(naira), name: user.name, user_id: user.id }); }
  catch (e) { await run("UPDATE wallet_funding SET status='failed', note=?, updated=? WHERE ref=?", 'could not start payment', now(), ref); throw e; }
  return { ref, url, amount: naira, gateway };
}
async function paystackInitialize(f) {
  const base = process.env.PAYSTACK_API_URL || 'https://api.paystack.co';
  let res;
  try {
    res = await fetch(base + '/transaction/initialize', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: f.email, amount: f.amount, currency: 'NGN', reference: f.ref, callback_url: `${S.BASE_URL}/account?wallet=${f.ref}`, metadata: { purpose: 'wallet_funding', user_id: f.user_id } }), signal: AbortSignal.timeout(15000) });
  } catch { throw new HttpError(502, 'We could not start the payment. Please try again.'); }
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.status || !d.data || !d.data.authorization_url) throw new HttpError(502, 'We could not start the payment. Please try again.');
  return d.data.authorization_url;
}
// Step 2 (webhook worker, or the customer coming back): ask Paystack itself, check reference, currency and amount, then credit exactly once.
async function settleFunding(ref, { strict = false } = {}) {
  const f = await get('SELECT * FROM wallet_funding WHERE ref=?', ref);
  if (!f) return null;
  if (f.status === 'success') return f;
  const d = await S.paystackVerify(ref);
  if (!d) { if (strict) throw new Error('Paystack could not confirm the payment yet'); return f; }
  if (d.status !== 'success') {
    if (['failed', 'abandoned', 'reversed'].includes(d.status)) await run("UPDATE wallet_funding SET status='failed', note=?, updated=? WHERE ref=? AND status='initiated'", 'gateway status: ' + d.status, now(), ref);
    return get('SELECT * FROM wallet_funding WHERE ref=?', ref);
  }
  const bad = String(d.reference || ref).toUpperCase() !== ref ? 'reference differs' : d.currency !== f.currency ? `currency was ${d.currency}` : Number(d.amount) !== Number(f.amount) ? `amount was ${Number(d.amount) / 100}, expected ${Number(f.amount) / 100}` : '';
  if (bad) { await run("UPDATE wallet_funding SET status='mismatch', note=?, updated=? WHERE ref=? AND status='initiated'", bad, now(), ref); console.error(`Wallet funding mismatch on ${ref}: ${bad}`); return get('SELECT * FROM wallet_funding WHERE ref=?', ref); }
  // The idempotency key is the funding reference, so a repeated webhook, a retry and the customer's own return can never credit twice.
  const { txn, replayed } = await post({ userId: f.user_id, type: 'deposit', amount: Number(f.amount), idemKey: 'fund:' + ref, ref: 'WT-' + ref.slice(3), gateway: f.gateway, gatewayRef: ref, description: 'Wallet top-up', allowFrozen: true });
  await run("UPDATE wallet_funding SET status='success', txn_id=(SELECT id FROM wallet_txns WHERE ref=?), updated=? WHERE ref=?", txn.ref, now(), ref);
  if (!replayed) require('./notify').notify([f.user_id], { type: 'wallet', title: 'Wallet funded', body: `₦${toNaira(f.amount).toLocaleString('en-NG')} was added to your VELTO wallet.`, link: '/account' }).catch(() => {});
  return get('SELECT * FROM wallet_funding WHERE ref=?', ref);
}


/* ---------- paying for an order ---------- */
const MIN_GATEWAY_KOBO = 5000; // never leave less than N50 for the gateway to charge
// The full breakdown the customer sees before confirming (display only: nothing is held, charged or spent here). The real amounts are fixed on the server when the order is placed.
async function preview(user, body) {
  const w = await ensureWallet(user.id); if (!w) fail(404, 'No wallet for this account.');
  const priced = await S.priceCart({ items: body && body.items, coupon: body && body.coupon, state: S.str(body && body.state, 60), delivery: (body && body.delivery) || 'standard', country: 'NG', currency: 'NGN' });
  if (!priced.lines.length) fail(400, 'Your cart is empty.');
  let loyalty = 0, pointsUsed = 0;
  if (body && Number(body.usePoints) > 0) { const q = await require('./loyalty').quotePoints(user.id, priced.subtotal - priced.discount, body.usePoints); loyalty = q.discount; pointsUsed = q.points; }
  const total = priced.total - loyalty, spendable = Math.max(0, Number(w.balance) - Number(w.pending));
  const use = body && body.useWallet === false ? 0 : split(toKobo(total), spendable);
  return { subtotal: priced.subtotal, product_discount: priced.discount, delivery_fee: priced.delivery.fee || 0, loyalty_discount: loyalty, points_used: pointsUsed, order_total: total, available_balance: toNaira(spendable), wallet_contribution: toNaira(use), remaining_payment: toNaira(toKobo(total) - use), note: 'Distance-based delivery fees, if any, are added when you confirm.' };
}
const split = (total, spendable) => {
  let use = Math.min(total, spendable);
  if (use < total && total - use < MIN_GATEWAY_KOBO) use = Math.max(0, total - MIN_GATEWAY_KOBO);
  return use;
};
// Called right after an order is placed with the customer's explicit "use my wallet" choice. The amounts come from the stored order, never from the request.
async function applyToOrder(order, user) {
  if (order.currency !== 'NGN' || order.gateway === 'stripe' || Number(order.charge_amount) !== order.total * 100) fail(400, 'The wallet can only pay for Naira orders paid through Paystack.');
  if (order.user_id == null || Number(order.user_id) !== Number(user.id)) fail(403, 'This order is not yours.');
  return tx(async () => {
    const w = await ensureWallet(user.id); if (!w) fail(400, 'This account does not have a wallet.');
    const wal = await get('SELECT * FROM ledger_accounts WHERE id=? FOR UPDATE', w.id);
    if (wal.status === 'frozen') fail(403, 'This wallet is frozen. Please contact support.');
    const total = order.total * 100, spendable = Number(wal.balance) - Number(wal.pending), use = split(total, spendable);
    if (use <= 0) fail(402, 'Your wallet balance is not enough to use here.');
    if (use === total) {
      await post({ userId: user.id, type: 'purchase', amount: use, idemKey: 'order:' + order.ref, orderRef: order.ref, description: 'Payment for order ' + order.ref });
      await run('UPDATE orders SET wallet_amount=?, charge_amount=0 WHERE id=?', use, order.id);
      await S.markPaid({ ...order, wallet_amount: use }, 'WALLET-' + order.ref, 'Paid from your VELTO wallet');
      return { paid: true, wallet_amount: toNaira(use), remaining: 0 };
    }
    // Part from the wallet: hold that money now, take it when the gateway part succeeds, give it back if the order is not paid.
    const t = now();
    await run("INSERT INTO wallet_reservations (order_ref,user_id,amount,created,updated) VALUES (?,?,?,?,?) ON CONFLICT (order_ref) DO NOTHING", order.ref, user.id, use, t, t);
    if (!(await get("SELECT 1 x FROM wallet_reservations WHERE order_ref=? AND amount=?", order.ref, use))) fail(409, 'The wallet was already applied to this order.');
    await run('UPDATE ledger_accounts SET pending = pending + ? WHERE id=?', use, wal.id);
    await run('UPDATE orders SET wallet_amount=?, charge_amount=? WHERE id=?', use, total - use, order.id);
    return { paid: false, wallet_amount: toNaira(use), remaining: toNaira(total - use) };
  });
}
// The gateway part was paid: turn the held money into a real purchase debit.
async function captureReservation(orderRef) {
  return tx(async () => {
    const r = await get("SELECT * FROM wallet_reservations WHERE order_ref=? AND status='held' FOR UPDATE", orderRef);
    if (!r) return false;
    await run('UPDATE ledger_accounts SET pending = pending - ? WHERE kind=? AND user_id=?', r.amount, 'customer_wallet', r.user_id);
    await post({ userId: r.user_id, type: 'purchase', amount: Number(r.amount), idemKey: 'order:' + orderRef, orderRef, description: 'Payment for order ' + orderRef, fromReservation: true, allowFrozen: true });
    await run("UPDATE wallet_reservations SET status='captured', updated=? WHERE id=?", now(), r.id);
    return true;
  });
}
async function releaseReservation(orderRef) {
  return tx(async () => {
    const r = await get("SELECT * FROM wallet_reservations WHERE order_ref=? AND status='held' FOR UPDATE", orderRef);
    if (!r) return false;
    await run('UPDATE ledger_accounts SET pending = pending - ? WHERE kind=? AND user_id=?', r.amount, 'customer_wallet', r.user_id);
    await run("UPDATE wallet_reservations SET status='released', updated=? WHERE id=?", now(), r.id);
    return true;
  });
}
// A refunded order gives the wallet's share back to the wallet (that is where it came from). The gateway share is still refunded by hand to the card.
async function refundOrderShare(order) {
  const amt = Number(order.wallet_amount || 0);
  if (amt <= 0 || order.user_id == null) return 0;
  const { replayed } = await post({ userId: order.user_id, type: 'refund', amount: amt, idemKey: 'refund:' + order.ref, orderRef: order.ref, description: 'Refund for order ' + order.ref, allowFrozen: true });
  if (!replayed) require('./notify').notify([order.user_id], { type: 'wallet', title: 'Refund to your wallet', body: `₦${toNaira(amt).toLocaleString('en-NG')} for order ${order.ref} was returned to your VELTO wallet.`, link: '/account' }).catch(() => {});
  return amt;
}

/* ---------- freezing, adjustments, reconciliation (staff) ---------- */
const audit = (userId, actor, action, detail) => run('INSERT INTO wallet_audit (user_id,actor_id,actor_name,action,detail,created) VALUES (?,?,?,?,?,?)', userId, actor ? actor.id : null, actor ? str(actor.name || actor.email, 80) : 'system', action, str(detail, 500), now());
async function setFrozen(userId, frozen, reason, actor) {
  if (frozen && !str(reason, 300)) fail(400, 'Please give a reason.');
  const w = await ensureWallet(userId); if (!w) fail(404, 'No wallet for this customer.');
  await run('UPDATE ledger_accounts SET status=?, frozen_reason=? WHERE id=?', frozen ? 'frozen' : 'active', frozen ? str(reason, 300) : '', w.id);
  await audit(userId, actor, frozen ? 'freeze' : 'unfreeze', reason);
}
// A manual adjustment is a normal ledger posting (never an edit). It needs a reason and a reference, and is audited.
async function adjust(userId, { direction, amount, reason, reference }, actor) {
  if (!str(reason, 300) || !str(reference, 60)) fail(400, 'An adjustment needs a reason and a reference.');
  const r = await post({ userId, type: 'adjustment', direction: direction === 'debit' ? 'debit' : 'credit', amount: toKobo(amount), idemKey: 'adj:' + str(reference, 60) + ':' + userId, description: 'Adjustment: ' + str(reason, 150), reason, actor: actor.name || actor.email, allowFrozen: true });
  await audit(userId, actor, 'adjust', `${direction} ${amount} ref ${reference}: ${reason}`);
  return r;
}
// Cached balances must equal the ledger, every txn must sum to zero, and the books as a whole must sum to zero.
async function reconcile() {
  const drift = await all(`SELECT a.id, a.kind, a.user_id, a.balance cached, COALESCE(SUM(e.amount),0) ledger FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.id HAVING a.balance <> COALESCE(SUM(e.amount),0)`);
  const unbalanced = await all('SELECT txn_id, SUM(amount) s FROM ledger_entries GROUP BY txn_id HAVING SUM(amount) <> 0');
  const liab = await get("SELECT COALESCE(SUM(balance),0) n FROM ledger_accounts WHERE kind='customer_wallet'");
  return { ok: !drift.length && !unbalanced.length, drift, unbalanced, wallet_liability: toNaira(liab.n) };
}

module.exports = { preview, applyToOrder, captureReservation, releaseReservation, refundOrderShare, post, ensureWallet, overview, history, statement, initFunding, settleFunding, setFrozen, adjust, reconcile, toKobo, toNaira, limits };
