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

## Referrals
Each customer has a code and link (`/?ref=CODE`). Sign-up with `referralCode` records the referral (a bad or own code is silently ignored; sign-up never fails because of a code). A friend can only ever be referred once.
- **Reward:** when the friend's first **delivered and paid** order has net goods value of at least `referral_min_order` (N5,000), the referrer gets `referral_reward_points` (500) and the friend `referral_welcome_points` (200), once (unique keys `referral:<id>:referrer|welcome`).
- **Anti-abuse:** sign-up with a phone number already used by another account is marked rejected; an order delivered to the referrer's own phone is rejected; a referrer is capped at `referral_monthly_cap` (20) rewards per 30 days; admin can reject a waiting referral with a reason. Customers see friends only as initial + `***`.
- API: GET `/api/loyalty/referrals`; admin GET `/api/admin/loyalty/referrals?status=`, POST `/referrals/:id/reject {reason}`.

## Campaigns
Admin-managed at `/api/admin/loyalty/campaigns` (GET, POST, PUT `/:id`; `active:false` switches one off). Fields: `name`, `kind` (`multiplier` or `first_purchase`), `multiplier_pct` (200 = double), `bonus_points`, `starts`/`ends` (epoch seconds), `weekdays` (e.g. `0,6` weekends, Lagos time), `min_tier`, `category_id` (limits the extra points to that category's lines).
- The best multiplier applies (campaigns never stack on each other); the extra is on top of the tier rate. A first-purchase bonus is paid on the customer's first earning order. The order's ledger note names the campaign.
- Customers see the campaigns that apply to them in `offers` on GET `/api/loyalty`.

## Points at checkout (phase 4 part)
`POST /api/checkout` accepts `usePoints: <points>` from a signed-in customer (explicit choice = confirmation). Order of events: order placed -> points applied -> wallet applied -> gateway asked for what is left.
- Rules: Naira orders only; at least `loyalty_min_redeem`, in steps of `loyalty_redeem_points`; server checks the balance; discount = points/`loyalty_redeem_points` x `loyalty_redeem_value` (1,000 points = N100 by default); capped at `loyalty_max_discount_pct` (30) of net goods value (0 switches points-at-checkout off). The discount lowers `orders.total` and adds to `orders.discount` (`points_used`, `points_discount` are recorded), so points later earned are based on what was actually paid.
- A bad request (wrong step, too many points, over the cap, not signed in) cancels the order, returns stock and spends nothing.
- Points come back once if the order is cancelled unpaid or refunded (ledger row `pts-return:<ref>`).
- `POST /api/wallet/preview` takes the same cart plus optional `usePoints` and returns the whole breakdown before confirming: subtotal, product_discount, delivery_fee, loyalty_discount, points_used, order_total, wallet_contribution, remaining_payment. Display only.
- Tier discounts (`loyalty_tiers.discount_pct`) are stored but not applied automatically, because rewards must not be applied without the customer seeing and confirming them.

## Payment preferences
GET/PUT `/api/wallet/preferences` `{default_method: ''|wallet|paystack|card|pod, preselect_wallet, preselect_points, promo_notifications}`. They only pre-select choices on the checkout screen; amounts are still shown and confirmed each time.

## Not built yet
Points expiry and reminders, birthday rewards (needs a date-of-birth field), product-level eligibility lists, tier downgrade review, tier discounts at checkout, promotional notifications honouring `promo_notifications` (no promotional messages are sent yet), and the screens. Run: `npm run test:loyalty`.

## Points expiry

Off by default. An administrator sets "Points expire after (months)" on the Wallet & rewards page (`loyalty_expiry_months`, 0 to 60; 0 means points never expire).

- First in, first out: points earned before the cutoff expire once everything already spent, reversed or expired is set against the oldest points first.
- An `expire` row is written to the points ledger (never an edit), once per customer per day, then the customer is notified.
- A reminder goes out once when points will expire within 30 days (at most one every 25 days per customer).
- Points handed back (for example when an unpaid order is cancelled) count as new points from that day.
- Runs in the existing 5-minute loyalty job and when a customer opens their rewards. Tell customers (and update the terms) before switching it on: expiry only takes effect from the day it is set, and it applies to points already earned.
