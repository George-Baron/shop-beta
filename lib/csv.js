'use strict';
// Reads supplier catalogues: CSV / pasted spreadsheet text (comma, semicolon or tab) and .xlsx files. No packages: .xlsx is a zip of XML files,
// and Node has zlib. Only the first worksheet is read, as plain values (formulas show their last saved result).
const zlib = require('zlib');

function detectDelimiter(text) {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  const score = (d) => { let n = 0, q = false; for (const ch of head) { if (ch === '"') q = !q; else if (!q && ch === d) n++; } return n; };
  const best = ['\t', ',', ';', '|'].map((d) => [d, score(d)]).sort((a, b) => b[1] - a[1])[0];
  return best[1] ? best[0] : ',';
}
// RFC 4180: quoted fields may hold the delimiter, quotes ("" = one quote) and line breaks.
function parseCsv(text, delimiter) {
  text = String(text).replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(text), rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"' && cell === '') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

/* ---------- .xlsx ---------- */
function unzip(buf) { // returns Map(name -> Buffer). Reads the central directory, so it copes with data descriptors.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('That does not look like an Excel (.xlsx) file.');
  const count = buf.readUInt16LE(end + 10); let p = buf.readUInt32LE(end + 16);
  const files = new Map(); let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('That Excel file is damaged.');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen); p += 46 + nlen + xlen + clen;
    if (!/^xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels)$/.test(name)) continue;
    if (usize > 30_000_000 || (total += usize) > 60_000_000) throw new Error('That Excel file is too large to read.'); // guards against zip bombs
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), raw = buf.subarray(start, start + csize);
    files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: 30_000_000 }));
  }
  return files;
}
const unxml = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, g) => (g[0] === '#' ? String.fromCodePoint(g[1] === 'x' ? parseInt(g.slice(2), 16) : Number(g.slice(1))) : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[g]));
const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

function parseXlsx(buf) {
  const files = unzip(buf);
  const shared = [];
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) for (const si of ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(unxml([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  // the first sheet in workbook order (not necessarily sheet1.xml)
  let target = 'xl/worksheets/sheet1.xml';
  const wb = files.get('xl/workbook.xml'), rels = files.get('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb.toString('utf8'));
    const rel = first && [...rels.toString('utf8').matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => new RegExp(`\\bId="${first[1]}"`).test(t));
    const to = rel && /\bTarget="([^"]+)"/.exec(rel);
    if (to) target = 'xl/' + to[1].replace(/^\/?(xl\/)?/, '');
  }
  const sheet = files.get(target) || files.get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('That Excel file has no worksheet to read.');
  const rows = [];
  for (const r of sheet.toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], ref = /\br="([A-Z]+\d+)"/.exec(attrs); if (!ref) continue;
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1], inner = c[2] || '';
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] || '';
      else if (type === 'inlineStr') val = unxml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
      else if (v !== undefined) val = unxml(v);
      row[colIndex(ref[1])] = val.trim();
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    if (row.some((x) => x !== '')) rows.push(row);
  }
  return rows;
}

// "¥1,234.50", "1.234,50", "$12", "12,5" -> number, or null when it is not a number.
function parseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v == null ? '' : v).trim().replace(/[^\d.,-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc >= 0 && ld >= 0) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lc >= 0) s = /,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

module.exports = { parseCsv, detectDelimiter, parseXlsx, parseNumber };
