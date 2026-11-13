'use strict';
// Where uploaded photos live. Production uses Supabase Storage, so the web servers never write to their own disk
// and any number of identical instances can run behind a load balancer.
//
//   STORAGE_DRIVER=supabase  (default when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set)
//   STORAGE_DRIVER=local     (default for local development only: writes to DATA_DIR/uploads)
//   STORAGE_DRIVER=none      (default in production with nothing configured: uploads are refused with a clear message)
const log = require('./log');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

class StorageError extends Error { constructor(status, message) { super(message); this.status = status; } }

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'shop-images';
const PUBLIC_BASE = (process.env.PUBLIC_IMAGE_BASE_URL || '').replace(/\/+$/, ''); // optional, e.g. an image domain behind Cloudflare
const configured = !!(SUPABASE_URL && KEY);
const DRIVER = (process.env.STORAGE_DRIVER || (configured ? 'supabase' : process.env.NODE_ENV === 'production' ? 'none' : 'local')).toLowerCase();
if (!['supabase', 'local', 'none'].includes(DRIVER)) throw new Error(`STORAGE_DRIVER must be supabase, local or none (got "${DRIVER}")`);
if (DRIVER === 'supabase' && !configured) throw new Error('STORAGE_DRIVER=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const PREFIX = 'uploads/';
const auth = () => ({ Authorization: 'Bearer ' + KEY, apikey: KEY });
const objectUrl = (key) => `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`;

// The address a browser uses to show the photo.
function publicUrl(name) {
  if (DRIVER === 'local') return '/uploads/' + name;
  if (PUBLIC_BASE) return `${PUBLIC_BASE}/${PREFIX}${name}`;
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${PREFIX}${name}`;
}

async function sb(method, url, opts = {}) {
  let res;
  try { res = await fetch(url, { method, signal: AbortSignal.timeout(20000), ...opts }); }
  catch (e) { throw new StorageError(502, 'Photo storage is not reachable right now. Please try again.'); }
  return res;
}

// Save a photo. `name` is like "ab12...ef.png". Returns the public address to store on the product.
async function put(name, buf, mime) {
  if (DRIVER === 'none') throw new StorageError(503, 'Photo storage is not set up. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see docs/STORAGE.md).');
  if (DRIVER === 'local') {
    const dir = path.join(DATA_DIR, 'uploads'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf);
    return publicUrl(name);
  }
  const res = await sb('POST', objectUrl(PREFIX + name), { headers: { ...auth(), 'Content-Type': mime, 'x-upsert': 'true', 'cache-control': 'max-age=31536000' }, body: buf });
  if (!res.ok) { log.error('Storage upload failed:', res.status, (await res.text()).slice(0, 200)); throw new StorageError(502, 'The photo could not be saved. Please try again.'); }
  return publicUrl(name);
}

async function remove(name) {
  try {
    if (DRIVER === 'local') fs.rmSync(path.join(DATA_DIR, 'uploads', name), { force: true });
    else if (DRIVER === 'supabase') await sb('DELETE', objectUrl(PREFIX + name), { headers: auth() });
  } catch { /* best effort */ }
}

// Creates the public bucket the first time (harmless if it already exists). Never stops the app from starting.
async function init() {
  if (DRIVER !== 'supabase') return;
  try {
    const res = await sb('POST', `${SUPABASE_URL}/storage/v1/bucket`, {
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 2097152, allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }),
    });
    if (res.ok) log.log(`Storage: created bucket "${BUCKET}".`);
    else if (res.status !== 409 && !/already exists/i.test(await res.text())) log.warn('Storage: could not create/check the bucket (' + res.status + '). Create a public bucket named "' + BUCKET + '" in Supabase if photos fail to upload.');
  } catch (e) { log.warn('Storage: bucket check skipped:', e.message); }
}

// ---- Private storage for database backups (customer data: never public). Bucket is created private on start. ----
const BACKUP_BUCKET = process.env.BACKUP_BUCKET || 'db-backups';
const backupUrl = (name) => `${SUPABASE_URL}/storage/v1/object/${BACKUP_BUCKET}/${name}`;
const backupDir = () => path.join(DATA_DIR, 'backups');
async function backupInit() {
  if (DRIVER !== 'supabase') return;
  try {
    const res = await sb('POST', `${SUPABASE_URL}/storage/v1/bucket`, { headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: BACKUP_BUCKET, name: BACKUP_BUCKET, public: false }) });
    if (res.ok) log.info(`Storage: created PRIVATE bucket "${BACKUP_BUCKET}" for backups.`);
    else if (res.status !== 409 && !/already exists/i.test(await res.text())) log.warn('Storage: could not create/check the backup bucket (' + res.status + '). Create a PRIVATE bucket named "' + BACKUP_BUCKET + '" in Supabase.');
  } catch (e) { log.warn('Storage: backup bucket check skipped:', e.message); }
}
async function backupPut(name, buf) {
  if (DRIVER === 'none') throw new StorageError(503, 'Backups need storage: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see docs/OPERATIONS.md).');
  if (DRIVER === 'local') { fs.mkdirSync(backupDir(), { recursive: true }); fs.writeFileSync(path.join(backupDir(), name), buf); return; }
  const res = await sb('POST', backupUrl(name), { headers: { ...auth(), 'Content-Type': 'application/gzip', 'x-upsert': 'true' }, body: buf, signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new StorageError(502, `Backup upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
async function backupGet(name) {
  if (DRIVER === 'local') return fs.readFileSync(path.join(backupDir(), name));
  if (DRIVER === 'none') throw new StorageError(503, 'Backup storage is not set up.');
  const res = await sb('GET', backupUrl(name), { headers: auth(), signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new StorageError(res.status === 404 ? 404 : 502, 'The backup file could not be read (' + res.status + ').');
  return Buffer.from(await res.arrayBuffer());
}
async function backupRemove(name) {
  try { if (DRIVER === 'local') fs.rmSync(path.join(backupDir(), name), { force: true }); else if (DRIVER === 'supabase') await sb('DELETE', backupUrl(name), { headers: auth() }); } catch { /* best effort */ }
}

module.exports = { backupInit, backupPut, backupGet, backupRemove, BACKUP_BUCKET, DRIVER, BUCKET, MIME, PREFIX, put, remove, init, publicUrl, StorageError, auth, objectUrl };
