# Trying the mobile API safely: staging first, production second

**Read this before merging pull request #28.** The Render blueprint has `autoDeploy: true`, so merging to the branch your live service watches deploys to production by itself. Do the staging steps first, or switch auto-deploy off on the live service until you are ready (Render > shop-beta > Settings > Build & Deploy > Auto-Deploy: Off).

What changes on the server: two new files in `migrations/` (they only **add** tables: `mobile_sessions`, `account_deletions`, `push_tokens`, `push_prefs`, `push_deliveries`), a new `/api/mobile/v1` route set, a small behaviour-neutral change to checkout code shared with the website, and background jobs (account-deletion clean-up, push sending). The website pages and endpoints are unchanged. Migrations run automatically when the server starts and are safe to run twice.

## A. Make a staging copy (about 30 to 45 minutes)
Never point staging at the live database or the live Paystack key.
1. **Supabase:** create a second project (free plan is fine), e.g. `velto-staging`, same region as the live one. Copy its **Transaction pooler** connection string (port 6543), the project URL and its service-role key (DEPLOY.md, Part 1). Create the storage bucket the same way as for live.
2. **Render:** New > Web Service > same GitHub repo `George-Baron/shop-beta`, **branch `feature/mobile-api`**, name `shop-beta-staging`, same region as the Supabase staging project. Build `npm ci --omit=dev`, start `npm start`, health check `/health`, **Auto-Deploy: on for that branch only**.
3. **Environment variables** (same names as live; the values differ):
   | Name | Staging value |
   | --- | --- |
   | `NODE_ENV` | `production` (so staging behaves like live) |
   | `BASE_URL` | the staging address Render gives you, e.g. `https://shop-beta-staging.onrender.com` |
   | `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | the **staging** Supabase values |
   | `PAYSTACK_SECRET_KEY` | your Paystack **test** key (`sk_test_…`) |
   | `RESEND_API_KEY` | leave empty: emails are stored in Admin > Marketing > Email outbox instead of being sent to real people |
   | `SEED_DEMO` | `1` (demo products, so there is something to browse) |
   | `ADMIN_EMAIL`, `ADMIN_PASSWORD` | a staging admin login (12+ characters) |
   | `HANDOVER_SECRET`, `BACKUP_PASSPHRASE` | any new long random values (not the live ones) |
   Do **not** set `EXPO_ACCESS_TOKEN` unless Expo's enhanced push security is on.
4. In Paystack (test mode) set the webhook to `https://<staging address>/api/paystack/webhook` as in DEPLOY.md, Part 3.
5. Open `https://<staging>/health` (should say ok) and `https://<staging>/api/mobile/v1/config` (should return JSON with `stores` and `zones`).

## B. Prove the server on staging
From your computer (Node 22), in the repository:
```bash
git checkout feature/mobile-api && npm ci
# The app's own API client against staging (registers a throwaway customer, places and cancels a pay-on-delivery order):
cd mobile && npm install --legacy-peer-deps
CONTRACT_API_URL=https://<staging address> npm run test:contract
```
If it prints `5 passed`, sign-in, catalogue, checkout, orders, support, push-token and sign-out all work against the real staging server and database. Delete the throwaway customer afterwards if you like (Admin > Customers).

Then do these by hand in the staging admin and a browser:
- [ ] The website homepage, a product page, a normal website checkout with pay on delivery, and a **Paystack test card** checkout still work exactly as before.
- [ ] Admin > Orders shows the contract-test order (cancelled) and the website order.
- [ ] Admin > Messages shows the support message from the contract test (`[App] Delivery - order …`).
- [ ] Make a wholesale customer: register through the contract-style API or the app, apply, approve under Admin > Wholesale, and check the price list shows only wholesale stock.

## C. Try the app against staging
- Quick look, no accounts: `cd mobile`, put `EXPO_PUBLIC_API_URL=https://<staging address>` in `.env.local`, run `npx expo start`, scan the QR code with **Expo Go** on a phone (sign-in, shop, cart, checkout, orders work; push does not in Expo Go).
- Proper test builds need the Expo account: `eas build --profile staging --platform android` gives an installable APK you can send to testers. iOS needs the Apple Developer account first. Put the staging address in `mobile/eas.json` (profile `staging`) before building. Steps and the real-phone checklist: `MOBILE_RELEASE.md`, sections 4 and 6.

## D. Production (only after A to C pass)
1. **Back up the live database** (DEPLOY.md, Part 11 and `docs/RESTORE.md`) and note the current live deploy in Render so you can roll back to it.
2. Merge pull request #28. With auto-deploy on, Render deploys it and runs the two migrations on start. Watch the deploy log for `migrate` lines and no errors, then open `/health`, the live homepage, and `https://<live>/api/mobile/v1/config`.
3. Place one real small order on the website (pay on delivery) to confirm nothing changed for customers.
4. The mobile API now exists but **no app is installed anywhere yet**, so nothing visible changes for customers. The app goes out later through the stores (`MOBILE_RELEASE.md`).
5. If something is wrong: in Render choose the previous deploy and **Rollback**. The new tables are unused by the old code and can stay. To sign out every phone at once see `MOBILE_RELEASE.md`, section 8.

## E. Ongoing
- Keep staging running on the feature branch while the app is being tested; keep its Paystack on test mode.
- Before every app release, run the contract test against staging again, then against production only for read-only calls (never place test orders on live data without telling the team).
