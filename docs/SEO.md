# SEO and Google: how VELTO-MART is set up to be found

Production domain: **https://velto-mart.com.ng**

Deploying this code makes the shop *ready* to be crawled. It does not mean Google has indexed anything. Only Google Search Console can tell you that, and indexing usually takes days to weeks.

## 1. Environment variables (Render)

| Variable | Required | Value |
|---|---|---|
| `BASE_URL` | **Yes** | `https://velto-mart.com.ng` (no trailing slash, no path). Every canonical link, Open Graph address, sitemap address and the feed use it. |
| `GOOGLE_SITE_VERIFICATION` | Optional | The `content` value of Google's HTML-tag method. Adds a meta tag to the homepage only. |
| `GOOGLE_VERIFICATION_FILE` | Optional | The file name of Google's HTML-file method, for example `google0123456789abcdef.html`. The server then serves that file. |
| `PRODUCTION_ORIGIN` | Optional | Defaults to `https://velto-mart.com.ng`. Only used for the warning in Admin > SEO. |

No verification token is stored in the code. Never put Google credentials in the browser code or in GitHub.

If `BASE_URL` is wrong (localhost, `*.onrender.com`, or a different domain), Admin > SEO shows a warning. Pages opened on the temporary `*.onrender.com` address are served with `noindex` so they cannot compete with the real domain, and their canonical links still name `velto-mart.com.ng`.

**No domain redirect is added by this change.** Add a redirect (for example `www` to the main domain, or Render's hostname to the real domain) only after the domain and DNS have been verified to work.

## 2. Database changes

None. No migration is needed. The feature only reads existing tables (`products`, `stores`, `vendors`, `categories`, `reviews`, `settings`).

Optional settings that already exist and are used when set (Admin > Settings): logo address, Instagram, Facebook, X and TikTok links (https only), contact phone. Optional overrides (not in the settings form; insert in the `settings` table if ever wanted): `seo_home_title`, `seo_home_description`.

## 3. What was built

- **robots.txt** allows crawling of everything except `/admin` (blocked outright at the owner's request; it also carries `noindex`) and `/api/`, and names `https://velto-mart.com.ng/sitemap.xml`. The other private pages (account, checkout, wholesale, supplier, partner, rider, order pages, login) are **not** blocked in robots.txt, because Google can only obey a `noindex` it is allowed to read. They carry `<meta name="robots" content="noindex,nofollow">` and an `X-Robots-Tag` header, and they still require sign-in. robots.txt is not security.
- **sitemap.xml** lists the homepage, `/shop`, public departments, `/stores`, `/dropshipping`, the information pages, approved partner stores and every public product, once each, with absolute https addresses and escaped XML. Hidden, inactive, unapproved, pharmacy-while-off and dropship-not-approved products are excluded, using the same rules the storefront uses. `lastmod` is left out because the database stores creation time, not last-change time. Above 50,000 addresses `/sitemap.xml` automatically becomes an index of `/sitemap-1.xml`, `/sitemap-2.xml`, and so on.
- **Homepage**: the agreed title and description (the description lists only departments that are switched on), `lang="en-NG"`, WebSite and Organization structured data, Open Graph and Twitter tags, and real text links (heading, departments, featured products, delivery, customer service) in the page itself, not only in JavaScript. The Organization uses only settings that exist: logo and social profiles only when set (https only), a contact email only when it is not the placeholder.
- **Product pages**: Product structured data from real values only: name, description, SKU, brand, up to six images, price in NGN, availability from real stock, URL, GTIN only when the barcode is a valid GTIN, approved reviews (up to five) and an aggregate rating only when approved reviews exist. A product with no description gets a meta description built from its name, brand and price.
- **Listings**: filtered, sorted, searched and paged views of `/shop` are `noindex,follow` with a canonical to the clean address, so there are no unlimited duplicate pages, while the plain `?page=N` links let crawlers walk the whole catalogue. Tracking parameters such as `utm_source` only receive the canonical.
- **Merchant Center feed**: `/feed/google-merchant.xml` (RSS with Google's `g:` fields). Only public products with a price, photo and description; out-of-stock items are marked out of stock; NGN prices; GTIN only when valid, otherwise `identifier_exists=no`; condition is `new`. It is read-only and separate from checkout. Served with `X-Robots-Tag: noindex` (it is a data file).
- **Admin > SEO** (owner only): domain check, sitemap, robots and feed addresses, counts, missing descriptions, photos, brand and identifiers, unusual or duplicate slugs, departments and partner stores without descriptions, Merchant feed inclusions, and whether the Search Console tag or file is configured. It does not and cannot report Google's indexing status.

## 4. Deploy

1. Merge the branch and let Render deploy (or deploy the branch manually).
2. On Render set `BASE_URL=https://velto-mart.com.ng` and save. The service restarts.
3. Open `https://velto-mart.com.ng/robots.txt` and `/sitemap.xml` and check they show the real domain.
4. Open Admin > SEO and clear any warnings.
5. Do the Search Console steps below.

Nothing here changes live settings on its own.

## 5. Google Search Console

1. Go to <https://search.google.com/search-console> and add a **Domain** property: `velto-mart.com.ng`.
2. **Verify with DNS (recommended)**: Google shows a TXT record. Add it at your DNS provider (Cloudflare or the domain registrar) for the root domain, wait a few minutes, press Verify. This covers every subdomain and needs no code change.
3. *Alternative, URL-prefix property* `https://velto-mart.com.ng/`:
   - **HTML tag**: copy only the `content` value into `GOOGLE_SITE_VERIFICATION` on Render, redeploy, verify.
   - **HTML file**: put the file name Google gives (for example `google0123456789abcdef.html`) into `GOOGLE_VERIFICATION_FILE`, redeploy, open that address to confirm it returns the right text, verify.
4. **Submit the sitemap**: Sitemaps > enter `sitemap.xml` > Submit. Status should become *Success*.
5. **URL Inspection**: paste the homepage, a department page and a product page into the top bar. Check "URL is on Google" or press *Request indexing* for new pages. Use *View crawled page* to confirm the structured data and the text are visible.
6. **Monitor**: Indexing > Pages shows indexed and not-indexed pages and the reasons. Enhancements shows Product and Merchant listings results. Expect *Excluded by noindex* for private and filtered pages. That is intended.
7. **Merchant Center** (optional): Products > Feeds > add a scheduled fetch of `https://velto-mart.com.ng/feed/google-merchant.xml`, country Nigeria, currency NGN. Set shipping and returns in Merchant Center. They are not in the feed.

Automated Search Console reporting inside the dashboard would need an authenticated Google API integration with credentials kept on the server. It is not part of this change.

## 6. Known limits

- Pages that the storefront script draws (reviews, filters, the full shop experience) are still drawn by JavaScript; the server-written text and links are the crawlable fallback and the source of the structured data.
- Product condition in the feed is assumed to be `new` because the catalogue has no condition field.
- `/sell` and a few other script-only routes still answer HTTP 404 on a direct hit, as before; they are not in the sitemap.

## 7. Tests

`npm run test:seo` (32 checks: robots, sitemap, metadata, structured data, noindex, feed, admin page, Search Console, ordering still works). Run `npm test` and the other `test:*` scripts as before.
