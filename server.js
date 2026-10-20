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
const { get, all, run, now, DATA_DIR } = require('./lib/db');
const { seed } = require('./lib/seed');
seed();
const S = require('./lib/shop');
const A = require('./lib/auth');
const jobs = require('./lib/jobs');

const { esc, BASE_URL, getSettings, parseImages, naira } = S;
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '0' ? false : 1);

/* ---------- first admin from environment variables (optional) ---------- */
(async () => {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
  if (email && pw.length >= 8 && !get("SELECT 1 x FROM users WHERE role='admin'") && !get('SELECT 1 x FROM users WHERE email=?', email)) {
    run("INSERT INTO users (name,email,phone,password,role,created) VALUES ('Store owner',?,'',?, 'admin', ?)", email, await A.hashPassword(pw), now());
    console.log('Admin account created for', email);
  }
})();

/* ---------- security headers ---------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

/* ---------- uploads ---------- */
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), {
  maxAge: '30d', immutable: true, index: false, dotfiles: 'ignore',
  setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'"); },
}));

/* ---------- API ---------- */
app.use('/api/admin/upload', express.json({ limit: '4mb' }));
app.use('/api', express.json({ limit: '200kb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
    let ok = false; try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { /* bad origin */ }
    if (!ok) return res.status(403).json({ error: 'Request blocked.' });
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
app.get('/sitemap.xml', (req, res) => {
  const urls = [BASE_URL + '/'];
  for (const s of all('SELECT slug FROM stores WHERE active=1 ORDER BY sort')) urls.push(`${BASE_URL}/d/${s.slug}`);
  for (const p of ['about', 'faq', 'shipping', 'contact', 'privacy', 'terms']) urls.push(`${BASE_URL}/page/${p}`);
  for (const p of all('SELECT p.slug FROM products p JOIN stores s ON s.slug=p.store WHERE p.active=1 AND s.active=1 ORDER BY p.id DESC LIMIT 5000')) urls.push(`${BASE_URL}/product/${p.slug}`);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`);
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

function describe(req) {
  const S0 = getSettings(), p = req.path.replace(/\/+$/, '') || '/', seg = p.split('/').filter(Boolean);
  const out = { status: 200, store: '', title: S0.store_name, desc: S0.tagline, canonical: BASE_URL + p, image: '', type: 'website', jsonld: null, noindex: false, body: '', S: S0 };
  const stores = all('SELECT slug, name, tab_label FROM stores WHERE active=1 ORDER BY sort');
  const nav = `<nav>${stores.map((s) => `<a href="/d/${esc(s.slug)}">${esc(s.name)}</a>`).join(' ')}</nav>`;
  const productLinks = (rows) => `<ul>${rows.map((r) => `<li><a href="/product/${esc(r.slug)}">${esc(r.name)}</a> ${naira(r.price)}</li>`).join('')}</ul>`;
  out.body = `<h1>${esc(S0.store_name)}</h1><p>${esc(S0.tagline)}</p>${nav}<p>Please enable JavaScript to shop.</p>`;

  if (NOINDEX.has(seg[0])) { out.noindex = true; out.title = seg[0] === 'admin' ? 'Admin · ' + S0.store_name : S0.store_name; if (seg[0] === 'admin') out.store = ''; return out; }
  if (seg[0] === 'd' && seg[1]) {
    const s = get('SELECT * FROM stores WHERE slug=? AND active=1', seg[1]);
    if (!s) { out.status = 404; out.noindex = true; return out; }
    out.store = s.slug; out.title = `${s.name} · ${S0.store_name}`; out.desc = clip(s.hero_sub || s.tagline, 160);
    out.canonical = `${BASE_URL}/d/${s.slug}`;
    out.body = `<h1>${esc(s.name)}</h1><p>${esc(s.hero_sub)}</p>${nav}${productLinks(all('SELECT slug, name, price FROM products WHERE store=? AND active=1 ORDER BY featured DESC, id DESC LIMIT 30', s.slug))}`;
    return out;
  }
  if (seg[0] === 'shop') {
    const s = req.query.store ? get('SELECT * FROM stores WHERE slug=? AND active=1', String(req.query.store).slice(0, 40)) : null;
    out.store = s ? s.slug : ''; out.title = (s ? s.name : 'Shop') + ' · ' + S0.store_name; out.desc = clip(s ? s.hero_sub : S0.tagline, 160);
    out.canonical = BASE_URL + '/shop' + (s ? '?store=' + s.slug : '');
    out.noindex = !!(req.query.q || req.query.page || req.query.sort || req.query.min || req.query.max || req.query.size || req.query.color || req.query.rating || req.query.instock || req.query.flag);
    out.body = `<h1>${esc(s ? s.name : 'Shop')}</h1>${nav}${productLinks(all(`SELECT slug, name, price FROM products WHERE active=1 ${s ? 'AND store=?' : ''} ORDER BY id DESC LIMIT 40`, ...(s ? [s.slug] : [])))}`;
    return out;
  }
  if (seg[0] === 'product' && seg[1]) {
    const pr = get('SELECT p.*, c.name category, (SELECT AVG(rating) FROM reviews r WHERE r.product_id=p.id AND r.approved=1) rating, (SELECT COUNT(*) FROM reviews r WHERE r.product_id=p.id AND r.approved=1) rn FROM products p LEFT JOIN categories c ON c.id=p.category_id JOIN stores s ON s.slug=p.store AND s.active=1 WHERE p.active=1 AND p.slug=?', seg[1].slice(0, 120));
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

app.get(/^\/(?!api\/|uploads\/).*/, (req, res) => {
  const d = describe(req);
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
  console.error(`${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

/* ---------- start ---------- */
const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`\nShop-Beta is running at ${BASE_URL}`);
  console.log(`Admin dashboard:   ${BASE_URL}/admin${get("SELECT 1 x FROM users WHERE role='admin'") ? '' : '   (open it now to create your admin account)'}`);
  console.log(S.paystackLive() ? 'Paystack: LIVE keys are set.' : 'Paystack: no PAYSTACK_SECRET_KEY set, so online payment runs in demo mode (no real money).');
  if (!process.env.RESEND_API_KEY) console.log('Email: RESEND_API_KEY not set, so emails are stored in Admin > Marketing > Email outbox instead of being sent.');
  jobs.start();
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
