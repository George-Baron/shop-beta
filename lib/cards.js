'use strict';
// VELTO-MART CARD: applications, issued-card references and status, driven by the issuer's webhooks. No card number, CVV, BVN or NIN is ever stored.
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const P = require('./card-providers');
const { fail, str, int } = S;

const CONSENT_VERSION = 'velto-card-terms-v1';
const OPEN = ['submitted', 'under_review', 'info_needed', 'approved'];
const toNaira = (k) => (k == null ? null : Number(k) / 100);
const notify = (uid, title, body) => require('./notify').notify([uid], { type: 'card', title, body, link: '/account' }).catch(() => {});
const history = (o) => run('INSERT INTO card_status_history (card_id,application_id,user_id,from_status,to_status,actor,note,created) VALUES (?,?,?,?,?,?,?,?)', o.cardId || null, o.appId || null, o.userId, o.from || '', o.to, o.actor || 'system', str(o.note, 300), now());
const audit = (userId, actor, action, detail) => run('INSERT INTO card_audit (user_id,actor_id,actor_name,action,detail,created) VALUES (?,?,?,?,?,?)', userId, actor ? actor.id : null, actor ? str(actor.name || actor.email, 80) : 'system', action, str(detail, 500), now());
const provider = () => { const p = P.get(); return p; };
async function available() { const on = (await get("SELECT value FROM settings WHERE key='card_enabled'")); return !!provider() && on && on.value === '1'; }

const appShape = (a) => ({ id: Number(a.id), kind: a.kind, status: a.status, message: a.status_note, created: Number(a.created), updated: Number(a.updated) });
const cardShape = (c) => ({ id: Number(c.id), brand: 'VELTO-MART CARD', kind: c.kind, network: c.network, masked_number: `•••• •••• •••• ${c.last4}`, expiry: c.expiry_month ? `${String(c.expiry_month).padStart(2, '0')}/${String(c.expiry_year).slice(-2)}` : null, status: c.status, delivery_status: c.delivery_status || null, balance: toNaira(c.balance), created: Number(c.created) });

async function overview(user) {
  const apps = await all('SELECT * FROM card_applications WHERE user_id=? ORDER BY id DESC LIMIT 10', user.id);
  const cards = await all("SELECT * FROM cards WHERE user_id=? AND status<>'replaced' ORDER BY id DESC", user.id);
  const ok = await available();
  return { programme: { available: ok, message: ok ? '' : 'The VELTO-MART CARD is coming soon. We will tell you as soon as you can apply.', kinds: ok ? ['virtual', 'physical'] : [] }, cardholder_name: user.name, applications: apps.map(appShape), cards: cards.map(cardShape) };
}

// Step 1: the customer applies. Identity numbers go straight to the issuer and are not kept.
async function apply(user, b) {
  if (!(await available())) fail(503, 'The VELTO-MART CARD is not available yet.');
  if (!b || b.consent !== true) fail(400, 'Please accept the card terms to continue.');
  const kind = b.kind === 'physical' ? 'physical' : b.kind === 'virtual' ? 'virtual' : '';
  if (!kind) fail(400, 'Choose a virtual or a physical card.');
  const bvn = String(b.bvn || '').replace(/\D/g, ''), nin = String(b.nin || '').replace(/\D/g, '');
  if (bvn.length !== 11 && nin.length !== 11) fail(400, 'Enter your 11-digit BVN or NIN so the issuer can verify you.');
  const d = b.delivery || {};
  if (kind === 'physical' && (!str(d.address, 200) || !str(d.city, 80) || !str(d.state, 60) || !str(d.phone, 30))) fail(400, 'A physical card needs a delivery address, city, state and phone number.');
  if (await get("SELECT 1 x FROM cards WHERE user_id=? AND kind=? AND status IN ('inactive','active','frozen')", user.id, kind)) fail(409, `You already have a ${kind} VELTO-MART CARD.`);
  if (await get('SELECT 1 x FROM card_applications WHERE user_id=? AND kind=? AND status = ANY(?)', user.id, kind, OPEN)) fail(409, 'You already have an application in progress.');
  const fullName = str(b.full_name, 100) || user.name, t = now();
  let r;
  try { r = await provider().createApplication({ user: { id: user.id, name: fullName, email: user.email, phone: user.phone }, kind, kyc: { bvn, nin, dob: str(b.dob, 12) }, delivery: kind === 'physical' ? { name: str(d.name, 80) || fullName, phone: str(d.phone, 30), address: str(d.address, 200), city: str(d.city, 80), state: str(d.state, 60) } : null }); }
  catch (e) { if (e.status === 400) fail(400, e.message); console.error('Card issuer application failed:', e.message); fail(502, 'The card issuer could not take your application right now. Please try again later.'); }
  const a = await get(`INSERT INTO card_applications (user_id,kind,status,provider,provider_ref,full_name,delivery_name,delivery_phone,delivery_address,delivery_city,delivery_state,consent_version,consent_at,created,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`, user.id, kind, ['under_review', 'approved'].includes(r.status) ? r.status : 'submitted', provider().name, r.providerRef, fullName, str(d.name, 80), str(d.phone, 30), str(d.address, 200), str(d.city, 80), str(d.state, 60), CONSENT_VERSION, t, t, t);
  await history({ appId: a.id, userId: user.id, to: a.status, actor: 'customer', note: 'Application submitted' });
  notify(user.id, 'VELTO-MART CARD application received', `We have sent your ${kind} card application for verification.`);
  return appShape(a);
}

