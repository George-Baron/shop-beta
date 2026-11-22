import { useQueryClient } from '@tanstack/react-query';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as A from './api';
import { removePush, syncPush } from './push';
import type { SessionUser } from './api';

type State = { status: 'loading' | 'in' | 'out'; user: SessionUser | null; notice: string };
type Ctx = State & {
  signIn: (email: string, password: string) => Promise<void>;
  register: (b: { name: string; email: string; phone?: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (u: SessionUser) => void;
  /** After the server has switched the account off (deletion): clear the phone without calling the server. */
  forget: () => Promise<void>;
  clearNotice: () => void;
};
const AuthCtx = createContext<Ctx | null>(null);
const REASONS: Record<string, string> = { session_revoked: 'You were signed out for your security. Please sign in again.', session_expired: 'Your session ended. Please sign in again.', account_off: 'This account has been switched off. Please contact the store.' };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [s, setS] = useState<State>({ status: 'loading', user: null, notice: '' });
  const qc = useQueryClient();

  useEffect(() => {
    A.bindSession({
      signedOut: (reason) => { qc.clear(); setS({ status: 'out', user: null, notice: REASONS[reason] ?? '' }); },
      user: (u) => setS((p) => (p.status === 'in' ? { ...p, user: u } : p)),
    });
    A.restoreSession().then((u) => setS((p) => (p.status === 'out' ? p : u ? { status: 'in', user: u, notice: '' } : { status: 'out', user: null, notice: '' })))
      .catch(() => setS({ status: 'out', user: null, notice: 'We could not reach VELTO-MART. Check your connection and sign in again.' }));
  }, [qc]);

  const signIn = useCallback(async (email: string, password: string) => { const u = await A.signIn(email, password); qc.clear(); setS({ status: 'in', user: u, notice: '' }); syncPush(); }, [qc]);
  const register = useCallback(async (b: Parameters<typeof A.register>[0]) => { const u = await A.register(b); qc.clear(); setS({ status: 'in', user: u, notice: '' }); }, [qc]);
  const signOut = useCallback(async () => { await removePush(); await A.signOut(); qc.clear(); setS({ status: 'out', user: null, notice: '' }); }, [qc]);
  const forget = useCallback(async () => { await A.dropLocalSession(); qc.clear(); setS({ status: 'out', user: null, notice: '' }); }, [qc]);
  const setUser = useCallback((u: SessionUser) => setS((p) => ({ ...p, user: u })), []);
  const clearNotice = useCallback(() => setS((p) => ({ ...p, notice: '' })), []);
  const value = useMemo(() => ({ ...s, signIn, register, signOut, setUser, forget, clearNotice }), [s, signIn, register, signOut, setUser, forget, clearNotice]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
export const useAuth = () => { const c = useContext(AuthCtx); if (!c) throw new Error('AuthProvider missing'); return c; };
