'use strict';
// Error tracking without another paid service: every unexpected error is stored in `error_log` (same mistake = one row with a count),
// shown in Admin > Jobs & errors, and the owner is alerted by email (ALERT_EMAIL) and/or a chat webhook (ALERT_WEBHOOK_URL).
//   - A NEW kind of error (or one you marked fixed that came back) alerts at once.
//   - The same error alerts again at most every ALERT_REPEAT_MINUTES (default 60).
//   - At most ALERT_MAX_PER_HOUR (default 20) alerts an hour overall, so a bad day cannot flood your inbox.
// Only the error text and the first lines of the stack are stored: never request bodies, headers, cookies or passwords.
const crypto = require('crypto');
const { get, all, run, now } = require('./db');
const log = require('./log');
const queue = require('./queue');
const INSTANCE = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || 'app';

const REPEAT_S = (Number(process.env.ALERT_REPEAT_MINUTES) || 60) * 60;
const MAX_PER_HOUR = Number(process.env.ALERT_MAX_PER_HOUR) || 20;
const FLUSH_MS = 2000;
const pending = new Map(); // fingerprint -> { n, ctx, timer }: bursts of the same error are written once per 2 s

const norm = (m) => String(m || '').replace(/[0-9a-f]{16,}/gi, '?').replace(/\d+/g, '#').slice(0, 300);
function fingerprint(source, err, route) {
  const frame = String((err && err.stack) || '').split('\n').find((l) => /\s+at /.test(l)) || '';
  return crypto.createHash('sha1').update([source, err && err.name, norm(err && err.message), frame.replace(/:\d+:\d+/, ''), source === 'request' ? route : ''].join('|')).digest('hex').slice(0, 16);
}

async function write(fp, ctx, n) {
  const t = now();
  const row = await get(`INSERT INTO error_log (fingerprint,source,message,stack,route,status,instance,count,first_seen,last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (fingerprint) DO UPDATE SET count = error_log.count + EXCLUDED.count, last_seen = EXCLUDED.last_seen,
        status = EXCLUDED.status, instance = EXCLUDED.instance,
        last_alerted = CASE WHEN error_log.resolved_at IS NOT NULL THEN NULL ELSE error_log.last_alerted END,
        resolved_at = NULL
      RETURNING id, last_alerted`, fp, ctx.source, ctx.message, ctx.stack, ctx.route, ctx.status || null, INSTANCE, n, t, t);
  if (row.last_alerted && t - row.last_alerted < REPEAT_S) return;
  // Claim the alert in the database first, so two instances hitting the same new error send one alert, not two.
  const recent = await get('SELECT COUNT(*) c FROM error_log WHERE last_alerted > ?', t - 3600);
  if (recent.c >= MAX_PER_HOUR) return;
  const claimed = await run('UPDATE error_log SET last_alerted=? WHERE id=? AND (last_alerted IS NULL OR last_alerted < ?)', t, row.id, t - REPEAT_S);
  if (claimed.changes !== 1) return;
  await queue.enqueue('alert', { subject: `[Shop-Beta] ${ctx.source} error: ${ctx.message.slice(0, 80)}`, text: `${ctx.source} error on ${INSTANCE}${ctx.route ? ' at ' + ctx.route : ''}${ctx.status ? ' (' + ctx.status + ')' : ''}:\n${ctx.message}\n\n${ctx.stack.split('\n').slice(0, 5).join('\n')}\n\nSee Admin > Jobs & errors.` }, { maxAttempts: 5 });
}

// Never throws and never waits for the database: a problem in error tracking must not turn into a second problem.
function record(err, { source = 'request', route = '', status } = {}) {
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    const ctx = { source, message: String(e.message).slice(0, 500), stack: String(e.stack || '').split('\n').slice(0, 10).join('\n').slice(0, 4000), route: String(route).slice(0, 200), status };
    const fp = fingerprint(source, e, ctx.route), p = pending.get(fp);
    if (p) { p.n++; p.ctx = ctx; return; }
    const entry = { n: 0, ctx };
    pending.set(fp, entry);
    write(fp, ctx, 1).catch((x) => log.error('Could not store error:', x.message));
    entry.timer = setTimeout(function flush() {
      const n = entry.n; entry.n = 0;
      if (!n) { pending.delete(fp); return; }
      write(fp, entry.ctx, n).catch((x) => log.error('Could not store error:', x.message)).finally(() => { entry.timer = setTimeout(flush, FLUSH_MS); entry.timer.unref(); });
    }, FLUSH_MS);
    entry.timer.unref();
  } catch (x) { log.error('Error tracking failed:', x.message); }
}

// The queue handler that actually sends an alert: chat webhook (Slack, Discord and Telegram-bridge style {text}) and/or email through Resend.
async function sendAlert({ subject, text }) {
  const hook = process.env.ALERT_WEBHOOK_URL, to = (process.env.ALERT_EMAIL || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!hook && !to.length) return; // nowhere to send: it is still in the log and in the admin screen
  if (hook) {
    const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: subject + '\n' + text, content: subject + '\n' + text }), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('Alert webhook answered ' + r.status);
  }
  if (to.length && process.env.RESEND_API_KEY) {
    const S = require('./shop');
    for (const addr of to) await S.queueMail(addr, subject, `<pre style="font-family:monospace;white-space:pre-wrap">${S.esc(text)}</pre>`);
  }
}

const list = () => all('SELECT * FROM error_log ORDER BY (resolved_at IS NOT NULL), last_seen DESC LIMIT 100');
const resolve = async (id) => (await run('UPDATE error_log SET resolved_at=? WHERE id=? AND resolved_at IS NULL', now(), id)).changes === 1;
const openCount = async (sinceSeconds = 3600) => (await get('SELECT COUNT(*) c FROM error_log WHERE resolved_at IS NULL AND last_seen > ?', now() - sinceSeconds)).c;
const prune = () => run('DELETE FROM error_log WHERE last_seen < ?', now() - 90 * 86400);

// Last-resort handlers. An uncaught exception leaves the process in an unknown state, so: log, try to store it, then exit and let Render restart us.
function installProcessHandlers(onFatal) {
  process.on('unhandledRejection', (e) => { log.error('Unhandled promise rejection:', e instanceof Error ? e : new Error(String(e))); record(e, { source: 'process' }); });
  process.on('uncaughtException', (e) => { log.error('Uncaught exception, exiting:', e); record(e, { source: 'process' }); setTimeout(() => { if (onFatal) onFatal(); process.exit(1); }, 1500); });
}

module.exports = { record, sendAlert, list, resolve, openCount, prune, installProcessHandlers, fingerprint };
