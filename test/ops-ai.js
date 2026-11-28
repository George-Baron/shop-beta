'use strict';
// The AI Operations Manager against a real database: the gateway, approvals, the audit log and the monitor.
// Run with: npm run test:ops-ai   (needs TEST_DATABASE_URL like the other tests; creates and drops its own database)
const assert = require('assert');
const { Client } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_opsai_' + Date.now().toString(36);
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };
const rejects = async (p, re) => { try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message); return e; } throw new Error('expected an error'); };

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.DATABASE_URL = urlOf(DB); process.env.NODE_ENV = 'test';
  const { run, get, all, migrate, close } = require('../lib/db');
  await migrate();
  const St = require('../lib/ops/store'), AP = require('../lib/ops/approvals'), G = require('../lib/ops/gateway'), Mon = require('../lib/ops/monitor'), T = require('../lib/ops/tools');
  const mk = async (name, role) => ({ id: Number((await run("INSERT INTO users (name,email,phone,password,role,created) VALUES (?,?,?,?,?,?)", name, name.toLowerCase() + '@t.test', '0800' + Math.floor(Math.random() * 1e7), 'x', role, 1)).lastInsertRowid), name, role });
  const owner = await mk('Owner', 'admin'), sup = await mk('Sup', 'staff'), mgr = await mk('Mgr', 'staff'), plain = await mk('Plain', 'staff'), fin = await mk('Fin', 'staff');
  await run('INSERT INTO ops_approvers (user_id,max_level,emergency,created) VALUES (?,2,0,1),(?,3,0,1),(?,4,0,1)', sup.id, mgr.id, fin.id);
  const ctx = { agent: 'procurement', user: owner, requestedByUser: false };
  const cfgOf = (o) => St.saveConfig(o, 'test');

  console.log('\nModes');
  await test('a fresh install only recommends: no approval, no action', async () => {
    const r = await G.perform(ctx, 'reorder.execute', { summary: 'Reorder rice', amount: 50000, counterparty: 'ACME', payload: { sku: 'R1' } });
    assert.strictEqual(r.status, 'recommended'); assert.strictEqual(Number((await get('SELECT COUNT(*) n FROM ops_approvals')).n), 0);
  });
  await test('an action that is not allowed is blocked and logged', async () => {
    const r = await G.perform(ctx, 'wipe.database', {}); assert.strictEqual(r.status, 'blocked');
    assert.ok(await get("SELECT id FROM ops_actions WHERE action_type='wipe.database' AND status='blocked'"));
  });
  await test('level 0 work (a task) runs even in Monitor mode and is confirmed by the backend', async () => {
    const r = await G.perform(ctx, 'task.create', { summary: 'Call supplier', payload: { title: 'Call supplier', priority: 'normal' } });
    assert.strictEqual(r.status, 'done'); assert.ok(await get('SELECT id FROM ops_tasks WHERE id=?', r.result.task_id));
  });
  await test('an action with no system behind it is refused instead of pretending', async () => {
    await cfgOf({ mode: 'assisted' });
    const r = await G.perform(ctx, 'procurement.off_rule', { summary: 'Buy outside the reorder rules', amount: 300000, counterparty: 'ACME' });
    assert.strictEqual(r.status, 'blocked'); assert.match(r.reason, /not connected/);
  });

  console.log('\nApprovals');
  let pay;
  await test('a payment becomes an approval request that a person must carry out', async () => {
    pay = await G.perform(ctx, 'supplier.payment', { summary: 'Pay ACME invoice 7', amount: 700000, counterparty: 'ACME', related_type: 'po', related_id: 'PO-7', justification: 'Goods received' });
    assert.strictEqual(pay.status, 'pending_approval'); assert.strictEqual(pay.level_required, 4); assert.strictEqual(pay.approvals_needed, 2);
  });
  const row = () => get('SELECT * FROM ops_approvals WHERE ref=?', pay.approval);
  await test('an ordinary employee and a too-junior approver are refused', async () => {
    await rejects(AP.decide(plain, (await row()).id, 'approve', ''), /approver/i);
    await rejects(AP.decide(mgr, (await row()).id, 'approve', ''), /level/i);
  });
  await test('one approval is not enough for a level-4 payment: two different people are needed', async () => {
    await AP.decide(fin, (await row()).id, 'approve', ''); assert.strictEqual((await row()).status, 'pending');
    await rejects(AP.decide(fin, (await row()).id, 'approve', ''), /already/);
    await AP.decide(owner, (await row()).id, 'approve', ''); assert.strictEqual((await row()).status, 'approved');
  });
  await test('the AI never moves money: a person records the payment with a reference, once', async () => {
    assert.strictEqual((await row()).executor, 'human');
    await rejects(AP.complete(owner, (await row()).id, { reference: '' }), /reference/i);
    await AP.complete(fin, (await row()).id, { reference: 'BANK-123' }); assert.strictEqual((await row()).status, 'completed');
    await rejects(AP.complete(fin, (await row()).id, { reference: 'BANK-123' }));
  });
  await test('changing the terms after the request was made invalidates it', async () => {
    const r = await G.perform(ctx, 'supplier.payment', { summary: 'Pay B', amount: 1000, counterparty: 'BETA', related_type: 'po', related_id: 'PO-9' });
    const a = await get('SELECT * FROM ops_approvals WHERE ref=?', r.approval);
    await run('UPDATE ops_approvals SET amount=999999 WHERE id=?', a.id);
    await rejects(AP.decide(owner, a.id, 'approve', ''), /changed/);
  });
  await test('the same request is not duplicated when asked twice', async () => {
    const p = { summary: 'Pay C', amount: 5000, counterparty: 'GAMMA', related_type: 'po', related_id: 'PO-11' };
    const a = await G.perform(ctx, 'supplier.payment', p), b = await G.perform(ctx, 'supplier.payment', p);
    assert.strictEqual(a.approval, b.approval); assert.ok(b.existing);
  });
  await test('a rejection needs a reason and ends the request', async () => {
    const r = await G.perform(ctx, 'supplier.payment', { summary: 'Pay D', amount: 5000, counterparty: 'DELTA', related_type: 'po', related_id: 'PO-12' });
    const id = (await get('SELECT id FROM ops_approvals WHERE ref=?', r.approval)).id;
    await rejects(AP.decide(owner, id, 'reject', ''), /why/i);
    await AP.decide(owner, id, 'reject', 'Wrong supplier'); assert.strictEqual((await get('SELECT status FROM ops_approvals WHERE id=?', id)).status, 'rejected');
  });
  await test('a person asking through the assistant cannot approve their own request', async () => {
    const r = await G.perform({ agent: 'finance', user: fin, requestedByUser: true }, 'supplier.payment', { summary: 'Pay E', amount: 5000, counterparty: 'EPS', related_type: 'po', related_id: 'PO-13' });
    const id = (await get('SELECT id FROM ops_approvals WHERE ref=?', r.approval)).id;
    await rejects(AP.decide(fin, id, 'approve', ''), /own request/i);
  });
  await test('an amount in a currency with no recorded rate is treated as unknown value: highest level', async () => {
    const r = await G.perform(ctx, 'supplier.payment', { summary: 'Pay F', amount: 10, currency: 'XYZ', counterparty: 'FOREIGN', related_type: 'po', related_id: 'PO-14' });
    assert.strictEqual(r.status, 'pending_approval'); assert.strictEqual(r.value_unknown, true);
  });

  console.log('\nAutonomy');
  await test('in controlled mode a routine action runs, but the financial department still asks', async () => {
    await cfgOf({ mode: 'controlled' });
    const t = await G.perform(ctx, 'task.create', { summary: 'x', payload: { title: 'Routine' } }); assert.strictEqual(t.status, 'done');
    const p = await G.perform(ctx, 'supplier.payment', { summary: 'Pay G', amount: 10, counterparty: 'G', related_type: 'po', related_id: 'PO-15' });
    assert.strictEqual(p.status, 'pending_approval');
  });
  await test('rider assignment reports the real outcome (no such order = failed, never "done")', async () => {
    const r = await G.perform({ ...ctx, agent: 'logistics' }, 'rider.assign', { summary: 'Assign', payload: { order_id: 999999 } });
    assert.strictEqual(r.status, 'failed');
  });
  await test('a switched-off agent cannot act', async () => {
    await cfgOf({ agents_disabled: ['logistics'] });
    const r = await T.run('take_action', { type: 'rider.assign', summary: 'x', payload: { order_id: 1 } }, { user: owner });
    assert.strictEqual(r.status, 'blocked'); await cfgOf({ agents_disabled: [] });
  });
  await test('changing settings is recorded', async () => assert.ok(await get("SELECT id FROM ops_actions WHERE action_type='config.change'")));

  console.log('\nAudit log');
  await test('the log cannot be edited, deleted or emptied', async () => {
    await rejects(run('UPDATE ops_actions SET description=? WHERE id>0', 'x'));
    await rejects(run('DELETE FROM ops_actions WHERE id>0'));
    await rejects(run('TRUNCATE ops_actions'));
  });
  await test('every AI action has an entry saying who did it', async () => {
    const rows = await all('SELECT DISTINCT actor_kind FROM ops_actions'); assert.ok(rows.length >= 2);
    assert.ok(await get("SELECT id FROM ops_actions WHERE actor_kind='human' AND action_type='approval.approve'"));
  });

  console.log('\nExceptions and the monitor');
  await test('the same problem raised twice is one open exception', async () => {
    const x = { kind: 't', severity: 'low', title: 'T', dedupe_key: 'k1' };
    const a = await St.raiseException(x), b = await St.raiseException(x); assert.strictEqual(a.ref, b.ref); assert.strictEqual(b.created, false);
  });
  await test('a problem that has cleared is closed by the monitor sweep', async () => {
    await St.raiseException({ kind: 'order_delayed', severity: 'low', title: 'old', dedupe_key: 'order_delayed:0', auto: true });
    const r = await Mon.run(); assert.ok(r.closed >= 1);
    assert.strictEqual((await get("SELECT status FROM ops_exceptions WHERE dedupe_key='order_delayed:0'")).status, 'resolved');
  });
  await close();
  const a2 = new Client({ connectionString: ADMIN_URL }); await a2.connect(); await a2.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a2.end();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
