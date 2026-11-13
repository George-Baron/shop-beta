# Load test (step 9)

Targets from the brief: **2,000 concurrent browsing shoppers and 100 checkouts a minute at the same time, p95 under 800 ms, under 1% errors, no lost or duplicated orders, no overselling.**
Budget stays at 2 Render Standard instances plus Supabase Pro. Nothing was bought for this step.

## What the test does
`load/run-staging.js` builds a throwaway copy of the shop on one computer and attacks it:
- a new Postgres database with a 20,000-product catalogue (`load/seed-catalogue.js`) and one scarce item with only **10** units;
- **2 app instances** behind a round-robin balancer (`scripts/dev-lb.js`, which stops sending to an instance that is down, like Render's balancer);
- a fake Paystack (`load/mock-paystack.js`, 120 ms delay per call);
- **k6** (`load/baseline.js`): 2,000 shoppers browsing with 2-6 s think time (home page, list, search, product page, API calls), and at the same time 100 checkouts a minute: 70% pay on delivery, 30% online followed by Paystack's signed webhook (20% of them sent twice, like Paystack retries), 5% of checkouts sent twice with the same Idempotency-Key (a shopper's retry), 10% aimed at the scarce item;
- afterwards `load/verify.js` compares the database with every order the shop said yes to, and with the stock levels recorded before the test (the checker was itself tested against deliberately corrupted data and does fail when orders are lost, invented, or stock moves without an order).
- `--chaos` stops one instance gracefully in the middle of the run and starts it again (what a Render deploy does).

Run it yourself: `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres node load/run-staging.js --vus 2000 --rate 100 --hold 180s --ramp 45s [--chaos]` (needs k6 and a local Postgres; it creates and drops its own database). Raw results of the runs below are in `docs/load-results/`.

## Results (13 Nov 2026, in this sandbox)
**Read this first:** the sandbox has only **2 CPUs and 8 GB, shared by the app instances, the balancer, Postgres and k6 itself**. During the full runs the whole computer was **78-80% busy on average and up to 93-97%**, so latencies here are worse than a dedicated machine would give. The database was on the same computer (no network delay to Supabase), and Cloudflare was not in front. So this is evidence about the application, not a measurement of Render.

| Run | Requests | p95 all | p95 checkout | App errors | Integrity |
|---|---|---|---|---|---|
| Target load A: 2,000 shoppers + 100 checkouts/min | 188,171 | 42 ms | 343 ms | 0.00% | all passed |
| Target load B (repeat) | 187,573 | 77 ms | **838 ms (over target)** | 0.00% | all passed |
| Target load C (repeat, with CPU accounting) | 187,013 | 72 ms | 784 ms | 0.00% | all passed |
| Target load D (repeat, final stricter checker) | 186,707 | 94 ms | **1,070 ms (over target)** | 0.00% | all passed (all 20,061 products and 15,068 variants checked) |
| Target load + instance restart (1) | 187,156 | 59 ms | 566 ms | 2 of 187,147 | 1 retry request cut off by the restart, no duplicate order |
| Target load + instance restart (2) | 187,214 | 72 ms | **805 ms (over target)** | 0.00% | all passed |
| Checkout alone at 3x the target (300/min) | 654 | 148 ms | 150 ms | 0.00% | all passed |
| Raw capacity: 400 shoppers with no pauses | 99,709 | 396 ms | n/a | 0.00% | all passed |

