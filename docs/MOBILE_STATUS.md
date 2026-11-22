# VELTO-MART mobile: what is done and what is not

Updated 2026-11-22. "Tested" means automated tests that ran in a development environment with a stand-in for Paystack and Expo. **No feature has been tested on a real phone, against live Paystack/Stripe, or in a store yet.**

## Built and tested (server)
Mobile sign-in (short-lived tokens, rotating refresh, revocation, device list, 10-device limit, customers only); profile; account deletion with waiting period; catalogue, search, product pages; cart pricing; delivery quote; idempotent checkout (pay on delivery, Paystack, Stripe path); order list, detail, cancel, resume payment, server-side payment verification; addresses; wishlist; in-app notifications; push notifications and preferences; support messages; wholesale (apply, price list from the separate wholesale warehouse, quotations, accept, pay, requests for quotation). About 70 automated tests across `test:mobile-auth`, `-shop`, `-wholesale` and `-push`.

## Built (app) and checked
All screens listed in `mobile/README.md`. Checks that passed: TypeScript, 22 unit tests, the Android and iOS JavaScript bundles build, and the app's API client passes a 5-step contract test against a real local server. **Not done:** running the screens on a device or simulator, visual QA, accessibility audit with a screen reader, performance profiling on low-end phones.

## Payments
| Method | Status |
| --- | --- |
| Pay on delivery | Built and tested end to end (server) |
| Paystack | Built; verified in tests with a stand-in gateway. **Not yet tried with the live Paystack account from the app** |
| Stripe | The shared checkout supports it (same as the website) but there is **no mobile-specific test** and it has not been exercised from the app. Treat as unverified until tested with Stripe test keys |
| Interswitch, Flutterwave, Monnify | **Not built. Not active. Must not be advertised.** Needs: their merchant accounts and keys, server integration, webhook/verification and refund handling, end-to-end tests |

## Not built yet
- Real device testing, store builds, store submission, store screenshots (need Expo/Apple/Google accounts)
- Photo attachments (the image picker is not installed; support is text only)
- Rider live map (the order screen says the rider is on the way; no map)
- In-app support history/reply thread (replies come by email)
- Product reviews written from the app; returns as a structured flow (a support message to the team instead)
- Wholesale requests with file or spreadsheet upload; wholesale bank-transfer instructions in the app (card payment only)
- Self-service cancelling of an account deletion (contact the store)
- Saved-address management screen (addresses can be picked at checkout; managing them is on the website)
- Reconciliation job and gateway refund API; gateway registry for the extra gateways above
- Biometric lock, deep links from email, offline order queue (the app shows clear offline messages and keeps the cart on the phone)

## Needs your decision
- Account-deletion waiting period (currently 14 days; stated in the app text)
- Which payment methods to show in version 1 (recommended: Paystack and pay on delivery; add Stripe after a test)
- Bundle identifier (`com.veltomart.app` suggested)
