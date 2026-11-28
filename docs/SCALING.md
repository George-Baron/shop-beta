# Scaling to 10,000 shoppers and 5,000 checkouts

Everything here was measured on a **2-CPU, 8 GB test machine** where the app, the load generator and Postgres all shared the same two CPUs. Real Render and Supabase numbers will differ, so repeat the tests on staging (see "Prove it on staging"). Where a number is an estimate, it says so.

## What was wrong (measured on `main` before this work)

| Problem | Evidence |
|---|---|
| The homepage was 700 KB (650 KB of inline JavaScript) with a per-visitor security token, so it was rebuilt and gzipped for every visit and could not be cached | 5,000 shoppers at once: the server was killed for running out of memory at 3.9 GB and every request failed. 1,000 at once: homepage median 12.9 s |
| Idle connections closed after Node's default 5 s | about 4% of requests dropped (`UND_ERR_SOCKET`) at 5,000 shoppers |
| `/health` waited in the same 10-connection database queue as customers | a checkout surge could make Render see a healthy server as dead and restart it |
| With a database 10 ms away (realistic for Render to Supabase), checkout ran out of database connections | 1,000 checkouts at once: only 701 succeeded, 128 hard 500 errors, and 28 customers saw an error although their order was created |
| Stock was taken as the first step of the order transaction, so the product row stayed locked for about 30 more database round trips | one popular product could only be bought as fast as one buyer at a time |
| The same rarely-changing settings (countries, zones, currencies, restricted products, partners) were re-read for every order | about 8 of 13 reads before the transaction |

## What changed

1. **Homepage** (`lib/assets.js`): the big inline script and style are moved at start-up into hashed files under `/assets/`, compressed once (brotli and gzip), cached for a year. The page itself is a 1.4 KB shell. CSP is `script-src 'self'` (inline scripts stay blocked; no nonce). The Meta pixel is served as `/px/<id>.js`. Indexable pages send `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`; admin, account and checkout stay `no-cache`.
2. **Overload protection** (`lib/overload.js`): keep-alive 120 s; in-flight caps (browse 1,500, checkout/payment = 15 x `DB_POOL_MAX`, minimum 100); refuses new browsing with a quick 503 + `Retry-After` when the event loop lags over 1 s or memory passes 85% of the container limit (payments only at 95%). `/health`, `/assets/`, `/px/` and payment webhooks are never refused. `/health` now checks the database in the background (unhealthy only after 15 s of failures).
3. **Storefront retry**: `api()` retries a `503 {code:'busy'}` up to 4 times after `Retry-After` plus 0-2 s of randomness. Safe because a refused request never reaches a handler, and checkout carries an Idempotency-Key.
4. **Database pool exhaustion** now answers `503 busy` (the page retries) instead of a 500.
5. **Checkout** (`lib/shop.js`): stock is taken as the last step of the order transaction (lock held for about 5 statements, not about 30), lines are still locked in a fixed order, and the finished order is loaded after the commit. Countries, zones, shipping bands, restricted products, currency rates and "any partners?" are cached for 10 s through the existing cache (admin edits already clear it, `routes/admin.js`).

## Results (same test, before and after)

Simulated 10 ms database round trip, 1 app instance, customers retry like the storefront.

| 1,000 checkouts at once | Succeeded | Hard errors | Order created but customer saw failure | Time |
|---|---|---|---|---|
| Before (pool 10) | 701 | 128 | 28 | 49.6 s |
| After (pool 10) | 992 | 0 | 0 | 36 s |
| After (`DB_POOL_MAX=30`) | **1,000** | 0 | 0 | **15 s** |

| Shoppers browsing at once (home, config, product list, product page, cart price) | Before | After |
|---|---|---|
| 1,000 | 0 failed, homepage median 12.9 s | 0 failed, homepage median 1.6 s |
| 5,000 | **server killed (3.9 GB)** | server alive, peak 544 MB, no dropped connections, 19 s for the whole run |

