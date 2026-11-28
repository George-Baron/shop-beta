'use strict';
// Global Trade notifications. A sweep reads real tracking events, failed bookings and webhook errors and writes one notification per fact
// (dedupe_key), so running it twice never sends twice. Customers get email (through the store's email service). Staff get in-app alerts
// and, if "Email that receives trade alerts" is set, an email. SMS and WhatsApp are not connected for international numbers.
// Status meaning: sent = handed to the email service; queued = waiting; skipped = no email service connected or switched off; failed = could not be created.
const { get, all, run, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const N = require('../notify');
const { esc } = S;

const WINDOW = 2 * 86400;   // only recent facts are announced, so a first start never floods old orders
const CUSTOMER = {
  order_confirmed: ['Order confirmed, payment received', 'We received your payment and confirmed your order. We will pack it and send it with an international carrier.'],
  packed: ['Your order is packed', 'Your order is packed and waiting for the carrier.'],
  dispatched: ['Your order has been dispatched', 'Your parcel has been handed to the carrier.'],
  import_customs: ['Your parcel is at customs', 'Your parcel has reached customs in your country. Customs may ask for extra information. Duties and taxes may be payable to the carrier or customs on delivery unless they were paid at checkout.'],
  arrived_destination: ['Your parcel arrived in your country', 'Your parcel arrived in the destination country and will go through customs.'],
  customs_hold: ['Your parcel is held at customs', 'Customs is holding your parcel. The carrier or customs may contact you for documents or for duties and taxes. Please reply to them quickly. Contact us if you need help.'],
  delayed: ['Your delivery is delayed', 'Your parcel is delayed. We are following it up with the carrier.'],
  out_for_delivery: ['Your parcel is out for delivery', 'Your parcel is with the local courier and should reach you soon.'],
  delivered: ['Your parcel was delivered', 'Your parcel was marked as delivered. If you did not receive it, contact us.'],
};
const ADMIN = { delayed: 'Shipment delayed', exception: 'Shipment problem', customs_hold: 'Shipment held at customs' };
const stageText = (s) => String(s).replace(/_/g, ' ');

async function customerOn() { return (await T.setting('notify_customers')) !== '0'; }
async function add(row) {   // returns true when this notification is new
  const r = await run('INSERT INTO trade_notifications (event,audience,recipient,channel,export_order_id,import_shipment_id,dedupe_key,subject,body,status,created) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (dedupe_key) DO NOTHING',
    row.event, row.audience, row.recipient || '', row.channel, row.export_order_id || null, row.import_shipment_id || null, row.key, row.subject, row.body, row.status || 'queued', now());
  return r.changes === 1;
}
const mark = (key, status) => run('UPDATE trade_notifications SET status=?, sent=? WHERE dedupe_key=?', status, status === 'sent' ? now() : null, key);

async function toCustomer(ev, eo, o) {
  const m = CUSTOMER[ev.stage]; if (!m || !eo.ship_email) return 0;
  const key = 'c:ev:' + ev.id;
  const on = await customerOn(), link = `${S.BASE_URL}/international/order/${encodeURIComponent(o.ref)}?t=${encodeURIComponent(o.access_token || '')}`, track = `${S.BASE_URL}/international/track`;
  const lines = [`Hello ${esc(eo.ship_name)},`, esc(m[1]), ev.description && ev.stage !== 'order_confirmed' ? `Latest update: ${esc(ev.description)}${ev.location ? ' (' + esc(ev.location) + ')' : ''}` : '',
    ev.stage === 'dispatched' && eo.carrier && eo.tracking_number ? `Carrier: ${esc(eo.carrier)}. Tracking number: <b>${esc(eo.tracking_number)}</b>.` : '', `Order ${esc(o.ref)}. <a href="${link}">View your order</a> or <a href="${track}">track your parcel</a>.`].filter(Boolean);
  const isNew = await add({ event: ev.stage, audience: 'customer', recipient: eo.ship_email, channel: 'email', export_order_id: eo.id, key, subject: `${m[0]} · ${o.ref}`, body: lines.join('\n'), status: on ? 'queued' : 'skipped' });
  if (!isNew || !on) return isNew ? 1 : 0;
  await S.queueMail(eo.ship_email, `${m[0]} · ${o.ref}`, S.mailWrap(await S.getSettings(), `<h3>${esc(m[0])}</h3>` + lines.map((l) => `<p>${l}</p>`).join('')));
  await mark(key, S.mailOn ? 'sent' : 'skipped');
  return 1;
}
async function toAdmin(key, event, subject, body, ids = {}) {
  if (!(await add({ event, audience: 'admin', channel: 'inapp', key, subject, body, ...ids }))) return 0;
  try { await N.toStaff('trade', false, { type: 'trade', title: subject, body, link: '/admin#/trade' }); } catch (e) { console.error('[trade notify]', e.message); }
  const to = await T.setting('notify_admin_email');
  if (to && /^\S+@\S+\.\S+$/.test(to)) { await S.queueMail(to, '[Velto-Mart trade] ' + subject, `<p>${esc(subject)}</p><p>${esc(body)}</p>`); await run('UPDATE trade_notifications SET recipient=? WHERE dedupe_key=?', to, key); }
  await mark(key, 'sent'); return 1;
}

async function sweep() {
  const since = now() - WINDOW; let n = 0;
  const evs = await all(`SELECT ev.*, eo.ref export_ref FROM shipment_tracking_events ev LEFT JOIN export_orders eo ON eo.id=ev.export_order_id WHERE ev.created >= ? ORDER BY ev.id LIMIT 500`, since);
  for (const ev of evs) {
    try {
      if (ev.export_order_id) {
        const eo = await get('SELECT * FROM export_orders WHERE id=?', ev.export_order_id), o = await get('SELECT * FROM orders WHERE id=?', eo.order_id);
        n += await toCustomer(ev, eo, o);
        if (ADMIN[ev.stage]) n += await toAdmin('a:ev:' + ev.id, ev.stage, `${ADMIN[ev.stage]}: ${eo.ref}`, `Order ${eo.ref} to ${eo.destination_country}. ${ev.description || stageText(ev.stage)}${ev.location ? ' (' + ev.location + ')' : ''}`, { export_order_id: eo.id });
      } else if (ev.import_shipment_id && ADMIN[ev.stage]) {
        const sh = await get('SELECT import_ref FROM import_shipments WHERE id=?', ev.import_shipment_id);
        n += await toAdmin('a:ev:' + ev.id, ev.stage, `${ADMIN[ev.stage]}: import ${sh.import_ref}`, ev.description || stageText(ev.stage), { import_shipment_id: ev.import_shipment_id });
      }
    } catch (e) { console.error('[trade notify] event', ev.id, e.message); }
  }
  for (const b of await all("SELECT b.*, eo.ref export_ref, s.import_ref FROM shipping_bookings b LEFT JOIN export_orders eo ON eo.id=b.export_order_id LEFT JOIN import_shipments s ON s.id=b.import_shipment_id WHERE b.status='failed' AND b.updated >= ?", since))
    n += await toAdmin('a:bk:' + b.id, 'booking_failed', `Shipment booking failed: ${b.export_ref || b.import_ref}`, String(b.error || 'The carrier refused the booking.').slice(0, 300), { export_order_id: b.export_order_id, import_shipment_id: b.import_shipment_id });
  for (const w of await all("SELECT * FROM trade_webhook_events WHERE error<>'' AND received >= ?", since))
    n += await toAdmin('a:wh:' + w.provider + ':' + w.event_id, 'api_error', `Carrier update could not be processed (${w.provider})`, String(w.error).slice(0, 300));
  return { created: n };
}

async function list(q = {}) {
  const where = ['1=1'], args = [];
  if (['customer', 'admin'].includes(q.audience)) { where.push('n.audience=?'); args.push(q.audience); }
  if (['queued', 'sent', 'failed', 'skipped'].includes(q.status)) { where.push('n.status=?'); args.push(q.status); }
  const rows = await all(`SELECT n.id, n.event, n.audience, n.recipient, n.channel, n.subject, n.status, n.created, n.sent, eo.ref export_ref, s.import_ref FROM trade_notifications n LEFT JOIN export_orders eo ON eo.id=n.export_order_id LEFT JOIN import_shipments s ON s.id=n.import_shipment_id WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT 200`, ...args);
  return { notifications: rows.map((r) => ({ ...r, id: Number(r.id), created: Number(r.created), sent: r.sent == null ? null : Number(r.sent) })), channels: { email: S.mailOn ? 'connected' : 'not connected (messages are kept but not sent)', sms: 'not connected for international numbers', whatsapp: 'not connected' } };
}
module.exports = { sweep, list, CUSTOMER };
