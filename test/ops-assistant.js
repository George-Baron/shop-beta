'use strict';
// The Command Centre assistant with a stand-in for the AI service (no network, no cost): tool loop, honest statuses, model choice, usage tracking.
// Run with: npm run test:ops-assistant
const assert = require('assert');
const { Client } = require('pg');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const DB = 'sb_opsasst_' + Date.now().toString(36);
const urlOf = (db) => ADMIN_URL.replace(/\/[^/?]*(\?.*)?$/, '/' + db + '$1');
let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  process.env.DATABASE_URL = urlOf(DB); process.env.NODE_ENV = 'test'; process.env.ANTHROPIC_API_KEY = 'test-key';
  const { run, get, migrate, close } = require('../lib/db'); await migrate();
  const A = require('../lib/ops/assistant'), St = require('../lib/ops/store');
  const owner = { id: Number((await run("INSERT INTO users (name,email,phone,password,role,created) VALUES ('Owner','o@t.test','08011111111','x','admin',1)")).lastInsertRowid), name: 'Owner', role: 'admin' };
  // a script of what the stand-in AI service says, one entry per call
  let script = [], seen = [];
  global.fetch = async (url, opt) => { const body = JSON.parse(opt.body); seen.push(body); const r = script.shift(); return { ok: true, json: async () => r, text: async () => '' }; };
  const tool = (name, input, usage = { input_tokens: 1000, output_tokens: 100 }) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't' + Math.random(), name, input }], usage });
  const say = (text, usage = { input_tokens: 1500, output_tokens: 200, cache_read_input_tokens: 3000 }) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage });

  console.log('\nAssistant');
  await test('it reads real data, acts through the gateway, and reports the backend status, not its own words', async () => {
    script = [tool('read_data', { what: 'overview' }), tool('take_action', { type: 'task.create', summary: 'Call supplier', payload: { title: 'Call supplier' } }), say('All done, the supplier was paid!')];
    const r = await A.chat(owner, null, 'Create a task to call the supplier');
    assert.strictEqual(r.actions.length, 1); assert.strictEqual(r.actions[0].status, 'done'); assert.strictEqual(r.actions[0].type, 'task.create');
    assert.ok(await get("SELECT id FROM ops_tasks WHERE title='Call supplier'"));
  });
  await test('a payment the AI asks for is shown as waiting for approval, whatever the model says', async () => {
    script = [tool('take_action', { type: 'supplier.payment', summary: 'Pay ACME', amount: 500000, counterparty: 'ACME', related_type: 'po', related_id: 'PO-1' }), say('Payment sent!')];
    const r = await A.chat(owner, null, 'Pay ACME');
    assert.notStrictEqual(r.actions[0].status, 'done'); assert.ok(['recommended', 'pending_approval', 'blocked'].includes(r.actions[0].status));
  });
  await test('an action that is not allowed comes back blocked', async () => {
    script = [tool('take_action', { type: 'bank.drain', summary: 'x' }), say('ok')]; const r = await A.chat(owner, null, 'x'); assert.strictEqual(r.actions[0].status, 'blocked');
  });
  await test('the system prompt tells it never to invent data and to report real statuses', async () => {
    assert.match(seen[0].system[0].text, /Never invent/); assert.match(seen[0].system[0].text, /Never say something was done unless the status is "done"/);
  });

  console.log('\nModel choice and cost');
  await test('the default model is used until management picks another', async () => {
    script = [say('hi')]; seen = []; await A.chat(owner, null, 'hello'); assert.strictEqual(seen[0].model, A.MODEL);
    await St.saveConfig({ assistant_model: 'claude-haiku-5-5' }, 't'); script = [say('hi')]; await A.chat(owner, null, 'hello again'); assert.strictEqual(seen[1].model, 'claude-haiku-5-5');
  });
  await test('an unknown model name is ignored, not sent', async () => {
    await St.saveConfig({ assistant_model: 'gpt-nonsense' }, 't'); assert.strictEqual((await St.getConfig()).assistant_model, '');
  });
  await test('tokens and the model are recorded for every reply', async () => {
    const row = await get("SELECT model, tokens_in, tokens_cached, tokens_out FROM ops_chat_messages WHERE role='assistant' AND model='claude-haiku-5-5'");
    assert.strictEqual(row.tokens_in, 1500); assert.strictEqual(row.tokens_cached, 3000); assert.strictEqual(row.tokens_out, 200);
  });
  await test('the spend estimate uses list prices', async () => {
    assert.ok(Math.abs(A.costUsd('claude-sonnet-5-5', { tokens_in: 1e6, tokens_cached: 0, tokens_out: 1e6 }) - 12) < 1e-9);
    assert.ok(Math.abs(A.costUsd('claude-haiku-5-5', { tokens_in: 1e6, tokens_cached: 1e6, tokens_out: 1e6 }) - 0.61) < 1e-9);
    assert.strictEqual(A.costUsd('unknown', {}), null);
    const u = await A.usageReport(); assert.ok(u.today.replies >= 1); assert.ok(u.today.est_usd > 0);
  });
  await test('the daily message limit stops the assistant before it spends anything', async () => {
    await St.saveConfig({ chat_daily_cap: 1 }, 't'); seen = []; const r = await A.chat(owner, null, 'one more'); assert.ok(r.capped); assert.strictEqual(seen.length, 0);
  });
  await test('if the AI service fails nothing is changed and the user is told', async () => {
    await St.saveConfig({ chat_daily_cap: 500 }, 't'); global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });
    const r = await A.chat(owner, null, 'do something'); assert.match(r.reply, /Nothing was changed/); assert.deepStrictEqual(r.actions, []);
  });
  await close();
  const a2 = new Client({ connectionString: ADMIN_URL }); await a2.connect(); await a2.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a2.end();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
