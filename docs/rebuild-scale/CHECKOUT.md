# Checkout and order rules

## Order states
`pending`, `paid`, `confirmed`, `dispatched`, `delivered`, `cancelled`, `refunded`. The database refuses any other value.

```
Online (Paystack):   pending -> paid -> confirmed -> dispatched -> delivered
Pay on delivery:     pending -> (staff phone the customer) confirmed -> dispatched -> delivered
Any time before delivery:   -> cancelled          After money was taken:   -> refunded
```
- **paid** is set only when Paystack itself confirms the payment (or staff record one Paystack could not, for example a transfer checked by hand).
- **Pay on delivery needs a phone call first.** The order page for staff shows "Phone confirmation needed". Staff press *Confirm by phone* and must write who they spoke to and what was agreed (3+ characters). That records the time and the staff member, moves the order to `confirmed`, and emails the customer. Until then the order cannot be confirmed or dispatched, and two staff pressing at once cannot both succeed. Nothing cancels an unconfirmed order automatically; unreachable customers are cancelled by staff.
- Online orders cannot be dispatched or delivered until paid. Steps cannot be skipped (paid to dispatched is refused).
- Delivered pay-on-delivery orders are recorded as paid (cash collected).
- Every status change is "compare and set": if someone else changed the order a moment ago, you get "changed by someone else, reload", never a silent overwrite.
- **Cancel** returns the stock and the coupon use once. If the order had been paid, the history says to refund the customer and then mark it Refunded.
- **Refunded** records that the money went back (do the real refund in the Paystack dashboard or by bank first; the shop cannot send money). Before dispatch, stock is returned; after dispatch or delivery it is **not** (goods may not have come back): adjust stock by hand if they did.
- Dashboard "sales" exclude cancelled and refunded orders.

## Double taps and retries (idempotency)
The checkout page makes one random key per "Place order" tap (same cart and details = same key) and sends it as `Idempotency-Key`. The server saves the key with the order in the same transaction:
- a second request with the same key (double tap, retry after a dropped connection, even at the same instant on two instances) waits for the first and gets **the same order back**; stock is taken once, one confirmation email is sent, and one Paystack payment is started;
- the same key with a different cart or different customer is refused (422);
- a request that fails (sold out, validation) leaves no key behind, so retrying works; if the shopper's connection drops with no answer, the page keeps the key so a retry cannot create a second order;
- no key (an old page, a script) behaves as before: each request is its own order.
Keys are deleted after 7 days.

## Stock
Reserved in the same database transaction that creates the order, with `UPDATE ... WHERE stock >= qty` (no overselling, tested with 10 shoppers racing for 3 units). The cache never decides stock.

## Paystack payment checks
An order is marked paid only when **all** are true: the webhook signature (HMAC-SHA512 of the exact bytes received, constant-time compare) is valid; Paystack's own verify call for that reference says `success`; the reference returned is the order's reference; the currency is NGN; and the amount equals the order total to the kobo. Otherwise the order stays unpaid and a note explaining why is added to its history once (not on every retry). The webhook itself only queues the check (see JOBS.md), so it always answers Paystack quickly.

## Before running on live data
Migration `007_order_states_idempotency.sql` renames existing statuses (`processing` becomes `confirmed`, `shipped` becomes `dispatched`) and adds columns and checks. It has only been run on test databases. Run it on staging first; do not run it against the live site without asking.

## Tests
`npm test` (idempotency including 6 simultaneous taps, key misuse, retry after sold out, POD phone gating and simultaneous confirmations, online flow, two staff acting at once, refund and stock rules, database refusing an invalid status) and `npm run test:queue` (Paystack: one payment for 5 simultaneous taps, tampered or wrongly cased signature, wrong amount, wrong currency, different reference).

## Not verified
Real Paystack (live or test mode) was not called. The fake Paystack in the tests follows the documented initialize/verify calls. To verify: use a test-mode key, place an online order, pay with a Paystack test card, and confirm the order becomes paid and the email arrives; then press Pay twice quickly on a slow connection and confirm only one order exists.
