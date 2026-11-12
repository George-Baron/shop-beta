# Shop-Beta architecture

> Sections 1 to 11 describe the code **before** the rebuild (step 1 snapshot, SQLite). **Section 12 describes what step 2 changed** (PostgreSQL). Where they disagree, section 12 wins.

Written from reading every file in the repo at commit `9d4767f`. Numbers in the last section were measured, not estimated.

## 1. What it is

One Node.js process (Express 4, Node 22.13+) with the built-in SQLite driver (`node:sqlite`). It serves:

- a single-page storefront and admin dashboard (`views/index.html`, about 1,150 lines, plain JavaScript, no build step),
- a JSON API under `/api`,
- uploaded product photos under `/uploads`,
- server-rendered titles, descriptions, JSON-LD and a text fallback for search engines (`describe()` in `server.js`).

Npm dependencies: `express`, `pg` and (from step 4) `compression`. Everything else (cookies, password hashing, rate limiting, `.env` loading, email, Paystack) is hand written.

## 2. Files

| File | Lines | Job |
|---|---|---|
| `server.js` | 181 | Boot, `.env` loader, security headers, `/uploads`, `/api` wiring, robots.txt, sitemap.xml, HTML shell with SEO tags and CSP nonce, error handler, graceful shutdown |
| `lib/db.js` | 114 | Opens `DATA_DIR/shop.db`, creates all tables and indexes, helpers `get/all/run/tx/now` |
| `lib/auth.js` | 79 | scrypt password hashing, cookie sessions, `loadUser`, `requireUser`, `requireAdmin`, in-memory rate limiter |
| `lib/shop.js` | 277 | Settings, cart pricing, stock, order creation/cancel/paid, Paystack calls, webhook signature check, email queue and templates |
| `lib/jobs.js` | 46 | Timers: expire unpaid online orders, abandoned-cart emails, housekeeping |
| `lib/seed.js` | 174 | First-run settings, 6 departments, 37 delivery zones, 60 demo products |
| `routes/public.js` | 286 | Storefront API |
| `routes/admin.js` | 289 | Admin API (all behind `requireAdmin`) |
| `views/index.html` | 1156 | The whole front end |
| `test/smoke.js` | 271 | 23 end-to-end checks on a throwaway database (all pass) |
| `load/` | new | k6 load test and a catalogue seeder (step 1) |

Config (`.env.example`): `PORT, BASE_URL, PAYSTACK_SECRET_KEY, RESEND_API_KEY, MAIL_FROM, ADMIN_EMAIL, ADMIN_PASSWORD, DATA_DIR, SEED_DEMO, TZ_OFFSET_HOURS, TRUST_PROXY` (plus `HOST`).

## 3. Pages (all served by the same HTML shell)

`/`, `/d/:department`, `/shop`, `/product/:slug`, `/page/{about,faq,shipping,privacy,terms,contact}`, and client-only pages `/checkout`, `/order/:ref`, `/account`, `/login`, `/register`, `/forgot`, `/wishlist`, `/track`, `/admin`. Also `GET /robots.txt`, `GET /sitemap.xml` (up to 5,000 products), `GET /uploads/*` (static, 30-day immutable cache).

## 4. API routes

Every `/api` response is `Cache-Control: no-store`. Non-GET requests that carry an `Origin` header must match the host (this is the only CSRF protection).

### Public (`routes/public.js`)

| Route | Notes |
|---|---|
| `GET /config` | Settings, departments, categories, delivery zones, payment options, current user. Read on every page load |
| `GET /home/:slug` | Department homepage: featured, bestsellers, new arrivals, deals (4 queries) |
| `GET /products` | Listing and search. `LIKE '%word%'` over name, brand, sku, category, description; filters; sort; 20 per page; extra COUNT and facet queries |
| `POST /products/by-ids` | Wishlist / recently viewed |
| `GET /products/:slug` | Product, variants, 50 reviews, 5 related |
| `POST /products/:id/reviews` | Limit 8/hour per IP |
| `POST /cart/price` | Re-prices a cart (server decides all prices) |
| `POST /cart/abandon` | Stores an email and cart for reminder email. 40/hour per IP |
| `POST /checkout` | Creates the order. 20/hour per IP. Paystack: initialises payment; pay on delivery: sends emails |
| `POST /orders/lookup`, `POST /orders/:ref/cancel`, `GET /orders` | Order ref + email, or signed-in user |
| `GET /paystack/verify` | Return-page check, asks Paystack to confirm |
| `POST /paystack/webhook` | HMAC-SHA512 signature check, then `settleWithPaystack` |
| `POST /pay/demo/:ref` | Only when no Paystack key is set |
| `POST /auth/register`, `/login`, `/logout`, `/forgot`, `/reset` | Register 10/h, forgot 6/h, reset 15/h per IP. Login: 30 per 15 min per IP and 8 per 15 min per email, applied inside the route |
| `GET/PUT /me`, `GET/POST/DELETE /addresses`, `GET/POST/DELETE /wishlist`, `POST /wishlist-merge` | Signed-in customers |
| `POST /contact`, `POST /newsletter` | 6/h and 10/h per IP |

