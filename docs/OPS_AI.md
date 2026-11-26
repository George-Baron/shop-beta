# VELTO AI Operations Manager (Phase 1: Command Centre, Phase 2: Procurement, Phase 3: Global order management)

Open **Admin > AI Operations** (`/admin#/opsai`). Staff need the new **AI Operations** permission (role "Operations Supervisor" has it); the owner always does.

## What it does today
- **Command Centre**: live figures from the real tables (orders by status and channel, retail stock, the separate wholesale warehouse, riders, suppliers, import/export, returns, approvals, exceptions). Costs the system does not record are listed as "not recorded", never estimated.
- **Assistant**: natural-language instructions. It reads data with `read_data` and acts only through `take_action`. Under each reply the screen shows the status the *backend* returned (Done / Recommended / Waiting for approval / Blocked / Failed). Needs `ANTHROPIC_API_KEY` (model: `OPS_ASSISTANT_MODEL`); without it you get a live summary.
- **Monitor** (worker job `cron.opsMonitor`, every 5 min): raises one exception per problem (late orders, orders waiting for dispatch, slow dropship suppliers, sales below cost, out-of-stock sellers, customs holds, past-ETA shipments, overdue supplier payables, stale GPS, failed jobs, approvals waiting) and closes them when they clear. It only observes.
- **Approvals**, **Exceptions**, **Audit log**, **Settings & agents** (mode, department modes, limits, 10 agents on/off, approvers, connection status).

## Control model
- Modes: **Monitor** (default: recommend only), **Assisted** (a person approves each action), **Controlled** (routine level-1 actions run alone inside a daily budget). The overall mode is a ceiling; a department can be set lower, never higher. Financial is capped at Assisted.
- Levels 0-4 with the starting limits 100k / 500k / 2M (configurable per category). Amounts to the same counterparty inside the window are added together, so splitting cannot dodge a limit. A foreign amount with no recorded exchange rate is "value unknown" and treated as level 4.
- From level 4, two different people must approve. Nobody approves their own request or decides twice. Approvals are bound to a hash of the exact terms; any later change invalidates them.
- The AI can never pay, transfer, change bank details, or approve. Money steps are carried out by a person, who records the reference.
- Segregation of duties is recorded per purchase (request, approve, receive, verify, pay).
- Actions with no system behind them yet are refused, not faked.
- The audit table `ops_actions` is append-only (database trigger); it is also protected during backup restore.

## Phase 2: procurement intelligence (AI Operations > Procurement)
- **Requests**: "Create requests from real stock" works out what to reorder from stock, incoming orders and 30-day sales (retail), and from reorder levels (wholesale). Retail and wholesale are never added together. The numbers behind each request are saved with it. One open request per product and destination.
- **Vendors**: every vendor starts *under review* with nothing verified. Only a person can mark a check verified (and must say how). Approving or preferring a vendor needs verified registration **and** contact; losing either drops an approved vendor to *conditional*. A person with approver level 2+ changes a status directly; anyone else, and the AI, must file a request for an approver.
- **Quotations** are prices vendors actually gave us. Each needs a source and, for vendor quotes, a reference. The AI never writes a price.
- **Comparison**: landed cost in Naira (goods, freight, insurance, duty, VAT, clearing; duty/VAT are marked as estimates), then a 0-100 score from the eight weighted factors (weights editable in Settings). Only factors with real data count, and each score says how much of the weight that is. Cheapest, fastest, preferred and recommended are shown with the reason. Only approved/preferred/conditional vendors on valid quotes that cover the quantity can be recommended; a quotation whose Naira cost is unknown (no exchange rate) is not ranked. Fewer than 3 qualified quotes is flagged.
- **Purchase orders**: drafting commits nothing. "Request approval" goes through the normal rules (level by value, split detection, two-person, requester cannot approve). The approval is bound to the PO's exact terms; any change after submission makes it fail. PDF export. A person records "sent" and "goods received" (the AI cannot); late or short deliveries feed the vendor's delivery score and raise an exception. Recording receipt does **not** change stock: receive it in the warehouse as usual.
- Still not connected: supplier **discovery** (no research source is wired, so the AI says so instead of inventing vendors), emailing vendors, courier APIs.

## Phase 3: every order, followed until it ends (AI Operations > Orders)
- A sweep runs every 2 minutes (`cron.opsOrders`) and registers every open retail, partner, dropshipping, international and wholesale order the first time it appears (`ops_order_watch`, history in `ops_order_stage_events`).
- Each order is placed in a stage from the store's own records (paid, awaiting dispatch, rider offered, out for delivery, awaiting supplier, wholesale picking/packed/dispatched, failed, under investigation) with the party who must act next.
- When a stage runs past its allowance (configurable, `order_sla`) one exception is raised with the recommended action. Orders waiting on the customer (payment, pickup) are shown but never counted late.
- Routine follow-up goes through the gateway so it is logged and obeys modes and permissions: an unassigned ready order is offered to the best rider (`rider.assign`), other late orders get a drafted customer update. Retries back off (15 min, doubling) and stop after 5; the exception is then raised to high and says the AI has stopped.
- An order closes only when the store itself records delivery, cancellation or refund. Delivery is labelled **verified** (OTP, photo or recipient confirmation; wholesale signer), **pickup**, **supplier reported** or **unproven**; unproven deliveries raise an exception for a person. Estimates and unverified messages never close an order.
- The sweep reads and writes only its own tables; it never edits an order, stock or money. Settings: `orders_follow_up` (nudges on/off), `order_sla`, the Order Management Agent switch.
- Limits: the store does not record web vs app, so both show as retail; partner fulfilment confirmation and stock shortage per order are not tracked by the store, so those stages are not claimed.

## Not built yet (later phases)
Supplier discovery, vendor email, courier integrations (DHL/UPS/FedEx show as *not connected*), import/export agent actions, split / multi-location fulfilment, returns and refund orchestration, demand forecasting, performance dashboards.

## Tests
`npm run test:ops-ai:unit`, `npm run test:ops-procure:unit` (rules and scoring, no DB); `npm run test:ops-ai` and `npm run test:ops-procurement` `npm run test:ops-orders:unit` and `npm run test:ops-orders` (order stages and the sweep); (database: gateway, approvals, audit, monitor, vendors, quotations, purchase orders).
