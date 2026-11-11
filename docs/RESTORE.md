# Backups and restoring Shop-Beta

Read this once now, not for the first time on a bad day. Practise a restore before launch (section 4).

## 1. What is protected, and where it lives

| Thing | Where it lives | How it is protected |
|---|---|---|
| Orders, customers, products, settings, reviews, delivery data | Postgres on Supabase | Nightly backup file made by the app (below), plus Supabase's own backups |
| Product photos | Supabase Storage bucket `product-images` | Stays in Supabase. Not part of the nightly file. Keep the originals of important photos |
| Code | GitHub | Every Render deploy comes from it |
| Secrets (keys, passphrase) | Render environment | Keep a copy in a password manager, not in the repo |

**Two layers.** (a) The app's nightly file, described here, works on any plan. (b) On a paid Supabase plan, turn on Supabase's own daily backups and, if you can afford it, point-in-time recovery (Supabase dashboard > Database > Backups). That is the fastest way back from "I deleted something an hour ago". Use both.

## 2. The nightly backup

- The background worker makes a backup every night (about 01:00 Lagos time) and saves it in a **private** Supabase bucket named `backups`. **You must create that bucket once** (Supabase > Storage > New bucket > name `backups`, leave "Public" OFF). Until you do, backups fail and Admin > Settings > "Status and backups" shows the error in red.
- The newest 14 are kept (`BACKUP_KEEP`). Older ones are deleted automatically.
- A backup holds every table except throw-away ones (sessions, reset tokens, rate limits, geo cache, job queue). It contains customer details and password hashes, so **set `BACKUP_PASSPHRASE`** (a long random phrase). The file is then encrypted. **If you lose the passphrase the backups cannot be opened**, so store it away from Render.
- Admin > Settings > "Status and backups" shows the last good backup, lets you press **Back up now** and download any file. Downloads are written to the activity log.
- If no good backup exists for 30 hours the panel shows a red warning. Point a free uptime monitor at `/health` as well (UptimeRobot or similar) so you hear about outages.
- You can also run `npm run backup` from a shell on Render.

Not covered by the app's backup: photos (they stay in the `product-images` bucket) and anything outside the database.

## 3. Restoring

Always restore into a **new, empty** Supabase project or database. Never on top of live data. The restore tool refuses a database that already has data.

1. Create a new Postgres database (a new Supabase project, or a local Postgres for a practice run). Copy its connection string.
2. Download the backup file from Admin > Settings > Status and backups (or from the Supabase `backups` bucket).
3. On your computer (Node 22 and this repo installed with `npm install`):

   ```
   DATABASE_URL="postgres://..."  BACKUP_PASSPHRASE="your passphrase"  npm run restore -- shop-beta-2026....json.gz.enc
   ```

   Leave `BACKUP_PASSPHRASE` out if the file does not end in `.enc`. The tool runs the database migrations, loads everything in one transaction (all or nothing), and fixes the id counters so new orders continue after the old ones.
4. Point the app at it: on Render change `DATABASE_URL` to the new database and redeploy. Check `/health`, sign in to Admin and open the latest orders.
5. Customers will have to sign in again (sessions are not backed up). Open orders, delivery codes and private order links keep working.
6. Anything that happened after the backup time is lost. Check recent Paystack payments in the Paystack dashboard and compare with your orders list.

If the tool says tables are missing, run it from the same version of the code that made the backup (or newer).

## 4. Practice run (do this before launch, and every few months)

1. Download the latest backup.
2. Create a free local or throw-away Postgres database.
3. Run the restore command above against it.
4. Start the app against that database (`DATABASE_URL=... npm start`), sign in to Admin and look at the orders.
5. Delete the throw-away database.

If any step surprises you, fix the documentation or the process now.

## 5. Other bad days

- **The site is down:** check `/health`. A 503 means the app is running but cannot reach the database. Look at Supabase status, then Render logs.
- **Finding what went wrong:** every log line has a request id, and server errors include it in the response (`requestId`) and in the `X-Request-Id` header, so a customer or you can quote it. Search for it in Render > Logs. Logs show paths but never query strings, so order-link tokens are not in them.
- **Jobs piling up (emails not sent):** Admin > Settings > Status shows jobs waiting and warns if the worker looks stuck. Restart the Render service, then retry failed jobs under Marketing.
- **Someone has Admin access who should not:** change the password, delete their user, and read Admin's activity log (`/api/admin/audit`) to see what they did.
