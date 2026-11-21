'use strict';
// Countries and currencies: conversion maths, weight-band delivery fees, tax, phone and postcode formats, Stripe webhook signatures. No database needed.
// Run with: npm run test:trade:unit
const assert = require('assert');
const crypto = require('crypto');
const CUR = require('../lib/currency');
const R = require('../lib/regions');
const STRIPE = require('../lib/stripe');

let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };

(async () => {
  console.log('\nCurrency conversion');
  await test('minor units come from the currency itself: dollars and naira have 2, yen has 0', () => {
    assert.strictEqual(CUR.decimals('USD'), 2); assert.strictEqual(CUR.decimals('NGN'), 2); assert.strictEqual(CUR.decimals('JPY'), 0);
    assert.strictEqual(CUR.toMinor(12.34, 'USD'), 1234); assert.strictEqual(CUR.toMinor(500, 'JPY'), 500);
  });
  await test('the markup makes the customer pay slightly MORE of their money, never less', () => {
    const r = CUR.chargeRate(1500, 2);
    assert.ok(r < 1500, 'a lower naira-per-dollar rate means more dollars charged');
    assert.strictEqual(CUR.chargeFor(150000, 1500, 'USD'), 10000);                 // exactly $100.00 with no markup
    assert.ok(CUR.chargeFor(150000, r, 'USD') > 10000);                           // $102.00 with a 2% markup
    assert.strictEqual(CUR.chargeFor(150000, r, 'USD'), 10200);
  });
  await test('amounts round UP so rounding can never leave the shop short', () => {
    assert.strictEqual(CUR.chargeFor(1000, 3, 'USD'), 33334);                      // 333.3333 -> 333.34
    assert.strictEqual(CUR.chargeFor(1000, 3, 'JPY'), 334);                        // 333.33 yen -> 334 (no decimals)
    assert.strictEqual(CUR.chargeFor(1500, 1500, 'USD'), 100);                     // exact amounts are not pushed up by floating point noise
  });
  await test('a missing or zero rate is an error, never a guess', () => {
    assert.throws(() => CUR.chargeFor(1000, 0, 'EUR'), /no exchange rate/);
    assert.throws(() => CUR.chargeFor(1000, undefined, 'EUR'), /no exchange rate/);
  });
  await test('formatting uses the currency\'s own symbol and decimals', () => {
    assert.match(CUR.format(10200, 'USD'), /102\.00/); assert.match(CUR.format(500, 'JPY'), /500/);
  });

  console.log('\nDelivery fee by weight');
  const bands = [{ up_to_kg: 0.5, fee: 25000 }, { up_to_kg: 1, fee: 30000 }, { up_to_kg: 2, fee: 42000 }, { up_to_kg: 5, fee: 75000 }, { up_to_kg: 10, fee: 130000 }];
  await test('the first band that is big enough is used, and a band edge belongs to that band', () => {
    assert.strictEqual(R.feeFor(bands, 12000, 0.2), 25000); assert.strictEqual(R.feeFor(bands, 12000, 0.5), 25000);
    assert.strictEqual(R.feeFor(bands, 12000, 0.51), 30000); assert.strictEqual(R.feeFor(bands, 12000, 5), 75000); assert.strictEqual(R.feeFor(bands, 12000, 10), 130000);
  });
  await test('beyond the last band each extra kg (rounded up) is added', () => {
    assert.strictEqual(R.feeFor(bands, 12000, 10.1), 130000 + 12000); assert.strictEqual(R.feeFor(bands, 12000, 12), 130000 + 24000); assert.strictEqual(R.feeFor(bands, 0, 50), 130000);
  });
  await test('bands in any order work, and a zone with no bands cannot quote', () => {
    assert.strictEqual(R.feeFor([...bands].reverse(), 0, 1.5), 42000);
    assert.strictEqual(R.feeFor([], 0, 1), null);
  });

  console.log('\nTax');
  await test('tax "added" goes on top; "included" is only the part already inside; "none" is zero', () => {
    assert.deepStrictEqual(R.taxOn('added', 20, 10000), { tax: 2000, added: true });
    assert.deepStrictEqual(R.taxOn('included', 20, 12000), { tax: 2000, added: false });
    assert.deepStrictEqual(R.taxOn('none', 20, 10000), { tax: 0, added: false });
    assert.deepStrictEqual(R.taxOn('added', 0, 10000), { tax: 0, added: false });
    assert.strictEqual(R.taxOn('added', 7.5, 3333).tax, 250);
  });

  console.log('\nPhone and postcode formats');
  const GB = { dial_code: '44', phone_min: 10, phone_max: 10, postcode_required: true, postcode_regex: '^[A-Za-z]{1,2}\\d[A-Za-z\\d]? ?\\d[A-Za-z]{2}$', name: 'United Kingdom' };
  const GH = { dial_code: '233', phone_min: 9, phone_max: 9, postcode_required: false, postcode_regex: '', name: 'Ghana' };
  await test('the same number is accepted with +, 00, the local 0, or spaces, and always stored the same way', () => {
    for (const v of ['+44 7911 123456', '07911 123456', '7911123456', '0044 7911 123456', '(07911) 123-456']) assert.strictEqual(R.normalisePhone(GB, v), '+447911123456', v);
    assert.strictEqual(R.normalisePhone(GH, '024 123 4567'), '+233241234567');
  });
  await test('numbers of the wrong length or country are refused', () => {
    assert.strictEqual(R.normalisePhone(GB, '12345'), null); assert.strictEqual(R.normalisePhone(GB, '+44 7911 1234567890'), null);
    assert.strictEqual(R.normalisePhone(GB, '+234 803 123 4567'), null, 'a Nigerian number is not a UK number');
    assert.strictEqual(R.normalisePhone(GB, 'call me'), null);
  });
  await test('postcodes follow the country: required or optional, and checked against its pattern', () => {
    assert.deepStrictEqual(R.checkPostcode(GB, 'sw1a 1aa'), { ok: true, value: 'SW1A 1AA' });
    assert.strictEqual(R.checkPostcode(GB, '12345').ok, false); assert.strictEqual(R.checkPostcode(GB, '').ok, false);
    assert.deepStrictEqual(R.checkPostcode(GH, ''), { ok: true, value: '' });
    assert.strictEqual(R.checkPostcode({ ...GH, postcode_regex: '([' }, 'X1').ok, true, 'a broken pattern in the admin never blocks every order');
    assert.strictEqual(R.checkPostcode(GB, 'A'.repeat(40)).ok, false);
  });

  console.log('\nStripe webhook signatures');
  const raw = Buffer.from('{"id":"evt_1","type":"checkout.session.completed"}'), secret = 'whsec_unit';
  const sign = (t, body = raw, sec = secret) => `t=${t},v1=${crypto.createHmac('sha256', sec).update(`${t}.`).update(body).digest('hex')}`;
  const T = 1800000000;
  await test('a correct signature passes; a wrong secret, a changed body or a missing header does not', () => {
    assert.ok(STRIPE.verifyWebhook(raw, sign(T), secret, { nowSec: T }));
    assert.ok(!STRIPE.verifyWebhook(raw, sign(T, raw, 'other'), secret, { nowSec: T }));
    assert.ok(!STRIPE.verifyWebhook(Buffer.from('{"id":"evt_2"}'), sign(T), secret, { nowSec: T }));
    assert.ok(!STRIPE.verifyWebhook(raw, '', secret, { nowSec: T })); assert.ok(!STRIPE.verifyWebhook(raw, sign(T), '', { nowSec: T }));
  });
  await test('an old message is refused, so a captured webhook cannot be replayed later', () => {
    assert.ok(STRIPE.verifyWebhook(raw, sign(T), secret, { nowSec: T + 299 }));
    assert.ok(!STRIPE.verifyWebhook(raw, sign(T), secret, { nowSec: T + 301 }));
  });
  await test('several signatures in the header (key rotation) are accepted if any matches', () => {
    const good = sign(T).split(',')[1];
    assert.ok(STRIPE.verifyWebhook(raw, `t=${T},v1=deadbeef,${good}`, secret, { nowSec: T }));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
