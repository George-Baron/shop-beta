'use strict';
// Phone / browser alerts (Web Push), against a local stand-in for the browser's push service.
// Run with: npm run test:push   (needs TEST_DATABASE_URL like the other tests)
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_push_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500);
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
const until = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(200); } throw new Error('timed out waiting'); };
const call = async (method, url, body, cookie) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined || body === null || method === 'GET' ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t, h: r.headers, c: (sc[0] || '').split(';')[0] };
};
const b64u = (b) => Buffer.from(b).toString('base64url');
const device = () => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64u(e.getPublicKey()), auth: b64u(crypto.randomBytes(16)) }; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem', '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const got = [];
  const push = https.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, (req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => { got.push({ url: req.url, h: req.headers, n: Buffer.concat(chunks).length }); res.writeHead(req.url.startsWith('/gone') ? 410 : 201); res.end(); });
  });
  await new Promise((r) => push.listen(0, '127.0.0.1', r)); const PP = push.address().port, EP = (n) => `https://127.0.0.1:${PP}/${n}`;
  const keys = require('web-push').generateVAPIDKeys();
  await pg(`CREATE DATABASE ${DB}`);
  let srv, log = '';
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: os.tmpdir() + '/sb-push-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50', WORKER_POLL_MS: '200', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:test@example.com', NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
    const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' })).c;
    const role = (await call('GET', '/api/admin/staff', null, admin)).j.roles[0].id;
    const mk = async (key) => { const r = await call('POST', '/api/admin/staff', { name: key, email: key + '@example.com', username: key + '.u', role_id: role }, admin); assert.strictEqual(r.s, 200, r.t); return (await call('POST', '/api/auth/login', { email: key + '@example.com', password: r.j.temp_password })).c; };
    const ann = await mk('annstaff'), bob = await mk('bobstaff');
    const announce = () => call('POST', '/api/admin/announce', { audience: 'staff', title: 'Stock check at 5pm', body: 'Please be ready' }, admin);

    console.log('\nSetting up');
    await test('the shop shares its public key, and the service worker is served from the root', async () => {
      const r = await call('GET', '/api/notifications/push', null, ann); assert.strictEqual(r.j.enabled, true); assert.strictEqual(r.j.key, keys.publicKey); assert.strictEqual(r.j.devices, 0);
      assert.strictEqual((await call('GET', '/api/notifications/push')).s, 401, 'signed-out people are refused');
      const sw = await call('GET', '/sw.js'); assert.strictEqual(sw.s, 200); assert.ok(/javascript/.test(sw.h.get('content-type'))); assert.strictEqual(sw.h.get('cache-control'), 'no-cache'); assert.ok(sw.t.includes("addEventListener('push'"));
    });
    await test('only a proper https device with real keys can be registered', async () => {
      const d = device();
      for (const bad of [{ endpoint: 'http://x.test/a', keys: d }, { endpoint: EP('ok'), keys: { p256dh: '!!', auth: d.auth } }, { endpoint: EP('ok') }, {}]) assert.strictEqual((await call('POST', '/api/notifications/push/subscribe', { subscription: bad }, ann)).s, 400);
      assert.strictEqual((await call('POST', '/api/notifications/push/subscribe', { subscription: { endpoint: EP('x'), keys: d } })).s, 401);
    });

    console.log('\nSending');
    await test('a notification is pushed, encrypted, to the person\'s device and only theirs', async () => {
      const a = device(), b = device();
      assert.strictEqual((await call('POST', '/api/notifications/push/subscribe', { subscription: { endpoint: EP('ann1'), keys: a } }, ann)).s, 200);
      assert.strictEqual((await call('POST', '/api/notifications/push/subscribe', { subscription: { endpoint: EP('bob1'), keys: b } }, bob)).s, 200);
      assert.strictEqual((await call('GET', '/api/notifications/push', null, ann)).j.devices, 1);
      await announce(); await until(() => got.length >= 2);
      const mine = got.find((g) => g.url === '/ann1'); assert.ok(mine, 'ann gets one'); assert.ok(/^vapid /i.test(mine.h.authorization), 'signed with the shop\'s key'); assert.strictEqual(mine.h['content-encoding'], 'aes128gcm'); assert.ok(mine.n > 40, 'has an encrypted body');
      assert.ok(got.find((g) => g.url === '/bob1'));
    });
    await test('turning a device off stops alerts to it', async () => {
      assert.strictEqual((await call('POST', '/api/notifications/push/unsubscribe', { endpoint: EP('ann1') }, ann)).s, 200);
      got.length = 0; await announce(); await until(() => got.some((g) => g.url === '/bob1')); await sleep(500);
      assert.ok(!got.some((g) => g.url === '/ann1'));
    });
    await test('nobody can switch off someone else\'s device', async () => {
      await call('POST', '/api/notifications/push/unsubscribe', { endpoint: EP('bob1') }, ann);
      assert.strictEqual((await call('GET', '/api/notifications/push', null, bob)).j.devices, 1);
    });
    await test('a device the browser says is gone (410) is forgotten', async () => {
      await call('POST', '/api/notifications/push/subscribe', { subscription: { endpoint: EP('gone1'), keys: device() } }, ann);
      await announce(); await until(async () => (await q('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint=$1', [EP('gone1')]))[0].n === '0');
    });
    await test('the in-app notification is still saved, and a dead push service never breaks sending', async () => {
      push.close(); await sleep(300);
      const before = (await call('GET', '/api/notifications/count', null, bob)).j.unread; await announce();
      await until(async () => (await call('GET', '/api/notifications/count', null, bob)).j.unread > before);
      await sleep(1500); assert.strictEqual((await call('GET', '/health')).s, 200);
    });
    await test('security review: the table has row security on', async () => assert.strictEqual((await q("SELECT relrowsecurity FROM pg_class WHERE relname='push_subscriptions'"))[0].relrowsecurity, true));
  } finally {
    srv.kill(); push.close(); await sleep(300);
    await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
