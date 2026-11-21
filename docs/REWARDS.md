# VELTO REWARDS (phase 2, part 1)

Every customer is enrolled automatically (existing customers by migration, new ones at sign-up) as Bronze with a referral code.

## Rules
- **Earning:** an order earns points only when it is **delivered and paid**. Base = subtotal minus discounts (delivery excluded unless `loyalty_include_delivery`=1). Points = floor(base x `loyalty_points_per_1000` / 1000) x the tier multiplier. Only orders delivered after `loyalty_start` (set when the migration ran) earn, so old orders are never back-paid.
- **How it is applied:** a background sweep (`cron.loyalty`, every 5 minutes, also run for a customer when they open their rewards) awards delivered orders and reverses refunded ones. It does not depend on which screen or rider flow delivered the order.
- **No double awards:** one ledger row per order (`earn:<ref>`) enforced by a unique key; reversal likewise (`reverse:<ref>`). A refund takes back what the order earned, limited to the points still available (the note records any already spent); lifetime points are reduced in full.
- **Ledger:** `loyalty_ledger` is immutable (no update, delete or truncate). Balances cannot go negative.
- **Tiers:** Bronze 0, Silver 5,000, Gold 20,000, Platinum 50,000 lifetime points, with multipliers 1.0/1.1/1.25/1.5. All editable.
- **Redemption (to wallet credit):** off by default (`loyalty_wallet_redeem`). 1,000 points = N100 (`loyalty_redeem_points`, `loyalty_redeem_value`), minimum `loyalty_min_redeem`, in steps of the redeem unit. Points debit and wallet credit happen in one transaction; the same `Idempotency-Key` redeems once.

## API (`/api/loyalty`, also `/api/mobile/v1/loyalty`)
GET `/` overview (points, lifetime, tier, next tier and points needed, pending, redemption terms, referral code, tier table) · GET `/history?before=&limit=` · POST `/redeem {points}` (header `Idempotency-Key`).
Admin (`/api/admin/loyalty`, admin only): GET/PUT `/config`, PUT `/tiers/:name`, GET `/report` (members, points outstanding, redeemed, liability value, tier mix), POST `/sweep`, GET `/customers/:id`, POST `/customers/:id/adjust {points,reason,reference}`.

## Not built yet
Points expiry and reminders, checkout discounts from points (phase 4), referral programme, campaigns (double points, birthday, first purchase), product/category eligibility, tier downgrade review, loyalty notifications preferences, and the screens. Run: `npm run test:loyalty`.
