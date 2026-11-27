'use strict';
// Stripe Checkout for international card payments. Off unless STRIPE_ENABLED=1 and STRIPE_SECRET_KEY is set. No SDK: plain HTTPS calls, so nothing new to install.
// Money is only ever marked received after WE ask Stripe for the session and its amount, currency and reference match the order. A webhook is just a nudge to check.
const crypto = require('crypto');

const API = () => process.env.STRIPE_API_URL || 'https://api.stripe.com';
const key = () => process.env.STRIPE_SECRET_KEY || '';
const enabled = () => process.env.STRIPE_ENABLED === '1' && !!key();
// Currencies this Stripe account can charge in (check your Stripe dashboard; Stripe cannot charge Naira here). Set STRIPE_CURRENCIES to change it.
const currencies = () => String(process.env.STRIPE_CURRENCIES || 'USD,GBP,EUR,CAD,AUD,NZD,AED,SAR,INR,JPY,SGD,MYR,BRL,MXN,SEK,CHF,ZAR').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
const supports = (code) => enabled() && currencies().includes(String(code).toUpperCase());

const form = (obj, prefix = '', out = []) => {
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') form(v, name, out); else if (v !== undefined && v !== null) out.push(encodeURIComponent(name) + '=' + encodeURIComponent(String(v)));
  }
  return out;
};
async function call(method, path, body) {
  const res = await fetch(API() + path, {
    method, headers: { Authorization: 'Bearer ' + key(), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': body.__idem } : {}) },
    body: body ? form({ ...body, __idem: undefined }).join('&') : undefined, signal: AbortSignal.timeout(15000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error('Stripe answered ' + res.status + ' ' + String((d.error && d.error.message) || '').slice(0, 200)); e.status = res.status; throw e; }
  return d;
}

// Starts a payment page for the order. The amount is the one fixed at checkout (order.charge_amount), never recalculated.
async function createSession(order, baseUrl) {
  const back = `${baseUrl}/order/${order.ref}?t=${order.access_token}`;
  return call('POST', '/v1/checkout/sessions', {
    __idem: 'shopbeta-' + order.ref, mode: 'payment', client_reference_id: order.ref, customer_email: order.email,
    success_url: back + '&paid=1', cancel_url: back + '&cancelled=1', expires_at: Math.floor(Date.now() / 1000) + 5400,
    line_items: { 0: { quantity: 1, price_data: { currency: String(order.currency).toLowerCase(), unit_amount: Number(order.charge_amount), product_data: { name: 'Order ' + order.ref } } } },
    metadata: { order_ref: order.ref }, payment_intent_data: { metadata: { order_ref: order.ref } },
  });
}
// Sends money back to the card the customer paid with. Stripe's Idempotency-Key makes a retry return the same refund instead of creating a second one.
// `payment` is the PaymentIntent id (pi_...); if we only hold the Checkout session id (cs_...), the PaymentIntent is looked up first.
async function refund({ payment, amount, idem, metadata }) {
  let pi = String(payment || '');
  if (pi.startsWith('cs_')) { const s = await call('GET', '/v1/checkout/sessions/' + encodeURIComponent(pi)); pi = String(s.payment_intent || ''); }
  if (!pi.startsWith('pi_')) { const e = new Error('No Stripe payment on record for this order'); e.status = 400; throw e; }
  return call('POST', '/v1/refunds', { __idem: idem, payment_intent: pi, amount: Math.round(Number(amount)), metadata: metadata || {} });
}
const retrieve = (id) => call('GET', '/v1/checkout/sessions/' + encodeURIComponent(id));

// Stripe-Signature: t=<time>,v1=<hex hmac of "<time>.<raw body>">. Rejects wrong secrets, tampered bodies and old (replayed) messages.
function verifyWebhook(raw, header, secret, { tolerance = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret || !raw || !header) return false;
  const parts = String(header).split(',').map((p) => p.trim().split('='));
  const t = (parts.find((p) => p[0] === 't') || [])[1];
  const sigs = parts.filter((p) => p[0] === 'v1').map((p) => p[1]);
  if (!t || !sigs.length || !/^\d+$/.test(t) || Math.abs(nowSec - Number(t)) > tolerance) return false;
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex'));
  return sigs.some((s) => { const b = Buffer.from(String(s)); return b.length === want.length && crypto.timingSafeEqual(b, want); });
}
const webhookOk = (raw, header) => verifyWebhook(raw, header, process.env.STRIPE_WEBHOOK_SECRET || '');

module.exports = { enabled, supports, currencies, createSession, retrieve, refund, verifyWebhook, webhookOk };
