'use strict';
// Minimal, dependency-light spreadsheet reading and writing: .xlsx (via fflate) and .csv.
// Reading takes the first sheet and returns an array of rows (arrays of strings). Limits protect against huge or booby-trapped files.
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');

const LIMITS = { fileBytes: 8 * 1024 * 1024, unzippedBytes: 60 * 1024 * 1024, rows: 10001, cols: 40 };

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const xml = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const colName = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

class SheetError extends Error {}
const bad = (m) => { throw new SheetError(m); };

/* ---------- reading ---------- */
// For readers that open the file themselves (the product import uses ExcelJS): refuse a booby-trapped file BEFORE anything is expanded.
// An .xlsx is a zip; a small file can claim to expand to gigabytes. We read only the zip's table of contents, never the contents.
function assertZipSafe(buf, maxUnzipped = LIMITS.unzippedBytes, maxEntries = 200) {
  let total = 0, n = 0;
  try {
    unzipSync(new Uint8Array(buf), { filter: (f) => { n++; total += f.originalSize; if (n > maxEntries || total > maxUnzipped) throw new SheetError('This spreadsheet is too large or unusual to read. Save it again from Excel as .xlsx or .csv, with fewer rows, and try again.'); return false; } });
  } catch (e) { if (e instanceof SheetError) throw e; bad('That file could not be read as an Excel (.xlsx) file. Save it as .xlsx or .csv and try again.'); }
}
function readXlsx(buf) {
  if (buf.length > LIMITS.fileBytes) bad('That file is too large. Keep it under 8 MB (about 10,000 products).');
  let files;
  try {
    let total = 0;
    files = unzipSync(new Uint8Array(buf), { filter: (f) => { total += f.originalSize; if (total > LIMITS.unzippedBytes) throw new SheetError('This spreadsheet is too large when opened.'); return /^(xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/worksheets\/[^/]+\.xml)$/.test(f.name); } });
  } catch (e) { if (e instanceof SheetError) throw e; bad('That file could not be read as an Excel (.xlsx) file. Save it as .xlsx or .csv and try again.'); }
  const text = (n) => (files[n] ? strFromU8(files[n]) : '');
  // shared strings
  const shared = [];
  const sst = text('xl/sharedStrings.xml');
  for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(unxml([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  // first sheet (in workbook order)
  let target = '';
  const wb = text('xl/workbook.xml'), rels = text('xl/_rels/workbook.xml.rels');
  const first = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb);
  if (first) { const rel = new RegExp('<Relationship\\b[^>]*Id="' + first[1].replace(/[^\w-]/g, '') + '"[^>]*>').exec(rels); const t = rel && /Target="([^"]+)"/.exec(rel[0]); if (t) target = 'xl/' + t[1].replace(/^\/?(xl\/)?/, ''); }
  if (!target || !files[target]) target = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort()[0];
  if (!target) bad('No sheet was found in that file.');
  const sheet = strFromU8(files[target]);
  const rows = [];
  for (const rm0 of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= LIMITS.rows) bad('Too many rows. Import at most 10,000 products at a time.');
    const rm = [rm0[0], (/\br="(\d+)"/.exec(rm0[1]) || [])[1], rm0[2]];
    const rn = rm[1] ? Number(rm[1]) - 1 : rows.length;
    while (rows.length < rn) rows.push([]);
    const row = [];
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], ref = /\br="([A-Z]+)\d+"/.exec(attrs), type = /\bt="(\w+)"/.exec(attrs);
      const ci = ref ? colIndex(ref[1]) : row.length; if (ci >= LIMITS.cols) continue;
      const inner = cm[2] || ''; let v = '';
      if (type && type[1] === 'inlineStr') v = unxml([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
      else { const vm = /<v>([\s\S]*?)<\/v>/.exec(inner); v = vm ? vm[1] : ''; if (type && type[1] === 's') v = shared[Number(v)] || ''; else if (type && type[1] === 'b') v = v === '1' ? 'TRUE' : 'FALSE'; else v = unxml(v); }
      while (row.length < ci) row.push('');
      row[ci] = v;
    }
    rows.push(row);
  }
  return rows;
}

/* ---------- csv ---------- */
function readCsv(buf) {
  if (buf.length > LIMITS.fileBytes) bad('That file is too large. Keep it under 8 MB (about 10,000 products).');
  let s = Buffer.from(buf).toString('utf8').replace(/^﻿/, '');
  const first = s.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cur = '', q = false, any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') { q = true; any = true; } else if (ch === delim) { row.push(cur); cur = ''; any = true; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; if (any || cur !== '' || row.length) { row.push(cur); rows.push(row.slice(0, LIMITS.cols)); } row = []; cur = ''; any = false; if (rows.length > LIMITS.rows) bad('Too many rows. Import at most 10,000 products at a time.'); }
    else { cur += ch; any = true; }
  }
  if (any || cur !== '' || row.length) { row.push(cur); rows.push(row.slice(0, LIMITS.cols)); }
  if (rows.length > LIMITS.rows) bad('Too many rows. Import at most 10,000 products at a time.');
  return rows;
}

function readSheet(buf, filename = '') {
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (/\.xls$/i.test(filename) && !isZip) bad('Old .xls files are not supported. In Excel choose Save As > Excel Workbook (.xlsx) or CSV.');
  const rows = (isZip ? readXlsx(buf) : readCsv(buf)).map((r) => r.map((c) => String(c == null ? '' : c).trim()));
  return rows.filter((r) => r.some((c) => c !== ''));
}

/* ---------- writing ---------- */
// sheets: [{ name, rows: [[...]], widths?: [..], header?: true }]. Strings are stored as text, never as formulas.
function writeXlsx(sheets) {
  const files = {};
  const wsXml = (sh) => {
    const cols = (sh.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const body = sh.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => {
      const ref = colName(ci) + (ri + 1), head = sh.header !== false && ri === 0;
      if (c === '' || c == null) return '';
      if (typeof c === 'number' && Number.isFinite(c)) return `<c r="${ref}"${head ? ' s="1"' : ''}><v>${c}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${head ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(c)}</t></is></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${sh.header === false ? '' : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'}</sheetView></sheetViews>${cols ? '<cols>' + cols + '</cols>' : ''}<sheetData>${body}</sheetData></worksheet>`;
  };
  sheets.forEach((sh, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(wsXml(sh)); });
  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  files['xl/workbook.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sh, i) => `<sheet name="${xml(sh.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  files['xl/styles.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F5C3A"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>');
  return Buffer.from(zipSync(files, { level: 6 }));
}

// CSV for Excel: UTF-8 with a byte-order mark. Cells that start like a formula get a leading apostrophe so they cannot run when opened.
const safeCell = (c) => { const s = String(c == null ? '' : c); return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s; };
function writeCsv(rows) {
  const q = (c) => { const s = safeCell(c); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return Buffer.from('﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n', 'utf8');
}

module.exports = { assertZipSafe, readSheet, readXlsx, readCsv, writeXlsx, writeCsv, SheetError, LIMITS };
