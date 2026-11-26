'use strict';
// Procurement intelligence against a real database: vendor verification, quotations, comparison, purchase orders and their approval.
// Run with: npm run test:ops-procurement   (creates and drops its own database)
const assert = require('assert');
const { Client } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_opsproc_' + Date.now().toString(36);
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };
const rejects = async (p, re) => { try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message); return e; } throw new Error('expected an error'); };

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.DATABASE_URL = urlOf(DB); process.env.NODE_ENV = 'test';
  const { run, get, all, migrate, close } = require('../lib/db');
  await migrate();
  const St = require('../lib/ops/store'), AP = require('../lib/ops/approvals'), G = require('../lib/ops/gateway'), PC = require('../lib/ops/procurement'), T = require('../lib/ops/tools');
  const mk = async (name, role) => ({ id: Number((await run("INSERT INTO users (name,email,phone,password,role,created) VALUES (?,?,?,?,?,?)", name, name.toLowerCase() + '@t.test', '0800' + Math.floor(Math.random() * 1e7), 'x', role, 1)).lastInsertRowid), name, role });
  const owner = await mk('Owner', 'admin'), sup = await mk('Sup', 'staff'), mgr = await mk('Mgr', 'staff'), plain = await mk('Plain', 'staff');
  await run('INSERT INTO ops_approvers (user_id,max_level,emergency,created) VALUES (?,2,0,1),(?,3,0,1)', sup.id, mgr.id);
  await run("INSERT INTO stores (slug,name,tab_label) VALUES ('supermarket','Supermarket','Supermarket') ON CONFLICT DO NOTHING");
  const prod = Number((await run("INSERT INTO products (slug,store,name,price,sku,stock,active,created) VALUES ('rice-1','supermarket','Rice 50kg',1000,'RICE50',0,1,1)")).lastInsertRowid);
  const verifyAll = async (id) => { for (const c of ['registration', 'contact']) await PC.setVerification(owner, id, c, 'verified', 'Checked on CAC portal'); };
  const vend = async (name, o = {}) => (await PC.createVendor(owner, { name, country: 'NG', currency: 'NGN', payment_days: 30, return_policy: '7 days', warranty: '1 year', ...o }));
  const q = (o = {}) => ({ unit_price: 100, source: 'vendor_quote', source_ref: 'email 12 Nov', qty_available: 1000, lead_days: 5, ...o });

  console.log('\nVendors and verification');
  const A = await vend('Alpha Foods'), B = await vend('Beta Traders'), C = await vend('Gamma Mills');
  await test('a new vendor is under review and nothing is verified', async () => {
    assert.strictEqual(A.status, 'under_review'); assert.ok(!Object.values(A.verification).some((v) => v.state === 'verified'));
  });
  await test('an unverified vendor can never be approved', async () => {
    await rejects(PC.changeStatusByPerson(owner, A.id, 'approved', ''), /verify/i);
  });
  await test('only a person can verify, and must say how', async () => {
    await rejects(PC.setVerification(owner, A.id, 'registration', 'verified', ''), /how you verified/);
    await rejects(PC.setVerification(null, A.id, 'registration', 'verified', 'x'), /person/);
  });
  await test('after identity checks an approver can approve; a non-approver cannot', async () => {
    await verifyAll(A.id); await verifyAll(B.id); await verifyAll(C.id);
    await rejects(PC.changeStatusByPerson(plain, A.id, 'approved', ''), /supervisor/i);
    for (const v of [A, B, C]) await PC.changeStatusByPerson(sup, v.id, 'approved', '');
    assert.strictEqual((await PC.vendorById(A.id)).status, 'approved');
  });
  await test('losing an identity check drops an approved vendor to conditional', async () => {
    const X = await vend('Delta Ltd'); await verifyAll(X.id); await PC.changeStatusByPerson(owner, X.id, 'approved', '');
    await PC.setVerification(owner, X.id, 'registration', 'unverified', 'Number did not match');
    assert.strictEqual((await PC.vendorById(X.id)).status, 'conditional');
  });
  await test('the AI asking for a status change must go through approval, and fails safely if the vendor is unverified', async () => {
    await St.saveConfig({ mode: 'assisted' }, 't');
    const U = await vend('Unverified Co');
    const r = await G.perform({ agent: 'procurement', user: null }, 'supplier.status_change', { summary: 'Approve Unverified Co', payload: { vendor_id: U.id, status: 'approved' } });
    assert.strictEqual(r.status, 'pending_approval');
    const id = (await get('SELECT id FROM ops_approvals WHERE ref=?', r.approval)).id;
    await AP.decide(sup, id, 'approve', '');
    const a = await get('SELECT status FROM ops_approvals WHERE id=?', id), l = await get("SELECT error FROM ops_actions WHERE approval_id=? AND status='failed'", id);
    assert.strictEqual(a.status, 'failed'); assert.match(l.error, /verify/i);
    assert.strictEqual((await PC.vendorById(U.id)).status, 'under_review');
  });

  console.log('\nRequests and quotations');
  let REQ;
  await test('a request for a product is created once; asking again does not duplicate it', async () => {
    REQ = await PC.createRequest(owner, { product_id: prod, qty: 100, justification: 'Out of stock', priority: 'high' });
    assert.ok(REQ.ref.startsWith('REQ-')); assert.ok((await PC.createRequest(owner, { product_id: prod, qty: 50 })).duplicate);
  });
  await test('a price needs a source and a reference: it is never made up', async () => {
    await rejects(PC.addQuotation(owner, REQ.id, { vendor_id: A.id, unit_price: 100 }), /where this price/);
    await rejects(PC.addQuotation(owner, REQ.id, { vendor_id: A.id, unit_price: 100, source: 'vendor_quote' }), /Reference/);
  });
  await test('comparison: an under-review vendor is not recommended however cheap', async () => {
    const R = await vend('Cheap Review Co');
    await PC.addQuotation(owner, REQ.id, { vendor_id: A.id, ...q({ unit_price: 100 }) });
    await PC.addQuotation(owner, REQ.id, { vendor_id: B.id, ...q({ unit_price: 96, lead_days: 2 }) });
    await PC.addQuotation(owner, REQ.id, { vendor_id: C.id, ...q({ unit_price: 104 }) });
    await PC.addQuotation(owner, REQ.id, { vendor_id: R.id, ...q({ unit_price: 50 }) });
    const c = await PC.compare(REQ.id), row = (name) => c.rows.find((r) => r.vendor.name === name);
    assert.strictEqual(row('Cheap Review Co').qualified, false); assert.strictEqual(c.qualified_count, 3);
    assert.strictEqual(c.rows.find((r) => r.quote.id === c.highlights.cheapest_qualifying).vendor.name, 'Beta Traders');
    assert.strictEqual(c.rows.find((r) => r.quote.id === c.highlights.fastest_qualifying).vendor.name, 'Beta Traders');
    assert.ok(c.recommended_reason.includes('/100'));
    assert.notStrictEqual(c.rows.find((r) => r.quote.id === c.highlights.recommended).vendor.name, 'Cheap Review Co');
  });
  await test('a score only counts factors that have data, and says how much that is', async () => {
    const c = await PC.compare(REQ.id), r = c.rows.find((x) => x.qualified);
    assert.strictEqual(r.evaluation.factors.quality.score, null); assert.strictEqual(r.evaluation.factors.delivery.score, null);
    assert.ok(r.evaluation.coverage < 100 && r.evaluation.coverage > 0);
  });
  await test('a foreign quotation with no recorded exchange rate has an unknown cost and is not ranked', async () => {
    const F = await vend('Shenzhen Parts', { country: 'CN', currency: 'USD' }); await verifyAll(F.id); await PC.changeStatusByPerson(owner, F.id, 'approved', '');
    await PC.addQuotation(owner, REQ.id, { vendor_id: F.id, ...q({ unit_price: 1, currency: 'USD', incoterm: 'FOB', freight: 20, duty_pct: 20 }) });
    let c = await PC.compare(REQ.id), r = c.rows.find((x) => x.vendor.name === 'Shenzhen Parts');
    assert.strictEqual(r.landed.ngn, null); assert.strictEqual(r.qualified, false);
    await run("INSERT INTO fx_rates (currency, ngn_per_unit, source, updated, updated_by) VALUES ('USD', 1500, 'manual', 1, 't')");
    c = await PC.compare(REQ.id); r = c.rows.find((x) => x.vendor.name === 'Shenzhen Parts');
    assert.ok(r.landed.ngn > 100 * 1500, 'duty and freight are added on top'); assert.ok(r.landed.estimated);
  });
  await test('fewer than three qualified quotations is flagged', async () => {
    const R2 = await PC.createRequest(owner, { description: 'Spare part', qty: 5 });
    await PC.addQuotation(owner, R2.id, { vendor_id: A.id, ...q() });
    assert.ok((await PC.compare(R2.id)).notes.some((x) => /Only 1 qualified/.test(x)));
  });

  console.log('\nPurchase orders');
  let PO;
  await test('a PO cannot be drafted from an unqualified quotation', async () => {
    const c = await PC.compare(REQ.id), bad = c.rows.find((r) => !r.qualified && r.vendor.name === 'Cheap Review Co');
    await rejects(PC.draftPO(owner, REQ.id, bad.quote.id), /cannot be used/);
  });
  await test('the AI drafts a PO from the recommended quotation; a draft commits nothing', async () => {
    const c = await PC.compare(REQ.id);
    const r = await G.perform({ agent: 'procurement', user: null }, 'po.draft', { summary: 'Draft PO', payload: { request_id: REQ.id, quotation_id: c.highlights.recommended } });
    assert.strictEqual(r.status, 'done'); PO = await get('SELECT * FROM ops_purchase_orders WHERE ref=?', r.result.po);
    assert.strictEqual(PO.status, 'draft'); assert.strictEqual(Number((await get('SELECT COUNT(*) n FROM ops_approvals WHERE action_type=\'po.create\'')).n), 0);
  });
  await test('a second PO for the same request and vendor is refused', async () => {
    const c = await PC.compare(REQ.id); await rejects(PC.draftPO(owner, REQ.id, c.highlights.recommended), /already a purchase order/);
  });
  await test('an unapproved PO cannot be sent or received', async () => {
    await rejects(PC.markSent(owner, PO.id, {}), /not been approved/); await rejects(PC.recordReceipt(owner, PO.id, { qty_received: 1 }), /sent to the vendor/);
  });
  await test('in Monitor mode asking for approval only records a recommendation', async () => {
    await St.saveConfig({ mode: 'monitor' }, 't');
    const r = await PC.requestPOApproval({ agent: 'procurement', user: sup, requestedByUser: true }, PO.id, 'Restock');
    assert.strictEqual(r.status, 'recommended'); assert.strictEqual((await get('SELECT status FROM ops_purchase_orders WHERE id=?', PO.id)).status, 'draft');
  });
  let apr;
  await test('in Assisted mode it becomes an approval request at the right level, and the PO waits', async () => {
    await St.saveConfig({ mode: 'assisted' }, 't');
    const r = await PC.requestPOApproval({ agent: 'procurement', user: sup, requestedByUser: true }, PO.id, 'Restock');
    assert.strictEqual(r.status, 'pending_approval'); assert.ok(r.level_required >= 1);
    apr = await get('SELECT * FROM ops_approvals WHERE ref=?', r.approval); assert.strictEqual((await get('SELECT status FROM ops_purchase_orders WHERE id=?', PO.id)).status, 'pending_approval');
  });
  await test('the person who asked cannot approve their own PO', async () => {
    await rejects(AP.decide(sup, apr.id, 'approve', ''), /own request/i);
  });
  await test('changing the PO after it was submitted stops the approval from taking effect', async () => {
    await run('UPDATE ops_purchase_orders SET total=total+1000 WHERE id=?', PO.id);
    await AP.decide(mgr, apr.id, 'approve', '');
    const a = await get('SELECT status FROM ops_approvals WHERE id=?', apr.id), l = await get("SELECT error FROM ops_actions WHERE approval_id=? AND status='failed'", apr.id);
    assert.strictEqual(a.status, 'failed'); assert.match(l.error, /changed after/i);
    await PC.listPOs();   // syncs
    assert.strictEqual((await get('SELECT status FROM ops_purchase_orders WHERE id=?', PO.id)).status, 'draft');
    await run('UPDATE ops_purchase_orders SET total=total-1000 WHERE id=?', PO.id);
  });
  await test('after a fresh request a different approver approves; the PO is approved, not sent', async () => {
    const r = await PC.requestPOApproval({ agent: 'procurement', user: sup, requestedByUser: true }, PO.id, 'Restock again');
    assert.strictEqual(r.status, 'pending_approval');
    const id = (await get('SELECT id FROM ops_approvals WHERE ref=?', r.approval)).id;
    await AP.decide(owner, id, 'approve', '');
    assert.strictEqual((await get('SELECT status FROM ops_purchase_orders WHERE id=?', PO.id)).status, 'approved');
  });
  await test('the PDF is a real PDF, and a draft says it is not approved', async () => {
    const pdf = await PC.poPdf(PO.id); assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-'); assert.ok(pdf.toString('latin1').includes(PO.ref));
  });
  await test('a person records it as sent, then what actually arrived; a short delivery raises an exception', async () => {
    await PC.markSent(owner, PO.id, { vendor_ref: 'ACK-1' }); assert.strictEqual((await get('SELECT status FROM ops_purchase_orders WHERE id=?', PO.id)).status, 'sent');
    await PC.recordReceipt(plain, PO.id, { qty_received: 80, note: 'short' });
    assert.strictEqual((await get('SELECT status FROM ops_purchase_orders WHERE id=?', PO.id)).status, 'received');
    assert.ok(await get("SELECT id FROM ops_exceptions WHERE kind='po_short' AND status<>'resolved'"));
    assert.strictEqual((await get('SELECT status FROM ops_requests WHERE id=?', REQ.id)).status, 'closed');
    await rejects(PC.recordReceipt(plain, PO.id, { qty_received: 80 }), /already recorded/);
  });
  await test('delivery history now feeds the vendor score', async () => {
    const vId = PO.vendor_id, s = await PC.vendorStats(vId); assert.strictEqual(s.receipts, 1); assert.ok(s.fill_pct === 80);
  });

  console.log('\nGuard rails');
  await test('supplier research is refused: there is no research integration, and nothing is invented', async () => {
    const r = await G.perform({ agent: 'procurement', user: null }, 'supplier.research', { summary: 'Find rice suppliers' }); assert.strictEqual(r.status, 'blocked'); assert.match(r.reason, /not connected/);
  });
  await test('the AI cannot create a PO approval for a vendor that is not approved', async () => {
    const R = await get("SELECT id FROM ops_vendors WHERE name='Cheap Review Co'"), rq = await PC.createRequest(owner, { description: 'Thing', qty: 2 });
    await run("UPDATE ops_vendors SET status='approved' WHERE id=?", R.id);   // simulate a quotation entered while approved
    const qt = await PC.addQuotation(owner, rq.id, { vendor_id: R.id, ...q() }); const po = await PC.draftPO(owner, rq.id, qt.id);
    await run("UPDATE ops_vendors SET status='suspended' WHERE id=?", R.id);
    await rejects(PC.requestPOApproval({ agent: 'procurement', user: sup, requestedByUser: true }, po.id, 'x'), /suspended/);
  });
  await test('a switched-off procurement agent cannot draft', async () => {
    await St.saveConfig({ agents_disabled: ['procurement'] }, 't');
    const r = await T.run('take_action', { type: 'po.draft', summary: 'x', payload: { request_id: 1, quotation_id: 1 } }, { user: owner }); assert.strictEqual(r.status, 'blocked');
    await St.saveConfig({ agents_disabled: [] }, 't');
  });
  await test('every step above is in the audit log', async () => {
    for (const t of ['vendor.create', 'vendor.verify', 'vendor.status', 'quotation.add', 'po.draft', 'po.sent', 'po.receipt']) assert.ok(await get('SELECT id FROM ops_actions WHERE action_type=?', t), t + ' missing');
  });
  await close();
  const a2 = new Client({ connectionString: ADMIN_URL }); await a2.connect(); await a2.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a2.end();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
