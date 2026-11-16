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

## Not built yet
picking/packing, delivery and final invoices, reports, bulk stock import. (Roles, RFQs and notifications came from the reconciled PR #10; see docs/ROLES_RFQ.md.) Migration 014 drops the earlier separate warehouse role table if it is empty. Tests: `npm run test:warehouse`.
