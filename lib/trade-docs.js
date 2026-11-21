'use strict';
// The paperwork for a shipment, made as PDFs on demand (nothing is stored but the document number, so the app stays stateless):
// commercial invoice, packing list, proforma invoice, purchase order (imports) and a customs data sheet.
// A document has one number and one issue date for ever. Printing it again gives the same number.
const PDF = require('./pdf');
const CUR = require('./currency');
const C = require('./countries');
const T = require('./trade');
const L = require('./trade-landed');
const TC = require('./trade-compliance');
const { fail } = require('./shop');

const date = (t) => (t ? new Date(Number(t) * 1000).toISOString().slice(0, 10) : '-');
const pad = (s, n, right) => { s = String(s == null ? '' : s); s = s.length > n ? s.slice(0, n) : s; return right ? s.padStart(n) : s.padEnd(n); };
const cname = (c) => (c ? C.countryName(c) : '-');

// Columns: [heading, width, align-right?]. A long description wraps onto extra lines inside its column.
function table(cols, rows) {
  const line = (cells) => cells.map((c, i) => pad(c, cols[i][1], cols[i][2])).join(' ');
  const out = [{ text: line(cols.map((c) => c[0])), font: 'C', size: 8, gap: 0 }, { text: '-'.repeat(cols.reduce((a, c) => a + c[1] + 1, -1)), font: 'C', size: 8, gap: 0 }];
  for (const r of rows) {
    const wrapped = cols.map((c, i) => (c[3] ? PDF.wrap(String(r[i]), 'C', 8, c[1] * 8 * 0.6) : [String(r[i])]));
    const h = Math.max(...wrapped.map((w) => w.length));
    for (let k = 0; k < h; k++) out.push({ text: line(wrapped.map((w) => w[k] || '')), font: 'C', size: 8, gap: k === h - 1 ? 1 : 0 });
  }
  return out;
}

function parties(ship, co, forInvoice) {
  const us = [co.name, co.address, co.tax_id && 'Tax ID: ' + co.tax_id, co.rc && 'Reg. no: ' + co.rc, co.phone, co.email].filter(Boolean).join('\n');
  const them = [ship.party_name, ship.party_address, ship.party_country && cname(ship.party_country), ship.party_tax_id && 'Tax ID: ' + ship.party_tax_id, ship.party_contact].filter(Boolean).join('\n');
  const imp = ship.direction === 'import';
  return { seller: imp ? them : us, buyer: imp ? us : them, sellerLabel: forInvoice ? 'Seller / exporter' : 'Seller', buyerLabel: forInvoice ? 'Buyer / consignee' : 'Buyer' };
}
const head = (title, number, issued, ship, extra = []) => [
  { text: title, font: 'HB', size: 16, gap: 4 }, { text: [`Number: ${number}`, `Date: ${date(issued)}`, `Shipment: ${ship.ref}`, ...extra].join('    '), size: 9, gap: 10 }];
const route = (ship) => `${cname(ship.origin_country)} to ${cname(ship.dest_country)}${ship.port_of_loading || ship.port_of_discharge ? ` (${[ship.port_of_loading, ship.port_of_discharge].filter(Boolean).join(' to ')})` : ''}`;
const terms = (ship) => `${ship.incoterm} ${L.INCOTERM_NAMES[ship.incoterm]}${ship.port_of_discharge ? ', ' + ship.port_of_discharge : ''}`;
const sign = (name) => [{ text: ' ', gap: 18 }, { text: '______________________________', gap: 0 }, { text: `Signed for ${name}`, size: 8, gap: 0 }, { text: 'Name and date', size: 8, gap: 6 }];

