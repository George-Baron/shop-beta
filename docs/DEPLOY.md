# Deploying Shop-Beta (go-live guide)

Target: **launch Monday 4 January 2027**, code freeze **Sunday 20 December 2026**. Hosting plan: 2 Render Standard instances + Supabase Pro (about $75 a month), Cloudflare free, Resend and Paystack as below.

**How to read this.** Every step says who does it. "You" = the account owner (you must log in to Render, Supabase, Cloudflare, Resend, Paystack and your domain registrar; I cannot do that for you). Steps marked **ASK** cost money or are hard to undo: do not do them until you have decided.
**What I could and could not check.** The shop side of this guide (every setting, start-up checks, health checks, migrations, restore, the checker `npm run preflight`) is tested on my side. I could **not** log in to any of the five services, so their screen names and prices are from my knowledge and may have moved a little: where a vendor fact matters I say "check". Anything marked *Not verified* needs your eyes.

Related guides: `docs/DATABASE.md` (Supabase, cutover from SQLite), `docs/STORAGE.md` (photos), `docs/OPERATIONS.md` (logs, alerts, backups, restore), `docs/SECURITY.md`, `docs/LOAD-TEST.md`.

---
## 0. Money (decide before you start)
| Item | Cost | Needed? |
|---|---|---|
| Render: 2 x Standard web instances | about $25 each a month | Yes. **Check** that your Render workspace plan allows 2 instances of a Standard service (manual scaling); some features need a higher workspace plan. If it does, tell me before paying: the budget changes. |
| Supabase Pro | about $25 a month (includes daily backups and Storage) | Yes. Point-in-time recovery is a paid add-on: **not needed, do not enable.** |
| Cloudflare Free | $0 | Yes (DNS, HTTPS, caching) |
| Resend | Free plan has a small daily and monthly sending limit (**check** resend.com/pricing; I believe 100 emails a day). Order, payment and cart-reminder emails count. If launch week could exceed it, the paid plan is **ASK**. | Yes |
| Paystack | no monthly fee; a percentage per successful payment | Yes |
| Domain name | whatever your registrar charges | Yes |
| Staging for the load test (second Render service + second Supabase project) | a day or two of Render time; Supabase Pro per project | **ASK** (see docs/LOAD-TEST.md) |
| Uptime monitor (UptimeRobot free / Better Stack free / Cloudflare) | $0 | Yes |

## 1. Timeline (a proposal; move it if you like, but the order matters)
| By | What |
|---|---|
| Fri 20 Nov | You decide: domain and the one address customers use (`www.yourdomain.com` or the bare domain), approve the paid items above. Create the accounts (sections 3-7). **Start Paystack's business verification now: going live needs it and it can take days.** |
| Fri 27 Nov | Staging running (sections 3-8) with Paystack TEST keys; test orders, test payments and a test email work. |
| Fri 4 Dec | Load test on staging (docs/LOAD-TEST.md). |
| Fri 11 Dec | Cutover rehearsal: import a copy of the live shop's data into staging (section 9), restore a backup (docs/OPERATIONS.md section 5). |
| **Sun 20 Dec** | **Code freeze.** Merge `rebuild/scale` into `main`. After this only fixes. |
| 21-27 Dec | Create production (Supabase, Render). Paystack LIVE keys. Cloudflare ready but DNS not switched. `npm run preflight` all green. One real ₦ payment. |
| Mon 28 Dec | Final rehearsal. Lower DNS TTL (section 7). |
| **Sun 3 Jan, late night** | Cutover (section 10) in the quiet hours. |
| **Mon 4 Jan** | Launch. Watch (section 12). |
| to 18 Jan | Keep the old shop untouched (it is the rollback). |

## 2. Every setting (environment variables)
Set these on Render (Environment tab). Never put a secret in the repository or in chat. `.env.example` lists the same names with comments; `npm run test:docs` fails if a variable exists in the code but not here.
**Secret** = treat like a password. **Req** = needed in production.