**5,000 checkouts in the same second, one instance, pool 30, 5 attempts each (about 30 s):** 1,838 got an order, the other 3,162 were told "busy" after their last retry. No 500 errors, no duplicate orders, no stock below zero, memory 360 MB. That is about **60 orders per second per instance** on this machine.
**5,000 buyers for one product with 300 in stock:** exactly 300 orders, stock 0, everyone else got a clean "sold out". No overselling.

## What is NOT proven

- **5,000 checkouts in one second are not completed by one instance.** At about 60 orders/s, one instance needs about 80 s for 5,000. To finish them inside the shopper's retry window (about 20 s) you need roughly 4 instances at this speed, or fewer round trips per order. (Estimate, not measured on Render.)
- **Each order still costs about 30 database round trips.** More can be removed (batching staff notifications, merging order updates, skipping the previous-status lookup) but each is a change inside the order transaction and needs its own testing.
- **Real hosting differs:** Render's CPU per instance is smaller than this machine; the database may be further than 10 ms away (then orders per second fall in proportion); my load generator took CPU from the server.
- **Multi-instance behaviour of the new caches** relies on the existing `cache.bump()` (instances catch up within about 5 s). Not load-tested with several real instances.
- **Paystack and Resend were stand-ins** in these tests. Real Paystack initialisation time will add to checkout latency.
- A **soak test** (10+ minutes) was not run, so slow memory leaks are unchecked.
- Nothing here has been run on staging or production.

## Settings to apply

| Where | Setting | Value |
|---|---|---|
| Render (web service) | Plan | a paid instance with at least 2 GB RAM (the free 512 MB instance sleeps and cannot hold a launch) |
| Render | Instances | start with 2, scale to 4 for a launch day |
| Render | `DB_POOL_MAX` | 30 per instance. Keep (instances x 30) under the Supabase pooler limit (use the transaction pooler, port 6543) |
| Render | `MEMORY_LIMIT_MB` | the plan's RAM (only if the container limit is not detected; shedding starts at 85%) |
| Render | `MAX_INFLIGHT_BROWSE` / `MAX_INFLIGHT_PAY` | defaults 1,500 / (15 x `DB_POOL_MAX`). Lower if latency is poor, raise if you see "busy" with idle CPU |
| Render | `RATE_LIMIT_MULTIPLIER` | **must not be set** (the preflight check already fails if it is) |
| Cloudflare (free) | Proxy the domain; cache `/assets/*` and `/px/*` (it respects the immutable headers); optionally cache `/api/home/*` and `/api/products*` | see `docs/LOAD_TEST.md` |
| Supabase | Connection string | the transaction pooler (port 6543) |

## Deploying safely

File names under `/assets/` contain a hash of their contents. During a rolling deploy two versions run side by side; a visitor who got the new page from one server may ask the old server for the new file and get a 404 until the deploy finishes. Deploy off-peak, and keep Cloudflare's caching on so files already fetched keep being served.

**Rollback:** every change is in its own commit on `perf/scale-10k`. To undo one, `git revert <commit>` and redeploy. To switch off just the load shedding without a deploy, set `OVERLOAD_DISABLED=1`.

## Prove it on staging

Use a separate Render service and database (never the live ones), the Paystack **test** key, and a new `HANDOVER_SECRET`. Run the load generator from another computer (it competes for CPU if it shares the server). The script refuses to hit anything but this computer unless the host is listed in `LOAD_TEST_ALLOW`:

```
LOAD_DB=<staging database url> LOAD_BASE=https://<staging host> LOAD_TEST_ALLOW=<staging host> \
  RETRIES=5 node load/burst.js spread 5000
```

30% of the checkouts start an online payment; against staging that calls Paystack's test API. Add `PAY_TENTHS=0` to send pay-on-delivery orders only.

Staging needs `RATE_LIMIT_MULTIPLIER=100000` (test only) because the test sends from one computer; remove it afterwards. Look at: status counts, 503 share, latency, orders created equal to 200 responses, no duplicate refs, stock never negative.
