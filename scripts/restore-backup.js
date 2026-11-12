'use strict';
// Restore a Shop-Beta database backup (see docs/OPERATIONS.md).
//
//   node scripts/restore-backup.js <file.ndjson.gz> --check
//        Only checks the file is complete and undamaged. Touches no database.
//   DATABASE_URL=<target> node scripts/restore-backup.js <file.ndjson.gz> --confirm <database-host>
//        Runs the migrations on the target, then loads the backup in ONE transaction (all or nothing).
//        --confirm must equal the host name inside DATABASE_URL, so a wrong or live URL is never hit by accident.
//        The target must have no users, orders or products unless you add --replace (which overwrites everything in it).
// Use MIGRATE_DATABASE_URL for the direct/session connection if DATABASE_URL is the transaction pooler.
const { Client } = require('pg');
const log = require('../lib/log');
const backup = require('../lib/backup');

const args = process.argv.slice(2), flag = (n) => args.includes(n), val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--confirm');
const fail = (m) => { console.error(m); process.exit(1); };

(async () => {
  if (!file) fail('Usage: node scripts/restore-backup.js <file.ndjson.gz> [--check] [--confirm <db-host>] [--replace]');
  const info = await backup.verifyFile(file);
  console.log(`Backup file is complete: made ${info.meta.created}, ${Object.keys(info.tables).length} tables, ${info.rows} records.`);
  if (flag('--check')) return;
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) fail('Set DATABASE_URL to the database you want to restore INTO.');
  const host = new URL(url).hostname;
  if (val('--confirm') !== host) fail(`Refusing to continue. You are about to write into the database at "${host}".\nIf that is correct, run again with:  --confirm ${host}`);
  const { migrate } = require('../lib/migrate');
  const applied = await migrate(); if (applied.length) console.log('Ran migrations on the target:', applied.join(', '));
  const { poolConfig } = require('../lib/db');
  const client = new Client({ connectionString: poolConfig(url).connectionString, ssl: poolConfig(url).ssl }); await client.connect();
  try {
    const done = await backup.restore(file, client, { replace: flag('--replace') });
    console.log(`Restored ${done.rows} records into ${host}. Sessions were not part of the backup, so everyone (including you) must sign in again.`);
  } finally { await client.end(); }
})().then(() => require('../lib/db').end().then(() => process.exit(0)), (e) => { log.error('Restore stopped, nothing was changed in the database:', e.message); console.error('\nRestore stopped. Nothing was changed. Reason: ' + e.message); process.exit(1); });
