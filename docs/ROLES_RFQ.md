# Employees, roles and quotation requests

## Setup (once)
1. Run the deploy as usual; migration 012 creates the tables and the eight starter roles.
2. In Supabase Storage create a **private** bucket named `rfq-docs` (Public OFF). Buyers' attached documents live there. `npm run preflight` checks it.

## Employees and roles (owner only: Employees & roles)
- The store owner is the only account with every permission. Employees get a role; a role is a list of areas with **View** or **Edit**.
- Starter roles: Commercial Manager, Commercial Officer, Sales Representative, Partner Relationship Officer, Wholesale Sales Officer, Catalogue Manager, Order Processing Officer, Finance Officer. Edit them or add your own.
- A person can have custom permissions that replace their role's.
- Settings, backups, the activity log, employee management and pharmacy are owner-only and cannot be given to a role.
- Changing a person's role, permissions or active state signs them out at once, so the change takes effect immediately.
- Sign in at `/admin` with email or username. New accounts get a temporary password shown once; "Reset password" makes a new one.
- Each employee has sign-in history and recent activity; the Performance tab counts changes, orders handled, products reviewed and quotations over 7/30/90/365 days.

## Quotation requests (RFQ)
1. An approved wholesale buyer lists products wanted (name, quantity, brand, packaging, target price, optional documents) under Wholesale > Request a quotation, and submits.
2. Staff with Edit on "Quotation requests" assign an officer, move it Received, Under review, Supplier sourcing, and price every line (matching to a catalogue product where we stock it, or marking "cannot supply").
3. Save prices to prepare the quotation (goods + logistics + service fee), then Send. The buyer sees prices only after it is sent, and gets a notification and email.
4. The buyer accepts or declines. Staff convert an accepted request into a wholesale order (every line must be matched to one of our own active, non-pharmacy products with enough stock).
5. When that wholesale order is delivered the request is marked Completed. Quotations expire after the validity period.

## Notifications
Bell in the storefront header and in the admin menu. Order status changes, partner product reviews, RFQ steps and announcements all land there. Staff with Edit on Marketing can send announcements to partner stores, wholesale buyers or employees (optionally by email).

## Not yet built
Phase 4 reports (sales, stock, partner and wholesale performance exports).

## Integration notes (after reconciling with main and the warehouse)
- Migration is `013_staff_rfq.sql` (012 is the warehouse). New module `warehouse` and roles Warehouse Manager, Inventory Officer, Dispatch Officer; see docs/WAREHOUSE.md.
- RFQ stock checks and the product matcher read **wholesale warehouse stock**, never the retail `products.stock`.
- `lib/xlsx.js` (fflate) is used for RFQ Excel files; the catalogue import uses `exceljs`. Two spreadsheet libraries: worth merging into one later.
- The partner-side catalogue import and its import-notification to staff were part of the old copy of the import code and are not on main; add them when partner imports are built.
