import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Banner, Body, Button, Card, ErrorState, Loading, Pic, Row, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { naira } from '@/lib/format';
import type { WholesaleProduct } from '@/lib/types';
import { messageOf } from '@/lib/useForm';
import { colors, radius, space } from '@/theme';

export default function WholesaleCatalog() {
  const router = useRouter();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [qty, setQty] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useQuery({ queryKey: ['ws-catalog', q], queryFn: () => api.get<{ products: WholesaleProduct[] }>('/wholesale/catalog' + (q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '')) });
  if (list.isLoading) return <Loading />;
  if (list.isError || !list.data) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  const chosen = list.data.products.map((p) => ({ p, n: Number(qty[p.id] || 0) })).filter((x) => x.n > 0);
  const problem = chosen.find(({ p, n }) => n < p.min_qty || n > p.stock);
  const send = async () => {
    setError(''); setBusy(true);
    try {
      const r = await api.post<{ ref: string }>('/wholesale/quotes', { items: chosen.map(({ p, n }) => ({ productId: p.id, qty: n })) });
      await qc.invalidateQueries({ queryKey: ['ws-quotes'] });
      router.replace({ pathname: '/wholesale/quote/[ref]', params: { ref: r.ref } });
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };
  return (
    <Screen>
      <TextInput value={q} onChangeText={setQ} placeholder="Search the price list" accessibilityLabel="Search the price list" placeholderTextColor={colors.muted} style={{ backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, minHeight: 46, paddingHorizontal: 12, marginBottom: space.md }} />
      {error ? <Banner kind="error">{error}</Banner> : null}
      {list.data.products.length === 0 ? <Body muted>No wholesale products found.</Body> : list.data.products.map((p) => {
        const n = Number(qty[p.id] || 0), bad = n > 0 && (n < p.min_qty || n > p.stock);
        return (
          <Card key={p.id}>
            <Row style={{ gap: space.md }}>
              <Pic uri={p.image} size={56} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '700', color: colors.ink }}>{p.name}</Text>
                <Text style={{ color: colors.navy, fontWeight: '800' }}>{naira(p.price)} <Text style={{ color: colors.muted, fontWeight: '400', textDecorationLine: 'line-through' }}>{naira(p.retail_price)}</Text></Text>
                <Body muted>Minimum {p.min_qty} · {p.stock} in the wholesale warehouse</Body>
              </View>
            </Row>
            <Row style={{ marginTop: space.sm, gap: space.sm }}>
              <Body>Quantity</Body>
              <TextInput value={qty[p.id] ?? ''} onChangeText={(t) => setQty({ ...qty, [p.id]: t.replace(/\D/g, '').slice(0, 6) })} keyboardType="number-pad" placeholder="0" accessibilityLabel={`Quantity of ${p.name}`}
                style={{ borderWidth: 1, borderColor: bad ? colors.danger : colors.line, borderRadius: radius.sm, minWidth: 80, minHeight: 40, paddingHorizontal: 10, backgroundColor: colors.white }} />
            </Row>
            {bad ? <Text style={{ color: colors.danger, marginTop: 4 }}>{n < p.min_qty ? `Minimum is ${p.min_qty}.` : `Only ${p.stock} available.`}</Text> : null}
          </Card>
        );
      })}
      <Body muted style={{ marginBottom: space.md }}>Delivery goes to your approved business address. We reply with a quotation that adds the logistics and service fees; you only pay after you accept it.</Body>
      <Button title={chosen.length ? `Request quotation (${chosen.length} product${chosen.length > 1 ? 's' : ''})` : 'Choose quantities'} onPress={send} loading={busy} disabled={!chosen.length || !!problem} />
    </Screen>
  );
}
