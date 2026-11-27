'use strict';
// Search-engine support: robots.txt, sitemaps, page metadata, structured data, the Google Merchant Center feed and the admin SEO audit.
// Everything here only READS the catalogue. Nothing in this file writes to the database or touches checkout, payments, wallets or orders.
// "Public" always means the same thing as everywhere else in the shop: the product / department is active and passes the pharmacy,
// partner-approval and dropship-approval rules in lib/pharmacy-core.js. Private pages (admin, account, checkout, wholesale, supplier...) are never listed.
const { get, all } = require('./db');
const cache = require('./cache');
const S = require('./shop');
const PC = require('./pharmacy-core');
const { esc, BASE_URL, parseImages, naira } = S;

const SITEMAP_MAX = 50000;                      // Google's limit per sitemap file (also 50 MB uncompressed; 50,000 short URLs is a few MB)
const INFO_PAGES = ['about', 'faq', 'shipping', 'contact', 'privacy', 'terms'];
const PRODUCTION_ORIGIN = (process.env.PRODUCTION_ORIGIN || 'https://velto-mart.com.ng').replace(/\/+$/, '');
const FILTER_KEYS = ['q', 'category', 'subcategory', 'brand', 'page', 'sort', 'min', 'max', 'size', 'color', 'rating', 'instock', 'flag', 'vendor', 'view', 'tag'];

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const absUrl = (u) => (!u ? '' : /^https?:\/\//i.test(u) ? u : BASE_URL + (u.startsWith('/') ? '' : '/') + u);
const httpsUrl = (u) => { try { const x = new URL(String(u || '').trim()); return x.protocol === 'https:' ? x.href : ''; } catch { return ''; } };
// A product is public when the whole shop would show it. Same conditions the storefront and the old sitemap used.
const publicProductSql = () => `p.active=1 AND s.active=1 AND ${PC.visibleSql('p')} AND ${PC.storeVisibleSql('s')}`;

/* ---------- domain checks ---------- */
// Problems with BASE_URL that would put the wrong address into canonical links and sitemaps. Shown in the admin SEO page and in the start-up log.
function baseUrlIssues(base = BASE_URL) {
  const out = []; let u;
  try { u = new URL(base); } catch { return ['BASE_URL is not a valid web address.']; }
  if (u.protocol !== 'https:') out.push('BASE_URL does not start with https://. Canonical links and sitemap addresses should be https.');
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname)) out.push('BASE_URL points to a local address. Google would be told to index localhost.');
  if (/\.onrender\.com$/i.test(u.hostname)) out.push('BASE_URL is Render\'s temporary hostname. Set it to your own domain.');
  if (u.pathname !== '/' || u.search || u.hash) out.push('BASE_URL should be only the domain, with no path.');
  if (process.env.NODE_ENV === 'production' && u.origin !== PRODUCTION_ORIGIN) out.push(`BASE_URL is ${u.origin} but the production domain is ${PRODUCTION_ORIGIN}. Set BASE_URL=${PRODUCTION_ORIGIN} on Render.`);
  return out;
}
// The temporary Render address must never compete with the real domain in Google: when BASE_URL is a different host, pages served on *.onrender.com are noindex.
const onTemporaryHost = (req) => { try { return /\.onrender\.com$/i.test(req.hostname || '') && !/\.onrender\.com$/i.test(new URL(BASE_URL).hostname); } catch { return false; } };

/* ---------- robots.txt ---------- */
// Crawling is allowed everywhere except the JSON API. Private HTML pages (admin, account, checkout, wholesale, supplier, partner...) are deliberately NOT disallowed:
// they carry a noindex tag and header, and Google can only obey a noindex it is allowed to fetch. robots.txt is not security: those pages still need a sign-in.
const robotsTxt = () => `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${BASE_URL}/sitemap.xml\n`;

