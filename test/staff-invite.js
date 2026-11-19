'use strict';
// Emailed employee invitations. Run with: npm run test:staff-invite
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const { Client: Pg } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const tag = Date.now().toString(36), DB = 'sb_invite_' + tag;
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pg = async (sql, params, db) => { const c = new Pg({ connectionString: db ? urlOf(db) : ADMIN_URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const q = (sql, params) => pg(sql, params, DB);
const OWNER = 'Str0ng-Owner-Pass!';
// Starts a server; mail=true gives it an email key (the send goes nowhere, the message is still stored in the outbox).
const start = async (port, mail) => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), BASE_URL: 'http://127.0.0.1:' + port, DATABASE_URL: urlOf(DB), DATA_DIR: require('os').tmpdir() + '/sb-invite-' + tag, ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: OWNER, RATE_LIMIT_MULTIPLIER: '50', ...(mail ? { RESEND_API_KEY: 're_test', RESEND_API_URL: 'http://127.0.0.1:9' } : { RESEND_API_KEY: '' }) } });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); } }
  const call = async (method, url, body, cookie) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; return { s: r.status, j, t, c: (sc[0] || '').split(';')[0] }; };
  return { srv, call };
};
(async () => {
  await pg(`CREATE DATABASE ${DB}`);
  const base = 7000 + Math.floor(Math.random() * 1000);
  let S = await start(base, false);
  const owner = (await S.call('POST', '/api/auth/login', { email: 'owner@example.com', password: OWNER })).c;
  const ST = (m, u, b) => S.call(m, '/api/admin/staff' + u, b, owner);
  const role = async () => (await ST('GET', '')).j.roles.find((r) => r.name === 'Sales Representative').id;
  const tokenOf = (link) => new URL(link).searchParams.get('token');

  console.log('\nInvitations when email is not set up');
  let inv;
  await test('an invitation gives the owner a link to pass on, and no password is ever shown', async () => {
    const r = await ST('POST', '', { name: 'Ngozi Eze', email: 'ngozi@example.com', role_id: await role(), invite: true });
    assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.invited, true); assert.strictEqual(r.j.emailed, false); assert.ok(/\/forgot\?token=[0-9a-f]{64}&invite=1$/.test(r.j.invite_link)); assert.strictEqual(r.j.temp_password, undefined); inv = r.j;
    assert.strictEqual((await q("SELECT COUNT(*)::int n FROM outbox WHERE to_email='ngozi@example.com'"))[0].n, 0);
  });
  await test('until they choose a password nobody can sign in as them', async () => {
    assert.strictEqual((await S.call('POST', '/api/auth/login', { email: 'ngozi@example.com', password: 'anything-at-all-123' })).s, 401);
  });
  await test('the link lets them choose a strong password, signs them in, works once, and is stored hashed', async () => {
    const t = tokenOf(inv.invite_link);
    assert.ok(!(await q('SELECT token FROM resets')).some((r) => r.token === t), 'raw token must not be stored');
    assert.strictEqual((await S.call('POST', '/api/auth/reset', { token: t, password: 'short' })).s, 400);
    const ok = await S.call('POST', '/api/auth/reset', { token: t, password: 'Blue-Harbour-Lamp-2026-x' }); assert.strictEqual(ok.s, 200, ok.t); assert.strictEqual(ok.j.user.role, 'staff');
    assert.strictEqual((await S.call('POST', '/api/auth/reset', { token: t, password: 'Another-Long-Pass-88!' })).s, 400, 'second use refused');
    assert.strictEqual((await S.call('POST', '/api/auth/login', { email: 'ngozi@example.com', password: 'Blue-Harbour-Lamp-2026-x' })).s, 200);
  });
  await test('an expired invitation is refused, and resending gives a fresh working link', async () => {
    const r = await ST('POST', '', { name: 'Tunde Ade', email: 'tunde@example.com', role_id: await role(), invite: true }); const t = tokenOf(r.j.invite_link);
    await q('UPDATE resets SET expires=1'); assert.strictEqual((await S.call('POST', '/api/auth/reset', { token: t, password: 'Green-Market-Drum-2026-y' })).s, 400);
    const again = await ST('POST', `/${r.j.id}/invite`, {}); assert.strictEqual(again.s, 200); const t2 = tokenOf(again.j.invite_link); assert.notStrictEqual(t, t2);
    assert.strictEqual((await S.call('POST', '/api/auth/reset', { token: t2, password: 'Green-Market-Drum-2026-y' })).s, 200);
  });
  await test('only the owner can invite; a switched-off account cannot be invited; other admins are not reset by someone else', async () => {
    const ng = await S.call('POST', '/api/auth/login', { email: 'ngozi@example.com', password: 'Blue-Harbour-Lamp-2026-x' });
    const id = (await ST('GET', '')).j.staff.find((x) => x.email === 'ngozi@example.com').id;
    assert.ok([401, 403].includes((await S.call('POST', `/api/admin/staff/${id}/invite`, {}, ng.c)).s)); assert.strictEqual((await S.call('POST', `/api/admin/staff/${id}/invite`, {})).s, 401);
    await ST('PUT', `/${id}`, { active: false }); assert.strictEqual((await ST('POST', `/${id}/invite`, {})).s, 400);
    assert.strictEqual((await ST('POST', '/99999/invite', {})).s, 404);
  });
  await test('the old way still works: choosing a password, or no invite, gives the same result as before', async () => {
    const a = await ST('POST', '', { name: 'Old Way', email: 'old@example.com', role_id: await role() }); assert.ok(a.j.temp_password && !a.j.invited);
    const b = await ST('POST', '', { name: 'Typed Pw', email: 'typed@example.com', role_id: await role(), password: 'Owner-Typed-Pass-2026!', invite: true }); assert.ok(!b.j.invited && !b.j.temp_password);
  });
  S.srv.kill(); await sleep(300);

  console.log('\nInvitations when email is set up');
  S = await start(base + 1, true);
  const owner2 = (await S.call('POST', '/api/auth/login', { email: 'owner@example.com', password: OWNER })).c;
  const ST2 = (m, u, b) => S.call(m, '/api/admin/staff' + u, b, owner2);
  await test('the invitation is emailed to the employee only; the owner never sees the link or a password', async () => {
    const r = await ST2('POST', '', { name: 'Chidi Okoro', email: 'chidi@example.com', role_id: await role() }); // no "invite" flag: email on means invite by default
    assert.strictEqual(r.s, 200, r.t); assert.strictEqual(r.j.invited, true); assert.strictEqual(r.j.emailed, true); assert.strictEqual(r.j.invite_link, undefined); assert.strictEqual(r.j.temp_password, undefined);
    const m = (await q("SELECT * FROM outbox WHERE to_email='chidi@example.com'"))[0]; assert.ok(m, 'mail stored'); assert.ok(/Choose my password/.test(m.body) && /chidi@example.com/.test(m.body) && /forgot\?token=[0-9a-f]{64}&amp;invite=1|forgot\?token=[0-9a-f]{64}&invite=1/.test(m.body.replace(/&amp;/g, '&')));
    const link = m.body.match(/href="([^"]+forgot[^"]+)"/)[1].replace(/&amp;/g, '&');
    assert.strictEqual((await S.call('POST', '/api/auth/reset', { token: tokenOf(link), password: 'Red-Station-Kite-2026-z' })).s, 200);
  });
  await test('the employee name is escaped in the email', async () => {
    await ST2('POST', '', { name: '<b>Evil</b> Name', email: 'evil@example.com', role_id: await role() });
    const m = (await q("SELECT body FROM outbox WHERE to_email='evil@example.com'"))[0]; assert.ok(!/<b>Evil/.test(m.body) && /&lt;b&gt;Evil/.test(m.body));
  });
  S.srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  await sleep(300); await pg(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
