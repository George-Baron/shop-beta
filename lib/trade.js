'use strict';
// Shipment records for imports and exports: who, what, how it travels (Incoterm, forwarder, container or airway bill, ETA), customs status,
// numbered documents and attached files. Admin only. The values here are cost and price data and are never sent to a customer or a supplier.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const C = require('./countries');
const FX = require('./fx');
const L = require('./trade-landed');
const TC = require('./trade-compliance');
const storage = require('./storage');
const SUP = require('./suppliers');
const { fail, str, int } = S;

const STATUSES = ['draft', 'booked', 'in_transit', 'arrived', 'cleared', 'delivered', 'cancelled'];
const NEXT = { draft: ['booked', 'cancelled'], booked: ['draft', 'in_transit', 'cancelled'], in_transit: ['arrived', 'cancelled'], arrived: ['cleared', 'cancelled'], cleared: ['delivered'], delivered: [], cancelled: ['draft'] };
const CUSTOMS = ['not_started', 'docs_ready', 'submitted', 'queried', 'held', 'cleared'];
const TRANSPORT = ['air', 'sea', 'road', 'courier', 'rail'];
const FILE_KINDS = ['bill_of_lading', 'airway_bill', 'certificate', 'permit', 'invoice', 'packing_list', 'customs', 'insurance', 'other'];
const DOCS = { commercial_invoice: { prefix: 'CI', label: 'Commercial invoice' }, packing_list: { prefix: 'PL', label: 'Packing list' }, proforma: { prefix: 'PF', label: 'Proforma invoice' }, purchase_order: { prefix: 'TPO', label: 'Purchase order' }, customs_sheet: { prefix: 'CD', label: 'Customs data sheet' } };
const LOCKED = ['in_transit', 'arrived', 'cleared', 'delivered'];          // from here the goods and values on the documents no longer change
const who = (u) => (u && (u.name || u.email)) || 'admin';
const day = (v, label) => { if (v == null || v === '') return null; const t = Date.parse(String(v).slice(0, 10) + 'T00:00:00Z'); if (!Number.isFinite(t)) fail(400, `${label} is not a valid date.`); return Math.floor(t / 1000); };
const num = (v, label, max = 1e12) => { if (v == null || v === '') return 0; const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) fail(400, `${label} must be a number of zero or more.`); return n; };
const rates = () => require('./dropship').rates();

/* ---------- our own company details, printed on every document ---------- */
const CO_KEYS = ['co_name', 'co_address', 'co_tax_id', 'co_rc', 'co_phone', 'co_email', 'co_bank_note'];
async function company() {
  const [st, rows] = await Promise.all([S.getSettings(), all("SELECT key, value FROM dropship_settings WHERE key LIKE 'co\\_%'")]);
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { name: v.co_name || st.store_name || '', address: v.co_address || st.address || '', tax_id: v.co_tax_id || '', rc: v.co_rc || '', phone: v.co_phone || st.contact_phone || '', email: v.co_email || st.contact_email || '', bank_note: v.co_bank_note || '' };
}
async function saveCompany(b) {
  const lim = { co_name: 120, co_address: 300, co_tax_id: 40, co_rc: 40, co_phone: 40, co_email: 120, co_bank_note: 300 };
  for (const k of CO_KEYS) if (b[k] !== undefined) await run('INSERT INTO dropship_settings (key,value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', k, str(b[k], lim[k]));
  return company();
}

/* ---------- reading ---------- */
const money = (v) => (v == null ? 0 : Number(v));
function shape(r) {
  return { ...r, id: Number(r.id), supplier_id: r.supplier_id == null ? null : Number(r.supplier_id), eta: r.eta == null ? null : Number(r.eta), etd: r.etd == null ? null : Number(r.etd),
    freight: money(r.freight), insurance: money(r.insurance), duty_pct: money(r.duty_pct), vat_pct: money(r.vat_pct), agent_fee: money(r.agent_fee), other_fees: money(r.other_fees),
    gross_weight_kg: r.gross_weight_kg == null ? null : Number(r.gross_weight_kg), fx_rate: r.fx_rate == null ? null : Number(r.fx_rate), packages: r.packages == null ? null : Number(r.packages),
    locked: LOCKED.includes(r.status), next: NEXT[r.status] || [] };
}
const itemShape = (i) => ({ ...i, id: Number(i.id), product_id: i.product_id == null ? null : Number(i.product_id), qty: Number(i.qty), unit_value: Number(i.unit_value), weight_kg: i.weight_kg == null ? null : Number(i.weight_kg), total: Math.round(Number(i.unit_value) * Number(i.qty) * 100) / 100 });
async function load(id) { const r = await get('SELECT * FROM trade_shipments WHERE id=?', int(id)); if (!r) fail(404, 'Shipment not found.'); return shape(r); }
const items = async (id) => (await all('SELECT * FROM trade_items WHERE shipment_id=? ORDER BY sort, id', int(id))).map(itemShape);

