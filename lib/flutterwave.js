'use strict';
// Flutterwave, used only for VELTO wallet top-ups (Naira). Off until FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_WEBHOOK_HASH are set.
// The wallet is credited only after we ask Flutterwave ourselves and the reference, currency and amount match (never from the browser or the webhook text).
const crypto = require('crypto');
const { HttpError } = require('./shop');
const base = () => process.env.FLUTTERWAVE_API_URL || 'https://api.flutterwave.com';
const enabled = () => !!process.env.FLUTTERWAVE_SECRET_KEY && !!process.env.FLUTTERWAVE_WEBHOOK_HASH;
const hdr = () => ({ Authorization: 'Bearer ' + process.env.FLUTTERWAVE_SECRET_KEY, 'Content-Type': 'application/json' });

// f: { ref, email, name, naira, redirect }  -> the address of Flutterwave's payment page
async function initialize(f) {
  let res;
  try {
    res = await fetch(base() + '/v3/payments', { method: 'POST', headers: hdr(), signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ tx_ref: f.ref, amount: f.naira, currency: 'NGN', redirect_url: f.redirect, customer: { email: f.email, name: f.name || '' }, customizations: { title: 'VELTO Wallet top-up' }, meta: { purpose: 'wallet_funding' } }) });
  } catch { throw new HttpError(502, 'We could not start the payment. Please try again.'); }
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.status !== 'success' || !d.data || !/^https:\/\//.test(d.data.link || '')) throw new HttpError(502, 'We could not start the payment. Please try again.');
  return d.data.link;
}
// Ask Flutterwave about a reference. Returns { status, reference, currency, amount } with amount in kobo, or null if it could not be reached / does not know it yet.
async function verify(ref) {
  let res;
  try { res = await fetch(base() + '/v3/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(ref), { headers: hdr(), signal: AbortSignal.timeout(15000) }); } catch { return null; }
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.status !== 'success' || !d.data) return null;
  const t = d.data, s = String(t.status || '').toLowerCase();
  return { status: s === 'successful' ? 'success' : s === 'failed' ? 'failed' : 'pending', reference: String(t.tx_ref || ''), currency: String(t.currency || ''), amount: Math.round(Number(t.amount) * 100) };
}
// Flutterwave sends your secret hash in the "verif-hash" header.
function webhookOk(headers) {
  const want = process.env.FLUTTERWAVE_WEBHOOK_HASH || '', got = String((headers && headers['verif-hash']) || '');
  if (!want || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
module.exports = { enabled, initialize, verify, webhookOk };