### Core
| Variable | Req | Secret | Value / default | What it does |
|---|---|---|---|---|
| `NODE_ENV` | yes | no | `production` | Strict start-up checks, Secure cookies, refuses local photo storage. |
| `NODE_VERSION` | yes (Render only) | no | `22` | Tells Render which Node to use (the app needs 22.13 or newer). Not read by the code. |
| `PORT` | no | no | Render sets it | Port the server listens on. |
| `HOST` | no | no | all addresses | Address to listen on. Leave empty. |
| `BASE_URL` | yes | no | `https://www.yourdomain.com` | Public address, no trailing slash. Used in emails and Paystack return links and to decide Secure cookies. Must be the address customers use. |
| `TRUST_PROXY` | yes | no | `1` = Render alone, `2` = Cloudflare in front of Render, `0` = none | How many proxies to believe when reading the visitor's IP (see section 7). |
| `TZ_OFFSET_HOURS` | no | no | `1` | Hours ahead of UTC for "today" in the dashboard (Nigeria = 1). |
| `INSTANCE_ID` | no | no | empty | Optional label for an instance in logs and the `X-Instance` header. |
| `RENDER_INSTANCE_ID` | no | no | Render sets it | Used as the instance label when `INSTANCE_ID` is empty. Do not set. |
| `DRAIN_MS` | no | no | `3000` | Milliseconds an instance keeps answering after Render asks it to stop, while the balancer moves traffic away. |
| `SEED_DEMO` | yes | no | `0` | `0` = never create the 60 demo products. **Always `0` in staging-with-real-data and production.** |

### Database (Supabase) - docs/DATABASE.md
| Variable | Req | Secret | Value / default | What it does |
|---|---|---|---|---|
| `DATABASE_URL` | yes | **yes** | Supabase **Transaction pooler** string, port 6543 | What the running shop uses. |
| `MIGRATE_DATABASE_URL` | yes | **yes** | Supabase **Session pooler** string, port 5432 | Used only for schema updates, imports and restore. |
| `PGSSL` | no | no | empty (automatic) | `require`, `verify-full` or `disable` (local only). |
| `PG_POOL_MAX` | no | no | `10` | Connections per instance. 2 instances x 10 = 20; keep under your Supabase limit. |
| `PG_STATEMENT_TIMEOUT_MS` | no | no | `20000` | A query running longer than this is cancelled. |
| `MIGRATE_ON_START` | no | no | on | `0` = do not apply migrations when the server starts (then run `npm run migrate` yourself). Two instances starting together are safe either way. |

### Admin account - docs/SECURITY.md
| Variable | Req | Secret | Value / default | What it does |
|---|---|---|---|---|
| `ADMIN_EMAIL` | first start | no | your email | With `ADMIN_PASSWORD`, creates the owner account if none exists. |
| `ADMIN_PASSWORD` | first start | **yes** | 12+ characters | Remove it from Render after the first start. |
| `ADMIN_SETUP_CODE` | optional | **yes** | 8+ characters | Alternative: lets you create the owner on `/admin` with this code. Leave empty to switch that page off. |

### Payments and email
| Variable | Req | Secret | Value / default | What it does |
|---|---|---|---|---|
| `PAYSTACK_SECRET_KEY` | yes | **yes** | `sk_test_...` on staging, `sk_live_...` in production | Starts payments, checks the signed webhook, verifies each payment. Empty = demo mode (no real money). |
| `RESEND_API_KEY` | yes | **yes** | `re_...` | Sends email. Empty = emails are only stored. |
| `MAIL_FROM` | yes | no | `Shop-Beta <orders@yourdomain.com>` | Sender; the domain must be verified in Resend. |

### Photos and backups storage (Supabase Storage) - docs/STORAGE.md
| Variable | Req | Secret | Value / default | What it does |
|---|---|---|---|---|
| `SUPABASE_URL` | yes | no | `https://<project-ref>.supabase.co` | Project address. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **yes** | the `service_role` key | Server-only key. Never in a browser, the repo or the admin screen. |
| `SUPABASE_BUCKET` | no | no | `shop-images` | Public bucket for product photos. |
| `PUBLIC_IMAGE_BASE_URL` | no | no | empty | Optional own image address or CDN in front of the bucket. |
| `STORAGE_DRIVER` | no | no | empty (automatic) | Leave empty. `local` is for development only and is refused in production. |
| `DATA_DIR` | no | no | `./data` | Development only: folder for local photos. |
| `BACKUP_BUCKET` | no | no | `db-backups` | **Private** bucket for nightly database backups (created automatically). |

