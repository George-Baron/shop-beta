# Best-of: how this branch was put together

Two rebuilds of the same plan existed on GitHub, both starting from commit 9d4767f:

* **rebuild/scale**: steps 1-10 (no step 6A, no pharmacy), 35 + 20 + 24 + 15 + 22 + 7 tests in its own suites.
* **rebuild/steps-2-10-pharmacy**: steps 2-10 plus step 6A (delivery maps and handover code) and the phase 2 pharmacy groundwork, 10 suites.

This branch (`best-of`) keeps the second as the base, because step 6A and the pharmacy work are built into its order, checkout and rider code, and adds the pieces of the first that were better or missing. Nothing was deleted from either branch.

| Step | Better | What was done |
|---|---|---|
| 1 Architecture notes, baseline load test | rebuild/scale | Not ported: its notes describe its own code. Re-read `ARCHITECTURE.md` on that branch if you want it. |
| 2 Postgres | about equal | Kept ours (advisory-lock migrations, restore-safe). Added `docker-compose.yml` and `npm run db:up` from theirs. |
| 3 Stateless / photo storage | about equal | Kept ours. |
| 4 Caching | about equal | Kept ours. |
| 5 Job queue | about equal | Kept ours. |
| 6 Checkout | rebuild/scale (refunds) | **Ported**: `refunded` status, refund recording, stock returns only if goods never left, "refund the customer" note when a paid order is cancelled. New test in `test:checkout`. |
| 6A Delivery maps + handover code | ours only | Kept. |
| 7 Security | about equal | Kept ours (Cloudflare-aware client IP, password policy, masked guest lookup). Took their numeric `TRUST_PROXY` hop count. |
| 8 Operations | rebuild/scale (error tracking) | **Ported**: `lib/errors.js`, `error_log` table, alerts by email or chat webhook, "Errors" panel in Admin. New test in `test:ops`. Kept our backup/restore. |
| 9 Load test | different | Kept ours (quick staged tool). Their k6 harness and results are on rebuild/scale and need k6; not ported. |
| 10 Deploy | about equal | Kept ours (`DEPLOY.md`, `render.yaml`, `npm run preflight`). Their `docs/DEPLOY.md` is on rebuild/scale. |
| Phase 2 pharmacy | ours only | Kept. |

Not ported (still only on rebuild/scale): the per-topic docs in `docs/` (they describe its own code), `ARCHITECTURE.md`, the k6 load harness and results, `scripts/set-admin-password.js`, and its extra tests (two-instance and image-migration tests).
This comparison was done by reading and running both; it is a judgement, not a benchmark. Run `npm run test:*` on this branch before relying on it.
