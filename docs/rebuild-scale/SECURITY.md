# Security (step 7)

## Administrator account
- No default login. The password is never stored in code.
- Production start-up needs one of: an existing administrator, `ADMIN_EMAIL` + `ADMIN_PASSWORD` (12+ characters; creates the account), or `ADMIN_SETUP_CODE` (8+ characters; enables the one-time `/admin` setup page). Otherwise the server stops with a clear message.
- The setup page needs the code, refuses once an administrator exists, and a unique database index (migration 008) guarantees only one administrator even if two requests race.
- Lost password: `ADMIN_EMAIL=... ADMIN_PASSWORD='...' node scripts/set-admin-password.js` (run with the production `DATABASE_URL`). It ends that account's sessions.
- Administrator sessions last 12 hours; shopper sessions 30 days.

## Passwords
scrypt (N=65536, r=8, p=2, 16-byte salt), stored as `scrypt$N$r$p$salt$hash`. Older hashes still work and are upgraded at the next sign-in. At most two hashes are computed at once so a flood of sign-ins cannot exhaust memory.

## Rate limits
Keyed by the person (email, or phone with +234 / 0 / spaces normalised), plus a loose per-IP ceiling because many phones share one mobile-network IP. Checkout 10/hour per phone and per email; sign-in 8 per 15 minutes per email; registration, reset, contact, newsletter, reviews, order lookup and cancel also per person. The counters live in Postgres so both instances share them. Per-IP ceilings are adjustable with `RATE_IP_<NAME>`. Trade-off: counting every sign-in attempt on an email lets someone lock a known email out for 15 minutes.

## CSRF, cookies, headers
- Requests that change data and carry a cookie must come from our own origin (Origin / Sec-Fetch-Site) and send `X-Requested-With: shop-beta`. The Paystack webhook is exempt (it is protected by its HMAC signature).
- On https the cookie is `__Host-sb_sid` (Secure, HttpOnly, SameSite=Lax, no Domain). A plain-named cookie is ignored on https. Changing a password ends the person's other sessions.
- Headers: strict CSP with a per-page nonce, no framing, nosniff, referrer policy, permissions policy, COOP/CORP, HSTS on https, no server banner, `no-store` on API answers.

## Input validation
Every route is fuzzed (`test/security.js`, about 6,000 hostile requests) and must never answer 5xx. NUL bytes anywhere in a URL or body are refused, and Postgres errors that mean the input itself is impossible (bad encoding, number out of range) answer 400. Uploads accept only real PNG/JPEG/GIF (and WebP if listed in routes/admin.js) images up to the size cap.

## Tests
`npm run test:security`: start-up rules, hashing and upgrade, limits, CSRF, cookies, headers, all 38 admin routes refuse visitors and shoppers, other people's addresses and orders, fuzz, uploads.

## Not verified
Behind real Cloudflare and Render (real client IPs, real https headers): needs checking on staging. `TRUST_PROXY=1` must be right there or every visitor will look like one IP; the per-person limits still protect checkout and sign-in either way.
