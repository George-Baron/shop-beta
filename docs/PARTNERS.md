# Partner stores

Many stores can sell on Shop-Beta. Each has its own page (`/store/<name>`), up to **3 departments**, and its own login at `/partner`.

## How a store joins
1. The store applies at `/sell` (business name, CAC number, address, departments, password). Status: **evaluating**. Customers cannot see it.
2. While evaluated it can sign in, fill its store page and add products. Every product starts as **pending**.
3. You check the details over a few weeks, then in **Admin > Partner stores** open the store, set the map position (riders collect there), set commission, and press **Approve**. Approval creates the store's pickup point automatically.
4. Review each product under **Product review**. Approved products go live. Changing a product's name, description, photos or category sends it back for review. Price and stock changes do not.

## What customers see
- "Sold by" on product cards, product pages, cart, checkout and orders.
- `/stores` directory (filter by department, search by store name).
- Search shows which stores the matching products come from, and stores whose name matches. Customers can filter to one store.
- One cart can hold several stores' products. It is one order and one payment.

## Money
- The customer pays us. For every order line we record the commission (the department's rate if you set one, otherwise the store's rate).
- A store is owed the price of **delivered** orders minus commission. Refunded and cancelled orders do not count. Coupon discounts and delivery fees are ours.
- Pay stores by bank transfer, then record it under **Partner stores > Payables**. The app refuses a payout larger than what is owed.
- Stores see their own sales, commission, balance and payouts under Earnings. They never see customer names, phones or addresses. Our rider collects and delivers.

## Not built yet
- Medicines from partner pharmacies: partner stores cannot use the pharmacy department. Pharmacy stays with the pharmacy module and its licence checks.
- Splitting delivery fees or paying out automatically (Paystack split / transfers).
- Store-level handling of returns and disputes: refunds still go through admin.
- Wholesale (next push).
