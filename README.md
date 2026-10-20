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

The shop is one Node program plus one folder of data (`data/`: the SQLite database and uploaded photos). Any host that runs Node and **keeps a persistent disk** will do: a small VPS, or a platform with a persistent volume. Hosts whose disk is wiped on every restart will lose your orders, so check this first. Free tiers often work for testing but not for a real shop. For a free starter web address most platforms give you a subdomain such as `yourshop.example-host.app`; connect your own domain later in the host's settings, then update `BASE_URL`.

Run it behind HTTPS (hosts do this for you). Back up the `data/` folder regularly.

## Files

| File | What it does |
| --- | --- |
| `views/index.html` | The whole front end: all six designs, storefront and admin screens |
| `server.js` | Web server, page rendering for search engines, security headers, sitemap |
| `routes/public.js` | Shop API: products, cart, checkout, orders, accounts, wishlist |
| `routes/admin.js` | Admin API |
| `lib/shop.js` | Pricing, stock, orders, Paystack, emails |
| `lib/db.js`, `lib/seed.js` | Database tables and the demo catalogue |
| `lib/auth.js`, `lib/jobs.js` | Passwords and sessions; background clean-up and reminders |

## Good to know

- Unpaid online orders are cancelled after 2 hours so their stock goes back on sale.
- Demo products use invented brand names. Replace them before launch.
- Return, privacy and terms pages in the shop use short generic wording. Have them reviewed for your business.
