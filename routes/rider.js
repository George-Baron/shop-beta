'use strict';
// Rider screen API. Riders only ever see orders assigned to them, and the customer's location only while the order is active.
// The handover code is never returned here: the customer reads it out, the rider types it in.
const A = require('../lib/auth');
const D = require('../lib/delivery');
const S = require('../lib/shop');
const { fail, str, int } = S;

const router = require('../lib/async-router').Router();
router.use(A.requireRider);
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
// Wrong-code guessing is stopped by the 5-attempt lock; this just keeps a script from hammering the endpoint.
const codeLimit = A.limitBy('handover', { ids: (req) => [req.user.id], max: 30, windowMs: 600000, ipMax: 600 });
const pingLimit = A.limitBy('ping', { ids: (req) => [req.user.id], max: 120, windowMs: 600000, ipMax: 2000 });

router.get('/orders', async (req, res) => res.json({ orders: await D.riderOrders(req.user.id), rider: { name: req.user.name } }));
router.get('/orders/:ref', async (req, res) => res.json({ order: await D.riderDetail(req.params.ref, req.user.id) }));
router.post('/orders/:ref/accept', async (req, res) => { await D.accept(req.params.ref, req.user.id); res.json({ ok: true }); });
router.post('/orders/:ref/pickup/:leg', async (req, res) => res.json({ ok: true, ...(await D.pickup(req.params.ref, req.user.id, int(req.params.leg))) }));
router.post('/orders/:ref/start', async (req, res) => { await D.start(req.params.ref, req.user.id); res.json({ ok: true }); });
router.post('/orders/:ref/location', pingLimit, async (req, res) => res.json({ ok: true, ...(await D.ping(req.params.ref, req.user.id, num(req.body.lat), num(req.body.lng))) }));
router.post('/orders/:ref/deliver', codeLimit, async (req, res) => {
  const b = req.body || {};
  const code = str(b.code, 10);
  if (!/^\d{6}$/.test(code)) fail(400, 'Enter the 6-digit code the customer reads out.');
  res.json({ ok: true, ...(await D.deliver(req.params.ref, req.user.id, code, { lat: num(b.lat), lng: num(b.lng) })) });
});

module.exports = router;
