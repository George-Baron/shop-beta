import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';
import { EAS_PROJECT_ID } from './config';

// Shown while the app is open, too.
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true }) });

let lastToken: string | null = null;
/**
 * Asks permission (only when `ask` is true, i.e. after the customer chose to turn notifications on) and gives the server this phone's Expo token.
 * Returns what happened so the screen can explain it: 'on' | 'denied' | 'unavailable'.
 */
export async function enablePush(ask: boolean): Promise<'on' | 'denied' | 'unavailable'> {
  if (!Device.isDevice || !EAS_PROJECT_ID) return 'unavailable';   // simulators and builds without an EAS project cannot get a token
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Orders and updates', importance: Notifications.AndroidImportance.DEFAULT, lightColor: '#f5b301' });
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && ask && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return 'denied';
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
  lastToken = data;
  await api.post('/push-token', { token: data, platform: Platform.OS });
  return 'on';
}
/** Called after sign-in: refreshes the token only if permission was already given. */
export const syncPush = () => enablePush(false).catch(() => undefined);
/** Called before sign-out so this phone stops getting this customer's notifications. */
export async function removePush() { if (lastToken) { try { await api.del('/push-token', { token: lastToken }); } catch { /* sign-out removes the device on the server anyway */ } lastToken = null; } }

/** Where a tapped notification should open. Only our own screens, never a web address. */
export function routeFor(data: { link?: string; type?: string } | undefined): string {
  const link = String(data?.link ?? '');
  if (data?.type === 'order' || data?.type === 'payment') return '/orders';
  if (data?.type === 'rfq' || /wholesale/.test(link)) return '/wholesale';
  return '/notifications';
}
