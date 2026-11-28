'use strict';
// Each customer's payment preferences. They only pre-select choices at checkout: the customer still sees the final amounts and confirms.
const { get, run, now } = require('./db');
const { fail, str } = require('./shop');
const METHODS = ['', 'wallet', 'paystack', 'card', 'pod'];
const shape = (r) => ({ default_method: r ? r.default_method : '', preselect_wallet: !!(r && r.preselect_wallet), preselect_points: !!(r && r.preselect_points), promo_notifications: r ? !!r.promo_notifications : true });
const read = async (user) => shape(await get('SELECT * FROM payment_preferences WHERE user_id=?', user.id));
async function write(user, b) {
  b = b || {};
  const cur = await read(user), m = b.default_method === undefined ? cur.default_method : str(b.default_method, 12);
  if (!METHODS.includes(m)) fail(400, 'Unknown payment method.');
  const flag = (k) => (b[k] === undefined ? (cur[k] ? 1 : 0) : b[k] ? 1 : 0);
  await run(`INSERT INTO payment_preferences (user_id,default_method,preselect_wallet,preselect_points,promo_notifications,updated) VALUES (?,?,?,?,?,?)
    ON CONFLICT (user_id) DO UPDATE SET default_method=excluded.default_method, preselect_wallet=excluded.preselect_wallet, preselect_points=excluded.preselect_points, promo_notifications=excluded.promo_notifications, updated=excluded.updated`,
    user.id, m, flag('preselect_wallet'), flag('preselect_points'), flag('promo_notifications'), now());
  return read(user);
}
module.exports = { read, write };
