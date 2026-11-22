import { Tabs } from 'expo-router';
import React from 'react';
import { Text } from 'react-native';
import { useCart } from '@/lib/cart';
import { colors } from '@/theme';

const icon = (glyph: string) => ({ focused }: { focused: boolean }) => <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.55 }}>{glyph}</Text>;

export default function TabsLayout() {
  const { count } = useCart();
  return (
    <Tabs screenOptions={{ headerStyle: { backgroundColor: colors.navy }, headerTintColor: colors.white, tabBarActiveTintColor: colors.navy, tabBarStyle: { backgroundColor: colors.white }, tabBarLabelStyle: { fontSize: 12, fontWeight: '600' } }}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('🏠') }} />
      <Tabs.Screen name="shop" options={{ title: 'Shop', tabBarIcon: icon('🛍️') }} />
      <Tabs.Screen name="cart" options={{ title: 'Cart', tabBarIcon: icon('🛒'), tabBarBadge: count > 0 ? count : undefined, tabBarBadgeStyle: { backgroundColor: colors.gold, color: colors.navy } }} />
      <Tabs.Screen name="orders" options={{ title: 'Orders', tabBarIcon: icon('📦') }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: icon('👤') }} />
    </Tabs>
  );
}
