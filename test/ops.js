'use strict';
// Operations tests: structured logs, error tracking and alerts, deep health check, scheduled and manual backups, retention,
// the admin download, and a REAL restore of a backup into a brand-new database (compared row by row).
// Run with: npm run test:ops   (needs Postgres like npm test)
const { spawn, spawnSync } = require('child_process');
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Client: Pg } = require('pg');
const mockStorage = require('./mock-supabase');

const ADMIN_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const withDb = (n) => { const u = new URL(ADMIN_URL); u.pathname = '/' + n; return u.toString(); };
const ssl = process.env.PGSSL_TEST === 'require' ? { rejectUnauthorized: false } : false;
const sql = async (q, db, args) => { const c = new Pg({ connectionString: db ? withDb(db) : ADMIN_URL, ssl }); await c.connect(); try { return await c.query(q, args); } finally { await c.end(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 9);
const waitFor = async (fn, ms = 15000, what = 'condition') => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(150); } };
const ADMIN_EMAIL = 'boss@example.com', ADMIN_PW = 'correct horse battery', KEY = 'service-key-123';
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.stack || e.message).split('\n').slice(0, 8).join('\n       ')); } }

const dbs = [], procs = [], tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ops-'));
let portN = 4400 + Math.floor(Math.random() * 60);
async function newDb(migrated = false) { const n = 'sb_ops_' + rnd(); await sql(`CREATE DATABASE ${n}`); dbs.push(n); return n; }
function spawnServer(db, env = {}) {
  const port = portN++;
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: withDb(db), PGSSL: process.env.PGSSL_TEST || 'disable', BASE_URL: 'http://127.0.0.1:' + port, STORAGE_DRIVER: 'local', DATA_DIR: path.join(tmp, 'd' + port), CACHE_DISABLED: '1', RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '', NODE_ENV: '', LOG_FORMAT: '', LOG_REQUESTS: '', ADMIN_EMAIL, ADMIN_PASSWORD: ADMIN_PW, ADMIN_SETUP_CODE: '', RATE_LIMITS: '', WORKER_POLL_MS: '150', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.out = ''; p.err = ''; p.port = port; p.base = 'http://127.0.0.1:' + port; p.stdout.on('data', (d) => { p.out += d; }); p.stderr.on('data', (d) => { p.err += d; });
  p.exited = new Promise((r) => p.on('exit', (c) => r(c))); procs.push(p); return p;
}
async function up(p) { for (let i = 0; i < 150; i++) { try { if ((await fetch(p.base + '/health')).ok) return p; } catch { /* wait */ } if (p.exitCode !== null) throw new Error('server exited: ' + (p.out + p.err).slice(-500)); await sleep(100); } throw new Error('no start'); }
const stop = async (p) => { p.kill(); await Promise.race([p.exited, sleep(2000)]); };

class Client {
  constructor(base) { this.base = base; this.cookies = {}; }
  async req(method, url, body, headers = {}) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => k + '=' + v).join('; ');
    const r = await fetch(this.base + url, { method, redirect: 'manual', headers: { 'X-Requested-With': 'shop-beta', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (/Max-Age=0/i.test(c)) delete this.cookies[kv.slice(0, i)]; else this.cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const buf = Buffer.from(await r.arrayBuffer()), text = buf.toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, buf, headers: r.headers };
  }
  get(u, h) { return this.req('GET', u, undefined, h); } post(u, b = {}, h) { return this.req('POST', u, b, h); }
}
const login = async (base) => { const c = new Client(base); const r = await c.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PW }); assert.strictEqual(r.status, 200, 'admin login: ' + r.text); return c; };
const ipn = (() => { let n = 0; return () => ({ 'X-Forwarded-For': '10.9.' + Math.floor(++n / 250) + '.' + (n % 250) }); })();