### Caching - docs/CACHING.md
| Variable | Req | Secret | Value / default | What it does |
|---|---|---|---|---|
| `EDGE_CACHE_SECONDS` | no | no | `30` | Seconds Cloudflare/browsers may keep shared catalogue answers. `0` = do not share. |
| `CACHE_POLL_MS` | no | no | `2000` | How often an instance checks whether another changed the catalogue. |
| `CACHE_MAX_ENTRIES` | no | no | `3000` | Cache size per instance. |
| `CACHE_DISABLED` | no | no | empty | `1` = server cache off (debugging only; the checker fails if set in production). |

### Background worker - docs/JOBS.md
| Variable | Req | Secret | Value / default | What it does |
|---|---|---|---|---|
| `WORKER` | no | no | on | `0` = this instance takes no jobs (emails and payment confirmations would wait). Leave on. |
| `WORKER_CONCURRENCY` | no | no | `4` | Jobs one instance runs at once. |
| `WORKER_POLL_MS` | no | no | `1000` | How often it looks for jobs. |
| `JOB_LEASE_SECONDS` | no | no | `300` | How long a worker may hold a job before another takes it. |
| `JOB_BACKOFF_BASE_SECONDS` | no | no | `30` | First retry delay (it grows each time). |

### Logs, alerts, backups - docs/OPERATIONS.md
| Variable | Req | Secret | Value / default | What it does |
|---|---|---|---|---|
| `LOG_FORMAT` | no | no | automatic (JSON in production) | `json` or `text`. |
| `LOG_LEVEL` | no | no | `info` | `debug`, `info`, `warn`, `error`. |
| `LOG_REQUESTS` | no | no | `errors` | Which requests get a log line: `errors` (failed, slow, checkout, webhook), `all`, `off`. |
| `SLOW_MS` | no | no | `800` | A request slower than this is logged. |
| `ALERT_EMAIL` | yes | no | your email(s), comma separated | Gets an email when a new error or a failed backup happens (needs `RESEND_API_KEY`). |
| `ALERT_WEBHOOK_URL` | optional | **yes** | Slack/Discord webhook URL | Same alerts in a chat channel. |
| `ALERT_REPEAT_MINUTES` | no | no | `60` | Same error alerts again at most this often. |
| `ALERT_MAX_PER_HOUR` | no | no | `20` | Overall alert cap per hour. |
| `BACKUPS` | no | no | on | `0` = nightly backups off (do not do this in production). |
| `BACKUP_KEEP` | no | no | `14` | Number of nightly backups kept. |
| `BACKUP_HOUR_LAGOS` | no | no | `3` | Nightly backup hour (Lagos time). |
| `BACKUP_MAX_AGE_HOURS` | no | no | `36` | `/health/deep` turns red if no backup succeeded within this. |

### Rate limits - docs/SECURITY.md
| Variable | Req | Secret | Value / default | What it does |
|---|---|---|---|---|
| `RATE_IP_CHECKOUT`, `RATE_IP_LOGIN`, and `RATE_IP_<NAME>` for the other limits | no | no | built-in loose ceilings | Raise a per-IP ceiling (only for load tests). Limits per phone/email are fixed in code. |

### Tests and load tests ONLY (never on a real server; `npm run preflight` fails if they are set)
| Variable | Meaning |
|---|---|
| `RATE_LIMITS` | `off` switches rate limits off (ignored when `NODE_ENV=production`). |
| `PAYSTACK_API_URL` | Points the app at a fake Paystack. |
| `RESEND_API_URL` | Points the app at a fake Resend. |

### The go-live checker
`npm run preflight -- --env-file /path/production.env --expect live --online` reads the settings (keep that file outside the repository, delete it afterwards), prints PASS/WARN/FAIL per line, never prints a secret, and with `--online` also connects to the database, Paystack and Supabase Storage. It catches the classic mistakes: test key on the live site, `resend.dev` sender, `[YOUR-PASSWORD]` left in the database address, public backup bucket, demo products on, test switches left on. Run it with `--expect test` for staging.

---
## 3. Supabase (you)
1. supabase.com > **New project**. Name `shop-beta-prod`. **Region:** the same area as Render (see section 5). Set a long database password and **save it in a password manager**.
2. **ASK:** upgrade the organisation to **Pro** (Billing). Do not add point-in-time recovery or compute upgrades.
3. **Connect** button (top bar) > copy two strings and replace `[YOUR-PASSWORD]` by the password. If the password has characters like `@ # / : ?` URL-encode them (or choose letters and digits only):
   - **Transaction pooler** (port **6543**) -> `DATABASE_URL`
   - **Session pooler** (port **5432**) -> `MIGRATE_DATABASE_URL`
