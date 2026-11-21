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
      await Promise.all([webhook(ref), webhook(ref), call('GET', '/api/wallet/fund/' + ref, null, bob.cookie), call('GET', '/api/wallet/fund/' + ref, null, bob.cookie)]);
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
  } finally {
    app.kill(); fake.close(); await sleep(300);
    await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log(app.log.slice(-1500)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
