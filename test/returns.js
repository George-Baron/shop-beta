'use strict';
// Emailed employee invitations. Run with: npm run test:staff-invite
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_ret_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
const OWNER = 'Str0ng-Owner-Pass!';
// Starts a server; mail=true gives it an email key (the send goes nowhere, the message is still stored in the outbox).
const http = require('http');
// A pretend Paystack: records refund requests; set fake.fail to make it refuse.
const fake = { calls: [], fail: false, stripe: [], stripeFail: false };
const fakeSrv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { if (req.url === '/refund') { const j = JSON.parse(b || '{}'); fake.calls.push({ ...j, auth: req.headers.authorization }); res.setHeader('Content-Type', 'application/json'); if (fake.fail) { res.statusCode = 400; return res.end(JSON.stringify({ status: false, message: 'Transaction has already been fully reversed' })); } return res.end(JSON.stringify({ status: true, message: 'queued', data: { id: 9000 + fake.calls.length, status: 'pending', transaction: j.transaction } })); } if (req.url === '/v1/refunds') { const f = new URLSearchParams(b); fake.stripe.push({ pi: f.get('payment_intent'), amount: Number(f.get('amount')), idem: req.headers['idempotency-key'], auth: req.headers.authorization }); res.setHeader('Content-Type', 'application/json'); if (fake.stripeFail) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'Charge ch_1 has already been refunded.' } })); } return res.end(JSON.stringify({ id: 're_' + fake.stripe.length, status: 'succeeded' })); }
    res.statusCode = 404; res.end('{}'); }); });
