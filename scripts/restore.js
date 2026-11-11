'use strict';
// Restore a Shop-Beta backup into a NEW, EMPTY database.
//   DATABASE_URL=postgres://... [BACKUP_PASSPHRASE=...] npm run restore -- path/to/shop-beta-2026....json.gz[.enc]
// It runs the migrations first, refuses to touch a database that already has data (unless --force), and loads everything in one transaction:
// either the whole backup goes in or nothing does. See docs/RESTORE.md.
const fs = require('fs');
const { Client } = require('pg');
const { migrate, close } = require('../lib/db');
const backup = require('../lib/backup');

(async () => {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const force = process.argv.includes('--force');
  if (!file || !process.env.DATABASE_URL) { console.error('Usage: DATABASE_URL=... [BACKUP_PASSPHRASE=...] npm run restore -- <backup file> [--force]'); process.exit(2); }
  const content = backup.decode(fs.readFileSync(file));
  console.log(`Backup from ${new Date(content.created * 1000).toISOString()} with ${Object.keys(content.tables).length} tables.`);
  await migrate();
  const url = process.env.DATABASE_URL, local = /@(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
  const client = new Client({ connectionString: url, ssl: (process.env.DATABASE_SSL || (local ? 'off' : 'on')).toLowerCase() === 'off' ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const r = await backup.restore(content, client, { force });
    console.log(`Restored ${r.rows} rows in ${r.tables} tables. Start the app and check /health.`);
  } finally { await client.end(); await close(); }
})().catch((e) => { console.error('Restore failed:', e.message); process.exit(1); });
