'use strict';
// VELTO WALLET API. Mounted at /api/wallet and /api/mobile/v1/wallet (same handlers for the website and the apps).
// Customers only ever see their own wallet: the owner is always req.user, never an id from the request.
const express = require('express');
const A = require('../lib/auth');
const ST = require('../lib/staff');
const W = require('../lib/wallet');
const S = require('../lib/shop');
const { get, all, run } = require('../lib/db');
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const customer = express.Router();
customer.use(A.requireUser);
customer.get('/', ah(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await W.overview(req.user)); }));
customer.get('/transactions', ah(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await W.history(req.user, req.query)); }));
customer.get('/statement.pdf', ah(async (req, res) => { const m = String(req.query.month || ''); const pdf = await W.statementPdf(req.user, m); res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="velto-wallet-${m}.pdf"`, 'Cache-Control': 'no-store' }).send(pdf); }));
customer.get('/statement.csv', ah(async (req, res) => { res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="velto-wallet-statement.csv"', 'Cache-Control': 'no-store' }); res.send(await W.statement(req.user, req.query)); }));
// Shows what the wallet would cover before the customer confirms. Display only; nothing is held or charged.
customer.post('/preview', A.limiter('wallet-preview', 60, 600000), ah(async (req, res) => res.json(await W.preview(req.user, req.body || {}))));
customer.get('/preferences', ah(async (req, res) => res.json(await require('../lib/prefs').read(req.user))));
customer.put('/preferences', ah(async (req, res) => res.json(await require('../lib/prefs').write(req.user, req.body))));
customer.post('/fund', A.limiter('wallet-fund', 10, 3600000), ah(async (req, res) => res.json(await W.initFunding(req.user, req.body))));
// The customer coming back from the payment page. We still ask the gateway; the browser's word is never enough.
customer.get('/fund/:ref', A.limiter('wallet-verify', 40, 600000), ah(async (req, res) => {
  const ref = S.str(req.params.ref, 20).toUpperCase();
  const f = await get('SELECT user_id FROM wallet_funding WHERE ref=?', ref);
  if (!f || Number(f.user_id) !== Number(req.user.id)) S.fail(404, 'Not found.');
  const r = await W.settleFunding(ref);
  res.json({ ref, status: r.status });
}));

const admin = express.Router();
admin.use(A.requireBackoffice);
// Switches and limits (administrators). Switching the wallet off stops new top-ups only; customers can still spend what they already hold.
const SETTINGS = ['wallet_enabled', 'wallet_min_fund', 'wallet_max_fund', 'wallet_max_balance', 'card_enabled'];
admin.get('/settings', ST.walletGate('view'), ah(async (req, res) => { const rows = await all('SELECT key, value FROM settings WHERE key = ANY(?)', SETTINGS); const m = Object.fromEntries(rows.map((r) => [r.key, r.value])); res.json({ wallet_enabled: m.wallet_enabled !== '0', wallet_min_fund: Number(m.wallet_min_fund || 100), wallet_max_fund: Number(m.wallet_max_fund || 1000000), wallet_max_balance: Number(m.wallet_max_balance || 5000000), card_enabled: m.card_enabled === '1', card_provider_ready: !!require('../lib/cards').provider() }); }));
admin.put('/settings', ST.walletGate('owner'), ah(async (req, res) => {
  const b = req.body || {}, put = (k, v) => run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value', k, String(v));
  const num = (v, name) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) S.fail(400, name + ' must be a whole number of Naira, 1 or more.'); return n; };
  if (b.wallet_enabled !== undefined) await put('wallet_enabled', b.wallet_enabled ? 1 : 0);
  if (b.wallet_min_fund !== undefined) await put('wallet_min_fund', num(b.wallet_min_fund, 'The smallest top-up'));
  if (b.wallet_max_fund !== undefined) await put('wallet_max_fund', num(b.wallet_max_fund, 'The largest top-up'));
  if (b.wallet_max_balance !== undefined) await put('wallet_max_balance', num(b.wallet_max_balance, 'The largest wallet balance'));
  if (b.card_enabled !== undefined) { if (b.card_enabled && !require('../lib/cards').provider()) S.fail(400, 'No card issuer is connected yet, so the card cannot be switched on.'); await put('card_enabled', b.card_enabled ? 1 : 0); }
  const cache = require('../lib/cache'); cache.clear(); await cache.bump().catch(() => {}); // settings are cached for a few seconds; the switch must take effect at once on every instance
  await W.audit(0, req.user, 'settings', JSON.stringify(b).slice(0, 200)).catch(() => {});
  res.json({ ok: true });
}));
admin.get('/reconcile', ST.walletGate('view'), ah(async (req, res) => res.json(await W.reconcile())));
admin.get('/customers/:id', ST.walletGate('view'), ah(async (req, res) => {
  const id = S.int(req.params.id), u = await get('SELECT id,name,email FROM users WHERE id=?', id); if (!u) S.fail(404, 'Not found.');
  res.json({ customer: u, wallet: await W.overview(u), transactions: (await W.history(u, req.query)).transactions, audit: await all('SELECT action,actor_name,detail,created FROM wallet_audit WHERE user_id=? ORDER BY id DESC LIMIT 50', id) });
}));
admin.post('/customers/:id/freeze', ST.walletGate('edit'), ah(async (req, res) => { await W.setFrozen(S.int(req.params.id), true, req.body && req.body.reason, req.user); res.json({ ok: true }); }));
admin.post('/customers/:id/unfreeze', ST.walletGate('edit'), ah(async (req, res) => { await W.setFrozen(S.int(req.params.id), false, '', req.user); res.json({ ok: true }); }));
admin.post('/customers/:id/adjust', ST.walletGate('owner'), ah(async (req, res) => res.json(await W.adjust(S.int(req.params.id), req.body || {}, req.user))));

// Financial reports (administrators). ?from=&to= are epoch seconds.
const F = require('../lib/finance');
admin.get('/funding', ST.walletGate('view'), ah(async (req, res) => res.json({ funding: await F.fundingList(req.query) })));
admin.get('/suspicious', ST.walletGate('view'), ah(async (req, res) => res.json(await F.suspicious())));
const reports = express.Router();
reports.use(A.requireBackoffice);
reports.get('/summary', ST.walletGate('view', ['finance']), ah(async (req, res) => res.json(await F.summary(req.query))));
reports.get('/wallet', ST.walletGate('view', ['finance']), ah(async (req, res) => res.json(await F.wallet(req.query))));
reports.get('/sales', ST.walletGate('view', ['finance']), ah(async (req, res) => res.json(await F.sales(req.query))));
reports.get('/rewards', ST.walletGate('view', ['finance']), ah(async (req, res) => res.json(await F.loyalty(req.query))));
reports.get('/gateways', ST.walletGate('view', ['finance']), ah(async (req, res) => res.json(await F.gateways(req.query))));
reports.get('/wallet-transactions.csv', ST.walletGate('view', ['finance']), ah(async (req, res) => { res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="wallet-transactions.csv"' }); res.send(await F.walletCsv(req.query)); }));

module.exports = { customer, admin, reports };
