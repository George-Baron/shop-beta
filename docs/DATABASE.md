# Database: PostgreSQL (Supabase)

From step 2 the shop stores everything in PostgreSQL instead of the `shop.db` SQLite file. The app needs `DATABASE_URL`; without it the app refuses to start and says so.

## 1. What you set up on Supabase (you do this once)

1. Create a Supabase project. Pick the region closest to where the app will run (the same region as the Render service).
2. In the project, open **Connect** and copy two connection strings. Replace `[YOUR-PASSWORD]` with the database password you chose:
   - **Transaction pooler**, port **6543** → this is `DATABASE_URL` (what the running shop uses).
   - **Session pooler**, port **5432** → this is `MIGRATE_DATABASE_URL` (used only for schema updates and the one-time import).
3. Put both in the hosting service's environment variables (never in the repository).

Why two: the transaction pooler is the right one for a busy shop (it shares a few real connections between many requests) but it cannot hold the lock that schema updates use. The shared poolers work over IPv4, which Render needs; the "direct connection" is IPv6-only unless you pay for Supabase's IPv4 add-on. Source: [Supabase IPv4 and IPv6 compatibility](https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP).

Environment variables:

| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | Connection string the app uses | none (required) |
| `MIGRATE_DATABASE_URL` | Connection string for migrations and the import (session pooler or direct) | uses `DATABASE_URL` |
| `PGSSL` | `require` (encrypted, default for hosted databases), `verify-full` (also check the certificate), `disable` (local only) | automatic |
| `PG_POOL_MAX` | Connections each app instance may open. Keep (instances × this) under your Supabase plan's limit | 10 |
| `PG_STATEMENT_TIMEOUT_MS` | Any single query running longer than this is cancelled | 20000 |
| `MIGRATE_ON_START` | `0` stops the app from applying new migrations when it starts | on |

## 2. Local development

```
npm install
npm run db:up                       # starts Postgres 16 in Docker (needs Docker Desktop)
echo 'DATABASE_URL=postgres://shop:shop@localhost:5432/shop' >> .env
npm start                           # creates the tables and demo data on first start
npm test                            # makes and deletes its own throwaway database
```

Without Docker, install PostgreSQL 14 or newer yourself and point `DATABASE_URL` (and `TEST_DATABASE_URL` for tests) at it.

## 3. Schema changes (migrations)

Plain SQL files in `migrations/`, applied in order, each once, and recorded in the `schema_migrations` table. The app applies new ones when it starts; two instances starting together are safe (one waits). To run by hand: `npm run migrate`. Never edit a migration that has been applied; add a new numbered file.

- `001_init.sql`: all tables.
- `002_indexes_and_search.sql`: indexes for product lists, orders and search, and the `search_text` column.
- `003_job_locks.sql`: lock table so background jobs run on one instance at a time.

Search: every product has a `search_text` column (name, brand, SKU, category, description, lower case) kept current by database triggers, with a trigram index (`pg_trgm`, available on Supabase). Typing part of a word still matches, as before.

## 4. Moving the live shop from SQLite to Postgres (cutover)

Do this at a quiet hour. The shop is unavailable between steps 3 and 6.

1. Make sure the Supabase database is **empty** (a new project is). Set `DATABASE_URL` and `MIGRATE_DATABASE_URL` in your shell.
2. Copy the live `shop.db` somewhere you can reach (download it from the server's data folder or Render disk). Keep this copy: it is your rollback.
3. Put the old shop into maintenance (stop the service, or switch it off) so no new orders arrive.
4. Take a final copy of `shop.db`, then rehearse: `npm run import:sqlite -- --sqlite path/to/shop.db --dry-run`. It copies everything inside one transaction, checks that every row count and the order, item and stock totals match, then rolls back.
5. Run it for real: `npm run import:sqlite -- --sqlite path/to/shop.db`. If anything differs it writes nothing.
6. Deploy this version with `DATABASE_URL` set and start it. Open the shop and admin, place a test order, then delete it or mark it cancelled.
7. Uploaded product photos are not in the database: copy the old `data/uploads/` folder to the new server's `DATA_DIR/uploads/` (step 3 of the rebuild moves these to proper storage).

Customers keep their accounts and passwords, order numbers and tracking links keep working, and ids carry on from where they were.

**Rollback:** the old SQLite version of the shop and your copy of `shop.db` are untouched. To go back, start the old version on that file. Any orders placed on Postgres after the cutover would have to be re-entered by hand, so decide quickly after the test order.

## 5. Safety properties you can rely on

- Stock can never go below zero or be sold twice: the update and the check are one atomic statement, and orders lock products in a fixed order so two shoppers cannot deadlock each other. Tested with 10 simultaneous buyers for 3 units.
- Cancelling or confirming payment twice at the same moment only counts once (stock is returned once, one "paid" email).
- A coupon limited to 1 use cannot be used twice at the same time.
- The import never changes the SQLite file and never leaves a half copy.

## 6. Not done yet in this step

Photos (step 3) and caching (step 4) are done, so more than one instance is now safe; emails still send from inside the web request until step 5.
