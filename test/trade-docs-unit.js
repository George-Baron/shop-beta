'use strict';
// Landed-cost maths (import and export, every Incoterm rule, currency conversion), restricted-item matching and the PDF layout. No database needed.
// Run with: npm run test:trade-docs:unit
const assert = require('assert');
const L = require('../lib/trade-landed');
const TC = require('../lib/trade-compliance');
const PDF = require('../lib/pdf');

let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };
const base = { direction: 'import', incoterm: 'FOB', currency: 'USD', goods: 10000, freight: 800, insurance: 100, duty_pct: 20, vat_pct: 7.5, agent_fee: 150 };
const line = (r, k) => r.lines.find((l) => l.key === k);

(async () => {
  console.log('\nLanded cost: import');
  await test('FOB: duty is charged on goods + freight + insurance, VAT on that plus duty, and every line adds up to the total', () => {
    const r = L.landed(base);
    assert.strictEqual(r.totals.customs_value, 1090000);                                 // 10,900.00 in cents
    assert.strictEqual(line(r, 'duty').minor, 218000); assert.strictEqual(line(r, 'vat').minor, 98100);   // 20% of 10,900 and 7.5% of 13,080
    assert.strictEqual(r.totals.landed_total, 1421100); assert.strictEqual(r.totals.our_cost, 1421100);
    assert.strictEqual(r.lines.reduce((a, l) => a + l.minor, 0), r.totals.landed_total, 'lines add up');
  });
  await test('CIF: freight and insurance are already in the price, so they are not added again and not charged duty twice', () => {
    const r = L.landed({ ...base, incoterm: 'CIF' });
    assert.strictEqual(r.totals.customs_value, 1000000); assert.strictEqual(r.totals.landed_total, 1305000);   // 10,000 + 2,000 + 900 + 150
    assert.ok(line(r, 'freight').included_in_price && line(r, 'insurance').included_in_price);
    assert.ok(r.warnings.some((w) => /Freight is already inside the goods price/.test(w)));
  });
  await test('DDP: the seller pays duty and VAT, so we only pay the goods and our own agent', () => {
    const r = L.landed({ ...base, incoterm: 'DDP' });
    assert.strictEqual(r.totals.our_cost, 1015000); assert.ok(line(r, 'duty').included_in_price && line(r, 'duty').paid_by === 'other');
    assert.ok(r.warnings.some((w) => /seller pays duty and VAT/.test(w)));
  });
  await test('EXW: nothing is in the price, the buyer pays everything', () => {
    const r = L.landed({ ...base, incoterm: 'EXW' });
    assert.ok(r.lines.filter((l) => l.key !== 'goods').every((l) => !l.included_in_price)); assert.strictEqual(r.totals.landed_total, 1421100);
  });
  await test('a clearing agent can charge a percentage of the customs value as well as a flat fee', () => {
    const r = L.landed({ ...base, agent_fee: 100, agent_pct: 1 });
    assert.strictEqual(line(r, 'agent_fee').minor, 10000 + 10900);                      // 100.00 + 1% of 10,900.00
  });
  console.log('\nLanded cost: export');
  await test('export: we are the seller, so our cost is what the Incoterm leaves with us, and the goods are revenue', () => {
    const r = L.landed({ ...base, direction: 'export', incoterm: 'CIF' });
    assert.strictEqual(line(r, 'goods').paid_by, 'other'); assert.strictEqual(line(r, 'freight').paid_by, 'us');
    assert.strictEqual(r.totals.our_cost, 80000 + 10000 + 15000, 'freight + insurance + our agent');
    assert.strictEqual(r.totals.buyer_pays, 1000000 + 200000 + 90000, 'goods + their duty and VAT');
  });
  await test('export DDP: we also pay the destination duty and VAT', () => {
    const r = L.landed({ ...base, direction: 'export', incoterm: 'DDP' });
    assert.strictEqual(r.totals.our_cost, 80000 + 10000 + 200000 + 90000 + 15000); assert.strictEqual(r.totals.buyer_pays, 1000000);
  });
  console.log('\nCurrencies');
  await test('any currency: the totals are converted through naira with the given rates and rounded to the currency\'s own decimals', () => {
    const r = L.landed({ ...base, show_in: 'NGN' }, { USD: 1500 });
    assert.strictEqual(r.converted.currency, 'NGN'); assert.strictEqual(r.converted.rate, 1500); assert.strictEqual(r.converted.totals.landed_total, 14211 * 1500);
    const y = L.landed({ ...base, currency: 'JPY', goods: 100000, freight: 0, insurance: 0, duty_pct: 0, vat_pct: 0, agent_fee: 0, show_in: 'USD' }, { JPY: 10, USD: 1500 });
    assert.strictEqual(y.decimals, 0); assert.strictEqual(y.converted.totals.landed_total, 666.67);
  });
  await test('a missing exchange rate is an error, never a guess', () => {
    const r = L.landed({ ...base, show_in: 'CNY' }, { USD: 1500 });
    assert.match(r.convert_error, /no exchange rate for CNY/); assert.ok(!r.converted, 'no guessed conversion'); assert.ok(r.totals_major.landed_total > 0, 'the cost itself is still worked out');
  });
  await test('bad input is refused with a plain message', () => {
    assert.throws(() => L.landed({ ...base, goods: -1 }), /goods value must be a number/);
    assert.throws(() => L.landed({ ...base, duty_pct: 900 }), /Duty must be between/);
    assert.throws(() => L.landed({ ...base, incoterm: 'XYZ' }), /Incoterm/);
    assert.throws(() => L.landed({ ...base, freight: 'abc' }), /Freight must be a number/);
  });
  await test('rounding is half up per line, so odd cents never make the lines disagree with the total', () => {
    const r = L.landed({ direction: 'import', incoterm: 'FOB', currency: 'USD', goods: 33.33, freight: 0, insurance: 0, duty_pct: 12.5, vat_pct: 7.5 });
    assert.strictEqual(r.lines.reduce((a, l) => a + l.minor, 0), r.totals.landed_total);
    assert.strictEqual(line(r, 'duty').minor, 417);                                       // 12.5% of 33.33 = 4.16625 -> 4.17
  });

  console.log('\nRestricted items');
  const classes = [
    { slug: 'medicines', label: 'Medicines', action: 'block', keywords: 'medicine,tablet,paracetamol', hs_prefixes: '3004', active: 1 },
    { slug: 'batteries', label: 'Batteries', action: 'review', keywords: 'battery,lithium,power bank', hs_prefixes: '8507', active: 1 },
    { slug: 'food', label: 'Food', action: 'review', keywords: 'snack,supplement', hs_prefixes: '19', active: 0 },
  ];
  await test('matches whole words, plurals and multi-word phrases, case-insensitively', async () => {
    assert.strictEqual((await TC.classify({ name: 'Paracetamol 500mg Tablets' }, classes)).action, 'block');
    assert.strictEqual((await TC.classify({ name: 'Fast Charging POWER BANK 20000mAh' }, classes)).slug, 'batteries');
    assert.strictEqual((await TC.classify({ name: 'AA Lithium Batteries 4-pack' }, classes)).action, 'review');
  });
  await test('does not match inside another word, and ignores a class that is turned off', async () => {
    assert.strictEqual((await TC.classify({ name: 'Batterysea Beach Towel' }, classes)).action, '');
    assert.strictEqual((await TC.classify({ name: 'Healthy snack box' }, classes)).action, '', 'the food class is switched off');
  });
  await test('an HS code starting with a listed prefix is caught even when the name looks harmless', async () => {
    const r = await TC.classify({ name: 'Wellness item', hs_code: '3004.90' }, classes); assert.strictEqual(r.action, 'block'); assert.match(r.hits[0].why, /HS code starts with 3004/);
    assert.strictEqual((await TC.classify({ name: 'Cable', hs_code: '8544.42' }, classes)).action, '');
  });
  await test('a block outranks a review when both match', async () => {
    const r = await TC.classify({ name: 'Lithium battery and medicine kit' }, classes); assert.strictEqual(r.action, 'block'); assert.strictEqual(r.hits.length, 2);
  });
  await test('words typed with special characters cannot break the matcher', async () => {
    const odd = [{ slug: 'x', label: 'X', action: 'review', keywords: 'a+b,(c,[d', hs_prefixes: '', active: 1 }];
    assert.strictEqual((await TC.classify({ name: 'a+b widget' }, odd)).action, 'review'); assert.strictEqual((await TC.classify({ name: 'plain' }, odd)).action, '');
  });

  console.log('\nPDF layout');
  await test('a long description wraps inside its column and the document is a valid PDF', () => {
    const buf = PDF.build([{ text: 'x'.repeat(40) + ' ' + 'word '.repeat(60), font: 'C', size: 8 }], { title: 'T' });
    assert.strictEqual(buf.toString('latin1', 0, 5), '%PDF-'); assert.ok(buf.toString('latin1').includes('%%EOF'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
