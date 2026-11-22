import { mockServer, mockSecureStore, secure, tokens } from './helpers';

jest.mock('expo-secure-store', () => require('./helpers').mockSecureStore());
jest.mock('expo-device', () => ({ deviceName: 'Test phone', modelName: 'T1' }));
jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256) }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.0.0', extra: { apiUrl: 'https://api.test', env: 'test' } } } }));

import * as Api from '../src/lib/api';

beforeEach(() => { for (const k of Object.keys(secure)) delete secure[k]; Api._testing.reset(); Api.bindSession({ signedOut: () => undefined, user: () => undefined }); });

test('signing in keeps only the refresh token in secure storage and never the password', async () => {
  const calls = mockServer(() => ({ status: 200, json: tokens(1) }));
  await Api.signIn('a@x.ng', 'Secret-pass-1');
  expect(calls[0].path).toBe('/auth/login');
  expect(calls[0].body.device.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(secure['velto.refresh-token']).toBe('rt_1');
  expect(JSON.stringify(secure)).not.toContain('Secret-pass-1');
  expect(JSON.stringify(secure)).not.toContain('at_1');   // the access token stays in memory
});

test('an expired access token is refreshed once and the request is retried with the new token', async () => {
  let expireNext = false;
  const calls = mockServer((c) => {
    if (c.path === '/auth/login') return { status: 200, json: tokens(1) };
    if (c.path === '/auth/refresh') return { status: 200, json: tokens(2) };
    if (expireNext) { expireNext = false; return { status: 401, json: { code: 'token_expired', error: 'expired' } }; }
    return { status: 200, json: { orders: [] } };
  });
  await Api.signIn('a@x.ng', 'Secret-pass-1');
  expireNext = true;
  await expect(Api.api.get('/orders')).resolves.toEqual({ orders: [] });
  expect(calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  expect(calls.find((c) => c.path === '/auth/refresh')!.body).toEqual({ refreshToken: 'rt_1' });
  expect(secure['velto.refresh-token']).toBe('rt_2');                // rotated token saved
  expect(calls.at(-1)!.headers.Authorization).toBe('Bearer at_2');
});

test('several requests that find the token expired share ONE refresh (the old refresh token works only once)', async () => {
  secure['velto.refresh-token'] = 'rt_0';
  let refreshes = 0;
  mockServer((c) => {
    if (c.path === '/auth/refresh') { refreshes += 1; return { status: 200, json: tokens(3) }; }
    return { status: 200, json: { ok: true } };
  });
  await Promise.all([Api.api.get('/orders'), Api.api.get('/notifications'), Api.api.get('/addresses')]);
  expect(refreshes).toBe(1);
});

test('when the server refuses the refresh token the phone signs out and forgets it', async () => {
  secure['velto.refresh-token'] = 'rt_old';
  const out = jest.fn(); Api.bindSession({ signedOut: out, user: () => undefined });
  mockServer(() => ({ status: 401, json: { code: 'session_revoked', error: 'revoked' } }));
  await expect(Api.api.get('/orders')).rejects.toMatchObject({ status: 401, code: 'session_revoked' });
  expect(out).toHaveBeenCalledWith('session_revoked');
  expect(secure['velto.refresh-token']).toBeUndefined();
});

test('being offline while refreshing does NOT sign the customer out', async () => {
  secure['velto.refresh-token'] = 'rt_keep';
  const out = jest.fn(); Api.bindSession({ signedOut: out, user: () => undefined });
  mockServer(() => 'offline');
  await expect(Api.api.get('/orders')).rejects.toMatchObject({ offline: true, code: 'offline' });
  expect(out).not.toHaveBeenCalled();
  expect(secure['velto.refresh-token']).toBe('rt_keep');
});

test('server errors become ApiError with the readable message, code and request id', async () => {
  mockServer(() => ({ status: 409, json: { error: 'You already have an order in progress.', code: 'orders_in_progress', requestId: 'abc' } }));
  await expect(Api.api.openPost('/anything', {})).rejects.toMatchObject({ status: 409, code: 'orders_in_progress', message: 'You already have an order in progress.', requestId: 'abc' });
});

test('public catalogue calls never send a token', async () => {
  secure['velto.refresh-token'] = 'rt_0';
  const calls = mockServer(() => ({ status: 200, json: { products: [] } }));
  await Api.api.open('/products');
  expect(calls[0].headers.Authorization).toBeUndefined();
});

test('sign-out tells the server, then clears the phone even if the server cannot be reached', async () => {
  secure['velto.refresh-token'] = 'rt_0';
  mockServer(() => 'offline');
  await Api.signOut();
  expect(secure['velto.refresh-token']).toBeUndefined();
});

test('a password reset or revoked device on the server ends the session on the next request', async () => {
  const out = jest.fn(); Api.bindSession({ signedOut: out, user: () => undefined });
  mockServer((c) => (c.path === '/auth/login' ? { status: 200, json: tokens(1) } : { status: 401, json: { code: 'session_revoked', error: 'x' } }));
  await Api.signIn('a@x.ng', 'Secret-pass-1');
  await expect(Api.api.get('/me')).rejects.toBeTruthy();
  expect(out).toHaveBeenCalled();
});
