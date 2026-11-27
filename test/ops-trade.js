'use strict';
// Import/export management against a real database: readiness, compliance escalation, linking to orders and purchase orders, and drafting a consignment.
// Run with: npm run test:ops-trade   (creates and drops its own database)
const assert = require('assert');
const { Client } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_opstrade_' + Date.now().toString(36);
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };
const rejects = async (p, re) => { try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message); return e; } throw new Error('expected an error'); };

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.DATABASE_URL = urlOf(DB); process.env.NODE_ENV = 'test';
  const { run, get, all, migrate, close, now } = require('../lib/db');
  await migrate();
  const St = require('../lib/ops/store'), AP = require('../lib/ops/approvals'), TO = require('../lib/ops/trade-ops'), T = require('../lib/trade'), G = require('../lib/ops/gateway'), OR = require('../lib/ops/orders');
  const mk = async (name, role) => ({ id: Number((await run("INSERT INTO users (name,email,phone,password,role,created) VALUES (?,?,?,?,?,?)", name, name.toLowerCase() + '@t.test', '0800' + Math.floor(Math.random() * 1e7), 'x', role, 1)).lastInsertRowid), name, email: name.toLowerCase() + '@t.test', role });
  const owner = await mk('Owner', 'admin'), sup = await mk('Sup', 'staff'), req = await mk('Req', 'staff');
  await run('INSERT INTO ops_approvers (user_id,max_level,emergency,created) VALUES (?,2,0,1)', sup.id);
  const T0 = now();
  const imp = async (extra = {}) => T.create(owner, { direction: 'import', incoterm: 'FOB', currency: 'USD', party_name: 'Shenzhen Parts Ltd', party_country: 'CN', origin_country: 'CN', dest_country: 'NG', transport: 'air', ...extra });
  const raised = []; const collect = async (x) => { raised.push(x); };
  const open = async (kind, id) => Number((await get("SELECT COUNT(*) n FROM ops_exceptions WHERE dedupe_key=? AND status='open'", `${kind}:${id}`)).n);

  console.log('\nReadiness from real consignments');
  const a = await imp();
  await test('an empty draft is not ready and says what is missing', async () => { const { r } = await TO.check(a); assert.strictEqual(r.ready, false); assert.ok(r.blockers.some((b) => b.code === 'no_items')); });
  await T.addItem(owner, a, { description: 'Phone cases', qty: 100, unit_value: 2, hs_code: '392690', origin_country: 'CN', weight_kg: 0.1 });
  await test('goods without invoice and packing list are still not ready', async () => { const { r } = await TO.check(a); assert.ok(r.blockers.some((b) => b.code === 'invoice_missing')); assert.ok(r.blockers.some((b) => b.code === 'packing_missing')); });
  await test('after the store issues the documents they count', async () => { const sh = await T.load(a); await T.issue(owner, sh, 'commercial_invoice'); await T.issue(owner, sh, 'packing_list'); const { r } = await TO.check(a); assert.ok(!r.blockers.some((b) => ['invoice_missing', 'packing_missing', 'no_items'].includes(b.code))); });
  await test('landed cost is an estimate with its gaps named', async () => { const d = await TO.detail(a); assert.ok(/ESTIMATE/.test(d.landed_cost.basis)); assert.ok(d.readiness.cost_gaps.length > 0); });

  console.log('\nCompliance is escalated, never decided');
  const b = await imp({ party_name: 'Volt Energy' });
  await T.addItem(owner, b, { description: 'Lithium battery packs', qty: 50, unit_value: 12, hs_code: '850760', origin_country: 'CN' });
  await test('regulated goods raise a compliance exception and block', async () => {
    const { r } = await TO.check(b); assert.ok(r.needs_compliance); assert.ok(r.blockers.some((x) => x.code === 'restricted_review'));
    await TO.watch(async (x) => St.raiseException(x)); assert.strictEqual(await open('consignment_compliance', b), 1);
  });
  await test('the AI never ticks a permit reminder', async () => { assert.strictEqual(Number((await get('SELECT COUNT(*) n FROM trade_checks')).n), 0); await TO.watch(async (x) => St.raiseException(x)); assert.strictEqual(Number((await get('SELECT COUNT(*) n FROM trade_checks')).n), 0); });
  await test('a person ticking every required reminder and the class review clears the permit blocker', async () => {
    const ship = await T.load(b), TC = require('../lib/trade-compliance'); const cl = await TC.checklist(ship, ['batteries']);
    for (const it of cl.items.filter((x) => x.required)) await TC.setCheck(owner, b, it.id, { status: 'done', note: 'Verified with authority' });
    const { r } = await TO.check(b); assert.ok(!r.blockers.some((x) => x.code === 'checklist_open'));
  });

  console.log('\nLinking to orders');
  const mkOrder = async (ref, country = 'GB') => Number((await run("INSERT INTO orders (ref,payment_method,payment_status,status,name,email,phone,state,subtotal,total,created,delivery,own_lines,country) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ref, 'card', 'paid', 'confirmed', 'Cust', 'c@t.test', '0803', 'Lagos', 5000, 5000, T0 - 7200, 'home', 1, country)).lastInsertRowid);
  const o1 = await mkOrder('X1');
  await test('an order linked to a consignment follows it and is NOT offered to a local rider', async () => {
    await TO.link(owner, a, 'order', o1, 'Export order'); await OR.sweep();
    const w = await get("SELECT * FROM ops_order_watch WHERE kind='order' AND ref_id=?", o1); assert.strictEqual(w.stage, 'awaiting_international_shipment');
    assert.strictEqual(Number((await get("SELECT COUNT(*) n FROM ops_actions WHERE action_type='rider.assign' AND related_id=?", String(o1))).n), 0);
  });
  await test('linking is idempotent, validates the target and is logged', async () => { assert.strictEqual((await TO.link(owner, a, 'order', o1)).linked, false); await rejects(TO.link(owner, a, 'order', 99999), /does not exist/); assert.ok(await get("SELECT id FROM ops_actions WHERE action_type='trade.link'")); });
  await test('a consignment cannot be linked to nonsense kinds', async () => rejects(TO.link(owner, a, 'refund', 1), /Link an order/));

  console.log('\nDrafting from a purchase order (through the approval engine)');
  const vend = Number((await get("INSERT INTO ops_vendors (ref,name,country,currency,status,verification,created,updated) VALUES ('V-1','Guangzhou Supply','CN','USD','approved',?::jsonb,?,?) RETURNING id", JSON.stringify({ registration: { state: 'verified' }, contact: { state: 'verified' } }), T0, T0)).id);
  const po = async (status, v = vend) => Number((await get("INSERT INTO ops_purchase_orders (ref,vendor_id,lines,currency,subtotal,total,status,created_by_kind,created,updated) VALUES (?,?,?::jsonb,'USD',100,100,?,'user',?,?) RETURNING id", 'PO-' + Math.random().toString(36).slice(2, 6), v, JSON.stringify([{ description: 'Phone cases', qty: 100, unit_price: 2 }]), status, T0, T0)).id);
  const ctx = { agent: 'trade', user: req, requestedByUser: true }, ask = (poId) => G.perform(ctx, 'consignment.draft', { summary: 'Draft consignment', related_type: 'purchase_order', related_id: String(poId), payload: { po_id: poId } });
  const p1 = await po('approved');
  await St.saveConfig({ mode: 'assisted' }, 't');
  await test('in Assisted mode drafting waits for approval; then it creates a draft that admits what is unconfirmed', async () => {
    const r = await ask(p1); assert.strictEqual(r.status, 'pending_approval'); assert.strictEqual(Number((await get('SELECT COUNT(*) n FROM ops_trade_links WHERE kind=?', 'purchase_order')).n), 0);
    const ap = await get('SELECT * FROM ops_approvals WHERE ref=?', r.approval); await AP.decide(sup, ap.id, 'approve', '');
    const l = await get("SELECT * FROM ops_trade_links WHERE kind='purchase_order' AND ref_id=?", p1); assert.ok(l); const s = await T.load(l.shipment_id);
    assert.strictEqual(s.status, 'draft'); assert.strictEqual(s.direction, 'import'); assert.ok(/NOT confirmed/.test(s.notes)); assert.strictEqual((await T.items(s.id)).length, 1);
  });
  await test('the same purchase order cannot get a second consignment', async () => { const r = await ask(p1); const ap = await get('SELECT * FROM ops_approvals WHERE ref=?', r.approval); await AP.decide(sup, ap.id, 'approve', ''); assert.strictEqual((await get('SELECT status FROM ops_approvals WHERE id=?', ap.id)).status, 'failed'); });
  await test('an unapproved purchase order and a Nigerian supplier are refused', async () => {
    const pd = await po('draft'), ng = Number((await get("INSERT INTO ops_vendors (ref,name,country,currency,status,created,updated) VALUES ('V-2','Lagos Co','NG','NGN','approved',?,?) RETURNING id", T0, T0)).id), pn = await po('approved', ng);
    for (const id of [pd, pn]) { const r = await ask(id); const ap = await get('SELECT * FROM ops_approvals WHERE ref=?', r.approval); await AP.decide(sup, ap.id, 'approve', ''); assert.strictEqual((await get('SELECT status FROM ops_approvals WHERE id=?', ap.id)).status, 'failed'); }
  });
  await test('the draft linked to an unverified supplier is flagged, a verified one is not', async () => {
    const l = await get("SELECT shipment_id FROM ops_trade_links WHERE kind='purchase_order' AND ref_id=?", p1); assert.ok(!(await TO.check(l.shipment_id)).r.blockers.some((x) => x.code === 'vendor_unverified'));
    await run("UPDATE ops_vendors SET verification='{}'::jsonb WHERE id=?", vend); assert.ok((await TO.check(l.shipment_id)).r.blockers.some((x) => x.code === 'vendor_unverified'));
  });

  console.log('\nThe watch and the board');
  await test('a booked shipment with no transport document and a silent shipment are reported; the AI never moves them forward', async () => {
    await T.update(owner, a, { bill_no: 'TMP' }); await T.setStatus(owner, a, 'booked'); await T.update(owner, a, { bill_no: '' });
    await run('UPDATE trade_events SET created=? WHERE shipment_id=?', T0 - 10 * 86400, a); await run('UPDATE trade_shipments SET updated=? WHERE id=?', T0 - 10 * 86400, a);
    await TO.watch(async (x) => St.raiseException(x)); assert.strictEqual(await open('consignment_blocked', a), 1); assert.strictEqual(await open('consignment_stale', a), 1); assert.strictEqual((await T.load(a)).status, 'booked');
  });
  await test('the board lists open consignments with readiness and counts', async () => { const d = await TO.board({}); assert.ok(d.open >= 3); assert.ok(d.needs_compliance >= 0); assert.ok(d.consignments.every((x) => typeof x.next_step === 'string')); assert.strictEqual((await TO.board({ direction: 'export' })).open, 0); });
  await test('the AI never changes a consignment status or documents on its own', async () => { assert.strictEqual(Number((await get("SELECT COUNT(*) n FROM trade_events WHERE actor LIKE '%AI%' AND kind='status'")).n), 0); });

  await close();
  const a2 = new Client({ connectionString: ADMIN_URL }); await a2.connect(); await a2.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a2.end();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
