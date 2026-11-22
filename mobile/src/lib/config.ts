import Constants from 'expo-constants';

type Extra = { env?: string; apiUrl?: string; eas?: { projectId?: string } };
const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

export const ENV = extra.env ?? 'development';
export const API_ORIGIN = (extra.apiUrl ?? '').replace(/\/+$/, '');
export const API_BASE = `${API_ORIGIN}/api/mobile/v1`;
export const EAS_PROJECT_ID = extra.eas?.projectId ?? '';
export const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';
// Public pages that live on the website (shown from Settings and required by the stores).
export const PRIVACY_URL = `${API_ORIGIN}/page/privacy`;
export const TERMS_URL = `${API_ORIGIN}/page/terms`;

/** Pictures come back as full addresses or as paths on our own server. */
export const imageUrl = (u?: string | null): string | undefined => (!u ? undefined : /^https?:\/\//.test(u) ? u : `${API_ORIGIN}${u.startsWith('/') ? '' : '/'}${u}`);