async function list({ status, direction, q } = {}) {
  const w = [], p = [];
  if (STATUSES.includes(status)) { w.push('s.status=?'); p.push(status); }
  if (['import', 'export'].includes(direction)) { w.push('s.direction=?'); p.push(direction); }
  if (q) { w.push("(lower(s.ref) LIKE ? OR lower(s.party_name) LIKE ? OR lower(s.bill_no) LIKE ? OR lower(s.container_no) LIKE ?)"); const l = '%' + String(q).toLowerCase().slice(0, 60) + '%'; p.push(l, l, l, l); }
  const rows = await all(`SELECT s.*, (SELECT COALESCE(SUM(unit_value*qty),0) FROM trade_items i WHERE i.shipment_id=s.id) goods, (SELECT COUNT(*) FROM trade_items i WHERE i.shipment_id=s.id) item_count FROM trade_shipments s ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 300`, ...p);
  return rows.map((r) => ({ ...shape(r), goods: Math.round(Number(r.goods) * 100) / 100, item_count: Number(r.item_count) }));
}

// The numbers on the shipment, worked out with the Incoterm and today's exchange rates (for the Naira figure).
async function landedFor(ship, its, show_in = 'NGN') {
  const goods = its.reduce((a, i) => a + i.unit_value * i.qty, 0);
  let rs = {}; try { rs = await rates(); } catch { /* the Naira figure is simply left out below */ }
  const input = { direction: ship.direction, incoterm: ship.incoterm, currency: ship.currency, goods, freight: ship.freight, insurance: ship.insurance, duty_pct: ship.duty_pct, vat_pct: ship.vat_pct, agent_fee: ship.agent_fee, other_fees: ship.other_fees };
  try { return L.landed({ ...input, show_in }, rs); } catch (e) { try { return { ...L.landed(input, rs), convert_error: e.message }; } catch (e2) { return { error: e2.message }; } }
}

async function detail(id) {
  const ship = await load(id), its = await items(id);
  const itemClasses = []; for (const i of its) { const c = await TC.classify({ name: i.description, hs_code: i.hs_code }); if (c.action) itemClasses.push(...c.hits.map((h) => h.slug)); }
  const supplier = ship.supplier_id ? await get('SELECT id, name, country, currency FROM suppliers WHERE id=?', ship.supplier_id) : null;
  return { shipment: ship, items: its, supplier, landed: await landedFor(ship, its), issued: await all('SELECT kind, number, issued, issued_by FROM trade_issued WHERE shipment_id=? ORDER BY id', ship.id),
    files: await files(ship.id), events: await events(ship.id), checklist: await TC.checklist(ship, [...new Set(itemClasses)]), item_classes: [...new Set(itemClasses)],
    net_weight_kg: Math.round(its.reduce((a, i) => a + (i.weight_kg || 0) * i.qty, 0) * 1000) / 1000, docs: DOCS };
}

