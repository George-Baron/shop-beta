'use strict';
// Shop-Beta server: serves the single-page storefront + admin, and the JSON API behind them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tiny .env loader (so you do not need an extra package). Real environment variables win.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env file */ }

const express = require('express');
const compression = require('compression');
const cache = require('./lib/cache');
const { ensureAdmin } = require('./lib/bootstrap-admin');
const { get, all, insert, now, DATA_DIR, ping, end } = require('./lib/db');
const { migrate } = require('./lib/migrate');
const storage = require('./lib/storage');
const { seed } = require('./lib/seed');
const S = require('./lib/shop');
const A = require('./lib/auth');
const jobs = require('./lib/jobs');

const { esc, BASE_URL, getSettings, parseImages, naira } = S;
const app = require('./lib/async-router').protect(express());
app.disable('x-powered-by');
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '0' ? false : 1);
// gzip for pages and API answers (Cloudflare may compress again with brotli; that is fine). Photos are not served from here.
app.use(compression({ level: 4, threshold: 1024 }));

/* ---------- first admin from environment variables (optional) ---------- */
async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
  if (email && pw.length >= 8 && !(await get("SELECT 1 x FROM users WHERE role='admin'")) && !(await get('SELECT 1 x FROM users WHERE lower(email)=?', email))) {
    await insert("INSERT INTO users (name,email,phone,password,role,created) VALUES ('Store owner',?,'',?, 'admin', ?)", email, await A.hashPassword(pw), now());
    console.log('Admin account created for', email);
  }
}

/* ---------- security headers ---------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), payment=(), usb=(), geolocation=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

/* ---------- health check (used by the load balancer) ---------- */
const INSTANCE = process.env.INSTANCE_ID || process.env.RENDER_INSTANCE_ID || require('os').hostname();
let draining = false;
app.use((req, res, next) => { res.setHeader('X-Instance', INSTANCE); next(); });
app.get('/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Instance', INSTANCE);
  if (draining) return res.status(503).json({ ok: false, status: 'shutting down', instance: INSTANCE });
  try { await ping(); res.json({ ok: true, db: true, instance: INSTANCE, cache: cache.snapshot() }); }
  catch (e) { res.status(503).json({ ok: false, db: false, instance: INSTANCE }); }
});

/* ---------- uploads ---------- */
// Photos live in Supabase Storage. Old links like /uploads/abc.jpg (emails, search results) are forwarded there.
if (storage.DRIVER === 'local') {
  app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), {
    maxAge: '30d', immutable: true, index: false, dotfiles: 'ignore',
    setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'"); },
  }));
} else {
  app.get('/uploads/:name', (req, res) => {
    if (!/^[a-f0-9]{16,}\.(png|jpg|webp|gif)$/.test(req.params.name) || storage.DRIVER === 'none') return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=86400'); res.redirect(301, storage.publicUrl(req.params.name));
  });
}

/* ---------- API ---------- */
// A NUL character can never be valid text and makes Postgres throw; refuse it up front (URL, query and JSON body).
const hasNul = (v) => typeof v === 'string' && (v.includes('\u0000') || v.includes('%00'));
app.use('/api', (req, res, next) => hasNul(req.originalUrl) ? res.status(400).json({ error: 'That request was not understood.' }) : next());
const rejectNulBody = (req, res, next) => (req.rawBody && req.rawBody.includes(0)) || (req.body && JSON.stringify(req.body).includes('\\u0000')) ? res.status(400).json({ error: 'That request was not understood.' }) : next();
app.use('/api/admin/upload', express.json({ limit: '4mb' }));
app.use('/api', express.json({ limit: '200kb', verify: (req, res, buf) => { req.rawBody = buf; } }), rejectNulBody);
// Cross-site request protection for anything that changes data (the Paystack webhook is signed instead and is exempt):
//  1. if the browser says where the request came from, it must be this site (Origin and Sec-Fetch-Site);
//  2. a request carrying a cookie must also carry our own header, which another website cannot add without our permission.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path !== '/paystack/webhook') {
    const blocked = () => res.status(403).json({ error: 'Request blocked.' });
    if (req.headers.origin) { let ok = false; try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { /* bad origin */ } if (!ok) return blocked(); }
    const site = req.headers['sec-fetch-site']; if (site && !['same-origin', 'none'].includes(site)) return blocked();
    if (req.headers.cookie && req.headers['x-requested-with'] !== 'shop-beta') return blocked();
  }
  next();
});
app.use('/api', A.loadUser);
app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/public'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

