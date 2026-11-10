#!/usr/bin/env node
'use strict';
// Run once with your real Supabase keys to prove photo storage works:  npm run check:storage
// It creates the bucket if needed, uploads a tiny test image, reads it back from its public address, then deletes it.
const fs = require('fs');
const path = require('path');
try { for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); } } catch { /* no .env */ }
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@localhost/unused'; // storage check does not touch the database
process.env.STORAGE_DRIVER = 'supabase';
const storage = require('../lib/storage');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
(async () => {
  const name = 'healthcheck' + Date.now().toString(16).padEnd(16, '0') + '.png';
  try {
    await storage.init();
    const url = await storage.put(name, PNG, 'image/png');
    console.log('Uploaded:', url);
    const r = await fetch(url);
    if (!r.ok || r.headers.get('content-type') !== 'image/png') throw new Error(`The public address did not return the image (HTTP ${r.status}, type ${r.headers.get('content-type')}). Is the bucket public?`);
    console.log('Read back through the public address: OK (' + (await r.arrayBuffer()).byteLength + ' bytes)');
    await storage.remove(name);
    const gone = await fetch(url);
    console.log(gone.status === 200 ? 'WARNING: the test file was not deleted.' : 'Deleted the test file: OK');
    console.log('\nPASS: photo storage works.');
  } catch (e) { console.error('\nFAIL:', e.message); process.exit(1); }
})();