4. **Project Settings > API:** copy the **Project URL** -> `SUPABASE_URL`, and the **service_role** key -> `SUPABASE_SERVICE_ROLE_KEY`. (Not the anon key. The service key bypasses all protection: only ever on Render.)
5. **Storage > New bucket** `shop-images`, switch **Public bucket ON**. (The shop also creates it at first start if missing.) The backup bucket `db-backups` is created by the shop **private**; check in Storage that it shows as private.
6. **Storage > Settings:** note the upload file size limit (default 50 MB). If the database ever grows beyond that, raise it, or nightly backups will fail (you would be alerted).
7. **Database > Backups:** confirm daily backups are listed (Pro). 
8. Check: `npm run preflight -- --online ...` shows "Database connects", the bucket lines and no FAIL.

## 4. Resend (you)
1. resend.com > create account. **Domains > Add Domain** `yourdomain.com` (choose the region closest to Render).
2. Resend shows DNS records (SPF and DKIM TXT, usually an MX/TXT for a `send` sub-name). Add them at your DNS (Cloudflare, section 7) as **DNS only** (grey cloud), then **Verify**. Wait until the domain shows *Verified*.
3. **API Keys > Create API Key**, permission **Sending access**, domain `yourdomain.com` -> `RESEND_API_KEY`.
4. `MAIL_FROM=Shop-Beta <orders@yourdomain.com>` (must be on the verified domain; `resend.dev` only delivers to your own address).
5. Also add a DMARC record at DNS: `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:you@yourdomain.com` (improves delivery to Gmail/Yahoo).
6. Test: place a staging order with your own email; the confirmation must arrive (not in spam). Admin > Jobs & backups shows failed email jobs if not.
7. *Not verified:* the free-plan limit and the current Resend screens.

## 5. Render (you)
**Region:** pick the Render region closest to your Supabase project (same city is best, so each database call is fast). Render has no African region and Supabase has one in South Africa; check both lists. Europe (Frankfurt) is the usual compromise for Nigeria; Cloudflare caching in front hides most of the distance for browsing.
Do this first for **staging** (`shop-beta-staging`, branch `rebuild/scale`, TEST keys), then again for **production** (`shop-beta`, branch `main`, LIVE keys).
1. render.com > **New > Web Service** > connect GitHub `George-Baron/shop-beta` > choose the branch.
2. **Runtime** Node. **Build command** `npm ci --omit=dev`. **Start command** `npm start`.
3. **Instance type** Standard. **Instances: 2** (Scaling). 
4. **Health Check Path** `/health` (shallow and fast: Render uses it to decide when a new version is ready and when an instance is sick).
5. **Environment:** add every Required variable from section 2 (production values). `NODE_ENV=production`, `NODE_VERSION=22`, `SEED_DEMO=0`, `TRUST_PROXY` per section 7, `ADMIN_EMAIL` + `ADMIN_PASSWORD` for the first start only.
6. **Auto-Deploy:** staging On. **Production Off** (you press *Manual Deploy* after tests pass; nothing reaches customers by accident).
7. Create. The first deploy applies the database migrations by itself (one instance waits for the other). Watch **Logs**: you should see `Database migrated: ...`, `Administrator account created for ...`, `listening`.
8. Check `https://<name>.onrender.com/health` (shallow) and `/health/deep` (database, jobs, backup; "no backup yet" is fine for the first day).
9. Deploys are rolling: Render starts the new version, waits for `/health`, moves traffic, then stops the old one; each instance finishes its requests first. In the load tests with an instance restart, browsing requests never failed; at most one checkout request that was in flight to the stopping instance was cut off (the shop page then retries with the same key, which never duplicates an order).

