# Global Trade module (imports, exports, international shipping)

Admin screen: **Admin > Global Trade**. Permission module: `trade` (roles "Trade & Logistics Manager" and "Trade Analyst" are created automatically; the owner can give `trade` to any role in Employees & roles).

## Build status

| Phase | What | Status |
|---|---|---|
| 1 | Database foundation (28 tables), row level security, roles, audit log, countries, currencies, settings | Built |
| 2 | Exchange rates (live provider + manual), product trade settings (HS code, origin, weight, size, bans), Excel/CSV import and export, public "ship to country" product list, dashboard shell | Built |
| 3 | Customer checkout for international orders (address validation, shipping quote, duties estimate, payment in the customer's currency) | Next |
| 4 | Suppliers, import purchase orders, import shipments, landed cost, goods received into stock | Not started |
| 5 | Carrier integrations (adapter per carrier; needs your own carrier accounts and API keys) | Not started |
| 6 | Shipment tracking and customer/admin notifications | Not started |
| 7 | Customs declarations and documents (invoice, packing list, certificate of origin) | Not started |
| 8 | Reports and exports | Not started |
| 9 | Hardening and launch checklist | Not started |

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
