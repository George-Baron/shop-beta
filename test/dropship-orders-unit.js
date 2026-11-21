'use strict';
// Dropship order state machine, purchase order documents, the PDF writer and the "stuck order" rules. No database needed.
// Run with: npm run test:dropship-orders:unit
const assert = require('assert');
const DO = require('../lib/dropship-orders');
const PDF = require('../lib/pdf');

let passed = 0, failed = 0;
const test = async (n, f) => { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n       ')); } };
const ORDER = ['pending_payment', 'paid', 'sent', 'confirmed', 'shipped', 'in_transit', 'customs', 'delivered'];

(async () => {
  console.log('\nState machine');
  await test('the happy path goes paid > sent > confirmed > shipped > in transit > customs > delivered, one step at a time', () => {
    for (let i = 0; i < ORDER.length - 1; i++) assert.ok(DO.allowed(ORDER[i], ORDER[i + 1]), `${ORDER[i]} -> ${ORDER[i + 1]}`);
  });
  await test('nothing can be ordered, confirmed or shipped without going through the steps before it', () => {
    assert.ok(!DO.allowed('pending_payment', 'sent')); assert.ok(!DO.allowed('pending_payment', 'shipped')); assert.ok(!DO.allowed('paid', 'confirmed'));
    assert.ok(!DO.allowed('paid', 'shipped')); assert.ok(!DO.allowed('sent', 'shipped')); assert.ok(!DO.allowed('paid', 'delivered'));
  });
  await test('an item never goes backwards', () => {
    for (let i = 1; i < ORDER.length; i++) for (let j = 0; j < i; j++) assert.ok(!DO.allowed(ORDER[i], ORDER[j]), `${ORDER[i]} -> ${ORDER[j]}`);
  });
  await test('shipping can skip customs for local parcels (in transit or shipped straight to delivered)', () => {
    assert.ok(DO.allowed('shipped', 'delivered')); assert.ok(DO.allowed('in_transit', 'delivered')); assert.ok(DO.allowed('shipped', 'customs'));
  });
  await test('cancelling is possible only before the parcel leaves the supplier', () => {
    for (const s of ['pending_payment', 'paid', 'sent', 'confirmed', 'issue']) assert.ok(DO.allowed(s, 'cancelled'), s);
    for (const s of ['shipped', 'in_transit', 'customs', 'delivered', 'refunded']) assert.ok(!DO.allowed(s, 'cancelled'), s);
  });
  await test('a supplier problem can be raised from the moment it is ordered until it arrives, and has only three ways out', () => {
    for (const s of ['sent', 'confirmed', 'shipped', 'in_transit', 'customs']) assert.ok(DO.allowed(s, 'issue'), s);
    assert.ok(!DO.allowed('paid', 'issue')); assert.ok(!DO.allowed('delivered', 'issue'));
    assert.deepStrictEqual([...DO.NEXT.issue].sort(), ['cancelled', 'confirmed', 'paid', 'shipped']);
  });
  await test('refunds follow only a cancellation or a return, and a refund is final', () => {
    assert.ok(DO.allowed('cancelled', 'refunded')); assert.ok(DO.allowed('returned', 'refunded')); assert.ok(DO.allowed('delivered', 'returned'));
    assert.ok(!DO.allowed('paid', 'refunded')); assert.ok(!DO.allowed('delivered', 'refunded')); assert.deepStrictEqual(DO.NEXT.refunded, []);
  });
  await test('every state is reachable, every target is a real state, and only refunded has no way out', () => {
    const seen = new Set(['pending_payment']), todo = ['pending_payment'];
    while (todo.length) for (const n of DO.NEXT[todo.pop()]) { assert.ok(DO.STATES.includes(n), n); if (!seen.has(n)) { seen.add(n); todo.push(n); } }
    assert.deepStrictEqual([...seen].sort(), [...DO.STATES].sort());
    assert.deepStrictEqual(DO.STATES.filter((s) => !DO.NEXT[s].length), ['refunded']);
  });
  await test('the words shown to customers never name the supplier or hint at cost', () => {
    for (const s of DO.STATES) { assert.ok(DO.LABEL[s], s); assert.ok(!/suppl|cost|margin|profit/i.test(DO.LABEL[s]), DO.LABEL[s]); }
  });

  console.log('\nPurchase order documents');
  const d = {
    po: { ref: 'PO-00007', currency: 'CNY', total_cost: 0, body: '' },
    sup: { name: 'Shenzhen Gadgets Ltd', contact_name: 'Li Wei', address: "Bao'an District", country: 'CN', email: 'li@sz.example', whatsapp: '+86 138 0000 0000', payment_terms: 'Prepaid' },
    o: { name: 'Zoë Ödegård', phone: '+447911123456', address: '10 Downing Street', landmark: '', city: 'London', state: 'England', postcode: 'SW1A 2AA', country: 'GB', email: 'zoe.private@example.com', total: 99999, ref: 'SB-SECRET1' },
    lines: [{ supplier_sku: 'SZ-100', name: 'Zorbix Earbuds Pro', variant_label: 'Black', qty: 2, unit_cost: '100.00', ship_cost: '20.00', sell_price: 43050 }, { supplier_sku: '', name: 'Cable', variant_label: '', qty: 1, unit_cost: '5.50', ship_cost: '0', sell_price: 900 }],
    store: { store_name: 'VELTO-MART', contact_email: 'hello@shop.example', contact_phone: '+234 800 000 0000', address: 'Lagos' },
  };
  await test('the order text has what the supplier needs to ship: destination, phone, items, quantities, cost and a reference to quote', () => {
    const t = DO.poText(d);
    for (const w of ['PO-00007', 'Shenzhen Gadgets Ltd', 'Li Wei', '10 Downing Street', 'London', 'SW1A 2AA', 'United Kingdom', '+447911123456', 'Zorbix Earbuds Pro', '(Black)', 'SZ-100', 'x 2', '240.00 CNY', 'Prepaid', 'DIRECTLY']) assert.ok(t.includes(w), w);
    assert.ok(t.includes('245.50 CNY'), 'total = 2 x (100 + 20) + 5.50');
  });
  await test('the supplier never learns the customer\'s email, what the customer paid, or our order total', () => {
    const t = DO.poText(d), pdf = DO.poPdf(d).toString('latin1');
    for (const secret of ['zoe.private@example.com', '43050', '43,050', '99999', 'SB-SECRET1']) { assert.ok(!t.includes(secret), 'text leaks ' + secret); assert.ok(!pdf.includes(secret), 'pdf leaks ' + secret); }
  });
  await test('the WhatsApp link is built from the supplier\'s number and the order text, or is empty without a number', () => {
    const u = DO.waLink(d.sup, DO.poText(d));
    assert.ok(u.startsWith('https://wa.me/8613800000000?text=')); assert.ok(decodeURIComponent(u).includes('PO-00007'));
    assert.strictEqual(DO.waLink({ whatsapp: '' }, 'x'), ''); assert.strictEqual(DO.waLink({ whatsapp: 'call me' }, 'x'), '');
  });
  await test('the PDF is a real PDF with the order in it, and accents and symbols cannot break it', () => {
    const buf = DO.poPdf(d), s = buf.toString('latin1');
    assert.ok(s.startsWith('%PDF-1.4')); assert.ok(s.trimEnd().endsWith('%%EOF')); assert.ok(s.includes('PURCHASE ORDER')); assert.ok(s.includes('PO-00007')); assert.ok(s.includes('Zorbix Earbuds Pro'));
    const xref = Number(/startxref\n(\d+)/.exec(s)[1]); assert.strictEqual(s.slice(xref, xref + 4), 'xref', 'the cross-reference table is where the file says it is');
    const odd = PDF.build([{ text: 'Zoë Łódź (50% off) \\ back\\slash ₦5,000 — “quoted” 日本' }]).toString('latin1');
    assert.ok(odd.includes('Zoe') && odd.includes('N5,000') && odd.includes('"quoted"')); assert.ok(!/[^\x00-\x7f]/.test(odd));
    assert.ok(odd.includes('\\(50% off\\)'), 'brackets are escaped');
  });
  await test('long documents flow onto more pages', () => {
    const s = PDF.build(Array.from({ length: 150 }, (_, i) => ({ text: 'line ' + i }))).toString('latin1');
    assert.ok(/\/Count (\d+)/.exec(s)[1] >= 3);
  });

  console.log('\nStuck orders');
  const t = Math.floor(Date.now() / 1000), H = 3600, D = 86400;
  await test('an order paid but not placed for a day, an unconfirmed order, an unshipped one and an unanswered customer are all flagged', () => {
    assert.ok(DO.overdue({ status: 'paid', po_id: null, paid_at: t - 25 * H }));
    assert.ok(!DO.overdue({ status: 'paid', po_id: null, paid_at: t - 5 * H }));
    assert.ok(DO.overdue({ status: 'sent', sent_at: t - 4 * D })); assert.ok(!DO.overdue({ status: 'sent', sent_at: t - 1 * D }));
    assert.ok(DO.overdue({ status: 'confirmed', sent_at: t - 8 * D }, 2)); assert.ok(!DO.overdue({ status: 'confirmed', sent_at: t - 4 * D }, 2));
    assert.ok(DO.overdue({ status: 'issue', customer_choice: '', updated: t - 4 * D })); assert.ok(!DO.overdue({ status: 'issue', customer_choice: 'refund', updated: t - 4 * D }));
    assert.ok(!DO.overdue({ status: 'shipped', sent_at: t - 40 * D }), 'a parcel in transit is not the shop\'s delay');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