/* ---------- sitemap ---------- */
const urlsetXml = (entries) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map((e) => `<url><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${esc(e.lastmod)}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`;
const indexXml = (locs) => `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs.map((l) => `<sitemap><loc>${esc(l)}</loc></sitemap>`).join('\n')}\n</sitemapindex>\n`;

// Every public, indexable address, once each. lastmod is left out on purpose: the catalogue stores when a row was created, not when it last changed, and a wrong lastmod is worse than none.
async function sitemapEntries() {
  return cache.cached('seo:sitemap', 60000, async () => {
    const seen = new Set(), out = [];
    const add = (path) => { const loc = BASE_URL + path; if (!seen.has(loc)) { seen.add(loc); out.push({ loc }); } };
    add('/'); add('/shop');
    for (const s of await all(`SELECT slug FROM stores s WHERE active=1 AND ${PC.storeVisibleSql('s')} ORDER BY sort`)) add(`/d/${encodeURIComponent(s.slug)}`);
    add('/stores'); add('/dropshipping'); add('/import-export');
    for (const p of INFO_PAGES) add(`/page/${p}`);
    for (const v of await all("SELECT slug FROM vendors WHERE status='approved' ORDER BY name")) add(`/store/${encodeURIComponent(v.slug)}`);
    for (const p of await all(`SELECT p.slug FROM products p JOIN stores s ON s.slug=p.store WHERE ${publicProductSql()} ORDER BY p.id`)) add(`/product/${encodeURIComponent(p.slug)}`);
    return out;
  });
}
async function sitemapHandler(req, res) {
  const entries = await sitemapEntries();
  res.set('Cache-Control', 'public, max-age=600').type('application/xml');
  if (entries.length <= SITEMAP_MAX) return res.send(urlsetXml(entries));
  const parts = Math.ceil(entries.length / SITEMAP_MAX); // the catalogue outgrew one file: /sitemap.xml becomes an index of /sitemap-1.xml ...
  res.send(indexXml(Array.from({ length: parts }, (_, i) => `${BASE_URL}/sitemap-${i + 1}.xml`)));
}
async function sitemapPartHandler(req, res) {
  const entries = await sitemapEntries(), n = Number(req.params[0]);
  if (entries.length <= SITEMAP_MAX || !(n >= 1) || (n - 1) * SITEMAP_MAX >= entries.length) return res.status(404).type('text/plain').send('Not found');
  res.set('Cache-Control', 'public, max-age=600').type('application/xml').send(urlsetXml(entries.slice((n - 1) * SITEMAP_MAX, n * SITEMAP_MAX)));
}

/* ---------- identifiers ---------- */
// A barcode is only passed on as a GTIN when it really is one (8, 12, 13 or 14 digits with a correct check digit). Internal codes are never published as GTINs.
function validGtin(raw) {
  const s = String(raw || '').replace(/[\s-]/g, '');
  if (!/^(\d{8}|\d{12,14})$/.test(s)) return '';
  const d = s.split('').map(Number), check = d.pop();
  const sum = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check ? s : '';
}

/* ---------- metadata ---------- */
const DEPT_WORDS = { fashion: 'fashion', supermarket: 'groceries', beauty: 'beauty', electronics: 'electronics', pharmacy: 'health products', food: 'kitchen and food items' };
const list = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
// Words describing what the shop sells right now: built from the departments customers can see, so a switched-off pharmacy is never advertised.
const offering = (stores) => list(stores.map((s) => DEPT_WORDS[s.slug] || String(s.tab_label || s.name).toLowerCase()));
const PAGE_DESC = (n) => ({
  about: `Learn about ${n}, an online store in Nigeria bringing fashion, groceries, beauty, electronics and kitchen essentials together with delivery across the country.`,
  faq: `Answers to common questions about ordering, payment, delivery, returns and your account at ${n}.`,
  shipping: `How delivery works across Nigeria, what to expect, and how to return an item bought at ${n}.`,
  contact: `How to reach ${n} customer service about an order, a delivery or a payment.`,
  privacy: `How ${n} collects, uses and protects your personal information.`,
  terms: `The terms that apply when you shop at or sell through ${n}.`,
});
function homeMeta(S0, stores) {
  const n = S0.store_name || 'VELTO-MART', what = offering(stores);
  return {
    title: S0.seo_home_title || `${n} | Online Shopping in Nigeria – Shop Fashion, Electronics, Groceries & More`,
    desc: S0.seo_home_description || `Shop ${what || 'everyday essentials'} and everyday essentials at ${n}. Discover great products and convenient delivery across Nigeria.`,
    what,
  };
}

/* ---------- structured data ---------- */
const altName = (n) => String(n).replace(/[-_]+/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
// WebSite + Organization for the homepage. Only facts that exist in the shop settings are used: no invented profiles, addresses, phone numbers or credentials.
function homeJsonLd(S0, stores) {
  const n = S0.store_name || 'VELTO-MART', url = BASE_URL + '/', what = homeMeta(S0, stores).what;
  const sameAs = ['instagram', 'facebook', 'x_twitter', 'tiktok'].map((k) => httpsUrl(S0[k])).filter(Boolean);
  const logo = httpsUrl(absUrl(S0.logo_url));
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(S0.contact_email || '') && !/\.example$/i.test(S0.contact_email) ? S0.contact_email : '';
  const phone = String(S0.contact_phone || '').trim();
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': url + '#website', name: n, alternateName: altName(n), url, inLanguage: 'en-NG', publisher: { '@id': url + '#organization' } },
      { '@type': 'Organization', '@id': url + '#organization', name: n, url,
        description: `${n} is an online store in Nigeria${what ? ` selling ${what}` : ''}, with delivery across Nigeria, wholesale buying and partner stores.`,
        ...(logo ? { logo } : {}), ...(sameAs.length ? { sameAs } : {}),
        ...(email || phone ? { contactPoint: { '@type': 'ContactPoint', contactType: 'customer service', areaServed: 'NG', availableLanguage: 'English', ...(email ? { email } : {}), ...(phone ? { telephone: phone } : {}) } } : {}) },
    ],
  };
}
// Product structured data from real catalogue values only. Reviews and the rating come from approved reviews; nothing is made up.
function productJsonLd(pr, reviews, canonical) {
  const imgs = parseImages(pr.images).map(absUrl).filter(Boolean).slice(0, 6), gtin = validGtin(pr.barcode);
  const rn = Number(pr.rn) || 0;
  return {
    '@context': 'https://schema.org', '@type': 'Product', name: pr.name, url: canonical,
    ...(clip(pr.description, 500) ? { description: clip(pr.description, 500) } : {}),
    ...(pr.sku ? { sku: pr.sku } : {}), ...(gtin ? { gtin } : {}),
    ...(pr.brand ? { brand: { '@type': 'Brand', name: pr.brand } } : {}),
    ...(pr.category ? { category: pr.category } : {}),
    ...(imgs.length ? { image: imgs } : {}),
    offers: { '@type': 'Offer', priceCurrency: 'NGN', price: Number(pr.price).toFixed(2), availability: pr.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url: canonical },
    ...(rn ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: Math.round(pr.rating * 10) / 10, reviewCount: rn, bestRating: 5, worstRating: 1 } } : {}),
    ...(rn && reviews.length ? { review: reviews.map((r) => ({ '@type': 'Review', author: { '@type': 'Person', name: r.name || 'Customer' }, reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5, worstRating: 1 },
      ...(r.title ? { name: r.title } : {}), ...(r.body ? { reviewBody: clip(r.body, 500) } : {}), datePublished: new Date(Number(r.created) * 1000).toISOString().slice(0, 10) })) } : {}),
  };
}

