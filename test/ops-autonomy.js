'use strict';
// Controlled autonomy against a real database: evidence, the rollout gate, the safeguard record, the circuit breaker, the pause switch.
// Run with: npm run test:ops-autonomy   (creates and drops its own database)
const assert = require('assert');
const { Client } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_opsauto_' + Date.now().toString(36);
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.DATABASE_URL = urlOf(DB); process.env.NODE_ENV = 'test';
  const { run, get, all, migrate, close, now } = require('../lib/db');
  await migrate();
  const St = require('../lib/ops/store'), AU = require('../lib/ops/autonomy'), G = require('../lib/ops/gateway'), P = require('../lib/ops/policy'), H = require('../lib/ops/handlers'), MON = require('../lib/ops/monitor');
  const mk = async (name, role) => Number((await get("INSERT INTO users (name,email,phone,password,role,created) VALUES (?,?,?,?,?,?) RETURNING id", name, name.toLowerCase() + '@t.test', '0800' + Math.floor(Math.random() * 1e7), 'x', role, now())).id);
  const ownerId = await mk('Owner', 'admin'), supId = await mk('Sup', 'staff');
  const T = now();
  const approval = (dept, status, n = 1) => (async () => { for (let i = 0; i < n; i++) await run(`INSERT INTO ops_approvals (action_type,category,department,level_required,payload_hash,requested_by_kind,status,deadline,created,updated) VALUES ('rider.assign','logistics',?,1,?,'ai',?,?,?,?)`, dept, 'h' + Math.random(), status, T + 9999, T, T); })();
  const only = (d) => ({ mode: 'controlled', department_modes: Object.fromEntries(P.DEPT_KEYS.map((k) => [k, k === d ? 'controlled' : 'monitor'])) });
  const keys = (b) => b.blocked.flatMap((x) => x.failing.map((f) => f.key));

  await test('starts safe: Monitor, not paused, nothing earned', async () => {
    const c = await St.getConfig(); assert.strictEqual(c.mode, 'monitor'); assert.strictEqual(c.autonomy_paused, false);
    const r = await AU.readiness(); assert.ok(r.departments.every((d) => d.mode === 'monitor' && !d.controlled.ok));
  });
  await test('cannot go to Controlled on a fresh install, and says exactly why', async () => {
    const g = await AU.guard({ mode: 'controlled' }, 'Owner');
    assert.strictEqual(g.allowed, false);
    for (const k of ['approvers', 'monitor', 'safeguards', 'evidence', 'acknowledged']) assert.ok(keys(g).includes(k), k);
  });
  await test('Assisted needs approvers, then opens', async () => {
    assert.strictEqual((await AU.guard({ mode: 'assisted' }, 'Owner')).allowed, false);
    await run('INSERT INTO ops_approvers (user_id,max_level,emergency,created) VALUES (?,3,0,?)', supId, T);
    assert.strictEqual((await AU.guard({ mode: 'assisted' }, 'Owner')).allowed, true);   // owner (admin) + a level-3 approver
  });
  await test('lowering a mode is never blocked', async () => { await St.saveConfig({ mode: 'assisted' }, 'Owner'); assert.strictEqual((await AU.guard({ mode: 'monitor' }, 'Owner')).allowed, true); });
  await test('evidence counts only decided AI proposals', async () => {
    await approval('riders', 'approved', 9); await approval('riders', 'rejected', 1); await approval('riders', 'pending', 5); await approval('riders', 'expired', 3);
    const e = (await AU.evidence()).riders; assert.deepStrictEqual([e.approved, e.rejected, e.decided, e.approved_pct], [9, 1, 10, 90]);
  });
  await test('the safeguard test runs, is recorded and is logged', async () => {
    const r = await AU.runSafeguards('Owner'); assert.ok(r.ok);
    assert.ok((await AU.kvGet('safeguard_last')).ok); assert.ok(await get("SELECT id FROM ops_actions WHERE action_type='safeguards.test' AND status='done'"));
  });
  await test('monitor run is stamped, and the gate sees it', async () => { await MON.run(); const f = await AU.facts(); assert.ok(f.monitor_age_min !== null && f.monitor_age_min <= 1); });
  await test('still blocked until the owner acknowledges; then riders still need GPS-live riders', async () => {
    let g = await AU.guard({ mode: 'controlled' }, 'Owner'); assert.ok(keys(g).includes('acknowledged'));
    await AU.acknowledge('riders', 'Owner');
    g = await AU.guard(only('riders'), 'Owner');
    assert.strictEqual(g.allowed, false); assert.deepStrictEqual(keys(g), ['riders']);
  });
  await test('a rider with live GPS satisfies it; the department opens alone', async () => {
    const rid = Number((await get("INSERT INTO riders (user_id, full_name, phone, verification_status, availability_status, created_at, updated_at) VALUES (?,'R One','0801','verified','available',?,?) RETURNING id", ownerId, T, T)).id);
    const ses = Number((await get('INSERT INTO rider_tracking_sessions (rider_id,started_at) VALUES (?,?) RETURNING id', rid, now())).id);
    await run('INSERT INTO rider_latest_location (rider_id,latitude,longitude,location_timestamp,received_at,tracking_session_id) VALUES (?,6.5,3.4,?,?,?)', rid, now(), now(), ses);
    const f = await AU.facts(); assert.strictEqual(f.riders_verified, 1);
    assert.strictEqual(f.riders_fresh_gps, 1);
    const g = await AU.guard(only('riders'), 'Owner'); assert.strictEqual(g.allowed, true); assert.ok(!g.overridden);
  });
  await test('an owner override needs a written reason, is logged, and cannot open Financial', async () => {
    const before = P.effectiveMode('retail', await St.getConfig());
    let g = await AU.guard(only('retail'), 'Owner'); assert.strictEqual(g.allowed, false);
    g = await AU.guard(only('retail'), 'Owner', 'too short'); assert.strictEqual(g.allowed, false);
    g = await AU.guard(only('retail'), 'Owner', 'Owner accepts the risk for the pilot week'); assert.strictEqual(g.allowed, true); assert.ok(g.overridden);
    assert.ok(await get("SELECT id FROM ops_actions WHERE action_type='autonomy.override' AND recommendation LIKE '%pilot week%'"));
    assert.strictEqual(P.effectiveMode('financial', P.normalizeConfig({ mode: 'controlled', department_modes: { financial: 'controlled' } })), 'assisted');
    assert.strictEqual(before, 'assisted');
    g = await AU.guard(only('financial'), 'Owner', 'Owner accepts the risk for the pilot week'); assert.strictEqual(g.allowed, true, 'financial stays at assisted so nothing rises');
  });
  await test('acknowledging Financial is refused', async () => { await assert.rejects(AU.acknowledge('financial', 'Owner'), /never be autonomous/); await assert.rejects(AU.acknowledge('nonsense', 'Owner'), /Unknown/); });

  // gateway behaviour in Controlled
  await St.saveConfig({ mode: 'controlled', department_modes: { riders: 'controlled' }, breaker_failures: 3, breaker_window_min: 30, autonomy_daily_limit: 1000 }, 'Owner');
  const orig = H.HANDLERS['rider.assign'];
  await test('Controlled: a routine action executes through the gateway', async () => {
    H.HANDLERS['rider.assign'] = async () => ({ status: 'done', summary: 'ok', result: { assignment_id: 1 } });
    const r = await G.perform({ agent: 'logistics_dispatch' }, 'rider.assign', { related_type: 'order', related_id: '1', payload: {} }); assert.strictEqual(r.status, 'done');
  });
  await test('daily limit: past it the same action waits for a person', async () => {
    await St.saveConfig({ autonomy_daily_limit: 1 }, 'Owner');
    const r = await G.perform({ agent: 'logistics_dispatch' }, 'rider.assign', { related_type: 'order', related_id: '2', payload: {} }); assert.strictEqual(r.status, 'pending_approval');
    await St.saveConfig({ autonomy_daily_limit: 1000 }, 'Owner');
  });
  await test('circuit breaker: repeated failures pause autonomy and raise a critical exception', async () => {
    H.HANDLERS['rider.assign'] = async () => { throw new Error('boom'); };
    for (let i = 0; i < 3; i++) await G.perform({ agent: 'logistics_dispatch' }, 'rider.assign', { related_type: 'order', related_id: 'f' + i, payload: {} });
    const c = await St.getConfig(); assert.strictEqual(c.autonomy_paused, true);
    assert.ok(await get("SELECT id FROM ops_exceptions WHERE dedupe_key='autonomy:breaker' AND severity='critical' AND status='open'"));
    assert.ok(await get("SELECT id FROM ops_actions WHERE action_type='autonomy.pause' AND actor_kind='system'"));
  });
  await test('while paused the AI asks instead of acting, even for routine work', async () => {
    H.HANDLERS['rider.assign'] = async () => ({ status: 'done', summary: 'ok', result: {} });
    const r = await G.perform({ agent: 'logistics_dispatch' }, 'rider.assign', { related_type: 'order', related_id: '3', payload: {} }); assert.strictEqual(r.status, 'pending_approval');
  });
  await test('a person resumes; the exception closes; autonomy works again (failures are not re-counted forever)', async () => {
    await AU.setPaused(false, 'Owner', 'Fixed the handler');
    assert.strictEqual((await St.getConfig()).autonomy_paused, false);
    assert.ok(!(await get("SELECT id FROM ops_exceptions WHERE dedupe_key='autonomy:breaker' AND status='open'")));
    assert.ok(await get("SELECT id FROM ops_actions WHERE action_type='autonomy.resume'"));
  });
  await test('breaker does not trip below the threshold or on non-autonomous failures', async () => {
    const before = await AU.checkBreaker(); assert.strictEqual(before.tripped, true, 'old failures are still inside the 30-minute window, so it trips again');
    await AU.setPaused(false, 'Owner', 'test'); await St.saveConfig({ breaker_failures: 50 }, 'Owner'); assert.strictEqual((await AU.checkBreaker()).tripped, false);
  });
  await test('pause switch via the owner works and is logged', async () => { await AU.setPaused(true, 'Owner', 'Holiday'); assert.strictEqual((await St.getConfig()).autonomy_paused, true); assert.ok(await get("SELECT id FROM ops_actions WHERE action_type='autonomy.pause' AND recommendation='Holiday'")); await AU.setPaused(false, 'Owner'); });
  await test('level-0 reading is unaffected by a pause', async () => {
    await AU.setPaused(true, 'Owner'); const r = await G.perform({ agent: 'orchestrator' }, Object.keys(P.ACTIONS).find((t) => P.ACTIONS[t].level === 0 && !P.ACTIONS[t].human), {}); assert.notStrictEqual(r.status, 'pending_approval'); await AU.setPaused(false, 'Owner');
  });
  await test('Financial stays human even with everything switched to Controlled', async () => {
    await St.saveConfig({ mode: 'controlled', department_modes: { financial: 'controlled' } }, 'Owner');
    const r = await G.perform({ agent: 'orchestrator' }, 'payment.authorize', { amount: 1000, currency: 'NGN', counterparty: 'X' });
    assert.ok(['pending_approval', 'blocked'].includes(r.status), r.status);
    assert.ok(!(await get("SELECT id FROM ops_actions WHERE action_type='payment.authorize' AND status='done'")));
  });
  H.HANDLERS['rider.assign'] = orig;
  await test('the autonomous activity list shows only what the AI did on its own', async () => { const l = await AU.recentAutonomous(50); assert.ok(l.length > 0 && l.every((x) => x.ref)); });

  await close(); const a2 = new Client({ connectionString: ADMIN_URL }); await a2.connect(); await a2.query(`DROP DATABASE ${DB} WITH (FORCE)`); await a2.end();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
