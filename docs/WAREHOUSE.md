# Wholesale warehouse (Phase 1: foundation)

Wholesale stock is **separate from retail stock**. `products.stock` belongs to the retail store only; wholesale uses the warehouse tables.

## What exists now
- **Warehouse + balances.** One main warehouse (`MAIN`; the schema allows more). Per product: `on_hand` (physical), `reserved`, and counters for received, dispatched, damaged, expired, returned, adjustments. `available = on_hand - reserved` (computed). The database refuses `reserved > on_hand`.
- **One function changes stock** (`lib/warehouse.js` `move()`): locks the balance row, applies the change, writes a `wholesale_stock_movements` row (ref `MV-2026-000001`, previous and new balances, user, reason, related quote/receipt) in the same transaction. A repeated idempotency key is applied once.
- **Quotes reserve warehouse stock** when the buyer accepts; released on lapse/cancel; deducted exactly once when shipped. Retail stock is never read or changed by wholesale.
- **Receipts and adjustments** (`GRN-2026-000001`): opening stock, supplier receipts, adjustments (reason required), damaged, expired, returns.
- **Roles, enforced on the server:** administrator = Super Administrator; others get a role from the administrator: warehouse_manager, sales_officer, inventory_officer, accounts_officer, dispatch_officer. Permissions are in `PERMISSIONS` in `lib/warehouse.js`.
- **Audit:** `wholesale_activity_logs` (stock changes, roles, price changes) and `wholesale_price_history`.
- **Document numbers:** `wholesale_document_sequences`, allocated atomically, never reused.

## API (`/api/warehouse`, role-checked)
`GET /me` · `GET /stock` · `GET /movements` · `POST /stock/receipt` · `POST /stock/adjust` · `PUT /stock/:productId/reorder-level` · `GET /activity` · admin only: `GET|POST /staff`, `DELETE /staff/:id`.

## Migration 012
Creates the tables, seeds the `MAIN` warehouse, and moves goods already held for accepted/paid quotes from the retail count into wholesale on-hand + reserved (nothing double counted). **After deploying, receive your wholesale stock** (`POST /stock/receipt` with `opening: true`): until you do, wholesale availability is zero and buyers see no products.

## Not built yet
Staff screens (`/warehouse`), RFQ revisions, final invoices and order numbers, picking/packing, delivery, reports, notifications, bulk stock import. Tests: `npm run test:warehouse`.
