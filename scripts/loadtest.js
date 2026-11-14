'use strict';
// Load test for Shop-Beta. No extra packages. Each "connection" is one simulated shopper who keeps asking for the next page as soon as the last one arrives.
//
//   TARGET=https://staging.example.com  STAGES=10,50,100,200  SECONDS=20  node scripts/loadtest.js
//
// Environment:
//   TARGET     base URL (default http://127.0.0.1:3000)
//   STAGES     comma list of simultaneous shoppers, one stage each (default 10,50,100)
//   SECONDS    length of each stage (default 15)
//   MIX        browse,search,product,checkout weights (default 55,15,28,2: mostly looking, a few searches, very few orders)
//   CHECKOUT   set to 1 to place REAL orders (pay on delivery). Only ever use on a staging copy: it creates orders and uses up stock.
//   FAKE_IPS   1 = each shopper sends its own visitor address the way Cloudflare would (needs the app behind a Cloudflare range or a test setup)
// Each stage prints requests per second, response times (median, 95th, 99th percentile) and the errors seen.
// Do NOT point this at your live shop or at someone else's site. Rate limits and your hosting provider will, rightly, object.
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0);
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const WORDS = ['phone', 'shirt', 'rice', 'cream', 'shoe', 'bag', 'oil', 'watch', 'dress', 'laptop', 'soap', 'tea', 'milk', 'cable', 'sneaker', 'serum'];

function client(target) {
  const u = new URL(target); const lib = u.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 1000 });
  return (method, path, body, headers = {}) => new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request({ agent, hostname: u.hostname, port: u.port, path, method, headers: { 'Accept-Encoding': 'gzip', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }, timeout: 20000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, gz: res.headers['content-encoding'] === 'gzip', ms: Number(process.hrtime.bigint() - t0) / 1e6, body: Buffer.concat(chunks), bytes: Buffer.concat(chunks).length }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, error: e.code || e.message, bytes: 0 }));
    if (data) req.write(data); req.end();
  });
}

const text = (r) => (r.gz ? require('zlib').gunzipSync(r.body) : r.body).toString() || '{}';
async function discover(call) {
  const cfg = JSON.parse(text(await call('GET', '/api/config')));
  const stores = (cfg.stores || []).map((s) => s.slug);
  const prods = JSON.parse(text(await call('GET', '/api/products?instock=1&sort=newest'))).products || [];
  // for checkout: pick items a shopper can really buy (with a size/colour chosen when the product has variants)
  const buyable = [];
  for (const p of prods.slice(0, 40)) {
    const d = JSON.parse(text(await call('GET', '/api/products/' + p.slug))).product; if (!d) continue;
    const v = (d.variants || []).find((x) => x.stock > 0);
    if (!(d.variants || []).length) buyable.push({ productId: d.id }); else if (v) buyable.push({ productId: d.id, variantId: v.id });
  }
  return { buyable, stores: stores.length ? stores : ['fashion'], slugs: prods.map((p) => p.slug), ids: prods.map((p) => p.id), categories: (cfg.categories || []).map((c) => c.slug) };
}

