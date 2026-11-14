'use strict';
// Admin: wholesale. Mounted inside routes/admin.js (admin sign-in, audit log and cache clearing already apply).
const express = require('express');
const W = require('../lib/wholesale');

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const by = (req) => String(req.user.name || req.user.email).slice(0, 80);

router.get('/accounts', ah(async (req, res) => res.json({ accounts: await W.adminAccounts(['pending', 'approved', 'rejected', 'suspended'].includes(req.query.status) ? req.query.status : '') })));
router.post('/accounts/:id/:action', ah(async (req, res) => { await W.decideAccount(req.params.id, req.params.action, req.body || {}, by(req)); res.json({ ok: true }); }));

router.get('/quotes', ah(async (req, res) => res.json({ quotes: await W.adminQuotes(req.query.status) })));
router.get('/quotes/:ref', ah(async (req, res) => res.json({ quote: await W.adminQuote(req.params.ref) })));
router.post('/quotes/:ref/send', ah(async (req, res) => { await W.sendQuote(req.params.ref, req.body || {}, by(req)); res.json({ ok: true }); }));
router.post('/quotes/:ref/transfer', ah(async (req, res) => { await W.markTransferReceived(req.params.ref, req.body && req.body.reference, by(req)); res.json({ ok: true }); }));
router.post('/quotes/:ref/ship', ah(async (req, res) => { await W.ship(req.params.ref, req.body || {}, by(req)); res.json({ ok: true }); }));
router.post('/quotes/:ref/deliver', ah(async (req, res) => { await W.deliver(req.params.ref, by(req)); res.json({ ok: true }); }));
router.post('/quotes/:ref/cancel', ah(async (req, res) => { await W.adminCancel(req.params.ref, String((req.body && req.body.reason) || '').slice(0, 300), by(req)); res.json({ ok: true }); }));

router.get('/products', ah(async (req, res) => res.json({ products: await W.adminProducts(req.query) })));
router.put('/products/:id', ah(async (req, res) => { await W.setProductPrice(req.params.id, req.body || {}); res.json({ ok: true }); }));

router.get('/settings', ah(async (req, res) => { const s = await require('../lib/shop').getSettings(); res.json({ defaults: await W.cfg(), settings: Object.fromEntries(W.SETTING_KEYS.map((k) => [k, s[k] || ''])) }); }));
router.put('/settings', ah(async (req, res) => { await W.saveSettings(req.body || {}); res.json({ ok: true }); }));

module.exports = router;
