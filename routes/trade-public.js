'use strict';
// Public Global Trade API for the storefront: which countries and currencies we trade in, converted prices, and products that may be shipped to a country.
// Nothing here is private: no costs, no supplier data, no restrictions notes.
const express = require('express');
const { all } = require('../lib/db');
const A = require('../lib/auth');
const FX = require('../lib/trade/fx');
const EX = require('../lib/trade/export');
const { run } = require('../lib/db');
const P = require('../lib/trade/products');
const S = require('../lib/shop');
const { fail } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(A.limiter('trade-public', 240, 60000));

router.get('/countries', ah(async (req, res) => {
  const rows = await all("SELECT code, name, dial_code, currency_code, region, tax_id_required, tax_id_label, postal_required, postal_regex, vat_label FROM trade_countries WHERE export_to=1 AND active=1 ORDER BY name");
  res.set('Cache-Control', 'public, max-age=60').json({ countries: rows.map((c) => ({ code: c.code, name: c.name, dial_code: c.dial_code, currency: c.currency_code || '', region: c.region, tax_id_required: !!Number(c.tax_id_required), tax_id_label: c.tax_id_label, postal_required: !!Number(c.postal_required), postal_regex: c.postal_regex, vat_label: c.vat_label })) });
}));
router.get('/currencies', ah(async (req, res) => {
  const rows = await all('SELECT code, name, symbol, decimals, is_base FROM trade_currencies WHERE active=1 ORDER BY is_base DESC, sort, code');
  res.set('Cache-Control', 'public, max-age=60').json({ currencies: rows.map((c) => ({ code: c.code, name: c.name, symbol: c.symbol, decimals: Number(c.decimals), base: !!Number(c.is_base) })) });
}));
router.get('/products', ah(async (req, res) => res.json(await P.publicList(req.query))));
// Convert one amount for display. Says where the rate came from. 503 when there is no usable rate.
router.get('/convert', ah(async (req, res) => {
  const amount = Number(req.query.amount), from = String(req.query.from || 'NGN').toUpperCase(), to = String(req.query.to || 'NGN').toUpperCase();
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) fail(400, 'Enter a valid amount.');
  if ((await all('SELECT code FROM trade_currencies WHERE active=1 AND code = ANY(?::text[])', [from, to])).length < (from === to ? 1 : 2)) fail(400, 'That currency is not available.');
  const c = await FX.convert(amount, from, to);
  res.json({ amount: c.amount, from, to, rate: c.rate, rate_source: c.source, rate_time: c.fetched_at, rate_stale: c.stale });
}));
router.get('/can-ship', ah(async (req, res) => {
  const id = Number(req.query.product), country = String(req.query.country || '');
  if (!Number.isInteger(id) || id < 1) fail(400, 'Choose a product.');
  res.json(await P.offerable(id, country));
}));

// Shipping options for a cart and destination. Every price is a manual estimate configured by staff and says so. No option means we cannot ship that parcel there yet.
// Carrier tracking webhook. Signature is checked against the raw body; no sign-in (the carrier calls it).
router.post('/webhooks/:provider', ah(async (req, res) => res.json(await require('../lib/trade/booking').handleWebhook(req.params.provider, req.rawBody || Buffer.from(''), req.headers, req.body))));
router.post('/quote', A.limiter('trade-quote', 60, 60000), ah(async (req, res) => res.json(await EX.quote(req.body || {}, req.user))));
// Place the order and start payment. Same safety as the normal checkout: an Idempotency-Key makes a double click or retry return the same order.
router.post('/checkout', A.limiter('trade-checkout', 20, 3600000), ah(async (req, res) => {
  const key = req.get('Idempotency-Key') || (req.body && req.body.idempotencyKey) || '';
  const order = await EX.checkout(req.body || {}, req.user, key);
  const done = { ref: order.ref, token: order.access_token, total_ngn: order.total };
  if (order.replayed) {
    if (order.status === 'cancelled') fail(409, 'That order was cancelled. Please place a new order.');
    if (order.payment_status === 'paid') return res.json({ ...done, next: 'paid', replayed: true });
    if (!S.paystackLive()) return res.json({ ...done, next: 'demo', replayed: true });
    if (!order.pay_url) { order.pay_url = await S.paystackInitialize(order); await run('UPDATE orders SET pay_url=? WHERE id=?', order.pay_url, order.id); }
    return res.json({ ...done, next: 'paystack', url: order.pay_url, replayed: true });
  }
  S.mailOrderPlaced(order);
  if (!S.paystackLive()) return res.json({ ...done, next: 'demo' });
  try { const url = await S.paystackInitialize(order); await run('UPDATE orders SET pay_url=? WHERE id=?', url, order.id); return res.json({ ...done, next: 'paystack', url }); }
  catch (err) { await S.cancelOrder(order, 'Payment could not be started'); throw err; }
}));
// The customer's own international order and its shipment timeline (secret link token, or the signed-in owner).
router.get('/orders/:ref', A.limiter('trade-order', 60, 60000), ah(async (req, res) => res.json(await EX.customerOrder(req.params.ref, String(req.query.t || ''), req.user))));

module.exports = router;
