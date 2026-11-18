'use strict';
// Administrator and logistics API for riders: /api/admin/rider-ops/...
// Anyone allowed here is back-office staff with the "delivery" permission (see lib/staff.js). Reading a precise position is written to location_access_log.
const express = require('express');
const { get, all, run, now } = require('../lib/db');
const S = require('../lib/shop');
const A = require('../lib/auth');
const R = require('../lib/riders');
const D = require('../lib/dispatch');
const geo = require('../lib/geo');
const CAT = require('../lib/catalog');
const { fail, int, str } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(A.requireBackoffice, require('../lib/staff').gate);
const who = (req) => req.user.name || req.user.email;
const rider = async (req) => { const r = await R.riderById(int(req.params.id)); if (!r) fail(404, 'Rider not found.'); return r; };

/* ---- live map and list ---- */
router.get('/riders', ah(async (req, res) => {
  await R.logAccess(req.user, null, 'live_map', req.clientIp);
  const c = await R.cfg();
  res.json({ riders: await R.roster(req.query), settings: { live_s: c.rider_live_s, stale_s: c.rider_stale_s, mode: c.rider_dispatch_mode }, at: now(), tiles: geo.TILE_URL || '', attribution: geo.TILE_URL ? 'Powered by Geoapify · © OpenStreetMap contributors' : '© OpenStreetMap contributors' });
}));
router.get('/riders/:id', ah(async (req, res) => {
  const r = await rider(req);
  await R.logAccess(req.user, r.id, 'rider_panel', req.clientIp);
  const [row] = (await R.roster()).filter((x) => x.id === Number(r.id));
  const out = { ...row, profile: { ...(await R.me(r.id)).rider, profile_image: r.profile_image, verification_status: r.verification_status, suspended_reason: r.suspended_reason }, performance: await R.performance(r.id) };
  if (row.position && row.assignment && row.assignment.dest) {
    const rt = await geo.route({ lat: row.position.lat, lng: row.position.lng }, row.assignment.dest).catch(() => null);
    if (rt) out.route = { km: rt.km, minutes: rt.minutes, approx: !!rt.approx };   // estimated travel time, "where supported": the fallback is marked approximate
  }
  out.history = await R.history(r.id, { limit: 15 });
  res.json({ rider: out });
}));
router.get('/riders/:id/trail', ah(async (req, res) => {
  const r = await rider(req), hours = Math.min(48, Math.max(1, int(req.query.hours, 2)));
  await R.logAccess(req.user, r.id, 'location_history', req.clientIp);
  const pts = await all('SELECT latitude lat, longitude lng, accuracy, location_timestamp ts, plausible FROM rider_locations WHERE rider_id=? AND created_at>? ORDER BY id DESC LIMIT 400', r.id, now() - hours * 3600);
  res.json({ points: pts.reverse() });
}));
router.get('/riders/:id/history', ah(async (req, res) => res.json({ history: await R.history((await rider(req)).id, { limit: int(req.query.limit, 100) }) })));
router.put('/riders/:id', ah(async (req, res) => { const r = await R.updateProfile(int(req.params.id), req.body || {}, who(req)); res.json({ ok: true, rider: { id: Number(r.id) } }); }));
router.post('/riders/:id/suspend', ah(async (req, res) => { await R.suspend(int(req.params.id), req.body && req.body.reason, who(req)); res.json({ ok: true }); }));
router.post('/riders/:id/reactivate', ah(async (req, res) => { await R.reactivate(int(req.params.id), who(req)); res.json({ ok: true }); }));
router.post('/riders/:id/force-offline', ah(async (req, res) => {
  const r = await rider(req), reason = str(req.body && req.body.reason, 200); if (reason.length < 5) fail(400, 'Write the reason (at least 5 characters).');
  await R.goOffline(r, { force: true, by: who(req), reason }); res.json({ ok: true });
}));
router.post('/riders/:id/feedback', ah(async (req, res) => { await R.addFeedback((await rider(req)).id, req.body || {}, who(req)); res.json({ ok: true }); }));
router.get('/performance', ah(async (req, res) => {
  const rows = await all('SELECT id, code, full_name FROM riders ORDER BY id'), out = [];
  for (const r of rows) out.push({ id: Number(r.id), code: r.code, name: r.full_name, ...(await R.performance(r.id)) });
  res.json({ riders: out });
}));

