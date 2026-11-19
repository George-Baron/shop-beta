'use strict';
// The command centre of the VELTO-MART AI Operations Manager: an administrator types a request, and the answer is read from the live database.
// Nothing is guessed: every reply carries the rows it came from and the time they were read. Requests that change an assignment are not carried out
// at once; they come back as a pending action that the administrator must confirm (policy rider_confirm_policy = always, the default).
const { get, all, run, now } = require('./db');
const S = require('./shop');
const R = require('./riders');
const D = require('./dispatch');
const { fail } = S;

const ORDER_RE = /\b(SB-[A-Z0-9][A-Z0-9-]{2,})\b/gi;
const RIDER_RE = /\bSB-R\d{2,5}\b/i;
const refsIn = (t) => [...String(t).matchAll(ORDER_RE)].map((m) => m[1].toUpperCase()).filter((x) => !/^SB-R\d{2,5}$/.test(x));
const mins = (s) => (s == null ? '—' : s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`);
const line = (r) => `${r.code} ${r.name} (${r.availability.replace('_', ' ')}, GPS ${r.gps_label.toLowerCase()}${r.position ? ', ' + mins(r.position.age_s) : ''}${r.assignment ? ', carrying ' + r.assignment.order_ref : ''})`;
const out = (reply, data = {}, extra = {}) => ({ reply, data, at: now(), source: 'live database', ...extra });

const HELP = `I can answer from live data. Try: "Show me all available riders", "How many riders are online right now?", "Show riders closest to the central warehouse", "Which rider is closest to order SB-1020?", "Find the best rider for order SB-1020", "Find all riders currently on delivery", "Show the current location of all active delivery riders", "Show me riders whose GPS has stopped updating", "Which riders are available in Ikorodu?", "Show me all deliveries currently delayed", "Send a message to rider SB-R005: <text>", "Ask rider SB-R003 for a delivery update", "Assign order SB-1020 to rider SB-R003" (needs your confirmation).`;

async function pending(admin, orderId, riderId, note) {
  const c = await R.cfg();
  const o = await get('SELECT ref FROM orders WHERE id=?', orderId), r = await R.riderById(riderId);
  if (c.rider_confirm_policy === 'never') { const id = await D.offer(orderId, riderId, { by: 'admin', actor: `${admin.name || admin.email} (command centre)`, actorId: admin.id }); return out(`Offered ${o.ref} to ${r.full_name} (${r.code}). They have ${Math.round(c.rider_offer_timeout_s / 60)} min to answer.`, { assignment_id: id }); }
  const row = await get("INSERT INTO rider_ops_log (actor, action, order_id, rider_id, detail, created_at) VALUES (?, 'pending_assign', ?, ?, ?::jsonb, ?) RETURNING id", String(admin.name || admin.email).slice(0, 80), orderId, riderId, JSON.stringify({ admin_id: admin.id, note }), now());
  return out(`Ready to offer ${o.ref} to ${r.full_name} (${r.code}). ${note || ''} Confirm to send the offer.`, {}, { pending: { id: Number(row.id), order: o.ref, rider: r.code, rider_name: r.full_name } });
}
async function confirm(admin, id) {
  const row = await get("UPDATE rider_ops_log SET action='assign_confirmed' WHERE id=? AND action='pending_assign' AND created_at>? AND (detail->>'admin_id')::bigint=? RETURNING order_id, rider_id", Number(id), now() - 600, admin.id);
  if (!row) fail(409, 'That action expired, was already confirmed, or belongs to someone else. Ask again.');
  const a = await D.offer(Number(row.order_id), Number(row.rider_id), { by: 'admin', actor: `${admin.name || admin.email} (command centre)`, actorId: admin.id });
  await R.logOps(admin.name || 'admin', 'command_assign', { orderId: row.order_id, riderId: row.rider_id, detail: { assignment: a } });
  const r = await R.riderById(row.rider_id), o = await get('SELECT ref FROM orders WHERE id=?', row.order_id);
  return out(`Offer sent: ${o.ref} to ${r.full_name} (${r.code}).`, { assignment_id: a });
}

async function handle(text, admin, ctx = {}) {
  const raw = String(text || '').trim().slice(0, 500), q = raw.toLowerCase();
  if (!raw) fail(400, 'Type a request.');
  await R.logOps(admin.name || admin.email || 'admin', 'command', { detail: { text: raw } });
  const ros = () => R.roster();
  const orderRef = refsIn(raw)[0] || (/\b(this|current) order\b/.test(q) ? String(ctx.orderRef || '').toUpperCase() : '');
  const riderCode = (RIDER_RE.exec(raw) || [])[0];

  // send / ask a rider (a message from the desk or from the AI)
  let m = /send (?:a )?message to rider\s+(SB-R\d+)\s*[:,-]?\s*([\s\S]*)/i.exec(raw);
  if (m) {
    const r = await R.riderByCode(m[1]); if (!r) return out(`I found no rider with the code ${m[1].toUpperCase()}.`);
    if (!m[2].trim()) return out(`What should the message to ${r.full_name} (${r.code}) say? Type: Send a message to rider ${r.code}: <your text>`, {}, { needs: 'message_text' });
    await R.post({ riderId: r.id, kind: 'admin', senderId: admin.id, text: m[2].trim() });
    return out(`Message sent to ${r.full_name} (${r.code}). It is logged in their thread.`);
  }
  m = /ask rider\s+(SB-R\d+)\s+for\s+(?:a\s+)?(?:delivery\s+)?(?:status\s+)?update/i.exec(raw);
  if (m) {
    const r = await R.riderByCode(m[1]); if (!r) return out(`I found no rider with the code ${m[1].toUpperCase()}.`);
    const a = await get(`SELECT a.order_id, o.ref FROM rider_assignments a JOIN orders o ON o.id=a.order_id WHERE a.rider_id=? AND a.assignment_status IN ${R.ACTIVE_ASSIGN} ORDER BY a.id DESC LIMIT 1`, r.id);
    await R.aiSay(r.id, a ? `${R.AI_NAME} here. Please send a delivery update for ${a.ref}: where you are, and your ETA to the customer.` : `${R.AI_NAME} here. Please confirm your status and where you are.`, a ? a.order_id : null, 'reminder');
    return out(`Asked ${r.full_name} (${r.code}) for ${a ? 'an update on ' + a.ref : 'their status'}. Their reply will appear in the chat.`);
  }

  // assignment changes: always come back for confirmation
  if (/^\s*(assign|offer|give)\b/i.test(raw) && (orderRef || ctx.orderRef)) {
    const ref = orderRef || String(ctx.orderRef).toUpperCase(), o = await get('SELECT id, ref FROM orders WHERE ref=?', ref);
    if (!o) return out(`I found no order ${ref}.`);
    const code = (RIDER_RE.exec(raw) || [])[0];
    if (code) { const r = await R.riderByCode(code); if (!r) return out(`I found no rider with the code ${code.toUpperCase()}.`); return pending(admin, o.id, r.id, ''); }
    const rk = await D.rank(o.id); if (!rk.ranking.length) return out(`No rider is eligible for ${o.ref} right now.`, { excluded: rk.excluded });
    const top = rk.ranking[0]; return pending(admin, o.id, top.rider_id, `${top.name} is the best match (${top.score}/100${top.pickup_km != null ? ', ' + top.pickup_km + ' km from pickup' : ''}).`);
  }

  if (/how many riders.*online|riders.*online (right )?now/.test(q)) {
    const r = await ros(), on = r.filter((x) => x.availability !== 'offline' && !x.suspended), by = {};
    for (const x of on) by[x.availability] = (by[x.availability] || 0) + 1;
    return out(`${on.length} of ${r.length} riders are online: ${Object.entries(by).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ') || 'none'}.`, { counts: by, online: on.length, total: r.length });
  }
  m = /available (?:riders )?in ([a-z][a-z \-']+?)\s*\??$/i.exec(raw) || /riders (?:are )?available in ([a-z][a-z \-']+?)\s*\??$/i.exec(raw);
  if (m) {
    const area = m[1].trim(), r = (await R.roster({ area, availability: 'available' }));
    return out(r.length ? `${r.length} available rider${r.length === 1 ? '' : 's'} serve ${area}: ${r.map(line).join('; ')}.` : `No available rider is registered for ${area} right now.`, { riders: r });
  }
  if (/\bavailable riders\b|all available/.test(q)) {
    const r = (await ros()).filter((x) => x.availability === 'available' && !x.suspended);
    return out(r.length ? `${r.length} available: ${r.map(line).join('; ')}.` : 'No rider is available right now.', { riders: r });
  }
  if (/closest to (the )?(central |main )?(warehouse|store|pickup)/.test(q)) {
    const p = await D.pickupPoint(0), r = (await ros()).filter((x) => x.position && x.availability !== 'offline' && !x.suspended);
    if (!p) return out('No pickup point is set up yet, so I cannot measure distance to the warehouse.');
    const rows = r.map((x) => ({ ...x, km: Math.round(R.km({ lat: x.position.lat, lng: x.position.lng }, { lat: Number(p.lat), lng: Number(p.lng) }) * 10) / 10 })).sort((a, b) => a.km - b.km).slice(0, 8);
    await logMap(admin);
    return out(rows.length ? `Closest to ${p.name} (straight-line distance): ${rows.map((x) => `${x.code} ${x.name} ${x.km} km${x.gps === 'stale' ? ' (stale location)' : ''}`).join('; ')}.` : `No online rider has a location yet.`, { pickup: p.name, riders: rows });
  }
  if (/(closest|nearest|best).*(rider)|rider.*(closest|nearest)/.test(q) && (orderRef || /order/.test(q))) {
    const ref = orderRef; if (!ref) return out('Which order? Include the order number, for example "Find the best rider for order SB-1020".');
    const o = await get('SELECT id, ref FROM orders WHERE ref=?', ref); if (!o) return out(`I found no order ${ref}.`);
    const rk = await D.rank(o.id), top = rk.ranking.slice(0, 5);
    await R.logOps('ai', 'rank', { orderId: o.id, detail: { top: top.map((x) => [x.code, x.score]) } });
    if (!top.length) return out(`No rider is eligible for ${o.ref}. ${rk.excluded.slice(0, 5).map((x) => `${x.code}: ${x.reasons.join(', ')}`).join('; ')}.`, { excluded: rk.excluded });
    return out(`Best match for ${o.ref}: ${top[0].name} (${top[0].code}), ${top[0].score}/100${top[0].pickup_km != null ? `, ${top[0].pickup_km} km to pickup (${top[0].pickup_min} min)` : ''}${top[0].approx ? ', distances approximate' : ''}. Next: ${top.slice(1).map((x) => `${x.code} ${x.score}`).join(', ') || 'none'}. Say "Assign order ${o.ref} to rider ${top[0].code}" to offer it.`, { ranking: top, excluded: rk.excluded, pickup: rk.pickup });
  }
  if (/current location|where are.*(riders|deliver)|location of all/.test(q) || (/on delivery/.test(q))) {
    const r = (await ros()).filter((x) => x.assignment && x.assignment.status !== 'offered' && !x.suspended);
    await logMap(admin);
    return out(r.length ? `${r.length} rider${r.length === 1 ? ' is' : 's are'} on delivery: ${r.map((x) => `${x.code} ${x.name} carrying ${x.assignment.order_ref}${x.position ? ` at ${x.position.lat.toFixed(4)}, ${x.position.lng.toFixed(4)} (${x.gps_label.toLowerCase()}, ${mins(x.position.age_s)})` : ' (no location)'}`).join('; ')}.` : 'No rider is on a delivery right now.', { riders: r });
  }
  if (/gps.*(stopped|stale|not updating|lost)|stopped updating|not updating/.test(q)) {
    const r = (await ros()).filter((x) => x.availability !== 'offline' && !x.suspended && ['stale', 'gps_disabled', 'permission_denied'].includes(x.gps));
    return out(r.length ? `${r.length} online rider${r.length === 1 ? ' has' : 's have'} no fresh GPS: ${r.map(line).join('; ')}.` : 'Every online rider has a recent GPS update.', { riders: r });
  }
  if (/delayed|late deliver|deliveries.*late|overdue/.test(q)) {
    const c = await R.cfg(), rows = await all(`SELECT o.ref, o.promised_at, o.status, r.code, r.full_name FROM orders o LEFT JOIN rider_assignments a ON a.order_id=o.id AND a.assignment_status IN ${R.LIVE_ASSIGN} LEFT JOIN riders r ON r.id=a.rider_id
      WHERE o.delivery<>'pickup' AND o.status IN ('paid','confirmed','processing','shipped') AND o.promised_at IS NOT NULL AND o.promised_at < ? ORDER BY o.promised_at LIMIT 50`, now() - c.rider_overdue_grace_min * 60);
    return out(rows.length ? `${rows.length} deliver${rows.length === 1 ? 'y is' : 'ies are'} past the promised time: ${rows.map((x) => `${x.ref} (${Math.round((now() - Number(x.promised_at)) / 60)} min late, ${x.code ? x.code + ' ' + x.full_name : 'no rider'})`).join('; ')}.` : 'No delivery is past its promised time.', { deliveries: rows });
  }
  return out(HELP, {}, { help: true });
}
const logMap = (admin) => R.logAccess(admin, null, 'ai_command_locations');

module.exports = { handle, confirm };
