import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Banner, Body, Button, Card, Chip, ErrorState, H1, H2, Loading, Pic, Row, Screen } from '@/components/ui';
import { ProductCard } from '@/components/ProductCard';
import { useCart } from '@/lib/cart';
import { naira } from '@/lib/format';
import { useProduct } from '@/lib/queries';
import { colors, font, space } from '@/theme';

export default function ProductScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const q = useProduct(String(slug));
  const { add } = useCart();
  const router = useRouter();
  const [variantId, setVariantId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { product: p, related, reviews } = q.data;
  const variants = p.variants ?? [];
  const chosen = variants.find((v) => v.id === variantId) ?? null;
  const stock = variants.length ? (chosen ? chosen.stock : 0) : p.stock;
  const price = chosen?.price || p.price;
  const needsChoice = variants.length > 0 && !chosen;
  const rx = !!p.rx_required;
  return (
    <Screen>
      <View style={{ alignItems: 'center', marginBottom: space.lg }}><Pic uri={p.images?.[0] ?? p.image} emoji={p.emoji} size={260} radiusPx={16} /></View>
      <H1>{p.name}</H1>
      {p.brand ? <Body muted>{p.brand}</Body> : null}
      <Row style={{ marginVertical: space.sm, gap: 10 }}>
        <Text style={{ fontSize: 24, fontWeight: '800', color: colors.navy }}>{naira(price)}</Text>
        {p.compare_price && p.compare_price > price ? <Text style={{ color: colors.muted, textDecorationLine: 'line-through' }}>{naira(p.compare_price)}</Text> : null}
      </Row>
      {p.vendor ? <Body muted>Sold by {p.vendor.name}</Body> : null}
      {variants.length > 0 ? (
        <View style={{ marginVertical: space.md }}>
          <H2>Choose an option</H2>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {variants.map((v) => <Chip key={v.id} label={[v.size, v.color].filter(Boolean).join(' · ') + (v.stock <= 0 ? ' (sold out)' : '')} active={variantId === v.id} onPress={() => v.stock > 0 && setVariantId(v.id)} />)}
          </ScrollView>
        </View>
      ) : null}
      {rx ? <Banner>This medicine needs a prescription. A pharmacist will check it before your order is processed; you are not charged until then.</Banner> : null}
      {added ? <Banner kind="ok">Added to your cart.</Banner> : null}
      {stock <= 0 && !needsChoice ? <Banner kind="error">Sold out.</Banner> : null}
      <Row style={{ gap: space.md, marginVertical: space.md }}>
        <Button title="−" kind="secondary" onPress={() => setQty(Math.max(1, qty - 1))} style={{ minWidth: 48 }} />
        <Text accessibilityLabel={`Quantity ${qty}`} style={{ fontSize: font.h2, fontWeight: '700', minWidth: 32, textAlign: 'center' }}>{qty}</Text>
        <Button title="+" kind="secondary" onPress={() => setQty(Math.min(Math.max(1, Math.min(99, stock || 1)), qty + 1))} style={{ minWidth: 48 }} />
        <Button title={needsChoice ? 'Choose an option' : 'Add to cart'} disabled={needsChoice || stock <= 0} style={{ flex: 1 }}
          onPress={() => { add({ productId: p.id, variantId: chosen ? chosen.id : null, qty }); setAdded(true); }} />
      </Row>
      {added ? <Button title="Go to cart" kind="link" onPress={() => router.push('/cart')} /> : null}
      {p.description ? <Card><H2>About this product</H2><Body>{p.description}</Body></Card> : null}
      {reviews?.length ? (
        <Card><H2>Reviews</H2>{reviews.slice(0, 5).map((r) => <View key={r.id} style={{ marginBottom: space.md }}><Body style={{ fontWeight: '700' }}>{'★'.repeat(r.rating)} {r.name}</Body><Body muted>{r.body ?? r.comment}</Body></View>)}</Card>
      ) : null}
      {related?.length ? <View><H2>You may also like</H2><ScrollView horizontal showsHorizontalScrollIndicator={false}>{related.map((r) => <View key={r.id} style={{ width: 170 }}><ProductCard p={r} /></View>)}</ScrollView></View> : null}
      <Link href="/shop" style={{ marginTop: space.lg }}><Body muted>Keep shopping</Body></Link>
    </Screen>
  );
}
