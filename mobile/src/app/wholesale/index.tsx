import { useQuery } from '@tanstack/react-query';
import { Link, useRouter } from 'expo-router';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Body, Button, Card, Empty, ErrorState, H2, Loading, Row, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { day, naira, statusLabel } from '@/lib/format';
import type { QuoteRow, WholesaleAccount } from '@/lib/types';
import { colors } from '@/theme';

export default function Wholesale() {
  const { status } = useAuth();
  const router = useRouter();
  const me = useQuery({ queryKey: ['ws-me'], enabled: status === 'in', queryFn: () => api.get<{ account: WholesaleAccount; terms: { eval_days: number; valid_days: number; pay_days: number; service_pct: number } }>('/wholesale/me') });
  const approved = me.data?.account?.status === 'approved';
  const quotes = useQuery({ queryKey: ['ws-quotes'], enabled: approved, queryFn: () => api.get<{ quotes: QuoteRow[] }>('/wholesale/quotes') });
  if (status !== 'in') return <Empty title="Sign in first" hint="Wholesale is for approved business accounts." action={<Link href="/sign-in" asChild><Button title="Sign in" onPress={() => undefined} /></Link>} />;
  if (me.isLoading) return <Loading />;
  if (me.isError || !me.data) return <ErrorState error={me.error} onRetry={() => me.refetch()} />;
  const a = me.data.account, t = me.data.terms;
  return (
    <Screen onRefresh={() => { me.refetch(); quotes.refetch(); }} refreshing={me.isRefetching}>
      {!a ? (
        <Card><H2>Buy in bulk for your business</H2><Body>Wholesale prices, set quantities and a dedicated delivery plan for registered businesses. Apply once; our team checks your details within about {t.eval_days} working days.</Body>
          <View style={{ height: 12 }} /><Button title="Apply for a wholesale account" onPress={() => router.push('/wholesale/apply')} /></Card>
      ) : a.status === 'pending' ? <Banner>Your application{a.business_name ? ` for ${a.business_name}` : ''} is being evaluated. We will notify you when it is decided. Wholesale prices stay hidden until then.</Banner>
        : a.status === 'rejected' ? <Banner kind="error">Your wholesale application was not approved. Contact us if you would like it reviewed.</Banner>
        : (
          <View>
            <Card><H2>{a.business_name}</H2><Body muted>Approved wholesale buyer. Wholesale stock is kept separately from the shop, so availability can differ.</Body>
              <View style={{ height: 12 }} /><Button title="Price list and request a quotation" onPress={() => router.push('/wholesale/catalog')} /></Card>
            <H2>My quotations</H2>
            {quotes.isLoading ? <Loading /> : (quotes.data?.quotes.length ?? 0) === 0 ? <Body muted>No quotations yet.</Body> : quotes.data!.quotes.map((q) => (
              <Link key={q.ref} href={{ pathname: '/wholesale/quote/[ref]', params: { ref: q.ref } }} asChild>
                <Pressable accessibilityRole="button" style={{ backgroundColor: colors.white, borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: colors.line }}>
                  <Row style={{ justifyContent: 'space-between' }}><Text style={{ fontWeight: '700', color: colors.navy }}>{q.ref}</Text><Text style={{ fontWeight: '700' }}>{statusLabel(q.status)}</Text></Row>
                  <Body muted>{day(q.created)} · {naira(q.total || q.goods_total)}</Body>
                </Pressable>
              </Link>
            ))}
            <Body muted style={{ marginTop: 12 }}>Requests for quotation with your own product lists and spreadsheet uploads are on the website for now.</Body>
          </View>
        )}
    </Screen>
  );
}
