import { API_BASE } from './config';
import { deviceInfo } from './device';
import { clearRefreshToken, readRefreshToken, saveRefreshToken } from './session-store';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) { super(message); this.name = 'ApiError'; }
  /** True when there was no answer from the server at all (offline, timeout). */
  get offline() { return this.status === 0; }
}

export type SessionUser = { id: number; name: string; email: string; phone: string; role: 'customer' };
type TokenReply = { user: SessionUser; accessToken: string; refreshToken: string; accessExpiresIn: number };

let accessToken: string | null = null;
let onSignedOut: (reason: string) => void = () => undefined;
let onUser: (u: SessionUser) => void = () => undefined;
export const bindSession = (h: { signedOut: (reason: string) => void; user: (u: SessionUser) => void }) => { onSignedOut = h.signedOut; onUser = h.user; };

const TIMEOUT_MS = 20000;
const DEAD_SESSION = new Set(['invalid_token', 'session_expired', 'session_revoked', 'account_off', 'missing_token']);

async function raw(method: string, path: string, opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { Accept: 'application/json', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    });
  } catch {
    throw new ApiError(0, 'offline', 'We could not reach VELTO-MART. Check your internet connection and try again.');
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, json?.code ?? 'error', json?.error ?? 'Something went wrong. Please try again.', json?.requestId);
  return json;
}

// Only one refresh runs at a time, so a burst of requests that all find the token expired share one rotation.
let refreshing: Promise<string> | null = null;
function refreshAccess(): Promise<string> {
  if (!refreshing) {
    refreshing = (async () => {
      const rt = await readRefreshToken();
      if (!rt) throw new ApiError(401, 'missing_token', 'Please sign in.');
      const r: TokenReply = await raw('POST', '/auth/refresh', { body: { refreshToken: rt } });
      await saveRefreshToken(r.refreshToken);   // saved before anything else uses the new pair
      accessToken = r.accessToken;
      onUser(r.user);
      return r.accessToken;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function endSession(reason: string) { accessToken = null; await clearRefreshToken(); onSignedOut(reason); }

export async function request<T = any>(method: string, path: string, opts: { body?: unknown; auth?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  const auth = opts.auth !== false;
  const send = (token: string | null) => raw(method, path, { body: opts.body, headers: opts.headers, token: auth ? token : null });
  if (!auth) return send(null);
  try {
    return await send(accessToken ?? (await refreshAccess()));
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    if (DEAD_SESSION.has(e.code) && e.code !== 'invalid_token' && e.code !== 'missing_token') { await endSession(e.code); throw e; }
    // The access token ran out (or is unknown): try one rotation, then one retry.
    try {
      accessToken = null;
      return await send(await refreshAccess());
    } catch (e2) {
      if (e2 instanceof ApiError && e2.status === 401) await endSession(e2.code);   // refresh refused: signed out for good
      throw e2;                                                                      // offline or server trouble: stay signed in
    }
  }
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', p, { body: body ?? {}, headers }),
  put: <T = any>(p: string, body?: unknown) => request<T>('PUT', p, { body: body ?? {} }),
  del: <T = any>(p: string, body?: unknown) => request<T>('DELETE', p, { body }),
  /** Catalogue reads that need no sign-in. */
  open: <T = any>(p: string) => request<T>('GET', p, { auth: false }),
  openPost: <T = any>(p: string, body?: unknown) => request<T>('POST', p, { body: body ?? {}, auth: false }),
};

/* ---- sign-in and out ---- */
async function adopt(r: TokenReply) { await saveRefreshToken(r.refreshToken); accessToken = r.accessToken; return r.user; }
export async function signIn(email: string, password: string) { return adopt(await raw('POST', '/auth/login', { body: { email, password, device: await deviceInfo() } })); }
export async function register(b: { name: string; email: string; phone?: string; password: string }) { return adopt(await raw('POST', '/auth/register', { body: { ...b, device: await deviceInfo() } })); }
export async function restoreSession(): Promise<SessionUser | null> {
  if (!(await readRefreshToken())) return null;
  try { await refreshAccess(); return await api.get<{ user: SessionUser }>('/me').then((r) => r.user); }
  catch (e) { if (e instanceof ApiError && e.status === 401) { await endSession(e.code); return null; } throw e; }
}
export async function signOut() {
  try { if (accessToken || (await readRefreshToken())) await api.post('/auth/logout'); } catch { /* the phone signs out even if the server cannot be reached */ }
  accessToken = null; await clearRefreshToken();
}
export const forgotPassword = (email: string) => raw('POST', '/auth/forgot', { body: { email } });
export const dropLocalSession = () => { accessToken = null; return clearRefreshToken(); };
export const _testing = { reset: () => { accessToken = null; refreshing = null; } };
