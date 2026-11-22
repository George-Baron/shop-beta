import * as WebBrowser from 'expo-web-browser';
import { newIdempotencyKey } from './device';
import type { CartLine } from './types';

/**
 * One checkout attempt = one Idempotency-Key. Tapping "Place order" twice, or retrying after a dropped connection, sends the SAME key,
 * so the server returns the same order instead of making a second one. If anything about the order changes, a new key is used.
 */
const keys = new Map<string, string>();
export function keyFor(body: unknown): string {
  const sig = JSON.stringify(body);
  let k = keys.get(sig);
  if (!k) { if (keys.size > 20) keys.clear(); k = newIdempotencyKey(); keys.set(sig, k); }
  return k;
}
export const forgetKeys = () => keys.clear();   // after a successful order

export const cartItems = (lines: CartLine[]) => lines.map((l) => ({ productId: l.productId, ...(l.variantId ? { variantId: l.variantId } : {}), qty: l.qty }));

/** Payment pages must be https. Anything else the server might send (it should not) is refused rather than opened. */
export const safePayUrl = (u: unknown): string | null => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);
export async function openPayment(url: string) { await WebBrowser.openBrowserAsync(url, { dismissButtonStyle: 'close' }); }
