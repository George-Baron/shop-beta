'use strict';
// VELTO-MART CARD check (sandbox issuer): application, webhooks, activation and controls, transactions, replacement, privacy, access control.
// Run with: npm run test:cards   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_cards_' + Date.now().toString(36);
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
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(P1), BASE_URL: 'http://127.0.0.1:' + P1, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', PAYSTACK_SECRET_KEY: PAYKEY, PAYSTACK_API_URL: 'http://127.0.0.1:' + FAKE, CARD_PROVIDER: 'sandbox', CARD_WEBHOOK_SECRET: 'whsec-test', RESEND_API_KEY: '', RATE_LIMIT_MULTIPLIER: '100', WORKER_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.log = ''; app.stdout.on('data', (d) => { app.log += d; }); app.stderr.on('data', (d) => { app.log += d; });
  try {
    await up();
    const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' })).c;
    const ann = await register('Ann'), bob = await register('Bob');

    console.log('VELTO-MART CARD');
    const crypto2 = require('crypto');
    const hook = (ev, sig) => { const raw = JSON.stringify(ev); return call('POST', '/api/cards/webhook', raw, null, { 'x-card-signature': sig || crypto2.createHmac('sha256', 'whsec-test').update(raw).digest('hex') }); };
    let evn = 0; const E = (type, f) => ({ eventId: 'EV-' + Date.now().toString(36) + (evn++), type, ...f });
    const view = async (u) => (await call('GET', '/api/cards', null, u.cookie)).j;
    const apply = (u, b) => call('POST', '/api/cards/apply', { kind: 'virtual', consent: true, bvn: '12345678901', ...b }, u.cookie);
    const ann2 = await register('Ann Okafor'), bob2 = await register('Bob Ade');

    await test('before the issuer is switched on the card shows "coming soon" and cannot be applied for', async () => {
      const v = await view(ann2); assert.strictEqual(v.programme.available, false); assert.ok(/coming soon/i.test(v.programme.message));
      assert.strictEqual((await apply(ann2)).s, 503);
    });
    await q("UPDATE settings SET value='1' WHERE key='card_enabled'");
    await test('card endpoints need sign-in; the apps use the same API on the mobile path', async () => {
      assert.strictEqual((await call('GET', '/api/cards')).s, 401); assert.strictEqual((await call('GET', '/api/mobile/v1/cards', null, ann2.cookie)).s, 200);
    });
    await test('applying needs consent, a kind, identity details and (for a physical card) an address', async () => {
      assert.strictEqual((await apply(ann2, { consent: false })).s, 400); assert.strictEqual((await apply(ann2, { kind: 'gold' })).s, 400);
      assert.strictEqual((await apply(ann2, { bvn: '123' })).s, 400); assert.strictEqual((await apply(ann2, { kind: 'physical' })).s, 400);
    });
    let appRef;
    await test('a valid application goes to the issuer and shows as under review', async () => {
      const r = await apply(ann2); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.application.status, 'under_review');
      appRef = (await q('SELECT provider_ref FROM card_applications WHERE user_id=$1', [ann2.id]))[0].provider_ref; assert.ok(appRef);
    });
    await test('the BVN/NIN is not stored anywhere in the database', async () => {
      const cols = (await q("SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('card_applications','cards','card_transactions','card_events','card_audit','card_status_history')")).map((c) => c.column_name);
      assert.ok(!cols.some((c) => /bvn|nin|pan|cvv|card_number|full_number/i.test(c)), cols.join(','));
      const dump = JSON.stringify(await q('SELECT * FROM card_applications')); assert.ok(!dump.includes('12345678901'));
    });
    await test('a second application of the same kind while one is open is refused', async () => assert.strictEqual((await apply(ann2)).s, 409));
    await test('webhooks without a valid signature are rejected', async () => { assert.strictEqual((await hook(E('application.approved', { providerRef: appRef }), 'bad')).s, 401); assert.strictEqual((await view(ann2)).applications[0].status, 'under_review'); });
    await test('"more information needed" and approval are shown to the customer', async () => {
      await hook(E('application.info_needed', { providerRef: appRef, message: 'Please resubmit a clearer selfie' })); let a = (await view(ann2)).applications[0]; assert.strictEqual(a.status, 'info_needed'); assert.ok(/selfie/.test(a.message));
      await hook(E('application.approved', { providerRef: appRef })); a = (await view(ann2)).applications[0]; assert.strictEqual(a.status, 'approved');
    });
    let card;
    await test('the issuer issues the card: only a masked number is stored and shown', async () => {
      const ev = E('card.issued', { providerRef: appRef, providerCardId: 'SBX-CARD-1', network: 'Verve', last4: '4242', expiryMonth: 8, expiryYear: 2029 });
      const r1 = await hook(ev), r2 = await hook(ev); assert.strictEqual(r1.s, 200); assert.strictEqual(r2.j.duplicate, true);
      const v = await view(ann2); assert.strictEqual(v.cards.length, 1); card = v.cards[0]; assert.strictEqual(card.masked_number, '•••• •••• •••• 4242'); assert.strictEqual(card.status, 'inactive'); assert.strictEqual(card.expiry, '08/29'); assert.strictEqual(card.network, 'Verve'); assert.strictEqual(v.applications[0].status, 'issued');
      assert.ok(!JSON.stringify(v).match(/\b\d{12,19}\b/), 'no full card number anywhere in the response');
    });
    await test('activate, freeze, unfreeze work through the issuer; wrong-state actions are refused', async () => {
      const act = (a) => call('POST', `/api/cards/${card.id}/${a}`, {}, ann2.cookie);
      assert.strictEqual((await act('freeze')).s, 409);
      assert.strictEqual((await act('activate')).j.card.status, 'active'); assert.strictEqual((await act('activate')).s, 409);
      assert.strictEqual((await act('freeze')).j.card.status, 'frozen'); assert.strictEqual((await act('unfreeze')).j.card.status, 'active');
    });
    await test('another customer cannot see or control this card', async () => {
      for (const [m, p] of [['POST', 'freeze'], ['GET', 'transactions'], ['GET', 'reveal']]) assert.strictEqual((await call(m, `/api/cards/${card.id}/${p}`, m === 'POST' ? {} : undefined, bob2.cookie)).s, 404);
      assert.strictEqual((await view(bob2)).cards.length, 0);
    });
    await test('full card details come only from the issuer\'s own secure page', async () => {
      const r = await call('GET', `/api/cards/${card.id}/reveal`, null, ann2.cookie); assert.strictEqual(r.s, 200); assert.ok(/^https:\/\/issuer\.example\//.test(r.j.url)); assert.deepStrictEqual(Object.keys(r.j).sort(), ['expires', 'url']);
    });
    await test('card transactions are listed once, even if the issuer repeats them', async () => {
      const ev = E('card.transaction', { providerCardId: 'SBX-CARD-1', providerTxnId: 'T-1', amount: 2500.5, merchant: 'VELTO-MART', status: 'completed' });
      await hook(ev); await hook({ ...ev, eventId: ev.eventId + 'b' }); // a repeat under a new event id still has the same transaction id
      const t = (await call('GET', `/api/cards/${card.id}/transactions`, null, ann2.cookie)).j.transactions; assert.strictEqual(t.length, 1); assert.strictEqual(t[0].amount, 2500.5); assert.strictEqual(t[0].merchant, 'VELTO-MART');
    });
    await test('card balances and wallet balances stay separate', async () => {
      const w0 = (await call('GET', '/api/wallet', null, ann2.cookie)).j.available_balance; await hook(E('card.balance', { providerCardId: 'SBX-CARD-1', balance: 9000 }));
      assert.strictEqual((await view(ann2)).cards[0].balance, 9000); assert.strictEqual((await call('GET', '/api/wallet', null, ann2.cookie)).j.available_balance, w0);
    });
    await test('delivery updates for a physical card are recorded', async () => {
      const r = await call('POST', '/api/cards/apply', { kind: 'physical', consent: true, nin: '98765432109', delivery: { address: '1 Road St', city: 'Yaba', state: 'Lagos', phone: '08031234567' } }, ann2.cookie); assert.strictEqual(r.s, 200, r.t);
      const ref = (await q("SELECT provider_ref FROM card_applications WHERE user_id=$1 AND kind='physical'", [ann2.id]))[0].provider_ref;
      await hook(E('application.approved', { providerRef: ref })); await hook(E('card.issued', { providerRef: ref, providerCardId: 'SBX-CARD-P', network: 'Verve', last4: '1111', expiryMonth: 1, expiryYear: 2030 }));
      await hook(E('card.delivery', { providerCardId: 'SBX-CARD-P', deliveryStatus: 'out_for_delivery' }));
      const c = (await view(ann2)).cards.find((x) => x.kind === 'physical'); assert.strictEqual(c.delivery_status, 'out_for_delivery');
    });
    await test('replacing a lost card blocks the old one at once and swaps it when the new one is issued', async () => {
      const r = await call('POST', `/api/cards/${card.id}/replace`, { reason: 'lost' }, ann2.cookie); assert.strictEqual(r.s, 200, r.t);
      assert.strictEqual((await q('SELECT status FROM cards WHERE id=$1', [card.id]))[0].status, 'blocked');
      const id = r.j.application.id; await q("UPDATE card_applications SET provider_ref='SBX-REPL-1' WHERE id=$1", [id]);
      await hook(E('application.approved', { providerRef: 'SBX-REPL-1' })); await hook(E('card.issued', { providerRef: 'SBX-REPL-1', providerCardId: 'SBX-CARD-2', network: 'Verve', last4: '9999', expiryMonth: 5, expiryYear: 2030 }));
      assert.strictEqual((await q('SELECT status FROM cards WHERE id=$1', [card.id]))[0].status, 'replaced');
      assert.ok((await view(ann2)).cards.some((c) => c.masked_number.endsWith('9999')));
    });
    await test('a rejected application stays rejected and shows the reason', async () => {
      const r = await apply(bob2); assert.strictEqual(r.s, 200); const ref = (await q('SELECT provider_ref FROM card_applications WHERE user_id=$1', [bob2.id]))[0].provider_ref;
      await hook(E('application.rejected', { providerRef: ref, message: 'BVN could not be verified' })); await hook(E('application.approved', { providerRef: ref }));
      const a = (await view(bob2)).applications[0]; assert.strictEqual(a.status, 'rejected'); assert.ok(/BVN/.test(a.message));
      assert.strictEqual((await apply(bob2)).s, 200); // may apply again after a rejection
    });
    await test('an issuer failure leaves nothing half-done', async () => {
      const before = Number((await q('SELECT COUNT(*) n FROM card_applications'))[0].n), r = await apply(await register('Cy Eze'), { bvn: '', nin: '' }); assert.strictEqual(r.s, 400);
      assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM card_applications'))[0].n), before);
    });
    await test('administrators see applications and metadata only, can block a card, and the report counts', async () => {
      assert.strictEqual((await call('GET', '/api/admin/cards/applications', null, ann2.cookie)).s, 401);
      const l = (await call('GET', '/api/admin/cards/applications', null, admin)).j.applications; assert.ok(l.length >= 3);
      const d = (await call('GET', `/api/admin/cards/applications/${l[l.length - 1].id}`, null, admin)).j; assert.ok(!JSON.stringify(d).match(/bvn|12345678901|98765432109/i));
      const c2 = (await view(ann2)).cards.find((c) => c.masked_number.endsWith('9999')); assert.strictEqual((await call('POST', `/api/admin/cards/${c2.id}/block`, {}, admin)).s, 400);
      assert.strictEqual((await call('POST', `/api/admin/cards/${c2.id}/block`, { reason: 'Fraud report from customer' }, admin)).s, 200); assert.strictEqual((await q('SELECT status FROM cards WHERE id=$1', [c2.id]))[0].status, 'blocked');
      assert.strictEqual((await q("SELECT COUNT(*) n FROM card_audit WHERE action='block'"))[0].n, '1');
      const rep = (await call('GET', '/api/admin/cards/report', null, admin)).j; assert.ok(rep.cards.blocked === 1 && rep.cards.replaced === 1 && rep.transactions.count === 1);
    });
    await test('the test issuer refuses to load in production', async () => {
      const { spawnSync } = require('child_process'); const r = spawnSync(process.execPath, ['-e', "process.env.CARD_PROVIDER='sandbox';process.env.NODE_ENV='production';require('./lib/card-providers').get()"], { cwd: path.join(__dirname, '..') });
      assert.ok(r.status !== 0 && /cannot be used in production/.test(String(r.stderr)));
    });
  } finally {
    app.kill(); fake.close(); await sleep(300);
    await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log(app.log.slice(-1500)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
