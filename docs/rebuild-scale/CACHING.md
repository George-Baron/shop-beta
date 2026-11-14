# Caching

No Redis and no extra cost: each instance keeps a small cache in its own memory, and instances tell each other when something changes. Cloudflare can additionally keep catalogue answers at the edge.

## What happens when the admin changes something
1. The admin saves a product, category, department, review or setting.
2. That instance empties its cache immediately, so the admin's next page already shows the change.
3. It adds 1 to a counter in the database (`cache_epoch`). The other instances read that counter every 2 seconds and empty their caches when it changes. So shoppers see the change within about 2 seconds everywhere (plus any time Cloudflare is holding the answer, up to 30 s).
4. If step 3 ever fails, the short expiry times (10 to 60 s) are the safety net.
Partner uploads (step 6A) must call `cache.invalidate()` after saving a product, the same way the admin routes do.

## Stock numbers
Stock on product pages and lists can be up to 10 to 20 seconds behind. Checkout does not use the cache: it takes stock in the database, so nothing can be oversold. A shopper may occasionally see "In stock" for something that has just sold out and get "sold out" at checkout.

## Cloudflare (optional, do after the site is behind it)
The app marks these as shareable (`Cache-Control: public, s-maxage=30`): `/api/home/*`, `/api/products` (lists and product pages), and `/sitemap.xml`. They never contain the signed-in user and never set cookies. Cloudflare does not cache JSON by default, so add one **Cache Rule**:
- If URI path starts with `/api/home/` or `/api/products` and method is GET, and the path does not contain `/reviews` → **Eligible for cache**, Edge TTL: **Respect origin headers**.
- Do **not** cache `/api/config`, `/api/me`, `/api/admin`, `/api/checkout` or the page HTML (`/`, `/product/...`). `/api/config` is `no-store` on purpose because it carries the signed-in user.
- To turn edge sharing off without redeploying code, set `EDGE_CACHE_SECONDS=0`.
- Not verified here (no Cloudflare in the test setup): after adding the rule, request a product URL twice and look for `cf-cache-status: HIT` in the second response.

## Settings (environment variables)
`EDGE_CACHE_SECONDS` (30), `CACHE_POLL_MS` (2000), `CACHE_MAX_ENTRIES` (3000), `CACHE_DISABLED=1` (debugging only). `/health` shows hits, misses, entries and invalidations for that instance.

## Tests
`npm run test:cache` (cache rules, two real instances: invalidation within 2 s, hidden products disappear, user never leaks into shared config, last unit not sold twice, random addresses cannot fill memory). `npm test` runs with the cache off so each step can read back what it just changed.
