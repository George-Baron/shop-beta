import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Banner, Body, Button, Card, ErrorState, H1, H2, Loading, Row, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { openPayment, safePayUrl } from '@/lib/checkout';
import { dateTime, day, naira, statusLabel } from '@/lib/format';
import type { Quote } from '@/lib/types';
import { messageOf } from '@/lib/useForm';
import { colors, space } from '@/theme';

export default function QuoteScreen() {
  const { ref } = useLocalSearchParams<{ ref: string }>();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ws-quote', ref], queryFn: () => api.get<{ quote: Quote }>(`/wholesale/quotes/${encodeURIComponent(String(ref))}`) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const tries = useRef(0);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['ws-quotes'] }); return q.refetch(); };

  // After the payment page closes, ask the server (never assume): it verifies with Paystack. Every 4 seconds for about 2 minutes.
  useEffect(() => {
    if (!checking) return;
    tries.current = 0;
    const t = setInterval(async () => {
      tries.current += 1;
      try {
        const r = await api.get<{ paid: boolean }>(`/wholesale/quotes/${encodeURIComponent(String(ref))}/payment-status`);
        if (r.paid) { clearInterval(t); setChecking(false); await refresh(); }
      } catch { /* keep trying until the limit */ }
      if (tries.current >= 30) { clearInterval(t); setChecking(false); setError('We have not heard back from the payment provider yet. If you paid, it can take a few minutes. Pull down to refresh.'); }
    }, 4000);
    return () => clearInterval(t);
  }, [checking]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const z = q.data.quote;
  const act = async (path: string, after?: () => Promise<void>) => { setBusy(true); setError(''); try { await api.post(`/wholesale/quotes/${encodeURIComponent(z.ref)}/${path}`); if (after) await after(); await refresh(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } };
  const pay = async () => {
    setBusy(true); setError('');
    try { const r = await api.post<{ url: string }>(`/wholesale/quotes/${encodeURIComponent(z.ref)}/pay`); const url = safePayUrl(r.url); if (!url) throw new Error('bad'); await openPayment(url); setChecking(true); }
    catch (e) { setError(e instanceof Error && e.message === 'bad' ? 'We could not open the payment page. Please try again.' : messageOf(e)); } finally { setBusy(false); }
  };
  const paid = ['paid', 'shipped', 'delivered'].includes(z.status);
  return (
    <Screen onRefresh={() => refresh()} refreshing={q.isRefetching}>
      <H1>{z.ref}</H1>
      <Text style={{ alignSelf: 'flex-start', backgroundColor: colors.goldSoft, color: colors.navy, fontWeight: '700', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, marginBottom: space.md }}>{statusLabel(z.status)}</Text>
      {error ? <Banner kind="error">{error}</Banner> : null}
      {checking ? <Banner>Checking your payment with the payment provider…</Banner> : null}
      {z.status === 'requested' ? <Banner>We have your request. Our team will send a quotation with the logistics and service fees.</Banner> : null}
      {z.status === 'quoted' && z.valid_until ? <Banner>This quotation is valid until {day(z.valid_until)}. Accepting it sets your goods aside in the wholesale warehouse.</Banner> : null}
      {z.status === 'accepted' ? <Banner>Accepted. Please pay {z.pay_by ? `by ${day(z.pay_by)}` : 'soon'}: we ship after payment is received.</Banner> : null}
      {paid ? <Banner kind="ok">Payment received.{z.invoice_no ? ` Invoice ${z.invoice_no}.` : ''}</Banner> : null}
      <Card>
        <H2>Items</H2>
        {z.items.map((i) => <Row key={i.id} style={{ justifyContent: 'space-between', marginBottom: 6 }}><View style={{ flex: 1 }}><Body>{i.name}</Body><Body muted>{i.qty} × {i.unit_price ? naira(i.unit_price) : 'price to be confirmed'}</Body></View><Body>{i.unit_price ? naira(i.line_total) : ''}</Body></Row>)}
        {z.status !== 'requested' ? (
          <View style={{ marginTop: 6 }}>
            <Row style={{ justifyContent: 'space-between' }}><Body>Goods</Body><Body>{naira(z.goods_total)}</Body></Row>
            <Row style={{ justifyContent: 'space-between' }}><Body>Logistics</Body><Body>{naira(z.logistics_fee)}</Body></Row>
            <Row style={{ justifyContent: 'space-between' }}><Body>Service fee ({z.service_pct}%)</Body><Body>{naira(z.service_fee)}</Body></Row>
            <Row style={{ justifyContent: 'space-between', marginTop: 6 }}><Text style={{ fontWeight: '800', color: colors.navy }}>Total</Text><Text style={{ fontWeight: '800', color: colors.navy }}>{naira(z.total)}</Text></Row>
          </View>
        ) : null}
      </Card>
      {z.admin_note ? <Card><H2>Note from our team</H2><Body>{z.admin_note}</Body></Card> : null}
      {z.fulfilment?.label ? <Card><H2>Delivery</H2><Body>{z.fulfilment.label}</Body></Card> : null}
      <Card><H2>Progress</H2>{z.events.map((e, i) => <View key={i} style={{ marginBottom: 6 }}><Body style={{ fontWeight: '700' }}>{statusLabel(e.status)}</Body>{e.note ? <Body muted>{e.note}</Body> : null}<Body muted>{dateTime(e.created)}</Body></View>)}</Card>
      {z.status === 'quoted' ? (
        <View style={{ gap: space.sm }}>
          <Button title="Accept quotation" loading={busy} onPress={() => Alert.alert('Accept this quotation?', `Total ${naira(z.total)}. Your goods are set aside and you then pay before we ship.`, [{ text: 'Not yet', style: 'cancel' }, { text: 'Accept', onPress: () => act('accept') }])} />
          <Button title="Decline" kind="secondary" loading={busy} onPress={() => act('decline')} />
        </View>
      ) : null}
      {z.status === 'accepted' ? <Button title={`Pay ${naira(z.total)}`} loading={busy} onPress={pay} /> : null}
    </Screen>
  );
}
