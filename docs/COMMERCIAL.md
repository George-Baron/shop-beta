# Commercial operations and reports

Admin > **Commercial operations** (visible to the owner and to roles with View on Partner stores, Quotation requests, Reports or Finance).

## Workspace
- Filters: dates, relationship officer (or "Unassigned"), partner status, quotation-request status.
- **Partner stores:** counts (under evaluation, approved, no officer, products awaiting review), and a table with each store's officer, products waiting for review, live products and sales for the period. Choose an officer straight from the table (needs Edit on Partner stores). Sales figures show only to people with Reports or Finance.
- **Quotation requests:** counts (waiting for an officer, assigned to me, quote sent, accepted, converted) and a table; assign an officer from the table (needs Edit on Quotation requests). Drafts are never shown.
- Assigning a partner store notifies the officer.

## Reports (Reports tab, each with Excel and CSV download)
| Report | Who | Notes |
|---|---|---|
| Partner store performance | Reports or Finance | Sales, orders, units, our commission, net to partner. Same sale rule as the dashboard: paid or pay-on-delivery, not cancelled or refunded. |
| Partner catalogues | Partners, Quotation requests or Reports (view) | Products by review state, out of stock, no photo. |
| Quotation request pipeline | Same | Requests created in the period, quotations sent, won, hours to quote, value won. |
| Retail sales by day | Reports or Finance | Lagos days. |
| Employee performance | Owner, or a role with Edit on Reports | Counts of recorded changes, requests assigned and won, partners managed. Activity counts only. |

Migration 016 adds `vendors.officer_id`. Tests: `npm run test:commercial`.

## Not built
Partner-side bulk catalogue upload by partners themselves; PDF output; scheduled/emailed reports.
