import { Link, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Banner, Body, Button, Field, H1, Screen } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { signInSchema } from '@/lib/schemas';
import { messageOf, useZodForm } from '@/lib/useForm';
import { space } from '@/theme';

export default function SignIn() {
  const { signIn, notice, clearNotice } = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');
  const { control, handleSubmit, formState: { errors, isSubmitting } } = useZodForm<{ email: string; password: string }>(signInSchema, { email: '', password: '' });
  const go = handleSubmit(async (v) => {
    setError(''); clearNotice();
    try { await signIn(v.email.trim().toLowerCase(), v.password); router.dismissAll?.(); router.replace('/'); } catch (e) { setError(messageOf(e)); }
  });
  return (
    <Screen>
      <H1>Welcome back</H1>
      {notice ? <Banner>{notice}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Field control={control} name="email" label="Email" error={errors.email?.message} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" />
      <Field control={control} name="password" label="Password" error={errors.password?.message} secureTextEntry autoComplete="current-password" textContentType="password" />
      <Button title="Sign in" onPress={go} loading={isSubmitting} testID="sign-in-submit" />
      <View style={{ marginTop: space.lg, gap: space.sm }}>
        <Link href="/forgot"><Body>Forgot your password?</Body></Link>
        <Link href="/register"><Body>New here? Create an account</Body></Link>
      </View>
    </Screen>
  );
}
