# Registered customers (members) and guests

**Guests** (not signed in) can browse the shop and buy normal items and check out, "buy and go".
**Registered customers** (free account) also get:

| Feature | Guest | Registered |
|---|---|---|
| Normal products, cart, checkout | yes | yes |
| Dropshipped items (list, search, product page, ordering) | hidden | yes |
| Dropshipping page | sign-in wall | yes |
| Import & Export page and enquiry form | sign-in wall (API returns 401) | yes |
| Rewards / loyalty, wallet | needs sign-in (401) | yes |
| Wholesale | sign-in wall (already) + approval | yes |

## How it works
- `lib/members.js` keeps, per request, whether the visitor is signed in. `PC.visibleSql` (the one place that decides what the public catalogue shows) leaves out dropshipped items for guests, so every list, search, product page, home rail and vendor page is covered. Background jobs have no visitor and see everything.
- Search-engine/server-rendered pages are built as a guest, so Google never sees members-only items.
- Catalogue cache keys carry `~g` (guest) or `~m` (member); `cache.drop(key)` drops both. Member answers are sent `private, no-cache` and never kept by Cloudflare.
- Checkout refuses dropshipped items for guests.
- `/api/dropshipping` answers `{locked:true}` to guests; the page shows a sign-in wall with `?next=` so they return afterwards.

No new settings or environment variables. Tests: `npm run test:members`.

## Homepage partner catalogue
Every department homepage ends with "Shop from our partner stores": up to 6 approved partners (busiest first), each with a row of their products and a "Visit store" link, plus "All partner products" (`/shop?store=<dept>&vendor=partners`) and "See all partner stores". Only active, approved products that pass the normal visibility rules appear (dropshipped partner items are hidden from guests). Test: `npm run test:home-partners`.

## Wallet and rewards are easy to find
- Signed-in customers see their wallet balance and reward points in a header chip (links to the account overview), and "Wallet & Rewards" in the menu. The chip refreshes at most once a minute.
- Visitors see a "Create a free account" invitation at the top of each department homepage.
- `/account` opens on the Overview (wallet + rewards + card), not on Orders.
- The VELTO-MART CARD stays "coming soon" until a card issuer is connected (docs/CARDS.md).
Test: `npm run test:wallet-visible`.
