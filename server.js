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
const SEO = require('./lib/seo');
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
const INSTANCE = process.env.INSTANCE_ID || process.env.RENDER_INSTANCE_ID || require('os').hostname();
app.use((req, res, next) => { res.setHeader('X-Instance', INSTANCE); next(); }); // lets tests and load balancers see which instance answered
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

// Static brand artwork (home banner).
app.use('/brand', express.static(path.join(__dirname, 'views', 'brand'), { maxAge: '7d', index: false, dotfiles: 'ignore', setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));

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
app.use('/api', (req, res, next) => (req.path === '/admin/upload' || req.path === '/partner/upload' || req.path === '/rider/photo' || req.path === '/admin/rider-ops/upload' || req.path === '/partner/photos' || /^\/orders\/[A-Za-z0-9-]+\/return\/\d+\/photos$/.test(req.path) || (req.method === 'POST' && /^\/(admin|partner)\/catalog\/(parse|validate|commit)$/.test(req.path)) || /^\/(wholesale|admin)\/rfq\/(parse|[A-Z0-9-]+\/files)$/.test(req.path) || (req.method === 'POST' && req.path === '/pharmacy/prescriptions') || /^\/admin\/pharmacy\/pharmacies\/\d+\/agreement$/.test(req.path) || /^\/admin\/dropship\/(suppliers\/\d+\/documents|trade\/shipments\/\d+\/files|import\/(preview|commit))$/.test(req.path) ? next() : smallJson(req, res, next)));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
    let ok = false; try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { /* bad origin */ }
    if (!ok) return res.status(403).json({ error: 'Request blocked.' });
  }
  next();
});
app.use('/api', A.loadUser);
app.use('/api/notifications', require('./routes/notifications'));
app.use(['/api/wallet', '/api/mobile/v1/wallet'], require('./routes/wallet').customer);
app.use(['/api/admin/wallet', '/api/mobile/v1/admin/wallet'], require('./routes/wallet').admin);
app.use(['/api/admin/finance', '/api/mobile/v1/admin/finance'], require('./routes/wallet').reports);
app.use(['/api/loyalty', '/api/mobile/v1/loyalty'], require('./routes/loyalty').customer);
app.use('/api/mobile/v1/auth', require('./routes/mobile').auth);
app.use(['/api/account/summary', '/api/mobile/v1/account'], require('./routes/mobile').account);
app.use('/api/cards/webhook', require('./routes/cards').webhook);
app.use(['/api/cards', '/api/mobile/v1/cards'], require('./routes/cards').customer);
app.use(['/api/admin/cards', '/api/mobile/v1/admin/cards'], require('./routes/cards').admin);
app.use(['/api/admin/loyalty', '/api/mobile/v1/admin/loyalty'], require('./routes/loyalty').admin);
app.use('/api/admin/pharmacy', require('./routes/pharmacy-admin'));
app.use('/api/admin/rider-ops', require('./routes/rider-admin'));
app.use('/api/admin/ops-ai', require('./routes/ops-ai'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/pharmacy', require('./routes/pharmacy'));
app.use('/api/rider', require('./routes/rider'));
app.use('/api/partner', require('./routes/partner'));
app.use('/api/supplier', require('./routes/supplier-portal'));
app.use('/api/wholesale', require('./routes/wholesale'));
app.use('/api/trade-enquiries', require('./routes/trade-enquiries').pub);
app.use('/api', require('./routes/public'));
app.use('/api/mobile/v1', require('./routes/public')); // the same shop endpoints under the apps' versioned prefix
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

/* ---------- robots & sitemap ---------- */
// robots.txt, sitemaps, the Merchant Center feed and Search Console file verification live in lib/seo.js.
app.get('/robots.txt', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('text/plain').send(SEO.robotsTxt()));
app.get('/sitemap.xml', ah(SEO.sitemapHandler));
app.get(/^\/sitemap-(\d+)\.xml$/, ah(SEO.sitemapPartHandler));          // only exists once the catalogue is too big for one sitemap (then /sitemap.xml is an index)
app.get('/feed/google-merchant.xml', ah(SEO.feedHandler));
app.get(/^\/(google[a-z0-9]+\.html)$/, SEO.verificationFile);           // Search Console HTML-file check; answers only for the file named in GOOGLE_VERIFICATION_FILE

/* ---------- pages (one HTML shell, filled in per URL for search engines and link previews) ---------- */
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'views', 'index.html'), 'utf8');
const PAGES = { about: 'About us', faq: 'Frequently asked questions', shipping: 'Shipping & Returns', privacy: 'Privacy policy', terms: 'Terms of service', contact: 'Contact us' };
const NOINDEX = new Set(['rider', 'pharmacist', 'partner', 'supplier', 'wholesale', 'checkout', 'order', 'account', 'login', 'register', 'forgot', 'wishlist', 'track', 'admin']);
const absUrl = (u) => (!u ? '' : /^https?:\/\//.test(u) ? u : BASE_URL + u);

function pixelSnippet(id, nonce) {
  return `<script nonce="${nonce}">!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');</script>`;
}

async function describe(req) {
  const S0 = await getSettings(), p = req.path.replace(/\/+$/, '') || '/', seg = p.split('/').filter(Boolean);
  const out = { status: 200, path: p, store: '', title: S0.store_name, desc: S0.tagline, canonical: BASE_URL + p, image: '', type: 'website', jsonld: null, noindex: false, robots: '', body: '', S: S0 };
  const stores = await all(`SELECT slug, name, tab_label, hero_sub FROM stores s WHERE active=1 AND ${PC.storeVisibleSql('s')} ORDER BY sort`);
  const nav = `<nav aria-label="Departments">${stores.map((s) => `<a href="/d/${esc(s.slug)}">${esc(s.name)}</a>`).join(' ')}</nav>`;
  const productLinks = (rows) => `<ul>${rows.map((r) => `<li><a href="/product/${esc(r.slug)}">${esc(r.name)}</a> ${naira(r.price)}</li>`).join('')}</ul>`;
  const hide = (why) => { out.noindex = true; out.robots = why || 'noindex,nofollow'; };
  out.body = `<h1>${esc(S0.store_name)}</h1><p>${esc(S0.tagline)}</p>${nav}<p>Please enable JavaScript to shop.</p>`;

  // Private and internal pages: always a noindex tag. robots.txt does not block them, so Google can read it.
  if (NOINDEX.has(seg[0])) { hide(); out.title = seg[0] === 'admin' ? 'Admin · ' + S0.store_name : S0.store_name; if (seg[0] === 'admin') out.store = ''; return out; }
  if (seg[0] === 'd' && seg[1]) {
    const s = await get(`SELECT * FROM stores s WHERE slug=? AND active=1 AND ${PC.storeVisibleSql('s')}`, seg[1]);
    if (!s) { out.status = 404; hide(); return out; }
    out.store = s.slug; out.title = `${s.name} · ${S0.store_name}`; out.desc = SEO.clip(s.hero_sub || s.tagline, 160) || `Shop ${s.name} at ${S0.store_name}.`;
    out.canonical = `${BASE_URL}/d/${s.slug}`;
    const cats = await all('SELECT slug, name FROM categories WHERE store=? ORDER BY sort, id LIMIT 40', s.slug);
    out.body = `<h1>${esc(s.name)}</h1><p>${esc(s.hero_sub)}</p>${nav}${cats.length ? `<h2>Categories</h2><ul>${cats.map((c) => `<li><a href="/shop?store=${esc(s.slug)}&amp;category=${esc(c.slug)}">${esc(c.name)}</a></li>`).join('')}</ul>` : ''}<h2>Products</h2>${productLinks(await all(`SELECT slug, name, price FROM products p WHERE store=? AND active=1 AND ${PC.visibleSql('p')} ORDER BY featured DESC, id DESC LIMIT 30`, s.slug))}<p><a href="/shop?store=${esc(s.slug)}">See all ${esc(s.name)} products</a></p>`;
    return out;
  }
  if (seg[0] === 'store' && seg[1]) {
    const v = await get("SELECT name, tagline, about, logo FROM vendors WHERE slug=? AND status='approved'", String(seg[1]).slice(0, 80));
    if (!v) { out.status = 404; hide(); return out; }
    out.title = `${v.name} · ${S0.store_name}`; out.desc = SEO.clip(v.about || v.tagline, 160) || `${v.name} is a partner store on ${S0.store_name}.`; out.canonical = `${BASE_URL}/store/${seg[1]}`; if (v.logo) out.image = absUrl(v.logo);
    out.body = `<h1>${esc(v.name)}</h1><p>${esc(v.about)}</p>${nav}`;
    return out;
  }
  if (seg[0] === 'stores' && seg.length === 1) {
    const vs = await all("SELECT slug, name, tagline FROM vendors WHERE status='approved' ORDER BY name LIMIT 200");
    out.title = `Partner stores · ${S0.store_name}`; out.desc = `Browse the approved partner stores that sell on ${S0.store_name}, each checked by our team before it opens.`; out.canonical = `${BASE_URL}/stores`;
    out.body = `<h1>Partner stores</h1><p>${esc(out.desc)}</p>${nav}<ul>${vs.map((v) => `<li><a href="/store/${esc(v.slug)}">${esc(v.name)}</a> ${esc(v.tagline)}</li>`).join('')}</ul>`;
    return out;
  }
  if (seg[0] === 'shop' && seg.length === 1) {
    const s = req.query.store ? await get(`SELECT * FROM stores s WHERE slug=? AND active=1 AND ${PC.storeVisibleSql('s')}`, String(req.query.store).slice(0, 40)) : null;
    const pageNo = Math.min(200, Math.max(1, parseInt(req.query.page, 10) || 1)), PER = 40;
    out.store = s ? s.slug : ''; out.title = (s ? s.name : 'Shop') + ' · ' + S0.store_name;
    out.desc = SEO.clip(s ? s.hero_sub : '', 160) || (s ? `Shop ${s.name} products at ${S0.store_name}.` : `Browse every department at ${S0.store_name}: fashion, groceries, beauty, electronics and more, delivered across Nigeria.`);
    out.canonical = BASE_URL + '/shop' + (s ? '?store=' + s.slug : '');   // filtered, sorted, searched and paged views all point back to this one address
    // A filtered or paged list is useful to follow (it leads to products) but is not a page to rank: noindex,follow. Unknown parameters such as utm_source only get the canonical.
    if (FILTERED(req.query)) hide('noindex,follow');
    const rows = await all(`SELECT slug, name, price FROM products p WHERE active=1 AND ${PC.visibleSql('p')} ${s ? 'AND store=?' : ''} ORDER BY id DESC LIMIT ${PER + 1} OFFSET ${(pageNo - 1) * PER}`, ...(s ? [s.slug] : []));
    const more = rows.length > PER, q = (n) => `/shop?${s ? 'store=' + esc(s.slug) + '&amp;' : ''}page=${n}`;
    out.body = `<h1>${esc(s ? s.name : 'Shop')}</h1>${nav}${productLinks(rows.slice(0, PER))}<p>${pageNo > 1 ? `<a rel="prev" href="${pageNo === 2 ? '/shop' + (s ? '?store=' + esc(s.slug) : '') : q(pageNo - 1)}">Previous page</a> ` : ''}${more ? `<a rel="next" href="${q(pageNo + 1)}">Next page</a>` : ''}</p>`;
    return out;
  }
  if (seg[0] === 'product' && seg[1] && seg.length === 2) {
    const pr = await get(`SELECT p.*, c.name category, (SELECT AVG(rating) FROM reviews r WHERE r.product_id=p.id AND r.approved=1) rating, (SELECT COUNT(*) FROM reviews r WHERE r.product_id=p.id AND r.approved=1) rn, s.name store_name FROM products p LEFT JOIN categories c ON c.id=p.category_id JOIN stores s ON s.slug=p.store AND s.active=1 WHERE p.active=1 AND p.slug=? AND ${PC.visibleSql('p')} AND ${PC.storeVisibleSql('s')}`, seg[1].slice(0, 120));
    if (!pr) { out.status = 404; hide(); return out; }
    const img = absUrl(parseImages(pr.images)[0]);
    out.store = pr.store; out.title = `${pr.name} · ${S0.store_name}`; out.canonical = `${BASE_URL}/product/${pr.slug}`; out.image = img; out.type = 'product';
    out.desc = SEO.clip(pr.description, 160) || `${pr.name}${pr.brand ? ' by ' + pr.brand : ''} for ${naira(pr.price)} at ${S0.store_name}.`;
    const reviews = pr.rn ? await all('SELECT name, rating, title, body, created FROM reviews WHERE product_id=? AND approved=1 ORDER BY id DESC LIMIT 5', pr.id) : [];
    out.jsonld = SEO.productJsonLd(pr, reviews, out.canonical);
    const related = await all(`SELECT slug, name, price FROM products p WHERE store=? AND active=1 AND id<>? AND ${PC.visibleSql('p')} ORDER BY featured DESC, id DESC LIMIT 8`, pr.store, pr.id);
    out.body = `<nav aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/d/${esc(pr.store)}">${esc(pr.store_name)}</a></nav><h1>${esc(pr.name)}</h1><p>${esc(pr.brand)} · ${naira(pr.price)}</p><p>${esc(pr.description)}</p>${related.length ? `<h2>More from ${esc(pr.store_name)}</h2>${productLinks(related)}` : ''}${nav}`;
    return out;
  }
  if (seg[0] === 'page' && seg[1] && seg.length === 2) {
    if (!PAGES[seg[1]]) { out.status = 404; hide(); return out; }
    out.title = `${PAGES[seg[1]]} · ${S0.store_name}`; out.canonical = `${BASE_URL}/page/${seg[1]}`; out.desc = SEO.PAGE_DESC(S0.store_name)[seg[1]];
    out.body = `<h1>${esc(PAGES[seg[1]])}</h1><p>${esc(out.desc)}</p>${nav}`; return out;
  }
  if (seg[0] === 'dropshipping' && seg.length === 1) {
    out.title = `Dropshipping: more products, shipped straight to you · ${S0.store_name}`; out.desc = 'Shop items shipped directly from our partner suppliers, with honest delivery times, tracking and a refund or alternative if a supplier cannot deliver.'; out.canonical = `${BASE_URL}/dropshipping`;
    out.body = `<h1>Dropshipping</h1><p>${esc(out.desc)}</p>${nav}`; return out;
  }
  if (seg[0] === 'import-export' && seg.length === 1) {
    out.title = `Import & Export: bring goods in, or buy Nigerian products abroad · ${S0.store_name}`; out.desc = 'Tell us what you want to import into Nigeria or buy from Nigeria for export. We reply with a clear price, route and timeline. Sending an enquiry is free and commits you to nothing.'; out.canonical = `${BASE_URL}/import-export`;
    out.body = `<h1>Import &amp; Export</h1><p>${esc(out.desc)}</p>${nav}`; return out;
  }
  if (p === '/') {
    const m = SEO.homeMeta(S0, stores);
    out.title = m.title; out.desc = m.desc; out.canonical = BASE_URL + '/'; out.jsonld = SEO.homeJsonLd(S0, stores);
    const feat = await all(`SELECT slug, name, price FROM products p WHERE active=1 AND ${PC.visibleSql('p')} AND store IN (${stores.length ? stores.map(() => '?').join(',') : "''"}) ORDER BY featured DESC, id DESC LIMIT 24`, ...stores.map((s) => s.slug));
    const mail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(S0.contact_email || '') && !/\.example$/i.test(S0.contact_email) ? S0.contact_email : '';
    out.body = `<h1>${esc(S0.store_name)}</h1><p>${esc(out.desc)}</p>`
      + `<h2>Shop by department</h2><ul>${stores.map((s) => `<li><a href="/d/${esc(s.slug)}">${esc(s.name)}</a>${s.hero_sub ? ' – ' + esc(s.hero_sub) : ''}</li>`).join('')}</ul>`
      + `<h2>More ways to shop</h2><ul><li><a href="/shop">All products</a></li><li><a href="/stores">Partner stores</a></li><li><a href="/dropshipping">Dropshipping</a></li><li><a href="/import-export">Import &amp; Export</a></li></ul>`
      + (feat.length ? `<h2>Featured products</h2>${productLinks(feat)}` : '')
      + `<h2>Delivery</h2><p>We deliver across Nigeria. Delivery cost and timing depend on your state. Read <a href="/page/shipping">Shipping &amp; Returns</a> before you order.</p>`
      + `<h2>Customer service</h2><p>Questions about an order? See the <a href="/page/faq">FAQ</a> or <a href="/page/contact">contact us</a>${mail ? ' at ' + esc(mail) : ''}. <a href="/page/about">About ${esc(S0.store_name)}</a>.</p>`;
    return out;
  }
  out.status = 404; hide(); out.title = 'Page not found · ' + S0.store_name;
  return out;
}

// The page head (title, description, structured data, plain-text body for search engines) is the same for everyone, so it is kept for 30 seconds.
// Only successful pages are kept, so a flood of made-up addresses cannot fill the cache with 404s. The per-request nonce below is never cached.
// Only the parameters that change the page are part of the key, so tracking parameters (utm_source...) cannot multiply cache entries.
const DESCRIBE_KEYS = ['store', ...SEO.FILTER_KEYS];
const FILTERED = (query) => SEO.FILTER_KEYS.some((k) => query[k] !== undefined && String(query[k]) !== '');
const describeCached = (req) => {
  const q = DESCRIBE_KEYS.map((k) => (req.query[k] === undefined ? '' : k + '=' + String(req.query[k]).slice(0, 60))).join('&');
  const key = 'page:' + req.path.slice(0, 200) + '?' + q;
  return cache.cached(key, 30000, () => describe(req), (d) => d.status === 200);
};

app.get(/^\/(?!api\/|uploads\/|health).*/, ah(async (req, res) => {
  const d = await describeCached(req);
  const nonce = crypto.randomBytes(16).toString('base64');
  if (!d.noindex && SEO.onTemporaryHost(req)) { d.noindex = true; d.robots = 'noindex,nofollow'; } // the temporary Render address must not compete with the real domain
  const tags = [SEO.headTags(d), d.S.meta_pixel_id && /^[A-Za-z0-9_-]+$/.test(d.S.meta_pixel_id) ? pixelSnippet(d.S.meta_pixel_id, nonce) : ''].join('\n');
  // Public pages carry their text links inside the page itself (the script replaces them when it starts); private pages keep theirs in <noscript> only.
  const html = TEMPLATE.replace(/<script>/g, `<script nonce="${nonce}">`)
    .replace('<!--HTMLATTR-->', d.store && /^[a-z0-9-]+$/.test(d.store) ? ` data-store="${d.store}"` : '')
    .replace('<!--SEO-->', () => tags).replace('<!--SEOBODY-->', () => (d.noindex ? '' : `<div class="seo-static">${d.body}</div>`)).replace('<!--PRERENDER-->', () => (d.noindex ? d.body : ''));
  res.status(d.status).set({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(d.noindex ? { 'X-Robots-Tag': d.robots || 'noindex,nofollow' } : {}),
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
  await require('./lib/staff').seedRoles();
  await bootstrapAdmin();
  cache.watch(); // notice edits made on other instances
  server = app.listen(PORT, process.env.HOST || '0.0.0.0', async () => {
    console.log(`\nVELTO-MART is running at ${BASE_URL}`);
    const hasAdmin = await get("SELECT 1 x FROM users WHERE role='admin'").catch(() => null);
    console.log(`Admin dashboard:   ${BASE_URL}/admin${hasAdmin ? '' : '   (open it now to create your admin account)'}`);
    console.log(S.paystackLive() ? 'Paystack: LIVE keys are set.' : 'Paystack: no PAYSTACK_SECRET_KEY set, so online payment runs in demo mode (no real money).');
    console.log(require('./lib/storage').DRIVER === 'supabase' ? 'Photos: saved in Supabase Storage (permanent).' : 'Photos: saved on THIS server\'s disk. They are lost when the server restarts. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    if (!process.env.RESEND_API_KEY) console.log('Email: RESEND_API_KEY not set, so emails are stored in Admin > Marketing > Email outbox instead of being sent.');
    if (process.env.WORKER_ENABLED !== '0') worker.start(); // set WORKER_ENABLED=0 on web instances when you run `npm run worker` separately
  });
})().catch((err) => { log.error('startup failed', { err }); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { Promise.resolve(worker.stop()).finally(() => { if (server) server.close(() => process.exit(0)); else process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); });
require('./lib/errors').installProcessHandlers(() => { if (server) server.close(); });
