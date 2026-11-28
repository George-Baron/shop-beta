'use strict';
// International payments: provider status, payment list, refunds (full and partial) and reconciliation.
// Customers are charged in NGN through Paystack at the exchange rate fixed when they ordered. A refund is only recorded as done after Paystack
// itself says "processed" (checked server-side by webhook or by asking Paystack). Nothing here moves money by itself.
const { get, all, run, tx, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const FX = require('./fx');
const { fail, str } = S;

const PS_URL = () => process.env.PAYSTACK_API_URL || 'https://api.paystack.co';
const PS_KEY = () => process.env.PAYSTACK_SECRET_KEY || '';
const live = () => !!PS_KEY();
const kobo = (n) => Math.round(Number(n) * 100);
class ProviderError extends Error { constructor(m, status, ambiguous) { super(m); this.name = 'ProviderError'; this.status = status; this.ambiguous = !!ambiguous; } }
async function ps(method, path, body) {
  let res;
  try { res = await fetch(PS_URL() + path, { method, headers: { Authorization: 'Bearer ' + PS_KEY(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
  catch { throw new ProviderError('Paystack did not answer.', 504, true); }
  const d = await res.json().catch(() => ({}));
  if (res.status >= 500) throw new ProviderError('Paystack had a problem (' + res.status + ').', 502, true);
  if (!res.ok || d.status === false) throw new ProviderError(String(d.message || 'Paystack refused the request.').slice(0, 200), res.status, false);
  return d.data;
}
const shape = (r) => ({ id: Number(r.id), kind: r.kind, status: r.status, provider: r.provider, provider_ref: r.provider_ref, provider_status: r.provider_status, order_ref: r.order_ref, export_ref: r.export_ref, amount: Number(r.amount), currency: r.currency, fee: Number(r.fee), amount_ngn: r.amount_ngn == null ? null : Number(r.amount_ngn), verified: !!Number(r.verified),
  reason: r.reason, parent_id: r.parent_id == null ? null : Number(r.parent_id), refunded: r.refunded == null ? undefined : Number(r.refunded), refundable: r.refundable == null ? undefined : Number(r.refundable), created: Number(r.created) });

function providers() {
  const set = live();
  return { providers: [
    { code: 'paystack', name: 'Paystack', status: set ? 'ready' : 'awaiting_configuration', status_label: set ? 'Ready' : 'Awaiting configuration (demo mode only)', env: [{ name: 'PAYSTACK_SECRET_KEY', required: true, set }],
      capabilities: { cards: 'International cards depend on your Paystack account settings', refunds: true, partial_refunds: true, webhooks: true }, webhook_path: '/api/paystack/webhook',
      note: 'Customers are charged in naira (NGN) at the rate fixed when they ordered. Their bank may show a different amount in their own currency. Refunds are sent through Paystack and shown as done only when Paystack confirms.' },
    { code: 'flutterwave', name: 'Flutterwave', status: 'not_integrated', status_label: 'Not integrated', env: [], capabilities: {}, note: 'Not built into this store.' },
    { code: 'stripe', name: 'Stripe', status: 'not_integrated', status_label: 'Not integrated', env: [], capabilities: {}, note: 'Not built into this store. Needs a Stripe account that supports your business country.' },
  ] };
}

const SEL = `SELECT p.*, o.ref order_ref, eo.ref export_ref,
  (SELECT COALESCE(SUM(c.amount),0) FROM international_payments c WHERE c.parent_id=p.id AND c.kind='refund' AND c.status='succeeded') refunded,
  p.amount - (SELECT COALESCE(SUM(c.amount),0) FROM international_payments c WHERE c.parent_id=p.id AND c.kind='refund' AND c.status IN ('succeeded','pending')) refundable
  FROM international_payments p JOIN orders o ON o.id=p.order_id JOIN export_orders eo ON eo.id=p.export_order_id`;
async function list(q = {}) {
  const where = ['1=1'], args = [];
  if (['charge', 'refund'].includes(q.kind)) { where.push('p.kind=?'); args.push(q.kind); }
  if (['pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'].includes(q.status)) { where.push('p.status=?'); args.push(q.status); }
  if (q.q) { where.push('(o.ref ILIKE ? OR eo.ref ILIKE ? OR p.provider_ref ILIKE ?)'); const l = '%' + String(q.q).replace(/[%_]/g, '').slice(0, 40) + '%'; args.push(l, l, l); }
  const from = Number(q.from) || 0, to = Number(q.to) || 0; if (from) { where.push('p.created>=?'); args.push(from); } if (to) { where.push('p.created<=?'); args.push(to); }
  const rows = await all(`${SEL} WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 200`, ...args);
  return { payments: rows.map((r) => { const s = shape(r); if (r.kind === 'refund') { delete s.refunded; delete s.refundable; } return s; }), providers: providers().providers.map((p) => ({ code: p.code, status: p.status })) };
}

/* ---------- refund state changes ---------- */
// Called whenever Paystack has confirmed a refund. Idempotent: only a pending row can become succeeded.
async function settleRefund(row, parent) {
  let changed = false;
  await tx(async () => {
    const r = await run("UPDATE international_payments SET status='succeeded', verified=1, verified_at=?, provider_status='processed', updated=? WHERE id=? AND status='pending'", now(), now(), row.id);
    if (r.changes !== 1) return; changed = true;
    const sum = Number((await get("SELECT COALESCE(SUM(amount),0) s FROM international_payments WHERE parent_id=? AND kind='refund' AND status='succeeded'", parent.id)).s);
    await run('UPDATE international_payments SET status=?, updated=? WHERE id=?', sum + 0.0001 >= Number(parent.amount) ? 'refunded' : 'partially_refunded', now(), parent.id);
  });
  if (!changed) return;
  const full = Number((await get("SELECT COALESCE(SUM(amount),0) s FROM international_payments WHERE parent_id=? AND kind='refund' AND status='succeeded'", parent.id)).s) + 0.0001 >= Number(parent.amount);
  const order = await S.loadOrder('id=?', parent.order_id); if (!order) return;
  const amt = '₦' + Number(row.amount).toLocaleString('en-NG');
  try {
    if (full) await S.refundOrder(order, `Refund of ${amt} processed by Paystack.`);
    else await S.addEvent(order.id, order.status, `Partial refund of ${amt} processed by Paystack.`);
  } catch (e) { await S.addEvent(order.id, order.status, `Refund of ${amt} processed by Paystack.`).catch(() => {}); }
}
async function failRefund(row, note) {
  await run("UPDATE international_payments SET status='failed', provider_status=?, updated=? WHERE id=? AND status='pending'", String(note || 'failed').slice(0, 60), now(), row.id);
}

async function refund(chargeId, b, user, ip) {
  if (!live()) fail(409, 'Paystack is not connected on this server, so refunds cannot be sent. Demo payments have nothing to refund.');
  const key = String(b.idempotency_key || ''); if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) fail(400, 'A refund key is required (16 to 64 letters or digits).');
  const reason = str(b.reason, 200); if (reason.length < 3) fail(400, 'Enter the reason for the refund.');
  const prev = await get('SELECT * FROM international_payments WHERE idempotency_key=?', key);
  if (prev) { if (Number(prev.parent_id) !== Number(chargeId)) fail(409, 'That refund key belongs to a different payment.'); return { payment: shape(await get(SEL + ' WHERE p.id=?', prev.id)), replayed: true }; }
  const amount = Number(b.amount_ngn); if (!Number.isFinite(amount) || amount <= 0 || amount > 1e10 || Math.round(amount * 100) !== amount * 100 && Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) fail(400, 'Refund amount: enter an amount in naira above 0 (up to 2 decimal places).');
  let row, charge;
  try {
    await tx(async () => {
      charge = await get("SELECT * FROM international_payments WHERE id=? AND kind='charge' FOR UPDATE", Number(chargeId) || 0); if (!charge) fail(404, 'Payment not found.');
      if (charge.provider !== 'paystack' || /^DEMO-/.test(charge.provider_ref)) fail(409, 'Only real Paystack payments can be refunded here.');
      if (!['succeeded', 'partially_refunded'].includes(charge.status) || !Number(charge.verified)) fail(409, 'This payment is not in a refundable state.');
      const used = Number((await get("SELECT COALESCE(SUM(amount),0) s FROM international_payments WHERE parent_id=? AND kind='refund' AND status IN ('succeeded','pending')", charge.id)).s), left = Math.round((Number(charge.amount) - used) * 100) / 100;
      if (amount > left + 1e-9) fail(409, left > 0 ? `At most ₦${left.toLocaleString('en-NG')} can still be refunded for this payment (including refunds still waiting for Paystack).` : 'This payment has already been fully refunded or has refunds waiting for Paystack.');
      const r = await run("INSERT INTO international_payments (export_order_id,order_id,provider,provider_ref,currency,amount,fee,fx_rate_to_ngn,amount_ngn,kind,status,verified,parent_id,reason,idempotency_key,created_by,provider_status,created,updated) VALUES (?,?,'paystack',?,'NGN',?,0,1,?,'refund','pending',0,?,?,?,?,'queued',?,?)",
        charge.export_order_id, charge.order_id, 'RFQ-' + key, amount, amount, charge.id, reason, key, user ? user.id : null, now(), now());
      row = await get('SELECT * FROM international_payments WHERE id=?', Number(r.lastInsertRowid));
    });
  } catch (e) { if (e.code === '23505') return refund(chargeId, b, user, ip); throw e; }
  await T.audit(user, 'payment.refund_requested', 'international_payments', row.id, { charge: Number(charge.id), amount, reason }, ip);
  try {
    const d = await ps('POST', '/refund', { transaction: charge.provider_ref, amount: kobo(amount), currency: 'NGN', merchant_note: reason, customer_note: reason });
    const st = String((d && d.status) || 'pending');
    await run('UPDATE international_payments SET provider_ref=COALESCE(?, provider_ref), provider_status=?, updated=? WHERE id=?', d && d.id != null ? 'PSR-' + d.id : null, st, now(), row.id);
    row = await get('SELECT * FROM international_payments WHERE id=?', row.id);
    if (st === 'processed') await settleRefund(row, charge); else if (st === 'failed') await failRefund(row, 'failed');
  } catch (e) {
    if (e instanceof ProviderError && !e.ambiguous) { await failRefund(row, e.message); await T.audit(user, 'payment.refund_failed', 'international_payments', row.id, { error: e.message }, ip); fail(e.status === 404 ? 404 : 422, e.message); }
    await run("UPDATE international_payments SET provider_status='no answer yet', updated=? WHERE id=?", now(), row.id);   // may have been accepted: keep it pending, never retry blindly
    fail(502, 'Paystack did not confirm the refund request. It is kept as pending: press "Check with Paystack" before trying again.');
  }
  return { payment: shape(await get(SEL + ' WHERE p.id=?', row.id)) };
}

// Ask Paystack where a pending refund stands.
async function refresh(refundId, user, ip) {
  if (!live()) fail(409, 'Paystack is not connected on this server.');
  const row = await get("SELECT * FROM international_payments WHERE id=? AND kind='refund'", Number(refundId) || 0); if (!row) fail(404, 'Refund not found.');
  const parent = await get('SELECT * FROM international_payments WHERE id=?', row.parent_id);
  if (row.status !== 'pending') return { payment: shape(await get(SEL + ' WHERE p.id=?', row.id)) };
  let psId = /^PSR-/.test(row.provider_ref) ? row.provider_ref.slice(4) : null, d;
  try {
    if (!psId) {   // the request may have been accepted without us hearing: find it by the original transaction
      const tr = await ps('GET', '/transaction/verify/' + encodeURIComponent(parent.provider_ref)), list = await ps('GET', '/refund?transaction=' + encodeURIComponent(tr.id));
      const taken = new Set((await all("SELECT provider_ref FROM international_payments WHERE kind='refund' AND provider_ref LIKE 'PSR-%'")).map((x) => x.provider_ref));
      const hit = (Array.isArray(list) ? list : []).find((x) => Number(x.amount) === kobo(row.amount) && !taken.has('PSR-' + x.id)); if (!hit) return { payment: shape(await get(SEL + ' WHERE p.id=?', row.id)), note: 'Paystack has no record of this refund request.' };
      psId = String(hit.id); await run('UPDATE international_payments SET provider_ref=?, updated=? WHERE id=?', 'PSR-' + psId, now(), row.id);
    }
    d = await ps('GET', '/refund/' + encodeURIComponent(psId));
  } catch (e) { if (e instanceof ProviderError) fail(e.status === 504 ? 504 : 502, e.message); throw e; }
  const st = String(d.status || '');
  const fresh = await get('SELECT * FROM international_payments WHERE id=?', row.id);
  if (st === 'processed') await settleRefund(fresh, parent); else if (st === 'failed') await failRefund(fresh, 'failed'); else await run('UPDATE international_payments SET provider_status=?, updated=? WHERE id=?', st.slice(0, 40), now(), row.id);
  await T.audit(user, 'payment.refund_refresh', 'international_payments', row.id, { provider_status: st }, ip);
  return { payment: shape(await get(SEL + ' WHERE p.id=?', row.id)) };
}

// Paystack refund.* webhook (signature already verified by the caller). Safe to receive twice.
async function onRefundEvent(ev) {
  const kind = String(ev.event || ''), d = ev.data || {}; if (!/^refund\./.test(kind)) return;
  const txRef = String(d.transaction_reference || ''); if (!txRef) return;
  const parent = await get("SELECT * FROM international_payments WHERE kind='charge' AND provider='paystack' AND UPPER(provider_ref)=UPPER(?)", txRef); if (!parent) return;   // not an international order
  const amountNgn = Number(d.amount) / 100, st = kind.slice(7);
  if (!(amountNgn > 0)) return;
  const pending = await get("SELECT * FROM international_payments WHERE parent_id=? AND kind='refund' AND status='pending' AND ABS(amount-?)<0.005 ORDER BY id LIMIT 1", parent.id, amountNgn);
  if (pending) { if (st === 'processed') await settleRefund(pending, parent); else if (st === 'failed') await failRefund(pending, 'failed'); else await run('UPDATE international_payments SET provider_status=?, updated=? WHERE id=?', st.slice(0, 40), now(), pending.id); return; }
  if (st !== 'processed') return;
  // a refund started in the Paystack dashboard: record it so the books match
  const refRef = 'PSX-' + String(d.refund_reference || d.id || txRef + ':' + kobo(amountNgn)).slice(0, 60);
  const ins = await run("INSERT INTO international_payments (export_order_id,order_id,provider,provider_ref,currency,amount,fee,fx_rate_to_ngn,amount_ngn,kind,status,verified,parent_id,reason,provider_status,created,updated) VALUES (?,?,'paystack',?,'NGN',?,0,1,?,'refund','pending',0,?,'Started in the Paystack dashboard','processed',?,?) ON CONFLICT (provider, provider_ref) DO NOTHING", parent.export_order_id, parent.order_id, refRef, amountNgn, amountNgn, parent.id, now(), now());
  if (ins.changes === 0) return;
  await settleRefund(await get('SELECT * FROM international_payments WHERE provider=? AND provider_ref=?', 'paystack', refRef), parent);
}

/* ---------- reconciliation ---------- */
async function reconciliation(q = {}) {
  const from = Number(q.from) || 0, to = Number(q.to) || 4102444800, rows = await all(`SELECT eo.ref, o.ref order_ref, o.total order_total, o.payment_status, eo.currency, eo.total, eo.fx_rate_to_ngn, eo.total_ngn, eo.created,
    (SELECT COALESCE(SUM(p.amount),0) FROM international_payments p WHERE p.export_order_id=eo.id AND p.kind='charge' AND p.verified=1 AND p.status IN ('succeeded','partially_refunded','refunded')) charged,
    (SELECT COALESCE(SUM(p.fee),0) FROM international_payments p WHERE p.export_order_id=eo.id AND p.kind='charge' AND p.verified=1) fees,
    (SELECT COALESCE(SUM(p.amount),0) FROM international_payments p WHERE p.export_order_id=eo.id AND p.kind='refund' AND p.status='succeeded') refunded,
    (SELECT COALESCE(SUM(p.amount),0) FROM international_payments p WHERE p.export_order_id=eo.id AND p.kind='refund' AND p.status='pending') refund_pending
    FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE o.payment_status IN ('paid','refunded') AND eo.created BETWEEN ? AND ? ORDER BY eo.id DESC LIMIT 500`, from, to);
  const cache = {}; const cur = async (c) => { if (c === 'NGN') return 1; if (!(c in cache)) { try { cache[c] = (await FX.rate(c, 'NGN')).rate; } catch { cache[c] = null; } } return cache[c]; };
  const out = []; const tot = { charged: 0, fees: 0, refunded: 0, net: 0, fx_difference: 0, flagged: 0 };
  for (const r of rows) {
    const charged = Number(r.charged), fees = Number(r.fees), refunded = Number(r.refunded), pend = Number(r.refund_pending), ordered = Number(r.order_total);
    const flag = charged === 0 ? 'no_provider_record' : Math.abs(charged - ordered) > 0.5 ? 'amount_mismatch' : pend > 0 ? 'refund_pending' : 'ok';
    const rate = await cur(r.currency), now_ngn = rate == null ? null : Math.round(Number(r.total) * rate), fxd = now_ngn == null ? null : now_ngn - Number(r.total_ngn);
    const net = charged - fees - refunded;
    out.push({ export_ref: r.ref, order_ref: r.order_ref, currency: r.currency, total: Number(r.total), fx_rate_to_ngn: Number(r.fx_rate_to_ngn), ordered_ngn: ordered, charged_ngn: charged, fees_ngn: fees, refunded_ngn: refunded, refund_pending_ngn: pend, net_ngn: net, fx_difference_ngn: fxd, flag, created: Number(r.created) });
    tot.charged += charged; tot.fees += fees; tot.refunded += refunded; tot.net += net; if (fxd != null) tot.fx_difference += fxd; if (flag !== 'ok') tot.flagged++;
  }
  return { rows: out, totals: tot, note: 'Charged = payments Paystack confirmed. "No provider record" means the order is marked paid but there is no confirmed Paystack payment on file (for example a demo or hand-marked payment). The exchange difference shows what the order total is worth at today\'s rate compared with the rate fixed at checkout; it is information, not a charge.' };
}
module.exports = { providers, list, refund, refresh, onRefundEvent, reconciliation, live };
