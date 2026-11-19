'use strict';
// A tiny PDF writer for plain documents (purchase orders, later trade documents). Text only, A4, Helvetica and Courier, automatic page breaks.
// No dependency: the file is built by hand. Text is reduced to what the standard PDF fonts can show (accents are dropped, other letters become "?").
const W = 595, H = 842, M = 48;
const FONTS = { H: 'Helvetica', HB: 'Helvetica-Bold', C: 'Courier' };
const WIDTH = { H: 0.5, HB: 0.55, C: 0.6 };        // average character width as a share of the font size (Courier is exact)

const clean = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/₦/g, 'N').replace(/[^\x20-\x7e]/g, '?');
const esc = (s) => clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function wrap(text, font, size, maxWidth) {
  const per = size * WIDTH[font], limit = Math.max(8, Math.floor(maxWidth / per)), out = [];
  for (const para of clean(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      let w = word;
      while (w.length > limit) { if (line) { out.push(line); line = ''; } out.push(w.slice(0, limit)); w = w.slice(limit); }
      if (!line) line = w; else if ((line + ' ' + w).length <= limit) line += ' ' + w; else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

// blocks: [{ text, font: 'H'|'HB'|'C', size, gap }]. Returns a Buffer.
function build(blocks, { title = 'Document' } = {}) {
  const pages = [[]]; let y = H - M;
  for (const b of blocks) {
    const font = b.font || 'H', size = b.size || 10, lead = size * 1.35;
    for (const line of wrap(b.text, font, size, W - 2 * M)) {
      if (y - lead < M) { pages.push([]); y = H - M; }
      y -= lead; pages[pages.length - 1].push(`BT /${font} ${size} Tf ${M} ${y.toFixed(1)} Td (${esc(line)}) Tj ET`);
    }
    y -= b.gap == null ? 3 : b.gap;
  }
  const objs = [];                                              // 1-based object numbers: 1 catalog, 2 pages, 3..5 fonts, 6 info, then page/content pairs
  const add = (s) => { objs.push(s); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${7 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  add(`<< /Title (${esc(title)}) /Producer (Shop-Beta) >>`);
  pages.forEach((ops, i) => {
    const content = ops.join('\n');
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /H 3 0 R /HB 4 0 R /C 5 0 R >> >> /Contents ${8 + i * 2} 0 R >>`);
    add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
module.exports = { build, clean, wrap, FONTS };
