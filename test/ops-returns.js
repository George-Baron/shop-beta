'use strict';
// AI returns layer against a real database: board, recommendation (once per result), exceptions, and that it never changes a return.
// Run with: npm run test:ops-returns   (creates and drops its own database)
const assert = require('assert');
const { Client } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_opsret_' + Date.now().toString(36);
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.DATABASE_URL = urlOf(DB); process.env.NODE_ENV = 'test';
  const { run, get, all, migrate, close, now } = require('../lib/db');
  await migrate();
  const RO = require('../lib/ops/returns-ops'), St = require('../lib/ops/store'), MON = require('../lib/ops/monitor');
  const T = now(); let n = 0;
  const uid = Number((await get("INSERT INTO users (name,email,phone,password,role,created) VALUES ('Ada','ada@t.test','0801','x','customer',?) RETURNING id", T)).id);
  await run("INSERT INTO stores (slug,name,tab_label) VALUES ('supermarket','Supermarket','Supermarket') ON CONFLICT DO NOTHING");
  const pid = Number((await get("INSERT INTO products (slug,store,name,price,stock,sku,listing,active,created,images) VALUES ('k','supermarket','Kettle',6000,10,'k','approved',1,1,'[]') RETURNING id")).id);
  const ret = async (o = {}) => {
    const ref = 'OR' + (++n), oid = Number((await get("INSERT INTO orders (ref,user_id,status,payment_method,payment_status,paystack_ref,name,email,phone,state,delivery_fee,subtotal,discount,total,created,access_token,delivered_at,wallet_amount) VALUES (?,?,'delivered','paystack','paid',?,'Ada','ada@t.test','0803','Lagos',1000,5000,0,6000,?,?,?,0) RETURNING id", ref, uid, 'ps' + n, T - 86400 * 3, 'tok' + ref + 'x'.repeat(20), T - 86400 * 2)).id);
    const it = Number((await get('INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES (?,?,?,5000,1) RETURNING id', oid, pid, 'Kettle')).id);
    const rid = Number((await get("INSERT INTO order_returns (ref,order_id,user_id,status,reason,item_condition,packaging,items,requested_amount,created,updated,decided_at,settling_at,last_error) VALUES (?,?,?,?,?,?,?,?,5000,?,?,?,?,?) RETURNING id", 'RET' + n, oid, uid, o.status || 'requested', o.reason || 'faulty', o.cond || 'damaged', 'original', JSON.stringify([{ item_id: it, name: 'Kettle', qty: 1, price: 5000 }]), o.created || T - 3600, T, o.decided || null, o.settling || null, o.err || '')).id);
    return { rid, oid, it };
  };
  const snapshot = async () => JSON.stringify(await all('SELECT id,status,approved_amount,restocked,settled_at,decision_note FROM order_returns ORDER BY id'));

  await test('board lists open returns with a recommendation, oldest first', async () => {
    await ret(); await ret({ reason: 'changed_mind', cond: 'unopened' });
    const b = await RO.board(); assert.strictEqual(b.open, 2); assert.ok(b.returns.every((r) => r.recommendation && r.recommendation.summary));
  });
  await test('a fault with no photo asks for evidence', async () => { const b = await RO.board(); assert.strictEqual(b.returns[0].recommendation.action, 'ask_evidence'); assert.strictEqual(b.returns[1].recommendation.action, 'approve_full'); });
  await test('detail explains reasons, level and stock rule', async () => {
    const d = await RO.detail(1); assert.ok(d.assessment.reasons.length && d.assessment.approver && /inspect/.test(d.assessment.restock)); assert.ok(/recommendation/i.test(d.note));
  });
  await test('recommend records once per distinct result, and logs it as a recommendation', async () => {
    const a = await RO.recommend(1); assert.strictEqual(a.recorded, true);
    const b = await RO.recommend(1); assert.strictEqual(b.recorded, false);
    const rows = await all("SELECT status, actor_kind FROM ops_actions WHERE action_type='refund.recommend' AND related_id='1'"); assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].status, 'recommended');
  });
  await test('a changed situation is recorded again (evidence arrives)', async () => {
    await run("INSERT INTO order_return_photos (return_id,stored,mime,size,created) VALUES (1,'x.jpg','image/jpeg',10,?)", T);
    const c = await RO.recommend(1); assert.strictEqual(c.recorded, true); assert.strictEqual(c.assessment.action, 'approve_full');
  });
  await test('sweep records for every open return and moves nothing', async () => {
    const before = await snapshot(); const s = await RO.sweep(); assert.ok(s.recorded >= 1); assert.strictEqual(await snapshot(), before, 'returns are untouched');
    assert.strictEqual((await RO.sweep()).recorded, 0, 'nothing new the second time');
  });
  await test('the AI never approves, settles or restocks (no money or stock written)', async () => {
    assert.strictEqual(Number((await get("SELECT COUNT(*) n FROM order_returns WHERE status IN ('awaiting_settlement','settled') OR restocked=1")).n), 0);
    assert.strictEqual(Number((await get("SELECT stock FROM products WHERE id=?", pid)).stock), 10);
  });
  await test('unreviewed return raises medium, then high', async () => {
    await ret({ created: T - 30 * 3600 }); await ret({ created: T - 80 * 3600 });
    const got = []; await RO.watch(async (x) => got.push(x));
    const u = got.filter((x) => x.kind === 'return_unreviewed'); assert.deepStrictEqual(u.map((x) => x.severity).sort(), ['high', 'medium']); assert.ok(u.every((x) => x.dedupe_key.startsWith('return_unreviewed:')));
  });
  await test('stuck settlement, failed refund and unpaid approval raise high exceptions', async () => {
    await ret({ status: 'settling', settling: T - 3600, decided: T - 7200 }); await ret({ status: 'awaiting_settlement', decided: T - 100 * 3600, err: 'Gateway timeout' });
    const got = []; await RO.watch(async (x) => got.push(x)); const k = (s) => got.filter((x) => x.kind === s);
    assert.strictEqual(k('refund_stuck').length, 1); assert.strictEqual(k('refund_unsettled').length, 1); assert.strictEqual(k('refund_failed').length, 1); assert.ok([...k('refund_stuck'), ...k('refund_unsettled'), ...k('refund_failed')].every((x) => x.severity === 'high'));
  });
  await test('a fresh return raises nothing', async () => { const got = []; await RO.watch(async (x) => got.push(x)); assert.ok(!got.some((x) => x.related_id === '2')); });
  await test('monitor run raises and later closes return exceptions', async () => {
    await MON.run(); assert.ok(Number((await get("SELECT COUNT(*) n FROM ops_exceptions WHERE kind LIKE 'return_%' OR kind LIKE 'refund_%'")).n) >= 3);
    await run("UPDATE order_returns SET status='rejected' WHERE status<>'rejected'"); await MON.run();
    assert.strictEqual(Number((await get("SELECT COUNT(*) n FROM ops_exceptions WHERE (kind LIKE 'return_%' OR kind LIKE 'refund_%') AND status='open'")).n), 0);
  });
  await test('late flag on the board', async () => { await ret({ created: T - 50 * 3600 }); const b = await RO.board(); assert.ok(b.late >= 1); });
  await test('agent switched off: sweep does nothing', async () => { await St.saveConfig({ agents_disabled: ['customer_fulfilment'] }, 'o'); assert.ok((await RO.sweep()).skipped); await St.saveConfig({ agents_disabled: [] }, 'o'); });

  await close(); const a2 = new Client({ connectionString: ADMIN_URL }); await a2.connect(); await a2.query(`DROP DATABASE ${DB} WITH (FORCE)`); await a2.end();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
