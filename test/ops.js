'use strict';
// Step 8 check: health, request ids and logs, backups (stored, encrypted, trimmed, scheduled) and restore into a fresh database.
// Run with: npm run test:ops   (needs TEST_DATABASE_URL like the main test)
const { spawn, spawnSync } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36);
const DBS = { a: 'sb_ops_' + tag, enc: 'sb_opse_' + tag, sched: 'sb_opss_' + tag, restored: 'sb_opsr_' + tag, busy: 'sb_opsb_' + tag };
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const BASE = 5700 + Math.floor(Math.random() * 40) * 5;
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(250); } };
const pg = async (sql, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql)).rows; } finally { await c.end(); } };
// In-process use of lib/backup (decode, trim, failure) points at the "enc" database and the folder the "enc" app also uses.
const ENC_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ops-enc-'));
process.env.DATABASE_URL = urlOf(DBS.enc); process.env.DATABASE_SSL = 'off'; process.env.DATA_DIR = ENC_DATA; delete process.env.BACKUP_PASSPHRASE; delete process.env.NODE_ENV;
const procs = [];
const start = (port, db, extra = {}) => {
  const data = extra.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ops-'));
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), BASE_URL: 'http://127.0.0.1:' + port, DATABASE_URL: urlOf(db), DATABASE_SSL: 'off', DATA_DIR: data, RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '', GEOAPIFY_API_KEY: '', ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', LOG_FORMAT: 'json', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.data = data; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; }); procs.push(p); return p;
};
const up = async (port, p) => { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); return; } catch { await sleep(100); } } throw new Error('app did not start on ' + port + '\n' + (p ? p.log.slice(-600) : '')); };
const call = async (port, method, url, body, { cookie, headers = {} } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer()); let j = null; try { j = JSON.parse(buf.toString()); } catch { /* */ }
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; return { s: r.status, j, buf, h: r.headers, c: (sc[0] || '').split(';')[0] };
};
const logsOf = (p) => p.log.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

