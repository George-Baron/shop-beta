/**
 * Contract check: runs the app's real API client against a real VELTO-MART server (a throwaway test copy, never production).
 * Skipped unless CONTRACT_API_URL is set. See docs/MOBILE_RELEASE.md ("Checking the app against the server").
 */
import { secure } from './helpers';

jest.mock('expo-secure-store', () => require('./helpers').mockSecureStore());
jest.mock('expo-device', () => ({ deviceName: 'Contract phone', modelName: 'C1' }));
jest.mock('expo-crypto', () => { const c = require('crypto'); return { getRandomBytes: (n: number) => new Uint8Array(c.randomBytes(n)) }; });
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.0.0', extra: { apiUrl: process.env.CONTRACT_API_URL, env: 'test' } } } }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

import * as Api from '../src/lib/api';
import { cartItems, keyFor } from '../src/lib/checkout';
import type { Card, OrderDetail, OrderRow, Priced } from '../src/lib/types';

const run = process.env.CONTRACT_API_URL ? describe : describe.skip;
const email = `contract.${Date.now()}@example.com`;

run('app client against a real server', () => {
  let product: Card; let ref = '';
  beforeAll(() => { for (const k of Object.keys(secure)) delete secure[k]; Api._testing.reset(); Api.bindSession({ signedOut: () => undefined, user: () => undefined }); });

  test('catalogue loads without signing in, with the fields the screens use', async () => {
    const cfg = await Api.api.open('/config'); expect(Array.isArray(cfg.stores)).toBe(true); expect(Array.isArray(cfg.zones)).toBe(true); expect(cfg.payments).toBeDefined();
    const r = await Api.api.open<{ products: Card[]; pages: number }>('/products?sort=newest&page=1');
    product = r.products.find((p) => p.stock >= 5)!; expect(product).toBeDefined();
    for (const k of ['id', 'slug', 'name', 'price', 'stock', 'rating', 'rating_n']) expect(product).toHaveProperty(k);
    const d = await Api.api.open('/products/' + product.slug); expect(d.product.id).toBe(product.id); expect(Array.isArray(d.related)).toBe(true);
  });

  test('register, restore the session from the stored refresh token, read profile', async () => {
    const u = await Api.register({ name: 'Contract Tester', email, phone: '08031234567', password: 'Contract-Pass-2026!' });
    expect(u.email).toBe(email);
    Api._testing.reset();                                   // a fresh app start: only the secure store remains
    const restored = await Api.restoreSession(); expect(restored?.email).toBe(email);
  });

  test('cart pricing, idempotent pay-on-delivery checkout, orders list and detail', async () => {
    const lines = [{ productId: product.id, variantId: null, qty: 1 }];
    const p = await Api.api.openPost<Priced>('/cart/price', { items: cartItems(lines), state: 'Lagos' });
    expect(p.lines[0].price).toBe(product.price); expect(p.delivery.options).toBeDefined(); expect(p.payments).toContain('pod');
    const body = { items: cartItems(lines), contact: { name: 'Contract Tester', email, phone: '08031234567' }, address: { state: 'Lagos', city: 'Yaba', address: '5 Herbert Macaulay Way' }, delivery: p.delivery.selected ?? 'standard', payment: 'pod' };
    const key = keyFor(body);
    const a = await Api.api.post<{ ref: string; next: string }>('/checkout', body, { 'Idempotency-Key': key });
    const b = await Api.api.post<{ ref: string; next: string }>('/checkout', body, { 'Idempotency-Key': key });
    expect(a.next).toBe('pod'); expect(b.ref).toBe(a.ref); ref = a.ref;
    const list = await Api.api.get<{ orders: OrderRow[] }>('/orders?limit=20'); expect(list.orders.some((o) => o.ref === ref)).toBe(true);
    const o = await Api.api.get<{ order: OrderDetail; actions: { can_cancel: boolean } }>('/orders/' + ref);
    expect(o.order.items.length).toBe(1); expect(o.order.events.length).toBeGreaterThan(0); expect(typeof o.order.total).toBe('number'); expect(o.actions.can_cancel).toBe(true);
  });

  test('support, notification settings and a push token', async () => {
    expect((await Api.api.post('/support', { topic: 'delivery', orderRef: ref, message: 'Where is my parcel?' })).ok).toBe(true);
    expect((await Api.api.get('/notifications/settings')).settings).toEqual({ orders: true, wholesale: true, offers: false });
    expect((await Api.api.put('/notifications/settings', { offers: true })).settings.offers).toBe(true);
    const tok = 'ExponentPushToken[' + 'a'.repeat(22) + ']';
    expect((await Api.api.post('/push-token', { token: tok, platform: 'android' })).ok).toBe(true);
    expect((await Api.api.del('/push-token', { token: tok })).ok).toBe(true);
    const n = await Api.api.get('/notifications'); expect(Array.isArray(n.notifications)).toBe(true);
  });

  test('devices, wholesale status for a new customer, cancel, sign-out', async () => {
    const d = await Api.api.get('/me/devices'); expect(d.devices.some((x: any) => x.current)).toBe(true);
    const w = await Api.api.get('/wholesale/me'); expect(w.account).toBeNull();
    await expect(Api.api.get('/wholesale/catalog')).rejects.toMatchObject({ status: 403 });
    expect((await Api.api.post('/orders/' + ref + '/cancel')).ok).toBe(true);
    await Api.signOut();
    await expect(Api.api.get('/orders')).rejects.toMatchObject({ status: 401 });
  });
});
