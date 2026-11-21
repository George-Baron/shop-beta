'use strict';
// Emailed employee invitations. Run with: npm run test:staff-invite
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_rsched_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
const OWNER = 'Str0ng-Owner-Pass!';
// Starts a server; mail=true gives it an email key (the send goes nowhere, the message is still stored in the outbox).
const start = async (port, mail) => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), BASE_URL: 'http://127.0.0.1:' + port, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-rsched-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: OWNER, RATE_LIMIT_MULTIPLIER: '50', RESEND_API_KEY: 're_test', RESEND_API_URL: 'http://127.0.0.1:9', WORKER_ENABLED: '0' } });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); } }
  const call = async (method, url, body, cookie) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; return { s: r.status, j, t, c: (sc[0] || '').split(';')[0] }; };
  return { srv, call };
};
(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  const port = 7100 + Math.floor(Math.random() * 800);
  const { srv, call } = await start(port, true);
  const owner = (await call('POST', '/api/auth/login', { email: 'owner@example.com', password: OWNER })).c;
  const A = (m, u, b, c) => call(m, '/api/admin' + u, b, c === undefined ? owner : c);
  const roles = (await A('GET', '/staff')).j.roles, rid = (n) => roles.find((r) => r.name === n).id;
  const mkEmp = async (name, email, role) => { const r = await A('POST', '/staff', { name, email, role_id: rid(role), password: 'Orange-Table-Lamp-2026-' + name.length }); assert.strictEqual(r.s, 200, r.t); const pw = 'Orange-Table-Lamp-2026-' + name.length; return { id: r.j.id, c: (await call('POST', '/api/auth/login', { email, password: pw })).c }; };
  const fin = await mkEmp('Fiona Finance', 'fiona@example.com', 'Finance Officer');
  const rep = await mkEmp('Rex Rep', 'rex@example.com', 'Sales Representative');
  const ownerId = (await A('GET', '/staff')).j.staff.length ? null : null;
  const ownerRow = (await q("SELECT id FROM users WHERE role='admin' LIMIT 1"))[0].id;
  const isPdf = (r) => r.s === 200 && r.t.startsWith('%PDF');
  const raw = async (url, cookie) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { headers: cookie ? { Cookie: cookie } : {} }); const b = Buffer.from(await r.arrayBuffer()); return { s: r.status, ct: r.headers.get('content-type'), cd: r.headers.get('content-disposition'), pdf: b.slice(0, 5).toString() === '%PDF-', n: b.length }; };

  console.log('\nPDF downloads');
  await test('commercial, warehouse and partner reports download as a real PDF; Excel and CSV still work', async () => {
    const p = await raw('/api/admin/commercial/reports/retail-sales/download?format=pdf', owner); assert.strictEqual(p.s, 200); assert.ok(p.pdf && /application\/pdf/.test(p.ct) && /\.pdf"/.test(p.cd) && p.n > 1000);
    assert.ok((await raw('/api/admin/commercial/reports/rfq-pipeline/download?format=xlsx', owner)).s === 200);
    const c = await raw('/api/admin/commercial/reports/retail-sales/download?format=csv', owner); assert.ok(/text\/csv/.test(c.ct));
    const w = (await A('GET', '/warehouse/reports')).j.reports[0]; const wp = await raw(`/api/admin/warehouse/reports/${w.name}/download?format=pdf`, owner); assert.ok(wp.s === 200 && wp.pdf, 'warehouse pdf ' + wp.s);
    assert.strictEqual((await raw('/api/admin/warehouse/reports/nope/download?format=pdf', owner)).s >= 400, true);
  });
  await test('PDF downloads obey the same permissions as the screen', async () => {
    assert.strictEqual((await raw('/api/admin/commercial/reports/retail-sales/download?format=pdf')).s, 401);
    assert.strictEqual((await raw('/api/admin/commercial/reports/retail-sales/download?format=pdf', rep.c)).s, 403, 'sales rep has no reports');
    assert.strictEqual((await raw('/api/admin/commercial/reports/employee-performance/download?format=pdf', fin.c)).s, 403, 'employee performance is owner/manager only');
    assert.ok((await raw('/api/admin/commercial/reports/retail-sales/download?format=pdf', fin.c)).pdf);
  });
  await test('a partner can download their own report as PDF', async () => {
    const ap = await call('POST', '/api/partners/apply', { name: 'Zed Stores', contactName: 'Owner Zed', email: 'zed@example.com', phone: '08031234567', address: '1 Market Rd', state: 'Lagos', city: 'Yaba', regNo: 'RCzed', about: 'x', password: 'Quartz-Meadow-2026!', departments: ['supermarket'] }); assert.strictEqual(ap.s, 200, ap.t);
    await q("UPDATE vendors SET status='approved'"); const pc = (await call('POST', '/api/auth/login', { email: 'zed@example.com', password: 'Quartz-Meadow-2026!' })).c;
    const r = await raw('/api/partner/reports/payouts/download?format=pdf', pc); assert.ok(r.s === 200 && r.pdf, 'partner pdf ' + r.s);
    assert.strictEqual((await raw('/api/partner/reports/payouts/download?format=pdf', owner)).s >= 400, true);
  });

  console.log('\nScheduled reports (setup rules)');
  let sid;
  await test('the owner can schedule a report to employees who may see it, and it is listed', async () => {
    const r = await A('POST', '/commercial/schedules', { source: 'commercial', report: 'retail-sales', frequency: 'weekly', recipients: [fin.id, ownerRow] }); assert.strictEqual(r.s, 200, r.t); sid = r.j.id;
    const l = (await A('GET', '/commercial/schedules')).j; assert.ok(l.schedules.some((x) => x.id === sid && x.recipients.length === 2 && x.active)); assert.ok(l.people.length >= 3 && l.reports.some((x) => x.source === 'warehouse'));
  });
  await test('bad schedules are refused with a clear reason', async () => {
    const bad = async (b, re) => { const r = await A('POST', '/commercial/schedules', { source: 'commercial', report: 'retail-sales', frequency: 'weekly', recipients: [fin.id], ...b }); assert.strictEqual(r.s, 400, r.t); assert.ok(re.test(r.t), r.t); };
    await bad({ report: 'nope' }, /list/); await bad({ frequency: 'hourly' }, /how often/); await bad({ recipients: [] }, /at least one/);
    await bad({ recipients: [rep.id] }, /does not have permission/); await bad({ recipients: [999999] }, /active employees/);
    const cust = await call('POST', '/api/auth/register', { name: 'Cust', email: 'cust@example.com', phone: '08030000001', password: 'Blue-Harbour-Lamp-2026-x' }); const cid = (await q("SELECT id FROM users WHERE email='cust@example.com'"))[0].id;
    await bad({ recipients: [Number(cid)] }, /active employees/);   // a shopper can never receive staff reports
    await bad({ report: 'employee-performance', recipients: [fin.id] }, /does not have permission/);
  });
  await test('only people with Reports: Edit (or the owner) can change schedules; Reports: View can only look', async () => {
    assert.strictEqual((await A('POST', '/commercial/schedules', { source: 'commercial', report: 'retail-sales', frequency: 'daily', recipients: [fin.id] }, fin.c)).s, 403);
    assert.strictEqual((await A('DELETE', '/commercial/schedules/' + sid, undefined, fin.c)).s, 403);
    assert.strictEqual((await A('GET', '/commercial/schedules', undefined, fin.c)).s, 200);
    for (const c of [rep.c, '']) assert.ok([401, 403].includes((await A('GET', '/commercial/schedules', undefined, c)).s));
  });

  console.log('\nScheduled reports (sending)');
  await test('"Send now" emails the headline figures and a link to each recipient only, with nothing attached and no rows', async () => {
    await q('INSERT INTO orders (ref,payment_method,payment_status,status,name,email,phone,state,subtotal,total,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', ['SCH1', 'card', 'paid', 'paid', 'Secret Shopper', 's@example.com', '08011111111', 'Lagos', 7000, 7000, Math.floor(Date.now() / 1000) - 86400 * 2]);
    const before = (await q("SELECT COUNT(*)::int n FROM outbox WHERE subject LIKE 'Weekly report%'"))[0].n;
    const r = await A('POST', `/commercial/schedules/${sid}/send`, {}); assert.strictEqual(r.s, 200, r.t); assert.ok(/Sent to 2/.test(r.j.note), r.j.note);
    const ms = await q("SELECT * FROM outbox WHERE subject LIKE 'Weekly report%' ORDER BY id"); assert.strictEqual(ms.length - before, 2);
    assert.deepStrictEqual(ms.map((m) => m.to_email).sort(), ['fiona@example.com', 'owner@example.com']);
    assert.ok(/Retail sales by day/.test(ms[0].subject + ms[0].body) && /Open the full report/.test(ms[0].body) && /NGN|Orders/.test(ms[0].body));
    assert.ok(!/Secret Shopper|s@example.com|08011111111/.test(ms[0].body), 'no customer details in the email');
  });
  await test('a recipient who loses permission or is switched off stops receiving it', async () => {
    await A('PUT', `/staff/${fin.id}`, { active: false });
    const n0 = (await q('SELECT COUNT(*)::int n FROM outbox'))[0].n; const r = await A('POST', `/commercial/schedules/${sid}/send`, {}); assert.ok(/Sent to 1 person/.test(r.j.note), r.j.note);
    assert.strictEqual((await q('SELECT COUNT(*)::int n FROM outbox'))[0].n - n0, 1);
    await A('PUT', `/staff/${fin.id}`, { active: true });
  });
  await test('the timetable sends once per slot: Monday 07:00 Lagos for weekly, and never twice', async () => {
    process.env.DATABASE_URL = urlOf(DB); process.env.RESEND_API_KEY = 're_test'; process.env.RESEND_API_URL = 'http://127.0.0.1:9'; process.env.BASE_URL = 'http://127.0.0.1:' + port; process.env.DATA_DIR = require('os').tmpdir() + '/sb-rsched-inproc-' + tag;
    const RS = require('../lib/report-schedule');
    const T = (y, m, d, h, mi = 0) => Date.UTC(y, m, d, h - 1, mi) / 1000;   // Lagos clock time -> UTC seconds
    assert.deepStrictEqual(RS.periodFor('daily', T(2026, 10, 18, 8)), { from: '2026-11-17', to: '2026-11-17' });
    assert.deepStrictEqual(RS.periodFor('weekly', T(2026, 10, 18, 8)), { from: '2026-11-09', to: '2026-11-15' });
    assert.deepStrictEqual(RS.periodFor('monthly', T(2026, 11, 1, 8)), { from: '2026-11-01', to: '2026-11-30' });
    assert.strictEqual(RS.slotNow('weekly', T(2026, 10, 18, 8)), null, 'Wednesday is not a weekly day'); assert.strictEqual(RS.slotNow('weekly', T(2026, 10, 16, 6, 59)), null, 'before 07:00'); assert.strictEqual(RS.slotNow('weekly', T(2026, 10, 16, 7)), '2026-11-16');
    assert.strictEqual(RS.slotNow('monthly', T(2026, 11, 1, 9)), '2026-12-01'); assert.strictEqual(RS.slotNow('monthly', T(2026, 11, 2, 9)), null);
    const realNow = Date.now; Date.now = () => T(2026, 10, 16, 8) * 1000;   // Monday 08:00 Lagos
    try {
      const n0 = (await q("SELECT COUNT(*)::int n FROM outbox WHERE subject LIKE 'Weekly%'"))[0].n;
      assert.strictEqual(await RS.runDue(), 1, 'weekly schedule fired'); assert.strictEqual((await q("SELECT COUNT(*)::int n FROM outbox WHERE subject LIKE 'Weekly%'"))[0].n - n0, 2);
      assert.strictEqual(await RS.runDue(), 0, 'not again in the same slot'); assert.strictEqual((await q("SELECT COUNT(*)::int n FROM outbox WHERE subject LIKE 'Weekly%'"))[0].n - n0, 2);
      await A('PUT', `/commercial/schedules/${sid}`, { active: false }); Date.now = () => T(2026, 10, 23, 8) * 1000;
      assert.strictEqual(await RS.runDue(), 0, 'a paused schedule stays quiet');
      await A('PUT', `/commercial/schedules/${sid}`, { active: true }); assert.strictEqual(await RS.runDue(), 1, 'next Monday it goes again');
    } finally { Date.now = realNow; }
    assert.ok((await A('GET', '/commercial/schedules')).j.schedules[0].last_note.startsWith('Sent to'));
  });
  await test('schedules can be changed and deleted', async () => {
    assert.strictEqual((await A('PUT', `/commercial/schedules/${sid}`, { frequency: 'monthly', recipients: [ownerRow] })).s, 200);
    const s = (await A('GET', '/commercial/schedules')).j.schedules.find((x) => x.id === sid); assert.strictEqual(s.frequency, 'monthly'); assert.strictEqual(s.recipients.length, 1);
    assert.strictEqual((await A('PUT', `/commercial/schedules/${sid}`, { recipients: [rep.id] })).s, 400);
    assert.strictEqual((await A('DELETE', `/commercial/schedules/${sid}`)).s, 200); assert.strictEqual((await A('GET', '/commercial/schedules')).j.schedules.length, 0); assert.strictEqual((await A('POST', `/commercial/schedules/${sid}/send`, {})).s, 404);
  });
  srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
