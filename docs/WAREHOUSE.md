# Wholesale warehouse (Phase 1: foundation)

Wholesale stock is **separate from retail stock**. `products.stock` belongs to the retail store only; wholesale uses the warehouse tables.

## What exists now
- **Warehouse + balances.** One main warehouse (`MAIN`; the schema allows more). Per product: `on_hand` (physical), `reserved`, and counters for received, dispatched, damaged, expired, returned, adjustments. `available = on_hand - reserved` (computed). The database refuses `reserved > on_hand`.
- **One function changes stock** (`lib/warehouse.js` `move()`): locks the balance row, applies the change, writes a `wholesale_stock_movements` row (ref `MV-2026-000001`, previous and new balances, user, reason, related quote/receipt) in the same transaction. A repeated idempotency key is applied once.
- **Quotes reserve warehouse stock** when the buyer accepts; released on lapse/cancel; deducted exactly once when shipped. Retail stock is never read or changed by wholesale.
- **Receipts and adjustments** (`GRN-2026-000001`): opening stock, supplier receipts, adjustments (reason required), damaged, expired, returns.
- **Roles use the shared Employees & roles system** (module `warehouse`, view / edit). Built-in roles: Warehouse Manager, Inventory Officer, Dispatch Officer (view); Wholesale Sales Officer and Finance Officer can view. The owner is the Super Administrator and gives people roles under **Employees & roles**. Viewing needs `warehouse:view`; every change needs `warehouse:edit`; the activity log needs `warehouse:edit`.
- **Audit:** `wholesale_activity_logs` (stock changes, roles, price changes) and `wholesale_price_history`.
- **Document numbers:** `wholesale_document_sequences`, allocated atomically, never reused.

## Screens (Admin > Warehouse)
- **Stock:** on hand, set aside, available, reorder level, retail stock for reference; search, low-stock filter, CSV download; Adjust button (count correction, damaged, expired, customer return; reason required).
- **Receive stock:** search products, enter quantities, save as one receipt (GRN). "Opening stock" for the first entry. Safe to press twice.
- **Movements:** every change with before/after balances, who and why; filter by quote or receipt number.
- **Activity** (edit permission): stock, receipt and price changes.
People who can only view see no edit buttons; the server refuses their changes anyway.

## API (`/api/admin/warehouse`, behind the back-office role gate)
`GET /stock` · `GET /movements` · `POST /stock/receipt` · `POST /stock/adjust` · `PUT /stock/:productId/reorder-level` · `GET /activity`. Staff are managed through `/api/admin/staff` as for every other area.

## Migrations 012 and 014
Creates the tables, seeds the `MAIN` warehouse, and moves goods already held for accepted/paid quotes from the retail count into wholesale on-hand + reserved (nothing double counted). **After deploying, receive your wholesale stock** (`POST /stock/receipt` with `opening: true`): until you do, wholesale availability is zero and buyers see no products.

## Orders, invoices, picking, packing and delivery (migration 015)
- **Paying a quote makes it an order**, in the same database transaction as the payment: order number `ORD-2026-000001` and final invoice `INV-2026-000001` (per-year, Lagos year, never reused). The invoice is a frozen copy of what the buyer paid for (`wholesale_invoices.snapshot`); a later price change cannot alter it. Quotes paid before this release get their numbers the first time they are opened.
- **Fulfilment stages** (between paid and shipped): To pick, Picking, Picked, Packed, Dispatched, Delivered. Every step is checked on the server against the current stage under a row lock, so two people cannot move one order at once (the second gets a clear 409). Quote statuses are unchanged.
- **Picking** records the quantity taken per line; an order cannot be marked picked while any line is short. **Packing** needs a package count. **Take back** steps one stage back until dispatch.
- **Dispatch** needs a packed order; it deducts the stock (once) and records carrier, waybill, driver, vehicle and expected arrival. **Delivered** needs the name of the person who received the goods. **Delivery failed** records a reason and tells the buyer.
- **Buyers** see the order number, invoice number, a progress tracker, driver and vehicle once dispatched, who received it, and can print the final invoice. Internal warehouse notes are never shown to them.
- **Staff** are notified of a new order to pick; the buyer is notified at each major step. Pick list, delivery note and invoice can be printed from the order.
- **Permissions:** picking and packing need warehouse edit; dispatch and delivered need delivery or warehouse edit; money reports need reports or finance; the frozen invoice can be read by finance, warehouse and wholesale staff.

## Reports (Warehouse > Reports, CSV download on each)
Stock and value, Low stock, Stock movements, Fulfilment speed (warehouse view); Sales by product, Sales by buyer, Invoices issued, Waiting for payment (need reports or finance). Periods are whole Lagos days (default last 30 days, at most two years). An order cancelled after payment keeps its invoice and is flagged "refund by hand" in the Invoices report, because credit notes do not exist yet.

API additions: `GET /orders`, `GET /orders/:ref`, `POST /orders/:ref/{start,pick,picked,pack,undo,dispatch,delivered,failed}`, `GET /invoices/:ref`, `GET /reports`, `GET /reports/:name`; buyers: `GET /api/wholesale/quotes/:ref/invoice`.

## Not built yet
Credit notes (refunds after payment are by hand), bulk stock import. (Roles, RFQs and notifications came from the reconciled PR #10; see docs/ROLES_RFQ.md.) Migration 014 drops the earlier separate warehouse role table if it is empty. Tests: `npm run test:warehouse`.