## 6. Paystack (you)
**Test mode first (staging):**
1. paystack.com > create the business account. Complete **business verification** (this is what enables LIVE payments; start early). Add your settlement bank account.
2. **Settings > API Keys & Webhooks** (the Test/Live switch is at the top). Copy the **Test Secret Key** -> staging `PAYSTACK_SECRET_KEY`.
3. In the same page set the **Test Webhook URL** to `https://<staging>.onrender.com/api/paystack/webhook`. (Use the Render address, not your domain: it skips Cloudflare, so Cloudflare can never block Paystack's calls. The webhook is protected by Paystack's signature, not by being secret.) Leave the callback URL empty: the shop sends the right return address with each payment.
4. Place a staging order and choose online payment. Paystack's test-payments page (paystack.com/docs/payments/test-payments) lists test cards; use a successful one with any future expiry date and the test PIN/OTP it shows. After paying you must land on your order page marked **paid** within seconds, and a confirmation email must arrive. Also try a failed card and closing the payment window: the order must stay unpaid and the stock must come back after the unpaid-order timeout.
5. In Paystack **Logs > Webhooks** every call should show status 200.

**Switching test to live (production, after verification and on cutover day, never before):**
1. Paystack dashboard: switch to **Live**. Copy the **Live Secret Key**.
2. Set the **Live Webhook URL** to `https://<production>.onrender.com/api/paystack/webhook` (it is a separate field from the test one).
3. Render production > Environment: `PAYSTACK_SECRET_KEY=sk_live_...` > save > the service redeploys.
4. `npm run preflight -- --env-file production.env --expect live --online` must say "Paystack key is a LIVE key" and "Paystack accepts the secret key".
5. Make one real payment of the smallest amount you can with your own card. Check: order marked paid, email received, Paystack shows the transaction and a 200 webhook. Then refund it from the Paystack dashboard (and mark the order refunded in Admin > Orders; the shop only records refunds).
6. A mismatch (live webhook URL with a test key, or the reverse) makes every payment look unconfirmed: Paystack takes the money, the shop never marks it paid. The Admin error list and the Paystack webhook log show 401 if that happens.

