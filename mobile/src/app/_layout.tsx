import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiError } from '@/lib/api';
import { AuthProvider, useAuth } from '@/lib/auth';
import { CartProvider } from '@/lib/cart';
import { routeFor } from '@/lib/push';
import { colors } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

const makeClient = () => new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Do not hammer the server: retry network trouble and server errors a couple of times, never client errors (wrong input, not yours, signed out).
      retry: (n, e) => (e instanceof ApiError ? (e.offline || e.status >= 500) && n < 2 : n < 1),
    },
  },
});

function Gate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  useEffect(() => { if (status !== 'loading') SplashScreen.hideAsync().catch(() => undefined); }, [status]);
  // Tapping a notification opens the matching screen (and only our own screens).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => { if (status === 'in') router.push(routeFor(r.notification.request.content.data as any) as any); });
    return () => sub.remove();
  }, [status, router]);
  return status === 'loading' ? null : <>{children}</>;
}

export default function Root() {
  const [client] = useState(makeClient);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <CartProvider>
            <StatusBar style="light" />
            <Gate>
              <Stack screenOptions={{ headerStyle: { backgroundColor: colors.navy }, headerTintColor: colors.white, headerTitleStyle: { fontWeight: '700' }, contentStyle: { backgroundColor: colors.bg } }}>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="sign-in" options={{ title: 'Sign in', presentation: 'modal' }} />
                <Stack.Screen name="register" options={{ title: 'Create account', presentation: 'modal' }} />
                <Stack.Screen name="forgot" options={{ title: 'Reset password', presentation: 'modal' }} />
                <Stack.Screen name="product/[slug]" options={{ title: 'Product' }} />
                <Stack.Screen name="checkout" options={{ title: 'Checkout' }} />
                <Stack.Screen name="order/[ref]" options={{ title: 'Order' }} />
                <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
                <Stack.Screen name="notification-settings" options={{ title: 'Notification settings' }} />
                <Stack.Screen name="profile" options={{ title: 'My details' }} />
                <Stack.Screen name="addresses" options={{ title: 'Saved addresses' }} />
                <Stack.Screen name="devices" options={{ title: 'Signed-in devices' }} />
                <Stack.Screen name="support" options={{ title: 'Contact us' }} />
                <Stack.Screen name="delete-account" options={{ title: 'Delete account' }} />
                <Stack.Screen name="about" options={{ title: 'About and legal' }} />
                <Stack.Screen name="wholesale/index" options={{ title: 'Wholesale' }} />
                <Stack.Screen name="wholesale/apply" options={{ title: 'Apply for wholesale' }} />
                <Stack.Screen name="wholesale/catalog" options={{ title: 'Wholesale price list' }} />
                <Stack.Screen name="wholesale/quote/[ref]" options={{ title: 'Quotation' }} />
              </Stack>
            </Gate>
          </CartProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