async function stage({ target, shoppers, seconds, mix, checkout, fakeIps }) {
  const call = client(target); const world = await discover(call);
  const [wBrowse, wSearch, wProduct, wCheckout] = mix; const total = wBrowse + wSearch + wProduct + (checkout ? wCheckout : 0);
  const stats = {}; const rec = (name, r) => { const s = (stats[name] = stats[name] || { n: 0, ms: [], err: {}, bytes: 0 }); s.n++; s.ms.push(r.ms); s.bytes += r.bytes; if (r.status === 0 || r.status >= 400) { const k = r.error || r.status; s.err[k] = (s.err[k] || 0) + 1; if (!s.sample) s.sample = {}; if (!s.sample[k]) { try { s.sample[k] = text(r).slice(0, 160); } catch { s.sample[k] = ''; } } } };
  const end = Date.now() + seconds * 1000; let orders = 0;
  const one = async (id) => {
    const ip = `41.${(id >> 8) & 255}.${id & 255}.${1 + Math.floor(Math.random() * 250)}`;
    const h = fakeIps ? { 'X-Forwarded-For': `${ip}, 172.70.0.9`, 'CF-Connecting-IP': ip } : {};
    while (Date.now() < end) {
      const x = Math.random() * total;
      if (x < wBrowse) {
        const store = rnd(world.stores); const roll = Math.random();
        if (roll < 0.35) rec('home', await call('GET', '/api/home/' + store, null, h));
        else rec('list', await call('GET', `/api/products?store=${store}&page=${1 + Math.floor(Math.random() * 4)}&sort=${rnd(['popular', 'newest', 'price_asc', 'price_desc'])}${world.categories.length && Math.random() < 0.5 ? '&category=' + rnd(world.categories) : ''}`, null, h));
      } else if (x < wBrowse + wSearch) {
        // a mix of common words (cached) and one-off words (never cached: the worst case for the database)
        const q = Math.random() < 0.6 ? rnd(WORDS) : crypto.randomBytes(3).toString('hex');
        rec('search', await call('GET', '/api/products?q=' + q, null, h));
      } else if (x < wBrowse + wSearch + wProduct && world.slugs.length) {
        rec('product', await call('GET', '/api/products/' + rnd(world.slugs), null, h));
      } else if (checkout && world.buyable.length) {
        const n = ++orders, tag = crypto.randomBytes(4).toString('hex');
        rec('checkout', await call('POST', '/api/checkout', { items: [{ ...rnd(world.buyable), qty: 1 }], contact: { name: 'Load Test', email: `load${tag}@example.com`, phone: '080' + String(10000000 + Math.floor(Math.random() * 89999999)) }, address: { state: 'Lagos', city: 'Yaba', address: '1 Load Test Street' }, delivery: 'standard', payment: 'pod' }, { ...h, 'Idempotency-Key': crypto.randomUUID() }));
      } else rec('home', await call('GET', '/api/home/' + rnd(world.stores), null, h));
    }
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: shoppers }, (_, i) => one(i + 1)));
  const secs = (Date.now() - t0) / 1000;
  const all = Object.values(stats).flatMap((s) => s.ms).sort((a, b) => a - b);
  const n = all.length, errs = {}; let bad = 0, five = 0, limited = 0;
  for (const s of Object.values(stats)) for (const [k, v] of Object.entries(s.err)) { errs[k] = (errs[k] || 0) + v; if (k === '429') limited += v; else bad += v; if (/^5/.test(k) || /ECONN|timeout|socket|reset/i.test(k)) five += v; }
  const by = Object.fromEntries(Object.entries(stats).map(([k, s]) => { const m = s.ms.sort((a, b) => a - b); return [k, { n: s.n, p50: Math.round(pct(m, 50)), p95: Math.round(pct(m, 95)), p99: Math.round(pct(m, 99)), kb: Math.round(s.bytes / s.n / 1024 * 10) / 10 }]; }));
  const samples = Object.fromEntries(Object.values(stats).flatMap((s) => Object.entries(s.sample || {})));
  return { samples, shoppers, seconds: Math.round(secs), requests: n, rps: Math.round(n / secs), p50: Math.round(pct(all, 50)), p95: Math.round(pct(all, 95)), p99: Math.round(pct(all, 99)), max: Math.round(all[n - 1] || 0), failed: bad, serverErrors: five, rateLimited: limited, errors: errs, by };
}

async function run(opts) {
  const out = [];
  for (const shoppers of opts.stages) {
    const r = await stage({ ...opts, shoppers }); out.push(r);
    console.log(`${String(shoppers).padStart(4)} shoppers  ${String(r.rps).padStart(5)} req/s   median ${String(r.p50).padStart(4)} ms   95th ${String(r.p95).padStart(5)} ms   99th ${String(r.p99).padStart(5)} ms   failed ${r.failed}${r.rateLimited ? `   rate-limited ${r.rateLimited}` : ''}${Object.keys(r.errors).length ? '   ' + JSON.stringify(r.errors) : ''}`);
  }
  return out;
}

module.exports = { run, stage };

if (require.main === module) {
  const target = (process.env.TARGET || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const stages = (process.env.STAGES || '10,50,100').split(',').map(Number).filter(Boolean);
  const mix = (process.env.MIX || '55,15,28,2').split(',').map(Number);
  if (process.env.CHECKOUT === '1') console.log('CHECKOUT=1: this will place real pay-on-delivery orders on ' + target);
  console.log(`Load test against ${target}: stages ${stages.join(', ')} shoppers, ${process.env.SECONDS || 15}s each\n`);
  run({ target, stages, seconds: Number(process.env.SECONDS) || 15, mix, checkout: process.env.CHECKOUT === '1', fakeIps: process.env.FAKE_IPS === '1' })
    .then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