/* ---------- robots & sitemap ---------- */
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /checkout\nDisallow: /account\nDisallow: /order/\nDisallow: /login\nDisallow: /register\n\nSitemap: ${BASE_URL}/sitemap.xml\n`);
});
app.get('/sitemap.xml', async (req, res) => {
  const xml = await cache.memo('sitemap', 600000, async () => {
    const urls = [BASE_URL + '/'];
    for (const s of await all('SELECT slug FROM stores WHERE active=1 ORDER BY sort')) urls.push(`${BASE_URL}/d/${s.slug}`);
    for (const p of ['about', 'faq', 'shipping', 'contact', 'privacy', 'terms']) urls.push(`${BASE_URL}/page/${p}`);
    for (const p of await all('SELECT p.slug FROM products p JOIN stores s ON s.slug=p.store WHERE p.active=1 AND s.active=1 ORDER BY p.id DESC LIMIT 5000')) urls.push(`${BASE_URL}/product/${p.slug}`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
  });
  res.set('Cache-Control', 'public, max-age=300').type('application/xml').send(xml);
});

/* ---------- pages (one HTML shell, filled in per URL for search engines and link previews) ---------- */
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'views', 'index.html'), 'utf8');
const PAGES = { about: 'About us', faq: 'Frequently asked questions', shipping: 'Shipping & Returns', privacy: 'Privacy policy', terms: 'Terms of service', contact: 'Contact us' };
const NOINDEX = new Set(['checkout', 'order', 'account', 'login', 'register', 'forgot', 'wishlist', 'track', 'admin']);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const absUrl = (u) => (!u ? '' : /^https?:\/\//.test(u) ? u : BASE_URL + u);

function pixelSnippet(id, nonce) {
  return `<script nonce="${nonce}">!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');</script>`;
}

