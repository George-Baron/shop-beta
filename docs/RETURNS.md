# Returns and refunds after delivery

**Customer:** once an order is delivered and paid, its page shows "Returns and refunds" with a **Return items** button (signed in, or via the private link in the order email). They pick the items and quantities and answer four short questions: why, what condition, original packaging, and what happened. The window is the shop setting `return_days` (7 by default), counted from delivery. Medicine orders are excluded (they go through the pharmacy team). One return can be open per order; the customer can cancel it until staff review it. They see every step on the order page and get an email and an in-app notice at each one.

**Staff:** a new request puts **"Order X is to be returned"** on the Dashboard, adds a count badge on **Returns** in the menu, and notifies everyone with Orders: Edit. In **Returns**, open a request to see the customer's answers, then **Approve** (amount defaults to what the items were worth after discounts, plus the delivery fee when we got it wrong and the whole order comes back; you can lower it with a short note, never above what is left on the order) or **Decline** (a reason is required and is sent to the customer). Needs Orders: Edit.

**Settlement:** an approved return shows as **Approved, refund awaiting settlement**, and Finance is notified. Someone with Finance: Edit (or the owner) settles it:
- *Original payment*: the part the customer paid from their VELTO wallet goes back to the wallet; the card part is refunded by Paystack on the original transaction (the amount is sent to Paystack and the money reaches the customer's bank in a few days, so "accepted by Paystack" is not "arrived").
- *VELTO wallet*: the whole refund as wallet credit (instant). Use for cash-on-delivery orders when the customer agrees.
- *Paid manually*: you refunded by bank transfer or in the Paystack/Stripe dashboard; enter its reference.
Optionally put the returned items back in stock. If every item came back and the whole order value was refunded, the order becomes *Refunded* (points used go back to the customer). Part returns leave the order as Delivered.

**Safety:** only one person can settle a return (it is claimed first); a Paystack refund that was accepted is remembered, so a retry never refunds twice; if Paystack refuses, nothing is recorded as paid and the reason is shown; each step is written to the Activity log.

**Limits:** Stripe payments cannot be refunded from here yet (refund in Stripe, then use "Paid manually"); loyalty points earned on a part return are not clawed back; partner adjustment is not applied when the whole order is refunded (that order simply leaves the partner's earnings, so "we cover it" cannot be honoured there); photos can be added only while submitting the request (the customer can remove them until it is reviewed); replacements/exchanges are not handled (refund only). Test: `npm run test:returns`.

## Photos
When asking for a return the customer can attach up to 5 photos (PNG, JPG or WEBP; the page shrinks big phone photos first, the server refuses anything over 4 MB or that is not really an image). They are stored in a **private** bucket (`return-photos`, or `SUPABASE_RETURNS_BUCKET`), never a public link; the customer sees them only when signed in or using their private order link, and staff see them inside the return (Orders access). The health check (preflight) warns if that bucket is missing or public. Without Supabase (local development) they go to `DATA_DIR/return-photos`.

## Partner payout adjustment
When a return that includes a partner store's items is settled, the value of those items **after our commission** (scaled down if staff approved less than requested) is taken off that partner's balance, once (recorded in `vendor_adjustments`, shown on the partner's Earnings page, the partner report, and the staff partner page; the partner is notified). In the Settle box staff can untick **"Take it off the partner's balance"** when we cover the return ourselves. A partner can never be paid more than the balance after adjustments (the payout check uses it). If the whole order is refunded, the order becomes Refunded and drops out of the partner's delivered figures by itself, so nothing is deducted twice.

## Operations Manager and returns opened by staff
A new built-in role, **Operations Manager**, runs returns day to day (Orders, Customers and Delivery: Edit; most other areas view-only). Existing shops get the role from migration 041; new shops get it with the other default roles. Roles are still editable under Employees & roles.

When a customer asks by phone, WhatsApp or in the shop, anyone with Orders: Edit uses **Returns → Open a return for a customer**: enter the order number, pick the items and quantities, record the customer's answers and an optional internal note. The customer gets the same email and order-page entry as an online request, and it enters the same review queue (one open return per order still applies). Staff can open a return after the window has closed; it is marked **late** for whoever approves it, and the customer still cannot do this themselves. Each return shows **Opened by** (the customer, or the staff member's name) in the queue detail and in the Activity log.

## Owner approval and automatic refunds
The flow is now: **request** (customer, or staff for the customer) → **review** by the Operations Manager (anyone with Orders: Edit) → **owner approval** → **refund sent automatically** → settled.

- **Review = recommend.** When a non-owner staff member presses *Recommend to owner*, the return moves to **Reviewed, waiting for the owner to approve**. The owner gets a notification and an email. Nothing is refunded, and the customer still sees "Waiting for review" (no amount shown). A reviewer can't decline a return once it's with the owner.
- **Owner approves.** *Approve and refund* (amount defaults to the reviewer's recommendation; changing it needs a note). The customer is told, and the refund is sent straight away: the wallet share goes to the VELTO wallet and the card share is refunded by Paystack on the original transaction. The owner can also approve a request directly, or decline it.
- **No automatic route** (pay on delivery, non-Paystack payments, guests with no wallet): the return stays **approved, awaiting settlement** and Finance is notified to settle it by hand (wallet credit or *Paid manually*), exactly as before.
- **If Paystack refuses**, nothing is recorded as paid, the return stays approved and Finance and the owner are alerted; settle it again from the return. A refund is never sent twice.
- **Automatic sending defaults:** the refund is sent without the *put items back in stock* step and takes the partner's share off the partner's balance (the default). Use the settings below if you want Finance to handle each one.

Shop settings (Settings page): `return_auto_refund` (1 = send approved refunds automatically, 0 = approval only queues them for Finance; default 1) and `return_auto_approve_max` (₦; a request at or under this amount is approved and refunded by itself; 0 = off, the default).

## Stripe refunds
Orders paid through Stripe (international card payments) are now refunded automatically just like Paystack ones: after the owner approves, the card share is sent back to the same card through Stripe, in the currency the customer paid in (the approved Naira amount is converted by the same share of the original charge, so the customer gets back the same proportion of what they were charged). The wallet share, if any, goes to the VELTO wallet.

- Needs `STRIPE_ENABLED=1` and `STRIPE_SECRET_KEY` (a key that is allowed to create refunds). If Stripe is off or refuses, nothing is recorded as paid, Finance is alerted and the return waits to be settled again; "Paid manually" is still available.
- Each return uses a Stripe idempotency key (`shopbeta-return-<id>`), so a retry after a timeout can never refund twice.
- Stripe refunds usually reach the customer within 5 to 10 days; the return screen shows Stripe's status.

## Returns in each sales channel
The customer's refund is always the same flow (request → review → owner approval → refund). What happens behind it depends on where the item came from. The return screen shows a **Where these items came from** box with the notes below, so the approver sees them first (`lib/returns-channels.js`).

| Channel | What happens |
|---|---|
| **Our own stock** | The goods can go back on the shelf (the *put items back in stock* option when settling). No notes. |
| **Partner store** | The partner's share, after our commission, comes off their balance when the refund is settled (unticked if we cover it ourselves). The screen shows the exact amount. |
| **Dropshipping** | We hold no stock, so the item is **never restocked**. When the owner approves, a **supplier return** (RMA) is opened on the dropship line (delivered → returned) and appears under Dropshipping → Money & reports → returns and *expecting refunds*, so nobody forgets to claim the money back from the supplier. When the customer has been refunded, the line is marked **refunded** and the refund is recorded for the profit report. If only part of a line comes back (for example 1 of 3 units), the line is left alone, a note is added to it and the owner is emailed, because a supplier return covers a whole line: claim that part by hand. |
| **Imported** (supplier outside Nigeria) | As dropshipping, plus a warning: suppliers abroad rarely refund duties or international shipping, and sending the parcel back may cost more than the item is worth. Check their return terms before approving. |
| **Wholesale quotes** | Not part of this flow. They are separate (bank or Paystack payment, bulk goods); see the wholesale returns section once added. |

The customer is always refunded in full as approved, whatever the supplier decides; the supplier side never blocks a customer's refund.
