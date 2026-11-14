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
const { get, all, run, now, migrate, health } = require('./lib/db');
const log = require('./lib/log');
const storage = require('./lib/storage');
const compression = require('compression');
const cache = require('./lib/cache');
const { seed } = require('./lib/seed');
const S = require('./lib/shop');
const PC = require('./lib/pharmacy-core');
const A = require('./lib/auth');
const worker = require('./lib/worker');

const { esc, BASE_URL, getSettings, parseImages, naira } = S;
const app = express();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// gzip pages and JSON (level 1: nearly the same size, several times less CPU). Pages carry a per-visitor security nonce, so they cannot be compressed once and reused;
// when the request comes through Cloudflare (it adds cf-ray) we send pages uncompressed and let Cloudflare compress them at the edge, which saves a lot of CPU.
app.use(compression({ threshold: 1024, level: 1, filter: (req, res) => !(req.headers['cf-ray'] && /text\/html/.test(String(res.getHeader('Content-Type') || ''))) && compression.filter(req, res) }));
app.disable('x-powered-by');
// TRUST_PROXY: number of proxy hops in front of the app (default 1 = Render). 0 turns it off (not for production).
app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY || '') ? Number(process.env.TRUST_PROXY) || false : 1);
app.use((req, res, next) => { req.clientIp = require('./lib/clientip').clientIp(req); next(); });
app.use(log.requestLogger); // request id on every response and one log line per request

/* ---------- first admin from environment variables (optional) ---------- */
async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
  const weak = email && pw ? require('./lib/passwords').check(pw, { min: require('./lib/passwords').STAFF_MIN }) : '';
  if (weak) console.error('ADMIN_PASSWORD was not used: ' + weak);
  if (email && pw && !weak && !(await get("SELECT 1 x FROM users WHERE role='admin'")) && !(await get('SELECT 1 x FROM users WHERE email=?', email))) {
    // ON CONFLICT: two instances starting together must not crash each other
    const made = await run("INSERT INTO users (name,email,phone,password,role,created) VALUES ('Store owner',?,'',?, 'admin', ?) ON CONFLICT (email) DO NOTHING", email, await A.hashPassword(pw), now());
    if (!made || made.changes !== 0) console.log('Admin account created for', email);
  }
}

/* ---------- security headers ---------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

/* ---------- uploads ---------- */
// Leaflet (the map library) is served from here, not from a third-party CDN.
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '30d', index: false, dotfiles: 'ignore', setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
// Photos live in object storage. Old /uploads/<name> links (emails, bookmarks) still work: in production they redirect to the storage URL.
if (storage.DRIVER === 'local') {
  app.use('/uploads', express.static(storage.LOCAL_DIR, {
    maxAge: '30d', immutable: true, index: false, dotfiles: 'ignore',
    setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'"); },
  }));
} else {
  app.get('/uploads/:name', (req, res) => {
    if (!/^[a-f0-9]{16,}\.(png|jpg|webp|gif)$/.test(req.params.name)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400').redirect(301, storage.urlFor(req.params.name));
  });
}

/* ---------- health (for uptime checks and the load balancer) ---------- */
// Deliberately tiny and public: only "the app is up and can reach the database". Details (queue, backups) are in Admin > Status.
app.get('/health', async (req, res) => {
  try { await Promise.race([health(), new Promise((_, rej) => setTimeout(() => rej(new Error('database timeout')), 4000))]); res.set('Cache-Control', 'no-store').json({ ok: true }); }
  catch (e) { log.error('health check failed', { err: e }); res.status(503).set('Cache-Control', 'no-store').json({ ok: false }); }
});

/* ---------- API ---------- */
// Request bodies are small by default. The photo upload is the one exception, and it reads its larger body only AFTER the admin check (see routes/admin.js).
const smallJson = express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } });
app.use('/api', (req, res, next) => (req.path === '/admin/upload' || (req.method === 'POST' && req.path === '/pharmacy/prescriptions') || /^\/admin\/pharmacy\/pharmacies\/\d+\/agreement$/.test(req.path) ? next() : smallJson(req, res, next)));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
    let ok = false; try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { /* bad origin */ }
    if (!ok) return res.status(403).json({ error: 'Request blocked.' });
  }
  next();
});
app.use('/api', A.loadUser);
app.use('/api/admin/pharmacy', require('./routes/pharmacy-admin'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/pharmacy', require('./routes/pharmacy'));
app.use('/api/rider', require('./routes/rider'));
app.use('/api', require('./routes/public'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

/* ---------- robots & sitemap ---------- */
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /rider\nDisallow: /pharmacist\nDisallow: /api/\nDisallow: /checkout\nDisallow: /account\nDisallow: /order/\nDisallow: /login\nDisallow: /register\n\nSitemap: ${BASE_URL}/sitemap.xml\n`);
});
app.get('/sitemap.xml', ah(async (req, res) => {
  const urls = [BASE_URL + '/'];
  for (const s of await all(`SELECT slug FROM stores s WHERE active=1 AND ${PC.storeVisibleSql('s')} ORDER BY sort`)) urls.push(`${BASE_URL}/d/${s.slug}`);
  for (const p of ['about', 'faq', 'shipping', 'contact', 'privacy', 'terms']) urls.push(`${BASE_URL}/page/${p}`);
  for (const p of await all(`SELECT p.slug FROM products p JOIN stores s ON s.slug=p.store WHERE p.active=1 AND s.active=1 AND ${PC.visibleSql('p')} AND ${PC.storeVisibleSql('s')} ORDER BY p.id DESC LIMIT 5000`)) urls.push(`${BASE_URL}/product/${p.slug}`);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`);
}));

