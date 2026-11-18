# Security review (spec section 11)

Run it any time: `npm run test:security-review` (discovers every admin route from source and sweeps it as signed-out, customer, partner, zero-permission employee and all-permission employee).

## Found and fixed
1. `catalog_imports` had no row-level security (migration 018 enables it).
2. A tiny .xlsx that expands to hundreds of MB could crash the server; any self-registered partner could reach it. Zip table is now checked before unpacking (`assertZipSafe`, 40 MB / entry cap).
3. The admin dashboard showed revenue, orders, customers and stock to employees with no permission for them. It is now filtered by role.

## Checked and OK
RLS on every table; CSRF origin check; image upload type/magic-byte/size limits; no secrets in API responses; partner/buyer isolation; deactivated employees locked out at once; owner-only areas unreachable with every permission.

## Added afterwards
- The activity log now covers partner stores and wholesale buyers as well as employees (migration 019, `lib/audit.js`). Owner-only page "Activity log" with a Who filter and search. Passwords, tokens, bank/card details and file contents are never recorded; long lists are stored as a count. Refused attempts are recorded too. Kept for a year.
- Partner bulk photos (`POST /api/partner/photos`): name each photo after the product reference or barcode (`RICE-001.jpg`, `RICE-001_2.jpg`). Own products only (a name that belongs to another store looks the same as "not found"), up to 8 photos per product, photos are added never removed. Test: `npm run test:photos-audit`.

## Not done
Live-site penetration test (sandbox cannot reach it); PDF/scheduled reports; customers' own actions (retail shoppers) are not in the activity log.
