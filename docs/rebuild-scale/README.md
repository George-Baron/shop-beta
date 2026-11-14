# Docs imported from the `rebuild/scale` branch

These guides were written for the `rebuild/scale` branch (steps 1-10, no delivery, pharmacy, partner stores or wholesale). They are kept here because they are detailed and useful, but **the code on `main` is the truth**: where they disagree, trust `main` and `docs/` + `DEPLOY.md` at the repo root.

Known differences: migration file names and order, job state `running` (not `active`), order and delivery flow (6A), password/auth modules (`lib/passwords.js`), `npm run test:all` does not exist on main, SQLite import is `scripts/import-sqlite.js`, restore is `scripts/restore.js`.

Ported as working code: `test/two-instances.js` (`npm run test:multi`), `scripts/check-storage.js` (`npm run check:storage`), `scripts/dev-lb.js` (`npm run lb`), and the k6 load harness in `load/` (`npm run load:local`, needs k6, **not run on main yet**). `server.js` now sends an `X-Instance` header.

Not ported on purpose: rebuild/scale's migrations, `lib/migrate.js`, `sqlite-to-postgres.js`, `migrate-images.js`, `restore-backup.js`, `set-admin-password.js` (main has its own versions or different auth).
