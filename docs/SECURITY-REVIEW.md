# Security review (spec section 11)

Run it any time: `npm run test:security-review` (discovers every admin route from source and sweeps it as signed-out, customer, partner, zero-permission employee and all-permission employee).

## Found and fixed
1. `catalog_imports` had no row-level security (migration 018 enables it).
2. A tiny .xlsx that expands to hundreds of MB could crash the server; any self-registered partner could reach it. Zip table is now checked before unpacking (`assertZipSafe`, 40 MB / entry cap).
3. The admin dashboard showed revenue, orders, customers and stock to employees with no permission for them. It is now filtered by role.

## Checked and OK
RLS on every table; CSRF origin check; image upload type/magic-byte/size limits; no secrets in API responses; partner/buyer isolation; deactivated employees locked out at once; owner-only areas unreachable with every permission.

## Not done
Live-site penetration test (sandbox cannot reach it); partner/buyer actions are not in audit_log (imports are in catalog_imports); PDF/scheduled reports; emailed employee invitations.
