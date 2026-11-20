# Global Trade module (imports, exports, international shipping)

Admin screen: **Admin > Global Trade**. Permission module: `trade` (roles "Trade & Logistics Manager" and "Trade Analyst" are created automatically; the owner can give `trade` to any role in Employees & roles).

## Build status

| Phase | What (numbering follows the project spec) | Status |
|---|---|---|
| 1 | Database architecture (28 tables), row level security, permissions, administration, audit log | Built |
| 2 | International product settings, currency conversion, country configuration, bulk product import/export | Built |
| 3 | Export checkout and international customer orders | Built |
| 4 | Import procurement and international supplier management | Built |
| 5 | Freight quotations and carrier API integrations (needs your own carrier accounts and keys) | Not started |
| 6 | Customs, duties, documentation and landed cost | Not started |
| 7 | International payments and shipment tracking | Not started |
| 8 | Notifications, reporting and AI assistant | Not started |
| 9 | Testing, security audit and production deployment | Not started |

## Rules the code follows (and the tests check)

- **No invented data.** Duty rates, carrier prices, exchange rates and tracking events start empty. Nothing is shown as a live carrier price unless a carrier returned it; manual rates are always labelled "manual estimate".
- **Everything starts OFF.** Nigeria is the home country. Every other country is off until you switch on "Ship to" / "Buy from". Only NGN, USD, GBP, EUR, CAD and AUD are on.
- **A product is offered abroad only when** it is switched on for export, approved for international shipping, has an origin, an HS code (6+ digits), a customs description, a weight and all three dimensions, is not a medicine, and the destination is not on its ban list.
- **Exchange rates.** Stored as history, never overwritten. A rate older than 30 hours is marked stale; older than 72 hours it is refused (HTTP 503) rather than guessed. A transaction will copy the rate it used (fields `fx_rate_to_ngn`, `fx_source`), so later updates never change old orders.
- **Money safety built into the database.** A payment cannot be `succeeded` unless `verified = 1`; a booking cannot be `booked` without the carrier's reference; a tracking event with the same hash is stored once; an export order can have one active booking.
- **Security.** Every trade table has row level security ON with no policies (the Supabase public key reads nothing). All access goes through the server: staff through `/api/admin/trade` (role checked, every change audited in `trade_audit_logs`), customers only through `/api/trade` (public, rate limited, no costs or internal notes). Carrier and payment API keys will only ever be environment variables, never stored in the database.

## Settings

Admin > Global Trade > Settings: exchange-rate refresh and age limits, optional markup on displayed prices (default 0%), shipping quote lifetime, default Incoterm, default duty arrangement (DAP: customer pays duties on arrival; DDP: we collect them), handling fee, shipping margin, insurance rate, alert email, when stock is deducted for export orders.

## Environment

`FX_API_URL`, `FX_API_KEY`, `FX_REFRESH` (all optional, see `.env.example`). Run the checks with `npm run test:trade`.

## Customers outside Nigeria

Public API (used by the storefront in phase 3): `GET /api/trade/countries`, `/currencies`, `/products?country=US&currency=USD`, `/convert?amount=&from=&to=`, `/can-ship?product=&country=`.

## Phase 3: export checkout and international orders

- Storefront: `/international` (country, currency, postal code, optional insurance, shipping options, address, place order) and `/international/order/REF?t=TOKEN` (status, totals, tracking timeline).
- An international order is a normal `orders` row (`delivery='international'`, charged in NGN through the existing Paystack flow) plus an `export_orders` row holding the customer currency, the frozen exchange rate, address, method and duties. Native-currency payment arrives in phase 7.
- Shipping prices are **manual estimates** set in Global Trade > Shipping & duties (zones, methods, weight-bracket rates). No carrier is called and nothing is invented; with no matching rate, the customer sees "no shipping method available".
- Duties are estimated only from rules staff enter. They are collected at checkout (DDP) only when the rules are verified (source + link) and the method supports it; otherwise the customer is told they pay on delivery.
- Quotes are tied to the cart and expire; checkout re-computes and refuses if the total changed. `Idempotency-Key` makes retries safe.
- Only the store's own stock (not partner stock, not pharmacy) can be exported. Stock is reserved at order time and released on cancel.
- Fulfilment (Global Trade > International orders): pack, dispatch (needs carrier + tracking number), deliver, cancel, return. Rider dispatch and handover codes never apply.
- Demo-mode payments confirm the order but never create a "verified" international payment record.
- Tests: `npm run test:trade-export`.

## Phase 4: import procurement and international suppliers

- **Suppliers** (Global Trade > International suppliers): directory with contact, currency, payment and shipping terms, Incoterm, rating and status (active, paused, blocked). Suppliers with orders or payments cannot be deleted, only paused or blocked.
- **Bank details** are encrypted (AES-256-GCM) and only people who can edit Finance may read them; every view is written to the activity log (never the details themselves). Set `TRADE_DATA_KEY` (32+ random characters) to switch this on; without it bank details cannot be saved. Keep a copy of the key: if it is lost the details cannot be read.
- **Catalogue** per supplier: add by hand or upload Excel/CSV (template provided; the preview lists rows with problems, good rows still import; re-uploading updates by supplier SKU and keeps existing product links). **Compare prices** across suppliers for a product, with NGN equivalents at the latest stored rate.
- **Purchase orders**: draft > quotation requested (optionally emailed to the supplier, only when you tick the box) > approved, or cancelled. The server checks the supplier, the minimum order quantity, the order currency and that importing into the destination (and buying from the supplier's country) is switched on under Countries. After approval only dates and notes can change. Approving creates exactly one import shipment.
- **Import shipments**: statuses move only along the allowed path (supplier processing, ready for collection, dispatched, in transit, arrived at port, customs clearance, customs hold, released, local transit, delivered to warehouse). Staff enter carrier, tracking/bill of lading number, expected arrival and the costs (freight, insurance, duties, taxes, clearing, port, inland, other). The exchange rate is frozen when the first cost is saved. Manual progress notes are supported. No carrier data is fetched yet (phase 5).
- **Not in this phase**: receiving goods into stock, damage/shortage counts, and landed-cost allocation per product (phase 6), so "stock received" and "completed" cannot be selected yet.
- **Supplier payments** are records of payments you made outside the system (Finance permission). Balances are kept per currency (orders approved minus payments), and the dashboard's "Owed to suppliers" converts them at the latest rate.
- **Documents** (supplier invoices, purchase agreements, bills of lading and so on; PDF, image, Excel, CSV or Word, up to 8 MB) are stored in a private bucket (`SUPABASE_TRADE_BUCKET`, default `trade-docs`; create it and leave "Public" off) and downloaded only through the staff API.
- Tests: `npm run test:trade-import`.