## 7. Cloudflare and the domain (you)
1. cloudflare.com > **Add a site** `yourdomain.com` > Free plan. **Before changing anything, copy every existing DNS record** (especially MX = your email, and Resend's records). Cloudflare imports most, but check each.
2. At your registrar change the **nameservers** to the two Cloudflare gives you (do this days before launch, not on the night; the website is unaffected as long as the records are the same).
3. **SSL/TLS > Overview:** mode **Full (strict)**. **Edge Certificates:** Always Use HTTPS **On**, Minimum TLS 1.2.
4. In Render production **Settings > Custom Domains:** add your customer address (`www.yourdomain.com`) and the bare domain. Render tells you the DNS records. In Cloudflare DNS create `www` **CNAME** -> `<production>.onrender.com`. Keep it **DNS only (grey cloud)** until Render shows the domain verified with a certificate, then turn the **proxy on (orange cloud)**.
5. Pick one customer address and redirect the other: Cloudflare **Rules > Redirect Rules**: bare domain -> `https://www.yourdomain.com` (301, keep path). `BASE_URL` must be the one you chose.
6. **TTL:** records that are DNS-only have a TTL; set it to 5 minutes (300 s) the week before cutover so a switch back is fast. Proxied records change within seconds.
7. **Caching:** add the one Cache Rule from `docs/CACHING.md`. Do not cache the page HTML, `/api/config`, `/api/me`, `/api/admin`, `/api/checkout`.
8. **Do not turn on Bot Fight Mode / Under Attack mode / challenge rules on the whole site** before testing: they can block real shoppers on mobile networks and Paystack. (Paystack calls Render directly, as set in section 6, so it is not affected.)
9. **TRUST_PROXY:** with Cloudflare in front of Render set `TRUST_PROXY=2`; with only Render set `1`. Check it once on staging/production: open `https://yourdomain.com/api/nope` on your phone using mobile data (not Wi-Fi), then in Render Logs find the line with `"path":"/api/nope"` and read its `ip`. It must be **your phone's public address** (search "what is my IP" on the phone). If you see an address starting `104.`, `172.64-71.`, `162.158.` or `141.101.` that is Cloudflare: raise `TRUST_PROXY` by one. If you see an address that is not yours and not Cloudflare, lower it. A wrong value makes all shoppers look like one person for the per-IP safety limits (checkout and sign-in are limited per phone number and email first, so shoppers are not blocked, but the safety net is weaker).
   *Known limit:* someone who goes straight to the `onrender.com` address (skipping Cloudflare) can fake their IP address. That only weakens the loose per-IP ceilings; the per-person limits do not depend on it.
10. *Not verified:* all Cloudflare screens and the cache hit (look for `cf-cache-status: HIT` on a second request of a product API URL).

## 8. Uptime monitor (you)
Set up the free monitors in `docs/OPERATIONS.md` section 3: `https://yourdomain.com/health/deep` and the home page, 5-minute checks, alerts to your phone. Test it by suspending staging for 10 minutes and confirming the alert arrives.

## 9. Moving the live shop's data (SQLite -> Supabase)
The current shop keeps everything in a `shop.db` file and photos in `data/uploads/`. Follow `docs/DATABASE.md` section 4 (import) and `docs/STORAGE.md` (photos: `npm run migrate:images`). Rules that matter:
- **The Supabase database must be empty when you import**, and the shop must not have been started on it yet, or demo/default data gets in the way. Set `SEED_DEMO=0`.
- Rehearse with `--dry-run` on staging first (section 1: 11 Dec). Keep the original `shop.db` and `uploads` untouched: they are your rollback.
- After the import: check counts in the import report, open a few products and old orders, sign in with an old customer account (passwords keep working).

## 10. Cutover night (Sunday 3 January, quiet hours; allow 2-3 hours)
Print this. Tick as you go. Nothing here is rushed: if a step fails, stop and use section 13.
1. [ ] Production is created and tested (sections 3-8) but customers still use the old shop. Old shop's `shop.db` copied and safe.
2. [ ] `npm run preflight -- --env-file production.env --expect live --online`: no FAIL; read every WARN.
3. [ ] Put the old shop in maintenance (stop it) so no order arrives during the copy. Note the time.
4. [ ] Final copy of `shop.db` and `data/uploads/`. Import dry run, then the real import (section 9). Counts match.
5. [ ] Photos migrated; open 3 product pages and check photos.
6. [ ] Render production: set `PAYSTACK_SECRET_KEY` to the LIVE key and the Live Webhook URL (section 6), `ADMIN_EMAIL`/`ADMIN_PASSWORD` if no administrator came with the import. **Manual Deploy.** Logs show migrations OK and `listening` on both instances.
7. [ ] `/health/deep` is green (backup says "no backup yet": press **Admin > Jobs & backups > Back up now** and wait for it to show ok).
8. [ ] Sign in to `/admin` (Render address). Check Settings (store name, delivery fees by state, free-delivery amount, WhatsApp/contacts) and a department homepage.
9. [ ] Place a pay-on-delivery order and one real small online payment; both emails arrive; mark the real one refunded after refunding in Paystack. Cancel the test orders (stock returns).
10. [ ] Cloudflare DNS: point the customer address at production (orange cloud on). Open it on mobile data. Check TRUST_PROXY (section 7 step 9).
11. [ ] Remove `ADMIN_PASSWORD` from Render environment. Save a fresh **downloaded backup** to your own storage.
12. [ ] Tell the uptime monitor the new address; confirm green.
13. [ ] Do not touch the old shop. Go to sleep; you will be alerted.

## 11. Go-live checklist (all must be ticked before Monday 4 Jan)
**Accounts and money:** [ ] Render allows 2 Standard instances, budget approved. [ ] Supabase Pro on. [ ] Paystack business verified, settlement account added. [ ] Resend domain verified, sending limit understood. [ ] Domain nameservers on Cloudflare.
**Settings:** [ ] `npm run preflight --expect live --online` has no FAIL. [ ] `SEED_DEMO=0`. [ ] `ADMIN_PASSWORD` removed after first start. [ ] `ALERT_EMAIL` set and a test alert received. [ ] Test switches (`RATE_LIMITS`, `PAYSTACK_API_URL`, `RESEND_API_URL`, `CACHE_DISABLED`) not set.
**Behaviour:** [ ] POD order works. [ ] Online payment works (test mode on staging, one real payment in production) and the webhook shows 200. [ ] Confirmation email arrives and is not in spam. [ ] Out-of-stock item cannot be ordered. [ ] Cancel and refund of an order work. [ ] Admin login, product edit with photo upload, order status change work. [ ] Each department homepage opens.
**Safety:** [ ] Nightly backup ran and shows ok; a backup **downloaded** and kept outside Supabase. [ ] A restore was rehearsed (docs/OPERATIONS.md 5). [ ] `/health/deep` monitored and an alert tested. [ ] Load test passed on staging (docs/LOAD-TEST.md). [ ] Nothing public in `db-backups`. [ ] No secret in the repo (`npm run test:docs` passes).
**Rollback:** [ ] Old shop and `shop.db` untouched and still startable. [ ] DNS TTL 5 minutes. [ ] You know section 13.

## 12. After launch: first 48 hours
Check morning and evening for the first week: Admin > **Jobs & backups** (errors open? failed jobs? last backup), Render **Metrics** (CPU under about 70%, memory steady), Supabase **Reports** (connections, CPU), Paystack > Transactions vs Admin > Orders (every paid transaction has a paid order), Resend > Logs (bounces). Orders stuck "pending" with a paid Paystack transaction mean the webhook is failing: check the Live Webhook URL and key (section 6 step 6). After the code freeze only fix bugs; deploy by Manual Deploy, outside peak hours (Nigerian evenings are busy), after the tests pass: `npm run test:all` on your machine or on staging first.

## 13. Rollback
Decide quickly; each option says what you lose.
| Situation | Do this | You lose / watch for |
|---|---|---|
| A new code version misbehaves, **no database change in it** | Render > Events/Deploys > pick the previous good deploy > **Rollback** (about a minute) | Nothing. |
| The bad version included a database migration | Do **not** roll the code back blindly: the old code may not understand the new tables. Fix forward (small fix, Manual Deploy), or restore the database from the last backup (docs/OPERATIONS.md 5) and roll back the code together. | Orders after that backup. |
| Payments are not being confirmed | Check the key/webhook pair (section 6). Customers who paid have a Paystack transaction; mark those orders paid in Admin after verifying in Paystack. | Nothing if handled in time. |
| Whole new shop is unusable on or soon after launch | Cloudflare DNS: point the customer address back to the old shop (TTL 5 minutes). Stop the new shop's emails if needed (suspend the service). Old shop's data is intact. | Orders placed on the new shop since cutover exist only in the new database (Admin > Orders, or the nightly backup): copy them into the old shop by hand, and contact those customers. |
| Data damage (bad import, deleted products) | Restore the last backup into a **new empty database first**, check it, then (with your say-so) restore with `--replace` into production. | Orders since the backup. |
| Paystack live causes trouble | Set `PAYSTACK_SECRET_KEY` back to the test key only on staging; in production remove online payment by clearing the key (pay on delivery keeps working, online payment shows demo mode: **tell customers**) or suspend the site. | Online payments pause. |
Keep the old shop and its `shop.db` untouched until Monday 18 January 2027, then archive them.

## 14. Troubleshooting
| Symptom | Likely cause and fix |
|---|---|
| Deploy fails at start with a message about the administrator | No admin exists and no `ADMIN_EMAIL` + `ADMIN_PASSWORD` (12+ chars) or `ADMIN_SETUP_CODE` is set. Set them (section 2). |
| `DATABASE_URL is not set` / cannot connect | Wrong string, `[YOUR-PASSWORD]` left in, special characters not URL-encoded, or you used the session string for `DATABASE_URL`. Run preflight `--online`. |
| Migrations hang or fail | `MIGRATE_DATABASE_URL` must be the Session pooler (5432), not 6543. |
| Photos disappear after a deploy | `STORAGE_DRIVER=local` or Supabase keys missing. Production refuses local; check preflight. |
| Customers get no emails | `RESEND_API_KEY` missing, domain not verified, or `MAIL_FROM` uses `resend.dev`. Admin > Jobs shows failed email jobs with the reason; press Try again after fixing. |
| Paid orders stay unpaid | Webhook URL wrong or key/webhook pair mismatched (section 6). Check Paystack > Logs > Webhooks. |
| Everyone gets "too many requests" | Per-IP limits seeing one address: `TRUST_PROXY` wrong (section 7 step 9). |
| `/health/deep` returns 503 | Read the `checks` in the answer: database, jobs waiting over 10 minutes (is a worker disabled?), or no backup within 36 hours (Admin > Jobs & backups shows why; docs/OPERATIONS.md). |
| Site slow only in the evening | Render Metrics CPU near 100% on both instances: ask me before changing instance size (paid). Also check Supabase connections. |
