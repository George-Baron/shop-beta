# VELTO-MART mobile app (Android and iOS)

Native app built with React Native, Expo (SDK 58), TypeScript and Expo Router. It talks only to the VELTO-MART server's versioned API (`/api/mobile/v1`, documented in `../docs/MOBILE_API.md`). It is not a WebView and it holds **no secrets**: no payment keys, database credentials or service keys are in the app.

## Run it
```bash
cd mobile
cp .env.example .env.local        # EXPO_PUBLIC_API_URL = address of a server you may test against (staging, never live data while developing)
npm install --legacy-peer-deps
npx expo start                    # scan with Expo Go for a quick look; sign-in, shop, cart and checkout work there
```
Push notifications and store-like behaviour need a development build (`eas build --profile development`), because Expo Go cannot register push tokens for a custom project.

## Checks
| Command | What it proves |
| --- | --- |
| `npm run typecheck` | TypeScript is clean |
| `npm test` | 24 unit tests: token refresh and sign-out rules, cart, idempotency keys, https-only payment pages, forms, notification routing |
| `npm run test:contract` | The app's real API client against a real server (needs `CONTRACT_API_URL`, a **test** server; see `../docs/MOBILE_RELEASE.md`) |
| `npx expo export --platform android` / `ios` | The JavaScript bundle builds for each platform |

## Layout
- `src/app`: screens (Expo Router). `(tabs)` Home, Shop, Cart, Orders, Account; product, checkout, order, wholesale, notifications, support, devices, delete account.
- `src/lib`: `api.ts` (bearer tokens, single-flight refresh, offline handling), `session-store.ts` (the refresh token lives only in the phone's Keychain/Keystore), `cart.tsx`, `checkout.ts`, `payment.ts`, `push.ts`, `schemas.ts` (Zod), `queries.ts` (TanStack Query).
- `app.config.ts` and `eas.json`: build configuration for development, staging and production.
