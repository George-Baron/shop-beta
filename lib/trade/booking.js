'use strict';
// Shipment booking through a connected carrier: staff get real rates for the packed parcel, book one, download the label,
// can cancel (refund) it, and carrier tracking webhooks update the order. A booking is only ever marked "booked" after the
// carrier's own response carries a shipment reference AND a tracking code. A repeated click or retry can never book twice.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const FX = require('./fx');
const CAR = require('./carriers');
const SUP = require('./suppliers');
const storage = require('../storage');
const { fail, str } = S;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const LIVE = ['requested', 'booked', 'cancel_requested'];
const ext = (mime, fmt) => { const m = String(mime || '').toLowerCase(), f = String(fmt || '').toLowerCase(); if (m.includes('pdf') || f === 'pdf') return 'pdf'; if (m.includes('png') || f === 'png') return 'png'; if (m.includes('jpeg') || m.includes('jpg') || f === 'jpg') return 'jpg'; if (m.includes('zpl') || f === 'zpl') return 'zpl'; return 'pdf'; };
const LABEL_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', zpl: 'text/plain' };

async function loadOrder(ref) {
  const eo = await get('SELECT eo.*, o.payment_status FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE eo.ref=? OR o.ref=?', String(ref || ''), String(ref || '')); if (!eo) fail(404, 'International order not found.');
  return eo;
}
function adapterFor(p) { const a = CAR.ADAPTERS[p.adapter]; if (!a) fail(409, 'This carrier cannot be used for booking.'); return a; }
async function pickProvider(code, country) {
  const ready = await CAR.readyProviders(country), p = code ? ready.find((x) => x.code === code) : ready[0];
  if (!p) fail(409, 'No carrier is connected and switched on for this destination. Check Global Trade > Carriers.'); return p;
}
const carrierFail = (e) => { if (e && e.name === 'CarrierError') fail(e.status === 504 ? 504 : e.status === 503 ? 503 : e.status >= 500 ? 502 : 422, e.message); throw e; };
const toUsd = async (amount, cur) => (cur === 'USD' ? amount : amount * (cur === 'NGN' ? 1 : (await FX.rate(cur, 'NGN')).rate) * (await FX.rate('NGN', 'USD')).rate);
const num = (v, label, max) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > max) fail(400, `${label}: enter a number above 0${max ? ' and at most ' + max : ''}.`); return Math.round(n * 1000) / 1000; };
const parcelOf = (p) => { p = p || {}; return { weight_kg: num(p.weight_kg, 'Parcel weight (kg)', 1000), length_cm: num(p.length_cm, 'Parcel length (cm)', 500), width_cm: num(p.width_cm, 'Parcel width (cm)', 500), height_cm: num(p.height_cm, 'Parcel height (cm)', 500) }; };

const bookingShape = (r) => ({ id: Number(r.id), status: r.status, provider: r.provider_code || undefined, carrier: r.carrier, service: r.service_name, shipment_ref: r.provider_ref, tracking_number: r.tracking_number, cost: r.cost == null ? null : Number(r.cost), currency: r.currency,
  insured: !!Number(r.insured), refund_status: r.refund_status, error: r.error, booked_at: r.booked_at == null ? null : Number(r.booked_at), created: Number(r.created), label_document_id: r.label_document_id == null ? null : Number(r.label_document_id) });
async function listBookings(ref) {
  const eo = await loadOrder(ref);
  const rows = await all(`SELECT b.*, p.code provider_code, (SELECT d.id FROM trade_documents d WHERE d.export_order_id=b.export_order_id AND d.doc_type='shipping_label' AND d.data->>'booking_id'=b.id::text ORDER BY d.id DESC LIMIT 1) label_document_id FROM shipping_bookings b JOIN shipping_providers p ON p.id=b.provider_id WHERE b.export_order_id=? ORDER BY b.id DESC`, eo.id);
  return { bookings: rows.map(bookingShape), origin: await CAR.originStatus(), carriers: (await CAR.readyProviders(eo.destination_country)).map((p) => ({ code: p.code, name: p.name })) };
}

