# Financial reports and reconciliation (administrators only)

Base: `/api/admin/finance` (also under `/api/mobile/v1/admin/finance`). Optional `?from=&to=` (epoch seconds). Admin role required.

## Accounting treatment
- **Wallet funding is not sales.** A top-up is money held for the customer: a liability. Sales are recognised on the order. The wallet part of an order is that liability being spent, not a second sale.
- **Points outstanding** are a liability, valued at the redemption rate (1,000 points = N100 by default). **Points used at checkout** are a discount, a cost of the programme.
- Wallet and card balances are kept apart. Card money is held by the issuer.
- The wallet ledger is double-entry: every transaction has two entries that sum to zero, entries cannot be changed, and the sum of all accounts is zero.

## Reports
| GET | What it shows |
|---|---|
| `/summary` | everything below in one call |
| `/wallet` | total wallet balances (liability), amount held for unpaid orders, wallets / with balance / frozen, funding, spending, refunds to wallet, points converted to wallet credit, adjustments, and reconciliation status |
| `/sales` | sales recognised, split into paid from wallet, by gateway/card, and on delivery; discount given with points. Top-ups never appear here |
| `/rewards` | members, points outstanding, redeemed, liability value, tier mix, points earned/reversed/bonus in the period, checkout discounts, campaign performance (orders and extra points per campaign), referral counts and points |
| `/gateways` | success rates for wallet top-ups and for order payments, per gateway |
| `/wallet-transactions.csv` | every wallet transaction in the period for the accountants (text cells are quoted so a spreadsheet never runs them as formulas) |
Card statistics (applications, cards, transactions) are in `/summary` under `cards` and at `/api/admin/cards/report`.

## Reconciliation
`GET /api/admin/wallet/reconcile`: (1) each account's cached balance equals the sum of its ledger entries, (2) every transaction's entries sum to zero, (3) total wallet liability. `ok: false` lists the accounts or transactions that differ. **Run it daily; alert on `ok:false`** (see DEPLOY notes to come). It also matches the identity: funding + refunds + rewards + credit adjustments - spending - debit adjustments = wallet liability.
Gateway-side: compare the day's successful `WF-` references and amounts in the Paystack dashboard with `GET /api/admin/wallet/funding?status=success`; anything in `mismatch` was refused automatically.

## Review tools
`GET /api/admin/wallet/funding?status=` list of top-ups. `GET /api/admin/wallet/suspicious`: repeated failed top-ups (5+ in 24h), amount mismatches, large deposits (setting `wallet_alert_amount`, default N500,000), very busy wallets (20+ transactions in 24h) and reservations held more than a day. These are flags for a person to look at; nothing is blocked automatically. Freeze a wallet at `/api/admin/wallet/customers/:id/freeze`.

Run: `npm run test:wallet` (includes the report checks).
