jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256)) }));
jest.mock('expo-device', () => ({ deviceName: 'x', modelName: 'x' }));
jest.mock('expo-secure-store', () => require('./helpers').mockSecureStore());
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.0.0', extra: { apiUrl: 'https://api.test', env: 'test' } } } }));
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));

import { addLine, sanitize } from '../src/lib/cart';
import { forgetKeys, keyFor, safePayUrl, cartItems } from '../src/lib/checkout';
import { naira, statusLabel } from '../src/lib/format';
import { routeFor } from '../src/lib/push';
import { checkoutSchema, phone, registerSchema, wholesaleApplySchema } from '../src/lib/schemas';
import { imageUrl } from '../src/lib/config';

describe('cart', () => {
  test('adding the same product and option merges quantities and caps at 99', () => {
    let l = addLine([], { productId: 5, variantId: null, qty: 2 });
    l = addLine(l, { productId: 5, variantId: null, qty: 3 });
    l = addLine(l, { productId: 5, variantId: 9, qty: 1 });
    expect(l).toEqual([{ productId: 5, variantId: null, qty: 5 }, { productId: 5, variantId: 9, qty: 1 }]);
    expect(addLine(l, { productId: 5, variantId: null, qty: 500 })[0].qty).toBe(99);
  });
  test('a damaged saved cart is cleaned, never trusted', () => {
    expect(sanitize('nope')).toEqual([]);
    expect(sanitize([{ productId: -1, qty: 2 }, { productId: 3, qty: 0 }, { productId: 4, qty: 500, variantId: 'x' }, null, { productId: 8, qty: 1, price: 1 }]))
      .toEqual([{ productId: 4, variantId: null, qty: 99 }, { productId: 8, variantId: null, qty: 1 }]);   // a price the phone might hold is dropped
  });
  test('only ids and quantities are sent to the server for pricing', () => {
    expect(cartItems([{ productId: 1, variantId: null, qty: 2 }, { productId: 2, variantId: 7, qty: 1 }])).toEqual([{ productId: 1, qty: 2 }, { productId: 2, variantId: 7, qty: 1 }]);
  });
});

describe('checkout safety', () => {
  beforeEach(() => forgetKeys());
  test('retrying the same order reuses one Idempotency-Key; a different order gets a new one', () => {
    const a = { items: [{ productId: 1, qty: 1 }], payment: 'pod' }, b = { items: [{ productId: 1, qty: 2 }], payment: 'pod' };
    const k1 = keyFor(a); expect(keyFor({ ...a })).toBe(k1); expect(keyFor(b)).not.toBe(k1);
    expect(k1).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });
  test('after a successful order the next order gets a fresh key', () => { const a = { x: 1 }; const k = keyFor(a); forgetKeys(); expect(keyFor(a)).not.toBe(k); });
  test('only https payment pages are ever opened', () => {
    expect(safePayUrl('https://checkout.paystack.com/abc')).toBe('https://checkout.paystack.com/abc');
    for (const bad of ['http://x.test', 'javascript:alert(1)', 'intent://x', '', null, undefined, 42]) expect(safePayUrl(bad)).toBeNull();
  });
});

describe('forms', () => {
  test('Nigerian phone numbers', () => {
    for (const ok of ['08031234567', '+2348031234567', '2348031234567', '07012345678', '09012345678']) expect(phone.safeParse(ok).success).toBe(true);
    for (const bad of ['0803123', '12345678901', '+1 415 555 2671', 'abc']) expect(phone.safeParse(bad).success).toBe(false);
  });
  test('registration needs a name, a valid email and a password of 8+ characters; phone is optional', () => {
    expect(registerSchema.safeParse({ name: 'Ada', email: 'ADA@X.NG', phone: '', password: 'longenough1' }).success).toBe(true);
    expect(registerSchema.safeParse({ name: 'A', email: 'nope', phone: '', password: 'short' }).success).toBe(false);
  });
  test('checkout needs every delivery field', () => {
    const ok = { name: 'Ada Obi', email: 'a@x.ng', phone: '0803 123 4567', state: 'Lagos', city: 'Yaba', address: '5 Herbert Macaulay Way' };
    const r = checkoutSchema.safeParse(ok); expect(r.success).toBe(true); if (r.success) expect(r.data.phone).toBe('08031234567');
    expect(checkoutSchema.safeParse({ ...ok, state: '' }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...ok, address: 'x' }).success).toBe(false);
  });
  test('wholesale application needs the registration number', () => {
    const ok = { business_name: 'Ada Provisions', contact_name: 'Ada Obi', phone: '08031234567', address: '5 Trade Fair Road', state: 'Lagos', city: 'Ojo', reg_no: 'RC445566', business_type: 'Retailer', buys: 'Rice and beans' };
    expect(wholesaleApplySchema.safeParse(ok).success).toBe(true);
    expect(wholesaleApplySchema.safeParse({ ...ok, reg_no: '' }).success).toBe(false);
  });
});

describe('display and routing', () => {
  test('money and status wording', () => { expect(naira(1234567)).toBe('₦1,234,567'); expect(naira(undefined)).toBe('₦0'); expect(statusLabel('shipped')).toBe('On its way'); });
  test('pictures on our own server get the server address; full links stay as they are', () => {
    expect(imageUrl('/uploads/a.jpg')).toBe('https://api.test/uploads/a.jpg'); expect(imageUrl('https://cdn.x/a.jpg')).toBe('https://cdn.x/a.jpg'); expect(imageUrl('')).toBeUndefined();
  });
  test('a tapped notification can only open our own screens', () => {
    expect(routeFor({ type: 'order' })).toBe('/orders'); expect(routeFor({ type: 'rfq' })).toBe('/wholesale');
    expect(routeFor({ type: 'x', link: 'https://evil.example' })).toBe('/notifications'); expect(routeFor(undefined)).toBe('/notifications');
  });
});

describe('version 1 choices', () => {
  const { visibleMethods, mapsUrl } = require('../src/lib/checkout');
  test('only Paystack and pay on delivery are offered; Stripe stays hidden; demo only outside production', () => {
    expect(visibleMethods(['paystack', 'stripe', 'pod'], 'production')).toEqual(['paystack', 'pod']);
    expect(visibleMethods(['demo', 'pod'], 'production')).toEqual(['pod']);
    expect(visibleMethods(['demo', 'pod'], 'staging')).toEqual(['demo', 'pod']);
  });
  test('the rider location link is built from checked numbers only', () => {
    expect(mapsUrl(6.5244, 3.3792)).toBe('https://www.google.com/maps/search/?api=1&query=6.524400,3.379200');
    for (const bad of [['x', 1], [91, 0], [0, 181], [null, null], ['6.5&q=evil', 3]]) expect(mapsUrl(bad[0], bad[1])).toBeNull();
  });
});
