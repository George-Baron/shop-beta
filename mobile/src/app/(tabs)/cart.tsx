import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import { Banner, Body, Button, Card, Empty, ErrorState, H1, Loading, Pic, Row, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { cartItems } from '@/lib/checkout';
import { useCart } from '@/lib/cart';
import { naira } from '@/lib/format';
import type { Priced } from '@/lib/types';
import { colors, font, space } from '@/theme';

export function usePriced(state: string, delivery?: string) {
  const { lines } = useCart();
  return useQuery({
    queryKey: ['price', lines, state, delivery], enabled: lines.length > 0, staleTime: 10_000,
    queryFn: () => api.openPost<Priced>('/cart/price', { items: cartItems(lines), state, delivery }),
  });
}

export default function CartScreen() {
  const { lines, setQty, remove, ready } = useCart();
  const router = useRouter();
  const priced = usePriced('Lagos');
  // The server's prices and quantities win: if an item is gone or the stock is lower, the phone's cart follows.
  useEffect(() => {
    const p = priced.data; if (!p) return;
    for (const l of lines) {
      const m = p.lines.find((x) => x.productId === l.productId && (x.variantId ?? null) === (l.variantId ?? null));
      if (!m) remove(l.productId, l.variantId); else if (m.qty !== l.qty) setQty(l.productId, l.variantId, m.qty);
    }
  }, [priced.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ready) return <Loading />;
  if (lines.length === 0) return <Empty title="Your cart is empty" hint="Add something you like and it will wait for you here." action={<Button title="Start shopping" onPress={() => router.push('/shop')} />} />;
  if (priced.isLoading) return <Loading />;
  if (priced.isError || !priced.data) return <ErrorState error={priced.error} onRetry={() => priced.refetch()} />;
  const p = priced.data;
  return (
    <Screen onRefresh={() => priced.refetch()} refreshing={priced.isRefetching}>
      <H1>Your cart</H1>
      {p.issues.map((i, n) => <Banner key={n}>{i.message}</Banner>)}
      {p.lines.map((l) => (
        <Card key={`${l.productId}:${l.variantId ?? 0}`}>
          <Row style={{ gap: space.md }}>
            <Pic uri={l.image} emoji={l.emoji} size={64} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={2} style={{ fontWeight: '700', color: colors.ink, fontSize: font.body }}>{l.name}</Text>
              {l.variantLabel ? <Body muted>{l.variantLabel}</Body> : null}
              <Text style={{ color: colors.navy, fontWeight: '800' }}>{naira(l.price)}</Text>
            </View>
          </Row>
          <Row style={{ justifyContent: 'space-between', marginTop: space.md }}>
            <Row style={{ gap: space.sm }}>
              <Button title="−" kind="secondary" onPress={() => setQty(l.productId, l.variantId, l.qty - 1)} style={{ minWidth: 44, minHeight: 40 }} />
              <Text accessibilityLabel={`Quantity ${l.qty}`} style={{ minWidth: 28, textAlign: 'center', fontWeight: '700' }}>{l.qty}</Text>
              <Button title="+" kind="secondary" disabled={l.qty >= l.available} onPress={() => setQty(l.productId, l.variantId, l.qty + 1)} style={{ minWidth: 44, minHeight: 40 }} />
            </Row>
            <Button title="Remove" kind="link" onPress={() => remove(l.productId, l.variantId)} />
          </Row>
        </Card>
      ))}
      <Card>
        <Row style={{ justifyContent: 'space-between' }}><Body>Subtotal</Body><Body style={{ fontWeight: '700' }}>{naira(p.subtotal)}</Body></Row>
        <Body muted style={{ marginTop: 6 }}>Delivery and any tax are worked out at checkout from your address.</Body>
      </Card>
      {p.blocked.map((b, n) => <Banner key={n} kind="error">{b}</Banner>)}
      <Button title="Checkout" onPress={() => router.push('/checkout')} disabled={p.blocked.length > 0 || p.lines.length === 0} testID="go-checkout" />
    </Screen>
  );
}
