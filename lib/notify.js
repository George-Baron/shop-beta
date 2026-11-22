'use strict';
// Notification centre: in-app notifications for everyone (customers, partners, wholesale buyers, employees) and, for the important ones, an email copy
// through the normal mail queue. Sending never breaks the action that caused it.
const { get, all, run, now } = require('./db');
const S = require('./shop');
const { fail, str, int } = S;

const clean = (n) => ({ type: str(n.type, 40), title: str(n.title, 140), body: str(n.body, 600), link: String(n.link || '').startsWith('/') ? String(n.link).slice(0, 200) : '' });

// users: ids or user rows. n: { type, title, body, link, email }
async function notify(users, n) {
  try {
    const c = clean(n), ids = [...new Set((users || []).map((u) => Number(u && u.id !== undefined ? u.id : u)).filter(Boolean))];
    if (!ids.length || !c.title) return 0;
    for (const id of ids) {
      const r = await run('INSERT INTO notifications (user_id,type,title,body,link,created) VALUES (?,?,?,?,?,?)', id, c.type, c.title, c.body, c.link, now());
      await require('./push').enqueue(r.lastInsertRowid, id, c.type).catch((e) => console.error('Push not queued:', e.message));   // phones that have the app signed in
    }
    if (n.email) {
      const rows = await all('SELECT email FROM users WHERE id = ANY(?) AND active<>0', ids), set = await S.getSettings();
      for (const r of rows) if (r.email) await S.queueMail(r.email, c.title, S.mailWrap(set, `<p>${S.esc(c.body || c.title)}</p>${c.link ? `<p><a href="${S.esc(S.BASE_URL + c.link)}">Open it</a></p>` : ''}`));
    }
    return ids.length;
  } catch (e) { console.error('Notification failed:', e.message); return 0; }
}
const St = () => require('./staff');
const toStaff = async (module, write, n) => notify(await St().whoCan(module, write), n);
const toVendor = async (vendorId, n) => notify(await all("SELECT id FROM users WHERE role='vendor' AND vendor_id=? AND active<>0", vendorId), n);
const toAccount = async (accountId, n) => { const a = await get('SELECT user_id FROM wholesale_accounts WHERE id=?', accountId); return a ? notify([a.user_id], n) : 0; };

async function list(user, q = {}) {
  const lim = Math.min(100, Math.max(1, int(q.limit, 30))), before = int(q.before, 0);
  const rows = await all(`SELECT id, type, title, body, link, created, read_at FROM notifications WHERE user_id=? ${q.unread === '1' ? 'AND read_at IS NULL' : ''} ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ${lim + 1}`, user.id, ...(before ? [before] : []));
  return { notifications: rows.slice(0, lim).map((r) => ({ id: Number(r.id), type: r.type, title: r.title, body: r.body, link: r.link, created: Number(r.created), read: r.read_at != null })), more: rows.length > lim, unread: await count(user) };
}
const count = async (user) => Number((await get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL', user.id)).n);
async function markRead(user, b) {
  if (b && b.all) await run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', now(), user.id);
  else { const id = int(b && b.id); if (!id) fail(400, 'Which notification?'); await run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL', now(), id, user.id); }
}
// An announcement from the administrator to a whole group.
async function announce(audience, b, by) {
  const title = str(b.title, 140), body = str(b.body, 600); if (!title) fail(400, 'Please write a title.');
  const who = { partners: "SELECT id FROM users WHERE role='vendor' AND active<>0", wholesale: "SELECT u.id FROM users u JOIN wholesale_accounts a ON a.user_id=u.id WHERE a.status='approved' AND u.active<>0", staff: "SELECT id FROM users WHERE role IN ('staff','admin') AND active<>0" }[audience];
  if (!who) fail(400, 'Choose who should get it: partners, wholesale buyers or employees.');
  const n = await notify(await all(who), { type: 'announcement', title, body, link: audience === 'partners' ? '/partner' : audience === 'wholesale' ? '/wholesale' : '/admin', email: !!b.email });
  return { sent: n, by };
}
// Called whenever an order moves to a new status: tells the customer, the partner stores that have items in it and the right employees.
const NICE = { pending: 'placed', paid: 'paid', confirmed: 'confirmed', processing: 'being prepared', shipped: 'on its way', delivered: 'delivered', cancelled: 'cancelled', refunded: 'refunded' };
async function orderChanged(orderId, status, first) {
  try {
    const o = await get('SELECT id, ref, user_id, total, payment_method FROM orders WHERE id=?', orderId); if (!o) return;
    const word = NICE[status] || status, vendors = await all('SELECT DISTINCT vendor_id FROM order_items WHERE order_id=? AND vendor_id IS NOT NULL', orderId);
    if (o.user_id) await notify([o.user_id], { type: 'order', title: `Order ${o.ref} is ${word}`, link: '/account' });
    for (const v of vendors) await toVendor(v.vendor_id, { type: 'order', title: first ? `New order ${o.ref} for your store` : status === 'paid' ? `Payment received for order ${o.ref}` : `Order ${o.ref} is ${word}`, link: '/partner' });
    if (first) await toStaff('orders', true, { type: 'order', title: `New order ${o.ref} (${S.naira(o.total)})`, link: '/admin#/orders' });
    if (status === 'confirmed') await toStaff('orders', true, { type: 'order', title: `Order ${o.ref} is confirmed`, link: '/admin#/orders' });
    if (status === 'paid') await toStaff('finance', false, { type: 'payment', title: `Payment received for order ${o.ref} (${S.naira(o.total)})`, link: '/admin#/orders' });
  } catch (e) { console.error('Order notification failed:', e.message); }
}
module.exports = { orderChanged, notify, toStaff, toVendor, toAccount, list, count, markRead, announce };
