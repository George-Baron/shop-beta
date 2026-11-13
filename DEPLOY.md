# Putting Shop-Beta online: the complete go-live guide

This guide takes you from "the code is on GitHub" to "customers can order". Do the parts in order. Each part says what to click, what to copy, and how to know it worked. Screens on Render, Supabase, Cloudflare, Paystack, Resend and Geoapify change names now and then; if a button is not where this says, look for the closest word.

**Time:** about half a day for the first time, plus a few days for domain, Paystack and email verification to be approved.
**Costs:** check the pricing pages (render.com/pricing, supabase.com/pricing, resend.com/pricing, geoapify.com/pricing). Cloudflare's free plan is enough. The launch plan we chose assumed roughly $75 a month for hosting; confirm against today's prices.
**Never** paste secret keys into GitHub, WhatsApp, or a screenshot. They go only into Render's Environment tab (and a password manager).

---

## The picture

```
Customer ──> Cloudflare (free: https, caching, attack shield)
                  │
                  ▼
        Render: Shop-Beta app (1 to 2 instances, also runs the background worker)
           │            │             │               │
           ▼            ▼             ▼               ▼
   Supabase Postgres  Supabase     Paystack        Resend (email)
   (orders, users…)   Storage      (payments)      Geoapify (maps)
                      (photos, private backups)
```

Things you must keep safe: the Supabase database password and service-role key, the Paystack secret key, `BACKUP_PASSPHRASE`, `HANDOVER_SECRET`, and your admin password.

---

## Part 1. Supabase (database and file storage)

1. Sign up at supabase.com and create a **New project**.
   - **Region:** choose the one closest to where you will run Render (both in Europe, for example Frankfurt or London). Keep Render and Supabase in the **same region**: every page asks the database several questions, and distance adds delay to each.
   - Set a long **database password** and save it in your password manager. You cannot read it again later (you can only reset it).
2. **Connection string.** Open the project's **Connect** (or Project Settings > Database) page and copy the **Transaction pooler** string. It uses port **6543**. Replace `[YOUR-PASSWORD]` with your database password. This is your `DATABASE_URL`.
   - Why the pooler: two app instances share connections safely, and a busy moment cannot exhaust the database. The app is written to work with it (no session features are used).
3. **Photo bucket.** Storage > **New bucket** > name exactly `product-images` > tick **Public bucket** > Create.
4. **Backup bucket.** Storage > New bucket > name exactly `backups` > leave **Public OFF** (private). Backups contain customer data.
5. **API keys.** Project Settings > API (or API Keys): copy the **Project URL** (`https://xxxx.supabase.co`, this is `SUPABASE_URL`) and the **service_role** secret key (this is `SUPABASE_SERVICE_ROLE_KEY`). The service-role key can do anything to your project. It goes only into Render, never into the browser or GitHub.
6. Supabase has its own daily backups on paid plans. Turn them on (Database > Backups) in addition to the app's nightly backup.

**Database certificate.** The app checks the database's certificate. If the first deploy fails with `self-signed certificate in certificate chain`, either download your project's certificate from Supabase (Database settings, SSL section) and paste its text into `DATABASE_CA`, or as a last resort set `DATABASE_SSL=no-verify` (still encrypted, but does not verify who it is talking to).

Done when: you have `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and two buckets.

---

## Part 2. Resend (order emails)

1. Sign up at resend.com. **Domains > Add domain** (use your shop's domain, for example `yourshop.com`).
2. Resend shows DNS records (SPF, DKIM and so on). Add them where your domain's DNS is managed (Cloudflare, after Part 7, or your registrar). Wait until Resend shows the domain as **Verified**.
3. **API Keys > Create** with sending permission. Copy it: this is `RESEND_API_KEY`.
4. `MAIL_FROM` is the sender line, for example `Shop-Beta <orders@yourshop.com>`. The address must be on the verified domain.

Without these, orders still work but customers get no email (messages are only stored in Admin > Marketing).

---

## Part 3. Paystack (card payments)

1. Create a Paystack account. You can test straight away with **test keys**; going live needs Paystack to verify your business.
2. Settings > **API Keys & Webhooks**: copy the **Secret key** (`sk_test_...` for now). That is `PAYSTACK_SECRET_KEY`. Never use the public key (`pk_...`) here.
3. In the same page set the **Webhook URL** to `https://YOUR-SHOP-ADDRESS/api/paystack/webhook`. The app checks Paystack's signature on every call, so forged webhooks are rejected.
4. At launch you will swap in the `sk_live_...` key and set the live webhook the same way (Part 10).

