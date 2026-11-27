'use strict';
// Advanced intelligence against a real database: forecasts from real sales, supplier scorecards, profitability with named gaps, at-risk prediction,
// AI performance (verified vs estimated savings) and stored reports. Run with: npm run test:ops-intel   (creates and drops its own database)
const assert = require('assert');
const { Client } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_opsintel_' + Date.now().toString(36);
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.DATABASE_URL = urlOf(DB); process.env.NODE_ENV = 'test';
  const { run, get, all, migrate, close, now } = require('../lib/db');
  await migrate();
  const I = require('../lib/ops/intel'), R = require('../lib/ops/reports'), St = require('../lib/ops/store'), OR = require('../lib/ops/orders');
  const T = now(), DAY = 86400;
  await run("INSERT INTO stores (slug,name,tab_label) VALUES ('supermarket','Supermarket','Supermarket') ON CONFLICT DO NOTHING");
  const prod = async (name, stock, cost) => Number((await get("INSERT INTO products (slug,store,name,price,stock,cost_price,active,created) VALUES (?,?,?,?,?,?,1,?) RETURNING id", name.toLowerCase().replace(/ /g, '-'), 'supermarket', name, 1000, stock, cost, T)).id);
  const order = async (when, items, o = {}) => { const id = Number((await get("INSERT INTO orders (ref,payment_method,payment_status,status,name,email,phone,state,subtotal,total,created,delivery,delivery_fee,own_lines,country) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id", 'I' + Math.random().toString(36).slice(2, 8), 'card', 'paid', o.status || 'delivered', 'C', 'c@t.test', '0803', 'Lagos', 1000, 1000, when, 'home', o.fee || 0, 1, 'NG')).id);
    for (const [pid, qty, price] of items) await run('INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES (?,?,?,?,?)', id, pid, 'x', price || 1000, qty); return id; };

  console.log('\nForecast from real sales');
  const pFast = await prod('Fast Rice', 12, 600), pNew = await prod('New Item', 5, 400);
  for (let d = 1; d <= 80; d++) await order(T - d * DAY, [[pFast, 3]]);                     // 3 a day for 80 days
  for (let d = 1; d <= 5; d++) await order(T - d * DAY, [[pNew, 1]]);                        // only 5 days of history
  await test('a product with long history gets a forecast, a stock-out warning and a measured accuracy', async () => {
    const f = await I.demandForecast({}), x = f.products.find((p) => p.name === 'Fast Rice');
    assert.ok(x.daily_rate > 2.5 && x.daily_rate < 3.5); assert.strictEqual(x.will_stock_out_before_restock, true); assert.ok(x.days_of_stock < 6); assert.ok(f.accuracy && f.accuracy.products_tested >= 1); assert.ok(f.accuracy.mean_error_pct < 15);
  });
  await test('a product with 5 days of history gets no forecast and the reason is given', async () => { const x = (await I.demandForecast({})).products.find((p) => p.name === 'New Item'); assert.strictEqual(x.confidence, 'none'); assert.ok(/at least 14/.test(x.basis)); });
  await test('incoming purchase orders are counted against the warning', async () => {
    const v = Number((await get("INSERT INTO ops_vendors (ref,name,country,currency,status,created,updated) VALUES ('V-1','Rice Co','NG','NGN','approved',?,?) RETURNING id", T, T)).id);
    await run("INSERT INTO ops_purchase_orders (ref,vendor_id,lines,currency,total,status,destination,created_by_kind,created,updated) VALUES ('PO-1',?,?::jsonb,'NGN',1,'sent','retail','user',?,?)", v, JSON.stringify([{ product_id: pFast, description: 'Fast Rice', qty: 200, unit_price: 500 }]), T, T);
    const x = (await I.demandForecast({})).products.find((p) => p.name === 'Fast Rice'); assert.strictEqual(x.on_order, 200); assert.strictEqual(x.will_stock_out_before_restock, false);
  });

  console.log('\nProfitability uses recorded costs only');
  const noCost = await prod('No Cost Item', 10, 0);
  await order(T - 3600, [[pFast, 2, 1000]], { fee: 500 }); await order(T - 3600, [[noCost, 1, 1000]]); await order(T - 3600, [[pFast, 1, 500]]);
  await test('orders with every product cost known are counted; others are listed as unknown, not zero-cost', async () => {
    const p = await I.profitability({ from: T - 7200, to: T }); assert.strictEqual(p.orders_in_range, 3); assert.strictEqual(p.orders_with_known_cost, 2); assert.strictEqual(p.unknown_orders, 1);
    assert.strictEqual(p.totals.goods, 2500); assert.strictEqual(p.totals.gross_margin, 2500 - 600 * 3); assert.ok(/Catalogue cost is a standard cost/.test(p.basis));
  });
  await test('selling below the recorded cost is reported as a loss', async () => { const p = await I.profitability({ from: T - 7200, to: T }); assert.strictEqual(p.negative_margin.length, 1); assert.ok(p.negative_margin[0].gross_margin < 0); });
  await test('courier cost recorded on a shipment is used; rider delivery cost is stated as not recorded', async () => {
    const o = await order(T - 3000, [[pFast, 1, 2000]]); const prov = Number((await get("INSERT INTO ops_providers (code,name,status,created,updated) VALUES ('P1','Courier One','approved',?,?) RETURNING id", T, T)).id);
    await run("INSERT INTO ops_shipments (ref,order_id,provider_id,status,cost,currency,created,updated) VALUES ('SHP-X',?,?,'delivered',900,'NGN',?,?)", o, prov, T, T);
    const x = (await I.profitability({ from: T - 3100, to: T - 2900 })); const row = x.negative_margin.concat(x.excessive_delivery); assert.strictEqual(x.orders_in_range, 1); assert.strictEqual(x.orders_with_known_cost, 1);
    const p2 = await I.profitability({ from: T - 7200, to: T }); assert.ok(p2.excessive_delivery.length === 0 || p2.excessive_delivery.every((r) => r.delivery_cost_recorded));
  });

  console.log('\nSupplier scorecards');
  const ds = Number((await get("INSERT INTO suppliers (name,country,currency,status,created,updated) VALUES ('Drop One','NG','NGN','active',?,?) RETURNING id", T, T)).id);
  const dline = async (status, o = {}) => { const oid = await order(T - 5000, [[pFast, 1]]); const it = await get('SELECT id FROM order_items WHERE order_id=?', oid); await run('INSERT INTO dropship_lines (order_item_id,order_id,product_id,supplier_id,status,qty,sell_price,created,updated,sent_at,shipped_at,supplier_response_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', it.id, oid, pFast, ds, status, 1, 1000, T - 5000, T - 4000, T - 5000, o.shipped ? T - 5000 + 7200 : null, o.resp ? T - 5000 + 3600 : null); };
  for (let i = 0; i < 4; i++) await dline('delivered', { shipped: 1, resp: 1 }); await dline('cancelled');
  await test('a dropship supplier with enough finished lines is scored from recorded timings', async () => {
    const s = (await I.supplierScorecards({})).suppliers.find((x) => x.name === 'Drop One'); assert.strictEqual(s.finished, 5); assert.strictEqual(s.success_pct, 80); assert.strictEqual(s.response_hours, 1); assert.strictEqual(s.ship_hours, 2); assert.ok(/Underperforming/.test(s.verdict));
  });
  await test('a purchasing supplier with one receipt is not scored', async () => {
    const po = await get("SELECT id FROM ops_purchase_orders WHERE ref='PO-1'"); await run('INSERT INTO ops_po_receipts (po_id,qty_ordered,qty_received,received_at,on_time,received_by,created) VALUES (?,200,150,?,1,?,?)', po.id, T, 'x', T);
    const s = (await I.supplierScorecards({})).suppliers.find((x) => x.name === 'Rice Co'); assert.strictEqual(s.fill_rate_pct, 75); assert.ok(/Not enough history/.test(s.verdict));
  });
  await test('what is not recorded is listed, not guessed', async () => assert.ok((await I.supplierScorecards({})).not_tracked.includes('Invoice accuracy')));

  console.log('\nOpen orders likely to be late');
  await test('a stage with little history is not predicted; with enough history a slow order is flagged', async () => {
    assert.strictEqual((await I.atRisk()).count, 0);
    for (let i = 0; i < 12; i++) { const id = 900 + i; await run("INSERT INTO ops_order_watch (kind,ref_id,ref,channel,stage,owner,stage_since,first_seen,last_seen,closed_at,outcome) VALUES ('order',?,?, 'retail','awaiting_dispatch','dispatch',?,?,?,?, 'delivered')", id, 'H' + i, T - 99999, T - 99999, T, T);
      await run("INSERT INTO ops_order_stage_events (kind,ref_id,from_stage,to_stage,detected) VALUES ('order',?,'','awaiting_dispatch',?),('order',?,'awaiting_dispatch','in_delivery',?)", id, T - 50000, id, T - 50000 + 600 + i * 60); }
    await run("INSERT INTO ops_order_watch (kind,ref_id,ref,channel,stage,owner,stage_since,first_seen,last_seen) VALUES ('order',777,'SLOW1','retail','awaiting_dispatch','dispatch',?,?,?)", T - 4 * 3600, T - 4 * 3600, T);
    const r = await I.atRisk(); assert.ok(r.at_risk.some((x) => x.ref === 'SLOW1' && x.level === 'high')); assert.ok(/past orders/.test(r.at_risk[0].basis));
  });

  console.log('\nAI performance and savings');
  await test('verified and estimated savings are kept apart and per currency', async () => {
    const v = (await get("SELECT id FROM ops_vendors LIMIT 1")).id;
    for (const [ref, price, at] of [['PO-A', 600, T - 20 * DAY], ['PO-B', 500, T - 5 * DAY]]) { const id = Number((await get("INSERT INTO ops_purchase_orders (ref,vendor_id,lines,currency,total,status,destination,created_by_kind,created,updated) VALUES (?,?,?::jsonb,'NGN',1,'received','retail','user',?,?) RETURNING id", ref, v, JSON.stringify([{ product_id: pNew, description: 'x', qty: 100, unit_price: price }]), at, at)).id); await run('INSERT INTO ops_po_receipts (po_id,qty_ordered,qty_received,received_at,on_time,received_by,created) VALUES (?,100,100,?,1,?,?)', id, at, 'x', at); }
    const s = (await I.performance({ days: 30 })).savings; assert.strictEqual(s.verified.price_change_vs_last_paid_by_currency.NGN, 10000); assert.ok(/ESTIMATE/.test(s.estimated_opportunity.note)); assert.ok(/never added together/.test(s.verified.note));
  });
  await test('orders, exceptions, approvals and AI actions are summarised from the records', async () => {
    await OR.sweep(); await St.raiseException({ kind: 'x', severity: 'low', dedupe_key: 'k1', title: 't', detail: 'd', impact: 'i', recommended_action: 'a', department: 'retail', auto: true });
    await St.logAction({ agent: 'orders', actor_kind: 'ai_autonomous', action_type: 'rider.assign', description: 'a', status: 'done' }); await St.logAction({ agent: 'orders', actor_kind: 'ai_autonomous', action_type: 'rider.assign', description: 'b', status: 'failed', error: 'x' }); await St.logAction({ agent: 'orders', actor_kind: 'human', action_type: 'x', description: 'staff', status: 'done' });
    const p = await I.performance({ days: 30 }); assert.ok(p.orders.watched >= 1); assert.ok(p.exceptions.raised >= 1); assert.strictEqual(p.ai_actions.executed, 1, 'human actions are not counted as the AI'); assert.strictEqual(p.ai_actions.failed, 1); assert.strictEqual(p.ai_actions.execution_success_pct, 50); assert.ok(/executed vs failed/.test(p.ai_actions.note));
  });

  console.log('\nStored reports');
  await test('a report is built once per period, stored with a headline, and never rewritten', async () => {
    const a = await R.ensure('daily', T), b = await R.ensure('daily', T); assert.strictEqual(a.created, true); assert.strictEqual(b.created, false);
    const rep = await R.getOne(a.id); assert.ok(rep.headline.length >= 3); assert.ok(rep.data.profitability && rep.data.ai_performance && rep.data.exceptions); assert.strictEqual((await R.list('daily')).length, 1);
    const before = JSON.stringify(rep.data); await order(T - 1000, [[pFast, 5]]); await R.ensure('daily', T); assert.strictEqual(JSON.stringify((await R.getOne(a.id)).data), before);
  });
  await test('weekly and monthly reports are made too, and each generation is in the audit log', async () => { const r = await R.ensureAll(T); assert.strictEqual(r.length, 3); assert.ok(Number((await get("SELECT COUNT(*) n FROM ops_actions WHERE action_type='report.generate'")).n) >= 3); });
  await test('the headline is plain numbers from the data, not model text', async () => { const rep = await R.getOne((await R.list('weekly'))[0].id); assert.ok(rep.headline.every((h) => typeof h === 'string')); assert.strictEqual(rep.generated_by, St.AI_NAME || 'VELTO AI'); });

  await close();
  const a2 = new Client({ connectionString: ADMIN_URL }); await a2.connect(); await a2.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a2.end();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
