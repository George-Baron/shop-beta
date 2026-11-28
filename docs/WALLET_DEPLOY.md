# VELTO wallet, rewards, card and mobile API: deployment, rollback, monitoring, support

Branch: `feature/velto-wallet-phase1`. Migrations 030 to 037 are added; nothing existing is changed or deleted. Existing Paystack and Stripe checkout, retail/wholesale separation and staff/rider/supplier features are untouched (all existing test suites pass).

## 1. Release order (never straight to production)
1. **Development:** `npm ci`, a local Postgres, run the tests below.
2. **Staging:** a separate database and separate Paystack **test** keys. Deploy the branch, run `npm run migrate`, then walk the checklist in section 4 with test money.
3. **Production:** only after staging sign-off. Take a backup first (`npm run backup`, or Admin > Backups). Deploy, migrations run automatically on start. Leave every new programme in its safe default and switch on one at a time:
   - Wallet: `settings.wallet_enabled` = 1 (default 1 once deployed; set 0 to hide top-ups) and the min/max/balance limits.
   - Rewards: `loyalty_enabled` = 1 (default). Points only start counting for orders delivered after the migration ran.
   - Points at checkout / to wallet: `loyalty_max_discount_pct` (30), `loyalty_wallet_redeem` (0).
   - Card: **stays off** (`card_enabled` = 0, no `CARD_PROVIDER`).
4. Watch the first days with section 5.

## 2. Tests that must pass before every release
`npm test`, `test:checkout`, `test:security`, `test:security-review`, `test:wholesale`, `test:roles`, `test:riders`, `test:ops`, `test:stateless`, `test:multi`, plus the new `test:wallet` (41), `test:loyalty` (34), `test:cards` (20), `test:mobile` (16), `test:restore-wallet` (6). All pass at the time of writing, against a local fake Paystack. **They do not replace a staging run against real Paystack test keys.**

## 3. Configuration
No new required variables. Optional: `CARD_PROVIDER`, `CARD_WEBHOOK_SECRET` (card issuer, section 7), `MOBILE_ACCESS_SECONDS`, `MOBILE_REFRESH_DAYS`. Existing `PAYSTACK_SECRET_KEY`, `DATABASE_URL`, `ALERT_EMAIL`/`ALERT_WEBHOOK_URL` are used as before. Do not change production payment configuration as part of this release. The Paystack webhook URL stays the same (`/api/paystack/webhook`); wallet top-up references start with `WF-` and are handled by the same webhook.

## 4. Staging checklist (real Paystack test mode)
1. Register a new customer: wallet (N0) and rewards (Bronze, referral code) exist. 2. Top up N1,000 with a Paystack test card: wallet credited once; repeat the webhook from the Paystack dashboard: still once. 3. A declined test card credits nothing. 4. Pay an order fully from the wallet; then one split (wallet + card); then cancel an unpaid split order: money returns to spendable. 5. Deliver an order (rider flow or admin handover): points appear within 5 minutes. 6. Refund the order: wallet share returns, points reversed. 7. Use points at checkout; cancel; points return. 8. Run `GET /api/admin/wallet/reconcile`: `ok: true`. 9. Existing Paystack-only and Stripe checkout, a wholesale quote and a pay-on-delivery order still work. 10. Try the same wallet/rewards/card URLs while signed out and as another customer: all refused.

## 5. Monitoring and alerting
- **Daily automatic reconciliation** (`cron.walletReconcile`): if any balance differs from the ledger, an error is raised and the existing alert (email/webhook) fires. If it fires: set `wallet_enabled` = 0, run `GET /api/admin/wallet/reconcile` to see which accounts, and do not "fix" anything by editing rows (the ledger is protected). Correct with a documented adjustment.
- Watch in Admin > Jobs & errors: Paystack verify failures, `cron.loyalty` errors, card webhook 401s.
- Daily by a person: `GET /api/admin/finance/wallet`, `/gateways` (success rates), `/api/admin/wallet/suspicious`, and compare yesterday's `WF-` successes with the Paystack dashboard.
- Money in the ledger is also in the nightly backups (the ledgers restore exactly; sign-in tokens are intentionally not backed up).

