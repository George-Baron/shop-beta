import { useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { FlatList, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ProductCard } from '@/components/ProductCard';
import { Chip, Empty, ErrorState, Loading } from '@/components/ui';
import { useConfig, useProducts } from '@/lib/queries';
import { colors, font, radius, space } from '@/theme';

const SORTS = [['', 'Featured'], ['popular', 'Popular'], ['newest', 'Newest'], ['price_asc', 'Price: low'], ['price_desc', 'Price: high']] as const;

export default function Shop() {
  const params = useLocalSearchParams<{ q?: string; store?: string }>();
  const cfg = useConfig();
  const [q, setQ] = useState(params.q ?? '');
  const [term, setTerm] = useState(params.q ?? '');
  const [store, setStore] = useState(params.store ?? '');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('');
  useEffect(() => { if (params.q !== undefined) { setQ(params.q); setTerm(params.q); } if (params.store !== undefined) { setStore(params.store); setCategory(''); } }, [params.q, params.store]);
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 400); return () => clearTimeout(t); }, [q]);   // search after a short pause, not on every key
  const prods = useProducts({ q: term, store, category, sort });
  const items = prods.data?.pages.flatMap((p) => p.products) ?? [];
  const cats = (cfg.data?.categories ?? []).filter((c) => !store || c.store === store);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <View style={{ padding: space.md, backgroundColor: colors.white }}>
        <TextInput value={q} onChangeText={setQ} placeholder="Search products" placeholderTextColor={colors.muted} returnKeyType="search" accessibilityLabel="Search products" clearButtonMode="while-editing"
          style={{ borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, minHeight: 46, paddingHorizontal: space.md, fontSize: font.body }} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.sm }}>
          <Chip label="All" active={!store} onPress={() => { setStore(''); setCategory(''); }} />
          {(cfg.data?.stores ?? []).map((s) => <Chip key={s.slug} label={s.name} active={store === s.slug} onPress={() => { setStore(s.slug); setCategory(''); }} />)}
        </ScrollView>
        {cats.length > 0 && store ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.sm }}>
            {cats.map((c) => <Chip key={c.id} label={c.name} active={category === c.slug} onPress={() => setCategory(category === c.slug ? '' : c.slug)} />)}
          </ScrollView>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.sm }}>
          {SORTS.map(([v, l]) => <Chip key={l} label={l} active={sort === v} onPress={() => setSort(v)} />)}
        </ScrollView>
      </View>
      {prods.isLoading ? <Loading /> : prods.isError ? <ErrorState error={prods.error} onRetry={() => prods.refetch()} /> : (
        <FlatList data={items} keyExtractor={(p) => String(p.id)} numColumns={2} renderItem={({ item }) => <ProductCard p={item} />} contentContainerStyle={{ padding: space.sm }}
          ListEmptyComponent={<Empty title="Nothing found" hint="Try a different word or department." />} onRefresh={() => prods.refetch()} refreshing={prods.isRefetching}
          onEndReached={() => { if (prods.hasNextPage && !prods.isFetchingNextPage) prods.fetchNextPage(); }} onEndReachedThreshold={0.6} keyboardShouldPersistTaps="handled" />
      )}
    </SafeAreaView>
  );
}
