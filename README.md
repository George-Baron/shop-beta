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
| `lib/auth.js`, `lib/jobs.js` | Passwords and sessions; background clean-up and reminders |

## Good to know

- Unpaid online orders are cancelled after 2 hours so their stock goes back on sale.
- Demo products use invented brand names. Replace them before launch.
- Return, privacy and terms pages in the shop use short generic wording. Have them reviewed for your business.
