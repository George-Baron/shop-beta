# Shop-Beta

A full online store: six department homepages (Fashion, Supermarket, Beauty, Electronics, Pharmacy, Food), search and filters, product pages with sizes and colours, cart, checkout, customer accounts, wishlist, reviews, order tracking, and an admin dashboard. Prices are in Naira. Delivery fees are set per state. Customers pay with Paystack or pay on delivery.

## Run it on your computer

You need Node.js 22.13 or newer (https://nodejs.org).

```
npm install
npm start
```

Open http://localhost:3000. Then open http://localhost:3000/admin and create your admin account. The first person to open that page becomes the owner, so do this before you put the shop online (or set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`).

The shop starts with 60 demo products so you can see every design. Replace them in **Admin > Products**, or start empty by setting `SEED_DEMO=0` before the first run.

Check that everything works: `npm test` runs a full test of ordering, payment, stock and the admin area on a throwaway database.

## What you can change in the admin (`/admin`)

- **Products**: photos (upload or paste a link), prices, "was" price for deals, sizes/colours with stock per variant, featured / best seller / new flags, hide or delete.
- **Departments**: the homepage text of each design, category names and icons.
- **Orders**: change status (paid, processing, shipped, delivered, cancelled). Customers get an email and see the update on their order page. Cancelling returns the stock.
- **Settings**: store name, contact details, WhatsApp button, social links, free-delivery amount, delivery fee and delivery time for every state, pay on delivery per state, Google Analytics and Meta Pixel IDs.
- **Coupons, reviews, messages, newsletter, abandoned carts**.

## Taking real payments (Paystack)

1. In your Paystack dashboard copy your **secret key** and put it in `.env` as `PAYSTACK_SECRET_KEY`.
2. In Paystack > Settings > API Keys & Webhooks, set the webhook URL to `https://YOUR-DOMAIN/api/paystack/webhook`.
3. Set `BASE_URL` to your real address (with `https://`).

Use a `sk_test_` key first and place a test order. Until a key is set the shop runs in **demo mode**: the "Pay online" button shows a fake payment page and no money moves.

The server never trusts the browser for prices. It re-prices every cart, checks stock, and only marks an order paid after asking Paystack to confirm the amount.

## Emails

Order confirmations, status updates, password resets and abandoned-cart reminders are always saved in **Admin > Marketing > Email outbox**. To actually send them, create a free Resend account, verify your domain, and set `RESEND_API_KEY` and `MAIL_FROM`.

## Putting it online

**Full go-live guide: [DEPLOY.md](DEPLOY.md)** (Supabase, Resend, Paystack, Geoapify, Render, Cloudflare, rehearsal, launch check, troubleshooting). `render.yaml` is a ready Render blueprint, and `npm run preflight` checks that your settings are safe for launch.


The shop is one Node program, a **PostgreSQL database** (Supabase in production) and a folder of uploaded photos (`data/uploads`, until step 3 moves them to object storage). The database holds orders, so it must never live on a disk that is wiped on restart: use Supabase (or any managed Postgres) and set `DATABASE_URL`.

Run it behind HTTPS (hosts do this for you). Turn on Supabase backups and keep your own copies too.

### Run it on your computer

1. Install Node 22.13 or newer and PostgreSQL 14 or newer.
2. Create an empty database: `createdb shopbeta_dev`.
3. Copy `.env.example` to `.env` and set `DATABASE_URL` (the default points at a local database).
4. `npm install`, then `npm start`. The tables are created automatically on first start (files in `migrations/`).
5. `npm test` runs the full checkout and admin test against a throwaway database. Set `TEST_DATABASE_URL` to a server where it may create databases (default `postgres://postgres@127.0.0.1:5432/postgres`).

### Move an existing SQLite shop to Postgres (one time)

1. Stop the old site, then copy `data/shop.db` (and the `data/shop.db-wal` file if it exists) somewhere safe.
2. Set `DATABASE_URL` to the new empty Postgres database.
3. Test first: `npm run import:sqlite -- path/to/shop.db --dry-run`. It copies everything inside one transaction, compares row counts, order totals and stock for every table, and then rolls back.
4. Run it for real: `npm run import:sqlite -- path/to/shop.db`. If Postgres already has shop data the script refuses (use `--force` only on a database you can empty).
5. Start the app, sign in as admin and spot-check products, a few orders and a customer login. Keep the old SQLite file and `data/uploads` until you are happy.

### Photos (Supabase Storage)

Product photos are stored in a public Supabase bucket, not on the server, so you can run several instances and restart freely. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and (optionally) `SUPABASE_BUCKET`. Move existing photos once with `npm run migrate:uploads -- path/to/data/uploads --dry-run`, then again without `--dry-run`. The script uploads each file, downloads it back to check the size, and only then rewrites the links in the database; it never deletes anything. Old `/uploads/...` links keep working through a redirect. `npm run test:stateless` starts two instances against one database and checks sessions, uploads and the production guard.

### Speed: caching and compression

- **Compression:** pages and JSON are gzip-compressed. Behind Cloudflare, pages are sent uncompressed and Cloudflare compresses them at the edge (saves server CPU).
- **Server cache (no Redis):** department homepages, product lists, product pages, the page head used for search engines, the site config and settings are kept in memory for 10 to 30 seconds. Many simultaneous requests for the same thing share one database query. Stock on a product page is always read live, and checkout always checks real stock inside a database transaction.
- **Edits show up quickly:** when an admin changes a product, category, department, setting or review approval, the cache is cleared at once on that instance, and the other instances notice within about 5 seconds (through a `cache_version` row in the `settings` table). Set `CACHE_DISABLED=1` to switch the server cache off.
- **Browser and Cloudflare:** catalogue answers carry `Cache-Control: public, max-age=10, s-maxage=30, stale-while-revalidate=60`. Account, cart, order, admin and page (HTML) responses are never shared-cacheable. Cloudflare does not cache JSON by default: add a Cache Rule for `/api/home/*`, `/api/products*` that respects the origin's Cache-Control (see DEPLOY notes). Do not cache `/api/config`, `/api/me` or HTML.
- `npm run test:cache` checks all of this with two instances.

### Connection pooling (Supabase)

Use the **transaction pooler** connection string (port 6543). Each app instance opens at most `DB_POOL_MAX` connections (default 10). Two instances use at most 20, well inside the Supabase Pro pooler limit.

## Files

| File | What it does |
| --- | --- |
| `views/index.html` | The whole front end: all six designs, storefront and admin screens |
| `server.js` | Web server, page rendering for search engines, security headers, sitemap |
| `routes/public.js` | Shop API: products, cart, checkout, orders, accounts, wishlist |
| `routes/admin.js` | Admin API |
| `lib/shop.js` | Pricing, stock, orders, Paystack, emails |
| `lib/db.js`, `migrations/`, `lib/seed.js` | PostgreSQL connection, table definitions (SQL migrations) and the demo catalogue |
| `scripts/import-sqlite.js` | One-time copy from the old SQLite file to Postgres |
| `lib/cache.js` | In-memory cache with request sharing and cross-instance clearing |
| `lib/storage.js`, `scripts/migrate-uploads.js` | Photo storage (Supabase Storage or local folder) and the one-time photo move |
| `lib/auth.js`, `lib/jobs.js` | Passwords and sessions; background clean-up and reminders |

## Good to know

- Unpaid online orders are cancelled after 2 hours so their stock goes back on sale.
- Demo products use invented brand names. Replace them before launch.
- Return, privacy and terms pages in the shop use short generic wording. Have them reviewed for your business.

## Background worker (step 5)
Emails, Paystack webhooks and the timed chores (expire unpaid orders, abandoned-cart reminders, clean-up) run as jobs in a Postgres table (`jobs`), no Redis.
- By default the worker runs inside the web process. To run it separately: `npm run worker`, and set `WORKER_ENABLED=0` on the web instances.
- Failed jobs retry after 30 s, 2 min, 10 min, 1 h and 6 h. After that they appear in Admin > Marketing > Background jobs, where you can Retry or Dismiss them.
- A Paystack webhook is acknowledged immediately and confirmed with Paystack in the background; duplicate webhooks do nothing extra.
- Optional: `WORKER_CONCURRENCY` (default 4), `WORKER_POLL_MS` (default 2000). `npm run test:queue` tests it.

## Safe checkout (step 6)
- **One order per attempt.** The checkout page sends a random key with each attempt. Sending the same key again (double click, dropped connection, back button) returns the same order and never takes stock or starts a payment twice. The same key with a different cart is refused (409).
- **Order states:** `pending` -> `paid` (online) or `confirmed` (pay on delivery) -> `processing` -> `shipped` -> `delivered`. Orders only move forward and can be cancelled until delivered. Two staff changing an order at the same moment cannot both win.
- **Pay on delivery needs a confirmation call.** Staff call the customer and set the order to Confirmed before it can be prepared. Unconfirmed orders are cancelled and their stock released after 24 hours. Both are in Admin > Settings > Payments (`pod_confirm_required`, `pod_confirm_hours`).
- **Payment checks:** an order is marked paid only when Paystack confirms the same reference, NGN, and the exact amount. A mismatch is not paid; the order records why for a person to review.
- `npm run test:checkout` tests all of this. `RATE_LIMIT_MULTIPLIER` exists for tests only; leave it unset in production.

## Delivery maps and the handover code (step 6A)
- **Pickup points** (Admin > Pickup points & riders): your main store and any partner shop, each with coordinates and a delivery radius. Until you add one, delivery works as before (state fee only, no map pin).
- **Checkout:** the customer drops a pin, searches an address or taps "Use my location". The server (never the browser) works out distance, driving time, any per-km fee and the promised time. Outside Nigeria, outside the radius, or in a state with no rider: the order is refused with a clear message and a store-pickup option. Items from two pickup points become two pickups on one order.
- **Riders** (Admin > Pickup points & riders) sign in at `/rider`: accept, collect from each pickup, "on the way" (location sent every ~15 s, only then), then enter the customer's 6-digit code. The rider never sees the code. A wrong code counts; after 5 the delivery locks until an admin overrides it with a written reason (saved on the order). For pay on delivery the correct code also records the cash.
- **The code** is made when an order is paid (or confirmed, for pay on delivery). It is calculated from a server secret plus a random value on the order, so it is not stored and a copy of the database does not reveal codes. Set `HANDOVER_SECRET` in production (otherwise one is generated and kept in the database). It dies when the order is delivered or cancelled.
- **Privacy:** only the assigned rider sees the customer's pin and phone, and only while the delivery is active. Rider location points are deleted after 30 days. Add this to your privacy policy (NDPA).
- **Map provider:** set `GEOAPIFY_API_KEY` (free plan: 3,000 requests/day, commercial use allowed, needs the "Powered by Geoapify" link, which the map shows). Restrict the key to your domain in the Geoapify dashboard because the tile URL is visible in the browser. Route and address answers are cached in the database; if the provider is down, quotes fall back to a straight-line estimate. The public OpenStreetMap servers are not used for production traffic. Leaflet is served from this server (`/vendor/leaflet`).
- `npm run test:delivery` tests all of this.

## Security and limits (step 7)

- **Rate limits live in Postgres**, so every instance shares one count. They are keyed on the real visitor IP (`CF-Connecting-IP`, trusted only when the request came from a Cloudflare address).
- **Login lockout** counts failed attempts only, per IP and per account+IP, so a stranger cannot lock the real owner out.
- **Passwords**: customers 8+, staff 12+, no common passwords, nothing containing the email or name. Registration never says whether an email already exists.
- **Guest order lookup** (order number + email) shows status only. Phone, address, delivery code and rider position need the private link sent to the customer (`&t=` token) or the signed-in owner.
- **Reviews** from people who have not received the product wait for admin approval (`review_moderation` setting, default on).
- **Production**: demo payments are off, first-run admin setup is closed unless `SETUP_CODE` is set, staff sessions last 3 days.
- **Pay-on-delivery abuse**: at most 2 unconfirmed POD orders per phone or email.
- **Admin activity log**: every admin change is recorded (passwords never) at `GET /api/admin/audit`.
- Not included yet: admin two-factor login (recommended next) and email verification at sign-up.
- Run `npm run test:security`.

## Operations (step 8)

- `GET /health` is public and only says "up and the database answers" (503 otherwise). Point an uptime monitor at it.
- **Logs**: one JSON line per request in production, with a request id (`X-Request-Id`, also shown on error responses). Query strings are never logged. `LOG_LEVEL`, `LOG_FORMAT`, `SLOW_REQUEST_MS` tune it.
- **Admin > Settings > Status and backups**: database speed, job queue, stuck-worker warning, last backup, "Back up now" and downloads.
- **Backups**: nightly, to the private Supabase bucket `backups` (create it), newest 14 kept, optional encryption with `BACKUP_PASSPHRASE`. `npm run backup` makes one now.
- **Restore**: `npm run restore -- <file>` into a new empty database. Full guide: [docs/RESTORE.md](docs/RESTORE.md).
- Run `npm run test:ops`.

## Load testing (step 9)

`npm run test:load` (quick) or `LOAD_FULL=1 npm run test:load` (staged to 800 shoppers). `npm run loadtest` points the same tool at a staging site. Results, fixes and caveats: [docs/LOAD_TEST.md](docs/LOAD_TEST.md).

## Pharmacy department (phase 2, off by default)

Everything is behind `PHARMACY_ENABLED` and stays invisible until it is set: no medicine can be listed, seen, searched, added to a cart or ordered, and every `/api/pharmacy` route answers 404. The demo medicines in the seed data are hidden too. Setting up (pharmacies, pharmacists, homepage details, checklist) works while it is off, in **Admin > Pharmacy**.
Full guide, the compliance checklist for your lawyer and PCN, and what is NOT built: [docs/PHARMACY.md](docs/PHARMACY.md). Run `npm run test:pharmacy`.