/* ---------- 1. real rates for this order's parcel ---------- */
async function getRates(ref, b, user, ip) {
  const eo = await loadOrder(ref);
  if (eo.payment_status !== 'paid') fail(409, 'The order must be paid before a shipment is booked.');
  if (!['confirmed', 'processing', 'packed'].includes(eo.status)) fail(409, `Rates cannot be requested while the order is "${eo.status}".`);
  const p = await pickProvider(b.provider, eo.destination_country), a = adapterFor(p), parcel = parcelOf(b.parcel), st = await T.settings(), origin = await CAR.originStatus();
  if (!origin.complete) fail(409, 'Enter the sender address under Global Trade > Settings first (name, phone, street, city, postal code).');
  const items = await all('SELECT * FROM export_order_items WHERE export_order_id=? ORDER BY id', eo.id), usd = await toUsd(1, eo.currency);
  const customs = { defaults: (p.settings && p.settings.customs_defaults) || {}, items: items.map((i) => ({ description: i.customs_description || i.description, quantity: Number(i.qty), weight_kg: Number(i.weight_kg) || parcel.weight_kg / items.length, value_usd: Number(i.declared_value) / Number(i.qty) * usd, hs_code: i.hs_code, origin_country: i.origin_country })) };
  let res;
  try { res = await a.rates({ from: CAR.fromAddress(st), to: { name: eo.ship_name, line1: eo.address_line1, line2: eo.address_line2, city: eo.city, region: eo.region, postal_code: eo.postal_code, country: eo.destination_country, phone: '+' + eo.phone_dial_code + eo.ship_phone, email: eo.ship_email }, parcel, customs, reference: eo.ref }); } catch (e) { carrierFail(e); }
  const t = now(), ttl = 20 * 60, out = [];
  for (const r of res.rates) {
    if (!(await get('SELECT 1 x FROM trade_currencies WHERE code=?', r.currency))) continue;
    const id = Number((await run("INSERT INTO shipping_rate_quotes (cart_key,cart_hash,user_id,provider_id,service_label,source,provider_quote_ref,origin_country,destination_country,currency,amount,est_days_min,est_days_max,breakdown,expires_at,created) VALUES (?,?,?,?,?,'api',?,?,?,?,?,?,?,?::jsonb,?,?)",
      'ex:' + eo.ref, '', user ? user.id : null, p.id, `${r.carrier} ${r.service}`.slice(0, 120), JSON.stringify({ shipment_id: res.shipment_id, rate_id: r.rate_id }), st.origin_country, eo.destination_country, r.currency, r.amount, r.days, r.days, JSON.stringify({ parcel, carrier: r.carrier, service: r.service }), t + ttl, t)).lastInsertRowid);
    let ngn = null; try { ngn = Math.round(r.amount * (r.currency === 'NGN' ? 1 : (await FX.rate(r.currency, 'NGN')).rate)); } catch { /* no usable rate: show carrier currency only */ }
    out.push({ quote_id: id, carrier: r.carrier, service: r.service, amount: r.amount, currency: r.currency, amount_ngn: ngn, days: r.days });
  }
  out.sort((x, y) => (x.amount_ngn == null) - (y.amount_ngn == null) || (x.amount_ngn || 0) - (y.amount_ngn || 0));
  await T.audit(user, 'booking.rates', 'export_orders', eo.ref, { provider: p.code, rates: out.length }, ip);
  const charged = Number(eo.shipping) ? { customer_paid_shipping_ngn: Number((await get('SELECT delivery_fee FROM orders WHERE id=?', eo.order_id)).delivery_fee) } : {};
  return { provider: p.code, expires_in_minutes: 20, rates: out, messages: res.messages, ...charged, note: 'These are the carrier\'s own prices for the parcel you entered. Your cost is compared with what the customer paid for shipping.' };
}