async function describeUncached(req) {
  const S0 = await getSettings(), p = req.path.replace(/\/+$/, '') || '/', seg = p.split('/').filter(Boolean);
  const out = { status: 200, store: '', title: S0.store_name, desc: S0.tagline, canonical: BASE_URL + p, image: '', type: 'website', jsonld: null, noindex: false, body: '', S: S0 };
  const stores = await all('SELECT slug, name, tab_label FROM stores WHERE active=1 ORDER BY sort');
  const nav = `<nav>${stores.map((s) => `<a href="/d/${esc(s.slug)}">${esc(s.name)}</a>`).join(' ')}</nav>`;
  const productLinks = (rows) => `<ul>${rows.map((r) => `<li><a href="/product/${esc(r.slug)}">${esc(r.name)}</a> ${naira(r.price)}</li>`).join('')}</ul>`;
  out.body = `<h1>${esc(S0.store_name)}</h1><p>${esc(S0.tagline)}</p>${nav}<p>Please enable JavaScript to shop.</p>`;

  if (NOINDEX.has(seg[0])) { out.noindex = true; out.title = seg[0] === 'admin' ? 'Admin · ' + S0.store_name : S0.store_name; if (seg[0] === 'admin') out.store = ''; return out; }
  if (seg[0] === 'd' && seg[1]) {
    const s = await get('SELECT * FROM stores WHERE slug=? AND active=1', seg[1]);
    if (!s) { out.status = 404; out.noindex = true; return out; }
    out.store = s.slug; out.title = `${s.name} · ${S0.store_name}`; out.desc = clip(s.hero_sub || s.tagline, 160);
    out.canonical = `${BASE_URL}/d/${s.slug}`;
    out.body = `<h1>${esc(s.name)}</h1><p>${esc(s.hero_sub)}</p>${nav}${productLinks(await all('SELECT slug, name, price FROM products WHERE store=? AND active=1 ORDER BY featured DESC, id DESC LIMIT 30', s.slug))}`;
    return out;
  }
  if (seg[0] === 'shop') {
    const s = req.query.store ? await get('SELECT * FROM stores WHERE slug=? AND active=1', String(req.query.store).slice(0, 40)) : null;
    out.store = s ? s.slug : ''; out.title = (s ? s.name : 'Shop') + ' · ' + S0.store_name; out.desc = clip(s ? s.hero_sub : S0.tagline, 160);
    out.canonical = BASE_URL + '/shop' + (s ? '?store=' + s.slug : '');
    out.noindex = !!(req.query.q || req.query.page || req.query.sort || req.query.min || req.query.max || req.query.size || req.query.color || req.query.rating || req.query.instock || req.query.flag);
    out.body = `<h1>${esc(s ? s.name : 'Shop')}</h1>${nav}${productLinks(await all(`SELECT slug, name, price FROM products WHERE active=1 ${s ? 'AND store=?' : ''} ORDER BY id DESC LIMIT 40`, ...(s ? [s.slug] : [])))}`;
    return out;
  }
  if (seg[0] === 'product' && seg[1]) {
    const pr = await get('SELECT p.*, c.name category, (SELECT AVG(rating) FROM reviews r WHERE r.product_id=p.id AND r.approved=1) rating, (SELECT COUNT(*) FROM reviews r WHERE r.product_id=p.id AND r.approved=1) rn FROM products p LEFT JOIN categories c ON c.id=p.category_id JOIN stores s ON s.slug=p.store AND s.active=1 WHERE p.active=1 AND p.slug=?', seg[1].slice(0, 120));
    if (!pr) { out.status = 404; out.noindex = true; return out; }
    const img = absUrl(parseImages(pr.images)[0]);
    out.store = pr.store; out.title = `${pr.name} · ${S0.store_name}`; out.desc = clip(pr.description, 160) || pr.name; out.canonical = `${BASE_URL}/product/${pr.slug}`; out.image = img; out.type = 'product';
    out.jsonld = { '@context': 'https://schema.org', '@type': 'Product', name: pr.name, description: clip(pr.description, 500), sku: pr.sku, brand: { '@type': 'Brand', name: pr.brand }, ...(img ? { image: [img] } : {}),
      offers: { '@type': 'Offer', priceCurrency: 'NGN', price: pr.price, availability: pr.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url: out.canonical },
      ...(pr.rn ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: Math.round(pr.rating * 10) / 10, reviewCount: pr.rn } } : {}) };
    out.body = `<h1>${esc(pr.name)}</h1><p>${esc(pr.brand)} · ${naira(pr.price)}</p><p>${esc(pr.description)}</p>${nav}`;
    return out;
  }
  if (seg[0] === 'page' && seg[1]) {
    if (!PAGES[seg[1]]) { out.status = 404; out.noindex = true; return out; }
    out.title = `${PAGES[seg[1]]} · ${S0.store_name}`; out.canonical = `${BASE_URL}/page/${seg[1]}`; return out;
  }
  if (p === '/') return out;
  out.status = 404; out.noindex = true; out.title = 'Page not found · ' + S0.store_name;
  return out;
}

// The page details (title, product data for search engines) are the same for everyone, so keep them briefly.
// Only successful pages are kept, so made-up addresses cannot fill the cache.
const DESCRIBE_KEYED = new Set(['d', 'product', 'page', 'shop']);
async function describe(req) {
  const p = req.path.replace(/\/+$/, '') || '/', seg = p.split('/').filter(Boolean);
  if (p !== '/' && !DESCRIBE_KEYED.has(seg[0])) return describeUncached(req);
  if (seg[0] === 'shop') return describeUncached(req); // depends on the search options in the address
  const key = 'page:' + p;
  return cache.memo(key, 60000, async () => { const d = await describeUncached(req); return d.status === 200 ? d : cache.skip(d); });
}
app.get(/^\/(?!api\/|uploads\/).*/, async (req, res) => {
  const d = await describe(req);
  const nonce = crypto.randomBytes(16).toString('base64');
  const tags = [
    `<title>${esc(d.title)}</title>`, `<meta name="description" content="${esc(d.desc)}">`, `<link rel="canonical" href="${esc(d.canonical)}">`,
    d.noindex ? '<meta name="robots" content="noindex,nofollow">' : '',
    `<meta property="og:site_name" content="${esc(d.S.store_name)}"><meta property="og:title" content="${esc(d.title)}"><meta property="og:description" content="${esc(d.desc)}"><meta property="og:type" content="${d.type}"><meta property="og:url" content="${esc(d.canonical)}">`,
    d.image ? `<meta property="og:image" content="${esc(d.image)}"><meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">',
    d.jsonld ? `<script type="application/ld+json" id="ldp">${JSON.stringify(d.jsonld).replace(/</g, '\\u003c')}</script>` : '',
    d.S.meta_pixel_id && /^[A-Za-z0-9_-]+$/.test(d.S.meta_pixel_id) ? pixelSnippet(d.S.meta_pixel_id, nonce) : '',
  ].join('\n');
  const html = TEMPLATE.replace(/<script>/g, `<script nonce="${nonce}">`)
    .replace('<!--HTMLATTR-->', d.store && /^[a-z0-9-]+$/.test(d.store) ? ` data-store="${d.store}"` : '')
    .replace('<!--SEO-->', () => tags).replace('<!--PRERENDER-->', () => d.body);
  res.status(d.status).set({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
    'Content-Security-Policy': [
      "default-src 'self'", `script-src 'nonce-${nonce}' https://www.googletagmanager.com https://connect.facebook.net`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", 'font-src https://fonts.gstatic.com', "img-src 'self' data: https:",
      "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://www.facebook.com https://connect.facebook.net",
      "form-action 'self'", "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'",
    ].join('; '),
  }).send(html);
});