### Admin (`routes/admin.js`, prefix `/api/admin`)

`GET/POST /setup` (first visitor becomes owner; this is the only unauthenticated admin route), `GET /dashboard`, `GET /orders`, `GET/PUT /orders/:id`, `GET/POST /products`, `GET/PUT/DELETE /products/:id`, `POST /upload`, `GET/POST /categories`, `PUT/DELETE /categories/:id`, `PUT /stores/:slug`, `GET /customers`, `GET/POST /coupons`, `DELETE /coupons/:code`, `GET /reviews`, `PUT/DELETE /reviews/:id`, `GET /messages`, `PUT/DELETE /messages/:id`, `GET /newsletter`, `GET /abandoned`, `POST /abandoned/remind`, `GET /outbox`, `GET/PUT /settings`.

## 5. Database tables (SQLite, 22)

`settings`, `stores` (the six departments, not partner shops), `categories`, `products`, `variants`, `users`, `sessions`, `resets`, `addresses`, `wishlist`, `zones` (delivery fee, ETA and pay-on-delivery flag per state), `coupons`, `orders`, `order_items`, `order_events`, `reviews`, `messages`, `newsletter`, `abandoned`, `outbox`.

Indexes: `products(store, active)`, `products(category_id)`, `variants(product_id)`, `orders(created)`, `orders(user_id)`, `orders(email)`, `order_items(order_id)`, `reviews(product_id, approved)`. Missing: orders by status, orders by payment reference, any search index, `sessions(user_id)`, `outbox(sent)`.

Money is whole Naira in `INTEGER` columns. Times are unix seconds. Order statuses today: `pending, paid, processing, shipped, delivered, cancelled`. Roles today: `customer`, `admin`.

## 6. Files written to disk

- `DATA_DIR/shop.db` and its `-wal` / `-shm` files. Default `DATA_DIR` is `./data`.
- `DATA_DIR/uploads/<24 hex chars>.<png|jpg|webp|gif>`: product photos from `POST /api/admin/upload` (base64 in JSON, 2 MB limit, file type checked by magic bytes). Product records store the path `/uploads/...` or an `https://` link.

Nothing else is written. On Render's free plan this folder is wiped on every restart, so the live shop loses its data unless a disk is attached.

## 7. Every place state lives on the server

| # | State | Where | Problem for 2 instances |
|---|---|---|---|
| 1 | All business data | SQLite file on local disk | Cannot be shared between instances. Single writer |
| 2 | Uploaded photos | Local folder `uploads/` | Second instance would not have them |
| 3 | Login sessions | `sessions` table (token stored as SHA-256) | Fine already, moves with the database |
| 4 | Password reset tokens | `resets` table | Fine |
| 5 | Rate-limit counters | In-memory `Map` in `lib/auth.js`, keyed by IP | Each instance counts separately; reset on restart; keyed by IP only |
| 6 | Background timers | `setInterval` in every process (`lib/jobs.js`) | Two instances would both run them: duplicate abandoned-cart emails, double expiry work |
| 7 | Email sending | `queueMail` writes `outbox`, then fire-and-forget `fetch` to Resend | A crash between the two loses the email; no retry; failures only logged |
| 8 | Paystack webhook | Processed inside the request | No retry queue if the database is busy |
| 9 | Settings | Read from the database on every request (`getSettings`) | No cache, so every request pays 1 query |
| 10 | HTML template | Read once at boot into memory | Fine |
| 11 | Prepared statement cache | In-memory `Map` in `lib/db.js` | Harmless |
| 12 | Cart, wishlist (guests), theme, last order | Browser `localStorage` / `sessionStorage` | Client side only |

## 8. Order, stock and payment flow today

