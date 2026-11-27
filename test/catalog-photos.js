'use strict';
// Product photos named by link in an import file: validation, background copy into storage, failures and retry, "use link as is", export and re-import.
// Run with: npm run test:catalog-photos   (needs TEST_DATABASE_URL like the main test)
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const ExcelJS = require('exceljs');
const { Client: Pg } = require('pg');
const http = require('http');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_catp_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const PORT = 7000 + Math.floor(Math.random() * 1500);
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
let srv, log = '';
const raw = async (method, url, body, cookie) => fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (method, url, body, cookie) => {
  const r = await raw(method, url, body, cookie);
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  if (process.env.DEBUG_V && r.status >= 400) console.log('   [' + r.status + '] ' + method + ' ' + url + ' ' + t.slice(0, 300));
  return { s: r.status, j, t, c: (sc[0] || '').split(';')[0] };
};
const login = async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.s, 200, 'login ' + r.t); return r.c; };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const xlsxB64 = async (rows) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Products'); rows.forEach((r) => ws.addRow(r)); return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'); };
// what the browser does after the mapping step: turn each file row into the Shop-Beta fields
const canon = (parsed, mapping = parsed.mapping) => parsed.rows.map((r) => { const o = { line: r.__line }; for (const [k, h] of Object.entries(mapping)) o[k] = h ? r[h] : ''; return o; });


// a 1x1 PNG, a text file pretending to be a photo, and a missing file
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let hits = 0;
const img = http.createServer((req, res) => {
  hits++;
  const m = /^\/api\/v2\/product\/(\d+)\.json/.exec(req.url);
  if (m) { res.writeHead(m[1] === '6001111111111' ? 200 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(m[1] === '6001111111111' ? { product: { image_front_url: `http://127.0.0.1:${img.address().port}/a.png` } } : {})); }
  if (req.url.startsWith('/a.png') || req.url.startsWith('/b.png') || req.url.startsWith('/c.png')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
  if (req.url.startsWith('/fake.jpg')) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end('this is not a picture'); }
  res.writeHead(404); res.end('nope');
});