/* ---- chat ---- */
router.get('/inbox', ah(async (req, res) => res.json({ threads: await R.inbox() })));
router.get('/riders/:id/messages', ah(async (req, res) => { const r = await rider(req); await R.markRead(r.id, 'desk'); res.json({ messages: await R.thread(r.id, { before: int(req.query.before) }), ai_name: R.AI_NAME }); }));
router.post('/riders/:id/messages', A.limiter('desk-msg', 120, 60000), ah(async (req, res) => {
  const r = await rider(req), b = req.body || {};
  const id = await R.post({ riderId: r.id, kind: 'admin', senderId: req.user.id, text: b.text, orderId: b.orderId ? int(b.orderId) : null, attachment: str(b.attachment, 300) });
  res.json({ ok: true, id });
}));
router.post('/upload', A.limiter('desk-up', 30, 60000), express.json({ limit: '4mb' }), ah(async (req, res) => res.json({ url: await CAT.putImage(req.body && req.body.data) })));

/* ---- dispatch ---- */
router.get('/awaiting', ah(async (req, res) => {
  const rows = await all(`SELECT o.id, o.ref, o.status, o.name, o.city, o.state, o.promised_at, o.created, o.is_pharmacy FROM orders o WHERE ${D.readySql} ORDER BY o.promised_at NULLS LAST, o.id LIMIT 100`);
  const offered = await all(`SELECT a.id, a.order_id, a.assignment_status status, a.assignment_timeout_at timeout_at, a.offered_by, r.code, r.full_name, o.ref FROM rider_assignments a JOIN riders r ON r.id=a.rider_id JOIN orders o ON o.id=a.order_id WHERE a.assignment_status='offered' ORDER BY a.id DESC LIMIT 100`);
  res.json({ awaiting: rows.map((o) => ({ ...o, id: Number(o.id) })), offered: offered.map((o) => ({ ...o, id: Number(o.id), order_id: Number(o.order_id), timeout_at: o.timeout_at && Number(o.timeout_at) })) });
}));
router.get('/orders/:id/ranking', ah(async (req, res) => { const r = await D.rank(int(req.params.id)); await R.logOps('ai', 'rank', { orderId: r.order.id, detail: { top: r.ranking.slice(0, 5).map((x) => [x.code, x.score]) } }); res.json(r); }));
router.post('/orders/:id/offer', ah(async (req, res) => {
  const rid = int(req.body && req.body.riderId); if (!rid) fail(400, 'Choose a rider.');
  const rk = (await D.rank(int(req.params.id)).catch(() => null)), pick = rk && rk.ranking.find((x) => x.rider_id === rid);
  res.json({ ok: true, assignment_id: await D.offer(int(req.params.id), rid, { by: 'admin', actor: who(req), actorId: req.user.id, rk: pick || null }) });
}));
router.post('/orders/:id/auto', ah(async (req, res) => res.json(await D.dispatchOrder(int(req.params.id), { force: true }))));
router.post('/assignments/:id/release', ah(async (req, res) => { const b = req.body || {}; res.json(await D.release(int(req.params.id), { custody: b.custody, reason: b.reason, excused: !!b.excused, outcome: b.outcome === 'failed' ? 'failed' : 'reassigned', actor: who(req) })); }));
router.post('/assignments/:id/excuse', ah(async (req, res) => {
  const reason = str(req.body && req.body.reason, 200); if (reason.length < 5) fail(400, 'Write the reason (at least 5 characters).');
  const r = await run('UPDATE rider_assignments SET excused=? WHERE id=?', req.body && req.body.excused === false ? 0 : 1, int(req.params.id));
  if (!r.changes) fail(404, 'Assignment not found.');
  await R.logOps(who(req), 'excuse', { detail: { assignment: int(req.params.id), reason } }); res.json({ ok: true });
}));
router.get('/deliveries/delayed', ah(async (req, res) => {
  const c = await R.cfg();
  res.json({ deliveries: await all(`SELECT o.id, o.ref, o.status, o.promised_at, r.code, r.full_name FROM orders o LEFT JOIN rider_assignments a ON a.order_id=o.id AND a.assignment_status IN ${R.LIVE_ASSIGN} LEFT JOIN riders r ON r.id=a.rider_id
    WHERE o.delivery<>'pickup' AND o.status IN ('paid','confirmed','processing','shipped') AND o.promised_at IS NOT NULL AND o.promised_at<? ORDER BY o.promised_at LIMIT 100`, now() - c.rider_overdue_grace_min * 60) });
}));
// A complete history of one delivery for review: offers and answers, steps with positions, messages and the proof.
router.get('/orders/:ref/history', ah(async (req, res) => {
  const o = await get('SELECT id, ref, status, name, city, state, promised_at, delivered_at FROM orders WHERE ref=?', String(req.params.ref).toUpperCase()); if (!o) fail(404, 'Order not found.');
  res.json({
    order: o,
    assignments: await all('SELECT a.id, a.assignment_status status, a.offered_by, a.assigned_at, a.accepted_at, a.rejected_at, a.arrived_pickup_at, a.pickup_at, a.delivered_at, a.reject_reason, a.closed_reason, a.excused, a.score, a.score_detail, r.code, r.full_name FROM rider_assignments a JOIN riders r ON r.id=a.rider_id WHERE a.order_id=? ORDER BY a.id', o.id),
    steps: await all('SELECT delivery_status status, note, latitude lat, longitude lng, event_timestamp at, rider_id FROM delivery_tracking WHERE order_id=? ORDER BY id', o.id),
    messages: await all("SELECT sender_kind, message, message_type, created_at FROM rider_messages WHERE order_id=? ORDER BY id", o.id),
    ops: await all('SELECT actor, action, detail, created_at FROM rider_ops_log WHERE order_id=? ORDER BY id', o.id),
    proof: await get('SELECT otp_verified, proof_image_url, recipient_confirmation, delivery_timestamp FROM delivery_proofs WHERE order_id=?', o.id) || null,
  });
}));