/* ---------- errors ---------- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof S.HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request was not understood.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
  // Postgres says the input itself is impossible (bad text encoding, number too big, wrong type): that is the caller's mistake, not ours.
  if (err && ['22021', '22003', '22P02', '22007', '22008'].includes(err.code)) return res.status(400).json({ error: 'That request was not understood.' });
  console.error(`${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

/* ---------- start ---------- */
const PORT = Number(process.env.PORT) || 3000;
let server;
async function main() {
  await ping();                 // fail fast with a clear message if the database cannot be reached
  await storage.init();
  if (process.env.MIGRATE_ON_START !== '0') { const done = await migrate(); if (done.length) console.log('Database migrated:', done.join(', ')); }
  await ensureAdmin();          // creates the first administrator from ADMIN_EMAIL/ADMIN_PASSWORD; in production refuses to start with none
  await seed();
  await bootstrapAdmin();
  // Node closes idle connections after 5 s by default, which makes load balancers (Render, Cloudflare) see random 502 errors. Keep them longer than the balancer does.
  const setTimeouts = (srv) => { srv.keepAliveTimeout = 65000; srv.headersTimeout = 66000; srv.requestTimeout = 60000; };
  server = app.listen(PORT, process.env.HOST || '0.0.0.0', async () => {
    setTimeouts(server);
    console.log(`\nShop-Beta is running at ${BASE_URL}`);
    console.log(`Admin dashboard:   ${BASE_URL}/admin${(await get("SELECT 1 x FROM users WHERE role='admin'")) ? '' : '   (open it now to create your admin account)'}`);
    console.log(storage.DRIVER === 'supabase' ? 'Photos: Supabase Storage.' : storage.DRIVER === 'local' ? 'Photos: LOCAL DISK (development only; they would be lost on a hosted server).' : 'Photos: storage not configured, uploads are disabled (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).');
    console.log(S.paystackLive() ? 'Paystack: LIVE keys are set.' : 'Paystack: no PAYSTACK_SECRET_KEY set, so online payment runs in demo mode (no real money).');
    if (!process.env.RESEND_API_KEY) console.log('Email: RESEND_API_KEY not set, so emails are stored in Admin > Marketing > Email outbox instead of being sent.');
    jobs.start();
    cache.start();
    if (cache.DISABLED) console.log('Cache: DISABLED by CACHE_DISABLED=1.');
  });
}
process.on('unhandledRejection', (e) => console.error('Unhandled error:', e));
main().catch((e) => { console.error('Could not start:', e.message); process.exit(1); });
// Finish in-flight requests, then close the database connections.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  if (stopping) return; stopping = true;
  // Tell the load balancer first (/health now says 503), give it a moment to stop sending traffic, then finish in-flight requests.
  draining = true; cache.stop();
  setTimeout(() => process.exit(0), 15000).unref();
  setTimeout(() => (server ? new Promise((r) => server.close(r)) : Promise.resolve()).then(() => jobs.stop()).then(() => end()).catch(() => {}).then(() => process.exit(0)), Number(process.env.DRAIN_MS ?? 3000));
});
