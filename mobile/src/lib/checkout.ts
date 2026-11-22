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

/**
 * Version 1 offers Paystack and pay on delivery only. Stripe stays hidden until it has been tested from the app with Stripe test keys
 * (add 'stripe' here then). Demo payments (local testing) are never shown in production builds.
 */
export const ENABLED_METHODS = ['paystack', 'pod'] as const;
export const visibleMethods = (offered: string[], env: string): string[] =>
  offered.filter((m) => (ENABLED_METHODS as readonly string[]).includes(m) || (m === 'demo' && env !== 'production'));

/** A link that opens the rider's last known position in the phone's maps app. Numbers are checked so nothing else can be put in the link. */
export function mapsUrl(lat: unknown, lng: unknown): string | null {
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null;   // Number(null) is 0: not a position
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return `https://www.google.com/maps/search/?api=1&query=${a.toFixed(6)},${b.toFixed(6)}`;
}
