'use strict';
// Checks scripts/migrate-images.js: dry run changes nothing; real run moves photos and links them; missing files are left alone; safe to run twice.
// Run with: npm run test:images
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const mock = require('./mock-supabase');
const ADMIN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DB = 'sb_img_' + Math.random().toString(36).slice(2, 10);
const withDb = (n) => { const u = new URL(ADMIN); u.pathname = '/' + n; return u.toString(); };
const ssl = process.env.PGSSL_TEST === 'require' ? { rejectUnauthorized: false } : false;
const q = async (sql, db, args) => { const c = new Client({ connectionString: db ? withDb(db) : ADMIN, ssl }); await c.connect(); try { return await c.query(sql, args); } finally { await c.end(); } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-img-'));
  const a = 'a'.repeat(24) + '.png', b = 'b'.repeat(24) + '.png', gone = 'c'.repeat(24) + '.png';
  fs.writeFileSync(path.join(dir, a), PNG); fs.writeFileSync(path.join(dir, b), PNG);
  const storage = await mock.start('k');
  await q(`CREATE DATABASE ${DB}`);
  let fail = null;
  try {
    const env = { ...process.env, DATABASE_URL: withDb(DB), PGSSL: process.env.PGSSL_TEST || 'disable', SUPABASE_URL: storage.url, SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_BUCKET: 'shop-images', STORAGE_DRIVER: '' };
    // async on purpose: the mock storage lives in this process and must keep answering
    const run = (...x) => new Promise((res) => { const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'migrate-images.js'), '--dir', dir, ...x], { env }); let stdout = '', stderr = ''; c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; }); c.on('close', (status) => res({ status, stdout, stderr })); });
    await run('--dry-run'); // creates the tables
    await q(`INSERT INTO stores (slug,name,tab_label) VALUES ('s','S','S')`, DB);
    await q(`INSERT INTO products (slug,store,name,price,images,created) VALUES ('p1','s','P1',100,$1,1),('p2','s','P2',100,$2,1)`, DB, [JSON.stringify(['/uploads/' + a, 'https://cdn.example.com/x.png']), JSON.stringify(['/uploads/' + gone, '/uploads/' + b])]);
    await q(`INSERT INTO settings (key,value) VALUES ('logo','/uploads/${a}')`, DB);
    const imgs = async () => (await q('SELECT slug, images FROM products ORDER BY slug', DB)).rows.map((r) => r.images).join('|');
    const before = await imgs();
    const dry = await run('--dry-run'); assert.strictEqual(dry.status, 0, dry.stderr); assert.match(dry.stdout, /Found 3 distinct local photos/); assert.strictEqual(await imgs(), before); assert.strictEqual(storage.objects.size, 0); assert.match(dry.stdout, /MISSING FILES \(1\)/);
    const r1 = await run(); assert.strictEqual(r1.status, 0, r1.stderr + r1.stdout);
    assert.strictEqual(storage.objects.size, 2); assert.ok(storage.objects.has('shop-images/uploads/' + a));
    const after = JSON.parse((await q("SELECT images FROM products WHERE slug='p1'", DB)).rows[0].images);
    assert.strictEqual(after[0], `${storage.url}/storage/v1/object/public/shop-images/uploads/${a}`); assert.strictEqual(after[1], 'https://cdn.example.com/x.png');
    const p2 = JSON.parse((await q("SELECT images FROM products WHERE slug='p2'", DB)).rows[0].images);
    assert.strictEqual(p2[0], '/uploads/' + gone, 'missing file left as is'); assert.ok(p2[1].startsWith(storage.url));
    assert.ok((await q("SELECT value FROM settings WHERE key='logo'", DB)).rows[0].value.startsWith(storage.url));
    assert.ok(fs.existsSync(path.join(dir, a)), 'local files are never deleted');
    const r2 = await run(); assert.match(r2.stdout, /Found 1 distinct local photos/); // only the missing one is left
    console.log('  ok   migrate-images: dry run is harmless, photos move and link, missing files are reported and left, second run is safe');
  } catch (e) { fail = e; console.log('  FAIL ' + e.message); }
  finally { storage.close(); await q(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); }
  process.exit(fail ? 1 : 0);
})();
