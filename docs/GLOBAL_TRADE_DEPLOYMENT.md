# Global Trade: going live on Render + Supabase

Read with `docs/GLOBAL_TRADE.md` (what each part does) and `docs/RESTORE.md` (backups). This module was built in 9 phases and is safe to deploy with nothing configured: every provider shows "awaiting configuration" until its keys are added, and nothing outside Nigeria can be bought until you switch countries on.

## 1. Before you deploy

1. **Take a backup** (Admin > Settings > Backups, or wait for the nightly one). Migrations 030 to 035 (Global Trade) only ADD tables and columns. They do not change or delete existing retail, wholesale, pharmacy or rider data.
2. Deploy the branch. Migrations run automatically at start-up, once each. Check the Render log for `Applied migration 035_trade_payments.sql`.
3. **Private storage bucket.** Create a PRIVATE Supabase Storage bucket named `trade-docs` (or set `SUPABASE_TRADE_BUCKET`). Leave "Public" off. Supplier invoices, customs files and shipping labels live there. Without Supabase, files go to the server's disk and are lost when Render restarts.
4. Staff roles: give people "Trade & Logistics Manager" (can edit trade, can view money) or "Trade Analyst" (read only). Money changes (supplier payments, refunds) need Finance edit. Owner and Finance roles already have it.

## 2. Environment variables (Render > Environment)

| Variable | Needed for | Notes |
|---|---|---|
| `TRADE_DATA_KEY` | Saving supplier bank details | 32+ random characters. Keep a copy in a password manager. Lose it and saved bank details cannot be read. |
| `PAYSTACK_SECRET_KEY` | Customer payments and refunds | Already used by the store. International orders are charged in naira. |
| `EASYPOST_API_KEY` | Live carrier rates, booking, labels | Start with a TEST key. |
| `EASYPOST_WEBHOOK_SECRET` | Carrier tracking updates | Same secret you give EasyPost for the webhook. |
| `FX_API_URL`, `FX_API_KEY`, `FX_REFRESH` | Exchange rates | Optional. Rates refresh every 6 hours once switched on in Settings. |
| `RESEND_API_KEY` | Customer and staff emails | Without it, messages are kept but marked "skipped". |
| `ANTHROPIC_API_KEY`, `TRADE_ASSISTANT_MODEL` | Assistant chat | Optional. The assistant's findings work without it. |
| `SUPABASE_TRADE_BUCKET` | Private file bucket | Default `trade-docs`. |

Never put keys in the repository or the front-end code (the automated audit checks the page source and every API response for key values).

## 3. Webhooks to register

| Provider | URL | What it does |
|---|---|---|
| Paystack | `https://YOUR-SITE/api/paystack/webhook` | Already set for payments. Also tick the **refund** events (`refund.pending`, `refund.processed`, `refund.failed`) so refunds finish without staff checking. |
| EasyPost | `https://YOUR-SITE/api/trade/webhooks/easypost` | Tracking updates. Signature is checked; unsigned calls are refused. |

## 4. Go-live checklist (do in this order, in test mode first)

1. Global Trade > Settings: fill sender address (name, phone, street, city, postal code). Set the alert email.
2. Countries: switch on a SMALL number of destinations. Set postal-code rules.
3. Currencies & rates: refresh rates; confirm each currency shows a recent rate. Leave the markup at 0% until you decide.
4. Products: for each product to export, fill HS code, customs description, origin, weight and size, then switch "export" on. Add real restrictions for countries you may not ship to.
5. Shipping zones, methods and rates (manual estimates) and duty rules. Duty rates are NOT pre-filled: enter verified rates with their source, or the customer is told duties are not included.
6. Carriers: add the EasyPost TEST key, press "Test connection". Rates must show as live carrier quotes, not estimates.
7. **One full test order**, start to finish: quote, pay (Paystack test card), pack, get rates, book, check label downloads, simulate a carrier update, confirm the customer email and the tracking page, then refund a small amount and wait for Paystack to confirm.
8. Check the customs declaration and documents for that order with your clearing agent. A person must verify HS codes, values and rules for each destination; the system only helps you prepare them.
9. Switch to live keys. Repeat step 7 once with a small real order.
10. Run a restore drill from `docs/RESTORE.md` once before launch.

## 5. After launch

- **Daily:** Notifications tab (alerts), Global tracking (parcels with no update), Payments > reconciliation (flags).
- **Weekly:** Reports (freight by carrier, delivery performance, customs charges). Review exchange-rate age.
- **When a refund stays "pending":** press "Check with Paystack". Never refund again until it says processed or failed.
- **Logs:** Render log shows `[booking]`, `[trade notify]` and Paystack lines. No key values are logged.

