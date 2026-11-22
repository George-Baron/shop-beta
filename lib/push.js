'use strict';
// Push notifications for the mobile apps, through Expo's push service. Every customer notification (lib/notify.js) is pushed once, in the background,
// to the phones that are still signed in, if the customer wants that kind of message. No secret is needed for sending; EXPO_ACCESS_TOKEN is optional
// and only used when "enhanced security" is switched on in the Expo account. The push carries a title and a short line, never payment or address details.
const { get, all, run, now } = require('./db');
const queue = require('./queue');

const EXPO_URL = process.env.EXPO_PUSH_URL || 'https://exp.host/--/api/v2/push'; // overridden only by tests
const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,64}\]$/;
// Which notification types are pushed, and under which switch. Anything not listed stays in the in-app list only.
const CATEGORY = { order: 'orders', payment: 'orders', rfq: 'wholesale', wholesale: 'wholesale', announcement: 'wholesale', offer: 'offers' };
const DEFAULTS = { orders: 1, wholesale: 1, offers: 0 };
const KEYS = Object.keys(DEFAULTS);

const prefs = async (userId) => {
  const r = await get('SELECT orders, wholesale, offers FROM push_prefs WHERE user_id=?', userId);
  return r ? { orders: !!Number(r.orders), wholesale: !!Number(r.wholesale), offers: !!Number(r.offers) } : { orders: true, wholesale: true, offers: false };
};
async function setPrefs(userId, b) {
  const cur = await prefs(userId), next = { ...cur };
  for (const k of KEYS) if (b && typeof b[k] === 'boolean') next[k] = b[k];
  await run('INSERT INTO push_prefs (user_id,orders,wholesale,offers,updated) VALUES (?,?,?,?,?) ON CONFLICT (user_id) DO UPDATE SET orders=EXCLUDED.orders, wholesale=EXCLUDED.wholesale, offers=EXCLUDED.offers, updated=EXCLUDED.updated',
    userId, +next.orders, +next.wholesale, +next.offers, now());
  return next;
}

// A phone registers its Expo token for the signed-in device session. A token that moves to another account or device is moved, never duplicated.
async function register(user, session, token, platform) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) { const e = new Error('That is not a valid push token.'); e.status = 400; e.code = 'invalid_push_token'; throw e; }
  const t = now();
  await run('DELETE FROM push_tokens WHERE session_id=? AND token<>?', session.id, token);   // one token per device session
  await run(`INSERT INTO push_tokens (user_id,session_id,token,platform,created,last_seen) VALUES (?,?,?,?,?,?)
             ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id, session_id=EXCLUDED.session_id, platform=EXCLUDED.platform, last_seen=EXCLUDED.last_seen, disabled_at=NULL, disabled_reason=''`,
  user.id, session.id, token, String(platform || '').slice(0, 20), t, t);
}
const unregister = (user, token) => run('DELETE FROM push_tokens WHERE user_id=? AND token=?', user.id, String(token || ''));

// Called by notify() after it saved a notification. The job key makes a repeat harmless.
async function enqueue(notificationId, userId, type) {
  if (!CATEGORY[type]) return;
  const has = await get('SELECT 1 x FROM push_tokens WHERE user_id=? AND disabled_at IS NULL LIMIT 1', userId);
  if (has) await queue.enqueue('push.send', { id: Number(notificationId) }, { key: 'push:' + notificationId });
}

async function send(notificationId) {
  const n = await get('SELECT id, user_id, type, title, body, link FROM notifications WHERE id=?', notificationId);
  if (!n || !CATEGORY[n.type]) return 0;
  // The row is claimed first; a second job for the same notification finds it taken and does nothing.
  const claim = await get('INSERT INTO push_deliveries (notification_id, sent_at, tokens) VALUES (?,?,0) ON CONFLICT DO NOTHING RETURNING notification_id', n.id, now());
  if (!claim) return 0;
  if (!(await prefs(n.user_id))[CATEGORY[n.type]]) return 0;
  const rows = await all('SELECT t.id, t.token FROM push_tokens t JOIN mobile_sessions s ON s.id=t.session_id JOIN users u ON u.id=t.user_id WHERE t.user_id=? AND t.disabled_at IS NULL AND s.revoked_at IS NULL AND u.active<>0', n.user_id);
  if (!rows.length) return 0;
  const unread = Number((await get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL', n.user_id)).n);
  const messages = rows.map((r) => ({ to: r.token, title: n.title, body: n.body || undefined, sound: 'default', badge: unread, data: { notificationId: Number(n.id), type: n.type, link: n.link } }));
  let res;
  try {
    res = await fetch(EXPO_URL + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: 'Bearer ' + process.env.EXPO_ACCESS_TOKEN } : {}) }, body: JSON.stringify(messages), signal: AbortSignal.timeout(15000) });
  } catch (e) { await run('DELETE FROM push_deliveries WHERE notification_id=?', n.id); throw e; }   // not reached Expo: free the claim so the retry can send
  if (res.status >= 500 || res.status === 429) { await run('DELETE FROM push_deliveries WHERE notification_id=?', n.id); throw new Error('Expo push answered ' + res.status); }
  const body = await res.json().catch(() => ({})), tickets = Array.isArray(body.data) ? body.data : [];
  let ok = 0;
  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    if (t && t.status === 'ok') ok++;
    else if (t && t.details && t.details.error === 'DeviceNotRegistered') await run("UPDATE push_tokens SET disabled_at=?, disabled_reason='not_registered' WHERE id=?", now(), rows[i].id);
  }
  await run('UPDATE push_deliveries SET tokens=? WHERE notification_id=?', ok, n.id);
  return ok;
}
const purge = async () => { await run('DELETE FROM push_deliveries WHERE sent_at<?', now() - 30 * 86400); await run('DELETE FROM push_tokens WHERE (disabled_at IS NOT NULL AND disabled_at<?) OR last_seen<?', now() - 30 * 86400, now() - 120 * 86400); };

module.exports = { register, unregister, enqueue, send, prefs, setPrefs, purge, CATEGORY, TOKEN_RE };