## 6. Rollback
- **Switch off without a code change (fast, no data lost):** `wallet_enabled` = 0 stops top-ups; `loyalty_enabled` = 0 stops earning and redeeming; `card_enabled` = 0 hides the card. Existing balances and points stay in place and customers can still use balances already in their wallet at checkout unless you also remove the code.
- **Code rollback:** redeploy the previous version. The migrations are additive, so the old code runs fine on the new database (it simply ignores the new tables and the two new `orders` columns). **Do not drop the wallet, ledger, points or card tables**: they may hold customer money and points. If the wallet code is rolled back while customers hold balances, tell them their balance is safe and will be available again after the fix.
- **Data rollback** is a restore from backup into a new empty database (`docs/RESTORE.md`), which loses everything after the backup. Prefer correcting with ledger adjustments.

## 7. External accounts, credentials, approvals and subscriptions
| Needed | For | Status |
|---|---|---|
| Paystack live keys (already in use) and a test-mode account for staging | wallet top-ups, split payments | existing |
| Staging environment and separate database | safe testing | to create |
| Card issuing partner contract, sandbox and live credentials, webhook secret (see `docs/CARDS.md`) | VELTO-MART CARD | **not started, needs your decision** |
| Card network and issuer approval of the card design; production card order | physical card | not started |
| Approved card terms, privacy notice and consent wording; legal review of Nigerian rules (CBN, NDPR/NDPC, consumer protection) for a prepaid/closed-loop wallet and for BVN/NIN handling | wallet and card launch | **needs a lawyer** |
| Push notification service accounts (Firebase Cloud Messaging; Apple APNs key) | mobile push | not built yet |
| Apple Developer and Google Play accounts; the apps themselves | Android and iOS apps | apps not in this repository |
| Flutterwave, Monnify, Interswitch accounts and confirmation that their APIs support wallet funding | extra funding gateways | not built |
| Alert email or webhook (`ALERT_EMAIL` / `ALERT_WEBHOOK_URL`) | reconciliation alerts | configure |

## 8. Features awaiting a third party or approval
VELTO-MART CARD issuing (issuer + legal), physical card production (network approval), push notifications (FCM/APNs), the Android and iOS screens (apps), Interswitch/Flutterwave/Monnify wallet funding (not integrated: a closed-loop wallet funded by Paystack only today), withdrawals and transfers (deliberately not built: need separate legal approval), points expiry and reminders (not built yet), birthday rewards (needs a date-of-birth field), website and admin screens for these programmes (APIs are ready).

## 9. Customer support guide
- **"I paid but my wallet is empty":** find the top-up in `GET /api/admin/wallet/funding` by email. `success` = credited (look in transactions); `initiated` = Paystack has not confirmed (ask them to wait 10 minutes, then check the Paystack dashboard and ask Paystack); `mismatch` = amount or currency differed, nothing was credited: refund through Paystack; `failed` = payment declined.
- **"My wallet is frozen":** reason is on the wallet record. Only unfreeze after the reason is cleared (`/api/admin/wallet/customers/:id/unfreeze`).
- **Refunds:** an order paid partly from the wallet gets that part back into the wallet automatically when marked Refunded; the card part is refunded in Paystack by hand.
- **Missing points:** points are given when the order is delivered and paid, usually within 5 minutes. Check the order status. If it is delivered and paid but there are no points after an hour, tell the developer (check the `cron.loyalty` errors); do not add points by hand without a reference.
- **Corrections:** wallet and points can only be corrected with an adjustment that needs a reason and a reference. Entries are never edited or deleted.
- **Card questions:** application status and the issuer's message are shown to the customer. Blocking a lost card: customer self-service, or staff via `/api/admin/cards/:id/block`. Never ask a customer for a full card number or CVV; staff cannot see them.
- **Apps:** a customer who changes their password is signed out of the apps and must sign in again. They can remove a lost phone under their devices.
