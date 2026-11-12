# Load testing Shop-Beta

## What was measured

Run on a 2-CPU, 8 GB test machine where the app, Postgres 16 and the load generator all share the same two CPUs. Catalogue of 5,060 products (about 1,000 with sizes and colours). Traffic went straight to the app, with **no Cloudflare caching in front**, which is the worst case. Each "shopper" asks for the next page the moment the last one arrives (no thinking time), so one test shopper is much busier than a real person.

Mix: 55% department home pages and product lists, 28% product pages, 15% search (40% of searches were one-off words that can never be cached).

| Shoppers at once | 1 app instance: requests/s | 95% of requests under | 2 app instances: requests/s | 95% under | Failed |
|---|---|---|---|---|---|
| 10 | 807 | 68 ms | 1,178 | 21 ms | 0 |
| 50 | 1,653 | 78 ms | 1,792 | 64 ms | 0 |
| 100 | 1,673 | 164 ms | 1,922 | 132 ms | 0 |
| 200 | 1,727 | 392 ms | 1,996 | 329 ms | 0 |
| 400 | 1,557 | 929 ms | 2,169 | 729 ms | 0 |
| 800 | 1,505 | 1,667 ms | 1,845 | 1,339 ms | 0 |

Reading it: past about 100 shoppers the machine is out of CPU, so extra shoppers just wait longer. They are not refused and nothing breaks. At 800 simultaneous no-pause shoppers the slowest 1% waited about 3 seconds.

**Orders (pay on delivery, 40 shoppers ordering as fast as they can):** about 260 orders per second, all stored with their items, no refusals.
**Overselling:** 60 buyers at the same moment for an item with 5 in stock gave exactly 5 orders and stock 0, on one instance and through two instances behind a round-robin front.

## What the test found and what was fixed

| Finding | Before | After |
|---|---|---|
| One-off searches scanned the whole catalogue (matching the category name in the same OR stopped the search indexes being used) | search-only traffic: 128 requests/s | 675 requests/s, then more once the next point was done |
| The size/colour filter list re-read every variant on every search | (same) | kept for 60 s per department and category |
| Product pages read stock and variants from the database on every view | 1,279 requests/s | 2,584 requests/s (stock shown may be 3 s old, checkout still takes stock atomically and the product page refreshes straight away on this instance after any order) |
| Anyone could hammer the search box with endless one-off words | no limit | 90 searches a minute per visitor per instance, then a polite 429. Browsing is never limited |
| Whole mixed traffic | about 550 requests/s | about 1,700 requests/s |

## What the numbers do NOT tell you

- **Real hosting is different.** This machine has the database next door (no network delay). On Render, every database query crosses the network to Supabase, so checkout (about 15 queries) is slower than measured here. Put the Render service and the Supabase project **in the same region** (e.g. both in Frankfurt or both in London).
- **Render's CPU.** The test machine had 2 full CPUs shared by everything. A small Render instance has less. My estimate, not measured: expect roughly a quarter to a third of the per-instance numbers above on a small instance, which is still several hundred requests per second, far more than a January 2027 launch needs.
- **Cloudflare** in front (cache rule for `/api/home/*` and `/api/products*`) takes most browsing traffic away from the app entirely, so real capacity is higher than the table.
- **Emails** were not sent in this test (no Resend key), so the queue emptied instantly. The queue itself is covered by `npm run test:queue`.
- **Paystack and Geoapify** were not called.
- Real shoppers pause between pages. The test's 800 no-pause shoppers is far more than 800 real people.

## Rough sizing

One shopper browsing a store loads about one page (a few requests) every 5 to 10 seconds. Using the 1-instance figure of about 1,500 requests/s as the machine ceiling here, that is thousands of people browsing at once. Even if a small Render instance gives a quarter of that, the numbers comfortably cover a launch. The thing to watch is not browsing but **checkout during a promotion**, because that depends on the database round trips. Test that against your real staging copy before any big campaign.

## How to run it

On this repo (starts its own app and database, needs `TEST_DATABASE_URL`):

```
npm run test:load                       # quick check with pass/fail limits, about 1 minute
LOAD_FULL=1 npm run test:load           # staged run up to 800 shoppers, about 3 minutes
LOAD_FULL=1 LOAD_INSTANCES=2 npm run test:load   # two app instances behind a round-robin front
```

Against a **staging** copy of the shop (never the live shop):

```
TARGET=https://staging.yourshop.com STAGES=10,50,100,200 SECONDS=20 npm run loadtest
CHECKOUT=1 TARGET=https://staging.yourshop.com ... npm run loadtest      # also places real pay-on-delivery orders
```

On a real staging site the rate limits will answer 429 to a test that comes from one computer, and that is correct. To test beyond them, run staging with the test-only setting `RATE_LIMIT_MULTIPLIER=100000`. Do not set it in production.

Before launch, run it once against staging from a different computer than the one hosting the shop, and compare with the table above.
