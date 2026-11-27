'use strict';
// Procurement records and workflows (database side of procure.js): vendors and their verification, requests, quotations, comparison,
// purchase orders, goods receipts. Nothing here pays anyone or contacts a vendor. Everything a person or the AI does is written to the audit log.
const { get, all, run, tx, now } = require('../db');
const S = require('../shop');
const P = require('./policy');
const PR = require('./procure');
const St = require('./store');
const D = require('./data');
const { fail, str, int } = S;

const n = (v) => (v == null ? null : Number(v));
const who = (u) => (u ? u.name || u.email || 'user ' + u.id : St.AI_NAME);
const log = (o) => St.logAction({ agent: 'procurement', status: 'done', ...o });
const ratesNow = async () => { try { return await require('../dropship').rates(); } catch { return {}; } };
const cfgWeights = async () => PR.normalizeWeights((await St.getConfig()).supplier_weights);

/* ---------------- vendors ---------------- */
const vendorOut = (v) => ({ ...v, id: n(v.id), supplier_id: n(v.supplier_id), payment_days: n(v.payment_days), lead_days: n(v.lead_days), created: n(v.created), updated: n(v.updated), verified_share: Math.round(PR.verifiedShare(v.verification) * 100) });
async function vendorStats(id) {
  const r = await get(`SELECT COUNT(*) c, COALESCE(AVG(on_time)*100,0) ot, COALESCE(SUM(qty_received)::float/NULLIF(SUM(qty_ordered),0)*100,0) fill FROM ops_po_receipts x JOIN ops_purchase_orders p ON p.id=x.po_id WHERE p.vendor_id=?`, id);
  return { receipts: Number(r.c), on_time_pct: Number(r.ot), fill_pct: Math.min(100, Number(r.fill)) };
}
const latestRating = async (id) => get('SELECT quality, responsiveness, note, rated_by, created FROM ops_vendor_ratings WHERE vendor_id=? ORDER BY id DESC LIMIT 1', id);
async function listVendors() {
  const rows = await all('SELECT * FROM ops_vendors ORDER BY CASE status WHEN \'preferred\' THEN 0 WHEN \'approved\' THEN 1 WHEN \'conditional\' THEN 2 WHEN \'under_review\' THEN 3 ELSE 4 END, name');
  return Promise.all(rows.map(async (v) => ({ ...vendorOut(v), stats: await vendorStats(v.id), rating: (await latestRating(v.id)) || null })));
}
const vendorById = async (id) => { const v = await get('SELECT * FROM ops_vendors WHERE id=?', int(id)); if (!v) fail(404, 'Vendor not found.'); return v; };

