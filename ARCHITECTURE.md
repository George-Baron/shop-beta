# Shop-Beta architecture (as of step 1, before the rebuild)

Written from reading every file in the repo at commit `9d4767f`. Numbers in the last section were measured, not estimated.

## 1. What it is

One Node.js process (Express 4, Node 22.13+) with the built-in SQLite driver (`node:sqlite`). It serves:

- a single-page storefront and admin dashboard (`views/index.html`, about 1,150 lines, plain JavaScript, no build step),
- a JSON API under `/api`,
- uploaded product photos under `/uploads`,
- server-rendered titles, descriptions, JSON-LD and a text fallback for search engines (`describe()` in `server.js`).

Only one npm dependency: `express`. Everything else (cookies, password hashing, rate limiting, `.env` loading, email, Paystack) is hand written.

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
DATA_DIR=/tmp/sb-load node load/seed-catalogue.js 20000
DATA_DIR=/tmp/sb-load PORT=3100 BASE_URL=http://localhost:3100 node server.js &
k6 run -e PROFILE=browse -e VUS=2000 -e RAMP=45s -e HOLD=60s load/baseline.js
k6 run -e PROFILE=stress -e VUS=100 -e HOLD=30s load/baseline.js
k6 run -e PROFILE=checkout -e RATE=100 -e HOLD=60s load/baseline.js
```

Use a throwaway `DATA_DIR`. The seeder refuses to touch a database that already holds orders.
