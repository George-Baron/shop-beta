# VELTO WALLET (phase 1)

Closed-loop shopping wallet. No transfers, no cash withdrawals. Amounts are kobo in the database; the API speaks Naira.

## Money rules
- Balances change only through `lib/wallet.js post()`: one DB transaction, two balanced ledger entries (customer wallet vs a system account), a unique `idem_key` per event.
- `ledger_entries` are immutable (triggers block UPDATE/DELETE/TRUNCATE); `wallet_txns` money fields are immutable; a customer wallet can never go below zero (CHECK constraint).
- Top-ups: `POST /fund` records an attempt (`WF-…` ref) and starts a Paystack payment. The wallet is credited only after the worker/return-visit asks Paystack and reference, currency and amount all match. The idempotency key is the funding ref, so webhook retries and parallel verifies credit once.
- Wallet funding is a liability (`gateway_clearing` side), never sales revenue.
- `reconcile()` checks cached balance = ledger sum, every txn sums to zero, and reports total wallet liability.

## API (same handlers at `/api/wallet` and `/api/mobile/v1/wallet`)
| Method & path | Who | Notes |
|---|---|---|
| GET `/` | customer | balances, totals, limits, 5 recent |
| GET `/transactions?type=deposits\|purchases\|refunds\|rewards\|adjustments&before=&limit=` | customer | own only |
| GET `/statement.csv?from=&to=` | customer | download |
| POST `/fund` `{amount}` | customer | 400 outside limits, 403 frozen, 503 gateway off |
| GET `/fund/:ref` | customer | owner-only (404 otherwise); verifies with gateway |
| GET `/api/admin/wallet/reconcile` | admin | |
| GET `/api/admin/wallet/customers/:id` | admin | wallet, txns, audit |
| POST `…/freeze` `{reason}`, `…/unfreeze` | admin | audited |
| POST `…/adjust` `{direction,amount,reason,reference}` | admin | posted as a ledger entry; same reference twice applies once |

Settings (table `settings`): `wallet_enabled`, `wallet_min_fund`, `wallet_max_fund`, `wallet_max_balance`.

## Paying with the wallet at checkout
`POST /api/checkout` (the existing endpoint) accepts `payment: "wallet"` or `useWallet: true`, for signed-in customers with Naira orders paid through Paystack. The customer's choice is the confirmation; the amounts are always worked out on the server from the stored order.
- Wallet covers the whole order: the wallet is debited and the order is paid at once (`next: "wallet"`).
- Wallet covers part: that amount is held (`pending`), the order's gateway amount is reduced to the remainder, and Paystack is asked for only that (`next: "paystack"`, plus `wallet_amount` and `remaining`). When the gateway part is verified the hold becomes one purchase debit; if the order is cancelled or expires unpaid the hold is released. At least ₦50 is always left for the gateway.
- Not enough balance, frozen wallet, or a non-Naira / Stripe order: the order is cancelled, stock returned, and an error is returned.
- `POST /api/wallet/preview` (same cart body as checkout) shows the wallet share and the remainder before confirming; display only.
- Refund: marking an order Refunded returns the wallet share to the wallet once (idempotent). The Paystack share is still refunded by hand to the card.

## Not built yet
Wallet notifications for low balance and suspicious activity, finer staff permissions (admin-only for now), Interswitch/Flutterwave/Monnify funding (each must be confirmed and tested first), mobile token sign-in (the API uses the existing cookie session), and the website/app screens. The repo contains no Android or iOS code; the API is ready for the apps to use when they go live.

Run: `npm run test:wallet`.

## Switching the wallet on or off
Admin > **Wallet & rewards** > **Switches and limits**: wallet top-ups on/off, smallest and largest top-up, largest balance, and the VELTO-MART CARD switch (it can only be turned on once a card issuer is connected). Off stops new top-ups only; customers can still spend their balance and refunds still return to the wallet. Rewards have their own switch lower on the same page.

## Second top-up provider: Flutterwave

Customers can add money with Paystack or Flutterwave once both are set up (the choice only appears when Flutterwave is configured).

Set on Render: `FLUTTERWAVE_SECRET_KEY` (Flutterwave dashboard > Settings > API) and `FLUTTERWAVE_WEBHOOK_HASH` (any long random text you also paste into Settings > Webhooks > "Secret hash"). Webhook URL: `https://YOUR-SHOP/api/flutterwave/webhook`.

How it stays safe: the wallet is credited only after our server asks Flutterwave (`verify_by_reference`) and the reference, NGN currency and amount match; the webhook only says "look at this reference". Repeats, retries and the customer's own return credit once (same idempotency key as Paystack). Used for top-ups only, not for orders or refunds.

**Status: tested against a stand-in for Flutterwave, not the live service.** Before announcing it, make a real ₦100 top-up with Flutterwave and check the wallet is credited once and the books-balanced check is green.

## Staff access to the wallet pages

Employees get a new area, **Wallet & rewards**, in Employees & roles (role or custom permissions). New roles are not created for you; add the area to a role as needed (for example support or finance staff).

| Who | Can do |
|---|---|
| Owner | Everything |
| **Edit** on Wallet & rewards | Look at everything below, plus freeze or unfreeze a wallet, block a card, reject a referral |
| **View** on Wallet & rewards | See the books check, money summary, a customer's wallet, rewards report, top-up list, suspicious items, card applications, wallet transactions CSV |
| **View** on Finance | The money reports only (summary, wallet, sales, rewards, gateways, transactions CSV), not the wallet pages |
| Owner only, always | Balance adjustments (money or points), wallet/rewards/card switches and limits, tiers, campaigns, points-expiry run |

Every freeze, unfreeze and block is recorded with the staff member's name in the staff-actions log. Changing a person's permissions signs them out at once. Their menu shows Wallet & rewards and VELTO-MART CARD only when their role includes the area, and the owner-only controls are hidden for them.

## Monthly PDF statement
Account > Wallet > Transactions: pick a month and press **PDF** (`GET /api/wallet/statement.pdf?month=YYYY-MM`). It shows opening balance, money in and out, every entry with its running balance, and the closing balance, for the calendar month in West Africa Time. Only the signed-in customer's own entries are included. The CSV statement is still there for any date range.
