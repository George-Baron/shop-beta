'use strict';
// Background housekeeping: abandoned-cart reminders, expiring unpaid online orders, clearing old sessions.
const { get, all, run, now } = require('./db');
const S = require('./shop');

// Email shoppers who typed an email at checkout but never ordered (at least 1 hour ago, at most 3 days ago).
async function remindAbandoned() {
  const t = now(), settings = await S.getSettings();
  let sent = 0;
  for (const c of await all('SELECT * FROM abandoned WHERE reminded=0 AND created<=? AND created>=?', t - 3600, t - 3 * 86400)) {
    if (await get('SELECT 1 x FROM orders WHERE email=? AND created>=?', c.email, c.created)) { await run('DELETE FROM abandoned WHERE email=?', c.email); continue; }
    let items = []; try { items = JSON.parse(c.cart); } catch { /* skip */ }
    const names = [];
    for (const i of items) { const pr = await get('SELECT name FROM products WHERE id=? AND active=1', i.productId); if (pr) names.push(pr.name); }
    if (!names.length) { await run('DELETE FROM abandoned WHERE email=?', c.email); continue; }
    await S.queueMail(c.email, `You left something in your ${settings.store_name} cart`,
      S.mailWrap(settings, `<p>Your cart is waiting:</p><ul>${names.map((n) => `<li>${S.esc(n)}</li>`).join('')}</ul><p><a href="${S.BASE_URL}/checkout">Finish your order</a></p>`));
    await run('UPDATE abandoned SET reminded=1 WHERE email=?', c.email);
    sent++;
  }
  return sent;
}

// Online orders that were never paid hold stock. Release it after 2 hours.
async function expireUnpaid() {
  for (const o of await all("SELECT id FROM orders WHERE payment_method='paystack' AND payment_status='unpaid' AND status='pending' AND created<?", now() - 7200)) {
    const order = await S.loadOrder('id=?', o.id);
    if (order) await S.cancelOrder(order, 'Payment was not completed in time');
  }
}

async function cleanup() {
  await run('DELETE FROM sessions WHERE expires<?', now());
  await run('DELETE FROM resets WHERE expires<?', now());
  await run('DELETE FROM abandoned WHERE created<?', now() - 14 * 86400);
  await run('DELETE FROM outbox WHERE created<?', now() - 90 * 86400);
  await require('./queue').prune();
}

module.exports = { remindAbandoned, expireUnpaid, cleanup };
