'use strict';
// Everything that happens in the background, as handlers for the job queue (lib/queue.js):
//   email             send one stored email through Resend (retries; permanent errors go to Admin > Jobs)
//   order-mail        build and queue the emails for an order event (placed / paid / status change)
//   paystack-webhook  confirm a Paystack payment with Paystack itself, then mark the order paid
//   remind-abandoned, expire-unpaid, cleanup   scheduled housekeeping (any instance may schedule; only one job of each kind exists at a time)
// Handlers may run more than once for the same job, so each one is safe to repeat.
const { get, all, run, now } = require('./db');
const S = require('./shop');
const queue = require('./queue');

const RESEND_URL = (process.env.RESEND_API_URL || 'https://api.resend.com').replace(/\/+$/, '');
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Shop-Beta <onboarding@resend.dev>';

// Email shoppers who typed an email at checkout but never ordered (at least 1 hour ago, at most 3 days ago).
async function remindAbandoned() {
  {
    const t = now(), settings = await S.getSettings();
    let sent = 0;
    for (const c of await all('SELECT * FROM abandoned WHERE reminded=0 AND created<=? AND created>=?', t - 3600, t - 3 * 86400)) {
      if (await get('SELECT 1 x FROM orders WHERE lower(email)=? AND created>=?', c.email, c.created)) { await run('DELETE FROM abandoned WHERE email=?', c.email); continue; }
      let items = []; try { items = JSON.parse(c.cart); } catch { /* skip */ }
      const names = [];
      for (const i of items) { const p = await get('SELECT name FROM products WHERE id=? AND active=1', i.productId); if (p) names.push(p.name); }
      if (!names.length) { await run('DELETE FROM abandoned WHERE email=?', c.email); continue; }
      // Mark first, then send: if two instances ever overlap, the shopper still gets one email, not two.
      const claimed = await run('UPDATE abandoned SET reminded=1 WHERE email=? AND reminded=0', c.email);
      if (claimed.changes !== 1) continue;
      await S.queueMail(c.email, `You left something in your ${settings.store_name} cart`,
        S.mailWrap(settings, `<p>Your cart is waiting:</p><ul>${names.map((n) => `<li>${S.esc(n)}</li>`).join('')}</ul><p><a href="${S.BASE_URL}/checkout">Finish your order</a></p>`));
      sent++;
    }
    return sent;
  }
}

// Online orders that were never paid hold stock. Release it after 2 hours.
async function expireUnpaid() {
  {
    for (const o of await all("SELECT id FROM orders WHERE payment_method='paystack' AND payment_status='unpaid' AND status='pending' AND created<?", now() - 7200)) {
      const order = await S.loadOrder('id=?', o.id);
      if (order) await S.cancelOrder(order, 'Payment was not completed in time');
    }
  }
}

async function cleanup() {
  {
    await run('DELETE FROM sessions WHERE expires<?', now());
    await run('DELETE FROM resets WHERE expires<?', now());
    await run('DELETE FROM abandoned WHERE created<?', now() - 14 * 86400);
    await run('DELETE FROM outbox WHERE created<?', now() - 90 * 86400);
    await run('DELETE FROM rate_limits WHERE reset_at<?', Date.now());
    await queue.prune();
  }
}

async function sendEmail({ outboxId }) {
  const row = await get('SELECT id, to_email, subject, body, sent FROM outbox WHERE id=?', outboxId);
  if (!row || row.sent) return;           // already sent (a repeat of this job) or deleted
  if (!RESEND_KEY) return;                // no email service set up: the message just stays in Admin > Marketing > Email outbox
  const res = await fetch(RESEND_URL + '/emails', {
    method: 'POST',
    // The idempotency key makes Resend ignore a repeat of the same email if we crash between sending and saving "sent".
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': 'outbox-' + row.id },
    body: JSON.stringify({ from: MAIL_FROM, to: [row.to_email], subject: row.subject, html: row.body }), signal: AbortSignal.timeout(15000),
  });
  if (res.ok) { await run('UPDATE outbox SET sent=1 WHERE id=?', row.id); return; }
  const text = (await res.text().catch(() => '')).slice(0, 300);
  const err = new Error(`Resend answered ${res.status} ${text}`);
  // A bad address or key will not fix itself, so do not retry those. Busy/overloaded answers are retried.
  if (res.status >= 400 && res.status < 500 && ![408, 409, 425, 429].includes(res.status)) err.permanent = true;
  throw err;
}

async function orderMail({ kind, orderId, status, note }) {
  const o = await S.loadOrder('id=?', orderId);
  if (!o) return;
  if (kind === 'placed') await S.mailOrderPlaced(o);
  else if (kind === 'paid') await S.mailOrderPaid(o);
  else if (kind === 'status') await S.mailOrderStatus(o, status, note);
}

// Paystack told us (signed) that a payment happened. We do not trust the message itself: settleWithPaystack asks Paystack for the
// transaction and checks the status, currency and amount against the order before marking it paid.
async function paystackWebhook({ reference }) {
  const o = await S.settleWithPaystack(reference);
  if (o && o.payment_status !== 'paid' && S.paystackLive()) {
    // Paystack answered but the payment is not confirmed (or the amount is wrong). Try again later; Paystack sometimes confirms seconds after the webhook.
    throw new Error('Payment for ' + reference + ' is not confirmed by Paystack yet');
  }
}

queue.register('email', sendEmail);
queue.register('order-mail', orderMail);
queue.register('paystack-webhook', paystackWebhook);
queue.register('remind-abandoned', remindAbandoned);
queue.register('expire-unpaid', expireUnpaid);
queue.register('cleanup', cleanup);

// Each instance asks on a timer; the queue only lets one job of each kind in per interval, so the work is not doubled.
const SCHEDULE = [['expire-unpaid', 600], ['remind-abandoned', 900], ['cleanup', 3600]];
let timer = null;
function start() {
  if (timer) return;
  const schedule = () => Promise.all(SCHEDULE.map(([name, every]) => queue.enqueueEvery(name, every))).catch((e) => console.error('Could not schedule background jobs:', e.message));
  schedule(); timer = setInterval(schedule, 60 * 1000); timer.unref();
  queue.start();
}
async function stop() { if (timer) clearInterval(timer); timer = null; await queue.stop(); }

module.exports = { remindAbandoned, expireUnpaid, cleanup, sendEmail, orderMail, paystackWebhook, start, stop };
