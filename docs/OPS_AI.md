# VELTO AI Operations Manager (Phase 1: Command Centre)

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

## Not built yet (later phases)
Supplier discovery and PO generation, courier integrations (DHL/UPS/FedEx show as *not connected*), supplier email, import/export agent actions, demand forecasting, performance dashboards.

## Tests
`npm run test:ops-ai:unit` (rules, no DB) and `npm run test:ops-ai` (database: gateway, approvals, audit, monitor).
