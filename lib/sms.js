'use strict';
// Text messages (one-time codes). Like email: every message is stored in sms_outbox, and is sent only when a gateway is configured.
//   SMS_DRIVER=outbox  (default) store only. Nothing leaves the server. Fine for testing, NOT for real customers.
//   SMS_DRIVER=webhook POST {"to":"2348012345678","message":"..."} as JSON to SMS_WEBHOOK_URL with "Authorization: Bearer SMS_WEBHOOK_TOKEN".
//                      Point it at the gateway you choose (or a small relay in front of it). No specific SMS provider is built in yet.
const { run, now } = require('./db');
const driver = () => (process.env.SMS_DRIVER || 'outbox').toLowerCase();
const live = () => driver() === 'webhook' && !!process.env.SMS_WEBHOOK_URL;

async function send(toPhone, message) {
  const r = await run('INSERT INTO sms_outbox (to_phone, body, created) VALUES (?,?,?)', toPhone, message, now());
  if (!live()) return { sent: false, stored: true };
  try {
    const res = await fetch(process.env.SMS_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.SMS_WEBHOOK_TOKEN ? { Authorization: 'Bearer ' + process.env.SMS_WEBHOOK_TOKEN } : {}) }, body: JSON.stringify({ to: toPhone, message }), signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('gateway answered ' + res.status);
    await run('UPDATE sms_outbox SET sent=1 WHERE id=?', Number(r.lastInsertRowid)); return { sent: true };
  } catch (e) { await run('UPDATE sms_outbox SET error=? WHERE id=?', String(e.message).slice(0, 200), Number(r.lastInsertRowid)); return { sent: false, error: e.message }; }
}
module.exports = { send, live };