(async () => {
  await new Promise((r) => img.listen(0, '127.0.0.1', r)); const IP = img.address().port, I = (p) => `http://127.0.0.1:${IP}${p}`;
  await pg(`CREATE DATABASE ${DB}`);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), BASE_URL: 'http://127.0.0.1:' + PORT, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-catp-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Str0ng-Owner-Pass!', RATE_LIMIT_MULTIPLIER: '50', ALLOW_PRIVATE_IMAGE_HOSTS: '1', OFF_BASE_URL: 'http://127.0.0.1:' + IP, WORKER_POLL_MS: '200' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const admin = await login('owner@example.com', 'Str0ng-Owner-Pass!');
  const A = (m, u, b) => call(m, '/api/admin/catalog' + u, b, admin);
  const fields = (await A('GET', '/fields')).j; const cat = fields.lookups.categories[0];
  const row = (n, extra = {}) => ({ line: n + 1, name: 'Photo Product ' + n, sku: 'PH-' + n, barcode: '', department: '', category: cat.name, price: '1500', stock: '10', ...extra });
  const waitPhotos = async (id, want) => { for (let i = 0; i < 100; i++) { const r = (await A('GET', `/history/${id}/photos`)).j; if (r.waiting === 0 && (want === undefined || r.total >= want)) return r; await sleep(200); } throw new Error('photos never finished ' + JSON.stringify(await A('GET', `/history/${id}/photos`).then((x) => x.j)) + JSON.stringify(await q('SELECT id,status,attempts,error,url FROM catalog_image_jobs WHERE import_id=$1', [id])) + JSON.stringify(await q('SELECT kind,state,attempts,last_error,key FROM jobs WHERE kind LIKE $1', ['%catalog%']))); };
  const images = async (sku) => JSON.parse((await q('SELECT images FROM products WHERE sku=$1', [sku]))[0].images);

  console.log('Image URLs column');
  await test('the template and field list have an Image URLs column, and a file with that header maps to it', async () => {
    assert.ok(fields.fields.some((f) => f.key === 'images' && f.header === 'Image URLs'));
    const p = (await A('POST', '/parse', { filename: 'p.xlsx', data: await xlsxB64([['Product Name', 'Category', 'Selling Price', 'Image URLs'], ['X', cat.name, 100, I('/a.png')]]) })).j;
    assert.strictEqual((p.mapping || p.parsed.mapping).images, 'Image URLs', JSON.stringify(p).slice(0,300));
  });
  await test('bad links are rejected in the preview, and so is more than five per product', async () => {
    const v = (await A('POST', '/validate', { mode: 'create', rows: [row(1, { images: 'ftp://x/a.png' }), row(2, { images: 'not a link' }), row(3, { images: [1, 2, 3, 4, 5, 6].map((i) => I('/a.png?' + i)).join(' ') }), row(4, { images: I('/a.png') + ' | ' + I('/b.png') + ', ' + I('/a.png') })] })).j;
    assert.ok(/Image URLs/.test(v.results[0].errors.join())); assert.ok(/Image URLs/.test(v.results[1].errors.join())); assert.ok(/up to 5/.test(v.results[2].errors.join()));
    assert.deepStrictEqual(v.results[3].errors, [], 'spaces, commas and | all separate links; a repeated link counts once');
  });

  console.log('\nCopying photos');
  let imp1;
  await test('creating products with photo links saves the products at once and copies the photos in the background', async () => {
    const rows = [row(10, { images: I('/a.png') + ' | ' + I('/b.png') }), row(11, { images: I('/missing.png') }), row(12, { images: I('/fake.jpg') }), row(13)];
    const r = (await A('POST', '/commit', { rows, mode: 'create', filename: 'photos.xlsx', total: 4 })).j;
    assert.strictEqual(r.created, 4); assert.strictEqual(r.photos, 4); imp1 = r.importId;
    const st = await waitPhotos(imp1, 4);
    assert.strictEqual(st.done, 2); assert.strictEqual(st.failed, 2);
  });
  await test('copied photos are in our own storage, in the order of the file', async () => {
    const im = await images('PH-10'); assert.strictEqual(im.length, 2); assert.ok(im.every((u) => /^\/uploads\/[a-f0-9]{16,}\.png$/.test(u)), JSON.stringify(im));
    const f = await fetch(`http://127.0.0.1:${PORT}${im[0]}`); assert.strictEqual(f.status, 200); assert.ok(Buffer.from(await f.arrayBuffer()).equals(PNG));
    assert.deepStrictEqual(await images('PH-13'), [], 'a product with no links stays without photos');
  });
  await test('a missing link and a file that is not an image fail with a reason and leave the product without photos', async () => {
    const st = (await A('GET', `/history/${imp1}/photos`)).j; assert.strictEqual(st.failures.length, 2);
    assert.ok(st.failures.some((f) => /404/.test(f.error)) && st.failures.some((f) => /not a valid image/.test(f.error)), JSON.stringify(st.failures));
    assert.deepStrictEqual(await images('PH-11'), []);
  });
  await test('retrying the failed photos tries them again and keeps what already worked', async () => {
    const h = hits; const r = (await A('POST', `/history/${imp1}/photos/retry`, {})).j; assert.strictEqual(r.retried, 2);
    const st = await waitPhotos(imp1, 4); assert.strictEqual(st.failed, 2); assert.strictEqual(st.done, 2); assert.ok(hits > h);
    assert.strictEqual((await images('PH-10')).length, 2);
  });

  console.log('\nExport and update');
  await test('the export has an Image URLs column with full links', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/catalog/export?format=csv`, { headers: { Cookie: admin } }); const t = await r.text();
    assert.ok(/Image URLs/.test(t.split('\n')[0])); assert.ok(new RegExp(`http://127.0.0.1:${PORT}/uploads/[a-f0-9]{16,}\\.png \\| http://127.0.0.1:${PORT}/uploads/[a-f0-9]{16,}\\.png`).test(t), 'both photos of PH-10, joined by |');
  });
  await test('importing an exported file again changes no photos and downloads nothing', async () => {
    const own = (await images('PH-10')).map((u) => `http://127.0.0.1:${PORT}${u}`).join(' | '); const h = hits;
    const v = (await A('POST', '/validate', { mode: 'update', rows: [{ line: 2, sku: 'PH-10', images: own }] })).j;
    assert.deepStrictEqual(v.results[0].errors, []); assert.strictEqual(v.results[0].changes.length, 0);
    const r = (await A('POST', '/commit', { mode: 'update', confirmUpdate: true, rows: [{ line: 2, sku: 'PH-10', images: own }], total: 1 })).j; assert.strictEqual(r.photos, 0); assert.strictEqual(hits, h);
  });
  await test('update mode adds new photo links after the current ones, and a blank cell keeps the current photos', async () => {
    const v = (await A('POST', '/validate', { mode: 'update', rows: [{ line: 2, sku: 'PH-13', images: I('/c.png') }, { line: 3, sku: 'PH-10', images: '' }] })).j;
    assert.ok(v.results[0].changes.some((c) => c.field === 'images')); assert.strictEqual(v.results[1].changes.length, 0);
    const r = (await A('POST', '/commit', { mode: 'update', confirmUpdate: true, rows: [{ line: 2, sku: 'PH-13', images: I('/c.png') }], total: 1 })).j; assert.strictEqual(r.updated, 1);
    await waitPhotos(r.importId, 1); assert.strictEqual((await images('PH-13')).length, 1);
  });
  await test('a product keeps at most 8 photos', async () => {
    for (let i = 0; i < 3; i++) { const r = (await A('POST', '/commit', { mode: 'update', confirmUpdate: true, rows: [{ line: 2, sku: 'PH-13', images: [1, 2, 3].map((n) => I(`/a.png?x=${i}${n}`)).join(' ') }], total: 1 })).j; await waitPhotos(r.importId, 3); }
    assert.ok((await images('PH-13')).length <= 8);
  });

  console.log('\nUse links as they are');
  await test('"use the links as they are" keeps https links without downloading, and refuses plain http', async () => {
    const h = hits;
    const r = (await A('POST', '/commit', { mode: 'create', photoMode: 'link', rows: [row(20, { images: 'https://example.com/pic.jpg' }), row(21, { images: I('/a.png') })], total: 2 })).j;
    const st = await waitPhotos(r.importId, 2); assert.strictEqual(st.done, 1); assert.strictEqual(st.failed, 1); assert.strictEqual(hits, h, 'nothing downloaded');
    assert.deepStrictEqual(await images('PH-20'), ['https://example.com/pic.jpg']);
  });

  console.log('\nFind photos by barcode');
  await test('products with a barcode and no photo get a photo from the open database; unknown barcodes are listed', async () => {
    const mk = (n, bc) => ({ ...row(n, { barcode: bc }), line: n });
    const c = (await A('POST', '/commit', { mode: 'create', rows: [mk(40, '6001111111111'), mk(41, '6002222222222'), mk(42, '')], total: 3 })).j; assert.strictEqual(c.created, 3, JSON.stringify(c));
    const r = (await A('POST', '/find-photos', {})).j; assert.strictEqual(r.queued, 2, JSON.stringify(r));
    const st = await waitPhotos(r.importId, 2); assert.strictEqual(st.done, 1); assert.strictEqual(st.failed, 1);
    const own = await images('PH-40'); assert.strictEqual(own.length, 1); assert.ok(own[0].startsWith('/uploads/') || own[0].startsWith('http'), own[0]);
    assert.deepStrictEqual(await images('PH-41'), []); assert.deepStrictEqual(await images('PH-42'), []);
    const csv = await (await raw('GET', `/api/admin/catalog/history/${r.importId}/photos.csv`, undefined, admin)).text();
    assert.ok(csv.includes('PH-41') && /Not found in Open Food Facts/.test(csv) && !csv.includes('PH-42'), csv);
    assert.strictEqual((await A('POST', '/find-photos', {})).j.queued, 1, 'only the product still without a photo is asked again');
  });

  console.log('\nAccess');
  await test('another account cannot read or retry an import\'s photo list', async () => {
    assert.ok([401, 403].includes((await call('GET', `/api/admin/catalog/history/${imp1}/photos`, undefined, '')).s));
    assert.ok([401, 403].includes((await call('POST', `/api/admin/catalog/history/${imp1}/photos/retry`, {}, '')).s));
  });

  img.close(); srv.kill(); await sleep(300);
  await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); srv && srv.kill(); console.error(log.slice(-2500)); process.exit(1); });