/* ---------- 2. book ---------- */
async function adoptBooked(booking, eo, bought, user) {
  const rate = bought.rate;
  if (!bought.shipment_id || !bought.tracking_code || !rate || !(rate.amount > 0)) return false;   // not confirmed by the carrier: not booked
  const t = now();
  const r = await run("UPDATE shipping_bookings SET status='booked', tracking_number=?, cost=?, currency=?, insured=?, error='', booked_at=?, updated=? WHERE id=? AND status='requested'", bought.tracking_code, rate.amount, rate.currency, bought.insurance > 0 ? 1 : 0, t, t, booking.id);
  if (r.changes !== 1) return true;
  await run('UPDATE export_orders SET carrier=?, tracking_number=?, updated=? WHERE id=?', `${rate.carrier} ${rate.service}`.slice(0, 60), bought.tracking_code, t, eo.id);
  return true;
}
async function saveLabel(booking, eo, bought, user) {
  if (!bought.label_url) return 'The carrier did not return a label.';
  try {
    const { buf, mime } = await CAR.ADAPTERS.easypost.fetchLabel(bought.label_url), e = ext(mime, bought.label_format), stored = crypto.randomBytes(16).toString('hex') + '.' + e;
    if (!buf.length || buf.length > 8 * 1024 * 1024) return 'The label file was empty or too large.';
    await storage.tradeDocs.put(stored, buf);
    const lr = await run("INSERT INTO shipping_labels (booking_id,kind,format,storage_path,created) VALUES (?,?,?,?,?)", booking.id, 'label', e, 'private:' + stored, now());
    await run("INSERT INTO trade_documents (doc_type,number,export_order_id,origin,file_name,storage_path,stored_name,mime,size_bytes,data,status,created_by,created) VALUES ('shipping_label',?,?,'generated',?,?,?,?,?,?::jsonb,'issued',?,?)",
      bought.tracking_code, eo.id, `label-${eo.ref}.${e}`, 'private:' + stored, stored, LABEL_MIME[e], buf.length, JSON.stringify({ booking_id: String(booking.id), label_id: Number(lr.lastInsertRowid) }), user ? user.id : null, now());
    return '';
  } catch (e) { console.error('[booking] label:', e.message); return 'The shipment is booked but the label could not be downloaded. Use "Refresh" to try again.'; }
}
async function book(ref, b, user, ip) {
  const eo = await loadOrder(ref);
  const key = String(b.idempotency_key || ''); if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) fail(400, 'A booking key is required (16 to 64 letters or digits).');
  const prev = await get('SELECT b.*, p.code provider_code, p.adapter FROM shipping_bookings b JOIN shipping_providers p ON p.id=b.provider_id WHERE b.idempotency_key=?', key);
  if (prev) {
    if (Number(prev.export_order_id) !== Number(eo.id)) fail(409, 'That booking key belongs to a different order.');
    if (prev.status === 'booked' || prev.status === 'cancel_requested' || prev.status === 'cancelled') return { booking: bookingShape(prev), replayed: true };
    if (prev.status === 'failed') fail(409, 'The previous attempt failed: ' + (prev.error || 'unknown error') + ' Start a new booking.');
    // 'requested': the answer never reached us. Ask the carrier what happened instead of buying again.
    const a = CAR.ADAPTERS[prev.adapter]; let sh; try { sh = await a.getShipment(prev.provider_ref); } catch (e) { carrierFail(e); }
    if (await adoptBooked(prev, eo, sh, user)) { const lerr = await saveLabel(prev, eo, sh, user); await T.audit(user, 'booking.reconciled', 'export_orders', eo.ref, { booking: Number(prev.id) }, ip); return { booking: bookingShape(await get('SELECT b.*, p.code provider_code FROM shipping_bookings b JOIN shipping_providers p ON p.id=b.provider_id WHERE b.id=?', prev.id)), replayed: true, label_error: lerr }; }
    return finishBuy(prev, eo, a, b, user, ip);
  }
  if (eo.payment_status !== 'paid') fail(409, 'The order must be paid before a shipment is booked.');
  if (eo.status !== 'packed') fail(409, 'Pack the order (all items) before booking a shipment.');
  const qr = await get("SELECT * FROM shipping_rate_quotes WHERE id=? AND cart_key=? AND source='api'", Number(b.quote_id) || 0, 'ex:' + eo.ref); if (!qr) fail(404, 'That rate was not found for this order. Get the rates again.');
  if (Number(qr.expires_at) < now()) fail(409, 'These rates have expired. Get the rates again.');
  const p = await get('SELECT * FROM shipping_providers WHERE id=?', qr.provider_id); if (!p || CAR.statusOf(p) !== 'ready') fail(409, 'That carrier is not available right now.');
  const ref0 = JSON.parse(qr.provider_quote_ref || '{}'); if (!ref0.shipment_id || !ref0.rate_id) fail(409, 'That rate cannot be booked. Get the rates again.');
  let id;
  try {
    const r = await run("INSERT INTO shipping_bookings (export_order_id,provider_id,idempotency_key,status,provider_ref,carrier,service_name,quote_id,request_summary,created_by,created,updated) VALUES (?,?,?,'requested',?,?,?,?,?::jsonb,?,?,?)",
      eo.id, p.id, key, ref0.shipment_id, (qr.breakdown && qr.breakdown.carrier) || '', (qr.breakdown && qr.breakdown.service) || '', qr.id, JSON.stringify({ rate_id: ref0.rate_id, parcel: qr.breakdown && qr.breakdown.parcel, quoted: Number(qr.amount), currency: qr.currency }), user ? user.id : null, now(), now());
    id = Number(r.lastInsertRowid);
  } catch (e) { if (e.code === '23505') { if (/idempotency/.test(String(e.constraint || e.message))) return book(ref, b, user, ip); fail(409, 'This order already has a shipment booking.'); } throw e; }
  const booking = await get('SELECT * FROM shipping_bookings WHERE id=?', id);
  return finishBuy({ ...booking, adapter: p.adapter }, eo, CAR.ADAPTERS[p.adapter], { ...b, _rate_id: ref0.rate_id }, user, ip);
}
async function finishBuy(booking, eo, a, b, user, ip) {
  const summary = booking.request_summary || {}, rateId = b._rate_id || summary.rate_id;
  let ins = 0;
  if (b.insure === true || b.insure === 'true') { const items = await all('SELECT declared_value, qty FROM export_order_items WHERE export_order_id=?', eo.id); ins = Math.round((await toUsd(items.reduce((x, i) => x + Number(i.declared_value), 0), eo.currency)) * 100) / 100; }
  let bought;
  try { bought = await a.buy(booking.provider_ref, rateId, ins); }
  catch (e) {
    if (e && e.name === 'CarrierError' && !e.ambiguous) { await run("UPDATE shipping_bookings SET status='failed', error=?, updated=? WHERE id=? AND status='requested'", e.message.slice(0, 300), now(), booking.id); await T.audit(user, 'booking.failed', 'export_orders', eo.ref, { error: e.message }, ip); }
    else if (e && e.name === 'CarrierError') await run("UPDATE shipping_bookings SET error=?, updated=? WHERE id=?", 'No confirmation received from the carrier. Press "Refresh" or book again with the same key to check.', now(), booking.id);
    carrierFail(e);
  }
  if (!(await adoptBooked(booking, eo, bought, user))) { await run("UPDATE shipping_bookings SET error=?, updated=? WHERE id=?", 'The carrier answered without a tracking code, so the booking is not confirmed. Press "Refresh" to check.', now(), booking.id); fail(502, 'The carrier did not confirm the booking (no tracking code). It is NOT marked as booked. Press "Refresh" to check again.'); }
  const lerr = await saveLabel(booking, eo, bought, user); if (lerr) await run('UPDATE shipping_bookings SET error=? WHERE id=?', lerr, booking.id);
  await T.audit(user, 'booking.booked', 'export_orders', eo.ref, { booking: Number(booking.id), tracking: bought.tracking_code, cost: bought.rate.amount, currency: bought.rate.currency }, ip);
  return { booking: bookingShape(await get('SELECT b.*, p.code provider_code FROM shipping_bookings b JOIN shipping_providers p ON p.id=b.provider_id WHERE b.id=?', booking.id)), label_error: lerr };
}

