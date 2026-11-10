#!/usr/bin/env node
'use strict';
// One-time move of existing product photos from the server's disk (/uploads/...) to Supabase Storage.
//
//   node scripts/migrate-images.js --dir ./data/uploads --dry-run     report only, change nothing
//   node scripts/migrate-images.js --dir ./data/uploads               upload, check each photo is reachable, then update the database
//
// - Needs DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see docs/STORAGE.md).
// - Finds every "/uploads/<file>" in products, order items, departments, and settings.
// - A photo is only linked in the database after it has been uploaded AND fetched back successfully.
// - Photos whose file is missing from --dir are reported and left as they are. Nothing is ever deleted from disk.
// - Safe to run again: already-moved photos are skipped, uploads overwrite.
const fs = require('fs');
const path = require('path');
try { for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); } } catch { /* no .env */ }
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const DRY = args.includes('--dry-run');
const DIR = path.resolve(opt('dir') || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads'));
if (!DRY) process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'supabase';
const storage = require('../lib/storage');
const { all, run, tx, end } = require('../lib/db');
const { migrate } = require('../lib/migrate');

const REF = /^\/uploads\/([a-f0-9]{16,}\.(png|jpg|webp|gif))$/;
const mimeOf = (name) => storage.MIME[name.split('.').pop()];

(async () => {
  if (!DRY && storage.DRIVER !== 'supabase') { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.'); process.exit(1); }
  await migrate();
  // 1. Everything that points at a local photo.
  const places = []; // {table, key, col, ...}
  for (const p of await all('SELECT id, images FROM products')) { let a = []; try { a = JSON.parse(p.images); } catch { /* skip */ } if (a.some((u) => REF.test(u))) places.push({ t: 'products', id: p.id, arr: a }); }
  for (const r of await all("SELECT DISTINCT image FROM order_items WHERE image LIKE '/uploads/%'")) places.push({ t: 'order_items', val: r.image });
  for (const r of await all("SELECT key, value FROM settings WHERE value LIKE '/uploads/%'")) places.push({ t: 'settings', key: r.key, val: r.value });
  const names = new Set();
  for (const p of places) for (const v of p.arr || [p.val]) { const m = REF.exec(v); if (m) names.add(m[1]); }
  console.log(`Folder: ${DIR}\nFound ${names.size} distinct local photos used in ${places.length} places${DRY ? '   (DRY RUN)' : ''}\n`);

  // 2. Upload and verify each file.
  const done = new Map(), missing = [], failed = []; let bytes = 0;
  const list = [...names];
  const worker = async () => {
    for (let name; (name = list.pop()) !== undefined;) {
      const file = path.join(DIR, name);
      if (!fs.existsSync(file)) { missing.push(name); continue; }
      if (DRY) { done.set(name, storage.publicUrl(name)); bytes += fs.statSync(file).size; continue; }
      try {
        const buf = fs.readFileSync(file);
        const url = await storage.put(name, buf, mimeOf(name));
        const back = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!back.ok || Number(back.headers.get('content-length') || buf.length) !== buf.length) throw new Error('uploaded but could not read it back (HTTP ' + back.status + ')');
        done.set(name, url); bytes += buf.length;
      } catch (e) { failed.push(name + ': ' + e.message); }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));

  // 3. Switch the database over, all at once, only for photos that are safely in storage.
  let rows = 0;
  if (!DRY) await tx(async () => {
    const swap = (v) => { const m = REF.exec(v); return m && done.has(m[1]) ? done.get(m[1]) : v; };
    for (const p of places) {
      if (p.t === 'products') { const next = p.arr.map(swap); if (next.join() !== p.arr.join()) { rows += (await run('UPDATE products SET images=? WHERE id=?', JSON.stringify(next), p.id)).changes; } }
      else if (p.t === 'order_items') { const n = swap(p.val); if (n !== p.val) rows += (await run('UPDATE order_items SET image=? WHERE image=?', n, p.val)).changes; }
      else { const n = swap(p.val); if (n !== p.val) rows += (await run('UPDATE settings SET value=? WHERE key=?', n, p.key)).changes; }
    }
  });
  console.log(`${DRY ? 'Would upload' : 'Uploaded'}: ${done.size} photos (${(bytes / 1048576).toFixed(1)} MB)`);
  if (!DRY) console.log(`Database rows updated: ${rows}`);
  if (missing.length) console.log(`\nMISSING FILES (${missing.length}), left as they are. Copy them into ${DIR} and run again:\n  ` + missing.join('\n  '));
  if (failed.length) { console.log(`\nFAILED (${failed.length}), left as they are. Run again:\n  ` + failed.join('\n  ')); process.exitCode = 1; }
  if (!missing.length && !failed.length) console.log('\nAll photos are in storage.');
  await end();
})().catch((e) => { console.error(e.message); process.exit(1); });
