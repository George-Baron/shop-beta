'use strict';
// Web Push: a copy of each in-app notification goes to the person's subscribed browsers/phones. Off until VAPID keys are set.
// Generate keys once with:  node -e "console.log(require('web-push').generateVAPIDKeys())"  then set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (mailto:you@yourshop.com).
const { get, all, run, now } = require('./db');
const { fail, str } = require('./shop');

const enabled = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
const lib = () => { const w = require('web-push'); w.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY); return w; };
const publicKey = () => (enabled() ? process.env.VAPID_PUBLIC_KEY : '');
const b64 = /^[A-Za-z0-9_-]{16,200}$/;

async function subscribe(user, b, agent) {
  if (!enabled()) fail(503, 'Phone alerts are not switched on yet.');
  const s = b && b.subscription || b || {}, k = s.keys || {}, ep = String(s.endpoint || '');
  if (!/^https:\/\/[^\s]{10,900}$/.test(ep) || !b64.test(String(k.p256dh || '')) || !b64.test(String(k.auth || ''))) fail(400, 'That device could not be registered.');
  if (Number((await get('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?', user.id)).n) >= 10 && !(await get('SELECT 1 x FROM push_subscriptions WHERE endpoint=? AND user_id=?', ep, user.id))) fail(400, 'This account already has 10 devices. Turn one off first.');
  await run(`INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth,agent,created) VALUES (?,?,?,?,?,?)
    ON CONFLICT (endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, agent=excluded.agent, fails=0`, user.id, ep, k.p256dh, k.auth, str(agent, 160), now());
  return { ok: true };
}
async function unsubscribe(user, b) {
  const ep = String((b && b.endpoint) || ''); if (!ep) fail(400, 'Which device?');
  await run('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?', ep, user.id); return { ok: true };
}
const mine = async (user) => Number((await get('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?', user.id)).n);

// Called by notify(): hand the sending to the background worker so the action that caused it is never slowed down or broken.
async function queueFor(ids, c) {
  if (!enabled() || !ids.length || c.type === 'promo') return;
  const q = require('./queue');
  const have = await all('SELECT DISTINCT user_id FROM push_subscriptions WHERE user_id = ANY(?)', ids);
  for (const r of have) await q.enqueue('push.send', { userId: Number(r.user_id), title: c.title, body: c.body, link: c.link, type: c.type });
}
// Worker: send to every device of one person. A device that is gone (404/410) is forgotten; one that keeps failing is dropped after 5 tries.
async function send(p) {
  if (!enabled()) return;
  const w = lib(), subs = await all('SELECT * FROM push_subscriptions WHERE user_id=?', p.userId);
  const payload = JSON.stringify({ title: str(p.title, 100), body: str(p.body, 200), link: String(p.link || '/').startsWith('/') ? p.link : '/', tag: str(p.type, 30) });
  for (const s of subs) {
    try { await w.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, timeout: 8000 }); await run('UPDATE push_subscriptions SET last_ok=?, fails=0 WHERE id=?', now(), s.id); }
    catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await run('DELETE FROM push_subscriptions WHERE id=?', s.id);
      else { await run('UPDATE push_subscriptions SET fails=fails+1 WHERE id=?', s.id); await run('DELETE FROM push_subscriptions WHERE id=? AND fails>=5', s.id); }
    }
  }
}
module.exports = { enabled, publicKey, subscribe, unsubscribe, mine, queueFor, send };