/* ---------- <head> tags ---------- */
const GSC_TOKEN = () => { const t = process.env.GOOGLE_SITE_VERIFICATION || ''; return /^[A-Za-z0-9_-]{20,120}$/.test(t) ? t : ''; };
// Search Console HTML-file verification: set GOOGLE_VERIFICATION_FILE to the file name Google gives you (google<code>.html). Nothing is hard-coded.
const GSC_FILE = () => { const f = process.env.GOOGLE_VERIFICATION_FILE || ''; return /^google[a-z0-9]{6,60}\.html$/.test(f) ? f : ''; };
function verificationFile(req, res, next) {
  const f = GSC_FILE();
  if (!f || req.params[0] !== f) return next();
  res.type('text/html').send(`google-site-verification: ${f}`);
}
function headTags(d) {
  const robots = d.robots || (d.noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large');
  const image = d.image || (d.noindex ? '' : httpsUrl(absUrl(d.S.logo_url)) || BASE_URL + '/brand/velto-banner.jpg');
  const ld = d.jsonld ? `<script type="application/ld+json" id="ldp" data-path="${esc(d.path || '')}">${JSON.stringify(d.jsonld).replace(/</g, '\\u003c')}</script>` : '';
  const gsc = d.path === '/' && GSC_TOKEN() ? `<meta name="google-site-verification" content="${GSC_TOKEN()}">` : '';
  return [
    `<title>${esc(d.title)}</title>`, `<meta name="description" content="${esc(d.desc)}">`, `<link rel="canonical" href="${esc(d.canonical)}">`,
    `<meta name="robots" content="${esc(robots)}">`, gsc,
    `<meta property="og:site_name" content="${esc(d.S.store_name)}"><meta property="og:locale" content="en_NG"><meta property="og:title" content="${esc(d.title)}"><meta property="og:description" content="${esc(d.desc)}"><meta property="og:type" content="${d.type}"><meta property="og:url" content="${esc(d.canonical)}">`,
    image ? `<meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(image)}">` : '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${esc(d.title)}"><meta name="twitter:description" content="${esc(d.desc)}">`,
    ld,
  ].filter(Boolean).join('\n');
}

/* ---------- Google Merchant Center feed ---------- */
// RSS 2.0 with Google's g: namespace, built only from real product fields. Items Merchant Center would reject (no price, picture or description) are left out
// rather than filled with made-up values. Out-of-stock products stay in, marked "out of stock". Keep this separate from checkout: it is read-only.
const xmlText = (s) => esc(String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''));
async function feedItems() {
  const rows = await all(`SELECT p.id, p.slug, p.name, p.brand, p.description, p.price, p.compare_price, p.stock, p.sku, p.barcode, p.images, c.name category
    FROM products p JOIN stores s ON s.slug=p.store LEFT JOIN categories c ON c.id=p.category_id WHERE ${publicProductSql()} ORDER BY p.id LIMIT 50000`);
  const items = [], skipped = { price: 0, image: 0, description: 0 };
  for (const p of rows) {
    const imgs = parseImages(p.images).map(absUrl).filter(Boolean), desc = String(p.description || '').replace(/\s+/g, ' ').trim();
    if (!(p.price > 0)) { skipped.price++; continue; }
    if (!imgs.length) { skipped.image++; continue; }
    if (!desc) { skipped.description++; continue; }
    items.push({ ...p, imgs, desc, gtin: validGtin(p.barcode) });
  }
  return { items, skipped, total: rows.length };
}
async function feedXml() {
  const { items } = await feedItems(), n = esc((await S.getSettings()).store_name || 'VELTO-MART');
  const one = (p) => {
    const onSale = p.compare_price > p.price, link = `${BASE_URL}/product/${encodeURIComponent(p.slug)}`;
    return `<item><g:id>${p.id}</g:id><title>${xmlText(clip(p.name, 150))}</title><description>${xmlText(clip(p.desc, 5000))}</description><link>${esc(link)}</link>`
      + `<g:image_link>${esc(p.imgs[0])}</g:image_link>${p.imgs.slice(1, 11).map((u) => `<g:additional_image_link>${esc(u)}</g:additional_image_link>`).join('')}`
      + `<g:availability>${p.stock > 0 ? 'in stock' : 'out of stock'}</g:availability><g:price>${onSale ? p.compare_price : p.price}.00 NGN</g:price>${onSale ? `<g:sale_price>${p.price}.00 NGN</g:sale_price>` : ''}`
      + `${p.brand ? `<g:brand>${xmlText(p.brand)}</g:brand>` : ''}<g:condition>new</g:condition>${p.gtin ? `<g:gtin>${p.gtin}</g:gtin>` : '<g:identifier_exists>no</g:identifier_exists>'}`
      + `${p.category ? `<g:product_type>${xmlText(p.category)}</g:product_type>` : ''}</item>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${n}</title><link>${esc(BASE_URL)}/</link><description>${n} product feed</description>\n${items.map(one).join('\n')}\n</channel></rss>\n`;
}
async function feedHandler(req, res) {
  const xml = await cache.cached('seo:feed', 300000, feedXml);
  res.set({ 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex' }).type('application/xml').send(xml); // a data file for Merchant Center, not a page to rank
}

/* ---------- admin audit ---------- */
// What the code can see about its own SEO setup. It does NOT know whether Google has indexed anything: that is only visible in Search Console.
async function audit() {
  const rows = await all(`SELECT p.id, p.slug, p.name, p.brand, p.description, p.price, p.sku, p.barcode, p.images FROM products p JOIN stores s ON s.slug=p.store WHERE ${publicProductSql()} ORDER BY p.id`);
  const pick = (f) => { const m = rows.filter(f); return { count: m.length, sample: m.slice(0, 25).map((p) => ({ id: p.id, name: p.name, slug: p.slug })) }; };
  const seen = new Map(); for (const p of rows) { const k = String(p.slug || '').toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); }
  const stores = await all(`SELECT slug, name, tagline, hero_sub FROM stores s WHERE active=1 AND ${PC.storeVisibleSql('s')} ORDER BY sort`);
  const vendors = await all("SELECT slug, name, tagline, about FROM vendors WHERE status='approved'");
  const settings = await S.getSettings(), feed = await feedItems();
  const badSlug = pick((p) => !p.slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug) || seen.get(String(p.slug).toLowerCase()) > 1);
  const noDesc = pick((p) => !String(p.description || '').trim());
  return {
    domain: { base_url: BASE_URL, production_origin: PRODUCTION_ORIGIN, matches_production: BASE_URL === PRODUCTION_ORIGIN, issues: baseUrlIssues() },
    urls: { sitemap: BASE_URL + '/sitemap.xml', robots: BASE_URL + '/robots.txt', merchant_feed: BASE_URL + '/feed/google-merchant.xml' },
    counts: { public_products: rows.length, public_departments: stores.length, partner_stores: vendors.length, sitemap_urls: (await sitemapEntries()).length },
    products: {
      missing_description: noDesc, short_description: pick((p) => { const l = String(p.description || '').trim().length; return l > 0 && l < 40; }),
      missing_images: pick((p) => !parseImages(p.images).length), missing_brand: pick((p) => !String(p.brand || '').trim()),
      missing_identifiers: pick((p) => !String(p.sku || '').trim() && !validGtin(p.barcode)), no_valid_gtin: { count: rows.filter((p) => !validGtin(p.barcode)).length },
      bad_or_duplicate_slugs: badSlug, zero_price: pick((p) => !(p.price > 0)),
    },
    metadata: {
      departments_missing_description: stores.filter((s) => !String(s.hero_sub || s.tagline || '').trim()).map((s) => s.slug),
      partner_stores_missing_description: vendors.filter((v) => !String(v.about || v.tagline || '').trim()).map((v) => v.slug),
      products_without_own_description: noDesc.count, // their meta description falls back to the product name
      logo_configured: !!httpsUrl(absUrl(settings.logo_url)), social_profiles_configured: ['instagram', 'facebook', 'x_twitter', 'tiktok'].filter((k) => httpsUrl(settings[k])),
    },
    canonical_warnings: [...baseUrlIssues(), ...(badSlug.count ? [`${badSlug.count} product address(es) contain characters other than lowercase letters, numbers and hyphens, or repeat another address.`] : [])],
    merchant_feed: { included: feed.items.length, excluded: feed.total - feed.items.length, excluded_reasons: feed.skipped },
    search_console: { meta_tag_configured: !!GSC_TOKEN(), html_file_configured: !!GSC_FILE(), note: 'Whether Google has indexed these pages is shown only in Google Search Console (Pages report). This page cannot know it.' },
  };
}

module.exports = { SITEMAP_MAX, FILTER_KEYS, INFO_PAGES, PAGE_DESC, clip, absUrl, httpsUrl, validGtin, baseUrlIssues, onTemporaryHost, robotsTxt, sitemapEntries, sitemapHandler, sitemapPartHandler,
  homeMeta, homeJsonLd, productJsonLd, headTags, verificationFile, feedItems, feedXml, feedHandler, audit, publicProductSql, urlsetXml, indexXml, naira };
