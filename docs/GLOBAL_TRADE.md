# Global Trade module (imports, exports, international shipping)

Admin screen: **Admin > Global Trade**. Permission module: `trade` (roles "Trade & Logistics Manager" and "Trade Analyst" are created automatically; the owner can give `trade` to any role in Employees & roles).

## Build status

| Phase | What (numbering follows the project spec) | Status |
|---|---|---|
| 1 | Database architecture (28 tables), row level security, permissions, administration, audit log | Built |
| 2 | International product settings, currency conversion, country configuration, bulk product import/export | Built |
| 3 | Export checkout and international customer orders | Built |
| 4 | Import procurement and international supplier management | Built |
| 5 | Freight quotations and carrier API integrations (needs your own carrier accounts and keys) | Built (EasyPost) |
| 6 | Customs, duties, documentation and landed cost | Built |
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

## Phase 5: freight quotations and carrier integrations

- **One real integration: EasyPost** (a multi-carrier service; connect DHL, FedEx, UPS and others inside your EasyPost account). DHL Express, FedEx, UPS, Aramex and EMS are listed as **"Not integrated"** and cannot be switched on directly; no direct carrier API is faked. Forwarders, air and sea freight stay as manual-rate methods.
- **Provider status** (Global Trade > Carriers): *Awaiting configuration* (key missing on the server), *Configured, switched off*, *Ready*, *Not integrated*. A provider can only be switched on when its key is present. Keys live only in server environment variables; the screen shows set / missing, never values. Test connection calls EasyPost's carrier-accounts endpoint.
- **Environment**: `EASYPOST_API_KEY`, `EASYPOST_WEBHOOK_SECRET` (for tracking webhooks), `EASYPOST_API_URL` (tests only). Fill the sender address under Settings (name, phone, street, city, postal code) or live prices and booking stay off.
- **Customer quote**: once a carrier is ready and the customer has entered street address and city, live prices appear next to the manual estimates, labelled **Live carrier price** vs **Estimate**. Prices are converted to NGN with the stored exchange rate, then the shipping margin and handling fee are added. If the carrier fails, only the manual estimates show. The live quote is stored and bound to the cart; checkout uses the stored quote and never calls the carrier again. Quotes expire.
- **Booking** (staff, packed and paid orders only): enter the real parcel, fetch the carrier's own prices, pick one, book. A browser-generated idempotency key makes a repeat click or retry return the first result. A booking is marked *booked* only when the carrier's reply carries a shipment reference and a tracking code. If the carrier does not answer, the booking stays *requested* and a retry with the same key asks the carrier what happened instead of buying again. A carrier rejection is recorded as *failed*. One live booking per order (database-enforced).
- **Labels** are downloaded into the private documents bucket and attached to the order. **Cancel** asks EasyPost for a refund; the booking stays *cancel requested* until the carrier says *refunded* (use Refresh). Not possible once dispatched.
- **Tracking webhook**: `POST /api/trade/webhooks/easypost`, signature (HMAC-SHA256 of the raw body) checked; `503` if no secret is configured, `401` on a bad signature, repeated events ignored. Events are added to the order timeline; after staff dispatch, the order advances to in transit / out for delivery / delivered one allowed step at a time.
- **Not in this phase**: pickup scheduling; insurance quotes in customer prices (insurance can be added at booking); importer-side bookings (imports stay manual).
- **Verification caveat**: the integration is tested against a stand-in for EasyPost, not the live service. Before going live, run one real test shipment in EasyPost's test mode and confirm the webhook signature format against their current documentation.
- Tests: `npm run test:trade-carriers`.

## Phase 6: customs, duties, documents, receiving and landed cost

- **Customs declarations** (Global Trade > Customs & docs, or "Customs declaration" inside an order or shipment): built from the order or shipment (HS code, description, origin, quantity, value, weights). Staff add gross weight, packages, dimensions, Incoterm. A **readiness check** lists what must be fixed (short HS code, missing origin or value, net above gross weight, product restricted for that country). Status path: incomplete / ready, then *submitted*, then *cleared*, *held* or *rejected*. **Nothing is filed with customs from here**: "Record as filed" means your broker or the customs portal was used, and the entry number is saved. A filed declaration cannot be edited.
- **Duty and tax calculator**: uses only the duty rules saved under Shipping & duties. No rule means nothing is calculated. An unverified rule gives an *estimate* and says so; only rules marked verified (with a source) give "verified". De-minimis limits are honoured.
- **Documents (PDF)**: commercial invoice (only after payment), proforma invoice, packing list, certificate of origin (a **draft**: no legal effect until an authorised body certifies it), export and customs declaration summaries (information only, not an official filing), goods received note. Regenerating creates a new version and marks the old one superseded; old versions stay downloadable. Air waybills, bills of lading, insurance certificates and import permits are **uploaded**, never invented. Files go to the private bucket. The seller address comes from Settings.
- **Receiving imported stock** (open a shipment that is *delivered to warehouse*): count received and damaged per item (received cannot exceed ordered; shortage is worked out). Only undamaged units are added to stock, to the **retail store** or the **wholesale warehouse** (through its existing stock ledger). Every item must be linked to one of our own products. Done once; a repeat is refused.
- **Landed cost**: each item's purchase cost plus its share of freight, insurance, duties, taxes, clearing, port, inland and other costs, in NGN at the exchange rate saved with the shipment. Shared by value, weight or quantity (weight needs weights on every item). Shares add up to the exact total (no rounding loss). Damaged and missing units are carried by the units that went into stock. The allocation is saved, per item and cost type, with a goods received note. A weighted-average cost per product is kept for inventory valuation (Trade > valuation report API: `/api/admin/trade/valuation`).
- **Shipment status**: *stock received* is set only by receiving; *completed* is a manual close afterwards.
- **Not in this phase**: automatic duty rates (you enter and verify them), electronic filing, a visual valuation report screen, retail stock-movement history (retail stock is a plain counter in this store).
- Tests: `npm run test:trade-customs` (add `UI_CHECK=1` to also drive the screens in a browser).
