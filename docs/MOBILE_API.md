# Mobile API (Android and iOS apps)

The apps are not in this repository yet; this is the contract they will use. Everything is under `/api/mobile/v1/`. The same shop endpoints as the website (catalogue, checkout, orders, account) answer under that prefix too, so the apps can use one base URL. The website keeps its cookie sign-in unchanged.

## Sign-in (customers only; staff use the website)
| Call | Body | Result |
|---|---|---|
| POST `/auth/login` | `{email, password, device:{name, platform:'android'|'ios', appVersion}}` | `{token_type:'Bearer', access_token, expires_in (3600), refresh_token, refresh_expires_in (30 days), user}` |
| POST `/auth/refresh` | `{refresh_token}` | a new pair (the old pair stops working) |
| POST `/auth/logout` | - (Bearer) | signs this device out |
| POST `/auth/logout-all` | - (Bearer) | signs out every device |
| GET `/auth/devices` | - (Bearer) | signed-in devices, `current` marks this one |
| DELETE `/auth/devices/:id` | - (Bearer) | remove one device |

Send `Authorization: Bearer <access_token>` on every other call. Keep both tokens in the Keychain / Android Keystore, never in plain preferences. When a call returns 401, refresh once and retry; if refresh returns 401, show the sign-in screen.
- Tokens are random, stored only as hashes, and each refresh token works once. If the app refreshes twice at the same moment, one wins and the other gets 401 (just use the new tokens). A used refresh token coming back after 10 seconds means a copy exists, so that device is signed out.
- Wrong passwords use the website's lockout (429 after repeated failures). Switched-off accounts, password changes and resets sign out all apps. At most 10 devices per customer; the oldest is signed out.
- New accounts: `POST /auth/register` (website endpoint, also under the prefix) then `POST /auth/login` for tokens.

## Account dashboard
GET `/account` (also `/api/account/summary` for the website): profile, wallet (available, pending, recent), rewards (points, tier, next tier, offers, recent, referral code), card (availability, cards, latest application), recent orders. One call fills MY VELTO ACCOUNT.

## Other documented areas (all Bearer or cookie)
Wallet `/wallet` (see WALLET.md) · Rewards `/loyalty` (REWARDS.md) · Cards `/cards` (CARDS.md) · Checkout `POST /checkout` with `payment`, `useWallet`, `usePoints`, header `Idempotency-Key` (use a new UUID per purchase attempt and reuse it on network retries) · Preview `POST /wallet/preview` · Preferences `/wallet/preferences`.

## Errors
JSON `{ "error": "message for the customer" }` with: 400 bad input, 401 sign in, 402 not enough wallet or points, 403 not allowed / frozen, 404 not found, 409 conflict, 429 slow down, 502/503 an outside service is unavailable.

## Not built yet
Push notification registration (device tokens), biometric re-lock is app-side, and API reference generation (OpenAPI). Run: `npm run test:mobile`.
