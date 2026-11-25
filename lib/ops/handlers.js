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
};

// Level-0 types that only record a recommendation or a draft: the output is the record itself.
const RECORD_ONLY = new Set(['po.draft', 'procurement.recommend', 'quote.compare', 'provider.compare', 'rider.recommend', 'refund.recommend', 'customer.draft', 'supplier.research', 'landed.calculate', 'report.generate', 'shipment.track']);

module.exports = { HANDLERS, RECORD_ONLY };
