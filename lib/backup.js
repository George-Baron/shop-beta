'use strict';
// Backups of the whole database, written without needing pg_dump (so they run on Render's plain Node image).
//
//   create(source)       -> takes a consistent snapshot, writes it to private storage, records it in backup_log, trims old ones
//   snapshot()           -> { buffer, name, ... } without storing it (used by the admin download)
//   decode(buffer)       -> the backup's content (decrypts if needed)
//   restore(content, db) -> loads a backup into an EMPTY database (used by scripts/restore.js)
//
// What is in a backup: every table except throw-away ones (sessions, password-reset tokens, rate limits, geo cache, job queue).
// A backup contains customer data and password hashes. Set BACKUP_PASSPHRASE to encrypt it (AES-256-GCM); keep that passphrase somewhere
// other than the server, because without it the backup cannot be read.
const crypto = require('crypto');
const zlib = require('zlib');
const { pool, now, get, run, all } = require('./db');
const storage = require('./storage');
const log = require('./log');

const SKIP = new Set(['schema_migrations', 'sessions', 'resets', 'rate_limits', 'geo_cache', 'jobs', 'backup_log']);
const MAGIC = Buffer.from('SBENC1');
const KEEP = () => Math.max(3, Number(process.env.BACKUP_KEEP) || 14);
const FORMAT = 1;

function encrypt(buf, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), enc]);
}
function decrypt(buf, pass) {
  if (!pass) throw new Error('This backup is encrypted. Set BACKUP_PASSPHRASE to the passphrase it was made with.');
  const salt = buf.subarray(6, 22), iv = buf.subarray(22, 34), tag = buf.subarray(34, 50);
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(pass, salt, 32), iv); d.setAuthTag(tag);
  try { return Buffer.concat([d.update(buf.subarray(50)), d.final()]); } catch { throw new Error('Wrong passphrase, or the backup file is damaged.'); }
}
const isEncrypted = (buf) => buf.length > 50 && buf.subarray(0, 6).equals(MAGIC);

function decode(buffer, pass = process.env.BACKUP_PASSPHRASE) {
  const raw = isEncrypted(buffer) ? decrypt(buffer, pass) : buffer;
  let content; try { content = JSON.parse(zlib.gunzipSync(raw).toString('utf8')); } catch { throw new Error('That file is not a Shop-Beta backup.'); }
  if (!content || content.format !== FORMAT || !content.tables) throw new Error('That file is not a Shop-Beta backup (or is from a newer version).');
  return content;
}

async function snapshot() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // every table is read as of the same instant
    const names = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map((r) => r.table_name).filter((n) => !SKIP.has(n));
    const tables = {}; let rows = 0;
    for (const n of names) {
      const r = await client.query(`SELECT COALESCE(json_agg(t), '[]'::json) AS j FROM "${n}" t`);
      tables[n] = r.rows[0].j; rows += tables[n].length;
    }
    await client.query('COMMIT');
    const created = now();
    const content = { format: FORMAT, app: 'shop-beta', created, tables };
    let buffer = zlib.gzipSync(Buffer.from(JSON.stringify(content)), { level: 6 });
    const pass = process.env.BACKUP_PASSPHRASE; const encrypted = !!pass;
    if (pass) buffer = encrypt(buffer, pass);
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/Z$/, 'Z'); // to the millisecond, so two backups in one second never share a name
    return { buffer, name: `shop-beta-${stamp}.json.gz${encrypted ? '.enc' : ''}`, tables: names.length, rows, encrypted };
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* gone */ } throw e; } finally { client.release(); }
}

async function create(source = 'schedule') {
  let snap;
  try {
    snap = await snapshot();
    await storage.backups.put(snap.name, snap.buffer);
    await run('INSERT INTO backup_log (name,bytes,tables,rows_total,ok,encrypted,source,created) VALUES (?,?,?,?,1,?,?,?)', snap.name, snap.buffer.length, snap.tables, snap.rows, snap.encrypted ? 1 : 0, source, now());
    log.info('backup created', { name: snap.name, bytes: snap.buffer.length, rows: snap.rows, encrypted: snap.encrypted });
    await trim();
    return snap;
  } catch (e) {
    await run('INSERT INTO backup_log (name,ok,error,source,created) VALUES (?,0,?,?,?)', snap ? snap.name : '', String(e.message).slice(0, 300), source, now()).catch(() => {});
    log.error('backup failed', { err: e });
    throw e;
  }
}

