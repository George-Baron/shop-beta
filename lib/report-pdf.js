'use strict';
// Any report ({title, note, from, to, summary[], columns[], rows[]}) as a landscape A4 PDF.
// Uses the built-in PDF fonts, so characters outside Western European letters (and the naira sign) are shown as "?" / "NGN".
const PDFDocument = require('pdfkit');

const safe = (v) => String(v == null ? '' : v).replace(/[^\x20-\x7E -ÿ]/g, '?').replace(/[\r\n\t]+/g, ' ');
const when = (v) => (v ? new Date(Number(v) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '');
function fmt(v, t) {
  if (v == null || v === '') return '';
  if (t === 'money') return 'NGN ' + Number(v).toLocaleString('en-NG');
  if (t === 'int') return Number(v).toLocaleString('en-NG');
  if (t === 'hours') return Number(v).toFixed(1) + ' h';
  if (t === 'date') return when(v);
  return safe(v);
}
const RIGHT = new Set(['money', 'int', 'hours']);

function reportPdf(rep, { store = 'Shop-Beta' } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: safe(rep.title), Author: safe(store) } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const L = 36, W = doc.page.width - 72, B = doc.page.height - 50;
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#16181d').text(safe(rep.title), L, 36, { width: W });
    doc.font('Helvetica').fontSize(9).fillColor('#667085').text(safe(store) + (rep.from ? `  |  ${rep.from} to ${rep.to}` : '') + '  |  Created ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', L, doc.y + 2, { width: W });
    doc.moveDown(0.6);
    // summary: label/value pairs in a row of boxes
    const sum = (rep.summary || []).filter((s) => s && s.label);
    if (sum.length) {
      const per = Math.min(5, sum.length), bw = (W - (per - 1) * 8) / per; let x = L, y = doc.y, n = 0;
      for (const s of sum) {
        if (n && n % per === 0) { x = L; y += 40; }
        doc.roundedRect(x, y, bw, 34, 4).lineWidth(0.5).strokeColor('#d0d5dd').stroke();
        doc.font('Helvetica').fontSize(7.5).fillColor('#667085').text(safe(s.label), x + 6, y + 5, { width: bw - 12, height: 10, ellipsis: true, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#16181d').text(fmt(s.value, s.type), x + 6, y + 17, { width: bw - 12, height: 14, ellipsis: true, lineBreak: false });
        x += bw + 8; n++;
      }
      doc.y = y + 44;
    }
    if (rep.note) { doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#667085').text(safe(rep.note), L, doc.y, { width: W }); doc.moveDown(0.5); }
    // table: column widths follow the longest content (bounded), then are scaled to the page
    const cols = rep.columns || [];
    if (cols.length) {
      doc.font('Helvetica').fontSize(8);
      const want = cols.map((c) => { let m = safe(c.label).length; for (const r of (rep.rows || []).slice(0, 200)) m = Math.max(m, fmt(r[c.key], c.type).length); return Math.min(Math.max(m, 4), 38) + 2; });
      const tot = want.reduce((a, b) => a + b, 0), w = want.map((x) => (x / tot) * W);
      const header = (y) => {
        doc.rect(L, y, W, 18).fill('#f2f4f7'); let x = L;
        cols.forEach((c, i) => { doc.font('Helvetica-Bold').fontSize(8).fillColor('#344054').text(safe(c.label), x + 3, y + 5, { width: w[i] - 6, height: 10, ellipsis: true, lineBreak: false, align: RIGHT.has(c.type) ? 'right' : 'left' }); x += w[i]; });
        return y + 18;
      };
      let y = header(doc.y), shade = false;
      for (const r of rep.rows || []) {
        if (y + 16 > B) { doc.addPage(); y = header(36); shade = false; }
        if (shade) doc.rect(L, y, W, 16).fill('#fafafa');
        let x = L;
        cols.forEach((c, i) => { doc.font('Helvetica').fontSize(8).fillColor('#16181d').text(fmt(r[c.key], c.type), x + 3, y + 4, { width: w[i] - 6, height: 10, ellipsis: true, lineBreak: false, align: RIGHT.has(c.type) ? 'right' : 'left' }); x += w[i]; });
        y += 16; shade = !shade;
      }
      if (!(rep.rows || []).length) doc.font('Helvetica').fontSize(9).fillColor('#667085').text('Nothing to show for this period.', L, y + 6);
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) { doc.switchToPage(i); doc.font('Helvetica').fontSize(7.5).fillColor('#98a2b3').text(`Page ${i - range.start + 1} of ${range.count}`, L, doc.page.height - 28, { width: W, align: 'right', lineBreak: false }); }
    doc.end();
  });
}
module.exports = { reportPdf };