/* ---------- pages (one HTML shell, filled in per URL for search engines and link previews) ---------- */
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'views', 'index.html'), 'utf8');
const PAGES = { about: 'About us', faq: 'Frequently asked questions', shipping: 'Shipping & Returns', privacy: 'Privacy policy', terms: 'Terms of service', contact: 'Contact us' };
const NOINDEX = new Set(['rider', 'pharmacist', 'checkout', 'order', 'account', 'login', 'register', 'forgot', 'wishlist', 'track', 'admin']);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const absUrl = (u) => (!u ? '' : /^https?:\/\//.test(u) ? u : BASE_URL + u);

function pixelSnippet(id, nonce) {
  return `<script nonce="${nonce}">!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');</script>`;
}

async function describe(req) {
  const S0 = await getSettings(), p = req.path.replace(/\/+$/, '') || '/', seg = p.split('/').filter(Boolean);
  const out = { status: 200, store: '', title: S0.store_name, desc: S0.tagline, canonical: BASE_URL + p, image: '', type: 'website', jsonld: null, noindex: false, body: '', S: S0 };
  const stores = await all(`SELECT slug, name, tab_label FROM stores s WHERE active=1 AND ${PC.storeVisibleSql('s')} ORDER BY sort`);
  const nav = `<nav>${stores.map((s) => `<a href="/d/${esc(s.slug)}">${esc(s.name)}</a>`).join(' ')}</nav>`;
  const productLinks = (rows) => `<ul>${rows.map((r) => `<li><a href="/product/${esc(r.slug)}">${esc(r.name)}</a> ${naira(r.price)}</li>`).join('')}</ul>`;
  out.body = `<h1>${esc(S0.store_name)}</h1><p>${esc(S0.tagline)}</p>${nav}<p>Please enable JavaScript to shop.</p>`;

  if (NOINDEX.has(seg[0])) { out.noindex = true; out.title = seg[0] === 'admin' ? 'Admin · ' + S0.store_name : S0.store_name; if (seg[0] === 'admin') out.store = ''; return out; }
  if (seg[0] === 'd' && seg[1]) {
    const s = await get(`SELECT * FROM stores s WHERE slug=? AND active=1 AND ${PC.storeVisibleSql('s')}`, seg[1]);
    if (!s) { out.status = 404; out.noindex = true; return out; }
    out.store = s.slug; out.title = `${s.name} · ${S0.store_name}`; out.desc = clip(s.hero_sub || s.tagline, 160);
    out.canonical = `${BASE_URL}/d/${s.slug}`;
    out.body = `<h1>${esc(s.name)}</h1><p>${esc(s.hero_sub)}</p>${nav}${productLinks(await all(`SELECT slug, name, price FROM products p WHERE store=? AND active=1 AND ${PC.visibleSql('p')} ORDER BY featured DESC, id DESC LIMIT 30`, s.slug))}`;
    return out;
  }
  if (seg[0] === 'shop') {
    const s = req.query.store ? await get(`SELECT * FROM stores s WHERE slug=? AND active=1 AND ${PC.storeVisibleSql('s')}`, String(req.query.store).slice(0, 40)) : null;
    out.store = s ? s.slug : ''; out.title = (s ? s.name : 'Shop') + ' · ' + S0.store_name; out.desc = clip(s ? s.hero_sub : S0.tagline, 160);
    out.canonical = BASE_URL + '/shop' + (s ? '?store=' + s.slug : '');
    out.noindex = !!(req.query.q || req.query.page || req.query.sort || req.query.min || req.query.max || req.query.size || req.query.color || req.query.rating || req.query.instock || req.query.flag);
    out.body = `<h1>${esc(s ? s.name : 'Shop')}</h1>${nav}${productLinks(await all(`SELECT slug, name, price FROM products p WHERE active=1 AND ${PC.visibleSql('p')} ${s ? 'AND store=?' : ''} ORDER BY id DESC LIMIT 40`, ...(s ? [s.slug] : [])))}`;
    return out;
  }
  if (seg[0] === 'product' && seg[1]) {
    const pr = await get(`SELECT p.*, c.name category, (SELECT AVG(rating) FROM reviews r WHERE r.product_id=p.id AND r.approved=1) rating, (SELECT COUNT(*) FROM reviews r WHERE r.product_id=p.id AND r.approved=1) rn FROM products p LEFT JOIN categories c ON c.id=p.category_id JOIN stores s ON s.slug=p.store AND s.active=1 WHERE p.active=1 AND p.slug=? AND ${PC.visibleSql('p')} AND ${PC.storeVisibleSql('s')}`, seg[1].slice(0, 120));
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

// The page head (title, description, structured data, plain-text body for search engines) is the same for everyone, so it is kept for 30 seconds.
// Only successful pages are kept, so a flood of made-up addresses cannot fill the cache with 404s. The per-request nonce below is never cached.
const DESCRIBE_KEYS = ['store', 'q', 'category', 'page', 'sort', 'min', 'max', 'size', 'color', 'rating', 'instock', 'flag'];
const describeCached = (req) => {
  const q = DESCRIBE_KEYS.map((k) => (req.query[k] === undefined ? '' : k + '=' + String(req.query[k]).slice(0, 60))).join('&');
  const key = 'page:' + req.path.slice(0, 200) + '?' + q;
  return cache.cached(key, 30000, () => describe(req), (d) => d.status === 200);
};

app.get(/^\/(?!api\/|uploads\/|health).*/, ah(async (req, res) => {
  const d = await describeCached(req);
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
}));

/* ---------- errors ---------- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof S.HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request was not understood.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
  log.error('unhandled error', { id: req.id, method: req.method, path: String(req.originalUrl || '').split('?')[0], err });
  require('./lib/errors').record(err, { source: 'request', route: `${req.method} ${req.route && req.route.path ? req.baseUrl + req.route.path : String(req.path).replace(/\d+/g, ':n')}`, status: 500 });
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.', requestId: req.id });
});

/* ---------- start ---------- */
if (process.env.NODE_ENV === 'production') {
  if (!process.env.PAYSTACK_SECRET_KEY && process.env.ALLOW_DEMO_PAYMENTS !== '1') console.warn('WARNING: PAYSTACK_SECRET_KEY is not set, so online payment is switched off. Customers can only pay on delivery until you add it.');
  if (!process.env.HANDOVER_SECRET) console.warn('WARNING: HANDOVER_SECRET is not set. A random one is kept in the database. Set your own long random value.');
}
const PORT = Number(process.env.PORT) || 3000;
let server;
(async () => {
  await migrate();      // creates or updates the tables (safe to run on every start, and by two instances at once)
  await seed();
  await bootstrapAdmin();
  cache.watch(); // notice edits made on other instances
  server = app.listen(PORT, process.env.HOST || '0.0.0.0', async () => {
    console.log(`\nShop-Beta is running at ${BASE_URL}`);
    const hasAdmin = await get("SELECT 1 x FROM users WHERE role='admin'").catch(() => null);
    console.log(`Admin dashboard:   ${BASE_URL}/admin${hasAdmin ? '' : '   (open it now to create your admin account)'}`);
    console.log(S.paystackLive() ? 'Paystack: LIVE keys are set.' : 'Paystack: no PAYSTACK_SECRET_KEY set, so online payment runs in demo mode (no real money).');
    if (!process.env.RESEND_API_KEY) console.log('Email: RESEND_API_KEY not set, so emails are stored in Admin > Marketing > Email outbox instead of being sent.');
    if (process.env.WORKER_ENABLED !== '0') worker.start(); // set WORKER_ENABLED=0 on web instances when you run `npm run worker` separately
  });
})().catch((err) => { log.error('startup failed', { err }); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { Promise.resolve(worker.stop()).finally(() => { if (server) server.close(() => process.exit(0)); else process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); });
require('./lib/errors').installProcessHandlers(() => { if (server) server.close(); });