/* ---------- writing ---------- */
const nextRef = async () => { const n = (await get("SELECT COALESCE(MAX(CAST(substring(ref from 4) AS INTEGER)),0)+1 n FROM trade_shipments WHERE ref ~ '^SH-[0-9]+$'")).n; return 'SH-' + String(n).padStart(5, '0'); };
async function parse(b, cur = {}) {
  const v = (k) => (b[k] !== undefined ? b[k] : cur[k]);
  const d = {};
  d.direction = v('direction') === 'export' ? 'export' : v('direction') === 'import' ? 'import' : fail(400, 'Choose import or export.');
  d.incoterm = String(v('incoterm') || 'FOB').toUpperCase(); if (!L.INCOTERMS.includes(d.incoterm)) fail(400, 'Choose an Incoterm from the list.');
  d.currency = String(v('currency') || 'USD').toUpperCase(); if (!C.isCurrency(d.currency)) fail(400, 'Choose a currency.');
  d.supplier_id = v('supplier_id') ? int(v('supplier_id')) : null;
  let sup = null; if (d.supplier_id) { sup = await get('SELECT * FROM suppliers WHERE id=?', d.supplier_id); if (!sup) fail(400, 'That supplier does not exist.'); }
  d.party_name = str(v('party_name'), 140) || (sup ? sup.name : ''); if (!d.party_name) fail(400, d.direction === 'import' ? 'Enter the supplier (the seller).' : 'Enter the buyer.');
  d.party_address = str(v('party_address'), 300) || (sup ? sup.address || '' : ''); d.party_tax_id = str(v('party_tax_id'), 40); d.party_contact = str(v('party_contact'), 160) || (sup ? [sup.contact_name, sup.email].filter(Boolean).join(', ') : '');
  const pc = str(v('party_country'), 2).toUpperCase() || (sup ? sup.country : ''); d.party_country = pc || null; if (pc && !C.isCountry(pc)) fail(400, 'The other party country is not valid.');
  for (const k of ['origin_country', 'dest_country']) { d[k] = String(v(k) || '').toUpperCase(); if (!C.isCountry(d[k])) fail(400, k === 'origin_country' ? 'Choose the country the goods leave from.' : 'Choose the country the goods go to.'); }
  if (d.origin_country === d.dest_country) fail(400, 'The goods must cross a border: choose two different countries.');
  d.transport = TRANSPORT.includes(v('transport')) ? v('transport') : 'air';
  d.forwarder = str(v('forwarder'), 120); d.forwarder_contact = str(v('forwarder_contact'), 160); d.container_no = str(v('container_no'), 40); d.bill_no = str(v('bill_no'), 40);
  d.port_of_loading = str(v('port_of_loading'), 80); d.port_of_discharge = str(v('port_of_discharge'), 80);
  d.eta = b.eta !== undefined ? day(b.eta, 'The ETA') : cur.eta == null ? null : cur.eta; d.etd = b.etd !== undefined ? day(b.etd, 'The departure date') : cur.etd == null ? null : cur.etd;
  d.customs_status = CUSTOMS.includes(v('customs_status')) ? v('customs_status') : 'not_started';
  d.packages = v('packages') === '' || v('packages') == null ? null : Math.round(num(v('packages'), 'Packages', 100000));
  d.gross_weight_kg = v('gross_weight_kg') === '' || v('gross_weight_kg') == null ? null : num(v('gross_weight_kg'), 'Gross weight', 1e7);
  d.freight = num(v('freight'), 'Freight'); d.insurance = num(v('insurance'), 'Insurance'); d.agent_fee = num(v('agent_fee'), 'The clearing agent fee'); d.other_fees = num(v('other_fees'), 'Other charges');
  for (const [k, max, label] of [['duty_pct', 500, 'Duty'], ['vat_pct', 100, 'VAT']]) { d[k] = num(v(k), label, max); }
  d.notes = str(v('notes'), 1000);
  return d;
}
async function fxSnapshot(currency) { if (currency === 'NGN') return null; try { const r = (await rates())[currency]; return r > 0 ? r : null; } catch { return null; } }
async function event(id, kind, note, user) { await run('INSERT INTO trade_events (shipment_id,kind,note,actor,created) VALUES (?,?,?,?,?)', id, kind, str(note, 300), who(user), now()); }
const events = (id) => all('SELECT kind, note, actor, created FROM trade_events WHERE shipment_id=? ORDER BY id DESC LIMIT 100', int(id));