// a tiny HTTP server that remembers what it was sent (stands in for a Slack/Discord alert webhook)
const hookServer = () => new Promise((resolve) => { const got = []; const s = http.createServer((q, r) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { got.push(JSON.parse(b)); r.end('ok'); }); }); s.listen(0, '127.0.0.1', () => resolve({ got, url: 'http://127.0.0.1:' + s.address().port, close: () => s.close() })); });

(async () => {
  const inprocDb = await newDb(); process.env.DATABASE_URL = withDb(inprocDb); process.env.PGSSL = 'disable'; process.env.DATA_DIR = path.join(tmp, 'inproc'); process.env.BACKUP_HOUR_LAGOS = '0'; process.env.STORAGE_DRIVER = 'local'; // the in-process library tests use this database
  const storage = await mockStorage.start(KEY);
  const hook = await hookServer();

  console.log('\nStructured logs');
  const logDb = await newDb(); const logSrv = await up(spawnServer(logDb, { LOG_REQUESTS: 'all', ADMIN_PASSWORD: ADMIN_PW }));
  await test('every log line is JSON with time, level, message and instance; requests carry an id, status and timing', async () => {
    const c = new Client(logSrv.base);
    const r = await c.get('/api/orders/lookup?email=secret.person@example.com&phone=08031234567', { 'X-Request-Id': 'abc-123' }); // wrong method: 404, but the query string must never be logged
    assert.strictEqual(r.headers.get('x-request-id'), 'abc-123'); assert.match((await c.get('/api/config')).headers.get('x-request-id'), /^[0-9a-f]{12}$/);
    assert.strictEqual((await c.get('/api/config', { 'X-Request-Id': 'bad id<script>' + 'x'.repeat(80) })).headers.get('x-request-id').includes('<'), false, 'request ids are cleaned');
    await sleep(300);
    const lines = (logSrv.out + logSrv.err).split('\n').filter(Boolean); assert.ok(lines.length > 3);
    for (const l of lines) { const o = JSON.parse(l); assert.ok(o.ts && o.level && typeof o.msg === 'string' && o.instance, l); }
    const reqLines = lines.map((l) => JSON.parse(l)).filter((o) => o.msg === 'request'); const mine = reqLines.find((o) => o.reqId === 'abc-123');
    assert.ok(mine && mine.method === 'GET' && mine.path === '/api/orders/lookup' && mine.status >= 400 && typeof mine.ms === 'number' && mine.ip, JSON.stringify(mine));
    const all = logSrv.out + logSrv.err; assert.ok(!all.includes('secret.person') && !all.includes('08031234567') && !all.includes(ADMIN_PW), 'no query strings, phones, emails or passwords in logs');
  });
  await test('secrets are redacted from structured fields', async () => {
    const log = require('../lib/log'); const c = log.clean({ user: 'a', password: 'p', nested: { apiKey: 'k', authorization: 'Bearer x', ok: 1 }, cookie: 'c', SUPABASE_SERVICE_ROLE_KEY: 's' });
    assert.deepStrictEqual(c, { user: 'a', password: '[redacted]', nested: { apiKey: '[redacted]', authorization: '[redacted]', ok: 1 }, cookie: '[redacted]', SUPABASE_SERVICE_ROLE_KEY: '[redacted]' });
  });
  await test('LOG_REQUESTS=errors (the default) stays quiet for good requests and speaks up for bad ones', async () => {
    const s = await up(spawnServer(await newDb())); const c = new Client(s.base);
    for (let i = 0; i < 5; i++) await c.get('/api/config'); await c.get('/api/products/99999'); await sleep(300);
    const reqs = (s.out + s.err).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.msg === 'request');
    assert.ok(reqs.every((o) => o.status >= 400 || o.ms >= 800 || /checkout|webhook/.test(o.path)), JSON.stringify(reqs)); assert.ok(reqs.some((o) => o.status === 404)); await stop(s);
  });
  await stop(logSrv);

  console.log('\nError tracking and alerts');
  const errDb = await newDb();
  const errSrv = await up(spawnServer(errDb, { ALERT_WEBHOOK_URL: hook.url, ALERT_REPEAT_MINUTES: '60' }));
  const admin = await login(errSrv.base);
  await test('an unexpected 500 is stored once with a count, grouped by place, without request data, and the owner is alerted once', async () => {
    await sql('ALTER TABLE zones RENAME TO zones_off', errDb); // break something real so the server fails on its own
    const c = new Client(errSrv.base); const statuses = []; for (let i = 0; i < 6; i++) statuses.push((await c.get('/api/config?token=SECRET-TOKEN-1', ipn())).status);
    assert.ok(statuses.every((s) => s === 500), statuses.join()); assert.deepStrictEqual((await c.get('/api/config')).json, { error: 'Something went wrong on our side. Please try again.' }, 'shoppers see a calm message, no details');
    const row = await waitFor(async () => { const r = (await sql('SELECT * FROM error_log', errDb)).rows; return r.length && r[0].count >= 7 ? r : null; }, 10000, 'error rows');
    assert.strictEqual(row.length, 1, 'same mistake, one row'); assert.strictEqual(row[0].source, 'request'); assert.match(row[0].route, /\/api\/config|config/); assert.ok(row[0].message.includes('zones'));
    assert.ok(!JSON.stringify(row[0]).includes('SECRET-TOKEN'), 'no query string stored');
    await waitFor(() => hook.got.length >= 1, 10000, 'alert'); await sleep(1500); assert.strictEqual(hook.got.length, 1, 'one alert, not one per error'); assert.match(hook.got[0].text, /error/i); assert.ok(!hook.got[0].text.includes('SECRET-TOKEN'));
  });
  await test('the admin screen lists it; marking it fixed hides it; if it comes back the owner is alerted again', async () => {
    const o = (await admin.get('/api/admin/ops')).json; assert.strictEqual(o.errors.length, 1); assert.strictEqual(o.alerts.webhook, true);
    assert.strictEqual((await admin.post('/api/admin/errors/' + o.errors[0].id + '/resolve')).status, 200); assert.strictEqual((await admin.post('/api/admin/errors/' + o.errors[0].id + '/resolve')).status, 404);
    await sql('ALTER TABLE zones_off RENAME TO zones', errDb); assert.strictEqual((await new Client(errSrv.base).get('/api/config')).status, 200, 'works again');
    await sql('ALTER TABLE zones RENAME TO zones_off', errDb); await new Client(errSrv.base).get('/api/config');
    await waitFor(() => hook.got.length >= 2, 10000, 'second alert'); assert.strictEqual((await sql('SELECT resolved_at FROM error_log', errDb)).rows[0].resolved_at, null, 'reopened');
    await sql('ALTER TABLE zones_off RENAME TO zones', errDb);
  });
  await test('errors that differ only in numbers or ids share one fingerprint; different errors do not', async () => {
    const E = require('../lib/errors'); const a = new Error('order 123 failed for user 4567'), b = new Error('order 999 failed for user 1'); a.stack = b.stack = 'Error\n    at f (/x/y.js:10:5)';
    assert.strictEqual(E.fingerprint('request', a, 'GET /a'), E.fingerprint('request', b, 'GET /a')); assert.notStrictEqual(E.fingerprint('request', a, 'GET /a'), E.fingerprint('request', a, 'GET /b')); assert.notStrictEqual(E.fingerprint('request', a, 'GET /a'), E.fingerprint('request', new Error('different'), 'GET /a'));
  });
  await test('if the alert webhook is down, the alert is kept and retried instead of being lost', async () => {
    const d = await newDb(), bad = await up(spawnServer(d, { ALERT_WEBHOOK_URL: 'http://127.0.0.1:9/nope', JOB_BACKOFF_BASE_SECONDS: '1' }));
    await sql('ALTER TABLE zones RENAME TO zones_off', d); await new Client(bad.base).get('/api/config');
    const j = await waitFor(async () => (await sql("SELECT * FROM jobs WHERE queue='alert' AND attempts >= 2", d)).rows[0], 15000, 'alert retries');
    assert.ok(['queued', 'active'].includes(j.state) && j.last_error, 'still waiting to be delivered, with the reason recorded'); await stop(bad);
  });
  await stop(errSrv);

  console.log('\nDeep health check for uptime monitors');
  const hDb = await newDb(); const hSrv = await up(spawnServer(hDb, { BACKUP_MAX_AGE_HOURS: '36' }));
  await test('/health stays shallow; /health/deep is 200 on a healthy new server and shows no customer data', async () => {
    const c = new Client(hSrv.base); const d = await c.get('/health/deep'); assert.strictEqual(d.status, 200, d.text); assert.strictEqual(d.json.ok, true); assert.ok(d.json.checks.database.ok && d.json.checks.queue.ok && d.json.checks.backup.ok);
    assert.ok(!/@|\bphone\b|password/i.test(d.text.replace(/shop-beta/g, ''))); assert.strictEqual(d.headers.get('cache-control'), 'no-store');
  });
  await test('it turns 503 when backups are too old, when jobs are stuck, and recovers when fixed', async () => {
    const c = new Client(hSrv.base), t = Math.floor(Date.now() / 1000);
    await sql("INSERT INTO backups (started,finished,state,kind,location,bytes,row_count) VALUES ($1,$1,'ok','scheduled','old.gz',1,1)", hDb, [t - 40 * 3600]);
    let d = await c.get('/health/deep'); assert.strictEqual(d.status, 503); assert.match(d.json.checks.backup.why, /no successful database backup/); assert.strictEqual(d.json.checks.database.ok, true);
    await sql("INSERT INTO backups (started,finished,state,kind,location,bytes,row_count) VALUES ($1,$1,'ok','scheduled','new.gz',1,1)", hDb, [t - 3600]); assert.strictEqual((await c.get('/health/deep')).status, 200);
    const id = (await sql("INSERT INTO jobs (queue,payload,run_at,created) VALUES ('no-such-handler','{}',$1,$1) RETURNING id", hDb, [t - 1200])).rows[0].id;
    d = await c.get('/health/deep'); assert.strictEqual(d.status, 503); assert.match(d.json.checks.queue.why, /waiting for over 10 minutes/);
    await sql('DELETE FROM jobs WHERE id=$1', hDb, [id]); assert.strictEqual((await c.get('/health/deep')).status, 200);
  });
  await test('it says 503 when the database is gone', async () => {
    const s = await up(spawnServer(await newDb())); const gone = dbs[dbs.length - 1];
    await sql(`ALTER DATABASE ${gone} ALLOW_CONNECTIONS false`); await sql('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', undefined, [gone]);
    const d = await new Client(s.base).get('/health/deep'); assert.strictEqual(d.status, 503); assert.strictEqual(d.json.checks.database.ok, false); assert.ok(!d.text.includes('postgres://'));
    await sql(`ALTER DATABASE ${gone} ALLOW_CONNECTIONS true`); await stop(s);
  });
  await stop(hSrv);

  console.log('\nBackups: scheduled, manual, stored privately, kept 2');
  const srcDb = await newDb(); const srcSrv = await up(spawnServer(srcDb, { STORAGE_DRIVER: 'supabase', SUPABASE_URL: storage.url, SUPABASE_SERVICE_ROLE_KEY: KEY, BACKUP_KEEP: '2' }));
  const srcAdmin = await login(srcSrv.base);
  // some real shop data: shoppers, an order, a review-like message with awkward text
  const nasty = 'Ọlá "Test" \\ \' line two 😀 <b>x</b>', person = 'Ọlá Adébáyọ̀';
  const phone = '0803' + String(Math.floor(1000000 + Math.random() * 8999999));
  await test('set up shop data to protect (shoppers, orders, awkward text)', async () => {
    const a = new Client(srcSrv.base); assert.strictEqual((await a.post('/api/auth/register', { name: person, email: 'ada@example.com', phone, password: 'ada password 1' }, ipn())).status, 200);
    const prods = (await a.get('/api/products?store=electronics')).json.products.filter((x) => !x.hasVariants && x.stock > 5).slice(0, 3); assert.ok(prods.length >= 2);
    for (const p of prods) assert.strictEqual((await a.post('/api/checkout', { items: [{ productId: p.id, qty: 2 }], contact: { name: person, email: 'ada@example.com', phone }, address: { state: 'Lagos', city: 'Ikeja', address: '1 Test Road, Ikeja' }, delivery: 'standard', payment: 'pod' }, ipn())).status, 200);
    assert.strictEqual((await a.post('/api/contact', { name: 'Ọlá', email: 'ada@example.com', subject: 'Hello', body: nasty }, ipn())).status, 200);
  });
  let firstName;
  await test('"Back up now" stores a complete backup in a PRIVATE bucket, recorded in the list', async () => {
    const auto = await waitFor(async () => (await sql("SELECT * FROM backups WHERE state='ok' AND kind='scheduled'", srcDb)).rows[0], 20000, 'the automatic first backup'); assert.ok(auto.location, 'the first backup runs by itself soon after the first start');
    assert.strictEqual((await srcAdmin.post('/api/admin/backups')).status, 202);
    const b = await waitFor(async () => (await sql("SELECT * FROM backups WHERE state='ok' AND kind='manual'", srcDb)).rows[0], 20000, 'backup');
    firstName = b.location; assert.match(firstName, /^shop-beta-\d{8}-\d{4}-\d+\.ndjson\.gz$/); assert.ok(b.bytes > 500 && b.row_count > 20);
    const bucket = storage.log.find((l) => l.bucket && l.bucket.id === 'db-backups'); assert.ok(bucket && bucket.bucket.public === false, 'backup bucket is created private'); assert.ok(!storage.log.some((l) => l.denied && /db-backups/.test(l.denied)));
    const pub = await fetch(storage.url + '/storage/v1/object/public/db-backups/' + firstName); assert.strictEqual(pub.status, 404, 'a private bucket is not readable by the public address');
    const obj = storage.objects.get('db-backups/' + firstName); assert.ok(obj && obj.buf.length === Number(b.bytes));
    const info = await require('../lib/backup').verifyFile(obj.buf); assert.ok(info.tables.users >= 2 && info.tables.orders >= 2);
  });
  await test('the file leaves out sessions, reset tokens, rate counters, the job queue and the error log', async () => {
    const info = await require('../lib/backup').verifyFile(storage.objects.get('db-backups/' + firstName).buf);
    for (const t of ['sessions', 'resets', 'rate_limits', 'jobs', 'job_locks', 'idempotency_keys', 'error_log', 'backups', 'schema_migrations']) assert.ok(!(t in info.tables), t + ' should not be in the backup');
    for (const t of ['users', 'orders', 'order_items', 'products', 'settings', 'zones', 'messages']) assert.ok(t in info.tables, t + ' should be in the backup');
  });
  await test('admin can download a stored backup; shoppers and visitors cannot; a second "now" press while one waits does nothing', async () => {
    const id = (await sql("SELECT id FROM backups WHERE state='ok' AND kind='manual'", srcDb)).rows[0].id; const r = await srcAdmin.get('/api/admin/backups/' + id + '/download');
    assert.strictEqual(r.status, 200); assert.match(r.headers.get('content-disposition'), /attachment; filename="shop-beta-/); assert.strictEqual(r.headers.get('cache-control'), 'no-store'); assert.ok(r.buf.equals(storage.objects.get('db-backups/' + firstName).buf));
    const shopper = new Client(srcSrv.base); await shopper.post('/api/auth/login', { email: 'ada@example.com', password: 'ada password 1' }, ipn());
    for (const c of [shopper, new Client(srcSrv.base)]) for (const u of ['/api/admin/backups/' + id + '/download', '/api/admin/backups/download', '/api/admin/ops']) assert.ok([401, 403].includes((await c.get(u)).status), u);
    assert.strictEqual((await srcAdmin.get('/api/admin/backups/999999/download')).status, 404);
  });
  await test('retention: only the newest 2 good backups are kept, older files are deleted from storage', async () => {
    for (let i = 0; i < 3; i++) {
      const maxId = (await sql('SELECT COALESCE(MAX(id),0)::int m FROM backups', srcDb)).rows[0].m; await sleep(1100); await srcAdmin.post('/api/admin/backups');
      await waitFor(async () => (await sql("SELECT 1 FROM backups WHERE id > $1 AND state='ok' AND kind='manual'", srcDb, [maxId])).rowCount, 20000, 'backup ' + i); await sleep(300); // pruning happens right after the upload is recorded
    }
    const ok = (await sql("SELECT location FROM backups WHERE state='ok' AND kind='manual' ORDER BY started", srcDb)).rows; assert.strictEqual(ok.length, 2);
    const keys = [...storage.objects.keys()].filter((k) => k.startsWith('db-backups/')); assert.strictEqual(keys.length, 2, keys.join()); assert.ok(!keys.includes('db-backups/' + firstName), 'the oldest was removed');
  });
  await test('Admin > Jobs & backups data shows the list and status', async () => {
    const o = (await srcAdmin.get('/api/admin/ops')).json; assert.ok(o.backupStatus.lastOk > 0 && o.backups.length >= 2 && o.backupsOn && o.storage === 'supabase');
    const page = (await new Client(srcSrv.base).get('/admin')).text; assert.ok(page.includes('Download a fresh backup') && page.includes('Mark fixed'));
  });
  await test('instant download: a fresh gzip straight from the database, audited, limited to 4 an hour, valid end to end', async () => {
    const r = await srcAdmin.get('/api/admin/backups/download'); assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('content-type'), 'application/gzip'); assert.match(r.headers.get('content-disposition'), /attachment; filename="shop-beta-\d{8}-\d{4}\.ndjson\.gz"/);
    const info = await require('../lib/backup').verifyFile(r.buf); assert.ok(info.rows > 20);
    assert.ok((await sql("SELECT 1 FROM backups WHERE kind='download'", srcDb)).rowCount >= 1, 'download is on the record'); assert.match((srcSrv.out + srcSrv.err), /Database backup downloaded/);
    fs.writeFileSync(path.join(tmp, 'fresh.ndjson.gz'), r.buf);
    const codes = []; for (let i = 0; i < 4; i++) codes.push((await srcAdmin.get('/api/admin/backups/download')).status); assert.ok(codes.includes(429), codes.join());
  });

  console.log('\nScheduling rules (in-process, local storage)');
  await test('scheduled backup runs once a day: skipped when a recent one exists, runs when the last is over 22 h old, failures are recorded and re-thrown', async () => {
    const { migrate } = require('../lib/migrate'); await migrate(); const B = require('../lib/backup'); const db = require('../lib/db');
    const first = await B.runJob({ kind: 'manual' }); assert.ok(first.name && fs.existsSync(path.join(tmp, 'inproc', 'backups', first.name)));
    assert.deepStrictEqual(await B.runJob({}), { skipped: 'recent backup exists' });
    await db.run("UPDATE backups SET finished = finished - 21*3600"); assert.ok((await B.runJob({})).skipped, 'under 22 hours: skipped');
    await db.run("UPDATE backups SET finished = finished - 4*3600"); const again = await B.runJob({}); assert.ok(again.name, 'over 22 hours: runs');
    await db.run("UPDATE backups SET finished = finished - 26*3600"); const dataDirFile = path.join(tmp, 'blocked'); fs.writeFileSync(dataDirFile, 'x'); fs.rmSync(path.join(tmp, 'inproc'), { recursive: true, force: true }); fs.writeFileSync(path.join(tmp, 'inproc'), 'a file where a folder should be');
    await assert.rejects(() => B.runJob({}), /./); const bad = await db.get("SELECT * FROM backups WHERE state='failed'"); assert.ok(bad && bad.error, 'failure is on the list');
    await sleep(300); assert.ok((await db.get("SELECT 1 x FROM error_log WHERE source='backup'")), 'and in the error log');
    fs.rmSync(path.join(tmp, 'inproc'), { force: true }); await db.end();
  });

  console.log('\nRestore into a brand-new database');
  const dumpFile = path.join(tmp, 'source.ndjson.gz');
  const tgtDb = await newDb(); // completely empty: the restore script runs the migrations itself
  const run = (args, env = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'restore-backup.js'), ...args], { env: { ...process.env, DATABASE_URL: withDb(tgtDb), MIGRATE_DATABASE_URL: '', PGSSL: 'disable', ...env }, encoding: 'utf8' });
  const snapshot = async (db) => { // a fingerprint of everything that matters, row by row
    const out = {}; for (const t of ['users', 'products', 'variants', 'orders', 'order_items', 'order_events', 'messages', 'settings', 'zones', 'stores', 'categories', 'coupons', 'addresses', 'outbox']) { const r = await sql(`SELECT COUNT(*)::int n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM ${t} x`, db); out[t] = r.rows[0]; } return out;
  };
  await test('take the source backup, then --check proves the file is whole', async () => {
    const r = await srcAdmin.get('/api/admin/backups/download'); assert.ok(r.status === 200 || r.status === 429, 'status ' + r.status);
    fs.copyFileSync(path.join(tmp, 'fresh.ndjson.gz'), dumpFile);
    const c = run([dumpFile, '--check']); assert.strictEqual(c.status, 0, c.stderr + c.stdout); assert.match(c.stdout, /Backup file is complete/);
    assert.strictEqual((await sql("SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'", tgtDb)).rows[0].n, 0, '--check did not touch the target');
  });
  await test('refuses without the right --confirm host, with a cut-off file, and with no file at all', async () => {
    let r = run([dumpFile]); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /--confirm 127\.0\.0\.1/);
    r = run([dumpFile, '--confirm', 'db.live.example.com']); assert.notStrictEqual(r.status, 0);
    const buf = fs.readFileSync(dumpFile), cut = path.join(tmp, 'cut.ndjson.gz'); fs.writeFileSync(cut, buf.subarray(0, Math.floor(buf.length / 2)));
    r = run([cut, '--check']); assert.notStrictEqual(r.status, 0); assert.match(r.stderr + r.stdout, /incomplete|unexpected end|damaged|Nothing/i);
    const lines = zlib.gunzipSync(buf).toString().split('\n').filter(Boolean); const noEnd = path.join(tmp, 'noend.ndjson.gz'); fs.writeFileSync(noEnd, zlib.gzipSync(lines.slice(0, -1).join('\n') + '\n'));
    r = run([noEnd, '--check']); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /incomplete/);
    const lie = path.join(tmp, 'lie.ndjson.gz'); fs.writeFileSync(lie, zlib.gzipSync(lines.map((l) => (l.startsWith('{"type":"end"') ? l.replace(/"orders":\d+/, '"orders":999') : l)).join('\n') + '\n'));
    r = run([lie, '--check']); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /damaged/);
    assert.strictEqual(run([]).status === 0, false);
    assert.strictEqual((await sql("SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'", tgtDb)).rows[0].n, 0, 'target still untouched');
  });
  await test('restore into the empty database: every table has the same rows, byte for byte', async () => {
    const r = run([dumpFile, '--confirm', '127.0.0.1']); assert.strictEqual(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /Restored \d+ records/);
    const a = await snapshot(srcDb), b = await snapshot(tgtDb); assert.deepStrictEqual(b, a);
    assert.ok(a.orders.n >= 2 && a.users.n >= 2 && a.products.n > 5 && a.messages.n >= 1, JSON.stringify(a));
    assert.strictEqual((await sql("SELECT body FROM messages ORDER BY id DESC LIMIT 1", tgtDb)).rows[0].body, (await sql("SELECT body FROM messages ORDER BY id DESC LIMIT 1", srcDb)).rows[0].body, 'unicode, quotes, backslashes and newlines survive');
    assert.strictEqual((await sql('SELECT COUNT(*)::int n FROM sessions', tgtDb)).rows[0].n, 0, 'nobody stays signed in on a restored copy');
  });
  await test('the restored database runs the shop: admin and shopper can sign in with their old passwords, new orders get fresh ids, stock still adds up', async () => {
    const s = await up(spawnServer(tgtDb)); const adm = await login(s.base);
    const a = new Client(s.base); assert.strictEqual((await a.post('/api/auth/login', { email: 'ada@example.com', password: 'ada password 1' })).status, 200);
    const maxBefore = (await sql('SELECT MAX(id)::int m FROM orders', tgtDb)).rows[0].m, itemsBefore = (await sql('SELECT MAX(id)::int m FROM order_items', tgtDb)).rows[0].m;
    const p = (await a.get('/api/products?store=electronics')).json.products.find((x) => !x.hasVariants && x.stock > 5); const stock0 = (await sql('SELECT stock FROM products WHERE id=$1', tgtDb, [p.id])).rows[0].stock;
    const o = await a.post('/api/checkout', { items: [{ productId: p.id, qty: 1 }], contact: { name: 'Ada', email: 'ada@example.com', phone }, address: { state: 'Lagos', city: 'Yaba', address: '5 New Road' }, delivery: 'standard', payment: 'pod' }, ipn()); assert.strictEqual(o.status, 200, o.text);
    assert.ok((await sql('SELECT MAX(id)::int m FROM orders', tgtDb)).rows[0].m > maxBefore && (await sql('SELECT MAX(id)::int m FROM order_items', tgtDb)).rows[0].m > itemsBefore, 'ids continue, no clash');
    assert.strictEqual((await sql('SELECT stock FROM products WHERE id=$1', tgtDb, [p.id])).rows[0].stock, stock0 - 1);
    assert.strictEqual((await adm.get('/api/admin/dashboard')).status, 200); assert.strictEqual((await new Client(s.base).get('/health/deep')).json.checks.database.ok, true); await stop(s);
  });
  await test('a second restore into a database that now has data is refused and changes nothing; --replace overwrites it back to the backup', async () => {
    const before = await snapshot(tgtDb); let r = run([dumpFile, '--confirm', '127.0.0.1']); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /already has data/); assert.deepStrictEqual(await snapshot(tgtDb), before, 'nothing changed');
    r = run([dumpFile, '--confirm', '127.0.0.1', '--replace']); assert.strictEqual(r.status, 0, r.stderr); assert.deepStrictEqual(await snapshot(tgtDb), await snapshot(srcDb), 'back to the backup');
  });
  await test('a restore that fails half way leaves the database exactly as it was (all or nothing)', async () => {
    const lines = zlib.gunzipSync(fs.readFileSync(dumpFile)).toString().split('\n').filter(Boolean);
    const i = lines.findIndex((l) => l.startsWith('{"t":"order_items"')); const o = JSON.parse(lines[i]); o.rows[0].order_id = 987654321; lines[i] = JSON.stringify(o); // points at an order that does not exist
    const bad = path.join(tmp, 'badfk.ndjson.gz'); fs.writeFileSync(bad, zlib.gzipSync(lines.join('\n') + '\n'));
    const before = await snapshot(tgtDb); const r = run([bad, '--confirm', '127.0.0.1', '--replace']); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /Nothing was changed/); assert.deepStrictEqual(await snapshot(tgtDb), before);
  });
  await stop(srcSrv);

  for (const p of procs) p.kill(); await sleep(400); hook.close(); storage.close();
  for (const d of dbs) await sql(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); for (const p of procs) p.kill(); for (const d of dbs) await sql(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {}); process.exit(1); });
