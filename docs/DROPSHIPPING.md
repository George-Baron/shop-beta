# Dropshipping

VELTO-MART can sell products it does not hold. A customer orders, the **supplier** ships, and we keep the margin. Suppliers and customers can be in any country.

> **Status.** Steps 1 to 4 are built: suppliers, dropship products, pricing, import and review, countries and currencies, and the dropship order flow. Trade documents, reports and the supplier portal come in later steps. **Customers can buy dropship items only when `DROPSHIP_ORDERS_ENABLED=1`.** Until then the product page shows "Not available to order just yet".

Everything is in **Admin > Dropshipping** (Suppliers, Products, Settings & rates). Tests: `npm run test:dropship` and `npm run test:dropship:unit`.

## 1. Onboard a supplier
1. Suppliers > **Add supplier**. Enter name, country, **the currency they invoice you in**, contact person, email, WhatsApp (with country code), address, payment terms, how many days you have to pay (0 = prepaid), their average processing days, and the shipping methods they offer (air, sea, courier, local).
2. Open the supplier and **upload documents**: business registration and your contract or agreement (PDF, JPG, PNG or Word). They are stored in a **private** bucket (`SUPABASE_SUPPLIER_BUCKET`, default `supplier-docs`), are only opened through the admin, and every opening is written to the activity log.
3. Optionally give the supplier a **margin rule** (see Pricing).
4. **Performance**: record orders, late deliveries, cancellations, defects and 1 to 5 star ratings. The supplier screen shows on-time %, cancellation % and average rating. (Step 4 will record orders and lateness automatically.)
5. **Pausing** a supplier hides all of their products from customers immediately. Make them active again to bring the products back.

## 2. Exchange rates (do this before adding products)
Settings & rates > **Exchange rates**. Enter how many Naira one unit of the supplier's currency is worth (for example CNY = 210). A product cannot be priced, imported or approved without a rate for its supplier's currency: the system refuses rather than guess. Changing a rate **never changes a live price by itself**. Open the product and press the calculated price, or "reprice", on purpose. The product screen shows how far the rate has moved since the price was set.

