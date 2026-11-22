# VELTO-MART Mobile API, version 1

Base path: `/api/mobile/v1`. JSON in, JSON out. Built for the VELTO-MART Android and iOS apps. The website and its `/api/...` routes are unchanged.

Status of this document: covers sign-in, profile, devices, account deletion, catalogue, cart, checkout, payments, orders, addresses, wishlist and notifications (all built and tested). **Not built yet:** wholesale, push notifications and preferences, support requests, returns enquiries, reviews. They are listed at the end.

## Rules every endpoint follows

- **Customers only.** Admin, staff, rider, partner, supplier and pharmacist accounts cannot sign in to the app (`403 use_website`). A mobile token is accepted only under `/api/mobile/v1`; it opens nothing on the website or back office.
- **No cookies.** A website cookie never signs anyone in here.
- **Errors** always look like `{ "error": "Readable message", "code": "machine_code", "requestId": "..." }`. Show `error` to the customer, branch on `code`.
- **Responses are never cached** by the network (`Cache-Control: no-store`), except public catalogue reads, which carry short public cache headers.
- **Money** is in the currency's main unit as the website uses it (Naira for NGN). Prices, stock, delivery fees and discounts are decided only by the server.
- **Rate limits** are keyed by account, device or email (not only IP address), and answer `429 rate_limited`.

### Common error codes

| Status | Code | Meaning / what the app does |
| --- | --- | --- |
| 400 | `invalid_request`, `bad_request` | Bad input; show `error` |
| 401 | `missing_token`, `invalid_token` | Not signed in; go to sign-in |
| 401 | `token_expired` | Access token expired; call `/auth/refresh` once, then retry |
| 401 | `session_expired` | Refresh token expired; sign in again |
| 401 | `session_revoked` | Signed out by the server (password change, copied token, switched-off account); sign in again |
| 403 | `use_website` | Not a customer account |
| 403 | `account_off` | Account switched off |
| 404 | `not_found` | Missing, or not yours |
| 409 | `conflict` and specific codes | State does not allow it (see endpoint) |
| 429 | `rate_limited` | Wait and retry later |

## Sign-in and tokens

- Access token: `at_...`, valid **15 minutes**, sent as `Authorization: Bearer <token>`. Keep in memory only.
- Refresh token: `rt_...`, valid **60 days** from its last use. Store in the device secure store (Expo SecureStore). **Every refresh returns a new pair; the old refresh token stops working.**
- If a reply is lost, retrying with the same old refresh token works once more for **60 seconds**. Using an old refresh token after that revokes the whole device session (a copied token).
- The server stores only SHA-256 hashes of tokens. A user can have **10** signed-in devices; the least recently used is signed out.
- `device` is sent at sign-in: `{ "id": "8-64 chars [A-Za-z0-9_-], made once per install", "name": "Pixel 8", "platform": "android|ios", "appVersion": "1.0.0" }`.

### POST `/auth/register`
Body: `{ name, email, phone?, password, device }`. Password rules are the website's (length, not common, not your email or name).
`200`: `{ user: { id, name, email, phone, role: "customer" }, accessToken, accessExpiresIn: 900, refreshToken, refreshExpiresAt }`.
Errors: `invalid_name`, `invalid_email`, `weak_password`, `invalid_device`, `cannot_register` (the same answer whether or not the email is taken).

### POST `/auth/login`
Body: `{ email, password, device }`. `200`: same as register.
Errors: `401 bad_credentials`, `403 use_website`, `403 account_off`, `429 rate_limited` (after repeated failures for the same email, device or address; only failures count).

### POST `/auth/refresh`
Body: `{ refreshToken }`. `200`: same shape as login. Errors: `invalid_token`, `session_expired`, `session_revoked`.

### POST `/auth/logout`
Auth required. Revokes this device's session on the server. `200 { ok: true }`.

### POST `/auth/forgot`
Body: `{ email }`. Always `200 { ok: true }`. Sends the website's reset email; the link opens the website page where the customer chooses a new password.

### POST `/auth/reset`
Body: `{ token, password }` (token from the email link). `200 { ok: true }`; every website and app session is signed out; the customer signs in again. Errors: `reset_expired`, `weak_password`.

## Profile, devices, deletion (auth required)

| Method and path | Body | Answer |
| --- | --- | --- |
| GET `/me` | | `{ user }` |
| PUT `/me` | `{ name, phone?, password?, newPassword? }` (changing the password needs the current `password`) | `{ user }`. A password change signs out every other app device and every browser. Errors `wrong_password`, `weak_password` |
| GET `/me/devices` | | `{ devices: [{ id, name, platform, app_version, created, last_used, current }] }` |
| DELETE `/me/devices/:id` | | `{ ok }`; `404` if not yours |
| POST `/me/delete-account` | `{ password }` | `{ ok, scheduled_for, wait_days }` |

**Account deletion:** blocked with `409 orders_in_progress` while an order or wholesale quotation is open. Otherwise the account is switched off at once (all devices signed out, login answers `account_off`). After `ACCOUNT_DELETE_WAIT_DAYS` (default 14) the worker anonymises name, email, phone, addresses, wishlist, notifications and review names. **Order and payment records are kept** (accounting) and stay linked to the anonymous account. To cancel within the waiting period the customer contacts the store (a self-service cancel is not built).

## Catalogue (no sign-in)

