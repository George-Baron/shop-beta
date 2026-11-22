import { Link, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Banner, Body, Button, Field, H1, Screen } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { PRIVACY_URL, TERMS_URL } from '@/lib/config';
import { registerSchema } from '@/lib/schemas';
import { messageOf, useZodForm } from '@/lib/useForm';
import * as WebBrowser from 'expo-web-browser';

export default function Register() {
  const { register } = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');
  const { control, handleSubmit, formState: { errors, isSubmitting } } = useZodForm<{ name: string; email: string; phone: string; password: string }>(registerSchema, { name: '', email: '', phone: '', password: '' });
  const go = handleSubmit(async (v) => {
    setError('');
    try { await register({ name: v.name.trim(), email: v.email.trim().toLowerCase(), phone: v.phone.replace(/\s/g, ''), password: v.password }); router.dismissAll?.(); router.replace('/'); } catch (e) { setError(messageOf(e)); }
  });
  return (
    <Screen>
      <H1>Create your account</H1>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Field control={control} name="name" label="Full name" error={errors.name?.message} autoComplete="name" textContentType="name" />
      <Field control={control} name="email" label="Email" error={errors.email?.message} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" />
      <Field control={control} name="phone" label="Phone (optional)" error={errors.phone?.message} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" />
      <Field control={control} name="password" label="Password" error={errors.password?.message} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
      <Button title="Create account" onPress={go} loading={isSubmitting} testID="register-submit" />
      <Body muted style={{ marginTop: 16 }}>
        By creating an account you agree to our <Body style={{ textDecorationLine: 'underline' }} onPress={() => WebBrowser.openBrowserAsync(TERMS_URL)}>Terms</Body> and have read our <Body style={{ textDecorationLine: 'underline' }} onPress={() => WebBrowser.openBrowserAsync(PRIVACY_URL)}>Privacy policy</Body>.
      </Body>
      <Link href="/sign-in" style={{ marginTop: 16 }}><Body>Already have an account? Sign in</Body></Link>
    </Screen>
  );
}