## 6. Rollback

Redeploy the previous commit. The extra tables and columns are ignored by older code and nothing in the retail store depends on them. Do not delete trade tables. To stop international selling without a deploy: switch all countries off under Global Trade > Countries.

## 7. Automated checks (run before every deploy)

`npm test` plus `npm run test:trade-core`, `test:trade-export`, `test:trade-import`, `test:trade-carriers`, `test:trade-customs`, `test:trade-payments`, `test:trade-reports`, `test:trade-security`. The security suite hits every trade route (signed out, customer, wrong role, read-only role), checks webhooks reject bad signatures, row-level security on all trade tables, key leaks in responses, page source and logs, injection strings, and rate limits.

## 8. Final acceptance (spec section 22)

| # | Requirement | Status |
|---|---|---|
| 1 | Customer abroad can browse eligible products | Done, tested (`/international`, eligibility and restrictions enforced) |
| 2 | Customer gets a shipping quotation | Done. Live carrier quotes need `EASYPOST_API_KEY`; otherwise clearly labelled manual estimates |
| 3 | Customer can place and pay an international order | Done (Paystack, charged in NGN). Tested with a fake Paystack; run the live test order in section 4 |
| 4 | Book shipments through configured carriers | Built for EasyPost only. Tested against a stand-in, **not the live service**. Other carriers are not integrated |
| 5 | Customers can track shipments | Done (`/international/track`, order page). Carrier updates need the EasyPost webhook |
| 6 | Manage imports from international suppliers | Done |
| 7 | Receive imported goods into inventory | Done (retail stock and wholesale warehouse) |
| 8 | Landed costs calculated and allocated | Done (by value, weight or quantity; exact rounding) |
| 9 | Customs documents generated and managed | Done (PDF documents, declarations, uploads). Filing with customs is only recorded, never sent |
| 10 | Currencies and payment methods work | NGN, USD, GBP, EUR, CAD, AUD and others with real saved rates. Only Paystack is integrated; Flutterwave and Stripe are not |
| 11 | Retail and wholesale still work | Done: all existing test suites pass unchanged |
| 12 | Permissions prevent unauthorised access | Done, tested on every route (`test:trade-security`) |
| 13 | Integrations have error handling | Done: timeouts, ambiguous results kept pending, idempotency keys, signed and de-duplicated webhooks |
| 14 | Works on mobile and desktop | Checked in a real browser at phone, tablet and desktop widths: no sideways scrolling on any trade screen or the tracking page |

## 9. Known limits (honest list)

- Live EasyPost and Paystack refund behaviour is verified against stand-ins only. Use test mode first.
- DHL, FedEx, UPS, Aramex, EMS, freight forwarders, air and sea cargo can only be used through EasyPost or as manual methods.
- Duty and tax rates are never invented. Without rates entered and verified by staff, duties show as "not available".
- Import shipments are not polled from carriers; update them by hand.
- SMS and WhatsApp are not connected for international numbers. Email only.
- No estimated landed-cost calculator before an import is received, and no demand forecasting.
- Customers pay in naira; the amount in their own currency is for display.

## 10. Living next to the Dropshipping module

Main also has a Dropshipping and "trade" module (supplier orders, supplier portal, trade documents, its own countries, currencies, shipping zones, Stripe). Global Trade was merged beside it, not over it. They are separate and do not share data:

| | Dropshipping module | Global Trade |
|---|---|---|
| Admin menu | Dropshipping | Global Trade |
| API | `/api/admin/dropship/...` | `/api/admin/trade/...`, `/api/trade/...` |
| Tables | `suppliers`, `countries`, `currencies`, `fx_rates`, `shipping_zones`, `trade_shipments`... | `international_suppliers`, `trade_countries`, `trade_currencies`, `trade_exchange_rates`, `trade_shipping_zones`... |
| Exchange rates | `FX_FEED_*` | `FX_API_URL`, `FX_API_KEY`, `FX_REFRESH` |
| International cards | Stripe (if switched on) | Paystack in naira only |

- Migrations: Global Trade's are 030 to 035 and run after main's 023 to 029.
- Both modules use the same private `trade-docs` storage bucket; file names do not clash.
- Staff roles: Global Trade uses the `trade` permission, Dropshipping its own. Give each person only what they need.
- Orders: Global Trade orders have delivery "international" and never go to riders; dropship orders are excluded by their own rule. Refunds and payment status for each follow their own module.
- Decide which module you will use for which job before launch, so staff do not enter the same supplier or shipment in both places.
