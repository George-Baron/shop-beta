# Global Trade module (imports, exports, international shipping)

Admin screen: **Admin > Global Trade**. Permission module: `trade` (roles "Trade & Logistics Manager" and "Trade Analyst" are created automatically; the owner can give `trade` to any role in Employees & roles).

## Build status

| Phase | What (numbering follows the project spec) | Status |
|---|---|---|
| 1 | Database architecture (28 tables), row level security, permissions, administration, audit log | Built |
| 2 | International product settings, currency conversion, country configuration, bulk product import/export | Built |
| 3 | Export checkout and international customer orders | Next |
| 4 | Import procurement and international supplier management | Not started |
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
