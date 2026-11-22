import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { APP_VERSION } from './config';

const KEY = 'velto.device-id';
let cached: string | null = null;

const randomId = () => Array.from(Crypto.getRandomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');

/** Made once per install. It only tells the server which phone a sign-in belongs to; it is not a secret. */
export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  let id: string | null = null;
  try { id = await SecureStore.getItemAsync(KEY); } catch { /* fall through */ }
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = randomId();
    try { await SecureStore.setItemAsync(KEY, id); } catch { /* still usable for this run */ }
  }
  cached = id;
  return id;
}

export async function deviceInfo() {
  return { id: await getDeviceId(), name: (Device.deviceName || Device.modelName || 'Phone').slice(0, 60), platform: Platform.OS === 'ios' ? 'ios' : 'android', appVersion: APP_VERSION };
}

/** A fresh key for one checkout attempt (16 to 64 characters). Reuse it only when retrying that same attempt. */
export const newIdempotencyKey = () => randomId();
