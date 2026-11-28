'use strict';
const http = require('http'); const crypto = require('crypto');
const { Client } = require('pg');
const { Agent, setGlobalDispatcher } = (() => { try { return require('undici'); } catch { return {}; } })();
// Load test for browsing and checkout. Use ONLY against a throwaway or staging copy: it creates real orders and uses stock.
//   LOAD_DB=postgres://...  (the database behind BASE; used to pick products and to check orders/stock afterwards)
//   LOAD_BASE=http://127.0.0.1:4400  LOAD_FAKE_PORT=4399 (a stand-in for Paystack's API, so 30% of checkouts can start an online payment)
//   node load/burst.js browse 5000        5000 shoppers at once, 5 requests each (NOHOME=1 skips the homepage)
//   node load/burst.js spread 5000        5000 checkouts at once over 6 products (RETRIES=5 attempts each, like the storefront)
//   node load/burst.js hot 5000 300       5000 buyers for ONE product with 300 in stock: must sell exactly 300
// It refuses to run against anything except this computer unless the host is listed in LOAD_TEST_ALLOW (comma separated), so it cannot hit the live shop by accident.
const BASE = process.env.LOAD_BASE || 'http://127.0.0.1:4400', FAKE = Number(process.env.LOAD_FAKE_PORT) || 4399;
{ const h = new URL(BASE).hostname; if (!['127.0.0.1', 'localhost', '::1'].includes(h) && !String(process.env.LOAD_TEST_ALLOW || '').split(',').map((x) => x.trim()).includes(h)) { console.error(`Refusing to load-test ${h}. It is not this computer and not in LOAD_TEST_ALLOW.`); process.exit(2); } }
const DBURL = process.env.LOAD_DB; if (!DBURL) { console.error('Set LOAD_DB to the database behind LOAD_BASE.'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const q = async (sql, a) => { const c = new Client({ connectionString: DBURL }); await c.connect(); try { return (await c.query(sql, a)).rows; } finally { await c.end(); } };
let inits = 0;
const fake = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { const s = (o) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(o)); if (req.url === '/transaction/initialize') { inits++; const j = JSON.parse(Buffer.concat(c)); return s({ status: true, data: { authorization_url: 'https://pay.test/' + j.reference } }); } s({ id: 'x' }); }); });
const ip = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
async function timed(name, i, fn, stats) { const t = performance.now(); let s = 0, ok = false; try { const r = await fn(); s = r.status; await r.text(); ok = s < 400; } catch (e) { s = 'ERR:' + (e.cause && e.cause.code || e.code || e.name); } const ms = performance.now() - t; stats.lat.push(ms); stats.codes[s] = (stats.codes[s] || 0) + 1; stats.by[name] = stats.by[name] || { n: 0, bad: 0, lat: [] }; stats.by[name].n++; stats.by[name].lat.push(ms); if (!ok) stats.by[name].bad++; return s; }
function report(title, st, wall) { st.lat.sort((a, b) => a - b); console.log(`\n=== ${title} ===\nrequests ${st.lat.length} in ${(wall / 1000).toFixed(1)}s (${(st.lat.length / (wall / 1000)).toFixed(0)} req/s)\nstatus: ${JSON.stringify(st.codes)}\nlatency ms  p50 ${pct(st.lat, .5).toFixed(0)}  p95 ${pct(st.lat, .95).toFixed(0)}  p99 ${pct(st.lat, .99).toFixed(0)}  max ${pct(st.lat, 1).toFixed(0)}`); for (const [k, v] of Object.entries(st.by)) { v.lat.sort((a, b) => a - b); console.log(`  ${k.padEnd(14)} n=${v.n} failed=${v.bad} p50=${pct(v.lat, .5).toFixed(0)} p95=${pct(v.lat, .95).toFixed(0)} max=${pct(v.lat, 1).toFixed(0)}`); } }
const H = (i) => ({ 'X-Forwarded-For': ip(i), 'Content-Type': 'application/json' });
(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  const mode = process.argv[2], N = Number(process.argv[3]) || 1000;
  const prods = await q("SELECT id, slug, stock FROM products WHERE active=1 AND id NOT IN (SELECT product_id FROM variants) ORDER BY id LIMIT 6");
  if (mode === 'browse') {
    const st = { lat: [], codes: {}, by: {} }; const t0 = performance.now();
    await Promise.all(Array.from({ length: N }, async (_, i) => {
      const h = H(i + 1), p = prods[i % prods.length];
      if (!process.env.NOHOME) { let html = ''; await timed('home(shell)', i, async () => { const r = await fetch(BASE + '/', { headers: h }); html = await r.clone().text(); return r; }, st);
      for (const u of (html.match(/\/assets\/[^"]+/g) || [])) await timed('asset(first visit)', i, () => fetch(BASE + u, { headers: h }), st); }
      await timed('config', i, () => fetch(BASE + '/api/config', { headers: h }), st);
      await timed('products', i, () => fetch(BASE + '/api/products', { headers: h }), st);
      await timed('product-page', i, () => fetch(BASE + '/api/products/' + p.slug, { headers: h }), st);
      await timed('cart-price', i, () => fetch(BASE + '/api/cart/price', { method: 'POST', headers: h, body: JSON.stringify({ items: [{ productId: p.id, qty: 1 }] }) }), st);
    }));
    report(`BROWSE: ${N} users at once, 5 requests each`, st, performance.now() - t0);
  } else {
    const hot = mode === 'hot'; const HOTSTOCK = Number(process.argv[4]) || 300;
    if (hot) await q('UPDATE products SET stock=$1 WHERE id=$2', [HOTSTOCK, prods[0].id]); else await q('UPDATE products SET stock=100000 WHERE id = ANY($1)', [prods.map((p) => p.id)]);
    const before = Object.fromEntries((await q('SELECT id, stock FROM products WHERE id = ANY($1)', [prods.map((p) => p.id)])).map((r) => [r.id, Number(r.stock)]));
    const ordersBefore = Number((await q('SELECT COUNT(*) n FROM orders'))[0].n);
    const st = { lat: [], codes: {}, by: {} }; const out = []; const t0 = performance.now();
    await Promise.all(Array.from({ length: N }, async (_, i) => {
      const p = hot ? prods[0] : prods[i % prods.length]; const pay = i % 10 < (process.env.PAY_TENTHS === undefined ? 3 : Number(process.env.PAY_TENTHS)) ? 'paystack' : 'pod';   // PAY_TENTHS=0 sends only pay-on-delivery orders (no calls to Paystack)
      const b = { items: [{ productId: p.id, qty: 1 }], contact: { name: 'Load User ' + i, email: `load${Date.now()}_${i}@example.com`, phone: '080' + String(Math.floor(Math.random() * 90000000) + 10000000) }, address: { state: 'Lagos', city: 'Yaba', address: i + ' Load Road' }, delivery: 'standard', payment: pay, idempotencyKey: crypto.randomUUID() };
      const t = performance.now(); let r, j = null, s; let tries = 0;
      for (;;) { // like the storefront: a 'busy' answer is retried after Retry-After (plus a little randomness), up to 8 times, with the same Idempotency-Key
        j = null; tries++;
        try { r = await fetch(BASE + '/api/checkout', { method: 'POST', headers: H(i + 1), body: JSON.stringify(b) }); s = r.status; const tx = await r.text(); try { j = JSON.parse(tx); } catch { /* */ } } catch (e) { s = 'ERR:' + (e.cause && e.cause.code || e.name); }
        if (s === 503 && j && j.code === 'busy' && tries < (Number(process.env.RETRIES) || 8)) { await sleep((Number(r.headers.get('retry-after')) || 3) * 1000 + Math.random() * 2000); continue; }
        break;
      }
      (global.tries = global.tries || []).push(tries);
      const ms = performance.now() - t; st.lat.push(ms); st.codes[s] = (st.codes[s] || 0) + 1; const k = pay; st.by[k] = st.by[k] || { n: 0, bad: 0, lat: [] }; st.by[k].n++; st.by[k].lat.push(ms); if (s !== 200) { st.by[k].bad++; out.push(s + ' ' + (j && (j.error || j.message) || '')); } 
    }));
    const wall = performance.now() - t0;
    report(`CHECKOUT: ${N} simultaneous (${hot ? 'ONE hot product, stock ' + HOTSTOCK : 'spread over ' + prods.length + ' products'}; 30% Paystack, 70% pay-on-delivery)`, st, wall);
    const tr = global.tries.slice().sort((a, b) => a - b); console.log(`attempts per customer: median ${pct(tr, .5)}, p95 ${pct(tr, .95)}, max ${pct(tr, 1)}`);
    const reasons = {}; out.forEach((x) => { reasons[x] = (reasons[x] || 0) + 1; }); console.log('non-200 reasons:', JSON.stringify(reasons));
    await sleep(3000);
    const after = Object.fromEntries((await q('SELECT id, stock FROM products WHERE id = ANY($1)', [prods.map((p) => p.id)])).map((r) => [r.id, Number(r.stock)]));
    const ordersAfter = Number((await q('SELECT COUNT(*) n FROM orders'))[0].n);
    const ok200 = st.codes[200] || 0; const sold = Object.keys(before).reduce((a, k) => a + (before[k] - after[k]), 0);
    console.log(`orders created: ${ordersAfter - ordersBefore}  (200 responses: ${ok200})   stock removed: ${sold}   min stock now: ${Math.min(...Object.values(after))}`);
    console.log('paystack initialisations hit mock:', inits);
    const dup = await q("SELECT COUNT(*) n FROM (SELECT ref FROM orders GROUP BY ref HAVING COUNT(*)>1) x"); console.log('duplicate order refs:', dup[0].n);
    if (hot) console.log(`OVERSELL CHECK: stock ${HOTSTOCK} -> sold ${before[prods[0].id] - after[prods[0].id]}, remaining ${after[prods[0].id]} ->`, after[prods[0].id] >= 0 && (before[prods[0].id] - after[prods[0].id]) <= HOTSTOCK ? 'NO OVERSELL' : 'OVERSELL!');
  }
  process.exit(0);
})();
