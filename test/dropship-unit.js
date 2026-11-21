'use strict';
// Dropshipping unit tests: pricing maths, currency conversion, CSV/Excel reading, image-fetch safety. No database needed.
// Run with: npm run test:dropship:unit
const assert = require('assert');
const zlib = require('zlib');
const http = require('http');
const P = require('../lib/pricing');
const FX = require('../lib/fx');
const CSV = require('../lib/csv');
const SF = require('../lib/safe-fetch');

let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg || ''} expected ${b}, got ${a}`);

(async () => {
  console.log('\nPricing');
  await test('a worked example: 100 CNY + 20 CNY shipping at 210, 20% duty, 7.5% tax, 30% markup', () => {
    const r = P.calculate({ cost: 100, ship_cost: 20, rate: 210, duty_pct: 20, tax_pct: 7.5, margin: { type: 'percent', value: 30 } });
    near(r.goods, 21000); near(r.shipping, 4200); near(r.duty, 5040); near(r.tax, 2268); near(r.landed, 32508);
    near(r.margin_amount, 9752.4);
    assert.strictEqual(r.calculated_price, 43050);                       // 42,260.40 + fee, rounded up to the next 50
    near(r.fee, 745.75); near(r.profit, 9796.25);
    near(r.markup_pct, 30.14, 'markup'); near(r.margin_pct, 22.76, 'margin');
    assert.ok(!r.below_break_even);
  });
  await test('a fixed margin adds that many Naira, whatever the cost', () => {
    const r = P.calculate({ cost: 10, rate: 100, duty_pct: 0, tax_pct: 0, margin: { type: 'fixed', value: 2000 } });
    near(r.landed, 1000); near(r.margin_amount, 2000);
    assert.ok(r.profit >= 2000 - 0.01, 'profit ' + r.profit);
  });
  await test('the price covers cost + margin after fees, and is the smallest such price (checked against brute force)', () => {
    const brute = (T) => { let p = Math.max(1, Math.floor(T)); while (P.proceeds(p) < T - 1e-9) p++; return p; };
    // a lower price can never also work: walk down from the answer
    for (let T = 1; T <= 9000; T += 7) assert.strictEqual(P.priceForProceeds(T), brute(T), 'T=' + T);
    for (let T = 9000; T <= 400000; T += 997) assert.strictEqual(P.priceForProceeds(T), brute(T), 'T=' + T);
  });
  await test('the awkward step at the flat-fee threshold (2,500) is handled', () => {
    // just under the threshold a price needs no flat fee; just above, it does, so the answer must jump over the gap
    const T = 2470; const p = P.priceForProceeds(T);
    assert.ok(p >= 2500 && P.proceeds(p) >= T);
    assert.ok(P.proceeds(2499) < T && P.proceeds(2499) > 2400);
  });
  await test('rounding up never loses money across the threshold, for many costs', () => {
    for (let cost = 1; cost <= 4000; cost += 13) {
      const r = P.calculate({ cost, rate: 1, duty_pct: 0, tax_pct: 0, margin: { type: 'percent', value: 25 } });
      assert.ok(r.price % 50 === 0, 'rounded to 50: ' + r.price);
      assert.ok(r.profit + 1e-6 >= r.margin_amount, `cost ${cost}: profit ${r.profit} < margin ${r.margin_amount}`);
    }
  });
  await test('large prices hit the fee cap, not a percentage', () => {
    const r = P.calculate({ cost: 5_000_000, rate: 1, duty_pct: 0, tax_pct: 0, margin: { type: 'percent', value: 10 } });
    near(r.fee, 2000); assert.ok(r.profit >= r.margin_amount - 0.01);
  });
  await test('break-even is the smallest price that does not lose money', () => {
    const r = P.calculate({ cost: 100, ship_cost: 20, rate: 210, duty_pct: 20, tax_pct: 7.5, margin: { type: 'percent', value: 30 } });
    assert.ok(P.proceeds(r.break_even) >= r.landed - 1e-9); assert.ok(P.proceeds(r.break_even - 1) < r.landed);
    assert.ok(r.break_even < r.calculated_price);
  });
  await test('profit at the price actually charged, and a price below break-even is flagged', () => {
    const lossy = P.calculate({ cost: 100, rate: 210, duty_pct: 0, tax_pct: 0, price: 20000 });
    assert.ok(lossy.below_break_even); assert.ok(lossy.profit < 0);
    const fine = P.calculate({ cost: 100, rate: 210, duty_pct: 0, tax_pct: 0, price: 30000 });
    assert.ok(!fine.below_break_even); assert.ok(fine.profit > 0);
  });
  await test('product rule beats category, category beats supplier, supplier beats the shop default', () => {
    const m = (type, value) => ({ margin_type: type, margin_value: value });
    assert.deepStrictEqual(P.resolveMargin({ product: m('fixed', 500), category: m('percent', 40), supplier: m('percent', 20), shop: m('percent', 30) }), { type: 'fixed', value: 500, source: 'product' });
    assert.strictEqual(P.resolveMargin({ category: m('percent', 40), supplier: m('percent', 20), shop: m('percent', 30) }).source, 'category');
    assert.strictEqual(P.resolveMargin({ product: m(null, null), supplier: m('percent', 20), shop: m('percent', 30) }).source, 'supplier');
    assert.strictEqual(P.resolveMargin({ shop: m('percent', 30) }).source, 'shop');
    assert.strictEqual(P.resolveMargin({}).source, 'built-in');
    assert.strictEqual(P.resolveMargin({ product: m('percent', 0) }).value, 0, 'a margin of 0 is a real choice, not "unset"');
  });
  await test('a missing rate or a bad cost stops the calculation instead of guessing', () => {
    assert.throws(() => P.calculate({ cost: 10, rate: 0 }), /exchange rate/);
    assert.throws(() => P.calculate({ cost: 10, rate: undefined }), /exchange rate/);
    assert.throws(() => P.calculate({ cost: -1, rate: 5 }), /zero or more/);
  });
  await test('delivery estimates add processing and a safety buffer to the long end', () => {
    const st = { NG: { min: 7, max: 14 }, ALL: { min: 12, max: 25 } };
    assert.deepStrictEqual(P.deliveryEstimate({ processing_days: 3, ship_times: st, region: 'NG', buffer: 2 }), { min: 10, max: 19 });
    assert.deepStrictEqual(P.deliveryEstimate({ processing_days: 3, ship_times: st, region: 'GH', buffer: 2 }), { min: 15, max: 30 }, 'falls back to ALL');
    assert.strictEqual(P.deliveryEstimate({ processing_days: 3, ship_times: { NG: { min: 1, max: 2 } }, region: 'GH', buffer: 2 }), null, 'no promise without data');
    assert.strictEqual(P.deliveryEstimate({ processing_days: 3, ship_times: {}, region: 'NG' }), null);
  });

  console.log('\nCurrency conversion');
  const rates = { CNY: 210, USD: 1500, GBP: 1900 };
  await test('Naira per unit: 100 CNY = 21,000 NGN, and back', () => {
    near(FX.toNaira(100, 'CNY', rates), 21000); near(FX.fromNaira(21000, 'CNY', rates), 100);
  });
  await test('cross rates go through Naira: 100 CNY = 14 USD', () => near(FX.convert(100, 'CNY', 'USD', rates), 14));
  await test('same currency and Naira need no rate', () => { assert.strictEqual(FX.convert(5, 'EUR', 'EUR', {}), 5); assert.strictEqual(FX.convert(5, 'NGN', 'NGN', {}), 5); near(FX.convert(2, 'USD', 'NGN', rates), 3000); });
  await test('currency codes are case-insensitive', () => near(FX.convert(1, 'usd', 'ngn', rates), 1500));
  await test('a missing, zero or negative rate is an error, never a guess', () => {
    assert.throws(() => FX.convert(1, 'EUR', 'NGN', rates), /no exchange rate for EUR/);
    assert.throws(() => FX.convert(1, 'USD', 'NGN', { USD: 0 }), /no exchange rate/);
    assert.throws(() => FX.convert(1, 'USD', 'NGN', { USD: -5 }), /no exchange rate/);
    assert.throws(() => FX.convert('abc', 'USD', 'NGN', rates), /not a number/);
  });
  await test('converting there and back gives the same amount', () => { for (const a of [0.01, 1, 99.99, 123456.78]) near(FX.convert(FX.convert(a, 'GBP', 'CNY', rates), 'CNY', 'GBP', rates), a); });

  console.log('\nCSV and pasted text');
  await test('quoted fields keep commas, quotes and line breaks', () => {
    const r = CSV.parseCsv('sku,name,note\r\nA1,"Cable, 2m","He said ""hi"""\r\nA2,Plug,"line1\nline2"\r\n');
    assert.deepStrictEqual(r, [['sku', 'name', 'note'], ['A1', 'Cable, 2m', 'He said "hi"'], ['A2', 'Plug', 'line1\nline2']]);
  });
  await test('delimiter is detected: comma, semicolon, tab (pasted from a spreadsheet)', () => {
    assert.deepStrictEqual(CSV.parseCsv('a;b;c\n1;2;3'), [['a', 'b', 'c'], ['1', '2', '3']]);
    assert.deepStrictEqual(CSV.parseCsv('a\tb\tc\n1\t2\t3'), [['a', 'b', 'c'], ['1', '2', '3']]);
    assert.deepStrictEqual(CSV.parseCsv('a,b\n"1,5",2'), [['a', 'b'], ['1,5', '2']], 'a comma inside quotes is not a delimiter');
  });
  await test('BOM, blank lines and trailing spaces are tolerated', () => assert.deepStrictEqual(CSV.parseCsv('﻿a,b\n\n 1 , 2 \n,\n'), [['a', 'b'], ['1', '2']]));
  await test('numbers with currency symbols and either decimal style', () => {
    const t = [['¥1,234.50', 1234.5], ['$12', 12], ['1.234,50', 1234.5], ['12,5', 12.5], ['1,234', 1234], ['1,234,567.89', 1234567.89], ['₦ 2 500', 2500], ['-3', -3], ['abc', null], ['', null], [' ', null], [7, 7]];
    for (const [i, o] of t) assert.strictEqual(CSV.parseNumber(i), o, `"${i}"`);
  });

  console.log('\nExcel (.xlsx)');
  const crc32 = zlib.crc32 || ((b) => { let c, t = [], crc = -1; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } for (const x of b) crc = t[(crc ^ x) & 0xff] ^ (crc >>> 8); return (crc ^ -1) >>> 0; });
  const makeZip = (entries, { store } = {}) => { // entries: { name: string }
    const parts = [], central = []; let off = 0;
    for (const [name, text] of Object.entries(entries)) {
      const raw = Buffer.from(text), data = store ? raw : zlib.deflateRawSync(raw), nm = Buffer.from(name);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(store ? 0 : 8, 10); ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
      parts.push(lh, nm, data); central.push(ch, nm); off += 30 + nm.length + data.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([...parts, cd, end]);
  };
  const xlsx = (sheetRows, extra = {}) => makeZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Catalogue" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>SKU</t></si><si><t>Name</t></si><si><t>Cost</t></si><si><t>Cable &amp; Plug</t></si><si><r><t>Rich </t></r><r><t>text</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>', // a decoy: the workbook points at sheet2
    'xl/worksheets/sheet2.xml': `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`, ...extra });
  const rowsXml = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>X-100</t></is></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>12.5</v></c></row>' +
    '<row r="3"><c r="A3"><v>200</v></c><c r="C3"><v>99</v></c></row>' + // B3 is empty
    '<row r="4"><c r="A4" t="s"><v>4</v></c></row>';
  await test('reads the first worksheet in workbook order: shared strings, inline strings, numbers, empty cells, XML entities', () => {
    assert.deepStrictEqual(CSV.parseXlsx(xlsx(rowsXml)), [['SKU', 'Name', 'Cost'], ['X-100', 'Cable & Plug', '12.5'], ['200', '', '99'], ['Rich text']]);
  });
  await test('stored (uncompressed) entries work too', () => assert.strictEqual(CSV.parseXlsx(makeZip({ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>' }, { store: true }))[0][0], '1'));
  await test('a file that is not an Excel file gives a clear error', () => {
    assert.throws(() => CSV.parseXlsx(Buffer.from('just some text, not a zip file at all, nope nope nope nope')), /does not look like an Excel/);
    assert.throws(() => CSV.parseXlsx(makeZip({ 'readme.txt': 'hi' })), /no worksheet/);
  });

  console.log('\nImage download safety');
  await test('private, loopback, link-local and mapped addresses are recognised', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '224.0.0.1', 'not-an-ip']) assert.ok(SF.isPrivateIp(ip), ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '203.0.113.5', '2606:4700:4700::1111']) assert.ok(!SF.isPrivateIp(ip), ip);
  });
  await test('internal addresses, odd schemes, logins and odd ports are refused before any request', async () => {
    delete process.env.ALLOW_PRIVATE_IMAGE_HOSTS;
    await assert.rejects(() => SF.fetchBuffer('http://127.0.0.1/x.png'), /not allowed/);
    await assert.rejects(() => SF.fetchBuffer('http://169.254.169.254/latest/meta-data/'), /not allowed/);
    await assert.rejects(() => SF.fetchBuffer('http://localhost/x.png'), /not allowed/);
    await assert.rejects(() => SF.fetchBuffer('file:///etc/passwd'), /Only http/);
    await assert.rejects(() => SF.fetchBuffer('ftp://example.com/a.png'), /Only http/);
    await assert.rejects(() => SF.fetchBuffer('https://user:pw@example.com/a.png'), /login/);
    await assert.rejects(() => SF.fetchBuffer('https://example.com:8443/a.png'), /port/);
    await assert.rejects(() => SF.fetchBuffer('not a url'), /valid address/);
  });
  await test('downloads follow redirects, and stop at size limits, errors and redirect loops', async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/ok') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.alloc(100, 1));
      if (req.url === '/redir') return res.writeHead(302, { Location: '/ok' }).end();
      if (req.url === '/loop') return res.writeHead(302, { Location: '/loop' }).end();
      if (req.url === '/big') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.alloc(3000, 1));
      if (req.url === '/bigchunked') { res.writeHead(200); res.write(Buffer.alloc(2000, 1)); return setTimeout(() => res.end(Buffer.alloc(2000, 1)), 20); }
      res.writeHead(404).end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
    process.env.ALLOW_PRIVATE_IMAGE_HOSTS = '1';
    try {
      assert.strictEqual((await SF.fetchBuffer(base + '/ok')).buf.length, 100);
      assert.strictEqual((await SF.fetchBuffer(base + '/redir')).buf.length, 100);
      await assert.rejects(() => SF.fetchBuffer(base + '/loop'), /redirects/);
      await assert.rejects(() => SF.fetchBuffer(base + '/big', { maxBytes: 1000 }), /too large/);
      await assert.rejects(() => SF.fetchBuffer(base + '/bigchunked', { maxBytes: 3000 }), /too large/);
      await assert.rejects(() => SF.fetchBuffer(base + '/missing'), /404/);
    } finally { delete process.env.ALLOW_PRIVATE_IMAGE_HOSTS; srv.close(); }
  });

  await test('production preflight fails if the private-address switch is left on, and the code ignores it in production', async () => {
    const { checkEnv } = require('../lib/preflight');
    assert.ok(checkEnv({ NODE_ENV: 'production', ALLOW_PRIVATE_IMAGE_HOSTS: '1' }).some((r) => r.level === 'FAIL' && r.name === 'ALLOW_PRIVATE_IMAGE_HOSTS'));
    assert.ok(!checkEnv({ NODE_ENV: 'production' }).some((r) => r.name === 'ALLOW_PRIVATE_IMAGE_HOSTS'));
    const was = process.env.NODE_ENV; process.env.NODE_ENV = 'production'; process.env.ALLOW_PRIVATE_IMAGE_HOSTS = '1';
    try { await assert.rejects(() => SF.fetchBuffer('http://127.0.0.1/x.png'), /not allowed/); } finally { if (was === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = was; delete process.env.ALLOW_PRIVATE_IMAGE_HOSTS; }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
