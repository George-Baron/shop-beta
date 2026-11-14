'use strict';
// Photo storage. Production: Supabase Storage (object storage, public bucket for product photos), so the app writes nothing to its own disk
// and any number of instances can run. Development and tests: a local folder (STORAGE_DRIVER=local, the default when SUPABASE_URL is not set).
//
//   put(buffer, name, mime) -> public URL to save in the database
//   urlFor(name)            -> public URL of an existing object
//
// Supabase Storage REST API: POST {SUPABASE_URL}/storage/v1/object/{bucket}/{name}  with  Authorization: Bearer <service key>.
// Public objects are read from {SUPABASE_URL}/storage/v1/object/public/{bucket}/{name}.
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'product-images';
const DRIVER = (process.env.STORAGE_DRIVER || (SUPABASE_URL && SERVICE_KEY ? 'supabase' : 'local')).toLowerCase();
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const LOCAL_DIR = path.join(DATA_DIR, 'uploads');

if (!['supabase', 'local'].includes(DRIVER)) throw new Error('STORAGE_DRIVER must be "supabase" or "local".');
if (DRIVER === 'supabase' && !(SUPABASE_URL && SERVICE_KEY)) throw new Error('Supabase storage needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
if (DRIVER === 'local') {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_UPLOADS !== '1') {
    throw new Error('Photos would be saved on this server\'s disk, which is wiped on restart and not shared between instances. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or ALLOW_LOCAL_UPLOADS=1 if you really mean it).');
  }
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
}

const publicUrl = (name) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(name)}`;
const urlFor = (name) => (DRIVER === 'supabase' ? publicUrl(name) : '/uploads/' + name);

async function put(buf, name, mime) {
  if (!/^[a-f0-9]{16,}\.(png|jpg|webp|gif)$/.test(name)) throw new Error('Bad file name');
  if (DRIVER === 'local') { fs.writeFileSync(path.join(LOCAL_DIR, name), buf); return '/uploads/' + name; }
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY, 'Content-Type': mime, 'Cache-Control': 'max-age=2592000', 'x-upsert': 'true' },
    body: buf,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); console.error('Storage upload failed', res.status, t.slice(0, 200)); throw Object.assign(new Error('Photo storage is not available right now. Please try again.'), { status: 502, storage: true }); }
  return publicUrl(name);
}

// True for a link to a file in our own bucket (so it is accepted even where the storage URL is plain http, e.g. a local test server).
const isOwnUrl = (u) => DRIVER === 'supabase' && typeof u === 'string' && u.startsWith(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`) && /^[^\s"'<>]+$/.test(u);

/* ---------- private stores (never public): backups, prescriptions, pharmacy documents ---------- */
// Supabase: a PRIVATE bucket you create yourself (leave "Public" off). Local: DATA_DIR/<folder>.
const sb = (p, init = {}) => fetch(`${SUPABASE_URL}/storage/v1/${p}`, { ...init, headers: { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY, ...(init.headers || {}) }, signal: AbortSignal.timeout(60000) });
const okName = (n) => /^[A-Za-z0-9._-]{3,120}$/.test(n);
function makeStore(bucket, folder, label) {
  const dir = path.join(DATA_DIR, folder);
  return {
    bucket, label,
    async put(name, buf) {
      if (!okName(name)) throw new Error('Bad file name');
      if (DRIVER === 'local') { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), buf); return; }
      const r = await sb(`object/${bucket}/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' }, body: buf });
      if (!r.ok) throw new Error(`${label} upload failed (${r.status}). Does the private bucket "${bucket}" exist? ${(await r.text().catch(() => '')).slice(0, 120)}`);
    },
    async list() { // newest first: [{ name, size, created }]
      if (DRIVER === 'local') { if (!fs.existsSync(dir)) return []; return fs.readdirSync(dir).filter(okName).map((n) => { const st = fs.statSync(path.join(dir, n)); return { name: n, size: st.size, created: Math.floor(st.mtimeMs / 1000) }; }).sort((a, b) => (a.name < b.name ? 1 : -1)); }
      const r = await sb(`object/list/${bucket}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 500, sortBy: { column: 'name', order: 'desc' } }) });
      if (!r.ok) throw new Error(`Could not list ${label} (${r.status})`);
      return (await r.json()).filter((o) => o.name && okName(o.name)).map((o) => ({ name: o.name, size: Number(o.metadata && o.metadata.size) || 0, created: Math.floor(Date.parse(o.created_at || o.updated_at || 0) / 1000) || 0 }));
    },
    async get(name) {
      if (!okName(name)) throw new Error('Bad file name');
      if (DRIVER === 'local') return fs.readFileSync(path.join(dir, name));
      const r = await sb(`object/${bucket}/${encodeURIComponent(name)}`);
      if (!r.ok) throw new Error(`Could not read ${label} (${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    },
    async remove(name) {
      if (!okName(name)) throw new Error('Bad file name');
      if (DRIVER === 'local') { fs.rmSync(path.join(dir, name), { force: true }); return; }
      const r = await sb(`object/${bucket}/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`Could not delete ${label} (${r.status})`);
    },
  };
}
const backups = makeStore(process.env.SUPABASE_BACKUP_BUCKET || 'backups', 'backups', 'backup');
const prescriptions = makeStore(process.env.SUPABASE_RX_BUCKET || 'prescriptions', 'prescriptions', 'prescription file'); // files are encrypted by the app before they are stored
const pharmacyDocs = makeStore(process.env.SUPABASE_PHARMACY_BUCKET || 'pharmacy-docs', 'pharmacy-docs', 'pharmacy document');

module.exports = { put, urlFor, isOwnUrl, backups, prescriptions, pharmacyDocs, DRIVER, LOCAL_DIR, BUCKET, SUPABASE_URL };