## 3. How the price is worked out
For each product (everything in the supplier's currency is converted to Naira at the rate above):

| Line | How |
|---|---|
| Goods | supplier cost × rate |
| Shipping | shipping per unit × rate |
| Duty (estimate) | (goods + shipping) × duty % |
| Tax (estimate) | (goods + shipping + duty) × tax % |
| **Landed cost** | sum of the four |
| Margin | landed × % (a markup), or a fixed ₦ amount |
| Payment fee | Paystack-style: 1.5% + ₦100 (the ₦100 only from ₦2,500), capped at ₦2,000. All editable |
| **Price** | the smallest price whose proceeds after the fee cover landed + margin, rounded **up** to the "round to" step (default ₦50) |

The product screen shows landed cost, fee, **break-even price** (no profit, no loss), the price charged and **profit per sale**, live while you type. The list shows break-even and profit for every product.

**Which margin rule applies** (first one that is set): the product, then its category, then the supplier, then the shop default (Settings, default 30%).

**Price mode:** *automatic* (the price follows the calculation each time you save) or *manual* (you set it; the screen warns if it is below break-even). A price below break-even **cannot be approved**.

**Duty and tax are placeholders** (defaults 20% and 7.5%). They depend on the HS code, the country and your clearing agent. Check them for your real products and set them per product or in Settings. Treat the figures as estimates, not legal or tax advice.

## 4. Import a supplier catalogue
Products > **Import catalogue**.
1. Choose the supplier and the department, then **upload a CSV or Excel (.xlsx) file, or paste rows copied from a spreadsheet**. The first row must be column names. Old `.xls` files: save as `.xlsx` or CSV first. At most 2,000 products per import.
2. **Preview** (nothing is saved). Columns are matched by their headings (SKU / item no, name / title, price / cost, freight, qty, weight, HS code, origin, brand, category, image URLs, and so on). If a column is not found, choose it from the list. If weights are in grams, say so.
3. Every row gets a verdict: **New**, **Already imported** (same supplier SKU), **Same name exists** (same product name already in the shop, skipped unless you tick "import anyway"), **Repeated in file**, or **Problem** (with the reason, such as no cost or an unknown country).
4. Set default shipping days to Nigeria for the new products, choose what happens to supplier codes that already exist ("leave alone", or "update cost, stock and sizes": the **live price is not changed**), and press **Import**.
5. New products start as **Needs review**. Photos are copied from the supplier's links into your own storage in the background (a few minutes for a large file). They are never hot-linked. Links to internal or private addresses are refused.

Importing the same file twice creates nothing new.

## 5. Review and publish
Products > filter **Needs review**. Open a product, check the photos, price, shipping times, HS code and weight, then **Approve & publish** or **Reject** (a reason is required). Approval is refused while there is no photo, no shipping time, no exchange rate, the supplier is paused, or the price is below break-even. Nothing dropshipped is visible to customers (product page, search, listings, sitemap) until approved.

Dropship products cannot be edited in the normal Products screen, so they cannot skip pricing and review. They are never offered wholesale.

## 6. What customers see
"Ships from [country]" and an honest delivery window: **processing days (the product's, else the supplier's) + shipping days + a safety buffer** (default 2 days, added to the long end). They never see the supplier, supplier code, cost, margin, HS code or duty. The product's public code is `DS-<id>`, not the supplier's code.

## 7. Handling problems
| Problem | What to do |
|---|---|
| "No exchange rate for XXX" | Settings & rates > add the rate, then retry |
| Approve is refused | The message names the first thing to fix (photo, shipping times, break-even, supplier paused, rate) |
| Supplier photos did not copy | The product shows "photos copying…". Retry later or upload a photo by hand |
| Supplier changed a cost | Import with "update", then open the product: it shows the calculated price is different from the live one. Reprice on purpose |
| Wrong department or category on an import | Edit the product (Products > open it) |
| Supplier is unreliable | Record late deliveries, cancellations and defects, or pause the supplier |

## 8. Countries, currencies and paying from abroad (step 3)
Open **Dropshipping > Countries & currencies**. Nothing ships abroad until you switch it on: the starter zones are OFF, and only Nigeria is enabled.

**How a price reaches a customer abroad.** Prices stay in Naira. The customer picks a currency (bottom of any page); the site shows prices converted for display, and checkout shows *exactly* what they will be charged. When the order is placed the server fixes the rate and the amount in the customer's currency (`orders.fx_rate`, `orders.charge_amount`). A later rate change never changes an order already placed, and the amount sent to Paystack or Stripe is that stored amount, never recalculated.

**Currencies.** A currency can only be switched on once it has a rate. The *markup* (default 2%) lowers the rate customers are charged at, so they pay slightly more of their own money; it covers bank and gateway currency costs. Amounts are rounded **up**. A rate typed by hand is *locked* and never changed by the automatic feed. Set `FX_FEED_ENABLED=1` to let the feed keep unlocked rates fresh every 6 hours: a jump of more than 25% in one update is ignored as a bad reading, and a feed rate older than `FX_MAX_AGE_HOURS` (72) stops being used, so a currency never sells at a stale rate. Rate changes never reprice your products.

**Shipping zones and fees.** Each zone has weight bands (`up to kg : fee in ₦`), a fee per extra kg beyond the last band, and delivery days from dispatch. A cart's weight is the sum of each product's weight (dropship products have one) or the *usual item weight* setting for products without one. A country is only shippable when its zone is switched on and has bands. Abroad there is one delivery option; express, store pickup, pay on delivery and the map pin are Nigeria-only. Nigeria keeps its state fees.

**Countries.** Add any country in the world. Each has its dial code, allowed phone length, whether a postcode is required and its pattern, the name of the region box (State, County, Province…), a usual currency, and its tax rule. Phone numbers are accepted as `+44 7911 123456`, `07911 123456` or `7911123456` and stored as `+447911123456`.

**Tax.** Off by default everywhere. *Added*: the tax is added to goods + delivery and is part of the total the customer pays. *Included*: the part already inside the price is shown on the order but the total does not change. The percentages seeded are usual standard rates for reference only: confirm with your accountant before turning tax on.

**Products that cannot go to a country.** Ban or restrict a product, a category or a whole department per country. *Banned*: the order is refused with a clear message. *Needs approval*: not sold online; the customer is asked to contact you.

**Paying.** Paystack is offered for Naira from anywhere, and for `PAYSTACK_CURRENCIES` (default NGN, GHS, ZAR, KES, USD) in countries marked "Paystack may be offered" (Nigeria and Africa). Stripe (international cards) is offered for `STRIPE_CURRENCIES` when `STRIPE_ENABLED=1` and keys are set. Pay on delivery stays Nigeria-only, in Naira. A payment is only marked received after the server asks the gateway itself and the **reference, currency and amount** all match the order; a Stripe webhook only prompts that check, and old or wrongly signed webhooks are refused. In the database `payment_method='paystack'` still means "paid online" for either gateway; `orders.gateway` says which.

**Privacy.** Customers see countries, their phone and postcode rules and display rates. They never see shipping fee tables, markups, supplier costs, margins or tax notes. The customer's own order shows what they were charged and nothing about our rate or gateway.

**Setting up Stripe.** Create the account, add `STRIPE_ENABLED=1`, `STRIPE_SECRET_KEY`, and a webhook for `checkout.session.completed` (and `checkout.session.async_payment_succeeded`) pointing at `https://YOUR-SITE/api/stripe/webhook`, then put its signing secret in `STRIPE_WEBHOOK_SECRET`. Check your Stripe account can charge the currencies in `STRIPE_CURRENCIES`. Stripe cannot charge Naira here, so Nigerian customers use Paystack.

## 9. Dropship orders (step 4)

**Where:** Admin > Dropshipping > *Supplier orders*.

**The journey of each supplier item** (a customer order with supplier items is split into one tracked line per item):
`Awaiting payment` > `Paid` > `Sent to supplier` > `Confirmed` > `Shipped` > `In transit` > `In customs` > `Delivered`. Side exits: `Problem`, `Cancelled`, `Returned`, `Refunded`. Nothing moves backwards, and repeating a click does nothing twice.

**Daily routine**
1. *Ready to order* lists paid items only. Nothing can be ordered before the payment is confirmed, and pay on delivery is not offered for supplier items.
2. Click **Create purchase order**. You get a PDF, a ready WhatsApp message, and the option to email the supplier with the PDF attached (or mark it "I sent it myself"). One purchase order covers one customer order and one supplier. The supplier sees the delivery address and phone (they ship to the customer) but never the customer's email, what the customer paid, or our other orders.
3. When the supplier replies, open the item (**Update**), type the *supplier's order number* and press **Supplier confirmed**. When it ships, enter the *carrier and tracking number* and press **Shipped**. The customer is emailed and sees the tracking on their order page. Then **In transit**, **In customs** and **Delivered** as it moves.
4. Every change is stored with who made it and when (open **Update** to see the history).

**When the supplier cannot deliver**
1. Press **Report the problem** and choose what went wrong. The customer is emailed and asked to choose on their order page.
2. Optionally **Offer an alternative**: another in-stock supplier product. The customer takes it at the price they already paid (we may lose margin, you are warned) or asks for a full refund. The order total never changes.
3. If they choose a refund, you are emailed and the item shows under *Refunds to pay the customer* with the exact amount. Refund it in your payment dashboard, then enter the reference and press **Record refund**. Refunds are not automatic until step 6.

**Order status.** An order made only of supplier items has no rider and no handover code: its status follows its items (you cannot set it by hand). A mixed order keeps its normal flow, but cannot be marked delivered while a supplier item is still on its way. An order cannot be cancelled once a supplier has been sent it: cancel the items so the supplier is told.

**Riders and staff roles.** Supplier-only orders and orders going abroad are never offered to a local rider (the dispatch rules skip them). The whole Dropshipping area, including costs and margins, is owner-only: no employee role can open it, because the staff role list has no dropshipping module.

**Stuck orders.** An item is flagged if it is paid but not ordered after 24 hours, sent but not confirmed after 3 days, not shipped 3 days after the supplier's processing time, or a customer has not answered a problem for 3 days. You get one email digest at most every 12 hours. The customer is not reminded automatically.

**Prices.** The price, cost and exchange rate are copied onto the order when it is placed. Changing a product later never changes an existing order.

## 10. Imports, exports and trade documents (step 5)
Open **Dropshipping > Imports & exports** (owner only, like the rest of Dropshipping).

**Shipments.** One record per import (we buy from a supplier abroad) or export (we sell to a buyer abroad): Incoterm, currency, the other party (copied onto the shipment so later edits never change old papers), forwarder, container and bill numbers, ETD/ETA, customs status, packages, weight, freight, insurance, duty %, VAT %, agent and other fees. Status goes draft, booked, in transit, arrived, cleared, delivered (or cancelled). Once goods are in transit the goods, values and parties are locked; tracking, customs and fees can still change. Goods can be typed in or taken from an approved dropship product (converted with the saved exchange rates).

**Documents.** Commercial invoice, proforma invoice, packing list (no prices), purchase order (imports) and a customs data sheet, all as PDFs. A document gets its number (CI-, PF-, PL-, TPO-, CD-) the first time it is opened and keeps it, so reprints are identical. Our company details (name, address, TIN, RC number, bank note) are set under **Our company details**.

**Landed cost.** The calculator (and each shipment) adds goods, freight, insurance, duty, VAT, agent fees and other charges in whole minor units. The Incoterm decides which costs the seller already included and who pays the rest. Duty is worked out on the CIF value. Amounts can also be shown in another currency using the saved rates. Duty and VAT are estimates; your clearing agent has the final figures.

**Files.** Bills of lading, certificates, permits and similar can be attached (PDF, JPG, PNG, DOCX, up to 6 MB). They go to the private `trade-docs` bucket (`SUPABASE_TRADE_BUCKET`), never to a public one, and every open of a document or file is in the activity log.

**Checklist.** Each shipment shows reminders for its countries (for example Form M, SONCAP, NAFDAC, NEPC and Form NXP for Nigeria). Mark each Done (with what you checked) or Not needed (with a reason). **These starting reminders are placeholders to verify with the official source. They are not legal advice.** Edit, add or switch them off under **Reminders and restricted items**.

**Restricted items.** Medicines and weapons are blocked; food, chemicals and batteries need a person to record that permits were checked. Matching is on whole words and HS code starts. A blocked item cannot be created, updated, approved, imported or added to a shipment. A "check first" item stays hidden until it is approved with a compliance note, and changing its class takes it back to pending. These checks cover dropship listings, importer rows and shipment goods, not your own-stock products. Medicines cannot be loosened until `PHARMACY_ENABLED=1`.

## 11. Money, refunds and reports (step 6)
Open **Dropshipping > Money & reports** (owner only: it shows our cost and margin, so no customer or supplier can ever reach it).

**What we owe suppliers.** Sending a purchase order creates a payable for that order, in the supplier's own currency. It is due on the day you send it for prepaid suppliers, or after the supplier's payment days (for example Net 30). The screen groups what is owed by supplier, flags overdue ones and shows a Naira total at today's rates. **Mark paid** needs a payment reference (the transfer or wire number) and records who and when. It records a payment you made; it does not move money. Marking paid twice changes nothing.

**Extra costs.** On each item (Supplier orders > item > **Money**) add duty, extra shipping, handling, the real payment fee, or other costs, in Naira. They start only after the customer has paid.

**Refunds.** A refund to the customer is still sent by hand (Paystack, Stripe or bank), then recorded on the item with its reference. The amount (up to what the customer paid for that item) is kept for the reports. A refund *from the supplier* is recorded as **credit** (lowers what we owe on that purchase order) or **cash** (money received, needs a reference). It can never be more than we paid for the item, and credit is refused once the purchase order is paid. The screen lists items that went wrong after we ordered and have no supplier refund yet, so the money is claimed back.

**Returns to the supplier.** A delivered item can be returned from its Money screen (reason needed). The item becomes "Returned" with the refund due set. The return itself follows: requested, approved, sent back (carrier and tracking needed), received, closed (or rejected, then closed). Refund the customer and claim the supplier refund separately.

**Profit reports.** Revenue (items the customer paid for; delivery fees are not included), customer refunds, supplier cost, supplier shipping, extra shipping, duty, payment fees, other costs, supplier refunds, net profit and margin. Group by order, supplier, country, product, day or month, for any period of up to two years (days are Lagos days). Every figure uses the price and exchange rate **fixed when the order was placed**, shown next to each order, so changing a rate later never rewrites old profit. Supplier cost counts once we have ordered. If a payment fee was not entered, it is estimated from the fee settings and marked with *. **Download Excel** gives the same table plus open payables (the download is in the activity log).

## Settings and environment
* `STRIPE_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CURRENCIES`, `PAYSTACK_CURRENCIES`, `FX_FEED_ENABLED`, `FX_FEED_URL`, `FX_MAX_AGE_HOURS`: see DEPLOY.md. `STRIPE_API_URL` is for tests only (preflight fails if it is set in production).
* `SUPABASE_SUPPLIER_BUCKET` (default `supplier-docs`): create it as a **private** bucket. `npm run preflight` checks it.
* `SUPABASE_TRADE_BUCKET` (default `trade-docs`): create it as a **private** bucket (shipment files).
* `DROPSHIP_ORDERS_ENABLED`: set to `1` to let customers buy supplier items. It also starts the stuck-order check (every 6 hours). Leave it off until you have a supplier, an approved product, and have tried one test order.
* Pricing defaults, exchange rates and category margins are stored in their own tables (not the public settings), so cost and margin data cannot reach the storefront.
* Every change is in the activity log. Rate limits protect uploads and imports. Migrations `010`, `011` and `012` are safe to re-run.

## Not built yet
Supplier login portal (step 7). Customer refunds are still sent by hand and then recorded; no payment is moved automatically.
