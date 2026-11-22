import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { Banner, Body, Button, Card, ErrorState, H2, Loading, Row, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { enablePush } from '@/lib/push';
import { colors, space } from '@/theme';

type Settings = { orders: boolean; wholesale: boolean; offers: boolean };
const ROWS: [keyof Settings, string, string][] = [['orders', 'Orders and delivery', 'Placed, confirmed, on its way, delivered, payment received.'], ['wholesale', 'Wholesale', 'Quotation and request updates for business buyers.'], ['offers', 'Offers', 'Occasional promotions. Off unless you turn it on.']];

export default function NotificationSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['push-settings'], queryFn: () => api.get<{ settings: Settings }>('/notifications/settings') });
  const [phone, setPhone] = useState<string>('');
  const save = useMutation({ mutationFn: (s: Partial<Settings>) => api.put<{ settings: Settings }>('/notifications/settings', s), onSuccess: (r) => qc.setQueryData(['push-settings'], r) });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data.settings;
  const turnOn = async () => { const r = await enablePush(true).catch(() => 'unavailable' as const); setPhone(r === 'on' ? 'ok' : r === 'denied' ? 'denied' : 'unavailable'); };
  return (
    <Screen>
      <H2>Alerts on this phone</H2>
      <Body muted style={{ marginBottom: space.md }}>Alerts only carry a short message. Your address and payment details are never sent in an alert.</Body>
      {phone === 'ok' ? <Banner kind="ok">Alerts are on for this phone.</Banner> : null}
      {phone === 'denied' ? <Banner>Alerts are blocked for VELTO-MART. You can allow them in your phone's Settings.</Banner> : null}
      {phone === 'unavailable' ? <Banner>Alerts cannot be turned on from this device (a real phone and a store-installed build are needed). You will still see updates in Notifications.</Banner> : null}
      <Button title="Turn on alerts on this phone" kind="secondary" onPress={turnOn} style={{ marginBottom: space.lg }} />
      <Card>
        {ROWS.map(([k, label, hint]) => (
          <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: space.sm }}>
            <View style={{ flex: 1, paddingRight: space.md }}><Text style={{ fontWeight: '700', color: colors.ink }}>{label}</Text><Body muted>{hint}</Body></View>
            <Switch value={s[k]} onValueChange={(v) => save.mutate({ [k]: v })} trackColor={{ true: colors.gold }} accessibilityLabel={label} />
          </Row>
        ))}
      </Card>
      {save.isError ? <Banner kind="error">We could not save that. Please try again.</Banner> : null}
    </Screen>
  );
}
