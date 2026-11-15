'use strict';
// Proves the app is stateless: two identical copies behind a load balancer, one database, one storage.
// Run with: npm run test:multi   (needs TEST_DATABASE_URL like npm test)
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client: PgClient } = require('pg');
const mockSupabase = require('./mock-supabase');
const { createLb } = require('../scripts/dev-lb');

const ADMIN_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DB = 'sb_multi_' + Math.random().toString(36).slice(2, 10);
const withDb = (n) => { const u = new URL(ADMIN_URL); u.pathname = '/' + n; return u.toString(); };
const ssl = process.env.PGSSL_TEST === 'require' ? { rejectUnauthorized: false } : false;
const sql = async (q, db) => { const c = new PgClient({ connectionString: db ? withDb(db) : ADMIN_URL, ssl }); await c.connect(); try { return await c.query(q); } finally { await c.end(); } };
const KEY = 'multi-key', base = 3800 + Math.floor(Math.random() * 100);
const ports = [base, base + 1], LB = base + 2;
let passed = 0; const procs = [];
const ok = (m) => { passed++; console.log('  ok   ' + m); };

function start(port, name, dataDir, storageUrl) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), INSTANCE_ID: name, DATA_DIR: dataDir, DATABASE_URL: withDb(DB), PGSSL: process.env.PGSSL_TEST || 'disable', BASE_URL: 'http://127.0.0.1:' + LB, SUPABASE_URL: storageUrl, SUPABASE_SERVICE_ROLE_KEY: KEY, SUPABASE_BUCKET: 'shop-images', STORAGE_DRIVER: '', DRAIN_MS: '300', PAYSTACK_SECRET_KEY: '', ADMIN_SETUP_CODE: 'test-setup-code', RESEND_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; }); procs.push(p); return p;
}
async function waitUp(port) { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 100)); } throw new Error('instance on ' + port + ' did not start'); }

class Client {
  constructor(url) { this.url = url; this.cookie = ''; this.seen = new Set(); }
  async req(method, p, body) {
    const r = await fetch(this.url + p, { method, headers: { 'X-Requested-With': 'shop-beta', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) this.cookie = c.split(';')[0];
    if (r.headers.get('x-instance')) this.seen.add(r.headers.get('x-instance'));
    const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch { /* html */ }
    return { status: r.status, json, text: t, headers: r.headers };
  }
  get(p) { return this.req('GET', p); } post(p, b = {}) { return this.req('POST', p, b); }
}

(async () => {
  const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), 'sb-a-')), fs.mkdtempSync(path.join(os.tmpdir(), 'sb-b-'))]; // separate disks: nothing can be shared through files
  const storage = await mockSupabase.start(KEY);
  await sql(`CREATE DATABASE ${DB}`);
  let failed = false;
  try {
    // Start one first so migrations and seeding run once, then the second.
    start(ports[0], 'A', dirs[0], storage.url); await waitUp(ports[0]);
    start(ports[1], 'B', dirs[1], storage.url); await waitUp(ports[1]);
    const lb = createLb(ports.map((p) => 'http://127.0.0.1:' + p), { healthMs: 300 });
    await new Promise((r) => lb.server.listen(LB, '127.0.0.1', r));
    const LBURL = 'http://127.0.0.1:' + LB;
    console.log('\nTwo identical instances behind a load balancer');

    const c = new Client(LBURL);
    for (let i = 0; i < 10; i++) await c.get('/api/config');
    assert.deepStrictEqual([...c.seen].sort(), ['A', 'B']); ok('the load balancer spreads requests over both instances');

    // Sign in on whichever instance answers, then prove the session works on each of them directly.
    const reg = await c.post('/api/auth/register', { name: 'Multi Tester', email: 'multi@example.com', phone: '08012345678', password: 'correct horse' });
    assert.strictEqual(reg.status, 200);
    for (const p of ports) { const d = new Client('http://127.0.0.1:' + p); d.cookie = c.cookie; const me = await d.get('/api/me'); assert.strictEqual(me.json.user && me.json.user.email, 'multi@example.com', 'session known to instance on ' + p); }
    ok('a sign-in made on one instance is recognised by the other (sessions live in the database)');

    // Admin uploads a photo through the LB; both instances give back the same stored photo; neither writes to its disk.
    const adm = new Client(LBURL); assert.strictEqual((await adm.post('/api/admin/setup', { code: 'test-setup-code', name: 'Boss', email: 'boss@example.com', password: 'correct horse' })).status, 200);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const up = await adm.post('/api/admin/upload', { data: png }); assert.strictEqual(up.status, 200);
    assert.ok(up.json.url.startsWith(storage.url), 'photo URL points at storage, not at an instance');
    assert.strictEqual((await fetch(up.json.url)).status, 200);
    for (const d of dirs) assert.ok(!fs.existsSync(path.join(d, 'uploads')) || fs.readdirSync(path.join(d, 'uploads')).length === 0);
    ok('a photo uploaded through one instance is served from storage for everyone; no instance writes it to disk');
    for (const p of ports) { const r = await fetch(`http://127.0.0.1:${p}/uploads/${up.json.url.split('/').pop()}`, { redirect: 'manual' }); assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.get('location'), up.json.url); }
    ok('old /uploads/ links redirect to storage on both instances');

    // The login rate limit is shared: 8 bad tries split across both instances lock the account out on either.
    const bad = new Client(LBURL);
    for (let i = 0; i < 8; i++) await new Client('http://127.0.0.1:' + ports[i % 2]).post('/api/auth/login', { email: 'victim@example.com', password: 'nope nope nope' });
    for (const p of ports) assert.strictEqual((await new Client('http://127.0.0.1:' + p).post('/api/auth/login', { email: 'victim@example.com', password: 'nope nope nope' })).status, 429);
    void bad; ok('login attempt limits are counted across both instances together');

    // Stop instance A while traffic flows: nothing should fail.
    const results = []; let stop = false;
    const traffic = (async () => { while (!stop) { try { results.push((await fetch(LBURL + '/api/config')).status); } catch { results.push('err'); } await new Promise((r) => setTimeout(r, 15)); } })();
    await new Promise((r) => setTimeout(r, 400));
    procs[0].kill('SIGTERM'); await new Promise((r) => procs[0].once('exit', r));
    await new Promise((r) => setTimeout(r, 1500)); stop = true; await traffic;
    const bads = results.filter((s) => s !== 200);
    assert.ok(results.length > 40, 'traffic ran'); assert.strictEqual(bads.length, 0, 'failed requests during shutdown: ' + bads.length + ' of ' + results.length);
    ok(`one instance shut down under traffic: ${results.length} requests, 0 failed`);
    assert.strictEqual((await c.get('/api/me')).json.user.email, 'multi@example.com'); ok('the surviving instance still knows the signed-in shopper');
    lb.server.close();
  } catch (e) { failed = true; console.log('  FAIL ' + String(e.message)); console.log(procs.map((p, i) => '--- instance ' + 'AB'[i] + ' log ---\n' + p.log.split('\n').slice(-15).join('\n')).join('\n')); }
  finally { procs.forEach((p) => p.kill()); storage.close(); await sql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); }
  console.log(`\n${passed} passed${failed ? ', FAILED' : ''}`); process.exit(failed ? 1 : 0);
})();
