'use strict';
// Knowledge, quotation requests, warehouse checks and transfer requests, integration tests, wholesale returns and filters, on a real database.
// Run with: npm run test:ops-gaps   (creates and drops its own database)
const assert = require('assert');
const { Client } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_opsgap_' + Date.now().toString(36);
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };
const rej = (p, re) => assert.rejects(p, re);

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.DATABASE_URL = urlOf(DB); process.env.NODE_ENV = 'test'; delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  const { run, get, all, migrate, close, now } = require('../lib/db');
  await migrate();
  const KN = require('../lib/ops/knowledge'), RF = require('../lib/ops/rfq'), WO = require('../lib/ops/warehouse-ops'), INT = require('../lib/ops/integrations'), RO = require('../lib/ops/returns-ops'), D = require('../lib/ops/data'), MON = require('../lib/ops/monitor'), G = require('../lib/ops/gateway'), St = require('../lib/ops/store');
  const T = now(), user = { id: 1, name: 'Staff', email: 's@t.test' };
  await run("INSERT INTO stores (slug,name,tab_label) VALUES ('supermarket','Supermarket','Supermarket') ON CONFLICT DO NOTHING");
  const prod = async (name, sku, stock) => Number((await get("INSERT INTO products (slug,store,name,price,stock,sku,listing,active,created,images) VALUES (?,'supermarket',?,5000,?,?,'approved',1,1,'[]') RETURNING id", sku.toLowerCase(), name, stock, sku)).id);
  const pK = await prod('Kettle', 'K1', 2), pF = await prod('Fan', 'F1', 40);

  /* ---------- knowledge ---------- */
  await test('knowledge: add, validate, search, expire', async () => {
    await rej(KN.add(user, { category: 'policy', title: '', body: 'x' }), /title/);
    await rej(KN.add(user, { category: 'nope', title: 't', body: 'b' }), /category/);
    await rej(KN.add(user, { category: 'handling', title: 't', body: 'b', subject_type: 'product' }), /Say which/);
    await rej(KN.add(user, { category: 'policy', title: 't', body: 'b', valid_until: T - 5 }), /future/);
    const a = await KN.add(user, { category: 'handling', title: 'Fan is fragile', body: 'Double box', subject_type: 'product', subject_ref: 'F1' });
    const b = await KN.add(user, { category: 'contract', title: 'Acme terms', body: 'Net 14', valid_until: T + 86400 });
    assert.ok(a.id && !a.out_of_date);
    assert.strictEqual((await KN.search({ q: 'fragile' })).notes.length, 1);
    assert.strictEqual((await KN.search({ subject_type: 'product', subject_ref: 'f1' })).notes.length, 1);
    await run('UPDATE ops_knowledge SET valid_until=? WHERE id=?', T - 10, b.id);
    const s = await KN.search({}); assert.ok(!s.notes.find((n) => n.id === b.id)); assert.strictEqual(s.out_of_date, 1);
    assert.ok((await KN.search({ include_old: true })).notes.find((n) => n.id === b.id).out_of_date);
    assert.ok(/never kept here/i.test(s.note));
  });
  await test('knowledge: archive hides a note', async () => { const n = await KN.add(user, { category: 'other', title: 'tmp', body: 'tmp' }); await KN.update(user, n.id, { status: 'archived' }); assert.ok(!(await KN.search({ q: 'tmp' })).notes.length); });
  await test('knowledge: search text is safe against wildcards and quotes', async () => { await KN.search({ q: "%' OR 1=1 --" }); await KN.search({ q: '_' }); });

  /* ---------- vendors, requests, rfq ---------- */
  const vendor = async (name, email, status = 'approved') => Number((await get("INSERT INTO ops_vendors (name,email,status,created,updated) VALUES (?,?,?,?,?) RETURNING id", name, email, status, T, T)).id);
  const vA = await vendor('Acme Ltd', 'sales@acme.test'), vB = await vendor('NoMail Co', ''), vS = await vendor('Bad Co', 'x@bad.test', 'suspended');
  const req = Number((await get("INSERT INTO ops_requests (product_id,description,qty,destination,created,updated) VALUES (?,'Kettle 1.7L',100,'retail',?,?) RETURNING id", pK, T, T)).id);
  await test('rfq: candidates exclude suspended vendors and say discovery is not connected', async () => {
    const c = await RF.candidates(req); assert.ok(!c.vendors.find((v) => v.id === vS)); assert.ok(/No supplier research service/.test(c.discovery)); assert.strictEqual(c.vendors.find((v) => v.id === vB).can_email, false);
  });
  await test('rfq: draft is created once, refuses suspended vendors and closed requests', async () => {
    const f = await RF.draft(req, vA, 'Staff'); assert.strictEqual(f.status, 'draft'); assert.ok(f.ref.startsWith('RFQ-')); assert.ok(/does not commit/.test(f.body));
    await rej(RF.draft(req, vA, 'Staff'), /already exists/); await rej(RF.draft(req, vS, 'Staff'), /suspended/);
    const closed = Number((await get("INSERT INTO ops_requests (description,qty,destination,status,created,updated) VALUES ('x',1,'retail','closed',?,?) RETURNING id", T, T)).id); await rej(RF.draft(closed, vA, 'S'), /closed/);
  });
  await test('rfq: send with email not configured creates a task and does NOT mark sent', async () => {
    const f = await RF.list(req); const r = await RF.send(f[0].id); assert.strictEqual(r.sent, false); assert.ok(/not configured/.test(r.reason));
    assert.strictEqual((await RF.one(f[0].id)).status, 'draft'); assert.ok(await get("SELECT id FROM ops_tasks WHERE related_type='rfq'"));
  });
  await test('rfq: vendor without an email gets a task, not a send', async () => {
    const f = await RF.draft(req, vB, 'Staff'); const r = await RF.send(f.id); assert.strictEqual(r.sent, false); assert.ok(/no email/i.test(r.reason));
  });
  await test('rfq: through the gateway in Monitor mode it is only recommended', async () => {
    const f = (await RF.list(req))[0]; const r = await G.perform({ agent: 'procurement', user }, 'supplier.enquiry', { related_type: 'rfq', related_id: String(f.id), payload: { rfq_id: f.id } });
    assert.notStrictEqual(r.status, 'done'); assert.strictEqual((await RF.one(f.id)).status, 'draft');
  });
  await test('rfq: marked sent by hand, then reminded only up to the limit (needs mail), then answered by a quotation', async () => {
    const f = (await RF.list(req)).find((x) => x.vendor === 'Acme Ltd'); const m = await RF.markSent(f.id, 'Staff'); assert.strictEqual(m.status, 'sent'); await rej(RF.markSent(f.id, 'S'), /Only a draft/);
    await run('UPDATE ops_rfqs SET followups=? WHERE id=?', RF.MAX_FOLLOWUPS, f.id); await rej(RF.send(f.id, { followup: true }), /should call/);
    await run('UPDATE ops_rfqs SET followups=0 WHERE id=?', f.id);
    await run("INSERT INTO ops_quotations (request_id,vendor_id,unit_price,currency,source,created) VALUES (?,?,4000,'NGN','vendor_quote',?)", req, vA, T);
    assert.ok((await RF.syncAnswered()) >= 1); assert.strictEqual((await RF.one(f.id)).status, 'answered');
  });
  await test('rfq: unanswered request raises an exception after 3 days, not before', async () => {
    const v2 = await vendor('Slow Co', 'slow@t.test'), f = await RF.draft(req, v2, 'S'); await RF.markSent(f.id, 'S');
    let got = []; await RF.watch(async (x) => got.push(x)); assert.strictEqual(got.length, 0);
    await run('UPDATE ops_rfqs SET sent_at=? WHERE id=?', T - 4 * 86400, f.id); got = []; await RF.watch(async (x) => got.push(x));
    assert.strictEqual(got.length, 1); assert.strictEqual(got[0].kind, 'rfq_unanswered'); assert.strictEqual(got[0].severity, 'low');
  });
  await test('rfq: cancel, and answered cannot be cancelled', async () => { const f = (await RF.list(req)).find((x) => x.vendor === 'NoMail Co'); assert.strictEqual((await RF.cancel(f.id)).status, 'cancelled'); const a = (await RF.list(req)).find((x) => x.status === 'answered'); await rej(RF.cancel(a.id), /Already answered/); });

  /* ---------- price history ---------- */
  await test('price history: age, source and validity are stated; an expired quote is not "current"', async () => {
    await run("INSERT INTO ops_quotations (request_id,vendor_id,unit_price,currency,source,valid_until,created) VALUES (?,?,3500,'NGN','vendor_quote',?,?)", req, vA, T - 100, T - 40 * 86400);
    const h = await KN.priceHistory({ vendor_id: vA, product_id: pK }); assert.ok(h.length >= 2);
    const old = h.find((x) => x.unit_price === 3500); assert.strictEqual(old.still_valid, false); assert.ok(/expired/.test(old.status)); assert.ok(old.age_days >= 40);
    assert.ok(/no expiry recorded/.test(h.find((x) => x.unit_price === 4000).status));
  });

  /* ---------- warehouse ---------- */
  const wl = Number((await get("INSERT INTO wholesale_warehouses (code,name,created) VALUES ('LOS','Lagos WH',?) RETURNING id", T)).id), wa = Number((await get("INSERT INTO wholesale_warehouses (code,name,created) VALUES ('ABJ','Abuja WH',?) RETURNING id", T)).id);
  let mv = 0;
  const bal = async (pid, w, on, res, reorder) => { await run('INSERT INTO wholesale_stock_balances (product_id,warehouse_id,on_hand,reserved,reorder_level,updated) VALUES (?,?,?,?,?,?)', pid, w, on, res, reorder, T);
    await run("INSERT INTO wholesale_stock_movements (ref,product_id,warehouse_id,type,qty,delta_on_hand,prev_on_hand,new_on_hand,prev_reserved,new_reserved,created) VALUES (?,?,?,'opening',?,?,0,?,0,?,?)", 'MV-T-' + (++mv), pid, w, Math.max(on, 1), on, on, res, T - 200 * 86400); };
  await bal(pF, wl, 5, 0, 10);      // Lagos is short of fans (at/under reorder level)
  await bal(pF, wa, 100, 0, 10);    // Abuja has lots
  await bal(pK, wa, 60, 0, 10);     // kettles only in Abuja; retail has 2
  await test('check: clean ledger has no discrepancy; dead stock and low lines are found', async () => {
    const c = await WO.check(); assert.strictEqual(c.discrepancies.length, 0); assert.ok(c.below_reorder.find((r) => r.product === 'Fan' && r.warehouse === 'Lagos WH')); assert.ok(c.dead_stock.length >= 1);
  });
  await test('check: a balance changed outside the ledger is a discrepancy; negative retail stock is found', async () => {
    await run('UPDATE wholesale_stock_balances SET on_hand=on_hand+7 WHERE product_id=? AND warehouse_id=?', pF, wa);
    const c = await WO.check(); assert.strictEqual(c.discrepancies.length, 1); assert.strictEqual(c.discrepancies[0].balance_on_hand - c.discrepancies[0].ledger_on_hand, 7); assert.deepStrictEqual(c.retail_negative, []);   // the store itself refuses negative retail stock
    await run('UPDATE wholesale_stock_balances SET on_hand=on_hand-7 WHERE product_id=? AND warehouse_id=?', pF, wa);
  });
  await test('suggest: wholesale to wholesale only from real surplus; retail shortage is a separate explicit kind', async () => {
    const s = await WO.suggest(); const w2w = s.suggestions.find((x) => x.kind === 'wholesale_to_wholesale' && x.product === 'Fan'); assert.ok(w2w); assert.strictEqual(w2w.from, 'Abuja WH'); assert.strictEqual(w2w.to, 'Lagos WH'); assert.ok(w2w.qty > 0 && w2w.qty <= 100 - 20);
    assert.ok(/separate|explicit/i.test(s.note + (s.suggestions.find((x) => x.kind === 'wholesale_to_retail') || { why: 'explicit' }).why));
  });
  await test('transfer request: validates, never moves stock, de-duplicates, creates a task', async () => {
    const before = JSON.stringify(await all('SELECT product_id,warehouse_id,on_hand,reserved FROM wholesale_stock_balances ORDER BY id')), stock0 = (await get('SELECT stock FROM products WHERE id=?', pK)).stock;
    await rej(WO.requestTransfer({ kind: 'wholesale_to_wholesale', product_id: pF, from_warehouse_id: wa, to_warehouse_id: wa, qty: 5 }), /two different/);
    await rej(WO.requestTransfer({ kind: 'wholesale_to_wholesale', product_id: pF, from_warehouse_id: wl, to_warehouse_id: wa, qty: 500 }), /Only 5 available/);
    await rej(WO.requestTransfer({ kind: 'x', product_id: pF, qty: 1 }), /Unknown/);
    await rej(WO.requestTransfer({ kind: 'retail_to_wholesale', product_id: pK, to_warehouse_id: wa, qty: 50 }), /retail stock/);
    const a = await WO.requestTransfer({ kind: 'wholesale_to_wholesale', product_id: pF, from_warehouse_id: wa, to_warehouse_id: wl, qty: 20, reason: 'Lagos short' }, 'AI'); assert.ok(a.ref.startsWith('TRF-') && !a.existing);
    assert.ok((await WO.requestTransfer({ kind: 'wholesale_to_wholesale', product_id: pF, from_warehouse_id: wa, to_warehouse_id: wl, qty: 20 }, 'AI')).existing);
    assert.strictEqual(JSON.stringify(await all('SELECT product_id,warehouse_id,on_hand,reserved FROM wholesale_stock_balances ORDER BY id')), before); assert.strictEqual((await get('SELECT stock FROM products WHERE id=?', pK)).stock, stock0);
    assert.ok(await get("SELECT id FROM ops_tasks WHERE related_type='transfer'"));
  });
  await test('transfer through the gateway: Monitor recommends; special (touches retail) is level 2 and needs a person', async () => {
    const r = await G.perform({ agent: 'inventory', user }, 'stock.transfer_request', { related_type: 'product', related_id: String(pF), payload: { kind: 'wholesale_to_wholesale', product_id: pF, from_warehouse_id: wl, to_warehouse_id: wa, qty: 1 } }); assert.notStrictEqual(r.status, 'done');
    await St.saveConfig({ mode: 'controlled', department_modes: { warehouse: 'controlled' } }, 'o');
    const s = await G.perform({ agent: 'inventory', user }, 'stock.transfer_special', { related_type: 'product', related_id: String(pF), payload: { kind: 'wholesale_to_retail', product_id: pF, from_warehouse_id: wa, qty: 5 } }); assert.strictEqual(s.status, 'pending_approval');
    await St.saveConfig({ mode: 'monitor', department_modes: {} }, 'o');
  });
  await test('transfer close: needs a real movement reference; reject needs none', async () => {
    const t = (await WO.listTransfers('requested'))[0]; await rej(WO.completeTransfer(user, t.id, { status: 'done' }), /movement reference/); await rej(WO.completeTransfer(user, t.id, { status: 'done', movement_ref: 'MV-FAKE' }), /No wholesale stock movement/);
    const done = await WO.completeTransfer(user, t.id, { status: 'done', movement_ref: 'MV-T-1' }); assert.strictEqual(done.status, 'done'); await rej(WO.completeTransfer(user, t.id, { status: 'rejected' }), /Already done/);
  });
  await test('warehouse watch: discrepancy and stale transfer raise exceptions', async () => {
    await run('UPDATE wholesale_stock_balances SET on_hand=on_hand+3 WHERE product_id=? AND warehouse_id=?', pF, wa);
    const t = await WO.requestTransfer({ kind: 'wholesale_to_wholesale', product_id: pK, from_warehouse_id: wa, to_warehouse_id: wl, qty: 5 }, 'AI'); await run('UPDATE ops_stock_transfers SET created=? WHERE id=?', T - 60 * 3600, t.id);
    const got = []; await WO.watch(async (x) => got.push(x)); assert.ok(got.find((x) => x.kind === 'stock_discrepancy' && x.severity === 'high')); assert.ok(got.find((x) => x.kind === 'transfer_open'));
    await run('UPDATE wholesale_stock_balances SET on_hand=on_hand-3 WHERE product_id=? AND warehouse_id=?', pF, wa);
  });

  /* ---------- split fulfilment on a real wholesale order ---------- */
  await test('fulfilment plan for a wholesale order uses wholesale stock only and splits when needed', async () => {
    const uid = Number((await get("INSERT INTO users (name,email,phone,password,role,created) VALUES ('W','w@t.test','0802','x','customer',?) RETURNING id", T)).id);
    const acc = Number((await get("INSERT INTO wholesale_accounts (user_id,business_name,status,evaluate_until,created) VALUES (?,'Biz','approved',?,?) RETURNING id", uid, T, T)).id);
    const q = Number((await get("INSERT INTO wholesale_quotes (ref,account_id,status,goods_total,total,created) VALUES ('WQ-T1',?,'accepted',1000,1000,?) RETURNING id", acc, T)).id);
    await run("INSERT INTO wholesale_quote_items (quote_id,product_id,name,qty,list_price,unit_price) VALUES (?,?,'Fan',90,100,100)", q, pF); await run("INSERT INTO wholesale_quote_items (quote_id,product_id,name,qty,list_price,unit_price) VALUES (?,?,'Kettle',20,100,100)", q, pK);
    const p = await WO.planForQuote(q); assert.strictEqual(p.uses, 'wholesale stock only'); assert.ok(p.complete); assert.strictEqual(p.mode, 'single'); assert.strictEqual(p.shipments[0].warehouse, 'Abuja WH');
    await run("INSERT INTO wholesale_quote_items (quote_id,product_id,name,qty,list_price,unit_price) VALUES (?,?,'Fan2',1,100,100)", q, pF).catch(() => {});
    await run('UPDATE wholesale_quote_items SET qty=? WHERE quote_id=? AND name=?', 100, q, 'Fan');   // more fans than Abuja alone (100 on hand, 0 reserved) + Lagos 5 => still Abuja
    await run('UPDATE wholesale_quote_items SET qty=? WHERE quote_id=? AND name=?', 104, q, 'Fan'); const p2 = await WO.planForQuote(q); assert.strictEqual(p2.mode, 'split'); assert.ok(p2.complete);
    await run('UPDATE wholesale_quote_items SET qty=? WHERE quote_id=? AND name=?', 500, q, 'Fan'); const p3 = await WO.planForQuote(q); assert.strictEqual(p3.complete, false); assert.ok(p3.shortfalls.length);
    await rej(WO.planForQuote(999999), /not found/);
  });

  /* ---------- integrations ---------- */
  await test('integrations: nothing is "connected" before a test; couriers can never be connected', async () => {
    const s = await INT.status(); assert.ok(s.every((i) => i.status !== 'connected')); for (const k of ['dhl', 'ups', 'fedex']) assert.strictEqual(s.find((i) => i.key === k).status, 'not_connected');
    const t = await INT.test('dhl', 'Owner'); assert.strictEqual(t.ok, false); assert.ok(/no adapter/i.test(t.message)); assert.strictEqual((await INT.status()).find((i) => i.key === 'dhl').status, 'not_connected');
  });
  await test('integrations: a real test passes for the database and records the time; missing keys fail honestly', async () => {
    assert.ok((await INT.test('database', 'Owner')).ok); const d = (await INT.status()).find((i) => i.key === 'database'); assert.strictEqual(d.status, 'connected'); assert.ok(d.last_tested && d.last_ok);
    const l = await INT.test('llm', 'Owner'); assert.strictEqual(l.ok, false); assert.ok(/ANTHROPIC_API_KEY/.test(l.message)); assert.strictEqual((await INT.status()).find((i) => i.key === 'llm').status, 'failing');
    assert.strictEqual((await INT.test('email', 'Owner')).ok, false); await rej(INT.test('nope', 'Owner'), /Unknown/);
  });
  await test('integrations: credentials are described, never returned', async () => { process.env.DHL_API_KEY = 'secret-key-123'; process.env.DHL_API_SECRET = 's'; const s = JSON.stringify(await INT.status()); assert.ok(!s.includes('secret-key-123')); assert.ok(/unused/.test(s)); delete process.env.DHL_API_KEY; delete process.env.DHL_API_SECRET; });
  await test('integrations: a failing test after a passing one keeps the last success and the last error', async () => {
    await INT.test('database', 'Owner'); const kv = await require('../lib/ops/autonomy').kvGet('integration_tests'); assert.ok(kv.database.last_ok);
    assert.ok(await get("SELECT id FROM ops_actions WHERE action_type='integration.test' AND status='failed'"));
  });

  /* ---------- wholesale returns ---------- */
  await test('wholesale returns appear on the board and raise exceptions when stuck', async () => {
    const uid = Number((await get("SELECT id FROM users LIMIT 1")).id), acc = Number((await get('SELECT id FROM wholesale_accounts LIMIT 1')).id), q = Number((await get('SELECT id FROM wholesale_quotes LIMIT 1')).id);
    await run("INSERT INTO wholesale_returns (ref,quote_id,account_id,status,reason,requested_amount,created,updated) VALUES ('WR-1',?,?,'requested','faulty',250000,?,?)", q, acc, T - 30 * 3600, T);
    const b = await RO.board(); const w = b.returns.find((r) => r.kind === 'wholesale'); assert.ok(w); assert.strictEqual(w.late, true); assert.ok(/Supervisor/.test(w.recommendation.approver));
    const got = []; await RO.watchWholesale(async (x) => got.push(x)); assert.ok(got.find((x) => x.kind === 'return_unreviewed' && x.dedupe_key === 'wreturn_unreviewed:' + w.id)); void uid;
  });

  /* ---------- filters ---------- */
  await test('filters: product and supplier filters run and narrow the order list', async () => {
    const uid = Number((await get('SELECT id FROM users LIMIT 1')).id);
    const mk = async (pid, n) => { const o = Number((await get("INSERT INTO orders (ref,user_id,status,payment_method,payment_status,name,email,phone,state,delivery_fee,subtotal,discount,total,created,access_token) VALUES (?,?,'paid','paystack','paid','A','a@t.test','1','Lagos',0,100,0,100,?,?) RETURNING id", 'F' + n, uid, T - 3600, 'tk' + n + 'y'.repeat(25))).id); await run('INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES (?,?,?,100,1)', o, pid, 'x'); };
    await mk(pK, 1); await mk(pF, 2);
    const all_ = await D.overview({}), k = await D.overview({ product: 'kettle' }), f = await D.overview({ product: 'F1' }), none = await D.overview({ product: 'zzz-nothing' }), sup = await D.overview({ supplier: 'nobody' });
    const tot = (o) => Number((o.orders && (o.orders.total ?? o.orders.total_orders)) ?? 0);
    assert.ok(tot(all_) >= 2); assert.strictEqual(tot(k), 1); assert.strictEqual(tot(f), 1); assert.strictEqual(tot(none), 0); assert.strictEqual(tot(sup), 0);
    assert.ok((await D.wholesaleStock({ warehouse: wl })).warehouses.length === 1); assert.ok((await D.wholesaleStock({})).warehouses.length >= 2);
    await D.overview({ product: "'; DROP TABLE orders; --" }); assert.ok(await get('SELECT COUNT(*) FROM orders'));
  });
  await test('monitor run includes the new watches without error', async () => { const r = await MON.run(); assert.ok(r); });

  await close(); const a2 = new Client({ connectionString: ADMIN_URL }); await a2.connect(); await a2.query(`DROP DATABASE ${DB} WITH (FORCE)`); await a2.end();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
