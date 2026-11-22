import { Link } from 'expo-router';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Pic } from '@/components/ui';
import { naira } from '@/lib/format';
import type { Card } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

export function ProductCard({ p }: { p: Card }) {
  return (
    <Link href={{ pathname: '/product/[slug]', params: { slug: p.slug } }} asChild>
      <Pressable accessibilityRole="button" accessibilityLabel={`${p.name}, ${naira(p.price)}${p.stock <= 0 ? ', sold out' : ''}`} style={{ flex: 1, backgroundColor: colors.white, borderRadius: radius.lg, padding: space.sm, margin: 4, borderWidth: 1, borderColor: colors.line }}>
        <View style={{ alignItems: 'center' }}><Pic uri={p.image} emoji={p.emoji} size={140} /></View>
        <Text numberOfLines={2} style={{ fontSize: font.body, fontWeight: '600', color: colors.ink, marginTop: space.sm, minHeight: 40 }}>{p.name}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
          <Text style={{ fontSize: font.h3, fontWeight: '800', color: colors.navy }}>{naira(p.price)}</Text>
          {p.compare_price && p.compare_price > p.price ? <Text style={{ fontSize: font.small, color: colors.muted, textDecorationLine: 'line-through' }}>{naira(p.compare_price)}</Text> : null}
        </View>
        {p.stock <= 0 ? <Text style={{ color: colors.danger, fontSize: font.small }}>Sold out</Text> : p.rating_n > 0 ? <Text style={{ color: colors.muted, fontSize: font.small }}>★ {p.rating} ({p.rating_n})</Text> : null}
      </Pressable>
    </Link>
  );
}
