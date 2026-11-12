'use strict';
// Database backups you can actually restore.
//
// A backup is one gzip file of JSON lines, taken from a single consistent snapshot (REPEATABLE READ, read only, so it never blocks shoppers):
//   {"type":"meta", ...}                       version, time, the migrations applied, table order (parents before children)
//   {"type":"table","name":"orders","columns":[...]}   then {"t":"orders","rows":[ ...up to 500 rows... ]} lines
//   {"type":"end","tables":{"orders":123,...}} the row counts; a file without this last line is a cut-off download and is refused
// Left out on purpose (not worth restoring, or secret): sessions, password-reset tokens, rate-limit counters, the job queue, idempotency keys,
// the error log, the backup list itself and the migration bookkeeping (the restore script runs the migrations itself).
// The file DOES contain customer names, phones, addresses and password hashes: it is only ever stored in the PRIVATE bucket or downloaded by the admin.
const zlib = require('zlib');
const readline = require('readline');
const fs = require('fs');
const { Readable } = require('stream');
const { get, all, run, pool, now } = require('./db');
const log = require('./log');
const storage = require('./storage');
const errors = require('./errors');

const VERSION = 1;
const SKIP = new Set(['sessions', 'resets', 'rate_limits', 'jobs', 'job_locks', 'idempotency_keys', 'cache_epoch', 'error_log', 'backups', 'schema_migrations']);
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);
const HOUR = Number(process.env.BACKUP_HOUR_LAGOS === undefined ? 3 : process.env.BACKUP_HOUR_LAGOS);
const BATCH = 500;