1. `POST /checkout` validates contact, state, delivery and payment choice, then `priceCart` re-prices from the database.
2. Inside one `BEGIN IMMEDIATE` transaction it takes stock with `UPDATE ... WHERE stock >= qty`, inserts the order, items and first event, and bumps the coupon. This already prevents overselling on a single SQLite file.
3. Paystack: calls `transaction/initialize`; if that fails the order is cancelled and stock returned. Pay on delivery: emails are queued.
4. Payment confirmation (`settleWithPaystack`, from the return page or the webhook): calls Paystack verify, checks status, currency and amount equal `total * 100`, then `markPaid`. Webhook signature is checked first. A payment arriving after cancellation is logged for manual refund.
5. Unpaid Paystack orders older than 2 hours are cancelled by a timer and stock is returned.
6. There is no idempotency key, so a double tap on Pay creates two orders. There is no phone confirmation step for pay on delivery.

## 9. Differences between the rebuild prompt and the repo

The prompt describes some things that are **not in the code at this commit**. They will have to be built, not extended:

- **Staff roles (sales, partner/market, delivery): not present.** Only `customer` and `admin` exist.
- **Live delivery map, Leaflet / OpenStreetMap, customer addresses on a map, nearest partner store: not present.** There is no Leaflet code and no latitude/longitude anywhere. The `stores` table holds the six departments, not partner shops.
- **Partner uploads with admin review: not present.**
- Orders have no location, rider, timer stamps or handover code. Step 6A is therefore a new build.

Please confirm whether another branch or an unpushed version holds that work. If it does, tell me where; otherwise I will build it from scratch in step 6A.

## 10. Other findings that matter for later steps

