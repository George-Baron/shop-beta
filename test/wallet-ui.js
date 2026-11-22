'use strict';
// Browser smoke test of the VELTO account tabs and the checkout wallet box (needs playwright + Chromium).
// Run with: npm run test:wallet-ui   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_wui_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const FAKE = 4900 + Math.floor(Math.random() * 90), P1 = FAKE + 100;
const PAYKEY = 'sk_test_wallet';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wui-'));
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
    let chromium; try { ({ chromium } = require('playwright')); } catch { console.log('playwright is not installed: skipping'); process.exit(0); }
    const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'OwnerPass123' })).c;
    const ann = await register('Ann');
    const prod = (await q('SELECT id FROM products WHERE active=1 AND stock>=30 AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 1'))[0];
    const ref = await fund(ann, 3000); await call('GET', '/api/wallet/fund/' + ref, null, ann.cookie);
    const browser = await chromium.launch(); const ctx = await browser.newContext(); const base = 'http://127.0.0.1:' + P1;
    await ctx.addCookies([{ name: ann.cookie.split('=')[0], value: ann.cookie.split('=').slice(1).join('=').split(';')[0], url: base }]);
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript((id) => { localStorage.setItem('sb_cart', JSON.stringify([{ productId: id, variantId: null, qty: 1 }])); }, prod.id);
    console.log('Browser');
    for (const [tab, text] of [['overview', 'Add money'], ['wallet', 'Add money'], ['rewards', 'Points balance'], ['card', 'coming soon']]) {
      await test('account tab ' + tab + ' renders', async () => { await page.goto(`${base}/account?tab=${tab}`); await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), text, { timeout: 8000 }); });
    }
    await test('the account Overview shows the wallet, rewards and card as cards', async () => { await page.goto(`${base}/account?tab=overview`); await page.waitForSelector('.vcards .vc', { timeout: 8000 }); assert.strictEqual(await page.locator('.vcards .vc').count(), 3); assert.ok(await page.locator('.vc-wallet').count() === 1 && await page.locator('.vc-soon').count() === 1, 'wallet card and a coming-soon card (no number) are shown'); if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/overview.png', fullPage: true }); });
    await test('the Rewards and Wallet tabs lead with their card', async () => { await page.goto(`${base}/account?tab=rewards`); await page.waitForSelector('.vc[class*=vc-bronze], .vc[class*=vc-silver], .vc[class*=vc-gold], .vc[class*=vc-platinum]', { timeout: 8000 }); await page.goto(`${base}/account?tab=wallet`); await page.waitForSelector('.vc-wallet', { timeout: 8000 }); });
    await test('returning from Paystack shows the verified top-up', async () => {
      const r2 = await fund(ann, 1000); await page.goto(`${base}/account?tab=wallet&wallet=${r2}`); await page.waitForFunction(() => document.body.innerText.includes('₦4,000'), null, { timeout: 8000 });
    });
    await test('checkout offers the wallet and shows the split', async () => {
      await page.goto(`${base}/checkout`); await page.waitForSelector('#vwal', { timeout: 10000 }); await page.check('#vwal');
      await page.waitForFunction(() => document.querySelector('#vbox').innerText.includes('From wallet'), null, { timeout: 8000 });
    });
    await test('no script errors on those pages', async () => assert.deepStrictEqual(errs, []));
    const actx = await browser.newContext(); await actx.addCookies([{ name: admin.split('=')[0], value: admin.split('=').slice(1).join('=').split(';')[0], url: base }]);
    const ap = await actx.newPage(); const aerrs = []; ap.on('pageerror', (e) => aerrs.push(e.message));
    await test('admin Wallet and rewards page shows the books check, settings and campaigns', async () => { await ap.goto(`${base}/admin#/wallet`); await ap.waitForFunction(() => document.body.innerText.includes('Are the books balanced') && document.body.innerText.includes('Rewards settings') && document.body.innerText.includes('New campaign'), null, { timeout: 10000 }); assert.ok((await ap.innerText('body')).includes('Yes')); });
    await test('admin can open a customer wallet and see its transactions', async () => { await ap.fill('#wcid', String(ann.id)); await ap.click('#wcgo'); await ap.waitForFunction(() => document.body.innerText.toLowerCase().includes('recent transactions'), null, { timeout: 8000 }); assert.ok(await ap.locator('#wcbox .vc').count() >= 1, 'the customer wallet shows as a card'); if (process.env.SHOTS) await ap.screenshot({ path: process.env.SHOTS + '/admin.png', fullPage: true }); });
    await test('admin can save rewards settings', async () => { await ap.click('#lcsave'); await ap.waitForFunction(() => document.body.innerText.includes('Saved'), null, { timeout: 5000 }); });
    await test('admin card page loads', async () => { await ap.goto(`${base}/admin#/cards`); await ap.waitForFunction(() => document.body.innerText.includes('Applications'), null, { timeout: 10000 }); });
    await test('admin can paste many categories under a department and create them', async () => {
      const st = (await q("SELECT name FROM stores WHERE slug <> 'pharmacy' ORDER BY sort LIMIT 1"))[0].name;
      await ap.goto(`${base}/admin#/categories`); await ap.waitForSelector('#bulkc', { timeout: 10000 }); await ap.click('#bulkc');
      await ap.fill('#bct', `Department\tCategory\n${st}\tPaste Test Aisle\n${st}\tFlour, Sugar & Paste Test\nNo Such Dept\tNope`); await ap.click('#bcc');
      await ap.waitForFunction(() => document.querySelector('#bcp').innerText.includes('2 new categories'), null, { timeout: 8000 });
      await ap.click('#bcg'); await ap.waitForFunction(() => document.body.innerText.includes('Paste Test Aisle'), null, { timeout: 8000 });
      assert.strictEqual(Number((await q("SELECT COUNT(*) n FROM categories WHERE name IN ('Paste Test Aisle','Flour, Sugar & Paste Test')"))[0].n), 2);
    });
    await test('no script errors on the admin pages', async () => assert.deepStrictEqual(aerrs, []));
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
