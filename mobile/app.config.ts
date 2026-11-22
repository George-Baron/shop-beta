import type { ExpoConfig } from 'expo/config';

// One config for every build. EAS profiles (eas.json) set APP_ENV and EXPO_PUBLIC_API_URL; nothing secret is ever put here:
// the app holds no payment keys, database credentials or service keys. Everything sensitive stays on the server.
const env = process.env.APP_ENV ?? 'development';
const isProd = env === 'production';
const suffix = isProd ? '' : env === 'staging' ? '.staging' : '.dev';
const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/+$/, '');

if (isProd && !/^https:\/\//.test(apiUrl)) {
  throw new Error('Production builds need EXPO_PUBLIC_API_URL set to the https address of the live server (see docs/MOBILE_RELEASE.md).');
}

const config: ExpoConfig = {
  name: isProd ? 'VELTO-MART' : `VELTO-MART (${env})`,
  slug: 'velto-mart',
  scheme: 'veltomart',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  icon: './assets/images/icon.png',
  backgroundColor: '#0b1b3a',
  runtimeVersion: { policy: 'appVersion' },
  assetBundlePatterns: ['**/*'],
  ios: {
    bundleIdentifier: `com.veltomart.app${suffix}`,
    supportsTablet: false,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: `com.veltomart.app${suffix}`,
    adaptiveIcon: { foregroundImage: './assets/images/adaptive-icon.png', backgroundColor: '#0b1b3a' },
    permissions: ['POST_NOTIFICATIONS'],
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'],
  },
  plugins: [
    'expo-router',
    ['expo-splash-screen', { image: './assets/images/splash.png', imageWidth: 200, resizeMode: 'contain', backgroundColor: '#0b1b3a' }],
    'expo-secure-store',
    ['expo-notifications', { color: '#f5b301' }],
  ],
  experiments: { typedRoutes: true },
  extra: {
    env,
    apiUrl: apiUrl || (env === 'development' ? 'http://localhost:3000' : ''),
    // Filled in after `eas init`; push tokens need it.
    eas: { projectId: process.env.EAS_PROJECT_ID ?? '' },
  },
};

export default config;