How payments are protected: the app only marks an order paid when Paystack confirms the exact reference, the Naira currency and the exact amount.

---

## Part 4. Geoapify (maps and delivery times)

1. Sign up at geoapify.com (the free plan is enough to start). Create a project and copy the **API key**: this is `GEOAPIFY_API_KEY`.
2. Restrict the key to your domain in Geoapify's key settings, because the map tiles use it in the browser.
3. If you skip this, checkout still works but distance and time quotes become rough straight-line estimates.

---

## Part 5. Render (the app)

1. Your code must be on GitHub (`George-Baron/shop-beta`). Connect GitHub to Render when asked.
2. **Easiest:** Render > **New > Blueprint** > choose the repo. It reads `render.yaml` and asks you for every secret value. Or create a **Web Service** by hand with these settings:
   - Runtime **Node**, region the same as Supabase.
   - Build command `npm ci --omit=dev`, start command `npm start`.
   - **Health check path** `/health`.
   - Instance type: start with one paid instance. The free instance sleeps when idle and is not suitable for a shop.
3. **Environment** tab: fill in the values below. The full list with explanations is at the end of this guide.

| Setting | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22.13.0` (or newer 22) |
| `SEED_DEMO` | `0` (no demo products on your first start) |
| `BASE_URL` | your public address, `https://www.yourshop.com`, no trailing slash. Use the `onrender.com` address until the domain works |
| `DATABASE_URL` | Part 1 |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Part 1 |
| `PAYSTACK_SECRET_KEY` | Part 3 (test key first) |
| `RESEND_API_KEY`, `MAIL_FROM` | Part 2 |
| `GEOAPIFY_API_KEY` | Part 4 |
| `HANDOVER_SECRET` | a long random text (Render can generate it). **Do not change it after launch**: delivery codes already shown to customers are derived from it |
| `BACKUP_PASSPHRASE` | long random phrase. **Keep a copy outside Render.** Without it, backups cannot be opened |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | your owner login (12+ characters). Or use `SETUP_CODE` instead (Part 6) |

4. Deploy. In **Logs** you should see `Applied migration 001...` through `006...`, then the server starting. Open `https://YOUR-SERVICE.onrender.com/health`: it must answer `{"ok":true}`.

**Two instances.** Once one instance works, raise the instance count to 2 (the plan we chose). Both run the background worker; the job queue is built so that they never do the same job twice. With 2 instances and the default `DB_POOL_MAX=10` you use at most 20 database connections, well inside what the Supabase pooler allows.

**Updating later.** Push to GitHub, Render rebuilds and swaps instances. Database changes apply automatically at start and are safe when two instances start together. Before a deploy that adds migrations, press **Back up now** (Admin > Settings > Status and backups).

---

## Part 6. First start: your admin account

- If you set `ADMIN_EMAIL` and `ADMIN_PASSWORD`, the owner account is created at start. Sign in at `/admin`. Then you may delete `ADMIN_PASSWORD` from Render.
- Otherwise set `SETUP_CODE` to a long random value, open `/admin` once, and create the owner with that code. In production the setup page is closed without a code, so a stranger cannot take it over.
- Add your **real products** (Admin > Products), delivery zones and settings. If you have an old SQLite shop, see Part 8.
- Create staff accounts (sales, partner, rider) under the staff pages. Staff passwords need 12+ characters.

---

## Part 7. Your domain and Cloudflare

1. Buy or use your domain. Add it to Cloudflare (free plan) and change your registrar's nameservers to the two Cloudflare gives you.
2. In Render > your service > **Custom Domains**, add `www.yourshop.com` (and the bare domain if you want it). Render shows what DNS record to create. Create it in Cloudflare DNS with the orange cloud **Proxied**.
3. Cloudflare > SSL/TLS: set the mode to **Full (strict)**. Turn on **Always Use HTTPS**.
4. Update Render's `BASE_URL` to `https://www.yourshop.com` and redeploy. Also update the Paystack webhook URL (Part 3).
5. **Cache rule** (Caching > Cache Rules): for URLs starting with `/api/home/` or `/api/products` choose **Eligible for cache** and **Use cache-control header if present**. The app already marks those answers as cacheable for 30 seconds at the edge. Do **not** cache `/api/admin`, `/api/auth`, `/api/orders`, `/api/checkout` or anything signed-in (the app marks these private, but do not add a rule that overrides them).
6. Security > **WAF / Rate limiting**: add a free rate-limit rule for `/api/auth/login` and `/api/checkout` as a second layer (the app has its own limits too). Turn on Bot Fight Mode if available.
7. The app trusts the visitor's real IP from Cloudflare only for requests that really come through Cloudflare. Keep `TRUST_PROXY` unset (the default is on).

