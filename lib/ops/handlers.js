'use strict';
// What the AI can actually DO in the running system. Each handler performs one action type through the existing code of the store
// (the rider dispatch engine, the notification centre, ...) and says honestly what happened:
//   { status: 'done',        summary, result }   the system confirmed it
//   { status: 'recommended', summary, result }   nothing was changed; a person has to act
//   throws                                       it failed (the caller records the error)
// Action types without a handler here are not wired yet (planned for a later phase) and the gateway refuses them rather than pretending.
const crypto = require('crypto');
const S = require('../shop');
const St = require('./store');
const { str, int } = S;

const HANDLERS = {
  'task.create': async (p, ctx) => {
    const id = await St.createTask(p, { kind: 'ai', name: ctx.agentName });
    return { status: 'done', summary: `Task #${id} created: ${str(p.title, 80)}`, result: { task_id: id } };
  },
  'notify.staff': async (p) => {
    const n = await require('../notify').toStaff(str(p.module, 20) || 'ops', false, { type: 'ops_note', title: str(p.title, 140), body: str(p.body, 600), link: '/admin#/opsai' });
    return { status: n ? 'done' : 'recommended', summary: n ? `Notified ${n} staff member${n === 1 ? '' : 's'}` : 'Nobody has access to this area, so nobody was notified.', result: { notified: n } };
  },
  'exception.raise': async (p, ctx) => {
    const key = 'manual:' + crypto.createHash('sha1').update(String(p.title) + '|' + String(p.related_type) + '|' + String(p.related_id)).digest('hex').slice(0, 16);
    const r = await St.raiseException({ kind: 'raised', severity: p.severity, title: p.title, detail: p.detail, impact: p.impact, recommended_action: p.recommended_action, department: p.department, related_type: p.related_type, related_id: p.related_id, dedupe_key: key, auto: false, detected_by: ctx.agentName });
    return { status: 'done', summary: `${r.ref} ${r.created ? 'raised' : 'already open, refreshed'}`, result: r };
  },
  // The existing rider dispatch engine does the work and keeps its own rules (eligibility, capacity, GPS freshness). Its own switch
  // (Admin > Riders > settings: manual / recommend / auto) is respected: the AI Operations Manager never overrides it.
  'rider.assign': async (p) => {
    const orderId = int(p.order_id); if (!orderId) throw new Error('Which order?');
    const r = await require('../dispatch').dispatchOrder(orderId);
    if (r.ok && r.offered) return { status: 'done', summary: `Delivery offered to rider ${r.rider.name || r.rider.code}`, result: { assignment_id: r.assignment_id, rider: r.rider.code, score: r.rider.score } };
    if (r.ok) return { status: 'recommended', summary: `Recommended rider ${r.recommended.name || r.recommended.code}. Rider dispatch is set to "recommend", so a person must assign.`, result: { rider: r.recommended.code, score: r.recommended.score } };
    if (r.mode === 'manual') throw new Error('Rider dispatch is set to manual in the rider settings, so no one is offered the delivery automatically.');
    const why = { not_ready: 'The order is not ready for dispatch (not paid or confirmed, already assigned, or a pickup order).', no_eligible_rider: 'No rider is eligible right now.', conflict: 'Another assignment took this order first.' }[r.reason] || 'It could not be assigned.';
    throw new Error(why);
  },

  /* ---- procurement (phase 2). Prices always come from recorded quotations; the AI never supplies one. ---- */
  'procurement.recommend': async () => {
    const r = await require('./procurement').recommendFromStock(null);
    return { status: 'done', summary: r.created.length ? `${r.created.length} procurement request(s) created from real stock and sales: ${r.created.join(', ')}` : `No new requests needed (${r.already_open} already open).`, result: r };
  },
  'quote.compare': async (p) => {
    const c = await require('./procurement').compare(int(p.request_id)), slim = (r) => ({ quotation_id: r.quote.id, vendor: r.vendor.name, vendor_status: r.vendor.status, qualified: r.qualified, why_not: r.disqualified_because, landed_ngn: r.landed.ngn, per_unit_ngn: r.landed.per_unit_ngn, estimated: r.landed.estimated, lead_days: r.quote.lead_days, score: r.evaluation.score, data_coverage_pct: r.evaluation.coverage });
    return { status: 'done', summary: c.recommended_reason || `No qualified quotation yet (${c.rows.length} on file).`, result: { request: c.request.ref, highlights: c.highlights, recommended_reason: c.recommended_reason, notes: c.notes, quotations: c.rows.map(slim) } };
  },
  'po.draft': async (p) => {
    const po = await require('./procurement').draftPO(null, int(p.request_id), int(p.quotation_id), { qty: p.qty, byAi: true });
    return { status: 'done', summary: `${po.ref} drafted (${po.currency} ${po.total}). It commits nothing until it is approved.`, result: { po: po.ref, total: po.total, currency: po.currency } };
  },
  'po.create': async (p) => { const r = await require('./procurement').approvePO(p); return { status: 'done', summary: `${r.po_ref} approved. A person must send it to the vendor.`, result: r }; },
  // Courier booking: the AI can only create the booking REQUEST (no courier API is connected). A person books with the courier and enters the tracking reference.
  'courier.book_local': async (p, ctx) => { const r = await require('./logistics').createFromRequest(p, ctx.user ? (ctx.user.name || ctx.user.email) : 'AI'); return { status: 'done', summary: `Booking request ${r.ref} created. Staff must book it with the courier and enter the tracking reference; nothing has been booked yet.`, result: r }; },
  'courier.book_intl': async (p, ctx) => { const r = await require('./logistics').createFromRequest(p, ctx.user ? (ctx.user.name || ctx.user.email) : 'AI'); return { status: 'done', summary: `International booking request ${r.ref} created. Staff must book it with the courier and enter the tracking reference; nothing has been booked yet.`, result: r }; },
  // Creates a DRAFT consignment in the store's trade module from an approved import purchase order. Nothing is booked; Incoterm, transport and costs are left for a person.
  'consignment.draft': async (p) => { const r = await require('./trade-ops').draftFromPo(p); return { status: 'done', summary: `Draft consignment ${r.ref} created from the purchase order. Incoterm, transport and costs are not confirmed; nothing has been booked.${r.skipped.length ? ' Some lines were not added: ' + r.skipped.join('; ') : ''}`, result: r }; },
  'landed.calculate': async (p) => {
    const PR = require('./procure'), rates = await require('../dropship').rates().catch(() => ({})), l = PR.quoteLanded({ country: String(p.vendor_country || 'NG').toUpperCase() }, p, int(p.qty) || 1, rates);
    if (l.ngn == null) throw new Error(l.error);
    return { status: 'done', summary: `Landed cost about ${l.ngn.toLocaleString('en-NG')} NGN (${l.per_unit_ngn} per unit)${l.estimated ? ', an estimate' : ''}.`, result: l };
  },
  'supplier.onboard': async (p, ctx) => { const v = await require('./procurement').createVendor(ctx.user, p.vendor || {}, { byAi: true }); return { status: 'done', summary: `Vendor ${v.ref} added as "under review". Nothing is verified yet.`, result: { vendor: v.ref } }; },
  'supplier.status_change': async (p, ctx) => { const r = await require('./procurement').applyStatus(ctx.user, int(p.vendor_id), str(p.status, 20), p.reason, 'ai_approved'); return { status: 'done', summary: `${r.ref}: ${r.from} → ${r.to}`, result: r }; },
};

// Level-0 types that only record a recommendation or a draft: the output is the record itself.
const RECORD_ONLY = new Set(['provider.compare', 'rider.recommend', 'refund.recommend', 'customer.draft', 'report.generate', 'shipment.track']);   // supplier.research is deliberately absent: there is no research integration yet, so the gateway says so

module.exports = { HANDLERS, RECORD_ONLY };