/* ---- settings, logs ---- */
router.get('/settings', ah(async (req, res) => res.json({ settings: await R.cfg(), defaults: R.DEFAULTS })));
router.put('/settings', ah(async (req, res) => { const s = await R.saveSettings(req.body || {}); await R.logOps(who(req), 'settings_changed', { detail: Object.keys(req.body || {}) }); res.json({ ok: true, settings: s }); }));
router.get('/log', ah(async (req, res) => res.json({ log: await all('SELECT actor, action, order_id, rider_id, detail, created_at FROM rider_ops_log ORDER BY id DESC LIMIT ?', Math.min(300, int(req.query.limit, 100))) })));
router.get('/access-log', A.requireAdmin, ah(async (req, res) => res.json({ log: await all('SELECT viewer_name, rider_id, purpose, ip, created_at FROM location_access_log ORDER BY id DESC LIMIT 300') })));

/* ---- command centre ---- */
router.post('/command', A.limiter('rider-cmd', 60, 60000), ah(async (req, res) => res.json(await require('../lib/rider-agent').handle(req.body && req.body.text, req.user, { orderRef: req.body && req.body.orderRef }))));
router.post('/command/confirm', ah(async (req, res) => res.json(await require('../lib/rider-agent').confirm(req.user, req.body && req.body.id))));

/* ---- live updates ---- */
router.get('/stream', ah(async (req, res) => { await R.logAccess(req.user, null, 'live_map', req.clientIp); await R.subscribe(req, res, { admin: true }); }));

module.exports = router;