const start = async (port, mail, fakePort) => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), BASE_URL: 'http://127.0.0.1:' + port, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-ret-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: OWNER, RATE_LIMIT_MULTIPLIER: '50', RESEND_API_KEY: 're_test', RESEND_API_URL: 'http://127.0.0.1:9', WORKER_ENABLED: '0', PAYSTACK_SECRET_KEY: 'sk_test_fake', PAYSTACK_API_URL: 'http://127.0.0.1:' + fakePort, STRIPE_ENABLED: '1', STRIPE_SECRET_KEY: 'sk_test_stripe', STRIPE_API_URL: 'http://127.0.0.1:' + fakePort } });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); } }
  const call = async (method, url, body, cookie) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; return { s: r.status, j, t, c: (sc[0] || '').split(';')[0] }; };
  return { srv, call };
};
(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  const port = 7200 + Math.floor(Math.random() * 700), fport = 7900 + Math.floor(Math.random() * 90);
  await new Promise((r) => fakeSrv.listen(fport, '127.0.0.1', r));
  const { srv, call } = await start(port, true, fport);
  const owner = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: OWNER })).c;
  const A = (m, u, b, c) => call(m, '/api/admin' + u, b, c === undefined ? owner : c);
  assert.strictEqual((await A('PUT', '/settings', { settings: { return_auto_refund: '0' } })).s, 200);   // the older tests below check manual settlement; automatic sending is tested in its own section
  const PW = 'Blue-Harbour-Lamp-2026-x', T = () => Math.floor(Date.now() / 1000);
  const reg = async (name, email) => { assert.strictEqual((await call('POST', '/api/auth/register', { name, email, phone: '0803' + String(Math.random()).slice(2, 9), password: PW })).s, 200); return { id: Number((await q('SELECT id FROM users WHERE email=$1', [email]))[0].id), c: (await call('POST', '/api/auth/login', { email, password: PW })).c, email, name }; };
  const ada = await reg('Ada Buyer', 'ada@buyer.com'), bob = await reg('Bob Other', 'bob@buyer.com');
  const prod = async (slug, name, price, stock) => Number((await q("INSERT INTO products (slug,store,name,price,stock,sku,listing,active,created,images) VALUES ($1,'supermarket',$2,$3,$4,$1,'approved',1,1,'[]') RETURNING id", [slug, name, price, stock]))[0].id);
  const kettle = await prod('kettle', 'Kettle', 6000, 10), mug = await prod('mug', 'Mug', 1000, 10), fan = await prod('fan', 'Fan', 4000, 10);
  let n = 0;
  // an order that is already paid and delivered. lines: [[productId, name, price, qty]]
  const order = async (o = {}) => {
    const lines = o.lines || [[kettle, 'Kettle', 6000, 1], [mug, 'Mug', 1000, 2]], sub = lines.reduce((a, l) => a + l[2] * l[3], 0), fee = o.fee === undefined ? 1500 : o.fee, total = o.total || sub + fee - (o.discount || 0), ref = o.ref || 'RT' + (++n) + tag.toUpperCase().slice(-3);
    const id = Number((await q(`INSERT INTO orders (ref,user_id,status,payment_method,payment_status,paystack_ref,name,email,phone,state,delivery_fee,subtotal,discount,total,created,access_token,delivered_at,wallet_amount) VALUES ($1,$2,$3,$4,$5,$6,'Ada Buyer',$7,'08031234567','Lagos',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [ref, o.user === undefined ? ada.id : o.user, o.status || 'delivered', o.pm || 'paystack', o.ps || 'paid', o.pref === undefined ? 'PSREF-' + ref : o.pref, o.email || 'ada@buyer.com', fee, sub, o.discount || 0, total, T() - 86400 * 3, 'tok' + ref + 'x'.repeat(20), o.deliveredAt === undefined ? T() - 86400 : o.deliveredAt, o.wallet || 0]))[0].id);
    for (const l of lines) await q("INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES ($1,$2,$3,$4,$5)", [id, l[0], l[1], l[2], l[3]]);
    return { id, ref, token: 'tok' + ref + 'x'.repeat(20), total, sub, items: (await q('SELECT id, product_id, name, price, qty FROM order_items WHERE order_id=$1 ORDER BY id', [id])).map((r) => ({ ...r, id: Number(r.id) })) };
  };
  const view = async (o, c = ada.c) => (await call('POST', '/api/orders/lookup', { ref: o.ref }, c)).j.order;
  const ask = (o, b, c = ada.c) => call('POST', `/api/orders/${o.ref}/return`, { reason: 'faulty', condition: 'damaged', packaging: 'original', details: 'The element does not heat up at all.', items: [{ item_id: o.items[0].id, qty: 1 }], ...b }, c);
  const stock = async (id) => Number((await q('SELECT stock FROM products WHERE id=$1', [id]))[0].stock);
  const wallet = async (uid) => (await q("SELECT COALESCE(SUM(amount),0)::bigint n FROM wallet_txns WHERE user_id=$1 AND type='refund'", [uid]))[0].n;
  const ret = async (id) => (await q('SELECT * FROM order_returns WHERE id=$1', [id]))[0];
  const emp = async (name, email, role) => { const roles = (await A('GET', '/staff')).j.roles; const r = await A('POST', '/staff', { name, email, role_id: roles.find((x) => x.name === role).id, password: 'Orange-Table-Lamp-2026-' + name.length }); assert.strictEqual(r.s, 200, r.t); return (await call('POST', '/api/auth/login', { email, password: 'Orange-Table-Lamp-2026-' + name.length })).c; };

  console.log('\nCustomer asks for a return');
  await test('a delivered, paid order shows the return button and what can be returned; before delivery it does not', async () => {
    const d = await order(), v = await view(d); assert.strictEqual(v.return_info.can, true); assert.strictEqual(v.return_info.lines.length, 2); assert.ok(v.return_info.deadline > T());
    const sh = await order({ status: 'shipped', deliveredAt: null }); assert.ok(!(await view(sh)).return_info, 'nothing to show before delivery');
  });
  await test('the questions are checked: reason, condition, packaging, a short description, and real items', async () => {
    const d = await order(); const bad = async (b, re) => { const r = await ask(d, b); assert.strictEqual(r.s, 400, r.t); assert.ok(re.test(r.t), r.t); };
    await bad({ reason: '' }, /why/i); await bad({ condition: 'x' }, /condition/i); await bad({ packaging: '' }, /packaging/i); await bad({ details: 'broken' }, /describe/i);
    await bad({ items: [] }, /at least one/i); await bad({ items: [{ item_id: 999999, qty: 1 }] }, /at least one/i); await bad({ items: [{ item_id: d.items[1].id, qty: 3 }] }, /at most 2/i);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM order_returns WHERE order_id=$1', [d.id]))[0].n, 0);
  });
  await test('only the buyer can ask; a stranger with just the order number and an email cannot; the private link works', async () => {
    const d = await order(); assert.strictEqual((await ask(d, {}, bob.c)).s, 404, 'another customer');
    assert.strictEqual((await call('POST', `/api/orders/${d.ref}/return`, { email: 'ada@buyer.com', reason: 'faulty', condition: 'damaged', packaging: 'no', details: 'long enough text here', items: [{ item_id: d.items[0].id, qty: 1 }] })).s, 403, 'email alone only shows a masked order');
    const g = await call('POST', `/api/orders/${d.ref}/return`, { token: d.token, reason: 'changed_mind', condition: 'unopened', packaging: 'original', items: [{ item_id: d.items[0].id, qty: 1 }] }); assert.strictEqual(g.s, 200, g.t);
  });
  await test('the window closes after the shop\'s return days, unpaid orders and orders not yet delivered cannot be returned', async () => {
    const old = await order({ deliveredAt: T() - 86400 * 9 }); const r = await ask(old, {}); assert.strictEqual(r.s, 400); assert.ok(/7-day return window.*closed/.test(r.t), r.t);
    assert.ok(/not paid/.test((await ask(await order({ ps: 'unpaid' }), {})).t));
    assert.strictEqual((await ask(await order({ status: 'shipped', deliveredAt: null }), {})).s, 400);
  });
  let d1, r1;
  await test('a good request is saved, shown on the order, and pops up for staff on the dashboard and in notifications', async () => {
    d1 = await order(); const r = await ask(d1, {}); assert.strictEqual(r.s, 200, r.t); r1 = r.j; assert.ok(/^RET-[0-9A-F]{8}$/.test(r1.ref));
    const v = await view(d1); assert.strictEqual(v.returns[0].status, 'requested'); assert.strictEqual(v.returns[0].requested_amount, 6000); assert.strictEqual(v.return_info.can, false); assert.ok(/already have a return open/.test(v.return_info.reason));
    assert.ok(v.events.some((e) => e.status === 'return' && e.note.includes(r1.ref)));
    const dash = (await A('GET', '/dashboard')).j; assert.ok(dash.returns.requested >= 1 && dash.returns.recent.some((x) => x.order_ref === d1.ref));
    assert.ok((await q("SELECT 1 FROM notifications WHERE type='return' AND title LIKE $1", ['%' + d1.ref + '%'])).length >= 1, 'staff notification');
    assert.ok((await q("SELECT 1 FROM outbox WHERE to_email='ada@buyer.com' AND subject LIKE $1", ['%' + r1.ref + '%'])).length >= 1, 'customer receipt email');
  });
  await test('only one return can be open per order; it can be cancelled by its owner only, then asked again', async () => {
    assert.strictEqual((await ask(d1, {})).s, 400);
    assert.strictEqual((await call('POST', `/api/orders/${d1.ref}/return/${r1.id}/cancel`, {}, bob.c)).s, 404);
    assert.strictEqual((await call('POST', `/api/orders/${d1.ref}/return/${r1.id}/cancel`, {}, ada.c)).s, 200); assert.strictEqual((await ret(r1.id)).status, 'cancelled');
    const again = await ask(d1, {}); assert.strictEqual(again.s, 200, again.t); r1 = again.j;
  });

  console.log('\nStaff review');
  await test('the returns queue lists it with the customer\'s answers; shoppers and unrelated staff cannot see it', async () => {
    const l = (await A('GET', '/returns')).j; const row = l.returns.find((x) => x.id === r1.id); assert.ok(row && row.status === 'requested' && row.order_ref === d1.ref && l.counts.requested >= 1);
    const det = (await A('GET', '/returns/' + r1.id)).j; assert.strictEqual(det.return.condition, 'Damaged'); assert.strictEqual(det.max_refund, d1.total); assert.ok(/does not heat/.test(det.return.details));
    for (const c of [ada.c, '']) assert.ok([401, 403].includes((await A('GET', '/returns', undefined, c)).s));
    const sup = await emp('Pat Packer', 'pat@example.com', 'Warehouse Staff').catch(() => null);
    const rep = await emp('Rex Rep', 'rex@example.com', 'Finance Officer'); assert.strictEqual((await A('GET', '/returns', undefined, rep)).s, 200, 'finance can look'); assert.strictEqual((await A('POST', `/returns/${r1.id}/approve`, {}, rep)).s, 403, 'but only Orders: Edit can approve');
    const nobody = await emp('Ivy Inventory', 'ivy@example.com', 'Inventory Officer'); assert.strictEqual((await A('GET', '/returns', undefined, nobody)).s, 403);
  });
  await test('approving needs the right amount: not above what is left, and a note if staff change it; decline needs a reason', async () => {
    const bad = async (b, re, status = 400) => { const r = await A('POST', `/returns/${r1.id}/approve`, b); assert.strictEqual(r.s, status, r.t); assert.ok(re.test(r.t), r.t); };
    await bad({ amount: d1.total + 1 }, /at most|between/); await bad({ amount: 0 }, /between/); await bad({ amount: 5000 }, /note/i);
    assert.strictEqual((await A('POST', `/returns/${r1.id}/reject`, { note: 'no' })).s, 400);
    assert.strictEqual((await ret(r1.id)).status, 'requested', 'nothing changed by the failed attempts');
  });
  await test('approval moves it to "awaiting settlement", tells the customer by email and the app, and alerts finance', async () => {
    const r = await A('POST', `/returns/${r1.id}/approve`, { amount: 5000, note: 'Approved, less a small handling fee.' }); assert.strictEqual(r.s, 200, r.t);
    const x = await ret(r1.id); assert.strictEqual(x.status, 'awaiting_settlement'); assert.strictEqual(x.approved_amount, 5000);
    const v = await view(d1); assert.strictEqual(v.returns[0].status_text, 'Approved, refund awaiting settlement'); assert.strictEqual(v.returns[0].approved_amount, 5000); assert.ok(/handling fee/.test(v.returns[0].note));
    assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND type='return' AND title LIKE '%approved%'", [ada.id])).length >= 1);
    assert.ok((await q("SELECT 1 FROM outbox WHERE to_email='ada@buyer.com' AND subject LIKE '%approved%'")).length >= 1); assert.ok((await q("SELECT 1 FROM notifications WHERE type='return' AND title LIKE 'Refund awaiting settlement%'")).length >= 1);
    assert.strictEqual((await A('POST', `/returns/${r1.id}/approve`, { amount: 5000, note: 'again please ok' })).s, 409, 'cannot be decided twice');
    assert.strictEqual((await A('POST', `/returns/${r1.id}/reject`, { note: 'changed my mind now' })).s, 409);
  });
  await test('declining tells the customer why, and they can ask again for the same items', async () => {
    const d = await order(); const rq = (await ask(d, {})).j; assert.strictEqual((await A('POST', `/returns/${rq.id}/reject`, { note: 'The photos show wear that is not covered.' })).s, 200);
    const v = await view(d); assert.strictEqual(v.returns[0].status, 'rejected'); assert.ok(/wear/.test(v.returns[0].note)); assert.strictEqual(v.return_info.can, true);
  });

  let finC;
  console.log('\nSettlement: the refund goes back where it came from');
  await test('who can settle: Finance (or the owner), not a review-only role; and nothing is sent before approval', async () => {
    finC = await emp('Fiona Finance', 'fiona@example.com', 'Finance Officer'); const ord = await emp('Olu Orders', 'olu@example.com', 'Sales Representative');
    assert.strictEqual((await A('POST', `/returns/${r1.id}/settle`, { method: 'original' }, ord)).s, 403);
    const fresh = await order(), q2 = (await ask(fresh, {})).j; assert.strictEqual((await A('POST', `/returns/${q2.id}/settle`, { method: 'original' })).s, 409, 'approve first'); assert.strictEqual(fake.calls.length, 0);
  });
  await test('a Finance employee can settle a refund that was approved by someone else, and it records who did it', async () => {
    const d = await order({ ref: 'FINC1' + tag.toUpperCase().slice(-3) }), rq = (await ask(d, {})).j; await A('POST', `/returns/${rq.id}/approve`, {});
    assert.strictEqual((await A('POST', `/returns/${rq.id}/settle`, { method: 'original' }, finC)).s, 200); assert.strictEqual((await ret(rq.id)).settled_by_name, 'Fiona Finance');
  });
  await test('a card payment is refunded through Paystack for exactly the approved amount, the return is closed, stock goes back, and the customer is told', async () => {
    const before = await stock(kettle); fake.calls.length = 0;
    const r = await A('POST', `/returns/${r1.id}/settle`, { method: 'original', restock: true }); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual(fake.calls.length, 1); const c = fake.calls[0]; assert.strictEqual(c.transaction, 'PSREF-' + d1.ref); assert.strictEqual(c.amount, 500000); assert.strictEqual(c.currency, 'NGN'); assert.strictEqual(c.auth, 'Bearer sk_test_fake');
    const x = await ret(r1.id); assert.strictEqual(x.status, 'settled'); assert.strictEqual(Number(x.gateway_refunded), 500000); assert.strictEqual(Number(x.wallet_refunded), 0); assert.ok(x.gateway_ref.startsWith('900') && x.gateway_status === 'pending' && x.settled_by_name);
    assert.strictEqual(await stock(kettle) - before, 1, 'returned item is back on the shelf');
    const v = await view(d1); assert.strictEqual(v.returns[0].status, 'settled'); assert.ok(/₦5,000 back to the card or account you paid with/.test(v.returns[0].refunded_to)); assert.strictEqual(v.status, 'delivered', 'a part return leaves the order delivered');
    assert.ok((await q("SELECT 1 FROM outbox WHERE to_email='ada@buyer.com' AND subject LIKE '%refund for return%'")).length >= 1);
    assert.strictEqual((await A('POST', `/returns/${r1.id}/settle`, { method: 'original' })).s, 409, 'never twice'); assert.strictEqual(fake.calls.length, 1);
  });
  await test('an order paid partly from the wallet is split: the wallet share to the wallet, the rest to Paystack', async () => {
    const d = await order({ lines: [[fan, 'Fan', 4000, 2]], fee: 0, wallet: 200000, ref: 'SPLIT1' + tag.toUpperCase().slice(-3) });   // total 8000, wallet paid 2000
    const rq = (await ask(d, { items: [{ item_id: d.items[0].id, qty: 1 }] })).j; assert.strictEqual((await A('POST', `/returns/${rq.id}/approve`, {})).s, 200);   // 4000
    const det = (await A('GET', '/returns/' + rq.id)).j; assert.deepStrictEqual([det.plan.wallet, det.plan.card], [100000, 300000]);
    fake.calls.length = 0; const w0 = Number(await wallet(ada.id)); const r = await A('POST', `/returns/${rq.id}/settle`, { method: 'original' }); assert.strictEqual(r.s, 200, r.t);
    assert.strictEqual(Number(await wallet(ada.id)) - w0, 100000); assert.strictEqual(fake.calls[0].amount, 300000 * 1);
    const x = await ret(rq.id); assert.deepStrictEqual([Number(x.wallet_refunded), Number(x.gateway_refunded)], [100000, 300000]);
  });
  await test('if Paystack refuses, nothing is paid anywhere, the reason is shown, and it can be settled again later', async () => {
    const d = await order({ ref: 'FAIL1' + tag.toUpperCase().slice(-3) }), rq = (await ask(d, {})).j; await A('POST', `/returns/${rq.id}/approve`, {});
    fake.fail = true; const bad = await A('POST', `/returns/${rq.id}/settle`, { method: 'original' }); assert.strictEqual(bad.s, 502); assert.ok(/already been fully reversed|refused/.test(bad.t), bad.t);
    let x = await ret(rq.id); assert.strictEqual(x.status, 'awaiting_settlement'); assert.ok(/refused/.test(x.last_error)); assert.strictEqual(Number(x.wallet_refunded) + Number(x.gateway_refunded), 0);
    assert.ok((await A('GET', '/returns/' + rq.id)).j.return.last_error);
    fake.fail = false; assert.strictEqual((await A('POST', `/returns/${rq.id}/settle`, { method: 'original' })).s, 200); x = await ret(rq.id); assert.strictEqual(x.status, 'settled'); assert.strictEqual(x.last_error, '');
  });
  await test('a refund already accepted by Paystack is never sent twice, even if recording it was interrupted', async () => {
    const d = await order({ ref: 'RESUME' + tag.toUpperCase().slice(-2) }), rq = (await ask(d, {})).j; await A('POST', `/returns/${rq.id}/approve`, {});
    await q("UPDATE order_returns SET status='settling', settling_at=$2, gateway_ref='9999', gateway_status='pending' WHERE id=$1", [rq.id, T() - 1200]);   // a crash left it half done 20 minutes ago
    fake.calls.length = 0; assert.strictEqual((await A('POST', `/returns/${rq.id}/settle`, { method: 'original' })).s, 200); assert.strictEqual(fake.calls.length, 0, 'no second Paystack refund');
    assert.strictEqual((await ret(rq.id)).gateway_ref, '9999');
    const d2 = await order({ ref: 'BUSY1' + tag.toUpperCase().slice(-3) }), r2 = (await ask(d2, {})).j; await A('POST', `/returns/${r2.id}/approve`, {}); await q("UPDATE order_returns SET status='settling', settling_at=$2 WHERE id=$1", [r2.id, T() - 5]);
    assert.strictEqual((await A('POST', `/returns/${r2.id}/settle`, { method: 'original' })).s, 409, 'someone is settling it right now');
  });
  await test('cash-on-delivery orders cannot go back to a card: choose the wallet or pay by hand with a reference; guests have no wallet', async () => {
    const d = await order({ pm: 'pod', pref: '', ref: 'POD1' + tag.toUpperCase().slice(-3) }), rq = (await ask(d, {})).j; await A('POST', `/returns/${rq.id}/approve`, {});
    const no = await A('POST', `/returns/${rq.id}/settle`, { method: 'original' }); assert.strictEqual(no.s, 400); assert.ok(/cash on delivery/.test(no.t));
    assert.strictEqual((await A('POST', `/returns/${rq.id}/settle`, { method: 'manual' })).s, 400); fake.calls.length = 0;
    const w0 = Number(await wallet(ada.id)); assert.strictEqual((await A('POST', `/returns/${rq.id}/settle`, { method: 'wallet' })).s, 200); assert.strictEqual(Number(await wallet(ada.id)) - w0, 600000); assert.strictEqual(fake.calls.length, 0);
    const g = await order({ user: null, email: 'guest@x.com', ref: 'GST1' + tag.toUpperCase().slice(-3) }), gr = (await call('POST', `/api/orders/${g.ref}/return`, { token: g.token, reason: 'changed_mind', condition: 'unopened', packaging: 'no', items: [{ item_id: g.items[0].id, qty: 1 }] })).j; await A('POST', `/returns/${gr.id}/approve`, {});
    const gw = await A('POST', `/returns/${gr.id}/settle`, { method: 'wallet' }); assert.strictEqual(gw.s, 400); assert.ok(/guest order/.test(gw.t));
    assert.strictEqual((await A('POST', `/returns/${gr.id}/settle`, { method: 'manual', reference: 'GTB-TRF-20113' })).s, 200); const x = await ret(gr.id); assert.strictEqual(x.settle_reference, 'GTB-TRF-20113'); assert.strictEqual(Number(x.gateway_refunded), 600000);
  });
  await test('sending every item back and refunding the whole order marks the order refunded; a part return does not', async () => {
    const d = await order({ ref: 'FULL1' + tag.toUpperCase().slice(-3), lines: [[mug, 'Mug', 1000, 2]], fee: 500 }), b = stock;
    const rq = (await ask(d, { reason: 'wrong_item', items: [{ item_id: d.items[0].id, qty: 2 }] })).j; assert.strictEqual((await ret(rq.id)).requested_amount, 2500, 'wrong item: the delivery fee comes back too');
    await A('POST', `/returns/${rq.id}/approve`, {}); const before = await b(mug); assert.strictEqual((await A('POST', `/returns/${rq.id}/settle`, { method: 'original', restock: true })).s, 200);
    const o = (await q('SELECT status, payment_status FROM orders WHERE id=$1', [d.id]))[0]; assert.deepStrictEqual([o.status, o.payment_status], ['refunded', 'refunded']); assert.strictEqual(await b(mug) - before, 2);
    assert.ok(!(await view(d)).return_info.can, 'nothing left to return');
  });
  await test('discounts are shared fairly: a return is worth what the customer actually paid for those items', async () => {
    const d = await order({ ref: 'DISC1' + tag.toUpperCase().slice(-3), lines: [[kettle, 'Kettle', 6000, 1], [mug, 'Mug', 1000, 4]], fee: 0, discount: 1000 });   // subtotal 10000, paid 9000
    const rq = (await ask(d, { reason: 'changed_mind', condition: 'unopened', details: '', items: [{ item_id: d.items[0].id, qty: 1 }] })).j; assert.strictEqual((await ret(rq.id)).requested_amount, 5400);
  });
  console.log('\nOperations Manager opens a return for a customer');
  await test('the Operations Manager role exists and can open returns; roles without Orders: Edit cannot', async () => {
    const roles = (await A('GET', '/staff')).j.roles, om = roles.find((x) => x.name === 'Operations Manager'); assert.ok(om && om.builtin, 'role is built in');
    const ops = await emp('Opal Ops', 'opal@example.com', 'Operations Manager'), d = await order({ ref: 'OPS1' + tag.toUpperCase().slice(-3) });
    assert.strictEqual((await A('GET', '/returns/lookup?ref=' + d.ref, undefined, ops)).s, 200);
    const fin = await emp('Fin Only', 'finonly@example.com', 'Finance Officer'); assert.strictEqual((await A('POST', '/returns/open', { order_ref: d.ref }, fin)).s, 403);
    const body = { order_ref: d.ref, reason: 'faulty', condition: 'damaged', packaging: 'original', details: 'Customer phoned: it will not switch on.', note: 'Phone call Monday', items: [{ item_id: d.items[0].id, qty: 1 }] };
    const r = await A('POST', '/returns/open', body, ops); assert.strictEqual(r.s, 200, r.t);
    const x = await ret(r.j.id); assert.strictEqual(x.opened_by, 'staff'); assert.strictEqual(x.opened_by_name, 'Opal Ops'); assert.strictEqual(x.status, 'requested'); assert.strictEqual(x.requested_amount, 6000); assert.strictEqual(x.open_note, 'Phone call Monday');
    assert.ok((await q("SELECT 1 FROM outbox WHERE to_email='ada@buyer.com' AND subject LIKE $1", ['%' + r.j.ref + '%'])).length >= 1, 'the customer is emailed');
    assert.ok((await view(d)).returns[0].ref === r.j.ref, 'the customer sees it on the order page');
    assert.strictEqual((await A('POST', '/returns/open', body, ops)).s, 400, 'one open return per order');
    const det = (await A('GET', '/returns/' + r.j.id)).j.return; assert.strictEqual(det.opened_by, 'staff'); assert.strictEqual(det.opened_by_name, 'Opal Ops');
    assert.ok((await q("SELECT 1 FROM audit_log WHERE path='/api/admin/returns/open'")).length >= 1, 'in the activity log');
  });
  await test('staff may open one after the window, flagged late; the customer still cannot; unknown orders, unpaid and undelivered are refused', async () => {
    const old = await order({ ref: 'OLD1' + tag.toUpperCase().slice(-3), deliveredAt: T() - 86400 * 20 }), b = { order_ref: old.ref, reason: 'faulty', condition: 'damaged', packaging: 'no', details: 'Found a defect while using it.', items: [{ item_id: old.items[0].id, qty: 1 }] };
    assert.strictEqual((await ask(old, {})).s, 400, 'customer is blocked by the window');
    const l = (await A('GET', '/returns/lookup?ref=' + old.ref)).j; assert.strictEqual(l.can, true); assert.strictEqual(l.past_window, true);
    const r = await A('POST', '/returns/open', b); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(Number((await ret(r.j.id)).past_window), 1);
    assert.strictEqual((await A('POST', '/returns/open', { ...b, order_ref: 'NOPE-1' })).s, 404);
    const unpaid = await order({ ps: 'unpaid' }); assert.strictEqual((await A('POST', '/returns/open', { ...b, order_ref: unpaid.ref, items: [{ item_id: unpaid.items[0].id, qty: 1 }] })).s, 400);
    const sh = await order({ status: 'shipped', deliveredAt: null }); assert.strictEqual((await A('POST', '/returns/open', { ...b, order_ref: sh.ref, items: [{ item_id: sh.items[0].id, qty: 1 }] })).s, 400);
    assert.strictEqual((await A('POST', '/returns/open', b, ada.c)).s !== 200, true, 'a shopper cannot use the staff route');
  });
  console.log('\nOwner approval and automatic refund');
  const autoOn = async (v, max) => { const r = await A('PUT', '/settings', { settings: { return_auto_refund: v, return_auto_approve_max: String(max || 0) } }); assert.strictEqual(r.s, 200, r.t); };
  let ops2, recd;
  await test('a reviewer only recommends: the return waits for the owner, nothing is refunded, the customer sees no decision yet, the owner is told', async () => {
    await autoOn('1'); ops2 = await emp('Ola Ops', 'ola@example.com', 'Operations Manager'); fake.calls.length = 0;
    const d = await order({ ref: 'REC1' + tag.toUpperCase().slice(-3) }), rq = (await ask(d, {})).j;
    const r = await A('POST', `/returns/${rq.id}/approve`, { amount: 6000, note: 'Faulty, photos look right.' }, ops2); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.stage, 'recommended');
    const x = await ret(rq.id); assert.strictEqual(x.status, 'recommended'); assert.strictEqual(x.approved_amount, null); assert.strictEqual(x.recommended_amount, 6000); assert.strictEqual(x.recommended_by_name, 'Ola Ops'); assert.strictEqual(fake.calls.length, 0, 'no money moved');
    const v = await view(d); assert.strictEqual(v.returns[0].status_text, 'Waiting for review'); assert.strictEqual(v.returns[0].approved_amount, null, 'customer sees no amount yet'); assert.strictEqual(v.returns[0].can_cancel, false);
    assert.ok((await q("SELECT 1 FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.role='admin' AND n.title LIKE $1", ['%needs your approval%' + d.ref])).length >= 1, 'owner notified');
    assert.strictEqual((await A('POST', `/returns/${rq.id}/approve`, {}, ops2)).s, 409, 'cannot recommend twice');
    assert.strictEqual((await A('POST', `/returns/${rq.id}/reject`, { note: 'Not eligible' }, ops2)).s, 403, 'a reviewer cannot decline once it is with the owner');
    assert.strictEqual((await A('POST', `/returns/${rq.id}/settle`, { method: 'original' })).s, 409, 'even the owner cannot settle before approving');
    const det = (await A('GET', '/returns/' + rq.id, undefined, ops2)).j.return; assert.strictEqual(det.status, 'recommended'); assert.strictEqual(det.recommended_by, 'Ola Ops');
    d.rq = rq; recd = d;
  });
  await test('the owner approves: Paystack is asked for the right amount automatically, the return is settled, the customer is told, nobody has to settle it', async () => {
    const d = recd, rq = d.rq; fake.calls.length = 0;
    const r = await A('POST', `/returns/${rq.id}/approve`, {}); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.stage, 'approved'); assert.strictEqual(r.j.auto.ok, true);
    const x = await ret(rq.id); assert.strictEqual(x.status, 'settled'); assert.strictEqual(x.approved_amount, 6000, 'defaults to what the reviewer recommended'); assert.strictEqual(x.approval, 'owner'); assert.strictEqual(x.auto_settle, 'done'); assert.strictEqual(Number(x.gateway_refunded), 600000);
    assert.strictEqual(fake.calls.length, 1); assert.strictEqual(fake.calls[0].amount, 600000); assert.strictEqual(fake.calls[0].transaction, 'PSREF-' + d.ref);
    assert.ok((await q("SELECT 1 FROM outbox WHERE to_email='ada@buyer.com' AND subject LIKE $1", ['%' + x.ref + '%'])).length >= 2, 'approval and refund emails');
    assert.strictEqual((await A('POST', `/returns/${rq.id}/approve`, {})).s, 409, 'cannot approve twice, so never a second refund'); assert.strictEqual(fake.calls.length, 1);
  });
  await test('the owner can approve straight from "requested", change the amount with a note, and a refused Paystack refund leaves it approved and waiting, with finance alerted', async () => {
    const d = await order({ ref: 'OWN1' + tag.toUpperCase().slice(-3) }), rq = (await ask(d, {})).j; fake.calls.length = 0; fake.fail = true;
    assert.strictEqual((await A('POST', `/returns/${rq.id}/approve`, { amount: 5000 })).s, 400, 'a changed amount needs a note');
    const r = await A('POST', `/returns/${rq.id}/approve`, { amount: 5000, note: 'Small handling fee.' }); fake.fail = false; assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.auto.ok, false); assert.ok(/reversed/.test(r.j.auto.error));
    const x = await ret(rq.id); assert.strictEqual(x.status, 'awaiting_settlement'); assert.strictEqual(x.auto_settle, 'failed'); assert.strictEqual(x.approved_amount, 5000);
    assert.ok((await q("SELECT 1 FROM notifications WHERE title LIKE $1", ['Automatic refund did not go through%' + d.ref])).length >= 1);
    const again = await A('POST', `/returns/${rq.id}/settle`, { method: 'original' }); assert.strictEqual(again.s, 200, again.t); assert.strictEqual((await ret(rq.id)).status, 'settled');
  });
  await test('cash on delivery cannot be sent automatically: approved and left for Finance to settle by hand; switching automatic refunds off does the same for card orders', async () => {
    const cod = await order({ ref: 'COD2' + tag.toUpperCase().slice(-3), pm: 'pod', pref: '' }), rq = (await ask(cod, {})).j; fake.calls.length = 0;
    const r = await A('POST', `/returns/${rq.id}/approve`, {}); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.auto.manual, true);
    assert.strictEqual((await ret(rq.id)).status, 'awaiting_settlement'); assert.strictEqual((await ret(rq.id)).auto_settle, 'manual_needed'); assert.strictEqual(fake.calls.length, 0);
    await autoOn('0'); const card = await order({ ref: 'OFF2' + tag.toUpperCase().slice(-3) }), r2 = (await ask(card, {})).j;
    assert.strictEqual((await A('POST', `/returns/${r2.id}/approve`, {})).s, 200); assert.strictEqual((await ret(r2.id)).status, 'awaiting_settlement'); assert.strictEqual(fake.calls.length, 0, 'switched off');
    await autoOn('1');
  });
  await test('a Stripe payment is refunded through Stripe in its own currency, once, automatically after the owner approves', async () => {
    const d = await order({ ref: 'STR1' + tag.toUpperCase().slice(-3), pref: 'pi_test_123' }); await q("UPDATE orders SET gateway='stripe', currency='USD', charge_amount=9500, fx_rate=1 WHERE id=$1", [d.id]);   // total 9500 naira = 9500 cents here, so the maths is easy to read
    const rq = (await ask(d, {})).j; fake.stripe.length = 0;
    const r = await A('POST', `/returns/${rq.id}/approve`, {}); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.auto.ok, true, JSON.stringify(r.j));
    assert.strictEqual(fake.stripe.length, 1); const c = fake.stripe[0]; assert.strictEqual(c.pi, 'pi_test_123'); assert.strictEqual(c.auth, 'Bearer sk_test_stripe'); assert.strictEqual(c.idem, 'shopbeta-return-' + rq.id);
    const x = await ret(rq.id), expect = Math.round(9500 * (6000 * 100) / (9500 * 100)); assert.strictEqual(c.amount, expect, 'refund is the approved share of what was charged'); assert.strictEqual(x.status, 'settled'); assert.strictEqual(x.gateway_ref, 're_' + fake.stripe.length); assert.strictEqual(x.gateway_status, 'succeeded');
    assert.strictEqual(fake.calls.length, 0, 'Paystack was not called'); assert.strictEqual((await A('POST', `/returns/${rq.id}/settle`, { method: 'original' })).s, 409); assert.strictEqual(fake.stripe.length, 1);
  });
  await test('if Stripe refuses, nothing is recorded as paid, Finance is alerted and the refund can be tried again', async () => {
    const d = await order({ ref: 'STR2' + tag.toUpperCase().slice(-3), pref: 'pi_test_456' }); await q("UPDATE orders SET gateway='stripe', currency='USD', charge_amount=9500, fx_rate=1 WHERE id=$1", [d.id]);
    const rq = (await ask(d, {})).j; fake.stripeFail = true;
    const r = await A('POST', `/returns/${rq.id}/approve`, {}); fake.stripeFail = false; assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.auto.ok, false); assert.ok(/Stripe refused/.test(r.j.auto.error), r.j.auto.error);
    const x = await ret(rq.id); assert.strictEqual(x.status, 'awaiting_settlement'); assert.strictEqual(x.gateway_ref, ''); assert.strictEqual(x.auto_settle, 'failed');
    const again = await A('POST', `/returns/${rq.id}/settle`, { method: 'original' }); assert.strictEqual(again.s, 200, again.t); assert.strictEqual((await ret(rq.id)).status, 'settled');
  });
  await test('small-amount rule (off by default): at or under the limit a request is approved and refunded by itself; above it, it waits as normal', async () => {
    const off = await order({ ref: 'SM0' + tag.toUpperCase().slice(-3) }), r0 = (await ask(off, {})).j; assert.strictEqual((await ret(r0.id)).status, 'requested', 'off by default');
    await autoOn('1', 2000); fake.calls.length = 0;
    const small = await order({ ref: 'SM1' + tag.toUpperCase().slice(-3), lines: [[mug, 'Mug', 1000, 2]] }), rs = (await ask(small, { reason: 'faulty', items: [{ item_id: small.items[0].id, qty: 1 }] })).j;
    const x = await ret(rs.id); assert.strictEqual(x.status, 'settled'); assert.strictEqual(x.approval, 'auto'); assert.strictEqual(x.approved_amount, 1000); assert.strictEqual(fake.calls.length, 1); assert.strictEqual(x.decided_by_name, 'Auto-approval (small amount)');
    const big = await order({ ref: 'SM2' + tag.toUpperCase().slice(-3) }), rb = (await ask(big, {})).j; assert.strictEqual((await ret(rb.id)).status, 'requested', 'over the limit waits for people');
    await autoOn('1', 0);
  });
  console.log('\nReturns in each sales channel');
  const supplier = async (name, cc) => Number((await q("INSERT INTO suppliers (name,country,currency,created,updated) VALUES ($1,$2,$3,1,1) RETURNING id", [name, cc, cc === 'NG' ? 'NGN' : 'USD']))[0].id);
  const dsLine = async (d, i, sup, status = 'delivered') => Number((await q("INSERT INTO dropship_lines (order_item_id,order_id,product_id,supplier_id,status,qty,sell_price,sent_at,created,updated,delivered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,1,1) RETURNING id", [d.items[i].id, d.id, d.items[i].product_id, sup, status, d.items[i].qty, d.items[i].price]))[0].id);
  await test('an imported dropship item is flagged for the approver, opens a supplier return when the owner approves, is not restocked, and is marked refunded once the customer is paid', async () => {
    const sup = await supplier('Shenzhen Home Co', 'CN'), d = await order({ ref: 'DSI1' + tag.toUpperCase().slice(-3), lines: [[kettle, 'Kettle', 6000, 1]] }), line = await dsLine(d, 0, sup);
    const rq = (await ask(d, {})).j, det = (await A('GET', '/returns/' + rq.id)).j; const c = det.channels[0];
    assert.strictEqual(c.channel, 'imported'); assert.strictEqual(c.supplier, 'Shenzhen Home Co'); assert.ok(c.notes.some((n) => /duties/.test(n)) && c.notes.some((n) => /not put back on our shelf/.test(n)));
    const stockBefore = await stock(kettle); fake.calls.length = 0;
    const ops3 = await emp('Dee Ops', 'dee@example.com', 'Operations Manager'); await A('POST', `/returns/${rq.id}/approve`, {}, ops3);
    assert.strictEqual((await q('SELECT status FROM dropship_lines WHERE id=$1', [line]))[0].status, 'delivered', 'a mere recommendation changes nothing at the supplier');
    const r = await A('POST', `/returns/${rq.id}/approve`, {}); assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.auto.ok, true);
    const l = (await q('SELECT status, refund_reference FROM dropship_lines WHERE id=$1', [line]))[0]; assert.strictEqual(l.status, 'refunded', 'customer refunded, so the line is refunded');
    const sr = (await q('SELECT status, reason FROM dropship_returns WHERE line_id=$1', [line]))[0]; assert.ok(sr && sr.status === 'requested' && /Customer return/.test(sr.reason), 'supplier return opened');
    assert.strictEqual((await q('SELECT amount_ngn FROM dropship_refunds WHERE line_id=$1', [line]))[0].amount_ngn, 6000);
    assert.strictEqual(await stock(kettle), stockBefore, 'no own stock to put back');
    const ex = await q("SELECT 1 FROM dropship_lines l LEFT JOIN dropship_returns r ON r.line_id=l.id WHERE l.id=$1 AND r.id IS NOT NULL", [line]); assert.strictEqual(ex.length, 1);
  });
  await test('a part-quantity return of a dropship line does not touch the supplier line, and tells the team to claim by hand; a Nigerian supplier is "dropship", not "imported"', async () => {
    const sup = await supplier('Ikeja Wholesale Ltd', 'NG'), d = await order({ ref: 'DSP1' + tag.toUpperCase().slice(-3), lines: [[mug, 'Mug', 1000, 3]] }), line = await dsLine(d, 0, sup);
    const rq = (await ask(d, { items: [{ item_id: d.items[0].id, qty: 1 }] })).j, det = (await A('GET', '/returns/' + rq.id)).j;
    assert.strictEqual(det.channels[0].channel, 'dropship'); assert.ok(det.channels[0].notes.some((n) => /Only 1 of 3/.test(n)));
    await A('POST', `/returns/${rq.id}/approve`, {});
    assert.strictEqual((await q('SELECT status FROM dropship_lines WHERE id=$1', [line]))[0].status, 'delivered'); assert.strictEqual((await q('SELECT COUNT(*)::int n FROM dropship_returns WHERE line_id=$1', [line]))[0].n, 0);
    assert.ok((await q("SELECT 1 FROM dropship_events WHERE line_id=$1 AND note LIKE 'Customer return%'", [line])).length >= 1, 'noted on the line');
    assert.strictEqual((await ret(rq.id)).status, 'settled', 'the customer is still refunded');
  });
  await test('a partner store item shows what comes off the partner\'s balance, and plain own-stock items carry no notes', async () => {
    const vid = Number((await q("INSERT INTO vendors (slug,name,status,commission_pct,created) VALUES ('shop-ch','Shop Ch','approved',10,1) RETURNING id"))[0].id);
    const d = await order({ ref: 'PCH1' + tag.toUpperCase().slice(-3), lines: [[kettle, 'Kettle', 6000, 1], [fan, 'Fan', 4000, 1]] }); await q('UPDATE order_items SET vendor_id=$1, commission=600 WHERE id=$2', [vid, d.items[0].id]);
    const rq = (await ask(d, { items: [{ item_id: d.items[0].id, qty: 1 }, { item_id: d.items[1].id, qty: 1 }] })).j, ch = (await A('GET', '/returns/' + rq.id)).j.channels;
    assert.strictEqual(ch[0].channel, 'partner'); assert.ok(/5,400/.test(ch[0].notes[0]) && /Shop Ch/.test(ch[0].notes[0])); assert.strictEqual(ch[1].channel, 'own'); assert.strictEqual(ch[1].notes.length, 0);
  });
  console.log('\nSafety');
  await test('every step is in the activity log, and the page for customers never shows staff names or gateway details', async () => {
    assert.ok((await q("SELECT 1 FROM audit_log WHERE path LIKE '/api/admin/returns/%/approve'")).length >= 1); assert.ok((await q("SELECT 1 FROM audit_log WHERE path LIKE '/api/admin/returns/%/settle'")).length >= 1);
    assert.ok((await q("SELECT 1 FROM audit_log WHERE actor='staff' AND path LIKE '/api/admin/returns/%'")).length >= 1);
    const t = JSON.stringify(await view(d1)); assert.ok(!/PSREF|gateway_ref|gateway_status|wallet_refunded|decided_by|settled_by|settle_reference|Fiona|9000/.test(t), 'no internal details: ' + t.slice(0, 200));
  });
  srv.kill(); fakeSrv.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
