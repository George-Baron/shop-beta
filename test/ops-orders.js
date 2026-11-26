'use strict';
// Global order management against a real database: every channel is picked up, followed per stage, and closed only when the store records delivery.
// Run with: npm run test:ops-orders   (creates and drops its own database)
const assert = require('assert');
const { Client } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_opsord_' + Date.now().toString(36);
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.DATABASE_URL = urlOf(DB); process.env.NODE_ENV = 'test';
  const { run, get, all, migrate, close, now } = require('../lib/db');
  await migrate();
  const OR = require('../lib/ops/orders'), St = require('../lib/ops/store');
  const T = now(), mkOrder = async (o = {}) => Number((await run("INSERT INTO orders (ref,payment_method,payment_status,status,name,email,phone,state,subtotal,total,created,delivery,own_lines,country) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    o.ref || 'O' + Math.random().toString(36).slice(2, 8), o.pay || 'card', o.paid || 'paid', o.status || 'confirmed', 'Cust', 'c@t.test', '0803', 'Lagos', 5000, 5000, o.created || T - 7200, o.delivery || 'home', 1, o.country || 'NG')).lastInsertRowid);
  const watch = (id, kind = 'order') => get('SELECT * FROM ops_order_watch WHERE kind=? AND ref_id=?', kind, id);

  console.log('\nPicking up orders');
  const a = await mkOrder({ ref: 'A1', status: 'pending', paid: 'unpaid', created: T - 600 }), b = await mkOrder({ ref: 'B1', status: 'confirmed', created: T - 7200 });
  await test('a sweep registers every open order, once', async () => {
    const r = await OR.sweep(); assert.strictEqual(r.new, 2);
    assert.strictEqual((await watch(a)).stage, 'awaiting_payment'); assert.strictEqual((await OR.sweep()).new, 0);
    assert.strictEqual(Number((await get('SELECT COUNT(*) n FROM ops_order_stage_events')).n), 2);
  });
  await test('an unpaid order waiting on the customer is not an exception', async () => assert.strictEqual(Number((await get("SELECT COUNT(*) n FROM ops_exceptions WHERE dedupe_key=?", 'order_late:order:' + a)).n), 0));

  console.log('\nFollowing late orders');
  await test('a confirmed, unassigned order is awaiting dispatch, raises one exception and the AI tries to assign', async () => {
    assert.strictEqual((await watch(b)).stage, 'awaiting_dispatch');
    const ex = await all("SELECT * FROM ops_exceptions WHERE dedupe_key=? AND status='open'", 'order_late:order:' + b); assert.strictEqual(ex.length, 1);
    assert.ok(await get("SELECT id FROM ops_actions WHERE action_type='rider.assign' AND related_id=?", String(b)), 'rider.assign was logged through the gateway');
    assert.strictEqual(Number((await watch(b)).attempts), 1);
  });
  await test('a repeat sweep does not hammer: backoff holds the next attempt', async () => { await OR.sweep(); assert.strictEqual(Number((await watch(b)).attempts), 1); assert.strictEqual(Number((await get("SELECT COUNT(*) n FROM ops_exceptions WHERE dedupe_key=?", 'order_late:order:' + b)).n), 1); });
  await test('after the backoff the AI tries again, and stops after the limit and tells a person', async () => {
    for (let i = 0; i < 8; i++) { await run('UPDATE ops_order_watch SET last_action_at=last_action_at-100000 WHERE ref_id=?', b); await OR.sweep(); }
    const w = await watch(b); assert.strictEqual(Number(w.attempts), OR.MAX_ATTEMPTS);
    const ex = await get("SELECT severity, detail FROM ops_exceptions WHERE dedupe_key=? AND status='open'", 'order_late:order:' + b); assert.ok(['high', 'critical'].includes(ex.severity)); assert.ok(/stopped/.test(ex.detail));
  });
  await test('switching follow-up off stops nudges but still reports', async () => {
    await St.saveConfig({ orders_follow_up: false }, null); const c = await mkOrder({ ref: 'C1', created: T - 9000 });
    const nudges = async () => Number((await get("SELECT COUNT(*) n FROM ops_actions WHERE action_type IN ('rider.assign','customer.draft') AND related_id=?", String(c))).n);
    await OR.sweep(); assert.strictEqual(await nudges(), 0);
    assert.strictEqual(Number((await get("SELECT COUNT(*) n FROM ops_exceptions WHERE dedupe_key=? AND status='open'", 'order_late:order:' + c)).n), 1);
    await St.saveConfig({ orders_follow_up: true }, null);
  });

  console.log('\nOther channels');
  await test('dropshipping, international and wholesale orders are all picked up with their own channel and stage', async () => {
    const d = await mkOrder({ ref: 'D1' }); await run('UPDATE orders SET ds_lines=1, own_lines=0, ds_open=1 WHERE id=?', d);
    const i = await mkOrder({ ref: 'I1', country: 'GB' });
    const uid = Number((await run("INSERT INTO users (name,email,phone,password,role,created) VALUES ('Buyer','buyer@t.test','0801','x','customer',1)")).lastInsertRowid);
    const acc = Number((await run("INSERT INTO wholesale_accounts (user_id,business_name,evaluate_until,created) VALUES (?,'Buyer Ltd',?,?)", uid, T, T)).lastInsertRowid);
    const q = Number((await run("INSERT INTO wholesale_quotes (ref,account_id,status,total,created,paid_at,order_no) VALUES ('Q1',?,'paid',90000,?,?,'WO-1')", acc, T - 5000, T - 4000)).lastInsertRowid);
    const wh = Number((await get("INSERT INTO wholesale_warehouses (code,name,created) VALUES ('W1','Main',1) RETURNING id")).id);
    await run("INSERT INTO wholesale_fulfilments (quote_id,warehouse_id,stage,created,updated) VALUES (?,?,'packed',?,?)", q, wh, T, T);
    await OR.sweep();
    const wq = await watch(q, 'wholesale'); assert.strictEqual(wq.channel, 'wholesale'); assert.strictEqual(wq.stage, 'wholesale_ready');
    assert.strictEqual((await watch(d)).channel, 'dropshipping'); assert.strictEqual((await watch(i)).channel, 'international');
  });

  console.log('\nClosing');
  await test('delivery recorded by the store closes the order; with no proof it is flagged, not accepted silently', async () => {
    await run("UPDATE orders SET status='delivered', delivered_at=? WHERE id=?", T, b); await OR.sweep();
    const w = await watch(b); assert.ok(w.closed_at); assert.strictEqual(w.outcome, 'delivered'); assert.strictEqual(w.proof, 'unproven');
    assert.strictEqual(Number((await get("SELECT COUNT(*) n FROM ops_exceptions WHERE dedupe_key=? AND status='open'", 'order_unproven:order:' + b)).n), 1);
    assert.strictEqual(Number((await get("SELECT COUNT(*) n FROM ops_exceptions WHERE dedupe_key=? AND status='open'", 'order_late:order:' + b)).n), 0, 'late exception cleared');
  });
  await test('an OTP proof makes the delivery verified', async () => {
    const x = await mkOrder({ ref: 'E1' }); await OR.sweep();
    const rid = Number((await get("INSERT INTO riders (user_id, full_name, created_at, updated_at) VALUES ((SELECT id FROM users LIMIT 1),'R One',?,?) RETURNING id", T, T)).id);
    await run("INSERT INTO delivery_proofs (order_id, rider_id, otp_verified, delivery_timestamp) VALUES (?,?,1,?)", x, rid, T);
    await run("UPDATE orders SET status='delivered', delivered_at=? WHERE id=?", T, x); await OR.sweep(); assert.strictEqual((await watch(x)).proof, 'verified');
  });
  await test('cancelled orders close as cancelled, never as delivered', async () => { const x = await mkOrder({ ref: 'F1' }); await OR.sweep(); await run("UPDATE orders SET status='cancelled' WHERE id=?", x); await OR.sweep(); const w = await watch(x); assert.strictEqual(w.outcome, 'cancelled'); assert.strictEqual(w.proof, 'not_applicable'); });
  await test('a closed order is never reopened or touched again', async () => { const w1 = await watch(b); await OR.sweep(); const w2 = await watch(b); assert.strictEqual(String(w1.last_seen), String(w2.last_seen)); });

  console.log('\nReads and safety');
  await test('the board counts open orders by stage and channel and never lists closed ones', async () => {
    const d = await OR.board(); assert.ok(d.open >= 4); assert.ok(!d.orders.some((x) => x.id === b)); assert.ok((await OR.board({ channel: 'international' })).orders.every((x) => x.channel === 'international'));
    assert.strictEqual(d.last7d.delivered_unproven, 1);
  });
  await test('the timeline shows stage history, AI actions and exceptions for one order', async () => { const t = await OR.timeline('order', b); assert.ok(t.events.length >= 2); assert.ok(t.actions.length >= 1); assert.ok(t.exceptions.length >= 1); assert.strictEqual(await OR.timeline('order', 999999), null); });
  await test('the sweep never changes an order, its stock or its money', async () => { const o = await get('SELECT status, total, rider_id FROM orders WHERE id=?', a); await OR.sweep(); const o2 = await get('SELECT status, total, rider_id FROM orders WHERE id=?', a); assert.deepStrictEqual(o, o2); });
  await test('switching the monitor off skips the sweep', async () => { await St.saveConfig({ monitor_enabled: false }, null); assert.ok((await OR.sweep()).skipped); await St.saveConfig({ monitor_enabled: true }, null); });
  await test('the order agent switched off skips the sweep', async () => { await St.saveConfig({ agents_disabled: ['orders'] }, null); assert.ok((await OR.sweep()).skipped); await St.saveConfig({ agents_disabled: [] }, null); });

  await close();
  const a2 = new Client({ connectionString: ADMIN_URL }); await a2.connect(); await a2.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a2.end();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
