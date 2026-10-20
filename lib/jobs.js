'use strict';
// Background housekeeping: abandoned-cart reminders, expiring unpaid online orders, clearing old sessions.
const { get, all, run, now } = require('./db');
const S = require('./shop');

// Email shoppers who typed an email at checkout but never ordered (at least 1 hour ago, at most 3 days ago).
function remindAbandoned() {
  const t = now(), settings = S.getSettings();
  let sent = 0;
  for (const c of all('SELECT * FROM abandoned WHERE reminded=0 AND created<=? AND created>=?', t - 3600, t - 3 * 86400)) {
    if (get('SELECT 1 x FROM orders WHERE email=? AND created>=?', c.email, c.created)) { run('DELETE FROM abandoned WHERE email=?', c.email); continue; }
    let items = []; try { items = JSON.parse(c.cart); } catch { /* skip */ }
    const names = items.map((i) => get('SELECT name FROM products WHERE id=? AND active=1', i.productId)).filter(Boolean).map((p) => p.name);
    if (!names.length) { run('DELETE FROM abandoned WHERE email=?', c.email); continue; }
    S.queueMail(c.email, `You left something in your ${settings.store_name} cart`,
      S.mailWrap(settings, `<p>Your cart is waiting:</p><ul>${names.map((n) => `<li>${S.esc(n)}</li>`).join('')}</ul><p><a href="${S.BASE_URL}/checkout">Finish your order</a></p>`));
    run('UPDATE abandoned SET reminded=1 WHERE email=?', c.email);
    sent++;
  }
  return sent;
}

// Online orders that were never paid hold stock. Release it after 2 hours.
function expireUnpaid() {
  for (const o of all("SELECT id FROM orders WHERE payment_method='paystack' AND payment_status='unpaid' AND status='pending' AND created<?", now() - 7200)) {
    const order = S.loadOrder('id=?', o.id);
    if (order) S.cancelOrder(order, 'Payment was not completed in time');
  }
}

function cleanup() {
  run('DELETE FROM sessions WHERE expires<?', now());
  run('DELETE FROM resets WHERE expires<?', now());
  run('DELETE FROM abandoned WHERE created<?', now() - 14 * 86400);
  run('DELETE FROM outbox WHERE created<?', now() - 90 * 86400);
}

function start() {
  const safe = (fn) => () => { try { fn(); } catch (e) { console.error('Background job failed:', e.message); } };
  setInterval(safe(expireUnpaid), 10 * 60 * 1000).unref();
  setInterval(safe(remindAbandoned), 15 * 60 * 1000).unref();
  setInterval(safe(cleanup), 60 * 60 * 1000).unref();
  safe(cleanup)();
}

module.exports = { remindAbandoned, expireUnpaid, cleanup, start };
