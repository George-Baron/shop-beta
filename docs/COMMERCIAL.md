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

## PDF reports and reports by email
- Every report (commercial, partner, warehouse) now has **Download PDF** next to Excel and CSV (A4 landscape, headline figures, repeating table header, page numbers). It uses the standard PDF fonts, so the naira sign prints as "NGN" and characters outside Western European letters print as "?". Excel and CSV keep the exact text.
- **Reports by email** (Commercial operations, Reports tab, bottom): schedule a report daily (yesterday), every Monday (the previous Monday to Sunday) or on the 1st (the previous month), sent shortly after 07:00 Lagos time. Needs Reports: Edit (or the owner) to change; Reports: View can look. The email has the headline figures and a link, never rows or customer details and no attachment; sign in for the full report and its PDF/Excel.
- Recipients can only be active employees or the owner, and each must be allowed to see that report (checked when you schedule and again at every send; a switched-off employee or one who lost access stops receiving it). "Send now" tests a schedule. Each schedule sends once per slot even with several servers running. Needs the Resend key to deliver. Test: `npm run test:report-schedule`.