const KINDS = ['local_manufacturer', 'distributor', 'wholesaler', 'authorized_distributor', 'international_manufacturer', 'importer', 'exporter', 'marketplace', 'other'];
function vendorFields(b) {
  const country = str(b.country, 2).toUpperCase() || 'NG'; if (!/^[A-Z]{2}$/.test(country)) fail(400, 'Country must be a 2-letter code like NG or CN.');
  const currency = str(b.currency, 3).toUpperCase() || 'NGN'; if (!/^[A-Z]{3}$/.test(currency)) fail(400, 'Currency must be a 3-letter code like NGN or USD.');
  const name = str(b.name, 160); if (!name) fail(400, 'The vendor needs a name.');
  const lead = b.lead_days === '' || b.lead_days == null ? null : int(b.lead_days);
  return { name, kind: KINDS.includes(b.kind) ? b.kind : 'distributor', country, location: str(b.location, 200), website: str(b.website, 200), email: str(b.email, 160), phone: str(b.phone, 40), registration_no: str(b.registration_no, 80), currency,
    payment_terms: str(b.payment_terms, 120), payment_days: Math.max(0, Math.min(365, int(b.payment_days) || 0)), lead_days: lead, return_policy: str(b.return_policy, 400), warranty: str(b.warranty, 400), certifications: str(b.certifications, 400), notes: str(b.notes, 600) };
}
// Creates a vendor. It always starts "under review" with nothing verified: what the vendor told us is not proof.
async function createVendor(by, b, { byAi = false } = {}) {
  const f = vendorFields(b), t = now();
  const dup = await get('SELECT id, ref FROM ops_vendors WHERE lower(name)=lower(?) AND country=?', f.name, f.country); if (dup) fail(409, `${dup.ref} already exists for this name and country.`);
  const ver = {}; for (const k of PR.CHECKS) ver[k] = { state: 'unverified' };
  if (f.registration_no) ver.registration = { state: 'vendor_supplied', note: 'Number given by the vendor' };
  if (f.email || f.phone) ver.contact = { state: 'vendor_supplied', note: 'Given by the vendor' };
  if (f.location) ver.location = { state: 'vendor_supplied', note: 'Given by the vendor' };
  const r = await run(`INSERT INTO ops_vendors (name,kind,country,location,website,email,phone,registration_no,currency,payment_terms,payment_days,lead_days,return_policy,warranty,certifications,status,verification,notes,created,updated,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'under_review',?::jsonb,?,?,?,?)`, f.name, f.kind, f.country, f.location, f.website, f.email, f.phone, f.registration_no, f.currency, f.payment_terms, f.payment_days, f.lead_days, f.return_policy, f.warranty, f.certifications, JSON.stringify(ver), f.notes, t, t, byAi ? St.AI_NAME : who(by));
  const v = await vendorById(r.lastInsertRowid);
  await log({ actor_kind: byAi ? 'ai_approved' : 'human', actor_user: by && by.id, actor_name: who(by), action_type: 'vendor.create', description: `Vendor ${v.ref} ${f.name} added (under review, nothing verified yet)`, related_type: 'vendor', related_id: v.ref });
  return vendorOut(v);
}
async function updateVendor(user, id, b) {
  const v = await vendorById(id), f = vendorFields({ ...v, ...b });
  await run('UPDATE ops_vendors SET name=?,kind=?,country=?,location=?,website=?,email=?,phone=?,registration_no=?,currency=?,payment_terms=?,payment_days=?,lead_days=?,return_policy=?,warranty=?,certifications=?,notes=?,updated=? WHERE id=?', f.name, f.kind, f.country, f.location, f.website, f.email, f.phone, f.registration_no, f.currency, f.payment_terms, f.payment_days, f.lead_days, f.return_policy, f.warranty, f.certifications, f.notes, now(), v.id);
  await log({ actor_kind: 'human', actor_user: user.id, actor_name: who(user), action_type: 'vendor.update', description: `Vendor ${v.ref} details updated`, related_type: 'vendor', related_id: v.ref });
}
// Only a signed-in person can mark something "verified": the AI can write "vendor_supplied" or "unverified" at most.
async function setVerification(user, id, check, state, note) {
  if (!user) fail(403, 'Only a person can verify.');
  if (!PR.CHECKS.includes(check)) fail(400, 'Unknown check.'); if (!PR.STATES.includes(state)) fail(400, 'Unknown state.');
  if (state === 'verified' && !str(note, 300)) fail(400, 'Say how you verified it (for example: "CAC search 12 Nov, RC 123456 matches").');
  const v = await vendorById(id), ver = { ...(v.verification || {}), [check]: { state, by: who(user), at: now(), note: str(note, 300) } };
  await run('UPDATE ops_vendors SET verification=?::jsonb, updated=? WHERE id=?', JSON.stringify(ver), now(), v.id);
  await log({ actor_kind: 'human', actor_user: user.id, actor_name: who(user), action_type: 'vendor.verify', description: `${v.ref}: ${PR.CHECK_LABEL[check]} marked ${state.replace('_', ' ')}`, related_type: 'vendor', related_id: v.ref, result: { check, state, note: str(note, 300) } });
  // a vendor that loses its identity checks cannot stay approved
  const st = ['preferred', 'approved'].includes(v.status) ? PR.canBeApproved(ver) : { ok: true };
  if (!st.ok) { await run("UPDATE ops_vendors SET status='conditional', updated=? WHERE id=?", now(), v.id); await log({ actor_kind: 'system', action_type: 'vendor.status', description: `${v.ref} moved to conditional: ${st.reason}`, related_type: 'vendor', related_id: v.ref }); }
}
async function rateVendor(user, id, b) {
  const v = await vendorById(id), q = b.quality === '' || b.quality == null ? null : int(b.quality), r = b.responsiveness === '' || b.responsiveness == null ? null : int(b.responsiveness);
  if ((q != null && (q < 0 || q > 100)) || (r != null && (r < 0 || r > 100))) fail(400, 'Ratings are 0 to 100.'); if (q == null && r == null) fail(400, 'Give at least one rating.');
  await run('INSERT INTO ops_vendor_ratings (vendor_id,quality,responsiveness,note,rated_by,created) VALUES (?,?,?,?,?,?)', v.id, q, r, str(b.note, 300), who(user), now());
  await log({ actor_kind: 'human', actor_user: user.id, actor_name: who(user), action_type: 'vendor.rate', description: `${v.ref} rated (quality ${q ?? '-'}, responsiveness ${r ?? '-'})`, related_type: 'vendor', related_id: v.ref });
}
// Applies a status. Approving or preferring a vendor needs verified identity; the caller has already been through the approval rules.
async function applyStatus(by, id, status, reason, actorKind) {
  if (!PR.STATUSES.includes(status)) fail(400, 'Unknown status.'); const v = await vendorById(id);
  if (['preferred', 'approved'].includes(status)) { const ok = PR.canBeApproved(v.verification); if (!ok.ok) fail(409, ok.reason); }
  if (['suspended', 'rejected', 'conditional'].includes(status) && !str(reason, 300)) fail(400, 'Give a reason.');
  await run('UPDATE ops_vendors SET status=?, updated=? WHERE id=?', status, now(), v.id);
  await log({ actor_kind: actorKind, actor_user: by && by.id, actor_name: who(by), action_type: 'vendor.status', description: `${v.ref} ${v.name}: ${v.status} → ${status}${reason ? ' (' + str(reason, 200) + ')' : ''}`, related_type: 'vendor', related_id: v.ref });
  return { ref: v.ref, from: v.status, to: status };
}
// A person with approver authority (level 2 or higher) changes a status directly; everyone else, and the AI, must ask (see gateway supplier.status_change).
async function changeStatusByPerson(user, id, status, reason) {
  const AP = require('./approvals'), a = await AP.approverOf(user);
  if (!a || a.max_level < 2) fail(403, 'Changing a supplier status needs supervisor approval. Ask an approver, or ask the AI to request it.');
  const out = await applyStatus(user, id, status, reason, 'human');
  await require('./approvals').recordStep('vendor', out.ref, 'supplier_approve', 'user:' + user.id);
  return out;
}

