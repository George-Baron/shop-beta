import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { Body, Button, Empty, ErrorState, Loading } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { routeFor } from '@/lib/push';
import { useNotices } from '@/lib/queries';
import { colors, space } from '@/theme';

export default function Notifications() {
  const q = useNotices();
  const qc = useQueryClient();
  const router = useRouter();
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read', { all: true }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notices'] }) });
  const readOne = (id: number) => api.post('/notifications/read', { id }).then(() => qc.invalidateQueries({ queryKey: ['notices'] })).catch(() => undefined);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <FlatList data={q.data.notifications} keyExtractor={(n) => String(n.id)} contentContainerStyle={{ padding: space.lg }} onRefresh={() => q.refetch()} refreshing={q.isRefetching}
      ListHeaderComponent={q.data.unread > 0 ? <Button title="Mark all as read" kind="link" onPress={() => readAll.mutate()} /> : undefined}
      ListEmptyComponent={<Empty title="Nothing new" hint="Order and delivery updates will show up here." />}
      renderItem={({ item: n }) => (
        <Pressable accessibilityRole="button" onPress={() => { if (!n.read) readOne(n.id); router.push(routeFor({ type: n.type, link: n.link }) as any); }}
          style={{ backgroundColor: n.read ? colors.white : colors.goldSoft, padding: space.md, borderRadius: 12, marginBottom: space.sm, borderWidth: 1, borderColor: colors.line }}>
          <Text style={{ fontWeight: n.read ? '500' : '800', color: colors.ink }}>{n.title}</Text>
          {n.body ? <Body muted>{n.body}</Body> : null}
          <View><Body muted>{dateTime(n.created)}</Body></View>
        </Pressable>
      )} />
  );
}
