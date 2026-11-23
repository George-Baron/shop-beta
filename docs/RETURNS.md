# Returns and refunds after delivery

**Customer:** once an order is delivered and paid, its page shows "Returns and refunds" with a **Return items** button (signed in, or via the private link in the order email). They pick the items and quantities and answer four short questions: why, what condition, original packaging, and what happened. The window is the shop setting `return_days` (7 by default), counted from delivery. Medicine orders are excluded (they go through the pharmacy team). One return can be open per order; the customer can cancel it until staff review it. They see every step on the order page and get an email and an in-app notice at each one.

**Staff:** a new request puts **"Order X is to be returned"** on the Dashboard, adds a count badge on **Returns** in the menu, and notifies everyone with Orders: Edit. In **Returns**, open a request to see the customer's answers, then **Approve** (amount defaults to what the items were worth after discounts, plus the delivery fee when we got it wrong and the whole order comes back; you can lower it with a short note, never above what is left on the order) or **Decline** (a reason is required and is sent to the customer). Needs Orders: Edit.

**Settlement:** an approved return shows as **Approved, refund awaiting settlement**, and Finance is notified. Someone with Finance: Edit (or the owner) settles it:
- *Original payment*: the part the customer paid from their VELTO wallet goes back to the wallet; the card part is refunded by Paystack on the original transaction (the amount is sent to Paystack and the money reaches the customer's bank in a few days, so "accepted by Paystack" is not "arrived").
- *VELTO wallet*: the whole refund as wallet credit (instant). Use for cash-on-delivery orders when the customer agrees.
- *Paid manually*: you refunded by bank transfer or in the Paystack/Stripe dashboard; enter its reference.
Optionally put the returned items back in stock. If every item came back and the whole order value was refunded, the order becomes *Refunded* (points used go back to the customer). Part returns leave the order as Delivered.

**Safety:** only one person can settle a return (it is claimed first); a Paystack refund that was accepted is remembered, so a retry never refunds twice; if Paystack refuses, nothing is recorded as paid and the reason is shown; each step is written to the Activity log.

**Limits:** Stripe payments cannot be refunded from here yet (refund in Stripe, then use "Paid manually"); loyalty points earned on a part return are not clawed back; customers cannot attach photos yet; replacements/exchanges are not handled (refund only). Test: `npm run test:returns`.
