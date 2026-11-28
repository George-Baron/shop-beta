'use strict';
// Customs declarations, readiness checks, duty/tax calculator and generated trade documents (PDF).
// A declaration is a record staff prepare and check here. This system does not file with any customs authority: "submitted" means staff filed it
// elsewhere (broker, customs portal) and enter that entry number. Duties are estimates unless a verified rule exists; nothing is assumed.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const FX = require('./fx');
const DU = require('./duties');
const PDF = require('./pdf');
const storage = require('../storage');
const { fail, str } = S;

const dstr = (d) => (d == null ? '' : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const rand = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const EDITABLE = ['draft', 'incomplete', 'ready'];
const NEXT = { draft: [], incomplete: [], ready: ['submitted'], submitted: ['cleared', 'held', 'rejected'], held: ['submitted', 'cleared', 'rejected'], rejected: ['draft'], cleared: [] };
const shape = (r) => ({ id: Number(r.id), ref: r.ref, direction: r.direction, export_ref: r.export_ref || undefined, import_ref: r.import_ref || undefined, export_country: r.export_country, import_country: r.import_country, incoterm: r.incoterm, currency: r.currency,
  declared_value: Number(r.declared_value), gross_weight_kg: r.gross_weight_kg == null ? null : Number(r.gross_weight_kg), net_weight_kg: r.net_weight_kg == null ? null : Number(r.net_weight_kg), packages: r.packages == null ? null : Number(r.packages), dimensions: r.dimensions,
  restrictions_note: r.restrictions_note, entry_number: r.entry_number, notes: r.notes, lines: r.lines || [], status: r.status, submitted_at: r.submitted_at == null ? null : Number(r.submitted_at), created: Number(r.created), updated: Number(r.updated) });
const SEL = 'SELECT c.*, eo.ref export_ref, ish.import_ref FROM customs_declarations c LEFT JOIN export_orders eo ON eo.id=c.export_order_id LEFT JOIN import_shipments ish ON ish.id=c.import_shipment_id';
async function load(id) { const r = await get(SEL + ' WHERE c.id=?', Number(id) || 0); if (!r) fail(404, 'Customs declaration not found.'); return r; }

/* ---------- lines and readiness ---------- */
function cleanLines(list) {
  if (!Array.isArray(list) || !list.length) fail(400, 'A declaration needs at least one line.'); if (list.length > 100) fail(400, 'A declaration can have up to 100 lines.');
  return list.map((l, i) => {
    const n = i + 1, qty = Number(l.qty), value = Number(l.value), w = l.weight_kg === '' || l.weight_kg == null ? null : Number(l.weight_kg);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000000) fail(400, `Line ${n}: quantity must be a whole number of 1 or more.`);
    if (!Number.isFinite(value) || value < 0 || value > 1e12) fail(400, `Line ${n}: enter the customs value (0 or more).`);
    if (w != null && (!Number.isFinite(w) || w < 0 || w > 1e6)) fail(400, `Line ${n}: weight must be 0 or more.`);
    const hs = String(l.hs_code || '').replace(/[^0-9.]/g, '').slice(0, 14), origin = String(l.origin_country || '').toUpperCase().slice(0, 2);
    return { product_id: l.product_id == null ? null : Number(l.product_id) || null, description: str(l.description, 200), hs_code: hs, origin_country: origin, qty, value: T.roundTo(value, 4), weight_kg: w };
  });
}
async function readiness(c) {
  const issues = [], B = (field, message) => issues.push({ level: 'block', field, message }), W = (field, message) => issues.push({ level: 'warn', field, message });
  const lines = c.lines || [];
  lines.forEach((l, i) => {
    const n = `Line ${i + 1}`;
    if (!l.description) B('lines', `${n}: add a customs description.`);
    if (String(l.hs_code || '').replace(/\D/g, '').length < 6) B('lines', `${n}: HS code needs at least 6 digits.`);
    if (!/^[A-Z]{2}$/.test(l.origin_country || '')) B('lines', `${n}: add the country of origin (2 letters).`);
    if (!(Number(l.value) > 0)) B('lines', `${n}: customs value must be above 0.`);
  });
  if (!(Number(c.gross_weight_kg) > 0)) B('gross_weight_kg', 'Enter the gross weight of the shipment.');
  if (!(Number(c.net_weight_kg) > 0)) B('net_weight_kg', 'Enter the net weight of the goods.');
  else if (Number(c.gross_weight_kg) > 0 && Number(c.net_weight_kg) > Number(c.gross_weight_kg)) B('net_weight_kg', 'Net weight cannot be more than gross weight.');
  if (!(Number(c.packages) >= 1)) B('packages', 'Enter the number of packages.');
  if (!c.incoterm) B('incoterm', 'Choose the Incoterm.');
  if (!c.dimensions) W('dimensions', 'Package dimensions are not entered.');
  const ids = lines.map((l) => l.product_id).filter(Boolean);
  if (ids.length) {
    const dir = c.direction, country = dir === 'export' ? c.import_country : c.import_country;
    const rs = await all(`SELECT r.product_id, r.reason, p.name FROM product_trade_restrictions r JOIN products p ON p.id=r.product_id WHERE r.country_code=? AND r.direction=? AND r.product_id = ANY(?::bigint[])`, country, dir, ids);
    for (const r of rs) B('restrictions', `${r.name} is restricted for ${dir} to/from ${country}${r.reason ? ': ' + r.reason : ''}.`);
  }
  if (c.restrictions_note) W('restrictions_note', 'Restrictions note: ' + c.restrictions_note);
  return { ready: !issues.some((x) => x.level === 'block'), issues };
}
const sumLines = (lines) => ({ value: T.roundTo(lines.reduce((a, l) => a + Number(l.value), 0), 4), weight: T.roundTo(lines.reduce((a, l) => a + (Number(l.weight_kg) || 0), 0), 3) });

