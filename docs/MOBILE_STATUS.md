# VELTO-MART mobile: what is done and what is not

Updated 2026-11-22. "Tested" means automated tests that ran in a development environment with a stand-in for Paystack and Expo. **No feature has been tested on a real phone, against live Paystack/Stripe, or in a store yet.**

## Built and tested (server)
Mobile sign-in (short-lived tokens, rotating refresh, revocation, device list, 10-device limit, customers only); profile; account deletion with waiting period; catalogue, search, product pages; cart pricing; delivery quote; idempotent checkout (pay on delivery, Paystack, Stripe path); order list, detail, cancel, resume payment, server-side payment verification; addresses; wishlist; in-app notifications; push notifications and preferences; support messages; wholesale (apply, price list from the separate wholesale warehouse, quotations, accept, pay, requests for quotation). About 70 automated tests across `test:mobile-auth`, `-shop`, `-wholesale` and `-push`.

## Built (app) and checked
All screens listed in `mobile/README.md`, including saved addresses (add, edit, delete) and the rider's last location (opens in the phone's Maps app). Checks that passed: TypeScript, 24 unit tests, the Android and iOS JavaScript bundles build, and the app's API client passes a 5-step contract test against a real local server. **Not done:** running the screens on a device or simulator, visual QA, accessibility audit with a screen reader, performance profiling on low-end phones.

## Payments
| Method | Status |
| --- | --- |
| Pay on delivery | Built and tested end to end (server) |
| Paystack | Built; verified in tests with a stand-in gateway. **Not yet tried with the live Paystack account from the app** |
| Stripe | **Hidden in version 1.** The shared checkout supports it (same as the website) but there is no mobile-specific test and it has not been exercised from the app. Test with Stripe test keys, then add `'stripe'` to `ENABLED_METHODS` |
| Interswitch, Flutterwave, Monnify | **Not built. Not active. Must not be advertised.** Needs: their merchant accounts and keys, server integration, webhook/verification and refund handling, end-to-end tests |

## Not built yet
- Real device testing, store builds, store submission, store screenshots (need Expo/Apple/Google accounts)
- Photo attachments (the image picker is not installed; support is text only)
- In-app support history/reply thread (replies come by email)
- Product reviews written from the app; returns as a structured flow (a support message to the team instead)
- Wholesale requests with file or spreadsheet upload; wholesale bank-transfer instructions in the app (card payment only)
- Self-service cancelling of an account deletion (contact the store)
- Embedded rider map (the order screen shows the rider's last location time and opens it in the phone's Maps app; an in-app map needs a Google Maps API key and a native build)
- Reconciliation job and gateway refund API; gateway registry for the extra gateways above
- Biometric lock, deep links from email, offline order queue (the app shows clear offline messages and keeps the cart on the phone)

## Decisions (confirmed by the owner, 2026-11-22)
- Account deletion waiting period: 14 days.
- Version 1 payment methods: Paystack and pay on delivery only. Stripe is hidden in the app (`ENABLED_METHODS` in `mobile/src/lib/checkout.ts`) until it has been tested from the app with Stripe test keys.
- Bundle identifier / Android package: `com.veltomart.app` (cannot be changed after the first store upload).
