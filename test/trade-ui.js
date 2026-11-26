'use strict';
// Browser smoke test of the public Import & Export page and the admin enquiries inbox (needs playwright + Chromium).
// Run with: npm run test:trade-ui   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_tui_' + Date.now().toString(36);
const URL_DB = ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + DB + '$1');
const FAKE = 4900 + Math.floor(Math.random() * 90), P1 = FAKE + 100;
const PAYKEY = 'sk_test_wallet';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tui-'));
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
    const browser = await chromium.launch(); const base = 'http://127.0.0.1:' + P1;
    const mk = async (cookie, vp) => { const c = await browser.newContext(vp ? { viewport: vp } : {}); if (cookie) await c.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('=').split(';')[0], url: base }]); const p = await c.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); return { p, errs }; };
    const reg = await call('POST', '/api/auth/register', { name: 'Chidi Okafor', email: 'chidi.ui@example.com', phone: '08031234567', password: 'mango-river-sky-55' }); const member = reg.c;
    const guest = await mk(null), visitor = await mk(member), admin = await mk(owner), phone = await mk(member, { width: 375, height: 700 });   // the page and form are for registered customers
    const txt = (p, t) => p.waitForFunction((x) => document.body.innerText.includes(x), t, { timeout: 10000 });
    console.log('Public page');
    await test('a guest sees a sign-in wall instead of the form, with a way back after signing in', async () => {
      await guest.p.goto(`${base}/import-export`); await txt(guest.p, 'This is for registered customers');
      assert.strictEqual(await guest.p.locator('#tf').count(), 0); assert.ok((await guest.p.getAttribute('a[href^="/login?next="]', 'href')).includes('import-export'));
    });
    await test('the page is live, not a placeholder, with Import and Export sections and the form', async () => {
      await visitor.p.goto(`${base}/import-export`); await txt(visitor.p, 'Send us an enquiry'); const t = await visitor.p.innerText('body');
      assert.ok(!/under construction/i.test(t)); for (const w of ['📥 Import', '📤 Export', 'How it works', 'Questions']) assert.ok(t.includes(w), w);
      assert.ok((await visitor.p.title()).startsWith('Import & Export')); const h = await visitor.p.evaluate(() => document.documentElement.innerHTML);
      assert.ok(!/noindex/.test(await (await fetch(`${base}/import-export`)).text()), 'indexable'); assert.ok(h.includes('id="tf"'));
    });
    await test('switching Import / Export changes the questions and the how-it-works steps', async () => {
      assert.ok((await visitor.p.innerText('#tcl')).includes('come from')); await visitor.p.check('input[name=tk][value=export]'); assert.ok((await visitor.p.innerText('#tcl')).includes('go to')); assert.ok((await visitor.p.innerText('#til')).includes('Which products'));
      await visitor.p.click('[data-how=export]'); await txt(visitor.p, 'We check what is possible'); await visitor.p.click('[data-how=import]'); await txt(visitor.p, 'We come back with a plan');
      await visitor.p.goto(`${base}/import-export?type=export`); await visitor.p.waitForSelector('#tf'); assert.strictEqual(await visitor.p.isChecked('input[name=tk][value=export]'), true, '?type=export preselects Export');
    });
    await test('an incomplete form shows a plain message and sends nothing', async () => {
      await visitor.p.fill('#tn', ''); await visitor.p.click('#tsend'); await txt(visitor.p, 'Please tell us your name'); assert.strictEqual(Number((await q('SELECT COUNT(*) n FROM trade_enquiries'))[0].n), 0);
    });
    await test('a complete import enquiry is sent: thank-you with a reference, saved, and the honeypot is invisible', async () => {
      await visitor.p.goto(`${base}/import-export`); await visitor.p.waitForSelector('#tf');
      assert.ok(await visitor.p.evaluate(() => { const r = document.querySelector('#tw').getBoundingClientRect(); return r.right < 0 || (r.width <= 1 && r.height <= 1); }), 'the trap field is off-screen');
      await visitor.p.fill('#tn', 'Chidi Okafor'); await visitor.p.fill('#te', 'chidi@example.com'); await visitor.p.fill('#tco', 'China'); await visitor.p.fill('#tit', 'Solar water pumps'); await visitor.p.fill('#tq', '40 units'); await visitor.p.selectOption('#ts', 'sea'); await visitor.p.fill('#td', 'Two inch surface pumps with a one year warranty.');
      await visitor.p.click('#tsend'); await txt(visitor.p, 'we have your enquiry'); const ref = await visitor.p.innerText('#tref'); assert.ok(/^TE-[0-9A-F]{8}$/.test(ref));
      const row = (await q('SELECT * FROM trade_enquiries WHERE ref=$1', [ref]))[0]; assert.strictEqual(row.kind, 'import'); assert.strictEqual(row.shipping, 'sea'); assert.strictEqual(row.item, 'Solar water pumps');
    });
    await test('an export enquiry from a phone-sized screen works and the page does not scroll sideways', async () => {
      await phone.p.goto(`${base}/import-export?type=export`); await phone.p.waitForSelector('#tf');
      assert.ok(await phone.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll');
      await phone.p.fill('#tn', 'Amina Yusuf'); await phone.p.fill('#te', 'amina@example.com'); await phone.p.fill('#tco', 'Ghana'); await phone.p.fill('#tit', 'Shea butter, 500 kg'); await phone.p.fill('#td', 'Raw, unrefined, packed in 25 kg bags.'); await phone.p.click('#tsend'); await txt(phone.p, 'we have your enquiry');
      assert.strictEqual((await q("SELECT kind FROM trade_enquiries WHERE email='amina@example.com'"))[0].kind, 'export');
    });
    console.log('Admin inbox');
    await test('the owner sees both enquiries in the inbox and can update one', async () => {
      await admin.p.goto(`${base}/admin#/tradeenq`); await admin.p.waitForSelector('[data-te]').catch(async () => { console.log((await admin.p.innerText('body')).slice(0, 600)); }); await txt(admin.p, 'Solar water pumps'); await txt(admin.p, 'Shea butter');
      await admin.p.click('[data-te]:has-text("Solar water pumps")'); await txt(admin.p, 'Internal note'); await admin.p.selectOption('#te-s', 'quoted'); await admin.p.fill('#te-n', 'Quote sent by email.'); await admin.p.click('#te-save');
      await until(async () => (await q("SELECT status FROM trade_enquiries WHERE item='Solar water pumps'"))[0].status === 'quoted'); await txt(admin.p, 'Quote sent');
    });
    await test('no script errors anywhere', async () => { assert.deepStrictEqual(visitor.errs, []); assert.deepStrictEqual(phone.errs, []); assert.deepStrictEqual(admin.errs, []); });
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
