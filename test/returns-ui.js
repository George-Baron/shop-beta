'use strict';
// Browser smoke test of the returns screens: admin retail and wholesale returns, the Open-a-return forms, and the buyer's return panel (needs playwright + Chromium).
// Run with: npm run test:returns-ui   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_rui_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const FAKE = 4900 + Math.floor(Math.random() * 90), P1 = FAKE + 100;
const PAYKEY = 'sk_test_wallet';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rui-'));
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(200); } };

// The fake Paystack: what it says about each reference is set by the test.
const fx = { refunds: [] };
const fake = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const send = (s, o) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/emails') return send(200, { id: 'x' });
    if (req.url === '/refund') { fx.refunds.push(JSON.parse(Buffer.concat(c).toString())); return send(200, { status: true, data: { id: 'rf_' + fx.refunds.length, status: 'pending' } }); }
    send(404, {});
  });
});
const q = async (sql, args) => { const c = new Pg({ connectionString: URL_DB }); await c.connect(); try { return (await c.query(sql, args)).rows; } finally { await c.end(); } };
const pg = async (sql) => { const c = new Pg({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const call = async (method, url, body, cookie, headers = {}) => { const raw = body === undefined || body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)); const r = await fetch(`http://127.0.0.1:${P1}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw }); const sc = r.headers.getSetCookie ? r.headers.getSetCookie()[0] || '' : ''; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, t, c: sc.split(';')[0] }; };
const up = async () => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${P1}/health`); return; } catch { await sleep(100); } } throw new Error('app did not start'); };

