'use strict';
// Logistics against a real database: providers, recorded rates, comparison, booking requests through the approval engine, shipment tracking and proof of delivery.
// Run with: npm run test:ops-logistics   (creates and drops its own database)
const assert = require('assert');
const { Client } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_opslog_' + Date.now().toString(36);
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };
const rejects = async (p, re) => { try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message); return e; } throw new Error('expected an error'); };

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.DATABASE_URL = urlOf(DB); process.env.NODE_ENV = 'test';
  const { run, get, all, migrate, close, now } = require('../lib/db');
  await migrate();
  const St = require('../lib/ops/store'), AP = require('../lib/ops/approvals'), LG = require('../lib/ops/logistics');
  const mk = async (name, role) => ({ id: Number((await run("INSERT INTO users (name,email,phone,password,role,created) VALUES (?,?,?,?,?,?)", name, name.toLowerCase() + '@t.test', '0800' + Math.floor(Math.random() * 1e7), 'x', role, 1)).lastInsertRowid), name, email: name.toLowerCase() + '@t.test', role });
  const owner = await mk('Owner', 'admin'), sup = await mk('Sup', 'staff'), req = await mk('Req', 'staff');
  await run('INSERT INTO ops_approvers (user_id,max_level,emergency,created) VALUES (?,2,0,1)', sup.id);
  const T = now(), mkOrder = async (ref, o = {}) => Number((await run("INSERT INTO orders (ref,payment_method,payment_status,status,name,email,phone,state,subtotal,total,created,delivery,own_lines,country) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ref, 'card', 'paid', o.status || 'confirmed', 'Cust', 'c@t.test', '0803', o.state || 'Lagos', 5000, 5000, T - 3600, 'home', 1, o.country || 'NG')).lastInsertRowid);
  const ctx = { agent: 'logistics', user: req, requestedByUser: true };
  const prov = async (name, extra = {}) => { const id = await LG.createProvider(owner, { name, coverage: 'Lagos', ...extra }); return id; };
  const rate = (id, o = {}) => LG.addRate(owner, id, { price: 3000, currency: 'NGN', destination: 'Lagos', source: 'provider_quote', source_ref: 'Quote Q-1, 20 Nov', eta_days_max: 3, ...o });

  console.log('\nProviders and recorded rates');
  const A = await prov('Alpha Express'), B = await prov('Beta Cargo');
  await test('a new provider is under review, and approving needs a reason', async () => {
    assert.strictEqual((await get('SELECT status FROM ops_providers WHERE id=?', A)).status, 'under_review');
    await rejects(LG.setProviderStatus(owner, A, 'approved', ''), /why/i); await LG.setProviderStatus(owner, A, 'approved', 'Contract signed and reference checked'); await LG.setProviderStatus(owner, B, 'approved', 'Test parcel delivered');
  });
  await test('a rate must have a price, a known source and a reference', async () => {
    await rejects(rate(A, { price: 0 }), /price/i); await rejects(rate(A, { source: 'memory' }), /where the rate/i); await rejects(rate(A, { source_ref: '' }), /reference/i);
  });
  const rA = await rate(A, { price: 3000 }), rB = await rate(B, { price: 2500, eta_days_max: 5 });
  await rate(A, { destination: 'Kano', price: 9000 });

  console.log('\nComparing for an order');
  const o1 = await mkOrder('L1');
  await test('the comparison uses only recorded rates that fit, says why others do not, and recommends one', async () => {
    const r = await LG.compareForOrder(o1, { weight_kg: 4 });
    assert.strictEqual(r.rows.length, 3); assert.strictEqual(r.rows.filter((x) => x.qualified).length, 2); assert.ok(r.rows.some((x) => /Kano/.test(x.disqualified_because.join())));
    assert.ok(r.recommended); assert.ok(r.explanation.length > 20); assert.strictEqual(r.cheapest.provider.name, 'Beta Cargo');
  });
  await test('an unapproved provider and an expired rate are excluded', async () => {
    const C = await prov('Gamma Dispatch'); await rate(C, { price: 1000 }); const D = await prov('Delta Old'); await LG.setProviderStatus(owner, D, 'approved', 'ok'); await rate(D, { price: 500, valid_until: T - 10 });
    const r = await LG.compareForOrder(o1, { weight_kg: 4 }); assert.ok(!r.rows.find((x) => x.provider.name === 'Gamma Dispatch').qualified); assert.ok(/expired/.test(r.rows.find((x) => x.provider.name === 'Delta Old').disqualified_because.join()));
  });
  await test('a foreign-currency rate with no verified exchange rate cannot be compared', async () => { await rate(B, { price: 20, currency: 'USD' }); const r = await LG.compareForOrder(o1, { weight_kg: 4 }); assert.ok(r.rows.some((x) => x.card.currency === 'USD' && !x.qualified && /exchange rate/.test(x.disqualified_because.join()))); });

  console.log('\nBooking requests and approval');
  await test('in Monitor mode nothing is created, it is only a recommendation', async () => {
    await St.saveConfig({ mode: 'monitor' }, 't'); const r = await LG.requestBooking(ctx, { order_id: o1, rate_id: rB }); assert.strictEqual(r.status, 'recommended'); assert.strictEqual(Number((await get('SELECT COUNT(*) n FROM ops_shipments')).n), 0);
  });
  let apr;
  await test('in Assisted mode it waits for approval; no shipment exists yet', async () => {
    await St.saveConfig({ mode: 'assisted' }, 't'); const r = await LG.requestBooking(ctx, { order_id: o1, rate_id: rB, weight_kg: 4 }); assert.strictEqual(r.status, 'pending_approval');
    apr = await get('SELECT * FROM ops_approvals WHERE ref=?', r.approval); assert.strictEqual(Number((await get('SELECT COUNT(*) n FROM ops_shipments')).n), 0);
  });
  await test('the requester cannot approve their own request; an approver can, and a booking REQUEST (not a booking) is created', async () => {
    await rejects(AP.decide(req, apr.id, 'approve', ''), /./); await AP.decide(sup, apr.id, 'approve', '');
    const s = await get("SELECT * FROM ops_shipments WHERE order_id=?", o1); assert.ok(s); assert.strictEqual(s.status, 'booking_requested'); assert.strictEqual(s.tracking_ref, '');
    assert.ok(await get("SELECT id FROM ops_tasks WHERE related_type='shipment' AND related_id=?", String(s.id)), 'staff task to book it');
  });
  await test('the same order cannot be booked twice while a shipment is open', async () => {
    const r = await LG.requestBooking(ctx, { order_id: o1, rate_id: rA, weight_kg: 4 }); const a2 = await get('SELECT * FROM ops_approvals WHERE ref=?', r.approval); await AP.decide(sup, a2.id, 'approve', '');
    assert.strictEqual(Number((await get('SELECT COUNT(*) n FROM ops_shipments WHERE order_id=?', o1)).n), 1); assert.strictEqual((await get('SELECT status FROM ops_approvals WHERE id=?', a2.id)).status, 'failed');
  });
  await test('if the rate changes after review, the approval does not take effect', async () => {
    const o2 = await mkOrder('L2'); const r = await LG.requestBooking(ctx, { order_id: o2, rate_id: rA, weight_kg: 4 }); const a = await get('SELECT * FROM ops_approvals WHERE ref=?', r.approval);
    await run('UPDATE ops_rate_cards SET price=price+500 WHERE id=?', rA); await AP.decide(sup, a.id, 'approve', '');
    assert.strictEqual(Number((await get('SELECT COUNT(*) n FROM ops_shipments WHERE order_id=?', o2)).n), 0); await run('UPDATE ops_rate_cards SET price=3000 WHERE id=?', rA);
  });
  await test('a delivered or cancelled order cannot be booked', async () => { const o3 = await mkOrder('L3', { status: 'cancelled' }); const r = await LG.requestBooking(ctx, { order_id: o3, rate_id: rA }); const a = await get('SELECT * FROM ops_approvals WHERE ref=?', r.approval); await AP.decide(sup, a.id, 'approve', ''); assert.strictEqual((await get('SELECT status FROM ops_approvals WHERE id=?', a.id)).status, 'failed'); });

  console.log('\nTracking and proof of delivery');
  const ship = await get('SELECT * FROM ops_shipments WHERE order_id=?', o1), sid = Number(ship.id);
  await test('nothing moves until a person enters the courier tracking reference, and it cannot be blank or reused', async () => {
    await rejects(LG.addEvent(sup, sid, { status: 'collected' }), /cannot move/); await rejects(LG.recordBooking(sup, sid, { tracking_ref: '' }), /cannot be made up/);
    await LG.recordBooking(sup, sid, { tracking_ref: 'BC-998', eta: T + 3 * 86400 }); assert.strictEqual((await get('SELECT status FROM ops_shipments WHERE id=?', sid)).status, 'booked');
  });
  await test('events must follow a sensible order', async () => { await rejects(LG.addEvent(sup, sid, { status: 'delivered' }), /cannot move/); await LG.addEvent(sup, sid, { status: 'collected', location: 'Ikeja' }); await LG.addEvent(sup, sid, { status: 'in_transit' }); await LG.addEvent(sup, sid, { status: 'out_for_delivery' }); });
  await test('"delivered" without proof is only claimed, and it raises an exception', async () => {
    const r = await LG.addEvent(sup, sid, { status: 'delivered' }); assert.strictEqual(r.status, 'delivered_claimed'); assert.ok(r.needs_proof);
    const seen = []; await LG.watch(async (x) => { seen.push(x.kind); }); assert.ok(seen.includes('shipment_no_proof'));
  });
  await test('delivery with proof is accepted and closes the shipment', async () => {
    const o4 = await mkOrder('L4'); const r = await LG.requestBooking({ ...ctx }, { order_id: o4, rate_id: rA }); const a = await get('SELECT * FROM ops_approvals WHERE ref=?', r.approval); await AP.decide(sup, a.id, 'approve', '');
    const s = await get('SELECT id FROM ops_shipments WHERE order_id=?', o4); await LG.recordBooking(sup, s.id, { tracking_ref: 'AX-1' }); await LG.addEvent(sup, s.id, { status: 'in_transit' });
    const d = await LG.addEvent(sup, s.id, { status: 'delivered', pod_kind: 'otp', pod_ref: 'OTP verified 4821' }); assert.ok(d.proof_accepted); const row = await get('SELECT status, pod_kind, closed_at FROM ops_shipments WHERE id=?', s.id); assert.strictEqual(row.status, 'delivered'); assert.ok(row.closed_at);
    await rejects(LG.addEvent(sup, s.id, { status: 'in_transit' }), /cannot move/);
  });

  console.log('\nThe watch');
  await test('an unbooked request, a silent shipment and a failed delivery each raise a problem, and a fixed one is no longer reported', async () => {
    const o5 = await mkOrder('L5'), o6 = await mkOrder('L6');
    const mkShip = async (o, status, extra = '') => Number((await get(`INSERT INTO ops_shipments (ref,order_id,provider_id,rate_id,status,cost,created,updated,last_event_at${extra ? ',' + extra.split('=')[0] : ''}) VALUES (?,?,?,?,?,?,?,?,?${extra ? ',' + extra.split('=')[1] : ''}) RETURNING id`, 'SHP-T' + o, o, A, rA, status, 3000, T - 8 * 3600, T - 8 * 3600, T - 30 * 3600)).id);
    const u = await mkShip(o5, 'booking_requested'), st = await mkShip(o6, 'in_transit');
    const kinds = new Set(); await LG.watch(async (x) => { kinds.add(x.kind + ':' + x.related_id); }); assert.ok(kinds.has('shipment_unbooked:' + u)); assert.ok(kinds.has('shipment_stale:' + st));
    await LG.addEvent(sup, st, { status: 'failed', note: 'Customer unreachable' }); const k2 = new Set(); await LG.watch(async (x) => { k2.add(x.kind + ':' + x.related_id); }); assert.ok(k2.has('shipment_failed:' + st)); assert.ok(!k2.has('shipment_stale:' + st));
  });

  console.log('\nScorecards and the log');
  await test('a provider with too little history is not scored; the verdict says so', async () => { const sc = await LG.scorecards(); const a = sc.find((x) => x.name === 'Alpha Express'); assert.strictEqual(a.enough, false); assert.ok(/Not enough history/.test(a.verdict)); });
  await test('every step is in the audit log', async () => { for (const t of ['provider.create', 'provider.status', 'rate.add', 'shipment.booked', 'shipment.event']) assert.ok(await get('SELECT id FROM ops_actions WHERE action_type=?', t), t); });
  await test('the owner-only provider status route rule exists in the router', async () => { assert.ok(/ownerOnly/.test(require('fs').readFileSync(require('path').join(__dirname, '../routes/ops-ai.js'), 'utf8'))); });

  await close();
  const a2 = new Client({ connectionString: ADMIN_URL }); await a2.connect(); await a2.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a2.end();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
