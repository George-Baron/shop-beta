# Shop-Beta

A full online store: six department homepages (Fashion, Supermarket, Beauty, Electronics, Pharmacy, Food), search and filters, product pages with sizes and colours, cart, checkout, customer accounts, wishlist, reviews, order tracking, and an admin dashboard. Prices are in Naira. Delivery fees are set per state. Customers pay with Paystack or pay on delivery.

## Run it on your computer

You need Node.js 22.13 or newer (https://nodejs.org) and a PostgreSQL database (the shop no longer uses a SQLite file).

```
npm install
npm run db:up                                   # starts Postgres 16 in Docker (or use any Postgres you have)
cp .env.example .env                            # DATABASE_URL in it already matches `db:up`
npm start
```

Open http://localhost:3000, then http://localhost:3000/admin. Locally (not in production) the first person to open that page becomes the owner, so do this yourself straight away; in production the owner comes from `ADMIN_EMAIL` and `ADMIN_PASSWORD` (see docs/SECURITY.md).

The shop starts with 60 demo products so you can see every design. Replace them in **Admin > Products**, or start empty by setting `SEED_DEMO=0` before the first start.

Check that everything works: `npm run test:all` runs every automatic test on throwaway databases (needs Postgres; set `TEST_DATABASE_URL` if yours is not the default). Single suites: `test`, `test:security`, `test:cache`, `test:queue`, `test:multi`, `test:ops`, `test:docs`, `test:preflight`.

## What you can change in the admin (`/admin`)

- **Products**: photos (upload or paste a link), prices, "was" price for deals, sizes/colours with stock per variant, featured / best seller / new flags, hide or delete.
- **Departments**: the homepage text of each design, category names and icons.
- **Orders**: change status (paid, processing, shipped, delivered, cancelled). Customers get an email and see the update on their order page. Cancelling returns the stock.
- **Settings**: store name, contact details, WhatsApp button, social links, free-delivery amount, delivery fee and delivery time for every state, pay on delivery per state, Google Analytics and Meta Pixel IDs.
- **Coupons, reviews, messages, newsletter, abandoned carts**.

## Payments, emails, going live

- **Paystack** (online payment), **Resend** (email), **Supabase** (database and photos), **Render** (hosting) and **Cloudflare** (domain, caching) are set up step by step in **docs/DEPLOY.md**, including the test-to-live switch for Paystack, every environment variable, the cutover night checklist and rollback.
- Until a Paystack key is set the shop runs in **demo mode**: "Pay online" shows a fake payment page and no money moves.
- The server never trusts the browser for prices. It re-prices every cart, checks stock under a database lock, and only marks an order paid after asking Paystack to confirm the exact amount.
- Emails are always saved in **Admin > Marketing > Email outbox**; they are sent when `RESEND_API_KEY` and `MAIL_FROM` are set.
- Before launch run `npm run preflight -- --env-file production.env --expect live --online`: it lists every setting mistake without printing a secret.

## Documentation

| Guide | What is in it |
| --- | --- |
| `docs/DEPLOY.md` | Go-live guide: settings, accounts, cutover night, checklist, rollback |
| `docs/OPERATIONS.md` | Logs, error alerts, uptime monitor, backups and restore |
| `docs/SECURITY.md` | Admin account, passwords, rate limits, CSRF, headers |
| `docs/DATABASE.md`, `docs/STORAGE.md` | Supabase database and photo storage; moving from the old SQLite shop |
| `docs/CACHING.md`, `docs/JOBS.md`, `docs/CHECKOUT.md` | How speed, background work and orders stay correct |
| `docs/LOAD-TEST.md` | Load test results and how to repeat them on Render |
| `ARCHITECTURE.md` | How the whole system fits together |

## Files

| File | What it does |
| --- | --- |
| `views/index.html` | The whole front end: all six designs, storefront and admin screens |
| `server.js` | Web server, page rendering for search engines, security headers, sitemap |
| `routes/public.js` | Shop API: products, cart, checkout, orders, accounts, wishlist |
| `routes/admin.js` | Admin API |
| `lib/shop.js` | Pricing, stock, orders, Paystack, emails |
| `lib/db.js`, `lib/seed.js`, `migrations/` | Postgres connection, the demo catalogue, and the database structure (plain SQL files) |
| `lib/auth.js`, `lib/jobs.js`, `lib/queue.js` | Passwords, sessions, rate limits; background jobs (email, payment confirmation, reminders) |
| `lib/backup.js`, `lib/errors.js`, `lib/log.js` | Backups, error tracking and alerts, structured logs |
| `scripts/` | Restore a backup, reset the admin password, import from the old SQLite shop, go-live checker |
| `load/` | Load test (k6) and its integrity checker |

## Good to know

- Unpaid online orders are cancelled after 2 hours so their stock goes back on sale.
- Demo products use invented brand names. Replace them before launch.
- Return, privacy and terms pages in the shop use short generic wording. Have them reviewed for your business.
