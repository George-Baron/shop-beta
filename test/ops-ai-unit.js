'use strict';
// The AI Operations Manager rules (lib/ops/policy.js): no database needed.   Run with: npm run test:ops-ai:unit
const assert = require('assert');
const P = require('../lib/ops/policy');
let passed = 0, failed = 0;
const test = (n, f) => { try { f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };
const cfg = (o = {}) => P.normalizeConfig(o);
const dec = (type, amount, o = {}) => P.decide({ type, amountNgn: amount, config: cfg(o.config), ...o });

console.log('\nLevels and thresholds');
test('the starting limits are 100k / 500k / 2M', () => {
  const t = P.DEFAULT_THRESHOLDS; assert.deepStrictEqual(t.procurement, [100000, 500000, 2000000]);
  assert.strictEqual(P.levelForAmount('procurement', 100000, cfg().thresholds), 1);
  assert.strictEqual(P.levelForAmount('procurement', 100001, cfg().thresholds), 2);
  assert.strictEqual(P.levelForAmount('procurement', 500001, cfg().thresholds), 3);
  assert.strictEqual(P.levelForAmount('procurement', 2000001, cfg().thresholds), 4);
});
test('a fresh install is in Monitor mode: nothing but recommendations', () => {
  assert.strictEqual(cfg().mode, 'monitor');
  assert.strictEqual(dec('reorder.execute', 50000).route, 'recommend');
});
test('unknown actions are blocked', () => assert.strictEqual(dec('delete.everything', 0).route, 'blocked'));
test('level 0 reads and drafts run in any mode', () => assert.strictEqual(dec('task.create', 0).route, 'execute'));

console.log('\nModes');
test('the global mode is a ceiling: a department cannot go above it', () => {
  const c = cfg({ mode: 'assisted', department_modes: { riders: 'controlled' } });
  assert.strictEqual(P.effectiveMode('riders', c), 'assisted');
});
test('a department can go lower than the global mode', () => {
  const c = cfg({ mode: 'controlled', department_modes: { riders: 'monitor' } });
  assert.strictEqual(P.effectiveMode('riders', c), 'monitor');
  assert.strictEqual(P.decide({ type: 'rider.assign', config: c }).route, 'recommend');
});
test('controlled mode lets a routine level-1 action run, and a switch can turn it off', () => {
  assert.strictEqual(P.decide({ type: 'rider.assign', config: cfg({ mode: 'controlled' }) }).route, 'execute');
  assert.strictEqual(P.decide({ type: 'rider.assign', config: cfg({ mode: 'controlled', l1_disabled: ['rider.assign'] }) }).route, 'approval');
});
test('the financial department can never go above Assisted', () => {
  assert.strictEqual(P.effectiveMode('financial', cfg({ mode: 'controlled' })), 'assisted');
});

console.log('\nMoney');
test('money actions above the limit always need a person, even in controlled mode', () => {
  const r = dec('reorder.execute', 300000, { config: { mode: 'controlled' } }); assert.strictEqual(r.route, 'approval'); assert.strictEqual(r.level, 2);
});
test('payments and bank transfers are human-executed and level 4, in every mode', () => {
  for (const t of ['supplier.payment', 'bank.transfer', 'banking.change']) { const r = dec(t, 10, { config: { mode: 'controlled' } }); assert.strictEqual(r.route, 'approval'); assert.strictEqual(r.level, 4); assert.ok(r.human_executes); }
});
test('splitting an order into small pieces cannot dodge a limit: amounts to one counterparty add up', () => {
  const one = dec('po.create', 80000), two = dec('po.create', 80000, { cumulativeNgn: 80000 });
  assert.strictEqual(one.level, 2); // po.create is a level 2 action already
  const r = dec('reorder.execute', 80000, { cumulativeNgn: 80000, config: { mode: 'controlled' } });
  assert.strictEqual(r.level, 2); assert.ok(r.split_suspected); assert.strictEqual(r.route, 'approval');
  assert.ok(two.effective_amount_ngn === 160000);
});
test('a level-1 autonomous daily budget stops runaway spending', () => {
  const r = dec('reorder.execute', 60000, { l1SpentNgn: 450000, config: { mode: 'controlled', l1_daily_budget_ngn: 500000 } }); assert.strictEqual(r.route, 'approval');
});
test('two people are needed from the configured level', () => {
  assert.strictEqual(dec('supplier.payment', 10).required_approvals, 2);
  assert.strictEqual(dec('po.create', 300000).required_approvals, 1);
});
test('an emergency is always seen at senior level', () => assert.ok(dec('procurement.emergency', 10, { emergency: true }).level >= 3));

console.log('\nApprovals');
const appr = (o = {}) => ({ status: 'pending', deadline: Math.floor(Date.now() / 1000) + 1000, requested_by_kind: 'ai', requested_by_user: null, level_required: 2, ...o });
test('the owner and a registered approver can decide; an ordinary employee cannot', () => {
  assert.ok(P.approverMayDecide({ approver: { id: 1, role: 'admin' }, approval: appr() }).ok);
  assert.ok(P.approverMayDecide({ approver: { id: 2, role: 'staff', max_level: 2 }, approval: appr() }).ok);
  assert.ok(!P.approverMayDecide({ approver: { id: 3, role: 'staff', max_level: 0 }, approval: appr() }).ok);
  assert.ok(!P.approverMayDecide({ approver: null, approval: appr() }).ok);
});
test('an approver needs a high enough level', () => assert.ok(!P.approverMayDecide({ approver: { id: 2, role: 'staff', max_level: 2 }, approval: appr({ level_required: 3 }) }).ok));
test('nobody approves their own request, or decides twice', () => {
  assert.ok(!P.approverMayDecide({ approver: { id: 5, role: 'admin' }, approval: appr({ requested_by_kind: 'user', requested_by_user: 5 }) }).ok);
  assert.ok(!P.approverMayDecide({ approver: { id: 5, role: 'admin' }, approval: appr(), decided: [5] }).ok);
});
test('an expired or finished request cannot be decided', () => {
  assert.ok(!P.approverMayDecide({ approver: { id: 1, role: 'admin' }, approval: appr({ deadline: 5 }) }).ok);
  assert.ok(!P.approverMayDecide({ approver: { id: 1, role: 'admin' }, approval: appr({ status: 'approved' }) }).ok);
});
test('the hash changes when any term changes', () => {
  const a = P.hashPayload({ type: 'po.create', amount: 100, supplier: 'x' });
  assert.strictEqual(a, P.hashPayload({ supplier: 'x', amount: 100, type: 'po.create' }));   // order of keys does not matter
  assert.notStrictEqual(a, P.hashPayload({ type: 'po.create', amount: 101, supplier: 'x' }));
});
test('separation of duties: the same person cannot create, approve, receive and pay', () => {
  assert.ok(P.sodConflict([{ step: 'request_create', actor: 'user:1' }], 'po_approve', 'user:1'));
  assert.ok(P.sodConflict([], 'po_approve', 'ai'), 'the AI may never approve a purchase order');
  assert.ok(!P.sodConflict([{ step: 'request_create', actor: 'user:1' }], 'po_approve', 'user:2'));
});
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
