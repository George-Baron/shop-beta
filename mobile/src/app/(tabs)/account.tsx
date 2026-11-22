import { Link, useRouter } from 'expo-router';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button, Card, Empty, H1, Row, Screen } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { APP_VERSION, ENV } from '@/lib/config';
import { useNotices } from '@/lib/queries';
import { colors, font, space } from '@/theme';

const Item = ({ href, label, hint }: { href: string; label: string; hint?: string }) => (
  <Link href={href as any} asChild>
    <Pressable accessibilityRole="button" style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <Row style={{ justifyContent: 'space-between' }}><Text style={{ fontSize: font.body, color: colors.ink, fontWeight: '600' }}>{label}</Text><Text style={{ color: colors.muted }}>{hint ?? '›'}</Text></Row>
    </Pressable>
  </Link>
);

export default function Account() {
  const { status, user, signOut } = useAuth();
  const router = useRouter();
  const notices = useNotices();
  if (status !== 'in' || !user) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
        <Empty title="Your VELTO-MART account" hint="Sign in to check out, follow your orders and get delivery updates." action={<View style={{ gap: space.sm }}><Button title="Sign in" onPress={() => router.push('/sign-in')} /><Button title="Create account" kind="secondary" onPress={() => router.push('/register')} /></View>} />
        <View style={{ padding: space.lg }}><Item href="/about" label="About and legal" /></View>
      </SafeAreaView>
    );
  }
  return (
    <Screen edges={['top']}>
      <H1>Hello, {user.name.split(' ')[0]}</H1>
      <Body muted style={{ marginBottom: space.lg }}>{user.email}</Body>
      <Card>
        <Item href="/notifications" label="Notifications" hint={notices.data?.unread ? `${notices.data.unread} new ›` : '›'} />
        <Item href="/notification-settings" label="Notification settings" />
        <Item href="/profile" label="My details and password" />
        <Item href="/addresses" label="Saved addresses" />
        <Item href="/devices" label="Signed-in devices" />
        <Item href="/wholesale" label="Wholesale (business buyers)" />
        <Item href="/support" label="Contact us" />
        <Item href="/about" label="About and legal" />
        <Item href="/delete-account" label="Delete my account" />
      </Card>
      <Button title="Sign out" kind="secondary" onPress={async () => { await signOut(); }} />
      <Body muted style={{ textAlign: 'center', marginTop: space.lg }}>VELTO-MART {APP_VERSION}{ENV !== 'production' ? ` (${ENV})` : ''}</Body>
    </Screen>
  );
}