/* ---------- create from an order / shipment ---------- */
async function fromExport(ref, user, ip) {
  const eo = await get('SELECT eo.* FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE eo.ref=? OR o.ref=?', String(ref || '').toUpperCase(), String(ref || '').toUpperCase()); if (!eo) fail(404, 'International order not found.');
  const ex = await get('SELECT id FROM customs_declarations WHERE export_order_id=?', eo.id); if (ex) return detail(ex.id);
  const items = await all('SELECT * FROM export_order_items WHERE export_order_id=? ORDER BY id', eo.id), st = await T.settings();
  const lines = items.map((i) => ({ product_id: Number(i.product_id), description: i.customs_description || i.description, hs_code: i.hs_code, origin_country: i.origin_country || '', qty: Number(i.qty), value: Number(i.declared_value), weight_kg: i.weight_kg == null ? null : T.roundTo(Number(i.weight_kg) * Number(i.qty), 3) }));
  const sm = sumLines(lines), t = now();
  let id; try {
    id = Number((await run("INSERT INTO customs_declarations (ref,export_order_id,direction,export_country,import_country,incoterm,declared_value,currency,net_weight_kg,lines,status,created,updated) VALUES (?,?,'export',?,?,?,?,?,?,?::jsonb,'incomplete',?,?)",
      'CD-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + rand(), eo.id, eo.origin_country, eo.destination_country, eo.duty_arrangement || st.default_incoterm, sm.value, eo.currency, sm.weight || null, JSON.stringify(lines), t, t)).lastInsertRowid);
  } catch (e) { if (e.code === '23505') { const x = await get('SELECT id FROM customs_declarations WHERE export_order_id=?', eo.id); return detail(x.id); } throw e; }
  await T.audit(user, 'customs.create', 'customs_declarations', id, { export: eo.ref }, ip);
  return detail(id);
}
async function fromImport(ref, user, ip) {
  const h = await get('SELECT * FROM import_shipments WHERE import_ref=?', String(ref || '').toUpperCase()); if (!h) fail(404, 'Import shipment not found.');
  const ex = await get('SELECT id FROM customs_declarations WHERE import_shipment_id=?', h.id); if (ex) return detail(ex.id);
  const items = await all('SELECT i.*, p.origin_country FROM import_shipment_items i LEFT JOIN product_trade_settings p ON p.product_id=i.product_id WHERE i.shipment_id=? ORDER BY i.id', h.id);
  const lines = items.map((i) => ({ product_id: i.product_id == null ? null : Number(i.product_id), description: i.description, hs_code: i.hs_code, origin_country: i.origin_country || h.supplier_country, qty: Number(i.qty_ordered), value: T.roundTo(Number(i.qty_ordered) * Number(i.unit_cost), 4), weight_kg: i.weight_kg == null ? null : T.roundTo(Number(i.weight_kg) * Number(i.qty_ordered), 3) }));
  const sm = sumLines(lines), t = now();
  let id; try {
    id = Number((await run("INSERT INTO customs_declarations (ref,import_shipment_id,direction,export_country,import_country,incoterm,declared_value,currency,net_weight_kg,lines,status,created,updated) VALUES (?,?,'import',?,?,?,?,?,?,?::jsonb,'incomplete',?,?)",
      'CD-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + rand(), h.id, h.supplier_country, h.destination_country, h.incoterm || '', sm.value, h.currency, sm.weight || null, JSON.stringify(lines), t, t)).lastInsertRowid);
  } catch (e) { if (e.code === '23505') { const x = await get('SELECT id FROM customs_declarations WHERE import_shipment_id=?', h.id); return detail(x.id); } throw e; }
  await T.audit(user, 'customs.create', 'customs_declarations', id, { import: h.import_ref }, ip);
  return detail(id);
}

/* ---------- read, list, edit ---------- */
async function docsOf(c) {
  const col = c.export_order_id ? 'export_order_id' : 'import_shipment_id', tid = c.export_order_id || c.import_shipment_id;
  return (await all(`SELECT id,doc_type,number,file_name,origin,version,status,size_bytes,created FROM trade_documents WHERE ${col}=? AND doc_type<>'shipping_label' ORDER BY id DESC`, tid)).map((d) => ({ id: Number(d.id), doc_type: d.doc_type, number: d.number, file_name: d.file_name, origin: d.origin, version: Number(d.version), status: d.status, size_bytes: Number(d.size_bytes), created: Number(d.created) }));
}
async function detail(id) { const c = await load(id), s = shape(c); return { declaration: s, readiness: await readiness(s), documents: await docsOf(c), next: NEXT[c.status] || [], editable: EDITABLE.includes(c.status) }; }
async function list(q = {}) {
  const where = [], args = [];
  if (['export', 'import'].includes(q.direction)) { where.push('c.direction=?'); args.push(q.direction); }
  if (q.status && Object.keys(NEXT).includes(q.status)) { where.push('c.status=?'); args.push(q.status); }
  if (q.q) { where.push('(c.ref ILIKE ? OR eo.ref ILIKE ? OR ish.import_ref ILIKE ? OR c.entry_number ILIKE ?)'); const l = '%' + String(q.q).replace(/[%_]/g, '').slice(0, 40) + '%'; args.push(l, l, l, l); }
  const rows = await all(`${SEL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.id DESC LIMIT 200`, ...args);
  return { declarations: rows.map((r) => { const s = shape(r); delete s.lines; return s; }) };
}
async function save(id, b, user, ip) {
  const c = await load(id); if (!EDITABLE.includes(c.status)) fail(409, `A declaration that is "${c.status}" cannot be edited. ${c.status === 'rejected' ? 'Reopen it first.' : ''}`);
  const set = [], a = [], ch = {};
  const numField = (k, label, max, int) => { if (b[k] === undefined) return; const v = b[k] === '' || b[k] === null ? null : Number(b[k]); if (v !== null && (!Number.isFinite(v) || v < 0 || v > max || (int && !Number.isInteger(v)))) fail(400, `${label}: enter ${int ? 'a whole number' : 'a number'} from 0 to ${max}.`); set.push(`${k}=?`); a.push(v); ch[k] = v; };
  numField('gross_weight_kg', 'Gross weight', 1e6); numField('net_weight_kg', 'Net weight', 1e6); numField('packages', 'Packages', 100000, true);
  if (b.incoterm !== undefined) { const v = String(b.incoterm).toUpperCase(); if (v && !require('./suppliers').INCOTERMS.includes(v)) fail(400, 'Unknown Incoterm.'); set.push('incoterm=?'); a.push(v); ch.incoterm = v; }
  for (const [k, max] of [['dimensions', 120], ['restrictions_note', 400], ['entry_number', 60], ['notes', 400]]) if (b[k] !== undefined) { set.push(`${k}=?`); a.push(str(b[k], max)); ch[k] = true; }
  if (b.lines !== undefined) { const lines = cleanLines(b.lines), sm = sumLines(lines); set.push('lines=?::jsonb', 'declared_value=?'); a.push(JSON.stringify(lines), sm.value); ch.lines = lines.length; }
  if (!set.length) return detail(id);
  await run(`UPDATE customs_declarations SET ${set.join(', ')}, updated=? WHERE id=?`, ...a, now(), c.id);
  const d = await detail(id), st = d.readiness.ready ? 'ready' : 'incomplete';
  if (st !== c.status) await run('UPDATE customs_declarations SET status=?, updated=? WHERE id=?', st, now(), c.id);
  await T.audit(user, 'customs.update', 'customs_declarations', c.ref, ch, ip);
  return detail(id);
}
async function setStatus(id, to, b, user, ip) {
  const c = await load(id); to = String(to || '');
  if (!(NEXT[c.status] || []).includes(to)) fail(409, `A declaration that is "${c.status}" cannot move to "${to}".`);
  const s = shape(c);
  if (to === 'submitted') { const r = await readiness(s); if (!r.ready) fail(409, 'Fix the items marked "must fix" before recording this as filed.'); }
  if (['cleared', 'held', 'rejected'].includes(to) && b.entry_number === undefined && !c.entry_number && to === 'cleared') fail(400, 'Enter the customs entry number given when this was filed.');
  const r = await run('UPDATE customs_declarations SET status=?, entry_number=COALESCE(NULLIF(?,\'\'), entry_number), notes=CASE WHEN ?<>\'\' THEN ? ELSE notes END, submitted_at=CASE WHEN ?=\'submitted\' THEN ? ELSE submitted_at END, reviewed_by=?, reviewed_at=?, updated=? WHERE id=? AND status=?',
    to, str(b.entry_number, 60), str(b.note, 400), str(b.note, 400), to, now(), user ? user.id : null, now(), now(), c.id, c.status);
  if (r.changes !== 1) fail(409, 'This declaration was just changed by someone else. Reload and try again.');
  // customs outcome is also a shipment event, so the timeline matches reality
  if (c.import_shipment_id && to === 'held') await run("INSERT INTO shipment_tracking_events (import_shipment_id,stage,description,location,occurred_at,source,event_hash,created_by,created) VALUES (?,?,?,?,?,'manual',?,?,?)", c.import_shipment_id, 'customs_hold', str(b.note, 300) || 'Customs hold recorded.', '', now(), crypto.createHash('sha256').update('cd:' + c.id + ':held:' + now()).digest('hex'), user ? user.id : null, now()).catch(() => {});
  await T.audit(user, 'customs.status', 'customs_declarations', c.ref, { from: c.status, to }, ip);
  return detail(id);
}

/* ---------- duty and tax calculator ---------- */
// Everything is computed in NGN with the stored exchange rate for the value's currency. Rules come only from staff-entered customs_duty_rules.
async function calc(b) {
  const dest = String(b.destination_country || '').toUpperCase(); if (!(await get('SELECT 1 x FROM trade_countries WHERE code=?', dest))) fail(400, 'Choose the destination country.');
  const cur = String(b.currency || 'NGN').toUpperCase(); if (!(await get('SELECT 1 x FROM trade_currencies WHERE code=?', cur))) fail(400, 'Unknown currency.');
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 50) fail(400, 'Add 1 to 50 goods lines.');
  let rate = 1, rateInfo = { source: 'NGN' }; if (cur !== 'NGN') { try { const r = await FX.rate(cur, 'NGN'); rate = r.rate; rateInfo = { source: r.source || '', stale: !!r.stale }; } catch { fail(409, 'No usable exchange rate for ' + cur + '. Refresh rates first.'); } }
  const num = (v, label) => { const n = Number(v || 0); if (!Number.isFinite(n) || n < 0 || n > 1e12) fail(400, label + ': enter a number of 0 or more.'); return n; };
  const lines = b.lines.map((l, i) => ({ product_id: i + 1, hs_code: String(l.hs_code || '').replace(/\D/g, ''), origin_country: String(l.origin_country || '').toUpperCase(), value_ngn: num(l.value, 'Line ' + (i + 1) + ' value') * rate }));
  if (lines.some((l) => l.hs_code.length < 4)) fail(400, 'Each line needs an HS code (at least 4 digits).');
  const res = await DU.estimate({ dest, lines, freightNgn: num(b.freight, 'Freight') * rate, insuranceNgn: num(b.insurance, 'Insurance') * rate });
  const back = (n) => (cur === 'NGN' ? n : T.roundTo(n / rate, 2));
  return { currency: cur, rate_to_ngn: rate, rate: rateInfo, status: res.status, de_minimis: res.de_minimis, unverified: res.unverified, levy_labels: res.labels, lines_without_rule: res.missing.map((i) => i - 1),
    totals: { duty_ngn: res.duty_ngn, vat_ngn: res.vat_ngn, levy_ngn: res.levy_ngn, total_ngn: res.total_ngn, total: back(res.total_ngn) },
    lines: res.lines.map((l) => ({ line: l.product_id - 1, rule_id: l.rule_id, valuation: l.valuation, base_ngn: l.base_ngn, duty_ngn: l.duty_ngn, levy_ngn: l.levy_ngn, vat_ngn: l.vat_ngn, verified: l.verified })),
    note: res.status === 'verified' ? 'Calculated from rules marked verified by your team.' : res.status === 'not_available' ? 'No duty rule is saved for this destination and HS code, so nothing is calculated. Add a rule under Shipping & duties.' : 'This is an ESTIMATE. At least one rule is unverified or missing. Confirm with the customs authority or your broker before relying on it.' };
}

/* ---------- generated documents (PDF) ---------- */
const GEN = { export: ['commercial_invoice', 'proforma_invoice', 'packing_list', 'certificate_of_origin', 'export_declaration', 'customs_declaration'], import: ['customs_declaration', 'goods_received_note'] };
const PREFIX = { commercial_invoice: 'INV', proforma_invoice: 'PRO', packing_list: 'PL', certificate_of_origin: 'COO', export_declaration: 'EXD', customs_declaration: 'CUS', goods_received_note: 'GRN' };
const TITLE = { commercial_invoice: 'COMMERCIAL INVOICE', proforma_invoice: 'PROFORMA INVOICE', packing_list: 'PACKING LIST', certificate_of_origin: 'CERTIFICATE OF ORIGIN (DRAFT FOR CERTIFICATION)', export_declaration: 'EXPORT DECLARATION (INFORMATION SUMMARY)', customs_declaration: 'CUSTOMS DECLARATION (INFORMATION SUMMARY)', goods_received_note: 'GOODS RECEIVED NOTE' };
const fmtDate = (t) => new Date((t || now()) * 1000).toISOString().slice(0, 10);
const addrLines = (o) => [o.name, o.line1, o.line2, [o.city, o.region, o.postal].filter(Boolean).join(', '), o.country, o.phone ? 'Tel: ' + o.phone : '', o.email, o.tax_id ? 'Tax ID: ' + o.tax_id : ''];

async function sellerOf(st) {
  const miss = ['origin_name', 'origin_line1', 'origin_city', 'origin_postal'].filter((k) => !st[k]); if (miss.length) fail(409, 'Enter the sender (seller) address under Global Trade > Settings first.');
  return { name: st.origin_name, line1: st.origin_line1, city: st.origin_city, region: st.origin_region, postal: st.origin_postal, country: st.origin_country, phone: st.origin_phone };
}
async function generate(type, target, user, ip) {
  type = String(type || '');
  const isExp = !!target.export_ref, ref = isExp ? target.export_ref : target.import_ref;
  if (!GEN[isExp ? 'export' : 'import'].includes(type)) fail(400, 'That document cannot be generated for this record. Upload it instead.');
  const st = await T.settings(); let buf, number, data = {}, col, tid;
  if (isExp) {
    const eo = await get('SELECT eo.*, o.payment_status FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE eo.ref=?', ref); if (!eo) fail(404, 'International order not found.'); col = 'export_order_id'; tid = eo.id;
    const items = await all('SELECT * FROM export_order_items WHERE export_order_id=? ORDER BY id', eo.id), decl = await get('SELECT * FROM customs_declarations WHERE export_order_id=?', eo.id);
    if (type === 'commercial_invoice' && eo.payment_status !== 'paid') fail(409, 'A commercial invoice is issued only after the order is paid. Use a proforma invoice before payment.');
    if (['export_declaration', 'customs_declaration'].includes(type) && !decl) fail(409, 'Create the customs declaration first (Customs & docs).');
    const seller = await sellerOf(st), buyer = { name: eo.ship_name, line1: eo.address_line1, line2: eo.address_line2, city: eo.city, region: eo.region, postal: eo.postal_code, country: eo.destination_country, phone: '+' + eo.phone_dial_code + ' ' + eo.ship_phone, email: eo.ship_email, tax_id: eo.tax_id };
    const ver = Number((await get('SELECT COALESCE(MAX(version),0) v FROM trade_documents WHERE export_order_id=? AND doc_type=?', eo.id, type)).v) + 1;
    number = `${PREFIX[type]}-${eo.ref}${ver > 1 ? '-v' + ver : ''}`; data = { version: ver, declaration_id: decl ? Number(decl.id) : null };
    buf = await PDF.build(TITLE[type], (doc) => {
      PDF.header(doc, TITLE[type], number, 'Date ' + fmtDate());
      if (['commercial_invoice', 'proforma_invoice', 'packing_list', 'certificate_of_origin'].includes(type)) PDF.twoCol(doc, type === 'certificate_of_origin' ? 'Exporter' : 'Seller / exporter', addrLines(seller), 'Consignee / buyer', addrLines(buyer));
      const meta = [`Order: ${eo.ref}`, `Currency: ${eo.currency}`, `Incoterm: ${eo.duty_arrangement}`, `Method: ${eo.service_label || eo.shipping_method || ''}`, eo.tracking_number ? `Carrier / tracking: ${eo.carrier} ${eo.tracking_number}` : ''].filter(Boolean).join('   |   ');
      doc.fontSize(9).text(meta, 40, doc.y, { width: doc.page.width - 80 }); doc.moveDown(0.5);
      if (['commercial_invoice', 'proforma_invoice'].includes(type)) {
        PDF.table(doc, [{ h: 'Description', w: 0.36 }, { h: 'HS code', w: 0.12 }, { h: 'Origin', w: 0.08 }, { h: 'Qty', w: 0.08, align: 'right' }, { h: 'Unit price', w: 0.18, align: 'right' }, { h: 'Total', w: 0.18, align: 'right' }],
          items.map((i) => [i.customs_description || i.description, i.hs_code, i.origin_country || '', i.qty, PDF.money(Number(i.declared_value) / Number(i.qty), 4), PDF.money(i.declared_value)]),
          { totals: [['Goods', `${eo.currency} ${PDF.money(eo.subtotal)}`], ['Shipping', `${eo.currency} ${PDF.money(eo.shipping)}`], ...(Number(eo.insurance) ? [['Insurance', `${eo.currency} ${PDF.money(eo.insurance)}`]] : []), ...(Number(eo.duties_collected) ? [['Duties and taxes (prepaid)', `${eo.currency} ${PDF.money(eo.duties)}`]] : []), ['TOTAL', `${eo.currency} ${PDF.money(eo.total)}`, true]] });
        PDF.note(doc, Number(eo.duties_collected) ? 'Duties and taxes are prepaid by the seller (DDP).' : 'Duties and taxes at destination, if any, are payable by the consignee (DAP).');
        PDF.note(doc, `Exchange rate fixed at order time: 1 ${eo.currency} = ${Number(eo.fx_rate_to_ngn)} NGN.`);
        if (type === 'proforma_invoice') PDF.note(doc, 'PROFORMA: this is not a demand for payment and not a tax invoice. Prices are valid for the quote period only.', { bold: true });
        PDF.note(doc, 'I declare that the information in this invoice is true and correct.   Signature: ______________________   Name / date: ______________________');
      } else if (type === 'packing_list') {
        PDF.table(doc, [{ h: 'Description', w: 0.42 }, { h: 'HS code', w: 0.14 }, { h: 'Ordered', w: 0.1, align: 'right' }, { h: 'Packed', w: 0.1, align: 'right' }, { h: 'Unit kg', w: 0.12, align: 'right' }, { h: 'Total kg', w: 0.12, align: 'right' }],
          items.map((i) => [i.description, i.hs_code, i.qty, i.packed_qty, i.weight_kg == null ? '' : PDF.money(i.weight_kg, 3), i.weight_kg == null ? '' : PDF.money(Number(i.weight_kg) * Number(i.packed_qty), 3)]));
        PDF.note(doc, `Packages: ${decl && decl.packages ? decl.packages : '____'}   Gross weight: ${decl && decl.gross_weight_kg ? decl.gross_weight_kg + ' kg' : '____ kg'}   Dimensions: ${decl && decl.dimensions ? decl.dimensions : '____'}`);
        if (items.some((i) => Number(i.packed_qty) < Number(i.qty))) PDF.note(doc, 'Not every item is marked as packed yet. Record packed quantities, then regenerate this list.', { bold: true, color: '#b91c1c' });
      } else if (type === 'certificate_of_origin') {
        PDF.table(doc, [{ h: 'Description of goods', w: 0.5 }, { h: 'HS code', w: 0.15 }, { h: 'Origin', w: 0.15 }, { h: 'Qty', w: 0.1, align: 'right' }, { h: 'Value', w: 0.1, align: 'right' }], items.map((i) => [i.customs_description || i.description, i.hs_code, i.origin_country || '', i.qty, PDF.money(i.declared_value)]));
        PDF.note(doc, 'DRAFT. This sheet was prepared from order data. It has NO legal effect until it is certified by the authorised chamber of commerce or authority. Upload the certified certificate as the "Certificate of origin" document.', { bold: true, color: '#b91c1c' });
      } else { // export / customs declaration summary
        const L = decl.lines || [];
        PDF.twoCol(doc, 'Declaration', [`Ref: ${decl.ref}`, `Status: ${decl.status}`, `Direction: ${decl.direction}`, `Entry number: ${decl.entry_number || '(not filed yet)'}`], 'Route', [`Export country: ${decl.export_country}`, `Import country: ${decl.import_country}`, `Incoterm: ${decl.incoterm}`]);
        PDF.table(doc, [{ h: 'Description', w: 0.36 }, { h: 'HS code', w: 0.14 }, { h: 'Origin', w: 0.08 }, { h: 'Qty', w: 0.08, align: 'right' }, { h: 'Kg', w: 0.1, align: 'right' }, { h: 'Value ' + decl.currency, w: 0.24, align: 'right' }], L.map((l) => [l.description, l.hs_code, l.origin_country, l.qty, l.weight_kg == null ? '' : l.weight_kg, PDF.money(l.value)]),
          { totals: [['Declared value', `${decl.currency} ${PDF.money(decl.declared_value)}`, true]] });
        PDF.note(doc, `Packages: ${decl.packages || '-'}   Gross: ${decl.gross_weight_kg || '-'} kg   Net: ${decl.net_weight_kg || '-'} kg   Dimensions: ${decl.dimensions || '-'}`);
        if (decl.restrictions_note) PDF.note(doc, 'Restrictions: ' + decl.restrictions_note);
        PDF.note(doc, 'Information summary prepared from your records to help with filing. It is NOT an official customs filing.', { bold: true });
      }
    });
  } else {
    const h = await get('SELECT h.*, s.name supplier, p.po_number FROM import_shipments h JOIN international_suppliers s ON s.id=h.supplier_id LEFT JOIN import_purchase_orders p ON p.id=h.po_id WHERE h.import_ref=?', ref); if (!h) fail(404, 'Import shipment not found.'); col = 'import_shipment_id'; tid = h.id;
    const items = await all('SELECT * FROM import_shipment_items WHERE shipment_id=? ORDER BY id', h.id), decl = await get('SELECT * FROM customs_declarations WHERE import_shipment_id=?', h.id);
    if (type === 'customs_declaration' && !decl) fail(409, 'Create the customs declaration first (Customs & docs).');
    if (type === 'goods_received_note' && !Number(h.stock_posted)) fail(409, 'A goods received note is created when stock is received.');
    const ver = Number((await get('SELECT COALESCE(MAX(version),0) v FROM trade_documents WHERE import_shipment_id=? AND doc_type=?', h.id, type)).v) + 1;
    number = type === 'goods_received_note' && h.grn_ref ? h.grn_ref + (ver > 1 ? '-v' + ver : '') : `${PREFIX[type]}-${h.import_ref}${ver > 1 ? '-v' + ver : ''}`; data = { version: ver, declaration_id: decl ? Number(decl.id) : null };
    buf = await PDF.build(TITLE[type], (doc) => {
      PDF.header(doc, TITLE[type], number, 'Date ' + fmtDate(h.received_at));
      if (type === 'goods_received_note') {
        PDF.twoCol(doc, 'Supplier', [h.supplier, 'Country: ' + h.supplier_country], 'Shipment', [`Import ref: ${h.import_ref}`, `PO: ${h.po_number || '-'}`, `Carrier / tracking: ${h.carrier} ${h.tracking_number}`, `Currency: ${h.currency}`]);
        PDF.table(doc, [{ h: 'Item', w: 0.3 }, { h: 'Ordered', w: 0.1, align: 'right' }, { h: 'Received', w: 0.1, align: 'right' }, { h: 'Damaged', w: 0.1, align: 'right' }, { h: 'Short', w: 0.1, align: 'right' }, { h: 'To stock', w: 0.1, align: 'right' }, { h: 'Landed / unit NGN', w: 0.2, align: 'right' }],
          items.map((i) => [i.description, i.qty_ordered, i.qty_received, i.qty_damaged, Math.max(0, i.qty_ordered - i.qty_received), i.qty_sellable == null ? '' : i.qty_sellable, i.landed_unit_cost_ngn == null ? '-' : PDF.money(i.landed_unit_cost_ngn)]),
          { totals: [['Total landed cost (NGN)', PDF.money(h.landed_total_ngn), true]] });
        PDF.note(doc, 'Landed cost = purchase value + freight, insurance, duties, taxes, clearing, port and inland charges (all in NGN at the exchange rate saved with the shipment), shared across the items by the stated basis. Damaged and missing units are absorbed by the units that went into stock.');
        PDF.note(doc, 'Received by: ______________________   Date: ______________');
      } else {
        const L = decl.lines || [];
        PDF.twoCol(doc, 'Declaration', [`Ref: ${decl.ref}`, `Status: ${decl.status}`, `Entry number: ${decl.entry_number || '(not filed yet)'}`], 'Route', [`From: ${decl.export_country}`, `To: ${decl.import_country}`, `Incoterm: ${decl.incoterm}`]);
        PDF.table(doc, [{ h: 'Description', w: 0.36 }, { h: 'HS code', w: 0.14 }, { h: 'Origin', w: 0.08 }, { h: 'Qty', w: 0.08, align: 'right' }, { h: 'Kg', w: 0.1, align: 'right' }, { h: 'Value ' + decl.currency, w: 0.24, align: 'right' }], L.map((l) => [l.description, l.hs_code, l.origin_country, l.qty, l.weight_kg == null ? '' : l.weight_kg, PDF.money(l.value)]), { totals: [['Declared value', `${decl.currency} ${PDF.money(decl.declared_value)}`, true]] });
        PDF.note(doc, `Packages: ${decl.packages || '-'}   Gross: ${decl.gross_weight_kg || '-'} kg   Net: ${decl.net_weight_kg || '-'} kg`);
        PDF.note(doc, 'Information summary prepared from your records to help your clearing agent. It is NOT an official customs filing.', { bold: true });
      }
    });
  }
  const stored = crypto.randomBytes(16).toString('hex') + '.pdf';
  try { await storage.tradeDocs.put(stored, buf); } catch (e) { console.error(e.message); fail(503, 'File storage is not available right now. Please try again.'); }
  const id = await tx(async () => {
    await run(`UPDATE trade_documents SET status='void' WHERE ${col}=? AND doc_type=? AND origin='generated' AND status='issued'`, tid, type);
    const r = await run(`INSERT INTO trade_documents (doc_type,number,${col},origin,file_name,storage_path,stored_name,mime,size_bytes,data,version,status,created_by,created) VALUES (?,?,?,'generated',?,?,?,'application/pdf',?,?::jsonb,?,'issued',?,?)`,
      type, number, tid, number + '.pdf', 'private:' + stored, stored, buf.length, JSON.stringify(data), data.version, user ? user.id : null, now());
    return Number(r.lastInsertRowid);
  });
  await T.audit(user, 'document.generate', 'trade_documents', id, { type, number }, ip);
  return { document: { id, doc_type: type, number, file_name: number + '.pdf', origin: 'generated', version: data.version, status: 'issued' } };
}
async function docList(kind, ref) {
  const row = kind === 'export' ? await get('SELECT id FROM export_orders WHERE ref=?', String(ref).toUpperCase()) : await get('SELECT id FROM import_shipments WHERE import_ref=?', String(ref).toUpperCase());
  if (!row) fail(404, 'Record not found.');
  const rows = await all(`SELECT id,doc_type,number,file_name,origin,version,status,size_bytes,created FROM trade_documents WHERE ${kind === 'export' ? 'export_order_id' : 'import_shipment_id'}=? AND doc_type<>'shipping_label' ORDER BY id DESC`, row.id);
  return { documents: rows.map((d) => ({ id: Number(d.id), doc_type: d.doc_type, number: d.number, file_name: d.file_name, origin: d.origin, version: Number(d.version), status: d.status, size_bytes: Number(d.size_bytes), created: Number(d.created) })), generate: GEN[kind] };
}
module.exports = { GEN, list, detail, save, setStatus, fromExport, fromImport, calc, generate, docList, readiness };
