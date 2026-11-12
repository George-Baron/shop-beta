# Operations: logs, errors, alerts, uptime, backups, restore

Everything here is built into the app or uses free tiers. Nothing paid was added (budget stays about $75 a month).

## 1. Logs
Render > your service > Logs. In production each line is JSON, for example:
`{"ts":"2026-11-12T09:00:00.000Z","level":"warn","msg":"request","instance":"srv-x","reqId":"a1b2c3d4e5f6","method":"POST","path":"/api/checkout","status":429,"ms":3,"ip":"41.x.x.x"}`
- Search by `reqId` to follow one request. The same id is sent to the browser as the `X-Request-Id` header, so a shopper can quote it.
- Default: only requests with status 400+, slower than 800 ms, checkout and the Paystack webhook are logged. `LOG_REQUESTS=all` logs every request; `off` none.
- Never logged: query strings, request bodies, cookies, passwords, tokens. The log line has the visitor's IP address (to investigate abuse) but no phone numbers or emails.

## 2. Error tracking and alerts
- Admin > **Jobs & backups** > Errors lists unexpected errors, grouped (same place and message = one line with a count). "Mark fixed" hides it; if it happens again it returns and alerts again.
- Alerts go to `ALERT_EMAIL` (comma-separated, needs `RESEND_API_KEY`) and/or `ALERT_WEBHOOK_URL`:
  - **Slack:** create an Incoming Webhook (api.slack.com/apps > Incoming Webhooks) and paste the URL.
  - **Discord:** channel settings > Integrations > Webhooks > copy URL, and add `/slack` at the end of it.
- A new error alerts at once, the same error at most every `ALERT_REPEAT_MINUTES` (60), and at most `ALERT_MAX_PER_HOUR` (20) alerts overall.
- If the webhook or Resend is down the alert is kept and retried (Admin > Jobs shows it if it keeps failing).
- Stored: error text and the first lines of the code path. Not stored: request data.
- Optional later: a hosted tracker such as Sentry has a free tier, but it is a new account and a new data processor, so I did not add it. Ask me if you want it.

## 3. Uptime monitoring (you create this; I cannot do it from here)
The app cannot tell you it is down, so use an outside monitor. Free options: UptimeRobot (free plan, 5-minute checks), Better Stack, or Cloudflare Health Checks.
1. Create the account; add an **HTTP(s) monitor** for `https://YOUR-DOMAIN/health/deep`, check every 5 minutes, alert by email/SMS/Telegram to you.
2. Add a second monitor for `https://YOUR-DOMAIN/` (the shop home page).
3. `/health/deep` answers 200 only when: the database answers, no background job has waited more than 10 minutes, and a database backup succeeded within `BACKUP_MAX_AGE_HOURS` (36). Otherwise 503 with a `checks` object saying which one.
4. Render's own health check keeps using `/health` (shallow and fast). Do not point Render at `/health/deep`.
Verify: stop the service on staging (or break `DATABASE_URL`) and confirm you receive the alert.

## 4. Backups
Two independent layers:
1. **Supabase's own daily backups** (included in Pro, 7 days). Restoring one is done in the Supabase dashboard (Database > Backups) and replaces the whole project database. Point-in-time recovery is a paid add-on: **not enabled; ask first.**
2. **The app's backup** (this document). Every night after 3 am Lagos time a background job takes a consistent snapshot and stores one compressed file in the **private** Supabase bucket `db-backups` (created automatically). The newest 14 are kept. A first backup runs a minute or two after the first start. Each one appears in Admin > Jobs & backups.
   - **Back up now** starts one immediately.
   - **Download a fresh backup** streams a new copy to your computer (limit 4 an hour, and each one is recorded). **It contains customer names, phones, addresses and password hashes.** Store it encrypted or in a private place; never email or chat it.
   - Not included: login sessions, reset tokens, rate counters, the job queue, the error log (nothing worth restoring).
   - Product photos are in Supabase Storage, not in the database, so they are not part of this file. They are not touched by a restore.
   - File size limit: Supabase's default upload limit is 50 MB per file. If the database grows past that, raise the limit (Supabase > Storage > Settings > Upload file size limit). `/health/deep` will turn red and you will be alerted if a nightly backup fails for this reason.
3. If a nightly backup fails the job is retried with delays, the error is recorded and you are alerted.
Keep an extra copy outside Supabase: once a week download a backup and keep it in your own storage.

## 5. Restore (tested)
Restore **always into an empty database first** to check it, never straight onto the live one.
1. Get the file: Admin > Jobs & backups > Download (or Supabase Storage > db-backups > download).
2. Check it is whole (touches no database): `node scripts/restore-backup.js shop-beta-XXXX.ndjson.gz --check`
3. Create an empty Postgres database (a new Supabase project on the free plan is fine for a rehearsal) and put its connection string (session or direct, not the transaction pooler) in `DATABASE_URL`.
4. Restore: `DATABASE_URL='postgres://...' node scripts/restore-backup.js shop-beta-XXXX.ndjson.gz --confirm <the-database-host-name>`
   - `--confirm` must equal the host name in the URL, so you cannot hit the wrong database by accident.
   - It runs the migrations, then loads everything in **one transaction**: either all of it or nothing.
   - It refuses if the target already has users, orders or products. To overwrite on purpose add `--replace` (this deletes what is there).
5. Start the app against it (`DATABASE_URL` the same) and check: sign in as admin (same password as at the time of the backup), open Orders, place a test order.
6. **Disaster recovery on the live site** (only with your say-so): stop traffic (set a maintenance page in Cloudflare), take one more download of the broken database if you can, restore with `--replace` into the live database, start the service, run the checks in step 5, remove the maintenance page. Everyone is signed out after a restore.
7. Orders placed after the backup was taken are lost on restore. Paystack and your email give you the payments of that gap; re-enter or reconcile them by hand.

### What was tested
`npm run test:ops` restores a backup into a brand-new database and compares users, products, variants, orders, order items, events, messages (with accents, quotes, emoji), settings, zones, stores, categories, coupons, addresses and email outbox row for row (hash of every row). It also checks that the restored shop works (logins, new orders get new ids, stock arithmetic), that a cut-off, damaged or wrong-host restore is refused, and that a failure half way leaves the database unchanged.
**Not tested here:** a restore against real Supabase (pooler and SSL behaviour), and the real Supabase bucket (private access and the upload size limit). Do the rehearsal in step 3 once on staging and write down how long it took.

## 6. Quick reference
| Need | Where |
|---|---|
| Something is broken, what happened? | Admin > Jobs & backups > Errors, then Render logs (search the request id) |
| Emails not going out | Admin > Jobs (failed jobs, Try again) |
| Is the nightly backup working? | Admin > Jobs & backups, and `/health/deep` |
| Lost admin password | `ADMIN_EMAIL=... ADMIN_PASSWORD='...' node scripts/set-admin-password.js` |
