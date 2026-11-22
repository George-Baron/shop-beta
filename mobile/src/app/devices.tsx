import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React from 'react';
import { Text, View } from 'react-native';
import { Banner, Body, Button, Card, ErrorState, Loading, Row, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { Device } from '@/lib/types';
import { colors } from '@/theme';

export default function Devices() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['devices'], queryFn: () => api.get<{ devices: Device[] }>('/me/devices') });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/me/devices/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }) });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <Screen onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <Body muted style={{ marginBottom: 12 }}>These phones are signed in to your account. Remove any you do not recognise.</Body>
      {remove.isError ? <Banner kind="error">We could not remove that device. Please try again.</Banner> : null}
      {q.data.devices.map((d) => (
        <Card key={d.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}><Text style={{ fontWeight: '700', color: colors.ink }}>{d.name}{d.current ? ' (this phone)' : ''}</Text><Body muted>{d.platform} · app {d.app_version}</Body><Body muted>Last used {dateTime(d.last_used)}</Body></View>
            {!d.current ? <Button title="Remove" kind="secondary" onPress={() => remove.mutate(d.id)} loading={remove.isPending && remove.variables === d.id} /> : null}
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