/* ---------- the issuer tells us what happened ---------- */
const FORWARD = { submitted: ['under_review', 'info_needed', 'approved', 'rejected'], under_review: ['info_needed', 'approved', 'rejected'], info_needed: ['under_review', 'approved', 'rejected'], approved: ['issued', 'rejected'] };
async function setApp(a, to, note) {
  if (a.status === to) return;
  if (!(FORWARD[a.status] || []).includes(to)) return; // never move a finished application backwards
  await run('UPDATE card_applications SET status=?, status_note=?, updated=? WHERE id=?', to, str(note, 300), now(), a.id);
  await history({ appId: a.id, userId: a.user_id, from: a.status, to, note });
}
async function setCard(c, to, note, actor) {
  if (c.status === to || ['replaced', 'cancelled', 'expired'].includes(c.status)) return;
  await run('UPDATE cards SET status=?, updated=? WHERE id=?', to, now(), c.id);
  await history({ cardId: c.id, userId: c.user_id, from: c.status, to, actor: actor || 'issuer', note });
}
async function handleEvent(provName, ev) {
  const eventId = str(ev.eventId, 120), type = str(ev.type, 40);
  if (!eventId || !type) fail(400, 'Bad event.');
  return tx(async () => {
    const ins = await run('INSERT INTO card_events (provider,event_id,type,created) VALUES (?,?,?,?) ON CONFLICT (provider,event_id) DO NOTHING', provName, eventId, type, now());
    if (!ins.changes) return { duplicate: true };
    const app = ev.providerRef ? await get('SELECT * FROM card_applications WHERE provider=? AND provider_ref=? FOR UPDATE', provName, str(ev.providerRef, 80)) : null;
    const card = ev.providerCardId ? await get('SELECT * FROM cards WHERE provider=? AND provider_card_id=? FOR UPDATE', provName, str(ev.providerCardId, 80)) : null;
    const msg = str(ev.message, 300);
    switch (type) {
      case 'application.under_review': if (app) await setApp(app, 'under_review', msg); break;
      case 'application.info_needed': if (app) { await setApp(app, 'info_needed', msg || 'The issuer needs more information.'); notify(app.user_id, 'More information needed for your card', msg || 'Open your card application to continue.'); } break;
      case 'application.approved': if (app) { await setApp(app, 'approved', msg); notify(app.user_id, 'VELTO-MART CARD approved', 'Your application was approved. Your card is being issued.'); } break;
      case 'application.rejected': if (app) { await setApp(app, 'rejected', msg || 'The issuer could not approve this application.'); notify(app.user_id, 'VELTO-MART CARD application update', 'We could not approve your card application. Open it to see why.'); } break;
      case 'card.issued': {
        if (!app) break;
        const last4 = String(ev.last4 || '').replace(/\D/g, '').slice(-4); if (last4.length !== 4 || !ev.providerCardId) fail(400, 'Issued card needs a card id and last 4 digits.');
        const c = await get(`INSERT INTO cards (user_id,application_id,kind,provider,provider_card_id,network,last4,expiry_month,expiry_year,delivery_status,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT (provider,provider_card_id) DO UPDATE SET updated=cards.updated RETURNING *`, app.user_id, app.id, app.kind, provName, str(ev.providerCardId, 80), str(ev.network, 20), last4, int(ev.expiryMonth) || null, int(ev.expiryYear) || null, app.kind === 'physical' ? 'being_produced' : '', now(), now());
        await history({ cardId: c.id, appId: app.id, userId: app.user_id, to: 'inactive', note: 'Card issued' });
        await setApp(app, 'issued', msg);
        if (app.replaces_card_id) await run("UPDATE cards SET status='replaced', updated=? WHERE id=? AND status IN ('blocked','frozen','active','inactive')", now(), app.replaces_card_id);
        notify(app.user_id, 'Your VELTO-MART CARD is ready', app.kind === 'physical' ? 'Your physical card is on its way. Activate it when it arrives.' : 'Your virtual card is ready. Activate it to start using it.'); break; }
      case 'card.activated': if (card) { await setCard(card, 'active'); notify(card.user_id, 'VELTO-MART CARD activated', 'Your card is ready to use.'); } break;
      case 'card.frozen': if (card) { await setCard(card, 'frozen'); notify(card.user_id, 'VELTO-MART CARD frozen', 'Your card is frozen and cannot be used.'); } break;
      case 'card.unfrozen': if (card) await setCard(card, 'active'); break;
      case 'card.blocked': if (card) { await setCard(card, 'blocked', msg); notify(card.user_id, 'Security alert: card blocked', 'Your VELTO-MART CARD was blocked.'); } break;
      case 'card.expired': if (card) await setCard(card, 'expired'); break;
      case 'card.delivery': if (card) { await run('UPDATE cards SET delivery_status=?, updated=? WHERE id=?', str(ev.deliveryStatus, 40), now(), card.id); notify(card.user_id, 'Card delivery update', 'Your card delivery is now: ' + str(ev.deliveryStatus, 40).replace(/_/g, ' ') + '.'); } break;
      case 'card.balance': if (card && Number.isFinite(Number(ev.balance))) await run('UPDATE cards SET balance=?, updated=? WHERE id=?', Math.round(Number(ev.balance) * 100), now(), card.id); break;
      case 'card.transaction': {
        if (!card || !ev.providerTxnId || !Number.isFinite(Number(ev.amount))) break;
        const r = await run('INSERT INTO card_transactions (card_id,user_id,provider_txn_id,amount,currency,kind,merchant,status,occurred,created) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          card.id, card.user_id, str(ev.providerTxnId, 80), Math.round(Number(ev.amount) * 100), str(ev.currency, 3).toUpperCase() || 'NGN', str(ev.kind, 20) || 'purchase', str(ev.merchant, 100), str(ev.status, 20) || 'completed', int(ev.occurred) || now(), now());
        if (r.changes) notify(card.user_id, 'Card transaction', `₦${Number(ev.amount).toLocaleString('en-NG')} at ${str(ev.merchant, 60) || 'a merchant'}.`); break; }
      default: await run("UPDATE card_events SET note='unknown event type' WHERE provider=? AND event_id=?", provName, eventId); return { ignored: true };
    }
    await run('UPDATE card_events SET handled=1 WHERE provider=? AND event_id=?', provName, eventId);
    return { ok: true };
  });
}

/* ---------- card controls (always through the issuer first) ---------- */
async function ownCard(user, id) { const c = await get('SELECT * FROM cards WHERE id=? AND user_id=?', int(id), user.id); if (!c) fail(404, 'Card not found.'); return c; }
async function control(user, id, action, body) {
  const c = await ownCard(user, id), P_ = provider(); if (!P_) fail(503, 'The VELTO-MART CARD service is not available right now.');
  const ok = { activate: ['inactive'], freeze: ['active'], unfreeze: ['frozen'], block: ['inactive', 'active', 'frozen'] };
  if (!ok[action].includes(c.status)) fail(409, `This card is ${c.status}, so it cannot be ${action === 'block' ? 'blocked' : action + 'd'}.`);
  try { await P_[action](c, str(body && body.reason, 100)); } catch (e) { console.error('Card issuer', action, 'failed:', e.message); fail(502, 'The card issuer could not do that right now. Nothing was changed.'); }
  const to = { activate: 'active', freeze: 'frozen', unfreeze: 'active', block: 'blocked' }[action];
  await setCard(c, to, str(body && body.reason, 100), 'customer');
  if (action === 'block') notify(user.id, 'Security alert: card blocked', 'You blocked your VELTO-MART CARD.');
  if (action === 'freeze') notify(user.id, 'VELTO-MART CARD frozen', 'Your card is frozen and cannot be used.');
  return cardShape(await get('SELECT * FROM cards WHERE id=?', c.id));
}
// Full card details are shown only on the issuer's own secure page.
async function reveal(user, id) {
  const c = await ownCard(user, id); if (c.status !== 'active' && c.status !== 'frozen') fail(409, 'Details are available once the card is active.');
  try { return await provider().revealSession(c); } catch (e) { console.error('Card reveal failed:', e.message); fail(502, 'The card issuer could not open the secure page right now.'); }
}
// A lost or damaged card: block the old one at the issuer, then apply for a replacement (no new identity check needed, the issuer already knows the customer).
async function replace(user, id, body) {
  const c = await ownCard(user, id); if (!['blocked', 'active', 'frozen', 'inactive'].includes(c.status)) fail(409, 'This card cannot be replaced.');
  if (c.status !== 'blocked') await control(user, id, 'block', { reason: str(body && body.reason, 100) || 'replacement' });
  const old = await get('SELECT * FROM card_applications WHERE id=?', c.application_id), t = now();
  const a = await get(`INSERT INTO card_applications (user_id,kind,status,provider,provider_ref,full_name,delivery_name,delivery_phone,delivery_address,delivery_city,delivery_state,status_note,replaces_card_id,consent_version,consent_at,created,updated)
    VALUES (?,?,'submitted',?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`, user.id, c.kind, c.provider, '', old ? old.full_name : user.name, old ? old.delivery_name : '', old ? old.delivery_phone : '', old ? old.delivery_address : '', old ? old.delivery_city : '', old ? old.delivery_state : '', 'Replacement requested', c.id, CONSENT_VERSION, t, t, t);
  await history({ appId: a.id, cardId: c.id, userId: user.id, to: 'submitted', actor: 'customer', note: 'Replacement requested' });
  return appShape(a);
}
async function transactions(user, id, q = {}) {
  const c = await ownCard(user, id), lim = Math.min(100, Math.max(1, int(q.limit, 30))), before = int(q.before, 0);
  const rows = await all(`SELECT * FROM card_transactions WHERE card_id=? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ${lim + 1}`, c.id, ...(before ? [before] : []));
  return { transactions: rows.slice(0, lim).map((r) => ({ id: Number(r.id), amount: Number(r.amount) / 100, currency: r.currency, kind: r.kind, merchant: r.merchant, status: r.status, date: Number(r.occurred) })), more: rows.length > lim };
}

/* ---------- administrators: metadata only ---------- */
async function adminList(status) {
  return all(`SELECT a.id, a.user_id, u.name customer, u.email, a.kind, a.status, a.status_note, a.provider, a.created, a.updated FROM card_applications a JOIN users u ON u.id=a.user_id ${status ? 'WHERE a.status=?' : ''} ORDER BY a.id DESC LIMIT 200`, ...(status ? [status] : []));
}
async function adminDetail(id) {
  const a = await get('SELECT id,user_id,kind,status,status_note,provider,full_name,delivery_city,delivery_state,consent_version,consent_at,created,updated FROM card_applications WHERE id=?', int(id)); if (!a) fail(404, 'Not found.');
  return { application: a, cards: (await all('SELECT * FROM cards WHERE application_id=?', a.id)).map(cardShape), history: await all('SELECT from_status,to_status,actor,note,created FROM card_status_history WHERE application_id=? OR card_id IN (SELECT id FROM cards WHERE application_id=?) ORDER BY id', a.id, a.id) };
}
async function adminBlock(cardId, reason, actor) {
  if (!str(reason, 200)) fail(400, 'Please give a reason.');
  const c = await get('SELECT * FROM cards WHERE id=?', int(cardId)); if (!c) fail(404, 'Card not found.');
  if (!['inactive', 'active', 'frozen'].includes(c.status)) fail(409, 'This card is already ' + c.status + '.');
  try { await provider().block(c, str(reason, 100)); } catch (e) { fail(502, 'The card issuer could not block the card. Nothing was changed.'); }
  await setCard(c, 'blocked', str(reason, 200), actor.name || actor.email); await audit(c.user_id, actor, 'block', reason);
  notify(c.user_id, 'Security alert: card blocked', 'Your VELTO-MART CARD was blocked for your protection. Contact support.');
}
async function adminReport() {
  const apps = await all('SELECT status, COUNT(*) n FROM card_applications GROUP BY status'), cards = await all('SELECT status, COUNT(*) n FROM cards GROUP BY status');
  const tx = await get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM card_transactions WHERE status='completed'");
  return { applications: Object.fromEntries(apps.map((r) => [r.status, Number(r.n)])), cards: Object.fromEntries(cards.map((r) => [r.status, Number(r.n)])), transactions: { count: Number(tx.n), value: Number(tx.s) / 100 } };
}
module.exports = { overview, apply, handleEvent, control, reveal, replace, transactions, adminList, adminDetail, adminBlock, adminReport, provider, available };
