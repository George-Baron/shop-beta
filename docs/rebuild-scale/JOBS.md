# Background jobs

Slow or unreliable work no longer happens while a shopper waits. It is saved as a **job** in the database and a worker does it, retrying if it fails. No new service, no extra cost: each web instance runs a worker inside itself, and the database makes sure each job is done by one instance only.

## What runs as a job
| Job | When it is created | What it does |
|---|---|---|
| `email` | whenever the shop stores an email (order, payment, password reset, contact, reminders) | sends it through Resend |
| `order-mail` | order placed (pay on delivery), order paid, admin changes status to processing/shipped/delivered | builds and queues the right emails |
| `paystack-webhook` | Paystack calls our webhook with a signed `charge.success` | asks Paystack to confirm the payment (status, currency, amount) and marks the order paid |
| `expire-unpaid`, `remind-abandoned`, `cleanup` | scheduled (every 10 min, 15 min, 1 h) | cancel unpaid online orders, send cart reminders, delete old rows |

Stock changes are **not** jobs. They stay inside the order's database transaction on purpose, so stock and order can never disagree.

## Why nothing is lost
- A job is saved in the **same database transaction** as the thing that caused it. The order and its confirmation email job are saved together or not at all. The Paystack webhook saves its job *before* answering Paystack "OK".
- Failures are retried after 30 s, 2 min, 8 min, 32 min, 2 h (6 tries; webhooks 10). Then the job is **failed** and appears in **Admin > Jobs** with the reason, where you can press *Try again* or *Dismiss*.
- An email that Resend rejects for good (bad address, bad key: HTTP 4xx other than 408/409/425/429) fails at once without retries.
- If an instance dies while doing a job, the job is picked up again by the other instance after 2 minutes.
- A job can occasionally run twice (crash after doing the work, before noting it). Every handler is safe to repeat: emails carry an `Idempotency-Key` so Resend ignores a duplicate; marking an order paid only happens once; a repeated webhook sends no second email.

## Checking on it
- Admin > Jobs: waiting, running, failed, done in the last 24 hours, and the failed list. Tell me if "waiting" keeps growing: the worker is stopped or too slow.
- Settings: `WORKER_CONCURRENCY` (4 jobs at once per instance), `WORKER_POLL_MS` (1000), `JOB_LEASE_SECONDS` (120). `WORKER=0` stops an instance taking jobs.
- Separate worker (optional, extra paid Render service, not needed now): `npm run worker` runs only the worker; start the web instances with `WORKER=0`.

## Not verified yet
Real Resend and real Paystack were not called (tests use fake ones that fail on purpose). Idempotency-Key handling is based on Resend's documentation and is not confirmed against the live service. Verify with: set `RESEND_API_KEY`, place a pay-on-delivery order, and check the email arrives and that Admin > Jobs shows nothing failed. For Paystack, use a test-mode key and Paystack's "test webhook" button (Settings > API Keys & Webhooks), then confirm the order becomes paid.

## Tests
`npm run test:queue`: the queue on a real database (retries, backoff, 8 workers racing over 100 jobs, crash recovery, no job saved if the transaction rolls back) and the whole shop with fake Resend/Paystack (outage retried, email exactly once, 20 orders over two instances, wrong amount never marks paid, repeated webhooks).