| Method and path | Notes |
| --- | --- |
| GET `/config` | Store settings, departments, delivery zones, payment methods. Same as the website's config, without a user |
| GET `/home/:store` | Department home content |
| GET `/products` | Query: `q`, `store`, `category`, `sort`, `min`, `max`, `size`, `color`, `rating`, `instock`, `page`. 20 per page; `{ products, total, pages, facets }`. Searches are limited to 120 per minute |
| GET `/products/:slug` | `{ product (with variants and live stock), related, reviews }`. Stock is for display only |
| POST `/products/by-ids` | `{ ids: [...] }` up to 24; for recently viewed, saved items |
| GET `/vendors`, GET `/vendors/:slug` | Partner stores and their pages |

Wholesale prices and quantities are never in any of these answers.

## Cart and delivery

The cart is kept on the phone. Send it to the server to be priced.

- POST `/cart/price`: `{ items: [{ productId, variantId?, qty }], state, coupon?, currency?, delivery? , payment? }` returns lines, subtotal, discount, delivery options and fee, tax, total, available payment methods and `issues[]`. **Always call this before checkout and show `issues`.** The server uses its own prices, whatever the phone sends.
- GET `/delivery/config`, GET `/delivery/search?q=`, POST `/delivery/quote` `{ location: { lat, lng }, state, items }`: delivery distance and time from partner stores. Partner phone numbers are not returned.

## Checkout (auth required)

### POST `/checkout`
**Header `Idempotency-Key` is required** (16 to 64 chars of `A-Za-z0-9_-`; make a new random one per checkout attempt and reuse it for retries of that attempt). Body is the website's checkout body: `{ items, contact: { name, email, phone }, address: { state, city, address }, delivery, payment: "paystack|stripe|pod", location?, coupon?, notes?, currency? }`.

`200`: `{ ref, token, next, url?, replayed? }` where `next` is:

- `paystack` or `stripe`: open `url` in the in-app browser (Expo WebBrowser), then poll the payment status below.
- `pod`: order placed; payment on delivery (phone confirmation rules apply; max 2 open pay-on-delivery orders per customer).
- `rx`: prescription order, waiting for the pharmacist (nothing charged).
- `demo`: only when online payments are not configured (development).

Sending the same key again returns the same order (`replayed: true`) and never creates a second order, takes stock twice, or starts a second payment. The same key with a different cart is `409`.

Behaviour kept from the website: if the quantity asked for is more than the stock, the order is placed for what is left and `/cart/price` reported it as an issue. Stock can never go below zero. A fully sold-out item is refused.

## Orders (auth required; only your own orders, others are `404`)

| Method and path | Answer |
| --- | --- |
| GET `/orders?limit=20&before=<id>` | `{ orders: [{ ref, status, payment_method, payment_status, total, currency, charge_amount, created, item_count, first_item, first_image }], next_before }`. Pass `next_before` as `before` for the next page |
| GET `/orders/:ref` | `{ order, actions: { can_cancel, can_pay, can_rate_delivery } }`. `order` has items, totals, timeline `events`, delivery code, rider position while out for delivery, and everything the website's order page shows to the owner |
| POST `/orders/:ref/cancel` | Only while pending and unpaid, else `400 cannot_cancel`. Returns stock |
| GET `/orders/:ref/payment-status` | The **server** asks the gateway and, only if reference, currency and amount match, marks the order paid once. Returns `{ ref, status, payment_status, payment_method, gateway, checking }`. `checking: true` means the gateway could not be reached; ask again shortly. Poll every 3 to 5 seconds for up to about 2 minutes after the browser closes |
| POST `/orders/:ref/pay` | Resume paying a waiting order: `{ url, gateway }`. Never creates a new order. Errors `not_payable`, `awaiting_pharmacist`, `payments_unavailable` |
| POST `/orders/:ref/rate-delivery` | `{ rating: 1-5, comment? }` after delivery by one of our riders. Once per order |
| POST `/orders/:ref/items/:lineId/choose` | `{ choice }` for dropshipped lines that need a customer decision |

**The app is never trusted for payment.** The webhook from the gateway and `payment-status` both go through the same verified settlement used by the website; nothing the phone sends can mark an order paid.

## Addresses (auth required)

GET `/addresses`; POST `/addresses`; PUT `/addresses/:id`; DELETE `/addresses/:id`. Body: `{ label?, name?, phone?, state, city?, address }`. Errors `invalid_state`, `invalid_address`, `too_many_addresses` (limit 10). Only your own.

## Wishlist (auth required)

GET `/wishlist` (ids); GET `/wishlist/products` (cards); POST `/wishlist/:id`; DELETE `/wishlist/:id`; POST `/wishlist/merge` `{ ids }` (after sign-in, to merge a local list). "Recently viewed" is kept on the phone only.

## Notification centre (auth required)

GET `/notifications`, GET `/notifications/count`, POST `/notifications/read` `{ all: true }` or `{ ids: [...] }`. The same notifications the website shows.

## Not built yet

- Wholesale (apply, status, price list, quotes, pay): the backend exists (`/api/wholesale`); the mobile routes are next. Wholesale stock and prices stay completely separate from retail.
- Push notifications (device tokens, Expo push sending, preferences, de-duplication).
- Support requests, complaints and return or refund enquiries linked to orders.
- Product reviews from the app.
- Other payment gateways (Interswitch, Flutterwave, Monnify): **not active and not offered**; nothing exists in the code.
