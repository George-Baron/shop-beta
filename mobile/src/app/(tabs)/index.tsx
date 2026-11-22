import { Link, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ProductCard } from '@/components/ProductCard';
import { ErrorState, Loading, H2 } from '@/components/ui';
import { useConfig, useProducts } from '@/lib/queries';
import { colors, font, radius, space } from '@/theme';

export default function Home() {
  const router = useRouter();
  const cfg = useConfig();
  const prods = useProducts({ sort: 'newest' });
  const [q, setQ] = useState('');
  const items = prods.data?.pages.flatMap((p) => p.products) ?? [];
  const header = (
    <View>
      <View style={{ backgroundColor: colors.navy, padding: space.lg, paddingBottom: space.xl, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg }}>
        <Text style={{ color: colors.gold, fontSize: font.h1, fontWeight: '800' }}>VELTO-MART</Text>
        <Text style={{ color: colors.white, marginBottom: space.md }}>{cfg.data?.settings.tagline || 'Shop online. Delivered to you.'}</Text>
        <TextInput value={q} onChangeText={setQ} placeholder="Search products" placeholderTextColor={colors.muted} returnKeyType="search" accessibilityLabel="Search products"
          onSubmitEditing={() => router.push({ pathname: '/shop', params: { q } })} style={{ backgroundColor: colors.white, borderRadius: radius.md, minHeight: 48, paddingHorizontal: space.md, fontSize: font.body }} />
      </View>
      <View style={{ padding: space.lg, paddingBottom: space.sm }}>
        <H2>Departments</H2>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {(cfg.data?.stores ?? []).map((s) => (
            <Link key={s.slug} href={{ pathname: '/shop', params: { store: s.slug } }} asChild>
              <Pressable accessibilityRole="button" style={{ backgroundColor: colors.goldSoft, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: space.md }}><Text style={{ color: colors.navy, fontWeight: '700' }}>{s.name}</Text></Pressable>
            </Link>
          ))}
        </View>
        <View style={{ height: space.lg }} /><H2>New arrivals</H2>
      </View>
    </View>
  );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      {prods.isLoading ? <Loading /> : prods.isError ? <ErrorState error={prods.error} onRetry={() => prods.refetch()} /> : (
        <FlatList data={items} keyExtractor={(p) => String(p.id)} numColumns={2} ListHeaderComponent={header} renderItem={({ item }) => <ProductCard p={item} />}
          contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: space.xl }} onRefresh={() => { prods.refetch(); cfg.refetch(); }} refreshing={prods.isRefetching}
          onEndReached={() => { if (prods.hasNextPage && !prods.isFetchingNextPage) prods.fetchNextPage(); }} onEndReachedThreshold={0.6} />
      )}
    </SafeAreaView>
  );
}
