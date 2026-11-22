import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Alert } from 'react-native';
import { Banner, Body, Button, Field, H2, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { deleteSchema } from '@/lib/schemas';
import { messageOf, useZodForm } from '@/lib/useForm';

export default function DeleteAccount() {
  const { forget } = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');
  const { control, handleSubmit, formState: { errors, isSubmitting } } = useZodForm<{ password: string }>(deleteSchema, { password: '' });
  const run = handleSubmit((v) => Alert.alert('Delete your account?', 'You will be signed out everywhere. This cannot be undone after the waiting period.', [
    { text: 'Keep my account', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => {
      setError('');
      try {
        const r = await api.post<{ wait_days: number }>('/me/delete-account', { password: v.password });
        await forget();
        Alert.alert('Account scheduled for deletion', `Your personal details will be erased after ${r.wait_days} days. Order records the law requires us to keep stay, without your name.`);
        router.replace('/');
      } catch (e) { setError(messageOf(e)); }
    } },
  ]));
  return (
    <Screen>
      <H2>Delete my account</H2>
      <Body style={{ marginBottom: 12 }}>Your account is switched off straight away. After a short waiting period we erase your name, email, phone, addresses, wishlist and notifications. Order and payment records are kept without your personal details, as our accounts require.</Body>
      <Body muted style={{ marginBottom: 16 }}>You cannot delete while you have an order or wholesale quotation in progress. To stop the deletion during the waiting period, contact us.</Body>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Field control={control} name="password" label="Your password" error={errors.password?.message} secureTextEntry />
      <Button title="Delete my account" kind="danger" onPress={run} loading={isSubmitting} />
    </Screen>
  );
}