// Tables in an order where parents come before the tables that point at them.
async function tableOrder(q) {
  const tables = (await q("SELECT table_name n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows.map((r) => r.n).filter((n) => !SKIP.has(n)).sort();
  const deps = (await q(`SELECT c.conrelid::regclass::text child, c.confrelid::regclass::text parent FROM pg_constraint c WHERE c.contype='f' AND c.connamespace='public'::regnamespace`)).rows;
  const left = new Set(tables), out = [];
  while (left.size) {
    const ready = [...left].filter((t) => deps.every((d) => d.child !== t || d.parent === t || !left.has(d.parent)));
    if (!ready.length) { out.push(...left); break; } // a cycle: keep going, the restore defers nothing here, so this is only a safety net
    for (const t of ready.sort()) { out.push(t); left.delete(t); }
  }
  return out;
}

// Writes the whole backup, as text chunks, to write(). Returns { tables: {name: count}, rows }.
async function dump(write) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const q = (sql, a) => client.query(sql, a);
    const order = await tableOrder(q), migrations = (await q('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
    await write(JSON.stringify({ type: 'meta', version: VERSION, created: new Date().toISOString(), migrations, tables: order }) + '\n');
    const counts = {}; let total = 0;
    for (const t of order) {
      const cols = (await q("SELECT column_name c FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position", [t])).rows.map((r) => r.c);
      await write(JSON.stringify({ type: 'table', name: t, columns: cols }) + '\n');
      const ident = '"' + t.replace(/"/g, '""') + '"';
      await q(`DECLARE bk NO SCROLL CURSOR FOR SELECT ${cols.map((c) => '"' + c + '"').join(',')} FROM ${ident}`);
      let n = 0;
      for (;;) {
        const { rows } = await q(`FETCH ${BATCH} FROM bk`);
        if (!rows.length) break;
        n += rows.length; await write(JSON.stringify({ t, rows }) + '\n');
      }
      await q('CLOSE bk'); counts[t] = n; total += n;
    }
    await write(JSON.stringify({ type: 'end', tables: counts, rows: total }) + '\n');
    await q('COMMIT');
    return { tables: counts, rows: total };
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* connection already gone */ } throw e; }
  finally { client.release(); }
}

// The whole backup as one gzip Buffer (for storing).
async function dumpToBuffer() {
  const gz = zlib.createGzip({ level: 6 }), chunks = [];
  gz.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { gz.on('end', res); gz.on('error', rej); });
  const info = await dump((s) => new Promise((res) => { if (gz.write(s)) res(); else gz.once('drain', res); }));
  gz.end(); await done;
  return { buf: Buffer.concat(chunks), ...info };
}

// Straight to an HTTP response (admin download button): nothing is kept in memory.
async function dumpToStream(out) {
  const gz = zlib.createGzip({ level: 6 }); gz.pipe(out);
  try {
    await dump((s) => new Promise((res) => { if (gz.write(s)) res(); else gz.once('drain', res); }));
    gz.end();
  } catch (e) { gz.destroy(); out.destroy(e); throw e; }
}

const stamp = (d = new Date()) => new Date(d.getTime() + 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');
const lagosHour = () => new Date(Date.now() + 3600e3).getUTCHours();

// The job. Scheduled runs happen at most once a day (first check after HOUR:00 Lagos time, or any time if the last good backup is over 30 h old).
async function runJob(payload = {}) {
  const manual = payload.kind === 'manual', t = now();
  if (!manual) {
    const last = await get("SELECT MAX(finished) f FROM backups WHERE state='ok'");
    const age = last && last.f ? t - last.f : Infinity;
    if (age < 22 * 3600) return { skipped: 'recent backup exists' };
    if (age < 30 * 3600 && lagosHour() < HOUR) return { skipped: 'waiting for the quiet hour' };
  }
  const id = (await get("INSERT INTO backups (started,state,kind,instance) VALUES (?,'running',?,?) RETURNING id", t, manual ? 'manual' : 'scheduled', log.INSTANCE)).id;
  try {
    const { buf, rows } = await dumpToBuffer();
    const name = `shop-beta-${stamp()}-${id}.ndjson.gz`;
    await storage.backupPut(name, buf);
    await run("UPDATE backups SET state='ok', finished=?, location=?, bytes=?, row_count=? WHERE id=?", now(), name, buf.length, rows, id);
    log.info('Backup finished', { backup: name, bytes: buf.length, rows });
    await prune();
    return { name, bytes: buf.length, rows };
  } catch (e) {
    await run("UPDATE backups SET state='failed', finished=?, error=? WHERE id=?", now(), String(e.message).slice(0, 500), id).catch(() => {});
    log.error('Backup failed:', e);
    errors.record(e, { source: 'backup', route: 'backup' });
    throw e; // the queue retries with backoff and finally lists it as failed
  }
}

// Keep the newest KEEP good backups; forget failed attempts older than 30 days. A backup is never removed unless newer good ones exist.
async function prune() {
  const old = await all("SELECT id, location FROM backups WHERE state='ok' ORDER BY started DESC OFFSET ?", KEEP);
  for (const b of old) { await storage.backupRemove(b.location); await run('DELETE FROM backups WHERE id=?', b.id); }
  await run("DELETE FROM backups WHERE state IN ('failed','running') AND started < ?", now() - 30 * 86400);
}

const list = () => all('SELECT * FROM backups ORDER BY started DESC LIMIT 30');
async function status() {
  const last = await get("SELECT finished, bytes, row_count FROM backups WHERE state='ok' ORDER BY finished DESC LIMIT 1");
  const first = await get('SELECT MIN(started) s FROM backups');
  return { lastOk: last ? last.finished : null, bytes: last ? last.bytes : 0, rows: last ? last.row_count : 0, everTried: !!(first && first.s), firstAttempt: first && first.s };
}

/* ---------- reading a backup file (used by the restore script and the tests) ---------- */
async function* readBackup(source) { // source: a Buffer, or the path of a .gz file
  const input = Buffer.isBuffer(source) ? Readable.from([source]) : fs.createReadStream(source);
  const gunzip = zlib.createGunzip();
  input.on('error', (e) => gunzip.destroy(new Error(e.code === 'ENOENT' ? 'Backup file not found: ' + source : 'Could not read the backup file: ' + e.message)));
  const rl = readline.createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line);
}

// Checks a backup file end to end without touching any database. Throws if it is cut off, damaged or from a newer program version.
async function verifyFile(source) {
  let meta = null, end = null; const counts = {}; let cur = null;
  for await (const o of readBackup(source)) {
    if (o.type === 'meta') { meta = o; if (o.version > VERSION) throw new Error(`This backup is version ${o.version}; this program reads up to ${VERSION}.`); }
    else if (o.type === 'table') { cur = o.name; counts[cur] = 0; }
    else if (o.type === 'end') end = o;
    else if (o.t) counts[o.t] = (counts[o.t] || 0) + o.rows.length;
  }
  if (!meta) throw new Error('Not a Shop-Beta backup (no header).');
  if (!end) throw new Error('This backup file is incomplete (the end marker is missing). Do not use it; download or pick another.');
  for (const [t, n] of Object.entries(end.tables)) if (counts[t] !== n) throw new Error(`Backup is damaged: table ${t} has ${counts[t]} rows but should have ${n}.`);
  return { meta, tables: end.tables, rows: end.rows };
}

// Loads a backup into the database behind `client` (a pg client), all in ONE transaction: it either fully works or changes nothing.
async function restore(source, client, { replace = false } = {}) {
  const info = await verifyFile(source);
  const q = (s, a) => client.query(s, a);
  await q('BEGIN');
  try {
    if (!replace) {
      for (const t of ['users', 'orders', 'products']) if ((await q(`SELECT 1 FROM ${t} LIMIT 1`)).rowCount) throw new Error(`The target database already has data in "${t}". Use --replace only if you are sure you want to overwrite it.`);
    }
    const have = new Set((await q("SELECT table_name n FROM information_schema.tables WHERE table_schema='public'")).rows.map((r) => r.n));
    const order = info.meta.tables;
    for (const t of order) if (!have.has(t)) throw new Error(`The target database has no table "${t}". Run the migrations first (npm run migrate).`);
    await q(`TRUNCATE ${order.map((t) => '"' + t + '"').join(', ')} RESTART IDENTITY CASCADE`);
    const cols = {};
    for await (const o of readBackup(source)) {
      if (o.type === 'table') cols[o.name] = o.columns;
      else if (o.t) {
        const c = cols[o.t].map((x) => '"' + x + '"').join(',');
        await q(`INSERT INTO "${o.t}" (${c}) OVERRIDING SYSTEM VALUE SELECT ${c} FROM json_populate_recordset(null::"${o.t}", $1::json)`, [JSON.stringify(o.rows)]);
      }
    }
    // Identity counters (the ids given to new rows) continue after the highest restored id. Only tables that have such a column.
    for (const r of (await q("SELECT table_name t, column_name c FROM information_schema.columns WHERE table_schema='public' AND (is_identity='YES' OR column_default LIKE 'nextval%')")).rows) {
      if (!order.includes(r.t)) continue;
      const seq = (await q('SELECT pg_get_serial_sequence($1, $2) s', ['"' + r.t + '"', r.c])).rows[0];
      if (seq && seq.s) await q(`SELECT setval($1, COALESCE((SELECT MAX("${r.c}") FROM "${r.t}"), 1), (SELECT MAX("${r.c}") IS NOT NULL FROM "${r.t}"))`, [seq.s]);
    }
    for (const [t, n] of Object.entries(info.tables)) { const c = (await q(`SELECT COUNT(*)::int c FROM "${t}"`)).rows[0].c; if (c !== n) throw new Error(`After loading, ${t} has ${c} rows but the backup has ${n}. Nothing was changed.`); }
    await q('COMMIT');
  } catch (e) { await q('ROLLBACK'); throw e; }
  return info;
}

module.exports = { dump, dumpToBuffer, dumpToStream, runJob, prune, list, status, verifyFile, restore, readBackup, stamp, KEEP, SKIP };
