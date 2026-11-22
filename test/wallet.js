'use strict';
// VELTO WALLET phase 1 check: wallet creation, funding (verified with the gateway only), idempotency, spending limits, ledger integrity, access control.
// Run with: npm run test:wallet   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_wallet_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const FAKE = 4900 + Math.floor(Math.random() * 90), P1 = FAKE + 100;
const PAYKEY = 'sk_test_wallet';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wallet-'));
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(200); } };

// The fake Paystack: what it says about each reference is set by the test.
const fx = { amounts: {}, status: {}, amountOverride: {} };
const fake = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const body = Buffer.concat(c).toString(); const send = (s, o) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/emails') return send(200, { id: 'x' });
    if (req.url === '/transaction/initialize') { const j = JSON.parse(body); fx.amounts[j.reference] = j.amount; return send(200, { status: true, data: { authorization_url: 'http://pay.test/' + j.reference } }); }
    const m = /^\/transaction\/verify\/(.+)$/.exec(req.url);
    if (m) { const ref = decodeURIComponent(m[1]); return send(200, { status: true, data: { status: fx.status[ref] || 'abandoned', currency: 'NGN', amount: fx.amountOverride[ref] != null ? fx.amountOverride[ref] : fx.amounts[ref], reference: ref } }); }
    send(404, {});
  });
});
const q = async (sql, args) => { const c = new Pg({ connectionString: URL_DB }); await c.connect(); try { return (await c.query(sql, args)).rows; } finally { await c.end(); } };
const pg = async (sql) => { const c = new Pg({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const call = async (method, url, body, cookie, headers = {}) => { const raw = body === undefined || body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)); const r = await fetch(`http://127.0.0.1:${P1}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw }); const sc = r.headers.getSetCookie ? r.headers.getSetCookie()[0] || '' : ''; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, t, c: sc.split(';')[0] }; };
const up = async () => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${P1}/health`); return; } catch { await sleep(100); } } throw new Error('app did not start'); };
const webhook = (ref, sig) => { const raw = JSON.stringify({ event: 'charge.success', data: { reference: ref } }); return call('POST', '/api/paystack/webhook', raw, null, { 'x-paystack-signature': sig || crypto.createHmac('sha512', PAYKEY).update(raw).digest('hex') }); };
let n = 0;
const register = async (name) => { const email = `w${Date.now().toString(36)}${n++}@example.com`; const r = await call('POST', '/api/auth/register', { name, email, phone: '0803' + String(1000000 + n * 7919).slice(0, 7), password: 'Velt0-Wallet-Qx7' }); assert.strictEqual(r.s, 200, 'register ' + r.t); return { email, cookie: r.c, id: Number((await q('SELECT id FROM users WHERE email=$1', [email]))[0].id) }; };
const fund = async (u, amount, status = 'success', override) => { const r = await call('POST', '/api/wallet/fund', { amount }, u.cookie); assert.strictEqual(r.s, 200, 'fund ' + r.t); fx.status[r.j.ref] = status; if (override != null) fx.amountOverride[r.j.ref] = override; return r.j.ref; };
const bal = async (u) => (await call('GET', '/api/wallet', null, u.cookie)).j;

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  await pg(`CREATE DATABASE ${DB}`);
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(P1), BASE_URL: 'http://127.0.0.1:' + P1, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', PAYSTACK_SECRET_KEY: PAYKEY, PAYSTACK_API_URL: 'http://127.0.0.1:' + FAKE, RESEND_API_KEY: '', RATE_LIMIT_MULTIPLIER: '100', WORKER_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.log = ''; app.stdout.on('data', (d) => { app.log += d; }); app.stderr.on('data', (d) => { app.log += d; });
  try {
    await up();
    const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' })).c;
    const ann = await register('Ann'), bob = await register('Bob');

    console.log('Wallet');
    await test('a new customer automatically gets a wallet with a zero balance', async () => {
      assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM ledger_accounts WHERE kind='customer_wallet' AND user_id=$1", [ann.id]))[0].n), 1);
      const w = await bal(ann); assert.strictEqual(w.available_balance, 0); assert.strictEqual(w.status, 'active'); assert.strictEqual(w.currency, 'NGN');
    });
    await test('wallet needs sign-in', async () => assert.strictEqual((await call('GET', '/api/wallet')).s, 401));
    await test('the same API answers on the mobile path', async () => assert.strictEqual((await call('GET', '/api/mobile/v1/wallet', null, ann.cookie)).s, 200));
    await test('top-up amount is checked against the minimum and maximum', async () => {
      assert.strictEqual((await call('POST', '/api/wallet/fund', { amount: 5 }, ann.cookie)).s, 400);
      assert.strictEqual((await call('POST', '/api/wallet/fund', { amount: 99999999 }, ann.cookie)).s, 400);
      assert.strictEqual((await call('POST', '/api/wallet/fund', { amount: 100.5 }, ann.cookie)).s, 400);
    });
    await test('starting a top-up credits nothing', async () => { await fund(ann, 5000, 'abandoned'); assert.strictEqual((await bal(ann)).available_balance, 0); });
    await test('a failed payment does not credit the wallet', async () => {
      const ref = await fund(ann, 5000, 'failed'); const r = await call('GET', '/api/wallet/fund/' + ref, null, ann.cookie);
      assert.strictEqual(r.j.status, 'failed'); assert.strictEqual((await bal(ann)).available_balance, 0);
    });
    await test('a verified payment credits exactly the amount, with a ledger entry', async () => {
      const ref = await fund(ann, 20000); const r = await call('GET', '/api/wallet/fund/' + ref, null, ann.cookie);
      assert.strictEqual(r.j.status, 'success'); const w = await bal(ann); assert.strictEqual(w.available_balance, 20000); assert.strictEqual(w.total_funded, 20000);
      const t = (await call('GET', '/api/wallet/transactions?type=deposits', null, ann.cookie)).j.transactions[0];
      assert.strictEqual(t.amount, 20000); assert.strictEqual(t.previous_balance, 0); assert.strictEqual(t.new_balance, 20000); assert.strictEqual(t.gateway_ref, ref);
    });
    await test('a payment for the wrong amount is refused and not credited', async () => {
      const before = (await bal(bob)).available_balance, ref = await fund(bob, 10000, 'success', 100); // paid 1 naira
      const r = await call('GET', '/api/wallet/fund/' + ref, null, bob.cookie);
      assert.strictEqual(r.j.status, 'mismatch'); assert.strictEqual((await bal(bob)).available_balance, before);
    });
    await test('webhook without a valid signature is rejected', async () => assert.strictEqual((await webhook('WF-X', 'bad')).s, 401));
    await test('duplicate webhooks, repeats and parallel verifies credit once', async () => {
      const ref = await fund(bob, 7000);
      const rs = await Promise.all([webhook(ref), webhook(ref), call('GET', '/api/wallet/fund/' + ref, null, bob.cookie), call('GET', '/api/wallet/fund/' + ref, null, bob.cookie)]);
      assert.ok(rs.every((r) => r.s === 200), 'no request may fail: ' + rs.map((r) => r.s));
      await until(async () => (await q('SELECT status FROM wallet_funding WHERE ref=$1', [ref]))[0].status === 'success');
      await webhook(ref); await call('GET', '/api/wallet/fund/' + ref, null, bob.cookie); await sleep(800);
      assert.strictEqual((await bal(bob)).available_balance, 7000);
      assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM wallet_txns WHERE gateway_ref=$1", [ref]))[0].n), 1);
    });
    await test('a customer cannot verify someone else\'s top-up', async () => {
      const ref = await fund(ann, 1000); assert.strictEqual((await call('GET', '/api/wallet/fund/' + ref, null, bob.cookie)).s, 404);
    });
    await test('customers see only their own wallet and transactions', async () => {
      const a = (await call('GET', '/api/wallet/transactions', null, ann.cookie)).j.transactions, b = (await call('GET', '/api/wallet/transactions', null, bob.cookie)).j.transactions;
      const refsA = new Set(a.map((t) => t.ref)); assert.ok(b.every((t) => !refsA.has(t.ref)));
      assert.strictEqual((await call('GET', '/api/admin/wallet/customers/' + ann.id, null, bob.cookie)).s, 401);
    });
    await test('the statement downloads as CSV', async () => { const r = await call('GET', '/api/wallet/statement.csv', null, ann.cookie); assert.strictEqual(r.s, 200); assert.ok(/^reference,date,type/.test(r.t) && /Wallet top-up/.test(r.t)); });

    console.log('Spending, adjustments and ledger integrity');
    const adj = (u, body) => call('POST', `/api/admin/wallet/customers/${u.id}/adjust`, body, admin);
    await test('an adjustment needs a reason and a reference', async () => assert.strictEqual((await adj(ann, { direction: 'credit', amount: 10 })).s, 400));
    await test('a debit larger than the balance is refused and the balance is unchanged', async () => {
      const r = await adj(bob, { direction: 'debit', amount: 99999, reason: 'test', reference: 'T-OVER' }); assert.strictEqual(r.s, 402); assert.strictEqual((await bal(bob)).available_balance, 7000);
    });
    await test('20 parallel debits of the whole balance spend it once (no overspend)', async () => {
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => adj(bob, { direction: 'debit', amount: 7000, reason: 'race', reference: 'RACE-' + i })));
      assert.strictEqual(rs.filter((r) => r.s === 200).length, 1); assert.ok(rs.every((r) => r.s === 200 || r.s === 402)); assert.strictEqual((await bal(bob)).available_balance, 0);
    });
    await test('the same adjustment reference twice applies once', async () => {
      await adj(bob, { direction: 'credit', amount: 500, reason: 'goodwill', reference: 'G-1' }); const r = await adj(bob, { direction: 'credit', amount: 500, reason: 'goodwill', reference: 'G-1' });
      assert.strictEqual(r.j.replayed, true); assert.strictEqual((await bal(bob)).available_balance, 500);
    });
    await test('a frozen wallet cannot be spent or topped up, and unfreezing restores it', async () => {
      assert.strictEqual((await call('POST', `/api/admin/wallet/customers/${ann.id}/freeze`, { reason: 'review' }, admin)).s, 200);
      assert.strictEqual((await call('POST', '/api/wallet/fund', { amount: 1000 }, ann.cookie)).s, 403);
      assert.strictEqual((await bal(ann)).status, 'frozen');
      await call('POST', `/api/admin/wallet/customers/${ann.id}/unfreeze`, {}, admin); assert.strictEqual((await bal(ann)).status, 'active');
    });
    await test('ledger entries cannot be edited or deleted, even directly in the database', async () => {
      await assert.rejects(q('UPDATE ledger_entries SET amount=amount+1'), /immutable/); await assert.rejects(q('DELETE FROM ledger_entries'), /immutable/); await assert.rejects(q('TRUNCATE ledger_entries'), /immutable/);
      await assert.rejects(q('DELETE FROM wallet_txns'), /cannot be deleted/); await assert.rejects(q('UPDATE wallet_txns SET amount=1'), /immutable/);
    });
    await test('a balance cannot be set below zero in the database', async () => assert.rejects(q("UPDATE ledger_accounts SET balance=-1 WHERE kind='customer_wallet'"), /wallet_never_negative/));
    await test('reconciliation: cached balances equal the ledger and every transaction balances to zero', async () => {
      const r = (await call('GET', '/api/admin/wallet/reconcile', null, admin)).j; assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.ok(r.wallet_liability > 0);
    });
    await test('staff accounts do not get shopping wallets', async () => assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM ledger_accounts WHERE kind='customer_wallet' AND user_id IN (SELECT id FROM users WHERE role<>'customer')"))[0].n), 0));

    console.log('Paying for orders with the wallet');
    const prod = (await q('SELECT id, price, stock FROM products WHERE active=1 AND stock>=30 AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 1'))[0];
    let uniq = 0;
    const cart = (qty, extra = {}) => ({ items: [{ productId: prod.id, qty }], contact: { name: 'Ada Obi', email: `buyer${Date.now().toString(36)}${uniq++}@example.com`, phone: '0803' + String(2000000 + uniq * 7907).slice(0, 7) }, address: { state: 'Lagos', city: 'Yaba', address: '1 Road Street' }, delivery: 'standard', payment: 'paystack', ...extra });
    const stockNow = async () => Number((await q('SELECT stock FROM products WHERE id=$1', [prod.id]))[0].stock);
    const orderRow = async (ref) => (await q('SELECT * FROM orders WHERE ref=$1', [ref]))[0];
    const buyer = await register('Buyer'), poor = await register('Poor'), carol = await register('Carol');
    let full;
    const qtyFor = (minTotal) => Math.max(1, Math.ceil(minTotal / prod.price));

    await test('preview shows what the wallet would cover and holds nothing', async () => {
      await call('GET', '/api/wallet/fund/' + await fund(buyer, 900000), null, buyer.cookie);
      const r = await call('POST', '/api/wallet/preview', cart(2), buyer.cookie); assert.strictEqual(r.s, 200, r.t);
      assert.strictEqual(r.j.wallet_contribution, r.j.order_total); assert.strictEqual(r.j.remaining_payment, 0);
      assert.strictEqual((await bal(buyer)).available_balance, 900000);
    });
    await test('paying with the wallet needs sign-in', async () => assert.strictEqual((await call('POST', '/api/checkout', cart(1, { payment: 'wallet' }))).s, 401));
    await test('full wallet payment: order is paid, wallet debited exactly the total, stock taken once', async () => {
      const s0 = await stockNow(), b0 = (await bal(buyer)).available_balance;
      const r = await call('POST', '/api/checkout', cart(2, { payment: 'wallet' }), buyer.cookie); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.next, 'wallet');
      const o = await orderRow(r.j.ref); assert.strictEqual(o.payment_status, 'paid'); assert.strictEqual(o.status, 'paid'); assert.strictEqual(Number(o.wallet_amount), o.total * 100);
      assert.strictEqual((await bal(buyer)).available_balance, b0 - o.total); assert.strictEqual(await stockNow(), s0 - 2);
      assert.strictEqual((await call('GET', '/api/wallet/transactions?type=purchases', null, buyer.cookie)).j.transactions[0].order_ref, r.j.ref);
      full = o;
    });
    await test('the same checkout key twice debits once', async () => {
      const k = crypto.randomUUID(), b0 = (await bal(buyer)).available_balance, body = cart(1, { payment: 'wallet', idempotencyKey: k });
      const rs = await Promise.all([call('POST', '/api/checkout', body, buyer.cookie), call('POST', '/api/checkout', body, buyer.cookie), call('POST', '/api/checkout', body, buyer.cookie)]);
      assert.ok(rs.every((r) => r.s === 200), rs.map((r) => r.s + ' ' + r.t).join(' | ')); assert.strictEqual(new Set(rs.map((r) => r.j.ref)).size, 1);
      const o = await orderRow(rs[0].j.ref); assert.strictEqual((await bal(buyer)).available_balance, b0 - o.total);
    });
    await test('an empty wallet is refused, the order is cancelled and stock is returned', async () => {
      const s0 = await stockNow(), r = await call('POST', '/api/checkout', cart(1, { payment: 'wallet' }), poor.cookie);
      assert.strictEqual(r.s, 402); assert.strictEqual(await stockNow(), s0);
    });
    let part;
    await test('split payment: wallet part is held, the gateway is asked for only the rest', async () => {
      await call('GET', '/api/wallet/fund/' + await fund(carol, 1000), null, carol.cookie);
      const r = await call('POST', '/api/checkout', cart(qtyFor(8000)), carol.cookie); assert.strictEqual(r.s, 200, r.t); // normal paystack order first, to learn the total
      await call('POST', `/api/orders/${r.j.ref}/cancel`, { token: r.j.token, email: undefined }, carol.cookie).catch(() => {});
      const r2 = await call('POST', '/api/checkout', cart(qtyFor(8000), { useWallet: true }), carol.cookie); assert.strictEqual(r2.s, 200, r2.t);
      assert.strictEqual(r2.j.next, 'paystack'); assert.strictEqual(r2.j.wallet_amount, 1000);
      const o = await orderRow(r2.j.ref); assert.strictEqual(Number(o.wallet_amount), 100000); assert.strictEqual(Number(o.charge_amount), o.total * 100 - 100000);
      assert.strictEqual(fx.amounts[r2.j.ref], o.total * 100 - 100000); // Paystack was asked for the remainder only
      const w = await bal(carol); assert.strictEqual(w.available_balance, 0); assert.strictEqual(w.pending_balance, 1000); assert.strictEqual(w.total_spent, 0);
      part = { ref: r2.j.ref, total: o.total };
    });
    await test('when the gateway part is paid, the held money becomes one purchase debit', async () => {
      fx.status[part.ref] = 'success'; await call('GET', '/api/paystack/verify?reference=' + part.ref);
      await until(async () => (await orderRow(part.ref)).payment_status === 'paid');
      const w = await bal(carol); assert.strictEqual(w.balance, 0); assert.strictEqual(w.pending_balance, 0); assert.strictEqual(w.total_spent, 1000);
      await call('GET', '/api/paystack/verify?reference=' + part.ref); await webhook(part.ref); await sleep(600);
      assert.strictEqual((await bal(carol)).total_spent, 1000);
    });
    await test('an unpaid split order that is cancelled releases the held money', async () => {
      await call('GET', '/api/wallet/fund/' + await fund(carol, 1000), null, carol.cookie);
      const r = await call('POST', '/api/checkout', cart(qtyFor(8000), { useWallet: true }), carol.cookie); assert.strictEqual(r.s, 200, r.t);
      assert.strictEqual((await bal(carol)).pending_balance, 1000);
      const id = (await orderRow(r.j.ref)).id; assert.strictEqual((await call('PUT', '/api/admin/orders/' + id, { status: 'cancelled' }, admin)).s, 200);
      const w = await bal(carol); assert.strictEqual(w.pending_balance, 0); assert.strictEqual(w.available_balance, 1000);
    });
    await test('refunding a wallet-paid order returns the wallet share once', async () => {
      const b0 = (await bal(buyer)).available_balance;
      assert.strictEqual((await call('PUT', '/api/admin/orders/' + full.id, { status: 'refunded' }, admin)).s, 200);
      assert.strictEqual((await bal(buyer)).available_balance, b0 + full.total);
      assert.strictEqual((await call('PUT', '/api/admin/orders/' + full.id, { status: 'refunded' }, admin)).s, 400);
      assert.strictEqual((await bal(buyer)).available_balance, b0 + full.total);
      assert.strictEqual((await call('GET', '/api/wallet/transactions?type=refunds', null, buyer.cookie)).j.transactions[0].order_ref, full.ref);
    });
    await test('points and wallet together: points reduce the total first, then the wallet pays the reduced amount', async () => {
      const dana = await register('Dana'); await call('GET', '/api/wallet/fund/' + await fund(dana, 900000), null, dana.cookie);
      await call('POST', `/api/admin/loyalty/customers/${dana.id}/adjust`, { points: 3000, reason: 'test', reference: 'DANA-1' }, admin);
      const pv = await call('POST', '/api/wallet/preview', { ...cart(2), usePoints: 2000 }, dana.cookie); assert.strictEqual(pv.s, 200, pv.t); assert.strictEqual(pv.j.loyalty_discount, 200); assert.strictEqual(pv.j.remaining_payment, 0);
      const b0 = (await bal(dana)).available_balance, r = await call('POST', '/api/checkout', { ...cart(2, { payment: 'wallet' }), usePoints: 2000 }, dana.cookie); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.next, 'wallet');
      const o = await orderRow(r.j.ref); assert.strictEqual(o.points_discount, 200); assert.strictEqual(o.payment_status, 'paid'); assert.strictEqual(Number(o.wallet_amount), o.total * 100);
      assert.strictEqual((await bal(dana)).available_balance, b0 - o.total); assert.strictEqual((await call('GET', '/api/loyalty', null, dana.cookie)).j.points, 1000);
      assert.strictEqual(pv.j.order_total, o.total);
    });
    console.log('Financial reports');
    const rep = async (u, c = admin) => call('GET', '/api/admin/finance' + u, null, c);
    await test('reports are for administrators only', async () => { for (const u of ['/summary', '/wallet', '/sales', '/rewards', '/gateways', '/wallet-transactions.csv']) assert.strictEqual((await rep(u, buyer.cookie)).s, 401, u); assert.strictEqual((await call('GET', '/api/admin/wallet/suspicious', null, buyer.cookie)).s, 401); });
    await test('wallet liability, funding, spending and refunds match the ledger', async () => {
      const w = (await rep('/wallet')).j, db = (await q("SELECT COALESCE(SUM(balance),0) b FROM ledger_accounts WHERE kind='customer_wallet'"))[0].b;
      assert.strictEqual(w.liability.total_wallet_balances, Number(db) / 100); assert.strictEqual(w.reconciliation.ok, true);
      const sumT = async (t) => Number((await q("SELECT COALESCE(SUM(amount),0) s FROM wallet_txns WHERE type=$1 AND status='completed'", [t]))[0].s) / 100;
      assert.strictEqual(w.funding.total, await sumT('deposit')); assert.strictEqual(w.spending.total, await sumT('purchase')); assert.strictEqual(w.refunds_to_wallet.total, await sumT('refund')); assert.ok(/not sales revenue/i.test(w.accounting_note));
      // money in = money out + what is still held
      assert.strictEqual(Math.round((w.funding.total + w.refunds_to_wallet.total + w.rewards_converted_to_wallet.total + w.adjustments.credits - w.spending.total - w.adjustments.debits) * 100) / 100, w.liability.total_wallet_balances);
    });
    await test('wallet top-ups never count as sales; sales split by how each order was paid', async () => {
      const s0 = (await rep('/sales')).j; await call('GET', '/api/wallet/fund/' + await fund(buyer, 12345), null, buyer.cookie);
      const s1 = (await rep('/sales')).j; assert.strictEqual(s1.sales_recognised, s0.sales_recognised); assert.strictEqual(s1.orders, s0.orders);
      const db = (await q("SELECT COALESCE(SUM(total),0) t, COALESCE(SUM(wallet_amount),0) w FROM orders WHERE payment_status='paid' AND status NOT IN ('refunded','cancelled')"))[0];
      assert.strictEqual(s1.sales_recognised, Number(db.t)); assert.strictEqual(s1.paid_from_wallet, Number(db.w) / 100);
      assert.strictEqual(Math.round((s1.paid_from_wallet + s1.paid_by_gateway_or_card + s1.paid_on_delivery) * 100) / 100, s1.sales_recognised);
    });
    await test('a date range limits the figures', async () => {
      const far = (await rep('/wallet?from=4000000000&to=4100000000')).j; assert.strictEqual(far.funding.total, 0); assert.strictEqual(far.spending.count, 0);
    });
    await test('gateway performance shows success rates for top-ups and order payments', async () => {
      const g = (await rep('/gateways')).j.wallet_funding_by_gateway.paystack; assert.ok(g.attempts >= 5 && g.success >= 1 && g.failed >= 1 && g.mismatch >= 1); assert.ok(g.success_rate > 0 && g.success_rate < 100);
    });
    await test('the rewards report shows points outstanding as a liability and checkout discounts', async () => {
      const r = (await rep('/rewards')).j; assert.ok('points_outstanding' in r && 'liability_value' in r && 'checkout_discounts' in r && Array.isArray(r.tier_distribution)); assert.ok(/liability/i.test(r.accounting_note));
    });
    await test('staff can review top-ups and spot suspicious ones (amount mismatch)', async () => {
      const f = (await call('GET', '/api/admin/wallet/funding?status=mismatch', null, admin)).j.funding; assert.ok(f.length >= 1 && f[0].status === 'mismatch');
      const s = (await call('GET', '/api/admin/wallet/suspicious', null, admin)).j; assert.ok(s.amount_mismatches.length >= 1); assert.ok('large_deposits_24h' in s);
    });
    await test('the wallet transactions CSV has one line per transaction and is safe to open in a spreadsheet', async () => {
      const r = await rep('/wallet-transactions.csv'); assert.strictEqual(r.s, 200); const lines = r.t.split('\n'); const n = Number((await q('SELECT COUNT(*) n FROM wallet_txns'))[0].n); assert.strictEqual(lines.length, n + 1);
      await call('POST', `/api/admin/wallet/customers/${buyer.id}/adjust`, { direction: 'credit', amount: 1, reason: '=HYPERLINK("http://evil")', reference: 'CSV-1' }, admin);
      const t2 = (await rep('/wallet-transactions.csv')).t; assert.ok(!/(^|,)"?[=+@-]\w*\(/m.test(t2) && t2.includes('"Adjustment: =HYPERLINK')); // text is quoted and never starts a cell with a formula character
    });
    await test('an administrator can switch top-ups off and on; customers cannot', async () => {
      assert.strictEqual((await call('PUT', '/api/admin/wallet/settings', { wallet_enabled: false }, ann.cookie)).s, 401);
      assert.strictEqual((await call('PUT', '/api/admin/wallet/settings', { wallet_enabled: false }, admin)).s, 200);
      assert.strictEqual((await call('GET', '/api/admin/wallet/settings', null, admin)).j.wallet_enabled, false);
      assert.strictEqual((await call('POST', '/api/wallet/fund', { amount: 1000 }, ann.cookie)).s, 503);
      assert.strictEqual((await bal(ann)).status, 'active'); // the balance is still visible and spendable
      assert.strictEqual((await call('PUT', '/api/admin/wallet/settings', { wallet_enabled: true }, admin)).s, 200);
      assert.strictEqual((await call('POST', '/api/wallet/fund', { amount: 1000 }, ann.cookie)).s, 200);
      assert.strictEqual((await call('PUT', '/api/admin/wallet/settings', { wallet_min_fund: 0 }, admin)).s, 400);
      assert.strictEqual((await call('PUT', '/api/admin/wallet/settings', { card_enabled: true }, admin)).s, 400); // no issuer connected
    });
    await test('the books still balance after all of that', async () => { const r = (await call('GET', '/api/admin/wallet/reconcile', null, admin)).j; assert.strictEqual(r.ok, true, JSON.stringify(r)); });
  } finally {
    app.kill(); fake.close(); await sleep(300);
    await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log(app.log.slice(-1500)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
