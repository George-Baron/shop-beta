import * as SecureStore from 'expo-secure-store';

const REFRESH = 'velto.refresh-token';
const opts: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

// The refresh token is the only thing kept on the phone, and only in the device's secure storage (Keychain / Keystore).
// The short-lived access token stays in memory. Passwords are never stored.
export const readRefreshToken = () => SecureStore.getItemAsync(REFRESH, opts).catch(() => null);
export const saveRefreshToken = (t: string) => SecureStore.setItemAsync(REFRESH, t, opts);
export const clearRefreshToken = () => SecureStore.deleteItemAsync(REFRESH, opts).catch(() => undefined);