/* ---------- 3. cancel (carrier refund) and refresh ---------- */
async function loadBooking(id) { const r = await get('SELECT b.*, p.code provider_code, p.adapter FROM shipping_bookings b JOIN shipping_providers p ON p.id=b.provider_id WHERE b.id=?', Number(id) || 0); if (!r) fail(404, 'Booking not found.'); return r; }
const fresh = async (id) => bookingShape(await get('SELECT b.*, p.code provider_code FROM shipping_bookings b JOIN shipping_providers p ON p.id=b.provider_id WHERE b.id=?', id));
async function cancel(id, user, ip) {
  const bk = await loadBooking(id); if (bk.status !== 'booked') fail(409, bk.status === 'cancel_requested' ? 'A cancellation was already requested. Press "Refresh" to see if the carrier confirmed it.' : 'Only a booked shipment can be cancelled.');
  const eo = await get('SELECT * FROM export_orders WHERE id=?', bk.export_order_id);
  if (['dispatched', 'in_transit', 'customs', 'out_for_delivery', 'delivered', 'returned'].includes(eo.status)) fail(409, 'The parcel has already been dispatched, so the label cannot be cancelled.');
  let sh; try { sh = await CAR.ADAPTERS[bk.adapter].refund(bk.provider_ref); } catch (e) { carrierFail(e); }
  const rs = String(sh.refund_status || 'submitted'), done = rs === 'refunded';
  await run('UPDATE shipping_bookings SET status=?, refund_status=?, updated=? WHERE id=?', done ? 'cancelled' : 'cancel_requested', rs, now(), bk.id);
  if (done) await run("UPDATE export_orders SET carrier='', tracking_number='', updated=? WHERE id=?", now(), eo.id);
  await T.audit(user, 'booking.cancel', 'export_orders', eo.ref, { booking: Number(bk.id), refund_status: rs }, ip);
  return { booking: await fresh(bk.id) };
}
async function refresh(id, user, ip) {
  const bk = await loadBooking(id), eo = await get('SELECT * FROM export_orders WHERE id=?', bk.export_order_id);
  let sh; try { sh = await CAR.ADAPTERS[bk.adapter].getShipment(bk.provider_ref); } catch (e) { carrierFail(e); }
  let lerr = '';
  if (bk.status === 'requested') { if (await adoptBooked(bk, eo, sh, user)) lerr = await saveLabel(bk, eo, sh, user); }
  else if (bk.status === 'booked' && !(await get("SELECT 1 x FROM trade_documents WHERE export_order_id=? AND doc_type='shipping_label' AND data->>'booking_id'=?", eo.id, String(bk.id)))) lerr = await saveLabel(bk, eo, sh, user);
  if (bk.status === 'cancel_requested' || sh.refund_status) {
    const rs = String(sh.refund_status || bk.refund_status);
    await run('UPDATE shipping_bookings SET refund_status=?, status=CASE WHEN ?=\'refunded\' AND status=\'cancel_requested\' THEN \'cancelled\' ELSE status END, updated=? WHERE id=?', rs, rs, now(), bk.id);
    if (rs === 'refunded' && bk.status === 'cancel_requested') await run("UPDATE export_orders SET carrier='', tracking_number='', updated=? WHERE id=?", now(), eo.id);
  }
  if (lerr) await run('UPDATE shipping_bookings SET error=? WHERE id=?', lerr, bk.id); else if (bk.status !== 'failed') await run("UPDATE shipping_bookings SET error='' WHERE id=? AND status IN ('booked','cancelled')", bk.id);
  await T.audit(user, 'booking.refresh', 'export_orders', eo.ref, { booking: Number(bk.id) }, ip);
  return { booking: await fresh(bk.id), label_error: lerr };
}

