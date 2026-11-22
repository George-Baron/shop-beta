import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { CartLine } from './types';

// The cart lives on the phone and holds only product ids and quantities. The server prices it every time; the phone never decides a price.
const KEY = 'velto.cart.v1';
type Ctx = { lines: CartLine[]; count: number; ready: boolean; add: (l: CartLine) => void; setQty: (productId: number, variantId: number | null, qty: number) => void; remove: (productId: number, variantId: number | null) => void; clear: () => void };
const CartCtx = createContext<Ctx | null>(null);
const same = (a: CartLine, productId: number, variantId: number | null) => a.productId === productId && (a.variantId ?? null) === (variantId ?? null);

export function sanitize(x: unknown): CartLine[] {
  if (!Array.isArray(x)) return [];
  return x.filter((l) => l && Number.isInteger(l.productId) && l.productId > 0 && Number.isInteger(l.qty) && l.qty > 0)
    .map((l) => ({ productId: l.productId, variantId: Number.isInteger(l.variantId) ? l.variantId : null, qty: Math.min(99, l.qty) })).slice(0, 60);
}
export function addLine(lines: CartLine[], l: CartLine): CartLine[] {
  const i = lines.findIndex((x) => same(x, l.productId, l.variantId));
  if (i < 0) return [...lines, { ...l, qty: Math.min(99, l.qty) }];
  return lines.map((x, j) => (j === i ? { ...x, qty: Math.min(99, x.qty + l.qty) } : x));
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => { AsyncStorage.getItem(KEY).then((s) => { try { setLines(sanitize(s ? JSON.parse(s) : [])); } catch { /* start empty */ } }).finally(() => setReady(true)); }, []);
  useEffect(() => { if (ready) AsyncStorage.setItem(KEY, JSON.stringify(lines)).catch(() => undefined); }, [lines, ready]);
  const add = useCallback((l: CartLine) => setLines((cur) => addLine(cur, l)), []);
  const setQty = useCallback((p: number, v: number | null, qty: number) => setLines((cur) => (qty < 1 ? cur.filter((x) => !same(x, p, v)) : cur.map((x) => (same(x, p, v) ? { ...x, qty: Math.min(99, qty) } : x)))), []);
  const remove = useCallback((p: number, v: number | null) => setLines((cur) => cur.filter((x) => !same(x, p, v))), []);
  const clear = useCallback(() => setLines([]), []);
  const value = useMemo(() => ({ lines, count: lines.reduce((s, l) => s + l.qty, 0), ready, add, setQty, remove, clear }), [lines, ready, add, setQty, remove, clear]);
  return <CartCtx.Provider value={value}>{children}</CartCtx.Provider>;
}
export const useCart = () => { const c = useContext(CartCtx); if (!c) throw new Error('CartProvider missing'); return c; };
