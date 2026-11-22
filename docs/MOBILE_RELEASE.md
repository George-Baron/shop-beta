# VELTO-MART mobile: setup, release and rollback

Status of everything below: the **app code, API and tests exist**. Nothing has been built with EAS, submitted to a store, or tested on a real phone yet, because the accounts in section 1 do not exist yet. Do not announce the app until section 7 is ticked.

## 1. Accounts you need (none exist yet)
| Account | Needed for | Cost / notes |
| --- | --- | --- |
| **Expo (expo.dev)** | EAS Build, EAS Submit, EAS Update, push notification service | Free plan works for a start (queued builds). Create an organisation, then run `eas init` inside `mobile/` to get the project id |
| **Apple Developer Program** | iOS builds, TestFlight, App Store, Apple push key | US$99 per year. Needs an Apple ID with two-factor sign-in. Business enrolment needs a D-U-N-S number and can take days or weeks |
| **Google Play Console** | Android release, Play listing | One-time US$25. New personal accounts must run a closed test (12 testers for 14 days) before production; business accounts are verified instead |
| **Firebase project (free)** | Android push (FCM v1) | Upload its service-account key to Expo (`eas credentials`). Needed only for Android push |
| Paystack, Stripe, Resend, Supabase | Already used by the website | No new account. The app reuses them through the server |

## 2. Server side (do this first, on STAGING)
1. Merge the pull request to a staging branch/copy of the server. Migrations `030_mobile_sessions.sql` and `031_push.sql` run on start and only **add** tables; no existing table is changed or dropped.
2. Back up the production database before the first production deploy (`docs/RESTORE.md`).
3. Server settings (Render environment). Nothing new is required. Optional: `EXPO_ACCESS_TOKEN` (only if "enhanced push security" is turned on in Expo), `ACCOUNT_DELETE_WAIT_DAYS` (default 14), `EXPO_PUSH_URL` (leave unset).
4. Run `npm run test:mobile-auth test:mobile-shop test:mobile-wholesale test:mobile-push` against the staging build. Then check the app against it (section 5).
5. The reset-password email opens the **website's** page, so `BASE_URL` must be the public https address.

## 3. App configuration
`mobile/app.config.ts` + `mobile/eas.json`. Only two values change per environment, and neither is secret:
- `APP_ENV` = `development` | `staging` | `production`
- `EXPO_PUBLIC_API_URL` = server address (production builds refuse to build unless it is `https://…`)

Replace the two `REPLACE-WITH-…` addresses in `eas.json`. Identifiers (change before the first store upload; they cannot be changed afterwards):
- Android package / iOS bundle id: **`com.veltomart.app`** (staging `.staging`, development `.dev`). Pick your own reverse-domain id if you prefer.
- Display name **VELTO-MART**, URL scheme `veltomart`.

## 4. Build and submit
```bash
cd mobile
npm install -g eas-cli && eas login
eas init                                   # writes the project id; also set EAS_PROJECT_ID for push tokens
eas credentials                            # Android keystore (EAS can create it), iOS certificates, FCM key, APNs key
eas build --profile staging --platform all # internal test builds (APK for Android; TestFlight-style for iOS)
eas build --profile production --platform all
eas submit --profile production --platform android   # needs the Play service-account JSON in mobile/secrets/ (git-ignored)
eas submit --profile production --platform ios       # needs the App Store Connect app record first
```
Store listing text, Data Safety and App Privacy answers are in `MOBILE_STORE_LISTING.md`.

## 5. Checking the app against a server
Use a **test** server and database, never production:
```bash
CONTRACT_API_URL=https://your-staging-server npm run test:contract   # inside mobile/
```
It registers a throwaway customer, places and cancels a pay-on-delivery order, and tests support, push-token and device calls with the app's real API client.

## 6. Manual test script on real phones (before any store submission)
Sign up, sign in, sign out; wrong password; forgot password email; browse and search; variants and sold-out items; cart quantity limits; checkout with pay on delivery; checkout with Paystack **test** card (pay, cancel the page, pay again); close the app during payment and reopen; place the same order twice quickly (one order only); orders list and tracking; cancel; delivery code; push on order status (iOS and Android), tap a push to open the order; turn categories off; sign out on one phone and confirm the other still works; remove a device; support message reaches Admin > Messages; delete account (blocked with an open order, works without); wholesale apply, approval in the admin, price list, quote, accept, pay (test), and that a normal customer sees no wholesale prices; airplane mode on each screen; large text and screen reader on checkout; small phone and tablet-size screens.

## 7. Go-live checklist
- [ ] Pull request reviewed and merged; staging deploy tested; production database backed up; production deploy done and `/api/mobile/v1/config` answers
- [ ] Website privacy policy updated for the app (see `MOBILE_STORE_LISTING.md`, "Privacy policy changes needed") and the page is public
- [ ] Account deletion page for Google Play published (Google requires a web link where a customer can ask for deletion; the website needs one, see listing doc)
- [ ] Section 6 completed on at least one iPhone and one Android phone, including a **live** Paystack payment of a small real order and its refund
- [ ] Real-device push confirmed on both platforms
- [ ] Reviewer test account created for Apple/Google (customer account with an order) and its details put in the review notes
- [ ] Store screenshots and listing text final

## 8. Rollback
- **Server:** the mobile API is additive and versioned. To switch the app off without touching the website, redeploy the previous server version (the new tables are harmless to the old code). Sessions are rows in `mobile_sessions`: `UPDATE mobile_sessions SET revoked_at=<now>, revoke_reason='admin' WHERE revoked_at IS NULL` signs every phone out.
- **App JavaScript fixes:** `eas update --channel production` ships a fix without a store review (same `runtimeVersion`); roll back with `eas update:republish` of the previous update.
- **Bad native build:** halt the rollout in Play Console (staged rollout recommended: 10%, then 50%, then 100%) or remove the build from sale in App Store Connect, then submit the previous version as a new build.
- **Push problems:** set a customer's category switches off or delete rows in `push_tokens`; the in-app notification list is unaffected.

## 9. Known gaps (be honest in the listing and with customers)
See `MOBILE_STATUS.md`.