async function build(user, id, kind) {
  const meta = T.DOCS[kind]; if (!meta) fail(400, 'Unknown document.');
  const ship = await T.load(id), its = await T.items(id), co = await T.company();
  if (kind === 'purchase_order' && ship.direction !== 'import') fail(400, 'A purchase order is made for an import, to the supplier. For an export, ask the buyer for theirs.');
  if (!co.name) fail(400, 'Add your company details first (Trade > Company details).');
  const { number, issued } = await T.issue(user, ship, kind);
  const d = CUR.decimals(ship.currency), n = (v) => Number(v).toLocaleString('en', { minimumFractionDigits: d, maximumFractionDigits: d });
  const goods = its.reduce((a, i) => a + i.unit_value * i.qty, 0), pt = parties(ship, co, kind !== 'purchase_order');
  const b = [];
  const priceRows = its.map((i, k) => [k + 1, i.description, i.hs_code || '-', i.origin_country || ship.origin_country, i.qty, n(i.unit_value), n(i.unit_value * i.qty)]);
  const priceCols = [['#', 2], ['Description of goods', 28, false, true], ['HS code', 10], ['Orig', 4], ['Qty', 7, true], ['Unit ' + ship.currency, 11, true], ['Total ' + ship.currency, 13, true]];
  const who = (label, text) => [{ text: label, font: 'HB', size: 9, gap: 1 }, { text, size: 9, gap: 7 }];

  if (kind === 'commercial_invoice' || kind === 'proforma') {
    const pro = kind === 'proforma';
    b.push(...head(pro ? 'PROFORMA INVOICE' : 'COMMERCIAL INVOICE', number, issued, ship));
    if (pro) b.push({ text: `This is not a demand for payment. The prices are valid until ${date(Number(issued) + 30 * 86400)}.`, size: 9, gap: 8 });
    b.push(...who(pt.sellerLabel, pt.seller), ...who(pt.buyerLabel, pt.buyer));
    b.push({ text: `Country of origin: ${cname(ship.origin_country)}    Destination: ${cname(ship.dest_country)}`, size: 9 }, { text: `Route: ${route(ship)}`, size: 9 }, { text: `Terms of delivery: ${terms(ship)}    Currency: ${ship.currency}`, size: 9 },
      { text: `Transport: ${ship.transport}${ship.bill_no ? '    Bill/airway bill: ' + ship.bill_no : ''}${ship.container_no ? '    Container: ' + ship.container_no : ''}`, size: 9, gap: 8 });
    b.push(...table(priceCols, priceRows));
    b.push({ text: ' ', gap: 2 }, { text: `Total ${ship.currency}: ${n(goods)}`, font: 'HB', size: 11, gap: 4 });
    const inc = L.SELLER_PAYS[ship.incoterm]; if (inc.length) b.push({ text: `Under ${ship.incoterm} the price includes: ${inc.join(', ')}.`, size: 8, gap: 4 });
    if (co.bank_note && ship.direction === 'export') b.push({ text: `Payment details: ${co.bank_note}`, size: 9, gap: 4 });
    b.push({ text: pro ? 'Proforma invoice for the buyer\'s information, customs and bank use only.' : `We declare that the particulars on this invoice are true and correct and that the goods are of ${cname(ship.origin_country)} origin.`, size: 8, gap: 4 }, ...sign(ship.direction === 'import' ? ship.party_name : co.name));
  } else if (kind === 'packing_list') {
    b.push(...head('PACKING LIST', number, issued, ship));
    b.push(...who(pt.sellerLabel, pt.seller), ...who(pt.buyerLabel, pt.buyer));
    b.push({ text: `Route: ${route(ship)}`, size: 9 }, { text: `Transport: ${ship.transport}${ship.bill_no ? '    Bill/airway bill: ' + ship.bill_no : ''}${ship.container_no ? '    Container: ' + ship.container_no : ''}`, size: 9, gap: 8 });
    const wcols = [['#', 2], ['Description of goods', 34, false, true], ['HS code', 10], ['Qty', 7, true], ['Net kg/unit', 11, true], ['Net kg', 11, true]];
    b.push(...table(wcols, its.map((i, k) => [k + 1, i.description, i.hs_code || '-', i.qty, i.weight_kg == null ? '-' : i.weight_kg.toFixed(3), i.weight_kg == null ? '-' : (i.weight_kg * i.qty).toFixed(3)])));
    const net = its.reduce((a, i) => a + (i.weight_kg || 0) * i.qty, 0), missing = its.filter((i) => i.weight_kg == null).length;
    b.push({ text: ' ', gap: 2 }, { text: `Total quantity: ${its.reduce((a, i) => a + i.qty, 0)}    Packages: ${ship.packages == null ? 'not entered' : ship.packages}`, font: 'HB', size: 10 },
      { text: `Total net weight: ${net.toFixed(3)} kg${missing ? ` (${missing} line(s) have no weight)` : ''}    Gross weight: ${ship.gross_weight_kg == null ? 'not entered' : ship.gross_weight_kg.toFixed(3) + ' kg'}`, font: 'HB', size: 10, gap: 6 },
      { text: 'Packing list: no prices are shown.', size: 8, gap: 4 }, ...sign(ship.direction === 'import' ? ship.party_name : co.name));
  } else if (kind === 'purchase_order') {
    b.push(...head('PURCHASE ORDER', number, issued, ship));
    b.push(...who('Buyer', pt.buyer), ...who('Supplier', pt.seller));
    b.push({ text: `Deliver to: ${cname(ship.dest_country)}    Terms: ${terms(ship)}    Transport: ${ship.transport}`, size: 9 }, { text: `Currency: ${ship.currency}${ship.forwarder ? '    Our forwarder: ' + ship.forwarder : ''}${ship.eta ? '    Needed by: ' + date(ship.eta) : ''}`, size: 9, gap: 8 });
    b.push(...table(priceCols.map((c, i) => (i === 3 ? ['Orig', 4] : c)), priceRows));
    b.push({ text: ' ', gap: 2 }, { text: `Order total ${ship.currency}: ${n(goods)}`, font: 'HB', size: 11, gap: 4 },
      { text: 'Please confirm this order, the prices and the ship date in writing. Send the commercial invoice and packing list before dispatch.', size: 9, gap: 4 }, ...sign(co.name));
  } else {                                                                    // customs data sheet
    const land = await T.landedFor(ship, its, 'NGN'), net = its.reduce((a, i) => a + (i.weight_kg || 0) * i.qty, 0);
    b.push(...head('CUSTOMS DATA SHEET', number, issued, ship, [ship.direction.toUpperCase()]));
    b.push(...who(pt.sellerLabel, pt.seller), ...who(pt.buyerLabel, pt.buyer));
    b.push({ text: `Origin: ${cname(ship.origin_country)}    Destination: ${cname(ship.dest_country)}    Incoterm: ${terms(ship)}`, size: 9 },
      { text: `Transport: ${ship.transport}    Forwarder/agent: ${ship.forwarder || '-'}    Bill/airway bill: ${ship.bill_no || '-'}    Container: ${ship.container_no || '-'}`, size: 9 },
      { text: `ETD: ${date(ship.etd)}    ETA: ${date(ship.eta)}    Customs status: ${ship.customs_status.replace('_', ' ')}    Packages: ${ship.packages == null ? '-' : ship.packages}    Gross weight: ${ship.gross_weight_kg == null ? '-' : ship.gross_weight_kg + ' kg'}`, size: 9, gap: 8 });
    const cols = [['#', 2], ['HS code', 10], ['Description', 26, false, true], ['Orig', 4], ['Qty', 6, true], ['Net kg', 9, true], ['Value ' + ship.currency, 14, true]];
    b.push(...table(cols, its.map((i, k) => [k + 1, i.hs_code || 'MISSING', i.description, i.origin_country || ship.origin_country, i.qty, i.weight_kg == null ? '-' : (i.weight_kg * i.qty).toFixed(3), n(i.unit_value * i.qty)])));
    b.push({ text: ' ', gap: 2 }, { text: `Goods value: ${ship.currency} ${n(goods)}    Net weight: ${net.toFixed(3)} kg`, font: 'HB', size: 10 });
    if (!land.error) {
      const t = land.totals_major;
      b.push({ text: `Freight: ${n(ship.freight)}    Insurance: ${n(ship.insurance)}    Customs value (duty basis): ${n(t.customs_value)}`, size: 9 },
        { text: `Estimated duty (${ship.duty_pct}%) and VAT (${ship.vat_pct}%): ${n(land.lines.find((l) => l.key === 'duty').amount)} and ${n(land.lines.find((l) => l.key === 'vat').amount)}. These are estimates for planning only. Customs and the clearing agent decide.`, size: 8, gap: 4 });
      if (land.converted) b.push({ text: `About ${land.converted.currency} ${Number(land.converted.totals.landed_total).toLocaleString('en')} landed in total at ${land.converted.rate.toLocaleString('en')} ${land.converted.currency} per ${ship.currency}.`, size: 8, gap: 4 });
    }
    const its2 = its.filter((i) => !i.hs_code).length; if (its2) b.push({ text: `Warning: ${its2} line(s) have no HS code.`, font: 'HB', size: 9, gap: 4 });
    const cl = await TC.checklist(ship, []);
    b.push({ text: 'Reminders (to verify with the official source, not legal advice)', font: 'HB', size: 9, gap: 1 }, ...cl.items.slice(0, 20).map((r) => ({ text: `[${r.status === 'done' ? 'x' : r.status === 'na' ? '-' : ' '}] ${r.title}`, size: 8, gap: 0 })));
  }
  return { buf: PDF.build(b, { title: `${meta.label} ${number}` }), number, filename: `${number}.pdf`, label: meta.label };
}

module.exports = { build };