Check: `https://www.yourshop.com/health` answers `{"ok":true}` and the padlock shows.

---

## Part 8. Moving an existing shop (optional, one time)

Only if you have the old SQLite database (`data/shop.db`) and uploaded photos.

1. On your own computer, in the repo folder, with the same `DATABASE_URL` as Render:
   `DATABASE_URL="postgres://..." npm run import:sqlite -- path/to/shop.db --dry-run` first (it reports what it would copy), then again without `--dry-run`. It refuses to run if the database already has data, copies everything in one transaction, keeps all ids and order numbers, and compares row counts at the end.
2. Photos: `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL=... npm run migrate:uploads -- path/to/uploads --dry-run`, then without `--dry-run`. It never deletes the originals.
3. Keep the old files until you have checked the shop.

---

## Part 9. Rehearsal (do all of it before opening to customers)

Use the Paystack **test** key and your `onrender.com` or real domain. Tick each line:

- [ ] Home page, a department, a product page and search work, and photos show.
- [ ] Register a customer, sign out, sign in. Try a password like `password123`: it must be refused.
- [ ] **Card order** with Paystack's test card. The order turns Paid and a confirmation email arrives.
- [ ] **Pay on delivery** order: it waits for the phone confirmation; confirm it in Admin and it moves forward.
- [ ] **Delivery:** drop a pin at checkout, see distance, fee and promised time. Assign a rider, sign in as the rider on a phone, accept, pick up, start. The customer's order page shows the code; completing with the code works; a wrong code five times locks the delivery.
- [ ] Order lookup with only the order number and email shows status only (no phone or address). The private link from the email shows everything.
- [ ] **Backup:** Admin > Settings > Status and backups > Back up now. The file appears and downloads. Then **practise a restore** into a throw-away database with `docs/RESTORE.md`.
- [ ] Admin > Settings > Status shows no red warnings.
- [ ] **Load test** your staging copy, not the live shop: see `docs/LOAD_TEST.md`.
- [ ] Run the launch check (next part).

---

## Part 10. Go-live

1. **Launch check.** In Render > your service > **Shell**, run `npm run preflight`. (Or on your computer with the same environment variables set.) Every line must be PASS or a WARN you have decided on. Fix every FAIL. It checks, among other things: production mode, https address, database reachable and migrated, buckets exist with the right public/private setting, Paystack key type, email, backups encrypted, nothing test-only switched on.
2. **Switch Paystack to live:** replace `PAYSTACK_SECRET_KEY` with `sk_live_...`, set the live webhook URL in Paystack, redeploy. Place one small real order and refund it.
3. Remove `ADMIN_PASSWORD` from Render if you used it.
4. Confirm an uptime monitor (UptimeRobot or similar) watches `https://www.yourshop.com/health` and alerts your phone.
5. Add a line to your privacy policy: rider location points are kept for 30 days, then deleted.
6. Open the shop. Stay near your phone for the first day.

---

## Part 11. Looking after it

**Daily (2 minutes):** Admin > Settings > Status and backups: last backup is recent, no failed jobs, no red warning. Check orders waiting for phone confirmation (they auto-cancel after 24 hours).
**Weekly:** read the activity log (`/api/admin/audit`) for changes you did not make; check Paystack's dashboard against paid orders.
**Monthly:** practise a restore; look at Supabase database size and Render usage; update dependencies (`npm audit`).
**Logs:** Render > Logs. Every line has a request id. Customers who see an error get a `requestId` to quote; search for it. Logs never contain query strings, so order-link tokens are not in them.
**Roll back a bad deploy:** Render > Events/Deploys > redeploy a previous version. Database changes are forward-only, which is why you back up first.
**Secrets leaked or a staff member leaves:** change the password, delete the user, rotate the exposed key (Supabase, Paystack, Resend), and read the activity log.

---

## Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| Deploy fails, log says `self-signed certificate in certificate chain` | Database certificate: set `DATABASE_CA` or, last resort, `DATABASE_SSL=no-verify` (Part 1) |
| Server will not start: "Photos would be saved on this server's disk" | `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` missing |
| `/health` returns 503 | App is up but cannot reach the database: check `DATABASE_URL`, password, Supabase status |
| Photos do not show | `product-images` bucket is not public, or the photo migration was not run |
| Backups failing (red line in Admin) | `backups` bucket missing or public/private wrong; run `npm run preflight` |
| Customers get no emails | `RESEND_API_KEY` / `MAIL_FROM` missing, or the domain is not verified in Resend. Failed jobs are listed under Marketing with a retry button |
| Card payments say unavailable | `PAYSTACK_SECRET_KEY` missing (demo payments are blocked in production) |
| Paid on Paystack but order still pending | Webhook URL wrong or not saved in Paystack. The app also checks when the customer returns; use the order's page, or Paystack's "resend webhook" |
| Everyone gets "too many requests" | `TRUST_PROXY=0` set by mistake, or the domain is not proxied through Cloudflare and you changed trusted ranges. Remove `TRUST_PROXY`, check `CLOUDFLARE_RANGES` is empty |
| Admin cannot sign in after many tries | Failed-login limits are per IP and per account+IP and clear after 15 minutes |
| Delivery quotes look like straight lines | `GEOAPIFY_API_KEY` missing, or Geoapify is temporarily down (the app pauses and falls back) |
| Site slow only on first visit after quiet time | Free Render instance sleeping: use a paid instance |
| Delivery codes stopped matching | `HANDOVER_SECRET` was changed. Restore the old value |

---

## All settings, explained

**Required in production**

| Name | Meaning |
|---|---|
| `NODE_ENV` | `production` locks down demo payments, the open admin setup, local photo storage |
| `BASE_URL` | public https address, no trailing slash |
| `DATABASE_URL` | Supabase transaction pooler string (port 6543) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | photo and backup storage |
| `PAYSTACK_SECRET_KEY` | `sk_test_` then `sk_live_`. Without it online card payment is off |
| `ADMIN_EMAIL` + `ADMIN_PASSWORD`, or `SETUP_CODE` | how the first admin is created |

**Strongly recommended**

| Name | Meaning |
|---|---|
| `RESEND_API_KEY`, `MAIL_FROM` | order emails |
| `HANDOVER_SECRET` | long random text the delivery codes are derived from; never change it |
| `BACKUP_PASSPHRASE` | encrypts backups; keep a copy outside Render |
| `GEOAPIFY_API_KEY` | delivery maps and quotes |
| `SEED_DEMO=0` | start with an empty catalogue |

**Tuning (defaults are fine)**

| Name | Default | Meaning |
|---|---|---|
| `DB_POOL_MAX` | 10 | database connections per instance |
| `DB_STATEMENT_TIMEOUT_MS` | 15000 | a database question taking longer is cancelled |
| `DATABASE_SSL` | on (off for local) | `on`, `off`, `no-verify` |
| `DATABASE_CA` | | database certificate text or base64 |
| `WORKER_ENABLED` | on | `0` on web instances if you run `npm run worker` as a separate service |
| `WORKER_CONCURRENCY`, `WORKER_POLL_MS` | 4, 2000 | background job speed |
| `BACKUP_KEEP` | 14 | backup files kept (min 3) |
| `BACKUP_ENABLED` | on in production | `0` turns the nightly backup off (not advised) |
| `BACKUP_MAX_AGE_HOURS` | 30 | Admin warns when the last good backup is older |
| `SUPABASE_BUCKET`, `SUPABASE_BACKUP_BUCKET` | `product-images`, `backups` | bucket names |
| `LOG_LEVEL`, `LOG_FORMAT`, `SLOW_REQUEST_MS` | info, json, 1500 | logging |
| `TZ_OFFSET_HOURS` | 1 | Nigeria time for "today" |
| `TRUST_PROXY` | on | leave unset behind Render and Cloudflare |
| `CLOUDFLARE_RANGES` | built in | only if Cloudflare changes its address list |
| `CACHE_DISABLED`, `CACHE_MAX_ENTRIES`, `CACHE_POLL_MS` | | in-memory cache tuning |
| `GEO_PROVIDER` | geoapify | map provider |

**Never set in production:** `ALLOW_DEMO_PAYMENTS`, `ALLOW_LOCAL_UPLOADS`, `RATE_LIMIT_MULTIPLIER`, `JOB_BACKOFF_SECONDS`, `PAYSTACK_API_URL`, `RESEND_API_URL`, `GEO_API_URL`, `GEO_DOWN_PAUSE_MS`, `STORAGE_DRIVER=local` (these exist for tests). `npm run preflight` flags the risky ones.

---

## Phase 2: pharmacy (not part of this launch)

Selling medicines needs a licence and extra checks (prescription upload and pharmacist verification) and is built behind a `PHARMACY_ENABLED` switch that stays **off** at launch. Do not list medicines until that phase is built and your licence position is confirmed.
