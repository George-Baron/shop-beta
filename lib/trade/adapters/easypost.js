'use strict';
// EasyPost adapter (multi-carrier). Docs: https://docs.easypost.com
// Credentials come only from the environment: EASYPOST_API_KEY (and EASYPOST_WEBHOOK_SECRET for webhooks). EASYPOST_API_URL is for testing only.
// Nothing here invents data: every value returned comes from EasyPost's response.
const crypto = require('crypto');

const base = () => (process.env.EASYPOST_API_URL || 'https://api.easypost.com/v2').replace(/\/+$/, '');
const configured = () => !!process.env.EASYPOST_API_KEY;
const TIMEOUT_MS = 15000;
class CarrierError extends Error { constructor(msg, o = {}) { super(msg); this.name = 'CarrierError'; this.status = o.status || 502; this.ambiguous = !!o.ambiguous; } }

async function call(method, path, body) {
  if (!configured()) throw new CarrierError('EasyPost is not configured on this server (EASYPOST_API_KEY is missing).', { status: 503 });
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(base() + path, { method, signal: ac.signal, headers: { Authorization: 'Basic ' + Buffer.from(process.env.EASYPOST_API_KEY + ':').toString('base64'), 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { // timeout or network failure: we cannot know whether the carrier acted on the request
    throw new CarrierError('The carrier did not answer in time. Check with the carrier before trying again.', { status: 504, ambiguous: true });
  } finally { clearTimeout(timer); }
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  if (!r.ok) {
    const m = j && j.error && (j.error.message || (typeof j.error === 'string' ? j.error : '')) || `The carrier returned an error (${r.status}).`;
    throw new CarrierError(String(m).slice(0, 300), { status: r.status >= 500 ? 502 : 422, ambiguous: r.status >= 500 });
  }
  return j || {};
}

const OZ_PER_KG = 35.27396195, IN_PER_CM = 0.3937007874;
const oz = (kg) => Math.max(0.1, Math.round(Number(kg) * OZ_PER_KG * 100) / 100);
const inch = (cm) => Math.max(0.1, Math.round(Number(cm) * IN_PER_CM * 100) / 100);
const addr = (a) => ({ name: a.name, company: a.company || undefined, street1: a.line1, street2: a.line2 || undefined, city: a.city, state: a.region || undefined, zip: a.postal_code || undefined, country: a.country, phone: a.phone || undefined, email: a.email || undefined });

// parcel: { weight_kg, length_cm, width_cm, height_cm }, customs: { items:[{description, quantity, weight_kg, value_usd, hs_code, origin_country}], defaults }
function shipmentBody({ from, to, parcel, customs, reference }) {
  const s = { from_address: addr(from), to_address: addr(to), parcel: { weight: oz(parcel.weight_kg), length: inch(parcel.length_cm), width: inch(parcel.width_cm), height: inch(parcel.height_cm) } };
  if (reference) s.reference = String(reference).slice(0, 60);
  if (customs) {
    const d = customs.defaults || {};
    s.customs_info = { customs_certify: d.customs_certify !== false, customs_signer: d.customs_signer || 'Velto-Mart', contents_type: d.contents_type || 'merchandise', restriction_type: d.restriction_type || 'none', non_delivery_option: d.non_delivery_option || 'return',
      customs_items: customs.items.map((i) => ({ description: String(i.description).slice(0, 200), quantity: i.quantity, weight: oz(i.weight_kg), value: Math.round(i.value_usd * 100) / 100, hs_tariff_number: i.hs_code || undefined, origin_country: i.origin_country || undefined })) };
  }
  return { shipment: s };
}
const rateShape = (r) => ({ rate_id: r.id, carrier: r.carrier, service: r.service, amount: Number(r.rate), currency: r.currency, days: r.delivery_days != null ? Number(r.delivery_days) : (r.est_delivery_days != null ? Number(r.est_delivery_days) : null) });

async function rates(args) {
  const j = await call('POST', '/shipments', shipmentBody(args));
  const list = (j.rates || []).map(rateShape).filter((r) => r.rate_id && Number.isFinite(r.amount) && r.amount > 0 && r.currency);
  return { shipment_id: j.id, rates: list, messages: (j.messages || []).map((m) => String(m.message || m.text || '').slice(0, 200)).filter(Boolean) };
}
const bought = (j) => ({ shipment_id: j.id, tracking_code: j.tracking_code || (j.tracker && j.tracker.tracking_code) || '', label_url: (j.postage_label && j.postage_label.label_url) || '', label_format: (j.postage_label && j.postage_label.label_file_type) || '',
  rate: j.selected_rate ? rateShape(j.selected_rate) : null, insurance: j.insurance != null ? Number(j.insurance) : null, refund_status: j.refund_status || '' });
async function getShipment(id) { return bought(await call('GET', '/shipments/' + encodeURIComponent(id))); }
async function buy(shipmentId, rateId, insuranceUsd) {
  const body = { rate: { id: rateId } }; if (insuranceUsd > 0) body.insurance = String(insuranceUsd);
  return bought(await call('POST', `/shipments/${encodeURIComponent(shipmentId)}/buy`, body));
}
async function refund(shipmentId) { return bought(await call('POST', `/shipments/${encodeURIComponent(shipmentId)}/refund`, {})); }
async function ping() { const j = await call('GET', '/carrier_accounts'); const list = Array.isArray(j) ? j : (j.carrier_accounts || []); return { carrier_accounts: list.map((c) => ({ id: c.id, type: c.type, description: String(c.description || c.readable || '').slice(0, 80) })) }; }
async function fetchLabel(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new CarrierError('The label could not be downloaded from the carrier.', { status: 502 });
  const buf = Buffer.from(await r.arrayBuffer()); return { buf, mime: (r.headers.get('content-type') || '').split(';')[0].trim() };
}

// Webhook signature: header x-hmac-signature = "hmac-sha256-hex=" + HMAC-SHA256(NFKD-normalised secret, raw body) as lowercase hex.
function verifyWebhook(rawBody, headers, secret) {
  if (!secret || !rawBody) return false;
  const h = String(headers['x-hmac-signature'] || ''); if (!h.startsWith('hmac-sha256-hex=')) return false;
  const want = 'hmac-sha256-hex=' + crypto.createHmac('sha256', String(secret).normalize('NFKD')).update(rawBody).digest('hex');
  const a = Buffer.from(h.toLowerCase()), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// tracker.updated event -> { id, tracking_code, status, est_delivery, details:[{status, message, at, location}] }
function parseTracker(ev) {
  if (!ev || ev.description !== 'tracker.updated' || !ev.result || ev.result.object !== 'Tracker') return null;
  const t = ev.result;
  return { id: ev.id, tracking_code: String(t.tracking_code || ''), status: String(t.status || ''), est_delivery: t.est_delivery_date ? String(t.est_delivery_date).slice(0, 10) : null,
    details: (t.tracking_details || []).map((d) => ({ status: String(d.status || ''), message: String(d.message || '').slice(0, 300), at: d.datetime ? Math.floor(Date.parse(d.datetime) / 1000) : null, location: d.tracking_location ? [d.tracking_location.city, d.tracking_location.state, d.tracking_location.country].filter(Boolean).join(', ').slice(0, 100) : '' })).filter((d) => d.at) };
}
module.exports = { code: 'easypost', configured, rates, buy, refund, getShipment, ping, fetchLabel, verifyWebhook, parseTracker, CarrierError, shipmentBody, oz, inch };
