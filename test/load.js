'use strict';
// Step 9: load test on this machine (app + Postgres + the load generator all share the same CPUs, so real hosting with separate machines does better).
//   npm run test:load            quick check with pass/fail limits (about 1 minute)
//   LOAD_FULL=1 npm run test:load   longer staged run (about 3 minutes) to find where it bends
// Checks: no failed requests at moderate load, search never ruins browsing, 60 buyers fighting over 5 items cannot oversell, the job queue drains after a rush of orders.
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client: Pg } = require('pg');
const { run } = require('../scripts/loadtest');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_load_' + Date.now().toString(36);
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 5900 + Math.floor(Math.random() * 90);
const PRODUCTS = Number(process.env.LOAD_PRODUCTS) || 5000;
const FULL = process.env.LOAD_FULL === '1';
const INSTANCES = Number(process.env.LOAD_INSTANCES) || 1;
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, db, args) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, args)).rows; } finally { await c.end(); } };
const procs = [];
const start = (port, extra = {}) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), BASE_URL: 'http://127.0.0.1:' + port, DATABASE_URL: urlOf(DB), DATABASE_SSL: 'off', DB_POOL_MAX: process.env.DB_POOL_MAX || '10', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sb-load-')), RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '', GEOAPIFY_API_KEY: '', ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', LOG_LEVEL: 'warn', RATE_LIMIT_MULTIPLIER: '100000', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; }); procs.push(p); return p;
};
const up = async (port) => { for (let i = 0; i < 300; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); return; } catch { await sleep(100); } } throw new Error('app did not start'); };
const J = async (port, method, url, body, headers = {}) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* */ } return { s: r.status, j }; };

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  const first = start(PORT); await up(PORT);
  // a realistic catalogue: PRODUCTS products across all departments and categories, some with sizes and colours
  await pg(`INSERT INTO products (slug,store,category_id,name,brand,description,price,compare_price,stock,sku,featured,bestseller,new_arrival,sold,created)
    SELECT 'load-item-'||g, s.slug, (SELECT id FROM categories c WHERE c.store=s.slug ORDER BY id OFFSET (g % GREATEST((SELECT COUNT(*) FROM categories c WHERE c.store=s.slug),1)) LIMIT 1),
           (ARRAY['Phone','Shirt','Rice','Cream','Shoe','Bag','Oil','Watch','Dress','Laptop','Soap','Tea','Milk','Cable','Sneaker','Serum'])[1 + g % 16] || ' model ' || g, 'Brand' || (g % 40),
           'A good quality product number ' || g || ' for everyday use. ' || repeat('Lorem ipsum dolor sit amet. ', 6), 500 + (g * 37) % 90000, CASE WHEN g % 5 = 0 THEN 1000 + (g * 37) % 90000 ELSE 0 END, 20 + g % 80, 'SKU' || g,
           (g % 17 = 0)::int, (g % 11 = 0)::int, (g % 13 = 0)::int, g % 300, extract(epoch from now())::bigint - g
    FROM generate_series(1, ${PRODUCTS}) g JOIN LATERAL (SELECT slug FROM stores ORDER BY slug OFFSET (g % (SELECT COUNT(*) FROM stores)) LIMIT 1) s ON true`, DB);
  await pg("INSERT INTO variants (product_id,size,color,stock) SELECT id, sz, 'Black', 20 FROM products, unnest(ARRAY['S','M','L']) sz WHERE slug LIKE 'load-item-%' AND id % 4 = 0", DB);
  await pg('ANALYZE', DB);
  const total = Number((await pg('SELECT COUNT(*) n FROM products', DB))[0].n); console.log(`Catalogue: ${total} products. ${INSTANCES} app instance(s), ${os.cpus().length} CPUs shared with Postgres and the load generator.\n`);
  const ports = [PORT]; for (let i = 1; i < INSTANCES; i++) { start(PORT + i * 100); ports.push(PORT + i * 100); await up(PORT + i * 100); }
  // tiny round-robin front, like a load balancer
  const http = require('http'); const FRONT = PORT + 50; let rr = 0;
  const front = http.createServer((req, res) => { const target = ports[rr++ % ports.length]; const p = http.request({ port: target, host: '127.0.0.1', path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); p.on('error', () => { res.writeHead(502).end(); }); req.pipe(p); });
  await new Promise((r) => front.listen(FRONT, r));
  const target = 'http://127.0.0.1:' + FRONT;

  const stages = FULL ? [10, 50, 100, 200, 400, 800] : [10, 50, 150];
  const seconds = FULL ? 15 : 8;
  console.log('Browsing and searching (55% listings and home, 15% search, 28% product pages), straight to the app with no Cloudflare in front:');
  const MIX = (process.env.LOAD_MIX || '55,15,28,0').split(',').map(Number);
  const res = await run({ target, stages: process.env.LOAD_STAGES ? process.env.LOAD_STAGES.split(',').map(Number) : stages, seconds, mix: MIX, checkout: false, fakeIps: true });
  if (process.env.LOAD_ONLY === '1') { front.close(); for (const p of procs) p.kill(); await sleep(500); if (process.env.LOAD_KEEP === '1') console.log('kept database ' + DB); else await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); process.exit(0); }
  const at = (n) => res.find((r) => r.shoppers === n) || res[res.length - 1];
  if (process.env.LOAD_VERBOSE === '1') for (const r of res) console.log(r.shoppers + ' shoppers by request type:', JSON.stringify(r.by));

  await test('up to 50 shoppers: no failed requests, 95th percentile under 500 ms', async () => { const r = at(50); assert.strictEqual(r.failed, 0, JSON.stringify(r.errors)); assert.ok(r.p95 < 500, 'p95 ' + r.p95); });
  await test('150-200 shoppers at once: still no server errors or time-outs and 99% of requests under 3 seconds', async () => { const r = at(FULL ? 200 : 150); assert.strictEqual(r.serverErrors, 0, JSON.stringify(r.errors)); assert.ok(r.p99 < 3000, 'p99 ' + r.p99); });
  await test('one-off searches (never cached) stay usable under load', async () => { const s = at(50).by.search; assert.ok(s && s.p95 < 1500, 'search p95 ' + (s && s.p95)); });

  console.log('\nOrders: 60 shoppers fight for 5 items; then a rush of orders.');
  await test('60 simultaneous buyers of an item with 5 in stock: exactly 5 orders succeed, stock ends at 0, never negative', async () => {
    const p = (await pg("SELECT id FROM products WHERE slug='load-item-1'", DB))[0]; await pg('UPDATE products SET stock=5 WHERE id=$1', DB, [p.id]); await pg('DELETE FROM variants WHERE product_id=$1', DB, [p.id]);
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => J(FRONT, 'POST', '/api/checkout', { items: [{ productId: Number(p.id), qty: 1 }], contact: { name: 'Racer ' + i, email: `race${i}@example.com`, phone: '0801000' + String(1000 + i) }, address: { state: 'Lagos', city: 'Yaba', address: '1 Race Street' }, delivery: 'standard', payment: 'pod' }, { 'Idempotency-Key': 'race-' + i + '-' + Date.now(), 'X-Forwarded-For': `41.9.${i}.1, 172.70.0.9`, 'CF-Connecting-IP': `41.9.${i}.1` })));
    const ok = rs.filter((r) => r.s === 200).length; assert.strictEqual(ok, 5, 'statuses: ' + JSON.stringify(rs.reduce((a, r) => ((a[r.s] = (a[r.s] || 0) + 1), a), {})));
    assert.strictEqual(Number((await pg('SELECT stock FROM products WHERE id=$1', DB, [p.id]))[0].stock), 0);
    assert.strictEqual(Number((await pg("SELECT COUNT(*) n FROM order_items WHERE product_id=$1", DB, [p.id]))[0].n), 5);
  });
  await test('a rush of orders: all accepted, every order has its items, and the email/job queue drains afterwards', async () => {
    await pg("UPDATE products SET stock=100000; UPDATE variants SET stock=100000", DB);
    const before = Number((await pg('SELECT COUNT(*) n FROM orders', DB))[0].n);
    const r = await run({ target, stages: [40], seconds: 8, mix: [0, 0, 0, 1], checkout: true, fakeIps: true });
    assert.strictEqual(r[0].serverErrors, 0, JSON.stringify(r[0].errors)); assert.ok(r[0].by.checkout && r[0].by.checkout.n >= 100, 'orders placed: ' + (r[0].by.checkout && r[0].by.checkout.n));
    const made = Number((await pg('SELECT COUNT(*) n FROM orders', DB))[0].n) - before;
    assert.strictEqual(r[0].failed, 0, 'refused orders: ' + JSON.stringify(r[0].errors) + ' ' + JSON.stringify(r[0].samples)); assert.strictEqual(made, r[0].by.checkout.n, `orders in database ${made} vs answered ${r[0].by.checkout.n}`);
    assert.strictEqual(Number((await pg('SELECT COUNT(*) n FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id)', DB))[0].n), 0, 'every order has items');
    const t0 = Date.now(); let left; for (;;) { left = Number((await pg("SELECT COUNT(*) n FROM jobs WHERE state IN ('queued','running') AND kind='email'", DB))[0].n); if (!left || Date.now() - t0 > 60000) break; await sleep(500); }
    assert.strictEqual(left, 0, left + ' email jobs still waiting after 60 s'); console.log(`         ${made} orders, queue drained in ${Math.round((Date.now() - t0) / 1000)} s`);
  });
  await test('after all that the app is still healthy and the database pool is not stuck', async () => {
    assert.strictEqual((await J(FRONT, 'GET', '/health')).s, 200);
    const n = Number((await pg("SELECT COUNT(*) n FROM pg_stat_activity WHERE datname=$1 AND state='idle in transaction'", undefined, [DB]))[0].n); assert.strictEqual(n, 0, 'connections left idle in a transaction');
  });

  front.close(); for (const p of procs) p.kill(); await sleep(500);
  await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