- **Spoofable client address.** `TRUST_PROXY=1` makes Express trust `X-Forwarded-For`. When the app is reached directly, a caller can send any address and bypass every per-IP limit (the baseline checkout test did this to place 100 orders a minute despite a 20/hour limit). Behind Cloudflare and Render the real client address is a different header and hop count. Step 7 must fix both.
- **Admin setup is first-come.** Whoever opens `/admin` first on an empty database becomes the owner, unless `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set.
- **Passwords** use scrypt N=16384, r=8, p=1 (acceptable, can be raised).
- **CSRF** relies on an Origin check only for requests that send an Origin header. No token.
- **Search is the bottleneck.** `LIKE '%word%'` over five columns scans every product. About 33 ms of CPU per search at 20,000 products, on a server that runs one request at a time.
- **Every HTML request** runs 2 to 6 queries (`describe()`) plus string replacement on the 1,150-line template.
- **Repeated product names in your inventory sheet** (about 1,640 names appear more than once) will become duplicate products if imported unchanged; clean first.

## 11. Baseline load test (measured 7 Nov 2026)

Setup: this sandbox, 2 CPUs and 8 GB RAM, shared by the server and the k6 load generator (so absolute numbers are a floor, a dedicated server would do better). One Node process, SQLite on local disk, **20,060 products** (20,000 generated by `load/seed-catalogue.js` plus the 60 demo ones), k6 v0.55.0. Script: `load/baseline.js`.

| Test | Result | Verdict vs target |
|---|---|---|
| Raw capacity, 50 connections, no think time | 159 req/s, 0% errors | |
| 100 connections | 152 req/s, p50 430 ms, **p95 679 ms**, p99 9.3 s, 0% errors | p95 passes, tail does not |
| 200 connections | 151 req/s, 0% errors | |
| 400 connections | 156 req/s, p50 2.3 s, **p95 2.7 s**, 0% errors | fails p95 |
| 500 shoppers (2 to 6 s between pages) | 108 req/s, p50 222 ms, **p95 1.14 s**, p99 29.6 s | fails p95 |
| **2,000 shoppers** (same behaviour) | 157 req/s, p50 133 ms, **p95 33.7 s**, p99 60 s, **10.0% errors** | fails both |
| **100 checkouts per minute** (60 s, pay on delivery) | 104 requests, p95 4 ms, 0 errors, 101 orders, no overselling | passes (but limit bypassed, see section 10) |

Reading: the server tops out near 155 requests a second regardless of connections, because one process handles one request at a time and search and listing queries scan the whole catalogue. The earlier test on 60 products reached 1,000 req/s; a catalogue 330 times larger cuts that to a sixth. Checkout itself is fast; the browsing path is what breaks at 2,000 shoppers.

Raw k6 summaries were saved in the scratch folder during the run; re-run with:

```
# After step 2 (PostgreSQL). Use a throwaway database; the seeder refuses a non-local one.
DATABASE_URL=postgres://postgres@127.0.0.1:5433/sb_load PGSSL=disable node load/seed-catalogue.js 20000
DATABASE_URL=postgres://postgres@127.0.0.1:5433/sb_load PGSSL=disable PORT=3100 BASE_URL=http://localhost:3100 node server.js &
k6 run -e PROFILE=browse -e VUS=2000 -e RAMP=45s -e HOLD=60s load/baseline.js
k6 run -e PROFILE=stress -e VUS=100 -e HOLD=30s load/baseline.js
k6 run -e PROFILE=checkout -e RATE=100 -e HOLD=60s load/baseline.js
```

The seeder refuses to touch a database that already holds orders. (The step 1 numbers above were measured on the SQLite version with the same k6 script.)

## 12. After step 2: PostgreSQL

Full setup, cutover and rollback instructions: `docs/DATABASE.md`.

**What changed**

- `lib/db.js` now uses the `pg` driver with a connection pool (`PG_POOL_MAX`, default 10). Same helper names (`get`, `all`, `run`, `tx`) plus `insert`, but every call is `async`: the whole app (routes, jobs, seed, server start) was converted. `tx()` uses AsyncLocalStorage, so any query inside `tx(async () => ...)` joins the transaction automatically; deadlocks are retried up to 3 times.
- Schema is SQL in `migrations/` (`001_init`, `002_indexes_and_search`, `003_job_locks`), applied by `lib/migrate.js` under an advisory lock when the app starts or with `npm run migrate`.
- `scripts/sqlite-to-postgres.js` copies the old `shop.db` in one transaction, keeps ids, checks every row count and money/stock total, supports `--dry-run`.
- Search uses a `search_text` column kept by triggers plus a trigram index (was `LIKE` over five columns).
- More than 30 indexes (product lists by department and sort, orders by customer/status/payment reference, etc.). Emails are unique case-insensitively through `lower(email)` indexes.
- Express 4 does not catch errors in async handlers, so `lib/async-router.js` wraps every route; a global `unhandledRejection` logger is a last resort.
- Background jobs take a database lease (`job_locks`) so only one instance runs each job, and the "reminder sent" claim is atomic. Works through Supabase's transaction pooler.
- The dashboard's 14 daily-total queries became one grouped query, and the department homepage runs its four lists in parallel.

**Race conditions that SQLite hid (it serialised every write) and are now handled explicitly**

| Case | Fix |
|---|---|
| Two shoppers buying the last unit | Atomic `UPDATE ... WHERE stock >= qty`; products locked in id order to avoid deadlocks |
| Variant stock total drifting | Product stock is adjusted by the same quantity as the variant, not recounted |
| Payment confirmed by webhook and return page at once | Only the call that flips `payment_status` continues (one email, one event) |
| Order cancelled twice at once | Only the call that flips `status` returns stock |
| Coupon with limited uses | Atomic `UPDATE ... WHERE used < max_uses` inside the order transaction |

All five are covered by the new "Concurrency" tests in `npm test` (28 tests now, run against a real throwaway Postgres database).

**Server state after step 2** (compare with section 7)

| # | State | Now |
|---|---|---|
| 1 | Business data | PostgreSQL, shared by any number of instances |
| 2 | Uploaded photos | Still local disk. **Blocks running two instances** (step 3) |
| 5 | Rate-limit counters | Still in memory per instance (steps 3 and 7) |
| 6 | Background timers | Still run on every instance, now guarded by database leases |
| 7 | Email sending | **Background worker (step 5)**, see section 15 |
| 9 | Settings | Still read from the database on every request (step 4) |

**Measured after step 2** (same sandbox, same 20,060-product catalogue, same k6 scripts as section 11; the Postgres server shares the 2 CPUs with the app and the load generator)

| Test | Before (SQLite) | After (Postgres) | Target |
|---|---|---|---|
| Single search request | 33 ms | 17 ms (uses the trigram index) | |
| 100 connections, no think time | 152 req/s, p95 679 ms, p99 9.3 s | 300 req/s, p95 454 ms, p99 511 ms | p95 under 800 ms |
| 400 connections | p95 2.7 s | 288 req/s, p95 1.78 s | |
| 500 shoppers browsing | p95 1.14 s, p99 29.6 s | 157 req/s, **p95 52 ms**, p99 79 ms, 0 errors | passes |
| **2,000 shoppers browsing** | p95 33.7 s, **10% errors** | 246 req/s, **p95 6.6 s, 0 errors** | p95 under 800 ms: **still fails** |
| 100 checkouts per minute | p95 4 ms | p95 18 ms, 0 errors, 101 orders, no negative stock | passes |

Reading: errors are gone and the database is no longer the first bottleneck, but one Node process still tops out near 250 to 300 requests a second, and in this sandbox it competes with Postgres and the load generator for two CPUs. Reaching the 2,000-shopper target needs the next steps: several instances (step 3) and caching of the config, homepage and product pages (step 4).


## 13. After step 3: stateless instances

Goal: any number of identical instances can run behind a load balancer, with nothing held on one instance's disk or memory that another instance would miss.

**Server state after step 3**

| # | State | Now |
|---|---|---|
| 1 | Business data | PostgreSQL |
| 2 | Uploaded photos | **Supabase Storage** (public bucket, key `uploads/<name>`); photo links in the database are full storage addresses; no instance writes photos to disk |
| 3 | Sign-in sessions | PostgreSQL (`sessions` table, already shared) |
| 5 | Rate-limit counters | **PostgreSQL** `rate_limits` (unlogged table), counted across all instances |
| 6 | Background timers | Run on every instance, guarded by database leases (only one does the work) |
| 7 | Email sending | Still inside the request process (step 5) |
| 9 | Settings | Still read from the database on every request (step 4) |

**Other changes**
- `GET /health` for the load balancer: checks the database, answers 503 while the instance is shutting down. Every response carries `X-Instance`.
- Shutdown drains: on SIGTERM the instance reports 503 on `/health`, keeps serving for `DRAIN_MS`, finishes in-flight requests, then closes the database pool (hard stop after 15 s).
- Old `/uploads/<name>` links answer a 301 redirect to the stored photo, so old emails, order pages and caches keep working.
- Production refuses local photo storage: with no Supabase keys, uploads answer a clear 503 instead of silently saving to a disk that disappears on redeploy.
- `scripts/migrate-images.js` moves existing photos (see `docs/STORAGE.md`); `scripts/check-storage.js` proves your real Supabase keys work; `scripts/dev-lb.js` is a tiny load balancer for running two copies on one computer.

**Tests added:** `npm run test:multi` starts two copies with separate disks behind the dev load balancer and checks shared sessions, shared storage, shared rate limits and a zero-failure shutdown under traffic. `npm run test:images` checks the migration script. The upload test in `npm test` now runs against a stand-in for Supabase Storage.

**Not verified here:** the real Supabase Storage service and real Render instances. All storage tests use a stand-in that follows the documented REST calls; run `npm run check:storage` with your keys to confirm.


## 14. After step 4: caching

**What is cached, where, for how long** (per instance, in memory, no Redis; details in `docs/CACHING.md`)

| What | Key | Kept for | Shared with Cloudflare/browsers |
|---|---|---|---|
| Settings (store name, fees, switches) | `settings` | 30 s | no |
| `/api/config` (departments, categories, delivery zones) | `config` (the signed-in user is added after, never cached) | 60 s | no (it carries the user) |
| Department homepage | `home:<slug>` | 30 s | yes, `s-maxage=30` |
| Product list / search / filters | `list:<normalised options>` | 20 s | yes |
| Product page data | `product:<slug>` | 10 s | yes |
| Page title and search-engine data for `/`, `/d/*`, `/product/*`, `/page/*` | `page:<path>` (only pages that exist) | 60 s | no (HTML has a per-visit security nonce) |
| `sitemap.xml` | `sitemap` | 10 min | yes, 5 min |

**How it stays correct**
- One cache miss on a busy page runs one database query, however many shoppers ask at that moment.
- Admin changes to products, categories, departments, reviews or settings clear the cache on that instance *before the admin gets their answer*, and bump a counter in the database (`cache_epoch`). Every other instance checks that counter every 2 s and clears too. Order and message handling do **not** clear it.
- Failed loads are never cached. A load that was running during a clear never stores its old answer.
- Memory is capped (3,000 entries, least recently used go first). Only known search options form the key, and only pages that exist are cached, so random addresses cannot fill it.
- **Stock numbers shown on product pages and lists can be up to 10 to 20 s behind.** Checkout never uses the cache: it reads and reserves stock in the database, so a last unit still cannot be sold twice (tested).

**Also added:** gzip for pages and API answers; photo files already carry `max-age=31536000` (set at upload) and old `/uploads/` links `max-age=86400`; `/health` now reports cache hits/misses.

**Measured after step 4** (same sandbox and 20,060-product catalogue; one instance; Postgres, app and load generator share 2 CPUs)

| Test | After step 2 | After step 4 | Target |
|---|---|---|---|
| **2,000 shoppers browsing** | p95 6.6 s, 0 errors | **p95 15 ms, p99 37 ms, 0 errors** (623 req/s, 99% served from memory) | p95 under 800 ms: **passes** |
| 400 connections, no think time | 288 req/s, p95 1.78 s | 2,218 req/s, p95 250 ms, 0 errors | |
| 100 checkouts per minute | p95 18 ms | p95 16 ms, 0 errors, 101 orders, no negative stock | passes |

**Read this number carefully:** the k6 shoppers pick from a limited set of departments, search words and products, so most requests hit the cache. Real shoppers will search more widely, so the real hit rate will be lower. The worst case (everything a miss) is the step 2 figure, which is why the next steps still matter. The final answer comes from the step 9 staging test on real Render instances.


## 15. After step 5: background worker and job queue

A PostgreSQL job queue (`jobs` table, `lib/queue.js`) claims work with `FOR UPDATE SKIP LOCKED`, which also works through the Supabase transaction pooler. I wrote this small queue instead of adding pg-boss, because it needs fewer moving parts on the pooler and every behaviour here is covered by tests. The worker runs inside each web instance (no extra paid service); `scripts/worker.js` can run it alone later.

- Emails, order emails, Paystack webhook confirmation and the three housekeeping tasks are jobs (see `docs/JOBS.md`). Checkout, the webhook and the admin screens no longer wait for Resend or Paystack.
- Jobs are saved in the same transaction as the change that caused them. Retries with backoff; failed jobs show in the new **Admin > Jobs** screen with Try again / Dismiss.
- The old lease table `job_locks` is no longer used (left in place; safe to drop later).
- Not a job on purpose: stock reservation and release. They stay inside the order transaction (correctness before speed).

Tests: `npm run test:queue` (19 checks). `npm test` waits for the worker before reading the outbox.


## 16. After step 6: checkout correctness

Order states are now `pending, paid, confirmed, dispatched, delivered, cancelled, refunded` (database check constraint). Pay-on-delivery orders need a recorded phone confirmation before they can be confirmed or dispatched. Double taps are made safe with an `Idempotency-Key` header stored in `idempotency_keys` inside the order transaction. Refunds and cancellations are recorded once and return stock only when the goods never left. Paystack payments are marked paid only after signature, Paystack's own verify, reference, NGN and exact-amount checks. Payment start is claimed once per order (`orders.pay_url`), so repeated requests get the same payment page. Full rules, and what is not verified: `docs/CHECKOUT.md`. Migration 007 renames live statuses: staging first.


## 17. After step 7: security and limits

Admin account only from environment variables (or a setup code), no defaults; scrypt hashing with upgrade of old hashes; rate limits per phone/email with loose per-IP ceilings; CSRF protection, `__Host-` secure cookies, stronger headers; every route fuzzed for 5xx (found and fixed NUL-byte and out-of-range-number errors). Dependencies updated so `npm audit --omit=dev` reports 0 vulnerabilities. Details and the lost-password recovery command are in `docs/SECURITY.md`. Tests: `npm run test:security` (18 checks).


## 18. After step 8: operations

- **Logs:** `lib/log.js` writes one JSON object per line (time, level, message, instance, fields). Request lines carry a request id (`X-Request-Id`, also returned to the browser), status and timing, never query strings, bodies or cookies. Secrets in fields are redacted.
- **Errors:** `lib/errors.js` stores unexpected errors (5xx, background jobs that give up, crashes, failed backups) in `error_log`, grouped by place so the same mistake is one row with a count. New errors alert the owner by email and/or webhook (throttled). Shown in Admin > Jobs & backups. No paid error-tracking service was added.
- **Uptime:** `/health` (shallow, for the load balancer) and `/health/deep` (database, job queue moving, a recent backup) for an external uptime monitor. The app cannot alert you when it is down, so the monitor is a free account you create (steps in `docs/OPERATIONS.md`).
- **Backups:** `lib/backup.js`. A consistent snapshot, gzip JSON lines, written nightly by a background job to a private Supabase bucket (newest 14 kept), on demand with "Back up now", or downloaded straight from the admin screen. This is in addition to Supabase's own daily backups.
- **Restore:** `scripts/restore-backup.js`, one transaction, refuses a wrong host, a cut-off file or a non-empty target. Tested by restoring into a brand-new database and comparing every table.

Tests: `npm run test:ops` (24 checks). Migration 009 adds `error_log` and `backups`.