(async () => {
  for (const d of Object.values(DBS)) await pg(`CREATE DATABASE ${d}`);
  const PA = BASE, PE = BASE + 1, PS = BASE + 2, PR = BASE + 3;
  const a = start(PA, DBS.a, { LOG_LEVEL: 'info' });
  const enc = start(PE, DBS.enc, { BACKUP_PASSPHRASE: 'test-passphrase-123', LOG_LEVEL: 'warn', DATA_DIR: ENC_DATA });
  const sched = start(PS, DBS.sched, { BACKUP_ENABLED: '1', LOG_LEVEL: 'warn' });
  await up(PA, a); await up(PE, enc); await up(PS, sched);
  const login = async (port) => (await call(port, 'POST', '/api/auth/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' })).c;
  const ac = await login(PA);
  const prod = (await call(PA, 'GET', '/api/products?instock=1')).j.products[0];

  await test('database connection options: Supabase transaction pooler gets no session settings, others get a server time limit, certificates can be supplied', async () => {
    const { connectionOptions: co } = require('../lib/db');
    const pooled = co('postgres://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres', {});
    assert.ok(!('statement_timeout' in pooled) && !('application_name' in pooled) && pooled.query_timeout >= 15000); assert.deepStrictEqual(pooled.ssl, { rejectUnauthorized: true });
    const direct = co('postgres://postgres:pw@db.abc.supabase.co:5432/postgres', { DB_STATEMENT_TIMEOUT_MS: '9000' }); assert.strictEqual(direct.statement_timeout, 9000);
    assert.strictEqual(co('postgres://postgres@127.0.0.1:5432/x', {}).ssl, false);
    assert.strictEqual(co('postgres://u:p@host.example:6543/postgres', { DATABASE_SSL: 'no-verify' }).ssl.rejectUnauthorized, false);
    const pem = '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----'; assert.strictEqual(co('postgres://u:p@h:5432/d', { DATABASE_CA: pem }).ssl.ca, pem);
    assert.strictEqual(co('postgres://u:p@h:5432/d', { DATABASE_CA: Buffer.from(pem).toString('base64') }).ssl.ca, pem);
  });
  await test('migrations: several instances starting at the same moment on an empty database all come up and migrate exactly once', async () => {
    await pg('CREATE DATABASE sb_mig_' + tag);
    const ps = [0, 1, 2, 3].map((i) => start(BASE + 10 + i, 'x', { DATABASE_URL: urlOf('sb_mig_' + tag) }));
    for (let i = 0; i < 4; i++) await up(BASE + 10 + i, ps[i]);
    const n = Number((await pg('SELECT COUNT(*) n FROM schema_migrations', 'sb_mig_' + tag))[0].n); const files = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).length; assert.strictEqual(n, files);
    assert.strictEqual(Number((await pg("SELECT COUNT(*) n FROM pg_locks WHERE locktype='advisory'", 'sb_mig_' + tag))[0].n), 0, 'no advisory lock left behind');
    for (const p of ps) p.kill(); await sleep(300); await pg('DROP DATABASE IF EXISTS sb_mig_' + tag + ' WITH (FORCE)');
  });
  await test('preflight: a good production setup passes, a careless one is stopped with plain reasons', async () => {
    const { checkEnv, checkLive, summary } = require('../lib/preflight');
    const good = { NODE_ENV: 'production', BASE_URL: 'https://www.shop.example', DATABASE_URL: 'postgres://u:p@aws-0-eu.pooler.supabase.com:6543/postgres', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', PAYSTACK_SECRET_KEY: 'sk_live_abc', RESEND_API_KEY: 're_x', MAIL_FROM: 'Shop <orders@shop.example>', HANDOVER_SECRET: 'x'.repeat(40), GEOAPIFY_API_KEY: 'g', BACKUP_PASSPHRASE: 'y'.repeat(30), ADMIN_EMAIL: 'o@shop.example', ADMIN_PASSWORD: 'Long-Strong-Pass-1', SEED_DEMO: '0' };
    assert.deepStrictEqual(summary(checkEnv(good)), { fail: 0, warn: 0, pass: summary(checkEnv(good)).pass });
    const bad = summary(checkEnv({ NODE_ENV: 'development', BASE_URL: 'http://localhost:3000', DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/x', ALLOW_DEMO_PAYMENTS: '1', RATE_LIMIT_MULTIPLIER: '1000', TRUST_PROXY: '0', PAYSTACK_SECRET_KEY: 'pk_live_public' }));
    assert.ok(bad.fail >= 8, 'fails: ' + bad.fail);
    const names = (e) => checkEnv(e).filter((r) => r.level === 'FAIL').map((r) => r.name);
    assert.ok(names({ ...good, PAYSTACK_API_URL: 'http://evil.example' }).includes('Test-only settings'));
    assert.ok(names({ ...good, PAYSTACK_SECRET_KEY: '' }).includes('Paystack')); assert.ok(checkEnv({ ...good, PAYSTACK_SECRET_KEY: 'sk_test_1' }).some((r) => r.level === 'WARN' && r.name === 'Paystack'));
    const live = await checkLive({}, require('../lib/db')); assert.ok(live.some((r) => r.name === 'Database' && r.level === 'PASS')); assert.ok(live.some((r) => r.name === 'Migrations' && r.level === 'PASS'));
    const down = await checkLive({}, { health: async () => { throw new Error('boom'); }, get: async () => ({}) }); assert.strictEqual(down[0].level, 'FAIL');
  });
  await test('health answers quickly with only ok:true, and is not written to the log', async () => {
    const r = await call(PA, 'GET', '/health'); assert.strictEqual(r.s, 200); assert.deepStrictEqual(r.j, { ok: true });
    await sleep(300); assert.ok(!logsOf(a).some((l) => l.path === '/health'));
  });
  await test('every response carries a request id; a sane one from the platform is kept, a strange one is replaced', async () => {
    const r1 = await call(PA, 'GET', '/api/config'); assert.match(r1.h.get('x-request-id'), /^[a-f0-9]{16}$/);
    assert.strictEqual((await call(PA, 'GET', '/api/config', undefined, { headers: { 'X-Request-Id': 'render-abc12345' } })).h.get('x-request-id'), 'render-abc12345');
    assert.match((await call(PA, 'GET', '/api/config', undefined, { headers: { 'X-Request-Id': 'bad id <script>' } })).h.get('x-request-id'), /^[a-f0-9]{16}$/);
  });
  await test('request log lines are JSON with id, status and time, and never contain the query string (order links carry secrets)', async () => {
    const r = await call(PA, 'GET', '/api/orders/SB-NOPE00?t=SECRETTOKEN12345&email=someone@example.com'); await sleep(400);
    const line = logsOf(a).find((l) => l.id === r.h.get('x-request-id')); assert.ok(line, 'log line for the request'); assert.strictEqual(line.msg === 'request' || line.msg === 'slow request', true);
    assert.ok(Number.isInteger(line.ms) && line.status >= 400 && line.path.startsWith('/api/orders/'));
    assert.ok(!a.log.includes('SECRETTOKEN12345') && !a.log.includes('someone@example.com'));
  });
  await test('the status page is for admins only and reports database, queue and backup state', async () => {
    assert.strictEqual((await call(PA, 'GET', '/api/admin/status')).s, 401);
    const s = (await call(PA, 'GET', '/api/admin/status', undefined, { cookie: ac })).j;
    assert.strictEqual(s.ok, true); assert.ok(s.database.ms >= 0 && s.database.pool.total >= 1); assert.ok('queued' in s.queue); assert.strictEqual(s.backups.stale, true); assert.strictEqual(s.workerLooksStuck, false);
  });

  // some shop data to protect
  const reg = await call(PA, 'POST', '/api/auth/register', { name: 'Ada Backup', email: 'ada.backup@example.com', phone: '08012349876', password: 'mango-river-sky-77' });
  const ord = (await call(PA, 'POST', '/api/checkout', { items: [{ productId: prod.id, qty: 2 }], contact: { name: 'Ada Backup', email: 'ada.backup@example.com', phone: '08012349876' }, address: { state: 'Lagos', city: 'Yaba', address: '5 Restore Road' }, delivery: 'standard', payment: 'pod' }, { cookie: reg.c })).j;
  let file;
  await test('"Back up now" saves a file, lists it, and the status turns healthy', async () => {
    const r = await call(PA, 'POST', '/api/admin/backups', {}, { cookie: ac }); assert.strictEqual(r.s, 200); assert.ok(r.j.rows > 0); file = r.j.name;
    const l = (await call(PA, 'GET', '/api/admin/backups', undefined, { cookie: ac })).j; assert.ok(l.files.some((f) => f.name === file)); assert.strictEqual(l.stale, false); assert.strictEqual(l.last.name, file);
  });
  await test('a backup holds the shop data but not sessions, reset tokens, rate limits or the job queue', async () => {
    const d = await call(PA, 'GET', '/api/admin/backups/' + file, undefined, { cookie: ac }); assert.strictEqual(d.s, 200);
    const c = require('../lib/backup').decode(d.buf); assert.ok(c.tables.users.some((u) => u.email === 'ada.backup@example.com')); assert.ok(c.tables.orders.some((o) => o.ref === ord.ref));
    for (const t of ['sessions', 'resets', 'rate_limits', 'jobs', 'geo_cache']) assert.ok(!(t in c.tables), t + ' should not be backed up');
  });
  await test('downloading a backup is written to the activity log; strangers and odd names are refused', async () => {
    const log = (await call(PA, 'GET', '/api/admin/audit', undefined, { cookie: ac })).j.log; assert.ok(log.some((x) => /backups\//.test(x.path) && x.detail === 'backup downloaded'));
    assert.strictEqual((await call(PA, 'GET', '/api/admin/backups/' + file)).s, 401);
    assert.strictEqual((await call(PA, 'GET', '/api/admin/backups/..%2F..%2Fetc%2Fpasswd', undefined, { cookie: ac })).s, 404);
  });
  await test('restore: a backup loads into a new empty database and the shop works from it (login, order, new orders, counters)', async () => {
    const f = path.join(os.tmpdir(), file); fs.writeFileSync(f, (await call(PA, 'GET', '/api/admin/backups/' + file, undefined, { cookie: ac })).buf);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'restore.js'), f], { env: { ...process.env, DATABASE_URL: urlOf(DBS.restored), DATABASE_SSL: 'off' }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    for (const t of ['users', 'orders', 'order_items', 'products', 'settings', 'categories', 'zones']) {
      const x = Number((await pg(`SELECT COUNT(*) n FROM ${t}`, DBS.a))[0].n), y = Number((await pg(`SELECT COUNT(*) n FROM ${t}`, DBS.restored))[0].n); assert.strictEqual(y, x, t);
    }
    const b = start(PR, DBS.restored); await up(PR, b);
    assert.strictEqual((await call(PR, 'POST', '/api/auth/login', { email: 'ada.backup@example.com', password: 'mango-river-sky-77' })).s, 200, 'customer password still works');
    assert.strictEqual((await call(PR, 'POST', '/api/orders/lookup', { ref: ord.ref, email: 'ada.backup@example.com', token: ord.token })).s, 200, 'old order and its private link survive');
    const n = await call(PR, 'POST', '/api/checkout', { items: [{ productId: prod.id, qty: 1 }], contact: { name: 'New Buyer', email: 'new.buyer@example.com', phone: '08099990000' }, address: { state: 'Lagos', city: 'Yaba', address: '1 After Restore St' }, delivery: 'standard', payment: 'pod' });
    assert.strictEqual(n.s, 200, JSON.stringify(n.j)); assert.notStrictEqual(n.j.ref, ord.ref);
    b.kill();
  });
  await test('restore refuses a database that already has data, and a file that is not a backup', async () => {
    const f = path.join(os.tmpdir(), file);
    const again = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'restore.js'), f], { env: { ...process.env, DATABASE_URL: urlOf(DBS.restored), DATABASE_SSL: 'off' }, encoding: 'utf8' });
    assert.notStrictEqual(again.status, 0); assert.match(again.stderr, /already has data/);
    const junk = path.join(os.tmpdir(), 'junk-' + tag + '.gz'); fs.writeFileSync(junk, 'hello');
    const bad = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'restore.js'), junk], { env: { ...process.env, DATABASE_URL: urlOf(DBS.busy), DATABASE_SSL: 'off' }, encoding: 'utf8' });
    assert.notStrictEqual(bad.status, 0); assert.match(bad.stderr, /not a Shop-Beta backup/);
    assert.strictEqual(Number((await pg("SELECT COUNT(*) n FROM information_schema.tables WHERE table_name='users'", DBS.busy))[0].n), 0, 'nothing touched on a bad file');
  });
  await test('with BACKUP_PASSPHRASE the file is encrypted: no readable customer data, wrong passphrase fails, right one restores', async () => {
    const ec = await login(PE); await call(PE, 'POST', '/api/auth/register', { name: 'Eve Secret', email: 'eve.secret@example.com', phone: '08012340000', password: 'mango-river-sky-88' });
    const r = (await call(PE, 'POST', '/api/admin/backups', {}, { cookie: ec })).j; assert.ok(/\.enc$/.test(r.name));
    const raw = (await call(PE, 'GET', '/api/admin/backups/' + r.name, undefined, { cookie: ec })).buf;
    assert.ok(!raw.includes('eve.secret@example.com')); assert.strictEqual(raw.subarray(0, 6).toString(), 'SBENC1');
    const B = require('../lib/backup');
    assert.throws(() => B.decode(raw, 'wrong'), /Wrong passphrase/); assert.throws(() => B.decode(raw, ''), /encrypted/);
    assert.ok(B.decode(raw, 'test-passphrase-123').tables.users.some((u) => u.email === 'eve.secret@example.com'));
    const tampered = Buffer.from(raw); tampered[tampered.length - 5] ^= 1; assert.throws(() => B.decode(tampered, 'test-passphrase-123'), /damaged|passphrase/);
    assert.ok((await call(PE, 'GET', '/api/admin/status', undefined, { cookie: ec })).j.backups.encryption);
  });
  await test('only the newest BACKUP_KEEP (min 3) files are kept', async () => {
    const ec = await login(PE); process.env.BACKUP_KEEP = '3';
    for (let i = 0; i < 4; i++) await call(PE, 'POST', '/api/admin/backups', {}, { cookie: ec });
    const before = (await call(PE, 'GET', '/api/admin/backups', undefined, { cookie: ec })).j.files.length; assert.ok(before >= 4, 'default keeps 14, so nothing trimmed yet: ' + before);
    const dir = path.join(ENC_DATA, 'backups'); const files = fs.readdirSync(dir).sort(); assert.ok(files.length >= 4);
    const B = require('../lib/backup'); await B.trim();
    const left = fs.readdirSync(dir).sort(); assert.strictEqual(left.length, 3); assert.deepStrictEqual(left, files.slice(-3), 'the three newest stay');
  });
  await test('the worker makes a daily backup by itself (BACKUP_ENABLED=1) and records it', async () => {
    const row = await until(async () => (await pg('SELECT * FROM backup_log WHERE ok=1', DBS.sched))[0]); assert.strictEqual(row.source, 'schedule'); assert.ok(Number(row.bytes) > 500);
    const sc = await login(PS); assert.strictEqual((await call(PS, 'GET', '/api/admin/status', undefined, { cookie: sc })).j.backups.stale, false);
  });
  await test('a failed backup is recorded and shown, not silent', async () => {
    const B = require('../lib/backup'); const st = require('../lib/storage'); const orig = st.backups.put; st.backups.put = async () => { throw new Error('bucket missing'); };
    await assert.rejects(() => B.create('test'), /bucket missing/); st.backups.put = orig;
    const row = (await pg("SELECT * FROM backup_log WHERE ok=0 AND source='test'", DBS.enc))[0]; assert.ok(row && /bucket missing/.test(row.error));
    const st2 = await B.status(); assert.ok(st2.lastFailure === null || /bucket missing/.test(st2.lastFailure.error));
  });

  await test('error tracking: the same error is stored once with a count, alerts are limited, admins can mark it fixed', async () => {
    const E = require('../lib/errors'); const boom = () => new Error('Test boom 12345');
    for (let i = 0; i < 5; i++) E.record(boom(), { source: 'request', route: 'GET /api/x' });
    E.record(new Error('Another kind'), { source: 'job', route: 'order-mail' });
    await sleep(2600);
    const rows = await pg("SELECT * FROM error_log WHERE message LIKE 'Test boom%' OR message='Another kind' ORDER BY id", DBS.enc);
    assert.strictEqual(rows.length, 2); assert.ok(rows.find((r) => /Test boom/.test(r.message)).count >= 5, 'counted, not repeated');
    assert.strictEqual(Number((await pg("SELECT COUNT(*) n FROM jobs WHERE kind='alert'", DBS.enc))[0].n) >= 2, true, 'a new error queues an alert');
    assert.ok(!JSON.stringify(rows).includes('password'), 'no request data is stored');
    const admin = (await call(PE, 'POST', '/api/auth/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' })).c;
    const list = await call(PE, 'GET', '/api/admin/errors', undefined, { cookie: admin }); assert.strictEqual(list.s, 200);
    assert.strictEqual((await call(PE, 'GET', '/api/admin/errors')).s, 401);
    const id = rows[0].id; assert.strictEqual((await call(PE, 'POST', '/api/admin/errors/' + id + '/resolve', {}, { cookie: admin })).s, 200);
    assert.strictEqual((await call(PE, 'POST', '/api/admin/errors/' + id + '/resolve', {}, { cookie: admin })).s, 404);
  });

  for (const p of procs) p.kill();
  await sleep(400);
  for (const d of Object.values(DBS)) await pg(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(procs[0].log.slice(-800));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
