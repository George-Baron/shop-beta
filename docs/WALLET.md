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

## Not built yet (rest of phase 1)
Wallet payment at checkout (full/partial, reservations), refunds to wallet, low-balance/suspicious-activity alerts, finer staff permissions (admin-only for now), Interswitch/Flutterwave/Monnify funding (each must be confirmed and tested first), website and app screens (the repo has no mobile app code, and mobile token auth does not exist yet: the API uses the existing cookie session).

Run: `npm run test:wallet`.
