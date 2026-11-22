import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Banner, Body, Button, Card, Chip, Empty, ErrorState, Field, H2, Loading, Row, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { addressSchema } from '@/lib/schemas';
import { useConfig } from '@/lib/queries';
import type { Address } from '@/lib/types';
import { messageOf, useZodForm } from '@/lib/useForm';
import { colors } from '@/theme';

type F = { label: string; name: string; phone: string; state: string; city: string; address: string };
const BLANK: F = { label: 'Home', name: '', phone: '', state: '', city: '', address: '' };

function AddressForm({ initial, id, onDone }: { initial: F; id?: number; onDone: () => void }) {
  const cfg = useConfig();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const { control, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } = useZodForm<F>(addressSchema, initial);
  const state = watch('state');
  const save = handleSubmit(async (v) => {
    setError('');
    try {
      const body = { ...v, phone: v.phone.replace(/\s/g, '') };
      if (id) await api.put(`/addresses/${id}`, body); else await api.post('/addresses', body);
      await qc.invalidateQueries({ queryKey: ['addresses'] }); onDone();
    } catch (e) { setError(messageOf(e)); }
  });
  return (
    <Card>
      <H2>{id ? 'Edit address' : 'New address'}</H2>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Field control={control} name="label" label="Name for this address (Home, Work…)" error={errors.label?.message} />
      <Field control={control} name="name" label="Who receives it (optional)" error={errors.name?.message} />
      <Field control={control} name="phone" label="Phone (optional)" error={errors.phone?.message} keyboardType="phone-pad" />
      <Body style={{ fontWeight: '600', marginBottom: 6 }}>State</Body>
      <Row style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>{(cfg.data?.zones ?? []).map((z) => <Chip key={z.state} label={z.state} active={state === z.state} onPress={() => setValue('state', z.state, { shouldValidate: true })} />)}</Row>
      {errors.state ? <Text style={{ color: colors.danger, marginBottom: 8 }}>{errors.state.message}</Text> : null}
      <Field control={control} name="city" label="City or area" error={errors.city?.message} />
      <Field control={control} name="address" label="Street address" error={errors.address?.message} multiline />
      <Row style={{ gap: 8 }}><Button title="Save" onPress={save} loading={isSubmitting} style={{ flex: 1 }} /><Button title="Cancel" kind="secondary" onPress={onDone} /></Row>
    </Card>
  );
}

export default function Addresses() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['addresses'], queryFn: () => api.get<{ addresses: Address[] }>('/addresses') });
  const [editing, setEditing] = useState<{ id?: number; form: F } | null>(null);
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/addresses/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['addresses'] }) });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <Screen onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      {editing ? <AddressForm key={editing.id ?? 'new'} id={editing.id} initial={editing.form} onDone={() => setEditing(null)} /> : <Button title="Add an address" onPress={() => setEditing({ form: BLANK })} style={{ marginBottom: 12 }} />}
      {remove.isError ? <Banner kind="error">We could not delete that address. Please try again.</Banner> : null}
      {q.data.addresses.length === 0 && !editing ? <Empty title="No saved addresses" hint="Save one here and pick it at checkout." /> : null}
      {q.data.addresses.map((a) => (
        <Card key={a.id}>
          <Text style={{ fontWeight: '700', color: colors.ink }}>{a.label || 'Address'}</Text>
          <Body>{a.address}{a.city ? `, ${a.city}` : ''}, {a.state}</Body>
          {a.name || a.phone ? <Body muted>{[a.name, a.phone].filter(Boolean).join(' · ')}</Body> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Button title="Edit" kind="secondary" onPress={() => setEditing({ id: a.id, form: { label: a.label ?? '', name: a.name ?? '', phone: a.phone ?? '', state: a.state, city: a.city ?? '', address: a.address } })} />
            <Button title="Delete" kind="link" onPress={() => Alert.alert('Delete this address?', undefined, [{ text: 'Keep', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => remove.mutate(a.id) }])} />
          </View>
        </Card>
      ))}
    </Screen>
  );
}
