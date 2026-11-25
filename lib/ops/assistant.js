'use strict';
// The assistant in the Command Centre. A person types an instruction; the model reads real data and asks the gateway to act.
// What is shown as "done / recommended / waiting for approval / blocked / failed" comes from the backend results (returned in `actions`),
// never from the model's wording. Without an API key it still answers with live figures, and says it is not using the language model.
const { get, all, run, now } = require('../db');
const S = require('../shop');
const St = require('./store');
const T = require('./tools');
const D = require('./data');

const KEY = process.env.ANTHROPIC_API_KEY || '';
const API = (process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const MODEL = process.env.OPS_ASSISTANT_MODEL || process.env.ASSISTANT_MODEL || 'claude-sonnet-5-5';
const MAX_ROUNDS = 6, MAX_CHARS = 2000, HISTORY = 16;
const enabled = () => !!KEY;

const SYSTEM = `You are the ${St.AI_NAME} for VELTO-MART, working inside the management Command Centre.
Rules you never break:
- Read real data with read_data before stating any number. If the data does not hold something, say it is not recorded. Never invent suppliers, quotations, prices, exchange rates, tracking numbers, customs charges or costs.
- Do things only through take_action. Report exactly the status it returns: done, recommended (nothing was changed), pending_approval (a person must approve; give the approval reference), blocked or failed. Never say something was done unless the status is "done".
- You cannot approve anything, pay anyone, change bank details, split an amount to avoid an approval level, or change stock without the proper record. If asked, say a person must do it.
- Retail and wholesale stock are separate; never mix them. Costs the system does not record are reported as not recorded.
- Be brief and concrete: lead with the answer, then the few figures or next steps that matter. Amounts are in Naira unless stated.`;

async function callClaude(messages) {
  const res = await fetch(API + '/v1/messages', {
    method: 'POST', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }], tools: T.TOOLS, messages }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('upstream ' + res.status + ' ' + t.slice(0, 160)); }
  return res.json();
}

// Keep tool results small enough to fit; the model gets the top of long lists.
const shrink = (v) => { let s = JSON.stringify(v); if (s.length > 12000) s = s.slice(0, 12000) + '…[truncated]'; return s; };

async function plainAnswer() {
  const o = await D.overview({});
  const lines = ['The language model is not switched on (no API key), so this is a live summary instead of an answer to your question.'];
  const s = o.orders && o.orders.summary ? o.orders.summary : o.orders;
  lines.push('Orders: ' + JSON.stringify(s).slice(0, 400));
  lines.push('Approvals: ' + JSON.stringify(o.ops && o.ops.approvals) + ' · Open exceptions: ' + JSON.stringify(o.ops && o.ops.exceptions));
  return lines.join('\n');
}

async function chat(user, chatId, text) {
  const msg = S.str(text, MAX_CHARS).trim(); if (!msg) S.fail(400, 'Type an instruction first.');
  const cfg = await St.getConfig();
  const used = await get("SELECT COUNT(*) n FROM ops_chat_messages WHERE role='user' AND created>=?", St.dayStartUtc());
  if (Number(used.n) >= cfg.chat_daily_cap) return { reply: 'The assistant has reached its daily limit. Management can raise it in the settings.', capped: true, actions: [] };
  let chatRow = chatId ? await get('SELECT * FROM ops_chats WHERE id=? AND user_id=?', Number(chatId), user.id) : null;
  if (!chatRow) { const r = await get('INSERT INTO ops_chats (user_id,title,created,updated) VALUES (?,?,?,?) RETURNING id', user.id, msg.slice(0, 60), now(), now()); chatRow = { id: r.id }; }
  const prior = await all('SELECT role, content FROM ops_chat_messages WHERE chat_id=? ORDER BY id DESC LIMIT ?', chatRow.id, HISTORY);
  await run('INSERT INTO ops_chat_messages (chat_id,role,content,created) VALUES (?,?,?,?)', chatRow.id, 'user', msg, now());
  const messages = [...prior.reverse().map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: msg }];
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const actions = []; let reply;
  if (!enabled()) reply = await plainAnswer();
  else {
    try {
      reply = '';
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const out = await callClaude(messages);
        const uses = (out.content || []).filter((b) => b.type === 'tool_use');
        if (out.stop_reason !== 'tool_use' || !uses.length) { reply = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(); break; }
        messages.push({ role: 'assistant', content: out.content });
        const results = [];
        for (const u of uses) {
          let r;
          try { r = await T.run(u.name, u.input, { user, requestedByUser: true }); } catch (e) { r = { status: 'failed', error: S.str(e.message, 200) }; }
          if (u.name === 'take_action') actions.push({ type: (u.input || {}).type, status: r.status, approval: r.approval, summary: r.summary || r.reason || r.error });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: shrink(r) });
        }
        messages.push({ role: 'user', content: results });
      }
      if (!reply) reply = 'I could not finish that. Please try again or narrow the request.';
    } catch (e) {
      console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', msg: 'ops assistant failed', error: S.str(e.message, 300) }));
      reply = 'The assistant could not reach the language model just now. Nothing was changed.';
    }
  }
  await run('INSERT INTO ops_chat_messages (chat_id,role,content,actions,created) VALUES (?,?,?,?::jsonb,?)', chatRow.id, 'assistant', reply, JSON.stringify(actions), now());
  await run('UPDATE ops_chats SET updated=? WHERE id=?', now(), chatRow.id);
  return { chat_id: chatRow.id, reply, actions };
}

async function history(user, chatId) {
  const c = await get('SELECT id FROM ops_chats WHERE id=? AND user_id=?', Number(chatId), user.id); if (!c) return [];
  return all('SELECT role, content, actions, created FROM ops_chat_messages WHERE chat_id=? ORDER BY id', c.id);
}
const chats = (user) => all('SELECT id, title, updated FROM ops_chats WHERE user_id=? ORDER BY updated DESC LIMIT 30', user.id);

module.exports = { enabled, chat, history, chats, MODEL };
