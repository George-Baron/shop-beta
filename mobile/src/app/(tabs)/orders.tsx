import { Link } from 'expo-router';
import React from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button, Empty, ErrorState, Loading, Pic, Row } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { dateTime, naira, statusLabel } from '@/lib/format';
import { useOrders } from '@/lib/queries';
import { colors, font, radius, space } from '@/theme';

export default function Orders() {
  const { status } = useAuth();
  const q = useOrders();
  const rows = q.data?.pages.flatMap((p) => p.orders) ?? [];
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      {status !== 'in' ? <Empty title="Sign in to see your orders" action={<Link href="/sign-in" asChild><Button title="Sign in" onPress={() => undefined} /></Link>} />
        : q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
          <FlatList data={rows} keyExtractor={(o) => o.ref} contentContainerStyle={{ padding: space.lg }} onRefresh={() => q.refetch()} refreshing={q.isRefetching}
            ListEmptyComponent={<Empty title="No orders yet" hint="When you place an order you can follow it here." />}
            onEndReached={() => { if (q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage(); }} onEndReachedThreshold={0.6}
            renderItem={({ item: o }) => (
              <Link href={{ pathname: '/order/[ref]', params: { ref: o.ref } }} asChild>
                <Pressable accessibilityRole="button" style={{ backgroundColor: colors.white, borderRadius: radius.lg, padding: space.md, marginBottom: space.md, borderWidth: 1, borderColor: colors.line }}>
                  <Row style={{ gap: space.md }}>
                    <Pic uri={o.first_image} size={56} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontWeight: '700', color: colors.navy, fontSize: font.body }}>{o.ref}</Text>
                      <Body muted>{o.first_item}{o.item_count > 1 ? ` + ${o.item_count - 1} more` : ''}</Body>
                      <Body muted>{dateTime(o.created)}</Body>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ fontWeight: '800', color: colors.navy }}>{naira(o.total)}</Text>
                      <Text style={{ color: o.status === 'cancelled' ? colors.danger : o.status === 'delivered' ? colors.ok : colors.ink, fontSize: font.small, fontWeight: '600' }}>{statusLabel(o.status)}</Text>
                      {o.payment_status === 'unpaid' && o.payment_method !== 'pod' && o.status === 'pending' ? <Text style={{ color: colors.danger, fontSize: font.small }}>Not paid</Text> : null}
                    </View>
                  </Row>
                </Pressable>
              </Link>
            )} />
        )}
    </SafeAreaView>
  );
}
