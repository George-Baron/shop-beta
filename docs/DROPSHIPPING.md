# Dropshipping

Shop-Beta can sell products it does not hold. A customer orders, the **supplier** ships, and we keep the margin. Suppliers and customers can be in any country.

> **Status.** Steps 1 and 2 are built: suppliers, dropship products, pricing, import and review. The order flow (placing orders with suppliers, tracking, refunds), multi-currency checkout, trade documents and reports come in later steps. **Until the order flow exists, customers cannot buy a dropship item.** It can be listed and approved, and the product page shows "Not available to order just yet". Do not set `DROPSHIP_ORDERS_ENABLED=1` before then.

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

## Settings and environment
* `SUPABASE_SUPPLIER_BUCKET` (default `supplier-docs`): create it as a **private** bucket. `npm run preflight` checks it.
* `DROPSHIP_ORDERS_ENABLED`: leave unset until the order flow (step 4) is built.
* Pricing defaults, exchange rates and category margins are stored in their own tables (not the public settings), so cost and margin data cannot reach the storefront.
* Every change is in the activity log. Rate limits protect uploads and imports. Migrations `010` and `011` are safe to re-run.

## Not built yet
Order flow and supplier purchase orders (step 4); display currencies, countries, shipping zones, Stripe and the automatic rates feed (step 3); trade documents, landed-cost calculator, compliance reminders and restricted-item checks (step 5); profit reports, payables and refunds (step 6); supplier login portal (step 7). Until step 5 adds restricted-item checks, **you** must not import medicines, food, chemicals, batteries or weapons. Medicines are blocked outright (the pharmacy department stays behind `PHARMACY_ENABLED`).
