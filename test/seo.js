'use strict';
// Search-engine support end to end: robots.txt, sitemap, page metadata, structured data, noindex rules, the Merchant Center feed, the admin SEO page,
// Search Console verification, and a check that ordering still works. Starts the real server on a throwaway database.
// Run with: npm run test:seo
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const os = require('os');
const { Client: Pg } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_seo_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 8000 + Math.floor(Math.random() * 900);
const SITE = 'https://velto-mart.com.ng';             // the address the test server believes it lives at (BASE_URL); requests still go to localhost
const GSC = 'abcDEF1234567890abcDEF1234567890', GSC_FILE = 'google0123456789abcdef.html';
let passed = 0, failed = 0, log = '', srv;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
const call = async (method, url, body, cookie, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* html or xml */ }
  return { s: r.status, j, t, h: r.headers, c: (sc[0] || '').split(';')[0] };
};
const tagOf = (html, re) => { const m = re.exec(html); return m ? m[1] : null; };
const title = (h) => tagOf(h, /<title>([^<]*)<\/title>/), desc = (h) => tagOf(h, /<meta name="description" content="([^"]*)"/), canon = (h) => tagOf(h, /<link rel="canonical" href="([^"]*)"/);
const robotsMeta = (h) => tagOf(h, /<meta name="robots" content="([^"]*)"/);
const ldBlocks = (h) => [...h.matchAll(/<script type="application\/ld\+json"[^>]*>([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, '<')));
const locs = (xml) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: SITE, DATABASE_URL: urlOf(DB), DATABASE_SSL: 'off', DATA_DIR: os.tmpdir() + '/sb-seo-' + tag,
    ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', GOOGLE_SITE_VERIFICATION: GSC, GOOGLE_VERIFICATION_FILE: GSC_FILE } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass!' })).c;

  const saveSettings = async (settings) => { const cur = (await call('GET', '/api/admin/settings', undefined, admin)).j; const r = await call('PUT', '/api/admin/settings', { settings, zones: cur.zones }, admin); assert.strictEqual(r.s, 200, r.t); await sleep(150); };

  /* ---- fixtures: real rows in the real tables ---- */
  const store = (await q("SELECT slug FROM stores WHERE slug='electronics'"))[0].slug;
  const mk = async (slug, name, extra = {}) => {
    const r = { brand: 'Acme', description: `${name} description for the test shop.`, price: 15000, stock: 5, sku: 'SKU-' + slug, barcode: '', images: '["https://cdn.example.com/' + slug + '.jpg"]', active: 1, ...extra };
    return Number((await q('INSERT INTO products (slug,store,name,brand,description,price,stock,sku,barcode,images,active,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id', [slug, store, name, r.brand, r.description, r.price, r.stock, r.sku, r.barcode, r.images, r.active, Math.floor(Date.now() / 1000)]))[0].id);
  };
  const live = await mk('seo-live-phone', 'SEO Live Phone', { barcode: '4006381333931' });          // a real, valid EAN-13
  const rated = await mk('seo-rated-speaker', 'SEO Rated Speaker', { barcode: 'INTERNAL-77', stock: 0 });
  await mk('seo-inactive-gadget', 'SEO Inactive Gadget', { active: 0 });
  await mk('seo-bare-cable', 'SEO Bare Cable', { description: '', images: '[]', brand: '', sku: '' });
  const pend = await mk('seo-pending-gadget', 'SEO Pending Gadget'); await q("UPDATE products SET fulfilment='dropship', listing='pending' WHERE id=$1", [pend]); // a dropship item nobody approved yet
  await q("INSERT INTO reviews (product_id,name,rating,title,body,approved,created) VALUES ($1,'Ngozi',5,'Loud and clear','Great sound for the price.',1,$2),($1,'Spam Bot',1,'x','zq-hidden-review',0,$2)", [rated, Math.floor(Date.now() / 1000)]);
  await call('GET', '/api/config'); await sleep(200);

  console.log('\nrobots.txt');
  await test('answers 200 as text and names the production sitemap', async () => {
    const r = await call('GET', '/robots.txt'); assert.strictEqual(r.s, 200); assert.match(r.h.get('content-type'), /text\/plain/);
    assert.match(r.t, new RegExp(`Sitemap: ${SITE}/sitemap\\.xml`)); assert.match(r.t, /Disallow: \/api\//); assert.match(r.t, /Allow: \//);
  });
  await test('does not block pages that carry a noindex tag, so Google can read it', async () => {
    const r = (await call('GET', '/robots.txt')).t, lines = r.split('\n').filter((l) => /^Disallow:/.test(l)).map((l) => l.replace('Disallow:', '').trim());
    assert.deepStrictEqual(lines, ['/admin', '/api/'], 'only the admin dashboard and the JSON API are disallowed');
    for (const p of ['/account', '/checkout', '/order/X', '/login', '/wholesale', '/supplier', '/partner', '/rider']) assert.ok(!lines.some((d) => p.startsWith(d)), p + ' must stay crawlable');
    assert.ok(!lines.some((d) => '/uploads/x.jpg'.startsWith(d) || '/brand/velto-banner.jpg'.startsWith(d)), 'images stay crawlable');
  });

  console.log('\nsitemap.xml');
  let sm, urls;
  await test('is valid XML with the right type, status 200, and uses the production address only', async () => {
    sm = await call('GET', '/sitemap.xml'); assert.strictEqual(sm.s, 200); assert.match(sm.h.get('content-type'), /application\/xml/);
    assert.match(sm.t, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/); assert.ok(sm.t.trim().endsWith('</urlset>'));
    urls = locs(sm.t); assert.ok(urls.length > 20);
    for (const u of urls) { assert.ok(u.startsWith(SITE + '/') || u === SITE, u); assert.ok(!/localhost|127\.0\.0\.1|onrender/.test(u), u); }
    assert.strictEqual(new Set(urls).size, urls.length, 'no duplicate addresses');
    assert.strictEqual((sm.t.match(/<url>/g) || []).length, (sm.t.match(/<\/url>/g) || []).length);
  });
  await test('lists the homepage, shop, departments, information pages, dropshipping and public products', async () => {
    for (const p of ['/', '/shop', '/stores', '/dropshipping', '/import-export', '/d/electronics', '/d/fashion', '/page/about', '/page/shipping', '/page/contact', '/product/seo-live-phone', '/product/seo-rated-speaker']) assert.ok(urls.includes(SITE + p), p);
    assert.ok(!urls.includes(SITE + '/d/pharmacy'), 'the pharmacy department is switched off');
  });
  await test('leaves out inactive, unapproved and private items', async () => {
    assert.ok(!sm.t.includes('seo-inactive-gadget')); assert.ok(!sm.t.includes('seo-pending-gadget'));
    for (const p of ['/admin', '/account', '/checkout', '/login', '/register', '/wholesale', '/supplier', '/partner', '/rider', '/order', '/track', '/wishlist', '/api', '/feed']) assert.ok(!urls.some((u) => u === SITE + p || u.startsWith(SITE + p + '/')), p + ' must not be listed');
  });
  await test('escapes XML and reports an unknown part file as 404 while one file is enough', async () => {
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(sm.t), 'bare ampersand'); assert.strictEqual((await call('GET', '/sitemap-1.xml')).s, 404);
  });
  await test('follows the catalogue: a product switched on appears, switched off disappears', async () => {
    await q("UPDATE products SET active=1 WHERE slug='seo-inactive-gadget'"); await saveSettings({ announcement: 'on' });
    assert.ok((await call('GET', '/sitemap.xml')).t.includes('/product/seo-inactive-gadget'), 'now public');
    await q("UPDATE products SET active=0 WHERE slug='seo-inactive-gadget'"); await saveSettings({ announcement: 'off' });
    assert.ok(!(await call('GET', '/sitemap.xml')).t.includes('seo-inactive-gadget'), 'switched off again');
  });

  console.log('\nHomepage');
  let home;
  await test('has the agreed title and description, en-NG, canonical and social tags', async () => {
    home = await call('GET', '/'); assert.strictEqual(home.s, 200); assert.match(home.t, /<html lang="en-NG"/);
    assert.strictEqual(title(home.t), 'VELTO-MART | Online Shopping in Nigeria – Shop Fashion, Electronics, Groceries &amp; More');
    assert.match(desc(home.t), /^Shop .* at VELTO-MART\. Discover great products and convenient delivery across Nigeria\.$/); assert.ok(!/health products/.test(desc(home.t)), 'pharmacy is off, so it is not advertised');
    assert.strictEqual(canon(home.t), SITE + '/'); assert.match(home.t, /property="og:url" content="https:\/\/velto-mart\.com\.ng\/"/); assert.match(home.t, /property="og:image" content="https:\/\/velto-mart\.com\.ng\/brand\/velto-banner\.jpg"/);
    assert.match(home.t, /name="twitter:title"/); assert.match(home.t, /name="twitter:description"/); assert.match(home.t, /name="twitter:card" content="summary_large_image"/); assert.match(robotsMeta(home.t), /^index,follow/);
  });
  await test('has WebSite and Organization structured data, with nothing invented', async () => {
    const g = ldBlocks(home.t)[0]['@graph'], site = g.find((x) => x['@type'] === 'WebSite'), org = g.find((x) => x['@type'] === 'Organization');
    assert.strictEqual(site.name, 'VELTO-MART'); assert.strictEqual(site.alternateName, 'Velto Mart'); assert.strictEqual(site.url, SITE + '/');
    assert.strictEqual(org.name, 'VELTO-MART'); assert.strictEqual(org.url, SITE + '/'); assert.ok(org.description.length > 40);
    assert.ok(!('logo' in org) && !('sameAs' in org) && !('address' in org) && !('telephone' in org), 'no logo or profiles are configured, so none are claimed');
    assert.ok(!('contactPoint' in org), 'the placeholder email is not published');
  });
  await test('once the owner sets a logo and profiles, they are used (https only)', async () => {
    await saveSettings({ logo_url: 'https://cdn.example.com/logo.png', instagram: 'https://instagram.com/veltomart', contact_phone: '+234 800 000 0000' });
    const org = ldBlocks((await call('GET', '/')).t)[0]['@graph'].find((x) => x['@type'] === 'Organization');
    assert.strictEqual(org.logo, 'https://cdn.example.com/logo.png'); assert.deepStrictEqual(org.sameAs, ['https://instagram.com/veltomart']); assert.strictEqual(org.contactPoint.telephone, '+234 800 000 0000');
    const bad = await call('PUT', '/api/admin/settings', { settings: { facebook: 'javascript:alert(1)' }, zones: (await call('GET', '/api/admin/settings', undefined, admin)).j.zones }, admin); assert.strictEqual(bad.s, 400, 'a non-https profile link cannot even be saved');
    home = await call('GET', '/');
  });
  await test('shows real, crawlable content without JavaScript: heading, departments, products, delivery and customer service', async () => {
    const t = home.t; assert.match(t, /<div id="shell"><div class="loading-page"><\/div><div class="seo-static"><h1>VELTO-MART<\/h1>/);
    for (const p of ['/d/electronics', '/d/fashion', '/shop', '/stores', '/dropshipping', '/page/shipping', '/page/faq', '/page/contact']) assert.ok(t.includes(`href="${p}"`), p);
    assert.ok(/<li><a href="\/product\/[a-z0-9-]+">/.test(t), 'featured products are linked with plain anchors');
    assert.match(t, /<h2>Delivery<\/h2>/); assert.match(t, /<h2>Customer service<\/h2>/); assert.ok(!t.includes('<!--'), 'every placeholder is filled');
  });
  await test('the Search Console tag is on the homepage only, and the verification file answers only for the configured name', async () => {
    assert.match(home.t, new RegExp(`<meta name="google-site-verification" content="${GSC}">`)); assert.ok(!(await call('GET', '/d/electronics')).t.includes('google-site-verification'));
    const f = await call('GET', '/' + GSC_FILE); assert.strictEqual(f.s, 200); assert.strictEqual(f.t, 'google-site-verification: ' + GSC_FILE);
    assert.strictEqual((await call('GET', '/google9999999999.html')).s, 404);
  });

  console.log('\nProduct pages');
  let live1, rated1;
  await test('carry complete, valid Product structured data from real values', async () => {
    live1 = await call('GET', '/product/seo-live-phone'); assert.strictEqual(live1.s, 200);
    const ld = ldBlocks(live1.t)[0]; assert.strictEqual(ld['@type'], 'Product'); assert.strictEqual(ld.name, 'SEO Live Phone'); assert.strictEqual(ld.sku, 'SKU-seo-live-phone'); assert.strictEqual(ld.brand.name, 'Acme');
    assert.deepStrictEqual(ld.image, ['https://cdn.example.com/seo-live-phone.jpg']); assert.strictEqual(ld.url, SITE + '/product/seo-live-phone'); assert.strictEqual(ld.gtin, '4006381333931');
    assert.deepStrictEqual({ c: ld.offers.priceCurrency, p: ld.offers.price, a: ld.offers.availability, u: ld.offers.url }, { c: 'NGN', p: '15000.00', a: 'https://schema.org/InStock', u: SITE + '/product/seo-live-phone' });
    assert.ok(!('aggregateRating' in ld) && !('review' in ld), 'no reviews exist, so no rating is claimed');
    assert.strictEqual(canon(live1.t), SITE + '/product/seo-live-phone'); assert.match(live1.t, /<div class="seo-static"><nav aria-label="Breadcrumb">/);
  });
  await test('use real approved reviews only, real stock, and never publish an internal code as a GTIN', async () => {
    rated1 = await call('GET', '/product/seo-rated-speaker'); const ld = ldBlocks(rated1.t)[0];
    assert.strictEqual(ld.offers.availability, 'https://schema.org/OutOfStock'); assert.ok(!('gtin' in ld));
    assert.deepStrictEqual({ v: ld.aggregateRating.ratingValue, n: ld.aggregateRating.reviewCount }, { v: 5, n: 1 }); assert.strictEqual(ld.review.length, 1); assert.strictEqual(ld.review[0].author.name, 'Ngozi'); assert.strictEqual(ld.review[0].reviewRating.ratingValue, 5);
    assert.ok(!rated1.t.includes('Spam Bot') && !rated1.t.includes('zq-hidden-review'));
  });
  await test('JSON-LD stays valid JSON when names contain markup', async () => {
    await q("UPDATE products SET name='Tricky </script><b>\"Phone\"' WHERE slug='seo-live-phone'"); await saveSettings({ announcement: 'tricky' });
    const h = (await call('GET', '/product/seo-live-phone')).t; assert.ok(!h.includes('</script><b>')); assert.strictEqual(ldBlocks(h)[0].name, 'Tricky </script><b>"Phone"');
    await q("UPDATE products SET name='SEO Live Phone' WHERE slug='seo-live-phone'"); await saveSettings({ announcement: 'normal' });
  });
  await test('every product page has its own title, description and canonical', async () => {
    const pages = [live1, rated1, await call('GET', '/product/seo-bare-cable')], ts = pages.map((p) => title(p.t)), ds = pages.map((p) => desc(p.t)), cs = pages.map((p) => canon(p.t));
    for (const list of [ts, ds, cs]) assert.strictEqual(new Set(list).size, list.length, JSON.stringify(list));
    assert.match(ds[2], /SEO Bare Cable/, 'a product with no description gets a description built from its real name and price');
  });
  await test('a product with no photo or brand claims neither', async () => {
    const ld = ldBlocks((await call('GET', '/product/seo-bare-cable')).t)[0]; assert.ok(!('image' in ld) && !('brand' in ld) && !('sku' in ld));
  });
  await test('hidden, inactive and unknown products answer 404 with noindex', async () => {
    for (const s of ['seo-pending-gadget', 'does-not-exist']) { const r = await call('GET', '/product/' + s); assert.strictEqual(r.s, 404); assert.match(robotsMeta(r.t), /noindex/); }
  });

  console.log('\nOther public pages');
  await test('departments, information pages, partner stores and dropshipping have unique metadata and the right canonical', async () => {
    const paths = ['/d/electronics', '/d/fashion', '/shop', '/stores', '/dropshipping', '/page/about', '/page/faq', '/page/shipping', '/page/contact', '/page/privacy', '/page/terms'], got = [];
    for (const p of paths) { const r = await call('GET', p); assert.strictEqual(r.s, 200, p); assert.ok(!/noindex/.test(robotsMeta(r.t)), p); assert.strictEqual(canon(r.t), SITE + p, p); got.push([title(r.t), desc(r.t)]); }
    assert.strictEqual(new Set(got.map((x) => x[0])).size, paths.length, 'titles'); assert.strictEqual(new Set(got.map((x) => x[1])).size, paths.length, 'descriptions');
  });
  await test('department pages link to their products and categories with plain links', async () => {
    const h = (await call('GET', '/d/electronics')).t; assert.ok(h.includes('href="/product/seo-live-phone"')); assert.match(h, /href="\/shop\?store=electronics&amp;category=[a-z0-9-]+"/);
  });
  await test('the shop list can be walked page by page without a search box', async () => {
    const p1 = (await call('GET', '/shop')).t; assert.match(p1, /rel="next" href="\/shop\?page=2"/);
    const p2 = await call('GET', '/shop?page=2'); assert.match(robotsMeta(p2.t), /^noindex,follow$/); assert.strictEqual(canon(p2.t), SITE + '/shop'); assert.match(p2.t, /rel="prev" href="\/shop"/);
  });
  await test('filters, sorting and search are noindex but followable and point at the clean address; tracking parameters stay indexable', async () => {
    for (const u of ['/shop?q=phone', '/shop?sort=price_asc', '/shop?store=electronics&category=audio', '/shop?min=100&max=500', '/shop?store=electronics&instock=1']) {
      const r = await call('GET', u); assert.strictEqual(r.s, 200); assert.match(robotsMeta(r.t), /^noindex,follow$/, u); assert.match(canon(r.t), /^https:\/\/velto-mart\.com\.ng\/shop(\?store=electronics)?$/, u);
    }
    const t = await call('GET', '/shop?store=electronics&utm_source=news'); assert.match(robotsMeta(t.t), /^index/); assert.strictEqual(canon(t.t), SITE + '/shop?store=electronics');
    assert.strictEqual(canon((await call('GET', '/d/electronics?sort=price_asc')).t), SITE + '/d/electronics');
  });

  console.log('\nPrivate pages');
  await test('carry noindex in the tag and the header, are not blocked by robots.txt, and show no store data', async () => {
    for (const p of ['/admin', '/account', '/checkout', '/login', '/register', '/wholesale', '/supplier', '/partner', '/rider', '/pharmacist', '/order/ABC123?t=secret', '/track', '/wishlist', '/forgot']) {
      const r = await call('GET', p); assert.strictEqual(r.s, 200, p); assert.match(robotsMeta(r.t), /^noindex,nofollow$/, p); assert.match(r.h.get('x-robots-tag') || '', /noindex/, p); assert.strictEqual(ldBlocks(r.t).length, 0, p); assert.ok(!r.t.includes('class="seo-static"'), p);
    }
    const nf = await call('GET', '/no/such/page'); assert.strictEqual(nf.s, 404); assert.match(robotsMeta(nf.t), /noindex/);
  });
  await test('stay protected by sign-in: robots and noindex are not access control', async () => {
    for (const u of ['/api/admin/seo', '/api/admin/orders', '/api/admin/dashboard']) assert.ok([401, 403].includes((await call('GET', u)).s), u);
    assert.ok([401, 403].includes((await call('GET', '/api/wholesale/prices')).s) || (await call('GET', '/api/wholesale/prices')).s === 404);
  });

  console.log('\nMerchant Center feed');
  await test('lists only real, public, sellable products with NGN prices and no invented identifiers', async () => {
    const r = await call('GET', '/feed/google-merchant.xml'); assert.strictEqual(r.s, 200); assert.match(r.h.get('content-type'), /application\/xml/); assert.match(r.h.get('x-robots-tag'), /noindex/);
    assert.match(r.t, /xmlns:g="http:\/\/base\.google\.com\/ns\/1\.0"/); const items = r.t.split('<item>').slice(1);
    const phone = items.find((i) => i.includes('/product/seo-live-phone<')); assert.ok(phone);
    assert.match(phone, /<g:price>15000\.00 NGN<\/g:price>/); assert.match(phone, /<g:availability>in stock<\/g:availability>/); assert.match(phone, /<g:brand>Acme<\/g:brand>/); assert.match(phone, /<g:condition>new<\/g:condition>/);
    assert.match(phone, /<g:gtin>4006381333931<\/g:gtin>/); assert.match(phone, /<g:image_link>https:\/\/cdn\.example\.com\/seo-live-phone\.jpg<\/g:image_link>/); assert.match(phone, new RegExp(`<link>${SITE}/product/seo-live-phone</link>`));
    const spk = items.find((i) => i.includes('seo-rated-speaker')); assert.match(spk, /out of stock/); assert.ok(!spk.includes('<g:gtin>') && /identifier_exists>no</.test(spk), 'an internal code is not sent as a GTIN');
    for (const hidden of ['seo-inactive-gadget', 'seo-pending-gadget', 'seo-bare-cable']) assert.ok(!r.t.includes(hidden), hidden + ' must not be in the feed');
    assert.ok(!/cost|wholesale|supplier/i.test(r.t.replace(/<description>[\s\S]*?<\/description>/g, '')), 'no private pricing fields');
  });

  console.log('\nAdmin SEO page');
  await test('is owner-only and reports real counts without claiming anything about Google', async () => {
    assert.ok([401, 403].includes((await call('GET', '/api/admin/seo')).s));
    const r = await call('GET', '/api/admin/seo', undefined, admin); assert.strictEqual(r.s, 200); const d = r.j;
    assert.strictEqual(d.domain.base_url, SITE); assert.strictEqual(d.urls.sitemap, SITE + '/sitemap.xml'); assert.strictEqual(d.urls.robots, SITE + '/robots.txt'); assert.ok(d.counts.public_products >= 3); assert.ok(d.counts.public_departments >= 5);
    assert.strictEqual(d.counts.sitemap_urls, locs((await call('GET', '/sitemap.xml')).t).length); assert.ok(d.products.missing_description.sample.some((x) => x.slug === 'seo-bare-cable')); assert.ok(d.products.missing_images.count >= 1);
    assert.ok(d.products.missing_identifiers.sample.some((x) => x.slug === 'seo-bare-cable')); assert.deepStrictEqual([d.search_console.meta_tag_configured, d.search_console.html_file_configured], [true, true]);
    assert.ok(!JSON.stringify(d).includes(GSC), 'the verification token itself is never shown'); assert.ok(!/indexed:/i.test(JSON.stringify(Object.keys(d))), 'no indexing claims');
  });
  await test('the dashboard page script has the SEO section and the page loads', async () => {
    const h = (await call('GET', '/admin')).t; assert.match(h, /views\.seo = async/); assert.match(h, /\['seo', '🔎', 'SEO'\]/);
  });

  console.log('\nDomain safety');
  await test('pages opened on Render\'s temporary address are noindex while canonicals still name the real domain', async () => {
    const r = await new Promise((ok, no) => require('http').get({ host: '127.0.0.1', port: PORT, path: '/d/electronics', headers: { Host: 'velto-mart-abc1.onrender.com' } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => ok({ s: res.statusCode, t })); }).on('error', no)); assert.strictEqual(r.s, 200); assert.match(robotsMeta(r.t), /^noindex/); assert.strictEqual(canon(r.t), SITE + '/d/electronics');
  });
  await test('a bad BASE_URL is reported (unit)', () => {
    const { baseUrlIssues } = require('../lib/seo');
    assert.ok(baseUrlIssues('http://localhost:3000').length >= 2); assert.ok(baseUrlIssues('https://shop.onrender.com').some((x) => /Render/.test(x))); assert.deepStrictEqual(baseUrlIssues('https://velto-mart.com.ng'), []);
  });
  await test('GTIN check (unit)', () => {
    const { validGtin } = require('../lib/seo'); assert.strictEqual(validGtin('4006381333931'), '4006381333931'); assert.strictEqual(validGtin('4006381333932'), ''); assert.strictEqual(validGtin('INTERNAL-77'), ''); assert.strictEqual(validGtin('96385074'), '96385074'); assert.strictEqual(validGtin(''), '');
  });
  await test('sitemap index for a very large catalogue (unit)', () => {
    const { indexXml, urlsetXml, SITEMAP_MAX } = require('../lib/seo'); assert.strictEqual(SITEMAP_MAX, 50000);
    assert.match(indexXml([SITE + '/sitemap-1.xml']), /<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\s*<sitemap><loc>https:\/\/velto-mart\.com\.ng\/sitemap-1\.xml<\/loc><\/sitemap>/);
    assert.match(urlsetXml([{ loc: SITE + '/a?b=1&c=2' }]), /<loc>https:\/\/velto-mart\.com\.ng\/a\?b=1&amp;c=2<\/loc>/);
  });

  console.log('\nOrdering still works');
  await test('cart pricing, pay-on-delivery checkout and the checkout page are unaffected', async () => {
    const price = await call('POST', '/api/cart/price', { items: [{ productId: live, qty: 2 }], state: 'Lagos' }); assert.strictEqual(price.s, 200, price.t);
    const r = await call('POST', '/api/checkout', { items: [{ productId: live, qty: 1 }], contact: { name: 'Chidi Eze', email: 'chidi@example.com', phone: '08031234567' }, address: { state: 'Lagos', city: 'Yaba', address: '5 Herbert Macaulay Way' }, delivery: 'standard', payment: 'pod' });
    assert.strictEqual(r.s, 200, r.t); assert.ok(r.j.ref); assert.strictEqual((await call('GET', '/checkout')).s, 200);
    assert.strictEqual((await call('GET', '/api/config')).s, 200);
  });

  try { srv.kill(); } catch { /* */ }
  await sleep(300);
  try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log('--- server log ---\n' + log.slice(-2000));
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e, '\n--- server log ---\n' + log.slice(-2500)); try { srv.kill(); } catch { /* */ } try { await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* */ } process.exit(1); });
