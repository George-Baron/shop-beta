#!/usr/bin/env node
'use strict';
// One-time move of product photos from the server's disk (data/uploads) to Supabase Storage, then rewrite the links in the database.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL=... node scripts/migrate-uploads.js [path/to/uploads] [--dry-run]
//
// - Finds every "/uploads/<name>" link in products.images and order_items.image.
// - Uploads each file that exists on disk (same file name, so it is safe to re-run), checks the stored copy by downloading it and comparing size,
//   and only then rewrites the database links, all in one transaction.
// - Never deletes anything. Keep data/uploads until you have checked the site.
// - Links whose file is missing on disk are listed and left untouched.
const fs = require('fs');
const path = require('path');
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'supabase';
const storage = require('../lib/storage');
const { pool, tx, all, run, close } = require('../lib/db');

const args = process.argv.slice(2), dry = args.includes('--dry-run');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads'));
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const LINK = /^\/uploads\/([a-f0-9]{16,}\.(png|jpg|webp|gif))$/;

(async () => {
  if (storage.DRIVER !== 'supabase') { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.'); process.exit(2); }
  const products = await all("SELECT id, images FROM products WHERE images LIKE '%/uploads/%'");
  const items = await all("SELECT id, image FROM order_items WHERE image LIKE '/uploads/%'");
  const names = new Set();
  const parse = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  for (const p of products) for (const u of parse(p.images)) { const m = LINK.exec(u); if (m) names.add(m[1]); }
  for (const i of items) { const m = LINK.exec(i.image); if (m) names.add(m[1]); }
  console.log(`${names.size} distinct photo(s) referenced; looking in ${dir}`);

  const done = new Map(), missing = [], failed = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { missing.push(name); continue; }
    const buf = fs.readFileSync(file);
    if (dry) { done.set(name, storage.urlFor(name)); continue; }
    try {
      const url = await storage.put(buf, name, MIME[name.split('.').pop()]);
      const back = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const got = back.ok ? Buffer.from(await back.arrayBuffer()) : null;
      if (!got || got.length !== buf.length) throw new Error('stored copy does not match (' + back.status + ')');
      done.set(name, url);
    } catch (e) { failed.push(name + ': ' + e.message); }
  }
  console.log(`uploaded and verified: ${done.size}, missing on disk: ${missing.length}, failed: ${failed.length}`);
  if (missing.length) console.log('Missing files (links left as they are):\n  ' + missing.join('\n  '));
  if (failed.length) { console.error('Failed uploads, database NOT changed:\n  ' + failed.join('\n  ')); process.exitCode = 1; await close(); return; }

  let np = 0, ni = 0;
  if (!dry) {
    await tx(async () => {
      for (const p of products) {
        const list = parse(p.images), next = list.map((u) => { const m = LINK.exec(u); return m && done.has(m[1]) ? done.get(m[1]) : u; });
        if (JSON.stringify(next) !== JSON.stringify(list)) { await run('UPDATE products SET images=? WHERE id=?', JSON.stringify(next), p.id); np++; }
      }
      for (const i of items) { const m = LINK.exec(i.image); if (m && done.has(m[1])) { await run('UPDATE order_items SET image=? WHERE id=?', done.get(m[1]), i.id); ni++; } }
    });
  }
  console.log(dry ? 'Dry run: nothing uploaded or changed.' : `Database updated: ${np} product(s), ${ni} order line(s).`);
  void pool;
  await close();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