What this says:
1. **Browsing 2,000 shoppers is comfortable**: p95 between 42 and 77 ms for every page and API call against a target of 800 ms. About 740 requests a second were served.
2. **Zero lost, duplicated or oversold orders in every run.** About 290 orders per run all reached the database; each accepted order appears once; every stock level in the shop (20,061 products and 15,068 variants in the last run) equals its starting stock minus what was sold; the scarce item sold exactly its 10 units and refused the other 14-28 attempts (run A used 50 units and never sold out, so it did not exercise this; all later runs used 10); every online order whose webhook arrived was marked paid exactly once (also when the webhook was sent twice); every order has its confirmation email saved; the background queue ended empty with nothing failed.
3. **Checkout p95 under full load is not reliably under 800 ms on this computer**: 343, 838, 784, 1,070 ms in four plain runs and 566, 805 ms in the two restart runs: over the target in 3 of the 6 full-load runs. Checkout alone, even at three times the target rate, is 150 ms and the computer was 11% busy. The difference is the computer being nearly full. I cannot claim the 800 ms checkout target is met until it is run on Render (below). I would not call it failed either; but it is not proven.
4. **How much CPU the app really needs**: about **1.06 ms of CPU per request** (measured, run C), so 740 requests a second is roughly **0.8 of one CPU core across both instances**. If a Render Standard instance has 1 vCPU (please confirm on Render's pricing page), two instances have about 2.5 times what this target needs, before Cloudflare caching removes some of the traffic. Memory per instance peaked at about 235 MB.
5. **Database connections**: at most 17-20 across both instances (each uses a pool of up to 10, `PG_POOL_MAX`). Supabase's transaction pooler should take that easily; confirm in its dashboard.
6. **Restart under load**: the stopped instance was back and healthy 6-7 s after the stop signal. The balancer retried browsing requests on the other instance, so shoppers saw no errors. A POST that was already in flight to the stopping instance was cut off once in two runs; the shop page retries with the same Idempotency-Key, which returns the same order, so nothing is duplicated (the integrity check proves it).
7. **Beyond capacity**: with 400 shoppers firing requests with no pauses (about 1,640 requests a second, far above 2,000 real shoppers), nothing failed, but the slowest 1% waited up to several seconds. That is queueing on a full computer, not an error.

## One finding that costs money: page weight
Every page view downloads the whole page shell, about **43 KB compressed** (the CSS and JavaScript are inside the HTML). The 4-minute test moved **8.9 GB**. At 2,000 browsing shoppers that is roughly 20 GB an hour of Render outbound traffic if Cloudflare does not serve it. API answers are small (0.5-3 KB).
Fix (not done: it is outside this step and would change how pages are built): move the CSS and JavaScript into separate fingerprinted files that Cloudflare and the browser cache, leaving a small HTML shell. Check how much bandwidth your Render plan includes and its overage price (I did not verify these). Say if you want this done.

## Not verified here (needs you)
- Real Render instances (CPU, memory, the real balancer, real client IPs), real Supabase (network delay on every query, pooler limits), Cloudflare in front, real Paystack. The steps below do the first two.
- Whether the checkout p95 meets 800 ms on Render.

## Running the same test on Render staging (needs your decisions first)
**Ask first, because it spends money:** (1) a separate staging web service with 2 Standard instances (billed for the time it runs; remove it afterwards); (2) a separate **staging database**. A second Supabase Pro project is a paid project; the free tier has smaller connection limits and pauses, so it is not a fair test. Options: pay for one Pro project for a day, or run the test on a temporary Pro project and delete it. **Never run this against the live database.** `load/seed-catalogue.js` refuses a database that has orders, and refuses a non-local database unless `--allow-remote`.

1. Create the staging service from the `rebuild/scale` branch with the same settings as production (docs/DEPLOY.md, step 10), but: its own `DATABASE_URL` (staging project, transaction pooler), `MIGRATE_DATABASE_URL` (session pooler), **no Paystack keys** (online payments then use the demo mode; the Paystack path is covered by the local test and a few real test-mode payments), `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `STORAGE_DRIVER` as production, and **`RATE_IP_CHECKOUT=100000`** (the test sends every checkout from one IP; the real per-person limits still apply and the script uses a different phone and email for each order).
2. Seed it once from your computer: `DATABASE_URL='<staging session pooler>' node load/seed-catalogue.js 20000 --allow-remote`, then record stock: `DATABASE_URL='<same>' node load/verify.js --snapshot before.json`.
3. Run k6 **from a machine that is not the shop**. The test downloads about 35 MB a second at full size, far more than a home or office connection; a small cloud server near the Render region works (a paid service: ask me before buying one). From a normal laptop run a smaller test, for example `--vus 300`, and treat it as a smoke test:
   `k6 run --console-output orders.log --summary-export summary.json -e PROFILE=mixed -e VUS=2000 -e RATE=100 -e RAMP=45s -e HOLD=300s -e ONLINE_SHARE=0 -e BASE=https://<staging>.onrender.com load/baseline.js`
   (use the onrender.com address, not Cloudflare, so you measure the app; run a second time through Cloudflare to see the cache effect).
4. While it runs, watch Render > Metrics (CPU and memory of both instances), Supabase > Reports (connections, CPU), and `https://<staging>/health/deep`.
5. Afterwards: `DATABASE_URL='<staging session pooler>' node load/verify.js --log orders.log --snapshot before.json --scarce-total 10` must print "All integrity checks passed", and k6 must print all thresholds as passed.
6. Rolling-deploy test: during the run press "Manual Deploy" on the staging service and note any failed requests.
7. Delete the staging service and database (or suspend them) and tell me the numbers; I will add them here.

**Pass means:** k6 thresholds green (p95 under 800 ms for every request type, under 1% errors), the integrity checks all passing, and Render CPU under about 70% on both instances. If checkout p95 is over: first check Supabase latency and `PG_POOL_MAX`; Render CPU near 100% means a bigger instance (a paid change: ask first).