// Keep the newest BACKUP_KEEP files (default 14: two weeks of daily backups). Never deletes anything if the listing looks empty or wrong.
async function trim() {
  const list = await storage.backups.list();
  const mine = list.filter((b) => /^shop-beta-\d{8}T\d{6,9}Z\.json\.gz(\.enc)?$/.test(b.name)).sort((a, b) => (a.name < b.name ? 1 : -1));
  for (const old of mine.slice(KEEP())) await storage.backups.remove(old.name).catch((e) => log.warn('could not delete old backup', { name: old.name, err: e }));
}

// Status for the admin page and the health check: when did the last good backup happen?
async function status() {
  const last = await get('SELECT name, bytes, created, encrypted FROM backup_log WHERE ok=1 ORDER BY created DESC LIMIT 1');
  const lastFail = await get('SELECT error, created FROM backup_log WHERE ok=0 ORDER BY created DESC LIMIT 1');
  const recent = await all('SELECT id, name, bytes, tables, rows_total, ok, error, encrypted, source, created FROM backup_log ORDER BY created DESC LIMIT 15');
  const maxAge = (Number(process.env.BACKUP_MAX_AGE_HOURS) || 30) * 3600;
  return { last: last || null, lastFailure: lastFail && (!last || lastFail.created > last.created) ? lastFail : null, stale: !last || now() - last.created > maxAge, encryption: !!process.env.BACKUP_PASSPHRASE, recent, driver: storage.DRIVER };
}

/* ---------- restore ---------- */
// Loads a decoded backup into the database `client` is connected to. The database must have no shop data yet (run the migrations first).
async function restore(content, client, { force = false } = {}) {
  const have = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows.map((r) => r.table_name);
  const names = Object.keys(content.tables).filter((n) => have.includes(n) && n !== 'schema_migrations');
  const missing = Object.keys(content.tables).filter((n) => !have.includes(n) && n !== 'schema_migrations');
  if (missing.length) throw new Error('The database is missing tables that the backup has: ' + missing.join(', ') + '. Run `npm run migrate` from the same version of the code first.');
  if (!force) {
    for (const n of names) {
      if (n === 'settings') continue; // migrations may seed a few settings
      const c = (await client.query(`SELECT COUNT(*)::int n FROM "${n}"`)).rows[0].n;
      if (c > 0) throw new Error(`The database already has data (${n} has ${c} rows). Restore into a new, empty database.`);
    }
  }
  // Parents before children: order by foreign keys.
  const deps = {}; for (const n of names) deps[n] = new Set();
  const fks = (await client.query("SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace")).rows;
  for (const f of fks) { const c = f.child.replace(/"/g, ''), p = f.parent.replace(/"/g, ''); if (c !== p && deps[c] && deps[p]) deps[c].add(p); }
  const order = [], seen = new Set();
  const visit = (n, stack = []) => { if (seen.has(n)) return; if (stack.includes(n)) return; for (const d of deps[n]) visit(d, [...stack, n]); seen.add(n); order.push(n); };
  names.forEach((n) => visit(n));
  await client.query('BEGIN');
  try {
    let rows = 0;
    for (const n of order) {
      const data = content.tables[n]; if (!data.length) continue;
      if (force) await client.query(`DELETE FROM "${n}"`);
      await client.query(`INSERT INTO "${n}" OVERRIDING SYSTEM VALUE SELECT r.* FROM json_populate_recordset(NULL::"${n}", $1::json) r`, [JSON.stringify(data)]);
      rows += data.length;
    }
    // Make the id counters continue after the restored rows.
    const seqs = (await client.query("SELECT t.relname AS tbl, a.attname AS col, pg_get_serial_sequence(quote_ident(t.relname), a.attname) AS seq FROM pg_class t JOIN pg_attribute a ON a.attrelid=t.oid JOIN pg_namespace ns ON ns.oid=t.relnamespace WHERE ns.nspname='public' AND t.relkind='r' AND a.attnum>0 AND NOT a.attisdropped")).rows.filter((s) => s.seq);
    for (const s of seqs) await client.query(`SELECT setval('${s.seq}', GREATEST((SELECT COALESCE(MAX("${s.col}"),0) FROM "${s.tbl}"),1), (SELECT COUNT(*)>0 FROM "${s.tbl}"))`);
    await client.query('COMMIT');
    return { tables: order.length, rows };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
}

module.exports = { create, snapshot, decode, restore, status, trim, isEncrypted };
