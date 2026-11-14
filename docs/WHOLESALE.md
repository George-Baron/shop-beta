# Wholesale buying

Customers and partner stores can apply to buy our own stock in bulk at wholesale prices.

## Flow
1. **Apply** at `/wholesale` (needs a normal account). Business name, CAC number, address, what they plan to buy.
2. **Evaluation.** Status is "evaluating" for `wholesale_eval_days` (default 21). Admin > Wholesale > Applications: check the registration number, then Approve (early approval asks for confirmation), Reject, Suspend or Extend. Applicants see no wholesale prices until approved.
3. **Request.** An approved buyer picks quantities (at or above each product's minimum) and asks for a quotation.
4. **Proforma invoice.** Admin > Wholesale > Requests & quotes: adjust quantities and unit prices, type the logistics fee, set the service fee % (blank uses the default, 3%), validity days and a shipment plan, then Send. Total = goods + logistics fee + service fee. The buyer gets an email and a printable invoice.
5. **Approval.** The buyer approves the quotation. The goods are set aside (stock is held).
6. **Payment before shipping.** Paystack online (reference = quote number), or bank transfer, which admin confirms with the bank reference. Unpaid quotes lapse after `wholesale_pay_days` (default 3) and the stock is released.
7. **Ship and deliver.** Admin can only mark shipped after payment (carrier and tracking), then delivered.

## Settings (Admin > Wholesale > Settings)
Service fee %, quote validity days, days to pay, evaluation days, bank transfer details.

## Wholesale prices
Admin > Wholesale > Wholesale prices: a price and a minimum quantity per product. Empty price = not offered. Wholesale prices appear only in signed-in `/api/wholesale/*` responses, never in public product data.

## Limits
- Our own stock only. Partner-store products are never sold wholesale.
- No medicines (pharmacy) and no products with sizes or colours.
- Refunds of wholesale payments are done manually.
- Late money for an expired quote is flagged in the quote history for you to handle; it is not accepted silently.
- This is a proforma invoice, not a tax invoice or receipt. Check tax and legal requirements for your business yourself.

Tests: `npm run test:wholesale`.
