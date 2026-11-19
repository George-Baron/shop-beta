# Riders: live GPS, dispatch and the AI Operations Manager

Rider accounts, consent-based GPS tracking, AI-assisted dispatch, chat and performance, built into the existing VELTO-MART backend.

## Screens
| Who | Address | What |
|---|---|---|
| Rider | `/rider/login`, `/rider/dashboard` | Mobile app: Go online (with a location notice), availability, offers with countdown, navigation map, delivery steps, chat with photos, profile and stats |
| Staff | `/admin/riders` (Admin, "Riders live") | Live map with status markers, list, filters and search, rider panel, dispatch ranking, performance comparison, AI commands, settings |

Staff need the **delivery** permission (see `lib/staff.js`). Rider accounts are created in *Pickup points & riders* as before; each gets a profile and an `SB-Rnnn` ID.

## The workflow
1. Rider signs in, taps **Go online**, accepts the location notice and the browser's permission prompt. A tracking session starts and the first fix is sent.
2. Admin sees the rider on the map. A confirmed order becomes "ready for dispatch" (`paid`, `confirmed` or `processing`, not pickup, no live assignment).
3. The AI ranks eligible riders (below). Depending on **dispatch mode** it only lists the best rider (`manual`), recommends and tells the desk (`recommend`, the default) or offers the order (`auto`).
4. The rider sees an offer card (no street address or phone yet) with a countdown. **Accept** is atomic: a partial unique index allows one live assignment per order, and the order row is locked while it changes.
5. Reject or no answer in time: the offer is released and the next rider is offered; if nobody is left the desk is told and the order stays waiting (re-checked every minute and whenever an order becomes ready).
6. Arrive at pickup (checked against GPS, noted not blocked) > collect > on the way (customer is told) > customer gives the 6-digit handover code > delivery proof is stored, the order closes and the rider is free again.
7. Every step, message and AI action is logged; `GET /api/admin/rider-ops/orders/:ref/history` returns the full story.

## Ranking
Eligible = online, verified, not suspended, under capacity, serving the area, with a **fresh** location (unless "allow no GPS" is on), within the maximum pickup distance. Score 0 to 100 from weights you can change (default proximity 30, availability 25, delivery time 20, workload 15, performance 10). Road distance and time come from the routing service for the top candidates; if it is unavailable the figure is marked `~` (straight line). The panel lists everyone left out and why.

## Location rules
* Tracking exists only inside a session the rider started (consent recorded), and ends when they go offline. A rider holding a delivery cannot go offline; the desk can force it with a reason, or take the delivery back (parcel whereabouts required).
* Intervals: 60 s waiting, 30 s assigned, 12 s on delivery (settings). The browser page tracks **only while it is open and in front**; a browser tab cannot promise background GPS. For true background tracking a native app is required; the same `/api/rider/location` endpoint would serve it.
* Status labels: Live, Recently updated, Stale, GPS disabled, Permission denied, Offline. A position older than the stale limit is never drawn as live.
* A browser cannot prove a position is genuine. The server rejects out-of-range values, poor accuracy, future or very old timestamps and impossible jumps; rejected fixes are kept flagged and do not move the marker.
* Precise positions are shown only to staff with the delivery permission; each view is written to `location_access_log` (admin can read it). Customers see only the position of their own rider while their order is on the way, never history.
* History older than the retention period (default 30 days) is deleted nightly; the live-update queue is pruned too. Rider tables have row-level security enabled with no policies, so only the server (never a browser key) can reach them.

## Real-time
Updates use server-sent events (`/api/rider/stream`, `/api/admin/rider-ops/stream`) fed by a `rider_events` table, not Supabase Realtime, because this app runs on its own Node server and Postgres. Each stream is checked per user: a rider only receives their own events.

## AI commands
Type in *AI commands*: "Show me all available riders", "How many riders are online right now?", "Which rider is closest to order SB-1020?", "Which riders are available in Ikorodu?", "Send a message to rider SB-R005: ...", "Ask rider SB-R003 for a delivery update", "Show riders whose GPS has stopped updating", "Show me all deliveries currently delayed", and so on. Answers come straight from the database with the time they were read. The command centre is rule-based (no language model); unknown requests get a help text, never a guess. "Assign order X to rider Y" asks for confirmation first (single use, 10 minutes, same administrator).

## Performance
Assigned, accepted, rejected, completed, failed, average pickup and delivery time, on-time share, rating, complaints and GPS reliability, from recorded data. Assignments marked **excused** (customer unreachable, wrong address, desk decision) are left out of on-time and failure counts. Riders with fewer than 5 assignments get a neutral dispatch score.

## Customer rating
After a delivery the buyer sees a 1 to 5 star form on their order page (only via their own order link, not email alone; once per order). It feeds the rider's rating; a score of 1 or 2 with a comment also counts as a complaint. `POST /api/orders/:ref/rate-delivery`.

## Settings (`PUT /api/admin/rider-ops/settings`)
Dispatch mode, weights, offer timeout, live/stale seconds, update intervals, maximum pickup distance and accuracy, wait for a reply, delay grace, retention days, allow riders without GPS. They are not exposed to customers.

## Tests
`npm run test:riders` (backend, 41 checks incl. the 27-step workflow) and `npm run test:riders-ui` (Chromium; real browser GPS permission, live map).