let n = 0;
const register = async (name) => { const email = `w${Date.now().toString(36)}${n++}@example.com`; const r = await call('POST', '/api/auth/register', { name, email, phone: '0803' + String(1000000 + n * 7919).slice(0, 7), password: 'Velt0-Wallet-Qx7' }); assert.strictEqual(r.s, 200, 'register ' + r.t); return { email, cookie: r.c, id: Number((await q('SELECT id FROM users WHERE email=$1', [email]))[0].id) }; };

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  await pg(`CREATE DATABASE ${DB}`);
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(P1), BASE_URL: 'http://127.0.0.1:' + P1, DATABASE_URL: URL_DB, DATABASE_SSL: 'off', DATA_DIR: DATA, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'OwnerPass123', PAYSTACK_SECRET_KEY: PAYKEY, PAYSTACK_API_URL: 'http://127.0.0.1:' + FAKE, RESEND_API_KEY: '', RATE_LIMIT_MULTIPLIER: '100', WORKER_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.log = ''; app.stdout.on('data', (d) => { app.log += d; }); app.stderr.on('data', (d) => { app.log += d; });
  try {
    await up();
    let chromium; try { ({ chromium } = require('playwright')); } catch { console.log('playwright is not installed: skipping'); process.exit(0); }
    const owner = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' })).c;
    const ann = await register('Ann Buyer'), T = Math.floor(Date.now() / 1000);
    const prod = (await q('SELECT id, name FROM products WHERE active=1 ORDER BY id LIMIT 1'))[0];
    // a delivered, paid retail order and a delivered, paid wholesale quote for Ann
    const oid = Number((await q("INSERT INTO orders (ref,user_id,status,payment_method,payment_status,paystack_ref,name,email,phone,state,delivery_fee,subtotal,discount,total,created,access_token,delivered_at,wallet_amount) VALUES ('UI-RET1',$1,'delivered','paystack','paid','PSREF-UI1','Ann Buyer',$2,'08031234567','Lagos',1000,5000,0,6000,$3,'tokuiret1xxxxxxxxxxxxxxxxxxxx',$3,0) RETURNING id", [ann.id, ann.email, T - 86400]))[0].id);
    await q('INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES ($1,$2,$3,5000,1)', [oid, prod.id, prod.name]);
    const wa = Number((await q("INSERT INTO wholesale_accounts (user_id,business_name,contact_name,email,status,evaluate_until,created) VALUES ($1,'Bright Traders','Ann Buyer',$2,'approved',1,1) RETURNING id", [ann.id, ann.email]))[0].id);
    const wq = Number((await q("INSERT INTO wholesale_quotes (ref,account_id,status,goods_total,logistics_fee,total,payment_method,payment_ref,order_no,created,delivered_at) VALUES ('WQ-UI0001',$1,'delivered',50000,1000,51000,'paystack','WQ-UI0001','WO-UI0001',1,$2) RETURNING id", [wa, T - 86400]))[0].id);
    await q("INSERT INTO wholesale_quote_items (quote_id,product_id,name,qty,list_price,unit_price) VALUES ($1,$2,$3,10,6000,5000)", [wq, prod.id, prod.name]);
    const browser = await chromium.launch(); const base = 'http://127.0.0.1:' + P1;
    const mk = async (cookie) => { const c = await browser.newContext(); await c.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('=').split(';')[0], url: base }]); const p = await c.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); return { p, errs }; };
    const buyer = await mk(ann.cookie), admin = await mk(owner);
    const txt = (p, t) => p.waitForFunction((x) => document.body.innerText.includes(x), t, { timeout: 10000 });
    console.log('Buyer');
    await test('the buyer sees a Return goods panel on a delivered wholesale order and can send a request', async () => {
      await buyer.p.goto(`${base}/wholesale/quote/WQ-UI0001`); await txt(buyer.p, 'Return goods'); await buyer.p.fill('[data-wrq]', '3'); await buyer.p.fill('#wrd', 'Three of them arrived cracked.'); await buyer.p.click('#wrgo');
      await txt(buyer.p, 'Waiting for review'); assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM wholesale_returns WHERE status='requested'"))[0].n), 1);
    });
    await test('the buyer can cancel it again, and the panel offers a new request', async () => {
      buyer.p.once('dialog', (d) => d.accept()); await buyer.p.click('[data-wrc]'); await txt(buyer.p, 'Ask to return'); assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM wholesale_returns WHERE status='cancelled'"))[0].n), 1);
    });
    console.log('Admin');
    await test('the Returns page shows retail and wholesale sections and both Open buttons', async () => {
      await admin.p.goto(`${base}/admin#/returns`); await txt(admin.p, 'Wholesale returns'); await admin.p.waitForSelector('#ropen'); await admin.p.waitForSelector('#wropen');
    });
    await test('opening a retail return for a customer from the form works and shows "Opened by" in the review', async () => {
      await admin.p.click('#ropen'); await admin.p.fill('#ro-ref', 'UI-RET1'); await admin.p.click('#ro-find'); await admin.p.waitForSelector('[data-roq]'); await admin.p.fill('[data-roq]', '1'); await admin.p.fill('#ro-det', 'Customer phoned: it does not switch on.'); await admin.p.fill('#ro-note', 'Phone call'); await admin.p.click('#ro-go');
      await txt(admin.p, 'Return opened'); await admin.p.waitForSelector('[data-ret]'); await admin.p.click('[data-ret]'); await txt(admin.p, 'Your decision'); await txt(admin.p, 'Opened by'); await txt(admin.p, 'Approve and refund');
    });
    await test('the owner approves and the Paystack refund goes out automatically', async () => {
      await admin.p.click('#rap'); await txt(admin.p, 'refunded automatically'); await until(async () => fx.refunds.length === 1); assert.strictEqual(fx.refunds[0].transaction, 'PSREF-UI1'); assert.strictEqual(fx.refunds[0].amount, 600000);
      assert.strictEqual((await q("SELECT status FROM order_returns"))[0].status, 'settled');
    });
    await test('opening a wholesale return for a buyer works, the owner approves, and Paystack refunds the goods only', async () => {
      await admin.p.goto(`${base}/admin#/returns`); await admin.p.waitForSelector('#wropen'); await admin.p.click('#wropen'); await admin.p.fill('#wo-ref', 'WQ-UI0001'); await admin.p.click('#wo-find'); await admin.p.waitForSelector('[data-woq]');
      await admin.p.fill('[data-woq]', '2'); await admin.p.fill('#wo-det', 'Agreed by phone with the buyer.'); await admin.p.click('#wo-go'); await txt(admin.p, 'Return opened');
      await admin.p.waitForSelector('[data-wret]'); await admin.p.click('[data-wret]'); await txt(admin.p, 'Your decision'); await admin.p.click('#wrap'); await txt(admin.p, 'refunded automatically');
      await until(async () => fx.refunds.length === 2); assert.strictEqual(fx.refunds[1].transaction, 'WQ-UI0001'); assert.strictEqual(fx.refunds[1].amount, 1000000);
    });
    await test('no script errors anywhere', async () => { assert.deepStrictEqual(buyer.errs, []); assert.deepStrictEqual(admin.errs, []); });
    await browser.close();
  } finally {
    app.kill(); fake.close(); await sleep(300);
    await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log(app.log.slice(-1500)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
