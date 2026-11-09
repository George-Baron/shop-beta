'use strict';
// Background housekeeping: abandoned-cart reminders, expiring unpaid online orders, clearing old rows.
// Every instance runs these timers, so each job takes a short database lease first: only one instance does the work at a time.
// (Step 5 moves these into a proper job queue.)
const { get, all, run, now } = require('./db');
const S = require('./shop');

// Only one instance runs a given job at a time. The lease expires by itself, so a crashed instance cannot block the job forever.
async function withLock(name, ttlSeconds, fn) {
  const t = now();
  const got = await get(`INSERT INTO job_locks (name, locked_until) VALUES (?, ?)
    ON CONFLICT (name) DO UPDATE SET locked_until = EXCLUDED.locked_until WHERE job_locks.locked_until < ? RETURNING name`, name, t + ttlSeconds, t);
  if (!got) return undefined;
  try { return await fn(); } finally { await run('UPDATE job_locks SET locked_until = 0 WHERE name = ?', name); }
}

// Email shoppers who typed an email at checkout but never ordered (at least 1 hour ago, at most 3 days ago).
async function remindAbandoned() {
  return (await withLock('remind-abandoned', 600, async () => {
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
  })) || 0;
}

// Online orders that were never paid hold stock. Release it after 2 hours.
async function expireUnpaid() {
  await withLock('expire-unpaid', 600, async () => {
    for (const o of await all("SELECT id FROM orders WHERE payment_method='paystack' AND payment_status='unpaid' AND status='pending' AND created<?", now() - 7200)) {
      const order = await S.loadOrder('id=?', o.id);
      if (order) await S.cancelOrder(order, 'Payment was not completed in time');
    }
  });
}

async function cleanup() {
  await withLock('cleanup', 600, async () => {
    await run('DELETE FROM sessions WHERE expires<?', now());
    await run('DELETE FROM resets WHERE expires<?', now());
    await run('DELETE FROM abandoned WHERE created<?', now() - 14 * 86400);
    await run('DELETE FROM outbox WHERE created<?', now() - 90 * 86400);
  });
}

function start() {
  const safe = (fn) => () => { fn().catch((e) => console.error('Background job failed:', e.message)); };
  setInterval(safe(expireUnpaid), 10 * 60 * 1000).unref();
  setInterval(safe(remindAbandoned), 15 * 60 * 1000).unref();
  setInterval(safe(cleanup), 60 * 60 * 1000).unref();
  safe(cleanup)();
}

module.exports = { remindAbandoned, expireUnpaid, cleanup, start };