/* ---------------- requests ---------------- */
const reqOut = (r) => ({ ...r, id: n(r.id), product_id: n(r.product_id), qty: n(r.qty), target_price: n(r.target_price), est_budget: n(r.est_budget), required_by: n(r.required_by), created: n(r.created), updated: n(r.updated) });
const listRequests = async (status) => (await all(`SELECT r.*, (SELECT COUNT(*) FROM ops_quotations q WHERE q.request_id=r.id) quotes FROM ops_requests r ${status ? 'WHERE r.status=?' : "WHERE r.status NOT IN ('closed','cancelled')"} ORDER BY CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, r.id DESC LIMIT 200`, ...(status ? [status] : []))).map((r) => ({ ...reqOut(r), quotes: n(r.quotes) }));
async function createRequest(by, b, source = 'manual', basis = null) {
  const qty = int(b.qty); if (qty < 1) fail(400, 'How many do you need?');
  const dest = b.destination === 'wholesale' ? 'wholesale' : 'retail', pid = b.product_id ? int(b.product_id) : null;
  let desc = str(b.description, 300), sku = str(b.sku, 60);
  if (pid) { const p = await get('SELECT name, sku FROM products WHERE id=?', pid); if (!p) fail(404, 'That product was not found.'); desc = desc || p.name; sku = sku || p.sku || ''; }
  if (!desc) fail(400, 'Describe what you need.');
  const t = now(), cur = str(b.currency, 3).toUpperCase() || 'NGN';
  const r = pid ? await get(`INSERT INTO ops_requests (product_id,sku,description,qty,target_price,currency,required_by,destination,justification,est_budget,department,priority,source,status,basis,created,updated,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?::jsonb,?,?,?) ON CONFLICT (product_id, destination) WHERE product_id IS NOT NULL AND status IN ('open','quoted','po_drafted') DO NOTHING RETURNING *`, pid, sku, desc, qty, b.target_price === '' || b.target_price == null ? null : Number(b.target_price), cur, b.required_by ? int(b.required_by) : null, dest, str(b.justification, 500), b.est_budget ? Number(b.est_budget) : null, str(b.department, 60) || 'Operations', ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal', source, basis ? JSON.stringify(basis) : null, t, t, by ? who(by) : St.AI_NAME)
    : await get(`INSERT INTO ops_requests (product_id,sku,description,qty,target_price,currency,required_by,destination,justification,est_budget,department,priority,source,status,basis,created,updated,created_by)
      VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,'open',?::jsonb,?,?,?) RETURNING *`, sku, desc, qty, b.target_price === '' || b.target_price == null ? null : Number(b.target_price), cur, b.required_by ? int(b.required_by) : null, dest, str(b.justification, 500), b.est_budget ? Number(b.est_budget) : null, str(b.department, 60) || 'Operations', ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal', source, basis ? JSON.stringify(basis) : null, t, t, by ? who(by) : St.AI_NAME);
  if (!r) return { duplicate: true };
  await log({ actor_kind: by ? 'human' : 'ai_autonomous', actor_user: by && by.id, actor_name: who(by), action_type: 'procurement.request', description: `${r.ref}: ${qty} × ${desc} (${dest})`, related_type: 'request', related_id: r.ref, result: { basis } });
  return reqOut(r);
}
// Requests from real stock. Retail and wholesale are worked out separately and never added together. The numbers behind each request are saved in `basis`.
async function recommendFromStock(by) {
  const rs = await D.retailStock(), made = [], skipped = [];
  for (const c of rs.reorder_candidates) {
    const r = await createRequest(by, { product_id: c.id, qty: c.recommended_qty, destination: 'retail', priority: c.days_of_cover != null && c.days_of_cover < 7 ? 'high' : 'normal', justification: `Stock ${c.stock} (+${c.incoming} incoming), selling ${c.avg_daily_demand}/day, ${c.days_of_cover} days of cover left; reorder point ${c.reorder_point}.` }, 'ai_stock', { stock: c.stock, incoming: c.incoming, sold_30d: c.sold_30d, avg_daily_demand: c.avg_daily_demand, days_of_cover: c.days_of_cover, reorder_point: c.reorder_point, assumptions: rs.assumptions });
    (r.duplicate ? skipped : made).push(r.duplicate ? c.name : r.ref);
  }
  const wh = await all(`SELECT p.id, p.name, SUM(b.on_hand-b.reserved) avail, MAX(b.reorder_level) lvl FROM wholesale_stock_balances b JOIN products p ON p.id=b.product_id WHERE b.reorder_level>0 GROUP BY p.id, p.name HAVING SUM(b.on_hand-b.reserved) <= MAX(b.reorder_level) ORDER BY SUM(b.on_hand-b.reserved) LIMIT 25`);
  for (const w of wh) {
    const qty = Math.max(1, Number(w.lvl) * 2 - Number(w.avail));
    const r = await createRequest(by, { product_id: w.id, qty, destination: 'wholesale', justification: `Wholesale stock available ${w.avail}, at or below the reorder level ${w.lvl}. Quantity brings it back to twice the reorder level.` }, 'ai_stock', { available: Number(w.avail), reorder_level: Number(w.lvl), rule: 'order up to 2 × reorder level' });
    (r.duplicate ? skipped : made).push(r.duplicate ? w.name : r.ref);
  }
  return { created: made, already_open: skipped.length };
}
async function cancelRequest(user, id, reason) {
  const r = await get('SELECT * FROM ops_requests WHERE id=?', int(id)); if (!r) fail(404, 'Request not found.');
  if (['closed', 'cancelled'].includes(r.status)) fail(409, `This request is ${r.status}.`);
  if (await get("SELECT id FROM ops_purchase_orders WHERE request_id=? AND status NOT IN ('cancelled')", r.id)) fail(409, 'A purchase order exists for this request. Cancel that first.');
  await run("UPDATE ops_requests SET status='cancelled', updated=? WHERE id=?", now(), r.id);
  await log({ actor_kind: 'human', actor_user: user.id, actor_name: who(user), action_type: 'procurement.cancel', description: `${r.ref} cancelled${reason ? ': ' + str(reason, 200) : ''}`, related_type: 'request', related_id: r.ref });
}

/* ---------------- quotations ---------------- */
async function addQuotation(user, requestId, b) {
  const req = await get('SELECT * FROM ops_requests WHERE id=?', int(requestId)); if (!req) fail(404, 'Request not found.');
  if (['closed', 'cancelled'].includes(req.status)) fail(409, 'This request is closed.');
  const v = await vendorById(b.vendor_id), price = Number(b.unit_price);
  if (!Number.isFinite(price) || price < 0) fail(400, 'Enter the unit price the vendor quoted.');
  const source = ['vendor_quote', 'vendor_catalogue', 'verbal', 'manual'].includes(b.source) ? b.source : ''; if (!source) fail(400, 'Say where this price came from (vendor quote, catalogue, verbal or manual).');
  if (['vendor_quote', 'vendor_catalogue'].includes(source) && !str(b.source_ref, 200)) fail(400, 'Reference the email, document or page the price came from.');
  const cur = str(b.currency, 3).toUpperCase() || v.currency; if (!/^[A-Z]{3}$/.test(cur)) fail(400, 'Currency must be a 3-letter code.');
  const incoterm = require('../trade-landed').INCOTERMS.includes(String(b.incoterm || '').toUpperCase()) ? String(b.incoterm).toUpperCase() : 'DAP';
  const z = (x) => Math.max(0, Number(x) || 0), opt = (x) => (x === '' || x == null ? null : int(x));
  const r = await run(`INSERT INTO ops_quotations (request_id,vendor_id,unit_price,currency,moq,qty_available,incoterm,freight,insurance,other_fees,duty_pct,vat_pct,clearing_fee,lead_days,payment_days,valid_until,source,source_ref,note,entered_by,created)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, req.id, v.id, price, cur, Math.max(1, int(b.moq) || 1), opt(b.qty_available), incoterm, z(b.freight), z(b.insurance), z(b.other_fees), Math.min(500, z(b.duty_pct)), Math.min(100, z(b.vat_pct)), z(b.clearing_fee), opt(b.lead_days), opt(b.payment_days), b.valid_until ? int(b.valid_until) : null, source, str(b.source_ref, 200), str(b.note, 300), who(user), now());
  const q = await get('SELECT * FROM ops_quotations WHERE id=?', r.lastInsertRowid);
  if (req.status === 'open') await run("UPDATE ops_requests SET status='quoted', updated=? WHERE id=?", now(), req.id);
  await log({ actor_kind: 'human', actor_user: user.id, actor_name: who(user), action_type: 'quotation.add', description: `${q.ref} from ${v.name} for ${req.ref}: ${cur} ${price} per unit (${source})`, related_type: 'request', related_id: req.ref });
  return q;
}

/* ---------------- compare ---------------- */
async function compare(requestId) {
  const req = await get('SELECT * FROM ops_requests WHERE id=?', int(requestId)); if (!req) fail(404, 'Request not found.');
  const quotes = await all('SELECT * FROM ops_quotations WHERE request_id=? ORDER BY id', req.id), entries = [];
  for (const q of quotes) { const v = vendorOut(await vendorById(q.vendor_id)); entries.push({ quote: { ...q, id: n(q.id), unit_price: n(q.unit_price), moq: n(q.moq), qty_available: n(q.qty_available), lead_days: n(q.lead_days), payment_days: n(q.payment_days), valid_until: n(q.valid_until), freight: n(q.freight), insurance: n(q.insurance), other_fees: n(q.other_fees), duty_pct: n(q.duty_pct), vat_pct: n(q.vat_pct), clearing_fee: n(q.clearing_fee) }, vendor: v, stats: await vendorStats(v.id), rating: await latestRating(v.id) }); }
  const out = PR.compare({ request: { qty: n(req.qty), target_price: n(req.target_price) }, entries, weights: await cfgWeights(), rates: await ratesNow() });
  return { request: reqOut(req), ...out, weights: await cfgWeights() };
}

/* ---------------- purchase orders ---------------- */
const poOut = (p) => ({ ...p, id: n(p.id), request_id: n(p.request_id), vendor_id: n(p.vendor_id), quotation_id: n(p.quotation_id), subtotal: n(p.subtotal), discount: n(p.discount), tax: n(p.tax), delivery: n(p.delivery), total: n(p.total), expected_date: n(p.expected_date), approval_id: n(p.approval_id), created: n(p.created), updated: n(p.updated), sent_at: n(p.sent_at) });
const poHash = (p) => P.hashPayload({ vendor_id: n(p.vendor_id), lines: p.lines, currency: p.currency, subtotal: n(p.subtotal), discount: n(p.discount), tax: n(p.tax), delivery: n(p.delivery), total: n(p.total), destination: p.destination, payment_terms: p.payment_terms, expected_date: n(p.expected_date) });
// Brings pending POs back to draft when their approval was rejected, sent back, expired or cancelled.
async function syncPending() {
  await run("UPDATE ops_purchase_orders p SET status='draft', approval_id=NULL, updated=? WHERE p.status='pending_approval' AND p.approval_id IS NOT NULL AND EXISTS (SELECT 1 FROM ops_approvals a WHERE a.id=p.approval_id AND a.status IN ('rejected','returned','expired','cancelled','failed'))", now());
}
async function listPOs(status) {
  await syncPending();
  const rows = await all(`SELECT p.*, v.name vendor_name, v.ref vendor_ref_code, a.ref approval_ref, a.status approval_status FROM ops_purchase_orders p JOIN ops_vendors v ON v.id=p.vendor_id LEFT JOIN ops_approvals a ON a.id=p.approval_id ${status ? 'WHERE p.status=?' : ''} ORDER BY p.id DESC LIMIT 200`, ...(status ? [status] : []));
  return rows.map((r) => ({ ...poOut(r), vendor_name: r.vendor_name, vendor_code: r.vendor_ref_code, approval_ref: r.approval_ref, approval_status: r.approval_status }));
}
// Drafts a PO from one quotation. A draft commits nothing. Unqualified vendors (not approved, quote expired, below minimum order...) cannot be drafted.
async function draftPO(actor, requestId, quotationId, { qty, byAi = false } = {}) {
  const cmp = await compare(requestId), row = cmp.rows.find((r) => Number(r.quote.id) === Number(quotationId));
  if (!row) fail(404, 'That quotation is not on this request.');
  if (!row.qualified) fail(409, 'This quotation cannot be used: ' + row.disqualified_because.join('; ') + '.');
  const req = cmp.request, q = row.quote, v = row.vendor, count = int(qty) || req.qty;
  if (count < q.moq) fail(400, `The minimum order is ${q.moq}.`); if (q.qty_available != null && count > q.qty_available) fail(400, `Only ${q.qty_available} available.`);
  const t = PR.poTotals({ vendor: v, quote: q, qty: count }), lines = [{ product_id: req.product_id, sku: req.sku, description: req.description, qty: count, unit_price: q.unit_price }];
  const settings = await S.getSettings().catch(() => ({})), expected = q.lead_days != null ? now() + q.lead_days * 86400 : null;
  const terms = `Prices in ${q.currency}. ${v.country !== 'NG' ? `Incoterm ${q.incoterm}. Import duty, VAT and clearing are paid separately at customs. ` : ''}Goods to be supplied as described, in the quantity above, to the delivery address shown. Any change to price, quantity or date needs written agreement from ${settings.store_name || 'VELTO-MART'}. This order is not valid until approved and issued.`;
  let po;
  try {
    po = await get(`INSERT INTO ops_purchase_orders (request_id,vendor_id,quotation_id,lines,currency,subtotal,discount,tax,delivery,total,destination,expected_date,payment_terms,terms,status,created_by_kind,created_by,created,updated)
      VALUES (?,?,?,?::jsonb,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?) RETURNING *`, req.id, v.id, q.id, JSON.stringify(lines), q.currency, t.subtotal, 0, t.tax, t.delivery, t.total, req.destination, expected, q.payment_days != null ? `${q.payment_days} days` : v.payment_terms, terms, byAi ? 'ai' : 'user', byAi ? St.AI_NAME : who(actor), now(), now());
  } catch (e) { if (e.code === '23505') fail(409, 'There is already a purchase order for this request and vendor.'); throw e; }
  await run("UPDATE ops_requests SET status='po_drafted', updated=? WHERE id=? AND status IN ('open','quoted')", now(), req.id);
  await log({ actor_kind: byAi ? 'ai_autonomous' : 'human', actor_user: actor && actor.id, actor_name: who(actor), action_type: 'po.draft', description: `${po.ref} drafted for ${v.name}: ${q.currency} ${t.total} (${req.ref}, quotation ${q.ref})`, related_type: 'po', related_id: po.ref, data_used: { quotation: q.ref, landed_ngn: row.landed.ngn, score: row.evaluation.score } });
  return poOut(po);
}
// Asks for approval of a draft PO through the gateway (rules, levels, two-person, split detection all apply). Returns what the backend says.
async function requestPOApproval(ctx, poId, justification) {
  await syncPending();
  const po = await get('SELECT p.*, v.name vendor_name, v.status vendor_status FROM ops_purchase_orders p JOIN ops_vendors v ON v.id=p.vendor_id WHERE p.id=?', int(poId)); if (!po) fail(404, 'Purchase order not found.');
  if (po.status !== 'draft') fail(409, `This purchase order is ${po.status.replace('_', ' ')}.`);
  if (!PR.QUALIFIED.includes(po.vendor_status)) fail(409, `${po.vendor_name} is "${po.vendor_status.replace('_', ' ')}", so no order can go to them.`);
  const r = await require('./gateway').perform(ctx, 'po.create', { summary: `Purchase order ${po.ref} to ${po.vendor_name}`, justification: str(justification, 600) || `Replenishment ${po.ref}`, amount: n(po.total), currency: po.currency, counterparty: po.vendor_name, related_type: 'po', related_id: po.ref, payload: { po_id: n(po.id), po_hash: poHash(po) } });
  if (r.status === 'pending_approval') { const a = await get('SELECT id FROM ops_approvals WHERE ref=?', r.approval); await run("UPDATE ops_purchase_orders SET status='pending_approval', approval_id=?, updated=? WHERE id=?", a.id, now(), po.id); }
  return r;
}
// Runs when the approval engine carries out an approved po.create. It checks the PO still says exactly what was approved.
async function approvePO(payload) {
  const po = await get('SELECT * FROM ops_purchase_orders WHERE id=?', int(payload.po_id)); if (!po) throw new Error('The purchase order no longer exists.');
  if (po.status !== 'pending_approval') throw new Error(`The purchase order is ${po.status}, not waiting for approval.`);
  if (poHash(po) !== payload.po_hash) throw new Error('The purchase order was changed after it was submitted. It was not approved; submit it again.');
  await run("UPDATE ops_purchase_orders SET status='approved', updated=? WHERE id=?", now(), po.id);
  return { po_ref: po.ref };
}
// A person tells us they sent the approved PO to the vendor (the AI does not send it).
async function markSent(user, id, b) {
  const po = await get('SELECT * FROM ops_purchase_orders WHERE id=?', int(id)); if (!po) fail(404, 'Purchase order not found.');
  if (po.status !== 'approved') fail(409, po.status === 'draft' ? 'This purchase order has not been approved yet.' : `This purchase order is ${po.status.replace('_', ' ')}.`);
  await run("UPDATE ops_purchase_orders SET status='sent', sent_at=?, sent_by=?, vendor_ref=?, updated=? WHERE id=?", now(), who(user), str(b.vendor_ref, 80), now(), po.id);
  await log({ actor_kind: 'human', actor_user: user.id, actor_name: who(user), action_type: 'po.sent', description: `${po.ref} recorded as sent to the vendor`, related_type: 'po', related_id: po.ref });
}
const NEXT = { sent: ['accepted', 'cancelled'], accepted: ['dispatched', 'cancelled'], dispatched: [], draft: ['cancelled'], pending_approval: [], approved: ['cancelled'] };
async function setPOStatus(user, id, status, note) {
  const po = await get('SELECT * FROM ops_purchase_orders WHERE id=?', int(id)); if (!po) fail(404, 'Purchase order not found.');
  if (!(NEXT[po.status] || []).includes(status)) fail(409, `A ${po.status.replace('_', ' ')} purchase order cannot move to ${status}.`);
  await run('UPDATE ops_purchase_orders SET status=?, updated=? WHERE id=?', status, now(), po.id);
  if (status === 'cancelled') { if (po.approval_id) await run("UPDATE ops_approvals SET status='cancelled', updated=? WHERE id=? AND status IN ('pending','approved')", now(), po.approval_id); await run("UPDATE ops_requests SET status='quoted', updated=? WHERE id=? AND status='po_drafted'", now(), po.request_id); }
  await log({ actor_kind: 'human', actor_user: user.id, actor_name: who(user), action_type: 'po.status', description: `${po.ref}: ${po.status} → ${status}${note ? ' (' + str(note, 150) + ')' : ''}`, related_type: 'po', related_id: po.ref });
}
// Goods receipt: a person records what really arrived. The AI cannot do this. The same person cannot also authorise the payment (see policy SOD).
async function recordReceipt(user, id, b) {
  const po = await get('SELECT * FROM ops_purchase_orders WHERE id=?', int(id)); if (!po) fail(404, 'Purchase order not found.');
  if (!['sent', 'accepted', 'dispatched'].includes(po.status)) fail(409, po.status === 'received' ? 'Goods for this order were already recorded.' : 'Only an order that has been sent to the vendor can be received.');
  const AP = require('./approvals'), problem = P.sodConflict(await AP.stepsFor('po', po.ref), 'goods_receipt', 'user:' + user.id); if (problem) fail(403, problem);
  const ordered = (po.lines || []).reduce((a, l) => a + Number(l.qty), 0), got = int(b.qty_received); if (got < 0 || got > ordered * 1.5) fail(400, 'Check the quantity received.');
  const at = b.received_at ? int(b.received_at) : now(), onTime = po.expected_date == null || at <= Number(po.expected_date) + 86400 ? 1 : 0;
  await tx(async () => {
    await run('INSERT INTO ops_po_receipts (po_id,qty_ordered,qty_received,received_at,on_time,note,received_by,created) VALUES (?,?,?,?,?,?,?,?)', po.id, ordered, got, at, onTime, str(b.note, 300), who(user), now());
    await run("UPDATE ops_purchase_orders SET status='received', updated=? WHERE id=?", now(), po.id);
    if (po.request_id) await run("UPDATE ops_requests SET status='closed', updated=? WHERE id=?", now(), po.request_id);
  });
  await AP.recordStep('po', po.ref, 'goods_receipt', 'user:' + user.id);
  await log({ actor_kind: 'human', actor_user: user.id, actor_name: who(user), action_type: 'po.receipt', description: `${po.ref}: ${got} of ${ordered} received${onTime ? '' : ' (late)'}. Stock is NOT changed here: receive it in the warehouse or catalogue as usual.`, related_type: 'po', related_id: po.ref, result: { ordered, received: got, on_time: !!onTime } });
  if (got < ordered) await St.raiseException({ kind: 'po_short', severity: 'medium', title: `${po.ref} arrived short: ${got} of ${ordered}`, detail: 'Quantity received is below the quantity ordered.', impact: 'Stock will be lower than planned.', recommended_action: 'Contact the vendor about the shortfall.', department: 'procurement', related_type: 'po', related_id: po.ref, dedupe_key: 'po_short:' + po.id, auto: false, detected_by: 'procurement' });
}

/* ---------------- PO document ---------------- */
async function poPdf(id) {
  const po = await get('SELECT * FROM ops_purchase_orders WHERE id=?', int(id)); if (!po) fail(404, 'Purchase order not found.');
  const v = await vendorById(po.vendor_id), s = await S.getSettings().catch(() => ({})), a = po.approval_id ? await get('SELECT ref, status FROM ops_approvals WHERE id=?', po.approval_id) : null;
  const d = (t) => (t ? new Date(Number(t) * 1000).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos' }) : '');
  const m = (x) => `${po.currency} ${Number(x).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const approved = ['approved', 'sent', 'accepted', 'dispatched', 'received'].includes(po.status);
  const blocks = [{ text: s.store_name || 'VELTO-MART', font: 'HB', size: 16, gap: 2 }, { text: [s.address, s.contact_phone || s.phone, s.contact_email || s.email].filter(Boolean).join(' · '), size: 9, gap: 10 },
    { text: 'PURCHASE ORDER ' + po.ref, font: 'HB', size: 13, gap: 2 }, { text: approved ? `Status: ${po.status.toUpperCase()}${a ? ' · approval ' + a.ref : ''}` : 'DRAFT: NOT APPROVED. DO NOT ACT ON THIS DOCUMENT.', font: 'HB', size: 10, gap: 8 },
    { text: 'Supplier', font: 'HB', gap: 1 }, { text: [v.name, v.location, v.country, v.email, v.phone].filter(Boolean).join(' · '), gap: 8 },
    { text: `Order date: ${d(po.created)}    Expected delivery: ${d(po.expected_date) || 'to be agreed'}    Deliver to: ${po.destination === 'wholesale' ? 'Wholesale warehouse' : 'Retail warehouse'}`, gap: 8 },
    { text: 'Items', font: 'HB', gap: 1 }, ...(po.lines || []).map((l) => ({ text: `${l.qty} × ${l.description}${l.sku ? ' [' + l.sku + ']' : ''} @ ${m(l.unit_price)} = ${m(l.qty * l.unit_price)}`, gap: 2 })),
    { text: '', gap: 6 }, { text: `Subtotal: ${m(po.subtotal)}`, gap: 1 }, ...(Number(po.discount) ? [{ text: `Discount: -${m(po.discount)}`, gap: 1 }] : []), { text: `Tax: ${m(po.tax)}`, gap: 1 }, { text: `Delivery and other charges: ${m(po.delivery)}`, gap: 1 }, { text: `TOTAL: ${m(po.total)}`, font: 'HB', size: 11, gap: 8 },
    { text: `Payment terms: ${po.payment_terms || 'as agreed'}`, gap: 6 }, { text: 'Terms', font: 'HB', gap: 1 }, { text: po.terms, size: 9, gap: 8 },
    { text: approved ? `Authorised through the VELTO-MART approval process${a ? ' (' + a.ref + ')' : ''}.` : 'Approval pending.', size: 9 }];
  return require('../pdf').build(blocks, { title: 'Purchase order ' + po.ref });
}

module.exports = { listVendors, vendorById, createVendor, updateVendor, setVerification, rateVendor, applyStatus, changeStatusByPerson, listRequests, createRequest, recommendFromStock, cancelRequest, addQuotation, compare, listPOs, draftPO, requestPOApproval, approvePO, markSent, setPOStatus, recordReceipt, poPdf, poHash, vendorStats, KINDS };
