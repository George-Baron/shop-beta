'use strict';
// Backup and restore with the wallet, rewards and card tables: a restore must bring back every balance and ledger entry exactly, and the ledger must still be protected afterwards.
const { spawnSync } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const stamp = Date.now().toString(36), A = 'sb_rs_a_' + stamp, B = 'sb_rs_b_' + stamp;
const urlFor = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
const root = path.join(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rs-'));
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const admin = async (sql) => { const c = new Client({ connectionString: ADMIN_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const q = async (db, sql, a) => { const c = new Client({ connectionString: urlFor(db) }); await c.connect(); try { return (await c.query(sql, a)).rows; } finally { await c.end(); } };
const node = (code, db, args = []) => { const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...(code.endsWith('.js') ? [code] : ['-e', code]), ...args], { cwd: root, env: { ...process.env, DATABASE_URL: urlFor(db), DATABASE_SSL: 'off', DATA_DIR: tmp }, encoding: 'utf8' }); return r; };
const totals = async (db) => (await q(db, `SELECT (SELECT COALESCE(SUM(balance),0) FROM ledger_accounts)::text bal, (SELECT COUNT(*) FROM ledger_entries)::text e, (SELECT COUNT(*) FROM wallet_txns)::text t,
   (SELECT COALESCE(SUM(points),0) FROM loyalty_accounts)::text pts, (SELECT COUNT(*) FROM loyalty_ledger)::text l, (SELECT COUNT(*) FROM loyalty_tiers)::text tiers, (SELECT COUNT(*) FROM cards)::text cards`))[0];

(async () => {
  await admin(`CREATE DATABASE ${A}`); await admin(`CREATE DATABASE ${B}`);
  try {
    const seed = `(async () => { const { migrate, run, get, close } = require('./lib/db'); await migrate();
      await run("INSERT INTO users (name,email,phone,password,role,created) VALUES ('Ann','ann@x.com','0803','x','customer',1)");
      const u = (await get("SELECT id FROM users WHERE email='ann@x.com'")).id, W = require('./lib/wallet'), L = require('./lib/loyalty');
      await W.post({ userId: u, type: 'deposit', amount: 500000, idemKey: 'k1' }); await W.post({ userId: u, type: 'purchase', amount: 120000, idemKey: 'k2' });
      await L.post({ userId: u, kind: 'earn', points: 750, idemKey: 'e1' });
      await run("INSERT INTO device_sessions (user_id,access_hash,refresh_hash,access_expires,refresh_expires,created,last_seen) VALUES (?,?,?,?,?,?,?)", u, 'a', 'b', 9e9, 9e9, 1, 1);
      const snap = await require('./lib/backup').snapshot(); require('fs').writeFileSync(process.argv[1], snap.buffer); await close(); })().catch((e) => { console.error(e); process.exit(1); });`;
    const file = path.join(tmp, 'backup.json.gz');
    await test('a backup is taken from a database with wallet and rewards activity', async () => { const r = node(seed, A, [file]); assert.strictEqual(r.status, 0, r.stderr); assert.ok(fs.statSync(file).size > 100); });
    let before;
    await test('the backup holds the ledgers but not sign-in tokens', async () => {
      before = await totals(A); assert.strictEqual(before.bal, '0'); assert.strictEqual(before.t, '2'); assert.strictEqual(before.pts, '750');
      const c = require('../lib/backup').decode(fs.readFileSync(file)); assert.ok(c.tables.ledger_entries.length === 4 && c.tables.wallet_txns.length === 2 && !('device_sessions' in c.tables));
    });
    await test('restoring into a new empty database brings back every balance and ledger entry', async () => {
      const r = node('scripts/restore.js', B, [file]); assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.deepStrictEqual(await totals(B), before);
      assert.strictEqual((await q(B, "SELECT balance::text b FROM ledger_accounts WHERE kind='customer_wallet'"))[0].b, '380000');
    });
    await test('after a restore the ledger is still protected and the books still balance', async () => {
      await assert.rejects(q(B, 'UPDATE ledger_entries SET amount=amount+1'), /immutable/); await assert.rejects(q(B, 'DELETE FROM loyalty_ledger'), /immutable/); await assert.rejects(q(B, 'DELETE FROM wallet_txns'), /cannot be deleted/);
      const r = node(`require('./lib/wallet').reconcile().then((x)=>{console.log(JSON.stringify(x));process.exit(0)})`, B); assert.strictEqual(JSON.parse(r.stdout.trim().split('\\n').pop()).ok, true, r.stdout + r.stderr);
    });
    await test('a forced restore over existing data replaces the ledgers and puts the guards back', async () => {
      await q(B, "INSERT INTO ledger_accounts (kind,currency,created) VALUES ('adjustment','NGN',1) ON CONFLICT DO NOTHING");
      const r = node('scripts/restore.js', B, [file, '--force']); assert.strictEqual(r.status, 0, r.stdout + r.stderr); assert.deepStrictEqual(await totals(B), before);
      await assert.rejects(q(B, 'DELETE FROM ledger_entries'), /immutable/);
    });
    await test('restoring over existing data without --force is refused', async () => { const r = node('scripts/restore.js', B, [file]); assert.notStrictEqual(r.status, 0); assert.ok(/already has data/.test(r.stdout + r.stderr)); });
  } finally {
    await admin(`DROP DATABASE IF EXISTS ${A} WITH (FORCE)`).catch(() => {}); await admin(`DROP DATABASE IF EXISTS ${B} WITH (FORCE)`).catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
