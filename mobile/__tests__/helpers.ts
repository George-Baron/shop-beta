// In-memory stand-ins for the phone's secure storage and the network, shared by the tests.
export const secure: Record<string, string> = {};
export const mockSecureStore = () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: jest.fn(async (k: string) => (k in secure ? secure[k] : null)),
  setItemAsync: jest.fn(async (k: string, v: string) => { secure[k] = v; }),
  deleteItemAsync: jest.fn(async (k: string) => { delete secure[k]; }),
});
export type Call = { method: string; path: string; headers: Record<string, string>; body: any };
export function mockServer(handler: (c: Call, n: number) => { status: number; json?: any } | 'offline') {
  const calls: Call[] = [];
  (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
    const c: Call = { method: init.method, path: String(url).replace(/^.*\/api\/mobile\/v1/, ''), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const r = handler(c, calls.length);
    if (r === 'offline') throw new TypeError('Network request failed');
    return { ok: r.status < 400, status: r.status, text: async () => (r.json === undefined ? '' : JSON.stringify(r.json)) };
  });
  return calls;
}
export const tokens = (n: number) => ({ user: { id: 1, name: 'Ada', email: 'a@x.ng', phone: '', role: 'customer' }, accessToken: `at_${n}`, refreshToken: `rt_${n}`, accessExpiresIn: 900 });
