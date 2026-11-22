import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Banner, Body, Button, Card, ErrorState, H1, H2, Loading, Pic, Row, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { openPayment, safePayUrl } from '@/lib/checkout';
import { dateTime, naira, payLabel, statusLabel } from '@/lib/format';
import { usePaymentCheck } from '@/lib/payment';
import { useOrder } from '@/lib/queries';
import { messageOf } from '@/lib/useForm';
import { colors, space } from '@/theme';

export default function OrderScreen() {
  const { ref, paying } = useLocalSearchParams<{ ref: string; paying?: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const order = useOrder(String(ref));
  const [checking, setChecking] = useState(paying === '1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pay = usePaymentCheck(String(ref), checking);
  if (order.isLoading) return <Loading />;
  if (order.isError || !order.data) return <ErrorState error={order.error} onRetry={() => order.refetch()} />;
  const { order: o, actions } = order.data;
  const online = o.payment_method === 'paystack' || o.payment_method === 'stripe';
  const paid = o.payment_status === 'paid' || pay.paid;

  const payNow = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post<{ url: string }>(`/orders/${encodeURIComponent(o.ref)}/pay`);
      const url = safePayUrl(r.url); if (!url) throw new Error('bad url');
      await openPayment(url); setChecking(true); pay.recheck();
    } catch (e) { setError(e instanceof Error && e.message === 'bad url' ? 'We could not open the payment page. Please try again.' : messageOf(e)); } finally { setBusy(false); }
  };
  const cancel = () => Alert.alert('Cancel this order?', 'Items go back into stock. This cannot be undone.', [
    { text: 'Keep order', style: 'cancel' },
    { text: 'Cancel order', style: 'destructive', onPress: async () => {
      setBusy(true); setError('');
      try { await api.post(`/orders/${encodeURIComponent(o.ref)}/cancel`); qc.invalidateQueries({ queryKey: ['orders'] }); await order.refetch(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
    } },
  ]);

  return (
    <Screen onRefresh={() => order.refetch()} refreshing={order.isRefetching}>
      <H1>Order {o.ref}</H1>
      <Row style={{ gap: space.sm, marginBottom: space.md }}>
        <Text style={{ backgroundColor: colors.goldSoft, color: colors.navy, fontWeight: '700', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 }}>{statusLabel(o.status)}</Text>
        <Body muted>{dateTime(o.created)}</Body>
      </Row>
      {error ? <Banner kind="error">{error}</Banner> : null}
      {checking && !paid ? <Banner>{pay.gaveUp ? 'We have not heard back from the payment provider yet. If you paid, it can take a few minutes. ' : 'Checking your payment with the payment provider… '}{pay.gaveUp ? <Text style={{ fontWeight: '700' }} onPress={() => { setChecking(true); pay.recheck(); }}>Check again</Text> : null}</Banner> : null}
      {paid && online ? <Banner kind="ok">Payment received. Thank you!</Banner> : null}
      {o.pharmacy?.rx_required && o.pharmacy.rx_status !== 'approved' ? <Banner>A pharmacist is checking your prescription. {o.pharmacy.needs_payment ? 'You will be able to pay once it is approved.' : ''}</Banner> : null}
      {online && !paid && actions.can_pay ? <Button title="Pay now" onPress={payNow} loading={busy} /> : null}
      {o.handover_code && o.status === 'shipped' ? <Card><H2>Delivery code</H2><Text style={{ fontSize: 32, fontWeight: '800', letterSpacing: 6, color: colors.navy }}>{o.handover_code}</Text><Body muted>Give this code to the rider only when you have your order in hand.</Body></Card> : null}
      <Card>
        <H2>Progress</H2>
        {o.events.map((e, i) => <View key={i} style={{ marginBottom: space.sm }}><Body style={{ fontWeight: '700' }}>{statusLabel(e.status)}</Body>{e.note ? <Body muted>{e.note}</Body> : null}<Body muted>{dateTime(e.created)}</Body></View>)}
        {o.rider ? <Body style={{ marginTop: 6 }}>Your rider is on the way.</Body> : null}
      </Card>
      <Card>
        <H2>Items</H2>
        {o.items.map((i, n) => <Row key={n} style={{ gap: space.md, marginBottom: space.sm }}><Pic uri={i.image} size={48} /><View style={{ flex: 1 }}><Body>{i.name}{i.variant_label ? ` (${i.variant_label})` : ''}</Body><Body muted>{i.qty} × {naira(i.price)}</Body></View></Row>)}
        <Row style={{ justifyContent: 'space-between', marginTop: 6 }}><Body>Items</Body><Body>{naira(o.subtotal)}</Body></Row>
        {o.discount ? <Row style={{ justifyContent: 'space-between' }}><Body>Discount</Body><Body>−{naira(o.discount)}</Body></Row> : null}
        <Row style={{ justifyContent: 'space-between' }}><Body>Delivery</Body><Body>{o.delivery_fee ? naira(o.delivery_fee) : 'Free'}</Body></Row>
        {o.tax ? <Row style={{ justifyContent: 'space-between' }}><Body>{o.tax_label || 'Tax'}</Body><Body>{naira(o.tax)}</Body></Row> : null}
        <Row style={{ justifyContent: 'space-between', marginTop: 6 }}><Text style={{ fontWeight: '800', color: colors.navy }}>Total</Text><Text style={{ fontWeight: '800', color: colors.navy }}>{naira(o.total)}</Text></Row>
        <Body muted style={{ marginTop: 6 }}>{payLabel(o.payment_method)} · {paid ? 'paid' : o.payment_method === 'pod' ? 'pay on delivery' : 'not paid'}</Body>
      </Card>
      <Card><H2>Delivering to</H2><Body>{o.name}</Body><Body>{o.address}, {o.city}, {o.state}</Body></Card>
      {actions.can_cancel ? <Button title="Cancel order" kind="secondary" onPress={cancel} loading={busy} style={{ marginBottom: space.md }} /> : null}
      <Button title="Problem with this order?" kind="link" onPress={() => router.push({ pathname: '/support', params: { orderRef: o.ref } })} />
    </Screen>
  );
}