/* ---------- 4. tracking webhooks (signed; repeats are ignored) ---------- */
const STAGE = { in_transit: 'in_transit', out_for_delivery: 'out_for_delivery', available_for_pickup: 'out_for_delivery', delivered: 'delivered', return_to_sender: 'exception', failure: 'exception', error: 'exception' };
async function handleWebhook(provider, rawBody, headers, body) {
  if (provider !== 'easypost') fail(404, 'Unknown provider.');
  const EP = CAR.ADAPTERS.easypost, secret = process.env.EASYPOST_WEBHOOK_SECRET;
  if (!secret) fail(503, 'Webhooks are not configured on this server.');          // never accept unsigned events
  if (!EP.verifyWebhook(rawBody, headers, secret)) fail(401, 'Bad signature.');
  const ev = body || {}, id = String(ev.id || '').slice(0, 80); if (!id) fail(400, 'Missing event id.');
  const ins = await run('INSERT INTO trade_webhook_events (provider,event_id,kind,received) VALUES (?,?,?,?) ON CONFLICT (provider, event_id) DO NOTHING', provider, id, String(ev.description || '').slice(0, 60), now());
  if (ins.changes === 0) return { ok: true, duplicate: true };
  const tr = EP.parseTracker(ev); let status = 'ignored', note = '';
  if (tr && tr.tracking_code) {
    const bk = await get("SELECT * FROM shipping_bookings WHERE tracking_number=? AND status IN ('booked','cancel_requested') AND export_order_id IS NOT NULL", tr.tracking_code);
    if (!bk) { status = 'unmatched'; note = 'No booking with this tracking number.'; }
    else {
      const eo = await get('SELECT * FROM export_orders WHERE id=?', bk.export_order_id);
      for (const d of tr.details) {
        const stage = STAGE[d.status]; if (!stage) continue;
        await run("INSERT INTO shipment_tracking_events (export_order_id,booking_id,stage,description,location,occurred_at,source,event_hash,created) VALUES (?,?,?,?,?,?,'webhook',?,?) ON CONFLICT (event_hash) DO NOTHING", eo.id, bk.id, stage, d.message, d.location, d.at, sha(`easypost:${bk.id}:${d.at}:${d.status}:${d.message}`), now());
      }
      if (tr.est_delivery) await run('UPDATE export_orders SET eta=?::date, updated=? WHERE id=?', tr.est_delivery, now(), eo.id);
      const target = { in_transit: 'in_transit', out_for_delivery: 'out_for_delivery', available_for_pickup: 'out_for_delivery', delivered: 'delivered' }[tr.status];
      if (target) await advance(eo.ref, target);
      status = 'processed';
    }
  }
  await run('UPDATE trade_webhook_events SET processed=?, error=? WHERE provider=? AND event_id=?', status === 'processed' ? 1 : 0, note, provider, id);
  return { ok: true, status };
}
// Moves the order forward through the normal staff path, one allowed step at a time. Never backwards, never past what the rules allow.
async function advance(ref, target) {
  const EX = require('./export'), flow = EX.FLOW;
  for (let guard = 0; guard < 8; guard++) {
    const cur = (await get('SELECT status FROM export_orders WHERE ref=?', ref)).status, ci = flow.indexOf(cur), ti = flow.indexOf(target);
    if (ci < 0 || ci >= ti || ci < flow.indexOf('dispatched')) return;     // only after staff dispatched it
    try { await EX.setStatus(ref, { status: flow[ci + 1], note: 'Updated from carrier tracking.' }, null, ''); } catch (e) { console.error('[booking] advance:', e.message); return; }
  }
}

async function fetchLabel(docId) { return SUP.fetchDocument(docId); }
module.exports = { listBookings, getRates, book, cancel, refresh, handleWebhook, fetchLabel };