async function create(user, b) {
  const d = await parse(b);
  const t = now(), fx = await fxSnapshot(d.currency);
  for (let k = 0; k < 5; k++) {
    try {
      const id = await tx(async () => {
        const ref = await nextRef();
        const id = Number((await run(`INSERT INTO trade_shipments (ref,direction,incoterm,currency,supplier_id,party_name,party_address,party_country,party_tax_id,party_contact,origin_country,dest_country,transport,forwarder,forwarder_contact,container_no,bill_no,port_of_loading,port_of_discharge,eta,etd,customs_status,packages,gross_weight_kg,freight,insurance,duty_pct,vat_pct,agent_fee,other_fees,fx_rate,notes,created,created_by,updated)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref, d.direction, d.incoterm, d.currency, d.supplier_id, d.party_name, d.party_address, d.party_country, d.party_tax_id, d.party_contact, d.origin_country, d.dest_country, d.transport, d.forwarder, d.forwarder_contact, d.container_no, d.bill_no, d.port_of_loading, d.port_of_discharge, d.eta, d.etd, d.customs_status, d.packages, d.gross_weight_kg, d.freight, d.insurance, d.duty_pct, d.vat_pct, d.agent_fee, d.other_fees, fx, d.notes, t, who(user), t)).lastInsertRowid);
        await event(id, 'created', `${d.direction} ${d.origin_country} to ${d.dest_country}`, user); return id;
      });
      return id;
    } catch (e) { if (!/trade_shipments_ref_key|duplicate key/.test(String(e.message))) throw e; }   // two people created one at once: take the next number
  }
  fail(503, 'Could not number the shipment. Please try again.');
}
async function update(user, id, b) {
  const cur = await load(id);
  if (cur.status === 'cancelled' || cur.status === 'delivered') fail(409, `A ${cur.status} shipment cannot be changed.`);
  const d = await parse(b, cur);
  if (cur.locked) {                                                         // goods and values are fixed once the goods are moving
    for (const k of ['direction', 'incoterm', 'currency', 'origin_country', 'dest_country', 'freight', 'insurance', 'duty_pct', 'vat_pct', 'party_name', 'party_address']) if (String(d[k]) !== String(cur[k])) fail(409, 'The goods are already moving, so the values and parties on the documents are fixed. Change tracking details only, or cancel and create a new shipment.');
  }
  const fx = d.currency !== cur.currency ? await fxSnapshot(d.currency) : cur.fx_rate;
  await run(`UPDATE trade_shipments SET incoterm=?,currency=?,supplier_id=?,party_name=?,party_address=?,party_country=?,party_tax_id=?,party_contact=?,origin_country=?,dest_country=?,transport=?,forwarder=?,forwarder_contact=?,container_no=?,bill_no=?,port_of_loading=?,port_of_discharge=?,eta=?,etd=?,customs_status=?,packages=?,gross_weight_kg=?,freight=?,insurance=?,duty_pct=?,vat_pct=?,agent_fee=?,other_fees=?,fx_rate=?,notes=?,updated=? WHERE id=?`,
    d.incoterm, d.currency, d.supplier_id, d.party_name, d.party_address, d.party_country, d.party_tax_id, d.party_contact, d.origin_country, d.dest_country, d.transport, d.forwarder, d.forwarder_contact, d.container_no, d.bill_no, d.port_of_loading, d.port_of_discharge, d.eta, d.etd, d.customs_status, d.packages, d.gross_weight_kg, d.freight, d.insurance, d.duty_pct, d.vat_pct, d.agent_fee, d.other_fees, fx, d.notes, now(), cur.id);
  if (d.customs_status !== cur.customs_status) await event(cur.id, 'customs', `Customs status: ${cur.customs_status.replace('_', ' ')} to ${d.customs_status.replace('_', ' ')}`, user);
}
async function setStatus(user, id, to, note) {
  const cur = await load(id); if (!STATUSES.includes(to)) fail(400, 'Unknown status.');
  if (cur.status === to) return { unchanged: true };
  if (!NEXT[cur.status].includes(to)) fail(409, `A ${cur.status.replace('_', ' ')} shipment cannot go to ${to.replace('_', ' ')}.`);
  if (to === 'booked' && !(await get('SELECT 1 x FROM trade_items WHERE shipment_id=?', cur.id))) fail(400, 'Add the goods first.');
  if (to === 'in_transit' && !cur.bill_no && !cur.container_no) fail(400, 'Enter the airway bill, bill of lading or container number first.');
  await tx(async () => {
    await run('UPDATE trade_shipments SET status=?, updated=?' + (to === 'cleared' ? ", customs_status='cleared'" : '') + ' WHERE id=?', to, now(), cur.id);
    await event(cur.id, 'status', `${cur.status.replace('_', ' ')} to ${to.replace('_', ' ')}${note ? ': ' + str(note, 200) : ''}`, user);
  });
  return { unchanged: false };
}
async function remove(user, id) {
  const cur = await load(id); if (cur.status !== 'draft' && cur.status !== 'cancelled') fail(409, 'Only a draft or cancelled shipment can be deleted. Cancel it first.');
  if (await get('SELECT 1 x FROM trade_issued WHERE shipment_id=?', cur.id)) fail(409, 'Documents were issued for this shipment, so it is kept for the records. Cancel it instead.');
  const fs = await all('SELECT file_key FROM trade_files WHERE shipment_id=?', cur.id);
  await run('DELETE FROM trade_shipments WHERE id=?', cur.id);
  for (const f of fs) storage.tradeDocs.remove(f.file_key).catch((e) => console.error('Could not delete trade file:', e.message));
}

/* ---------- items ---------- */
async function itemInput(b, ship) {
  const description = str(b.description, 200); if (!description) fail(400, 'Describe the goods.');
  const qty = int(b.qty); if (!(qty > 0 && qty <= 10000000)) fail(400, 'Quantity must be a whole number above zero.');
  const unit = Number(b.unit_value); if (!Number.isFinite(unit) || unit < 0 || unit > 1e9) fail(400, `Enter the value of one unit in ${ship.currency}.`);
  const hs = str(b.hs_code, 14); if (hs && !/^\d{4}([. ]?\d{2}){0,3}$/.test(hs)) fail(400, 'The HS code is 4 to 10 digits, like 8517.12 or 851712.');
  const origin = str(b.origin_country, 2).toUpperCase() || null; if (origin && !C.isCountry(origin)) fail(400, 'The country of origin is not valid.');
  const w = b.weight_kg === '' || b.weight_kg == null ? null : Number(b.weight_kg); if (w != null && (!Number.isFinite(w) || w < 0 || w > 100000)) fail(400, 'Weight must be zero or more (kg per unit).');
  const cl = await TC.classify({ name: description, hs_code: hs });
  if (cl.action === 'block') fail(400, `These goods cannot be shipped through the shop: they look like ${TC.explain(cl)}.`);
  return { description, qty, unit, hs, origin, w };
}
async function guardEditable(ship) { if (ship.locked || ship.status === 'cancelled') fail(409, 'The goods are fixed once the shipment is moving or cancelled.'); }
async function addItem(user, id, b) {
  const ship = await load(id); await guardEditable(ship);
  if ((await get('SELECT COUNT(*) n FROM trade_items WHERE shipment_id=?', ship.id)).n >= 200) fail(400, 'A shipment can hold up to 200 lines.');
  const i = await itemInput(b, ship);
  const r = await run('INSERT INTO trade_items (shipment_id,product_id,description,hs_code,origin_country,qty,unit_value,weight_kg,sort) VALUES (?,?,?,?,?,?,?,?,?)', ship.id, b.product_id ? int(b.product_id) : null, i.description, i.hs, i.origin, i.qty, i.unit, i.w, Number((await get('SELECT COALESCE(MAX(sort),0)+1 n FROM trade_items WHERE shipment_id=?', ship.id)).n));
  await run('UPDATE trade_shipments SET updated=? WHERE id=?', now(), ship.id);
  return Number(r.lastInsertRowid);
}
// Take the details from a dropship product: name, HS code, origin, weight, and the supplier price converted to the shipment currency.
async function addFromProduct(user, id, b) {
  const ship = await load(id); await guardEditable(ship);
  const p = await get(`SELECT p.id, p.name, dp.hs_code, dp.origin_country, dp.weight_kg, dp.cost, s.currency, s.country FROM products p JOIN dropship_products dp ON dp.product_id=p.id JOIN suppliers s ON s.id=dp.supplier_id WHERE p.id=?`, int(b.product_id));
  if (!p) fail(404, 'Dropship product not found.');
  let unit = Number(p.cost);
  if (p.currency !== ship.currency) { try { unit = FX.convert(unit, p.currency, ship.currency, await rates()); } catch (e) { fail(400, e.message + ' Add it in Dropshipping > Settings > Exchange rates.'); } }
  return addItem(user, id, { product_id: p.id, description: p.name, qty: b.qty || 1, unit_value: Math.round(unit * 10000) / 10000, hs_code: p.hs_code, origin_country: p.origin_country || p.country, weight_kg: p.weight_kg });
}
async function updateItem(user, id, itemId, b) {
  const ship = await load(id); await guardEditable(ship);
  const cur = await get('SELECT * FROM trade_items WHERE id=? AND shipment_id=?', int(itemId), ship.id); if (!cur) fail(404, 'Line not found.');
  const i = await itemInput({ description: cur.description, qty: cur.qty, unit_value: cur.unit_value, hs_code: cur.hs_code, origin_country: cur.origin_country, weight_kg: cur.weight_kg, ...b }, ship);
  await run('UPDATE trade_items SET description=?,hs_code=?,origin_country=?,qty=?,unit_value=?,weight_kg=? WHERE id=?', i.description, i.hs, i.origin, i.qty, i.unit, i.w, cur.id);
  await run('UPDATE trade_shipments SET updated=? WHERE id=?', now(), ship.id);
}
async function removeItem(user, id, itemId) { const ship = await load(id); await guardEditable(ship); await run('DELETE FROM trade_items WHERE id=? AND shipment_id=?', int(itemId), ship.id); await run('UPDATE trade_shipments SET updated=? WHERE id=?', now(), ship.id); }

/* ---------- document numbers (stable) and attached files ---------- */
async function issue(user, ship, kind) {
  const meta = DOCS[kind]; if (!meta) fail(400, 'Unknown document.');
  const have = await get('SELECT * FROM trade_issued WHERE shipment_id=? AND kind=?', ship.id, kind);
  if (have) return { number: have.number, issued: Number(have.issued) };
  if (ship.status === 'cancelled') fail(409, 'This shipment is cancelled.');
  if (!(await get('SELECT 1 x FROM trade_items WHERE shipment_id=?', ship.id))) fail(400, 'Add the goods before making documents.');
  const t = now(); let number;
  for (let k = 0; k < 5; k++) {
    const n = Number((await get('SELECT COUNT(*) n FROM trade_issued WHERE kind=?', kind)).n) + 1 + k;
    number = `${meta.prefix}-${String(n).padStart(5, '0')}`;
    try { await run('INSERT INTO trade_issued (shipment_id,kind,number,issued,issued_by) VALUES (?,?,?,?,?)', ship.id, kind, number, t, who(user)); await event(ship.id, 'document', `${meta.label} ${number} issued`, user); return { number, issued: t }; }
    catch (e) { const again = await get('SELECT * FROM trade_issued WHERE shipment_id=? AND kind=?', ship.id, kind); if (again) return { number: again.number, issued: Number(again.issued) }; if (!/duplicate key/.test(String(e.message))) throw e; }
  }
  fail(503, 'Could not number the document. Please try again.');
}
const files = (id) => all('SELECT id, kind, file_name, mime, bytes, created, created_by FROM trade_files WHERE shipment_id=? ORDER BY id DESC', int(id));
async function addFile(user, id, kind, buf, filename) {
  const ship = await load(id);
  if (!FILE_KINDS.includes(kind)) fail(400, 'Choose what kind of document this is.');
  if (!buf.length) fail(400, 'Please choose a file.');
  if (buf.length > 8_000_000) fail(400, 'That file is over 8 MB.');
  const type = SUP.FILE_TYPES.find((t) => t.test(buf)); if (!type) fail(400, 'Files must be a PDF, JPG, PNG or Word (.docx) file.');
  if ((await get('SELECT COUNT(*) n FROM trade_files WHERE shipment_id=?', ship.id)).n >= 40) fail(400, 'This shipment already has 40 files. Remove an old one first.');
  const key = `shipment-${ship.id}-${kind}-${crypto.randomBytes(6).toString('hex')}.${type.ext}`;
  await storage.tradeDocs.put(key, buf);
  const r = await run('INSERT INTO trade_files (shipment_id,kind,file_key,file_name,mime,bytes,created,created_by) VALUES (?,?,?,?,?,?,?,?)', ship.id, kind, key, str(filename, 100).replace(/[^\w .()-]/g, '_') || key, type.mime, buf.length, now(), who(user));
  await event(ship.id, 'file', `File added: ${kind.replace('_', ' ')}`, user);
  return Number(r.lastInsertRowid);
}
async function openFile(id, fileId) {
  const f = await get('SELECT * FROM trade_files WHERE id=? AND shipment_id=?', int(fileId), int(id)); if (!f) fail(404, 'File not found.');
  return { buf: await storage.tradeDocs.get(f.file_key), mime: f.mime, name: f.file_name };
}
async function removeFile(user, id, fileId) {
  const f = await get('SELECT * FROM trade_files WHERE id=? AND shipment_id=?', int(fileId), int(id)); if (!f) fail(404, 'File not found.');
  await run('DELETE FROM trade_files WHERE id=?', f.id); await event(int(id), 'file', `File removed: ${f.kind.replace('_', ' ')}`, user);
  storage.tradeDocs.remove(f.file_key).catch((e) => console.error('Could not delete trade file:', e.message));
}

module.exports = { STATUSES, NEXT, CUSTOMS, TRANSPORT, FILE_KINDS, DOCS, company, saveCompany, load, items, list, detail, landedFor, create, update, setStatus, remove, addItem, addFromProduct, updateItem, removeItem, issue, files, addFile, openFile, removeFile, event };
