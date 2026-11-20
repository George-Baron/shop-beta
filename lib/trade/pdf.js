'use strict';
// Small PDF helpers (pdfkit) for trade documents. Documents are built only from stored records; nothing here invents data.
const PDFDocument = require('pdfkit');

function build(title, draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: title, Producer: 'Velto-Mart' } }), chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    try { draw(doc); doc.end(); } catch (e) { reject(e); }
  });
}
const money = (n, dp = 2) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
function header(doc, title, number, sub) {
  doc.fontSize(18).font('Helvetica-Bold').text(title, { align: 'left' }); doc.fontSize(10).font('Helvetica').fillColor('#444').text('No. ' + number + (sub ? '   ' + sub : '')).fillColor('#000'); doc.moveDown(0.6);
}
function block(doc, label, lines, x, y, w) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#666').text(label.toUpperCase(), x, y, { width: w }); doc.font('Helvetica').fontSize(10).fillColor('#000');
  doc.text(lines.filter(Boolean).join('\n'), x, doc.y, { width: w });
}
function twoCol(doc, leftLabel, left, rightLabel, right) {
  const y = doc.y, w = (doc.page.width - 80 - 20) / 2; block(doc, leftLabel, left, 40, y, w); const y1 = doc.y; doc.y = y; block(doc, rightLabel, right, 40 + w + 20, y, w); doc.y = Math.max(y1, doc.y) + 8; doc.x = 40;
}
// cols: [{ h, w (fraction), align }]; rows: arrays of strings
function table(doc, cols, rows, opt = {}) {
  const total = doc.page.width - 80, widths = cols.map((c) => c.w * total); let y = doc.y;
  const row = (cells, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(String(c == null ? '' : c), { width: widths[i] - 6 }))) + 6;
    if (y + h > doc.page.height - 60) { doc.addPage(); y = 40; }
    if (bold) doc.rect(40, y, total, h).fill('#eeeeee').fillColor('#000');
    let x = 40; cells.forEach((c, i) => { doc.text(String(c == null ? '' : c), x + 3, y + 3, { width: widths[i] - 6, align: cols[i].align || 'left' }); x += widths[i]; });
    doc.moveTo(40, y + h).lineTo(40 + total, y + h).strokeColor('#cccccc').lineWidth(0.5).stroke().strokeColor('#000'); y += h;
  };
  row(cols.map((c) => c.h), true); rows.forEach((r) => row(r, false)); doc.y = y + 6; doc.x = 40;
  if (opt.totals) opt.totals.forEach(([l, v, b]) => { doc.font(b ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).text(`${l}: ${v}`, 40, doc.y, { width: total, align: 'right' }); });
}
function note(doc, text, o = {}) { doc.moveDown(0.5).font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size || 8.5).fillColor(o.color || '#333').text(text, 40, doc.y, { width: doc.page.width - 80 }).fillColor('#000'); }
module.exports = { build, header, twoCol, table, note, money };
